#!/usr/bin/env node
import { checkEnv, env } from "./lib/env.js";
import { logger } from "./lib/logger.js";
import { latestClosedMonth } from "./lib/period.js";
import { collectGa4ForMonth } from "./lib/ga4.js";
import { collectGscForMonth } from "./lib/gsc.js";
import { collectShopifyForMonth } from "./lib/shopify.js";
import { allSites } from "./lib/normalize.js";

const [, , command, ...args] = process.argv;

const flags = new Map();
for (const arg of args) {
  if (!arg.startsWith("--")) continue;
  const [key, ...rest] = arg.slice(2).split("=");
  flags.set(key, rest.length ? rest.join("=") : true);
}

if (flags.get("verbose")) process.env.LOG_LEVEL = "debug";
const noCache = flags.has("no-cache");
const force = flags.has("force");
const noAi = flags.has("no-ai");
const noSlack = flags.has("no-slack");
const noRepair = flags.has("no-repair");

const HELP = `
Lovebox Analytics — collecte + rapport mensuel
(module lecture seule : aucune action d'écriture sur les sites)

  npm run doctor                         Vérifie credentials, joignabilité GA4/GSC/Shopify,
                                          sonde les métriques GA4 disponibles, ne plante jamais
  npm run collect -- --month=2026-06     Collecte + snapshot data/monthly/2026-06.json
                                          (pas d'appel IA, pas d'envoi Slack)
  npm run backfill -- --months=14        Collecte les 14 derniers mois clos
  npm run report -- --month=2026-06      Génère MD + HTML + Slack à partir du snapshot
                                          (le collecte s'il manque). Options : --no-ai, --no-slack, --no-repair
  npm run monthly                        Run du 3 du mois : collect(M-1) + report complet

Flags globaux : --no-cache, --verbose, --force
Flags spécifiques à report/monthly : --no-ai (pas d'appel Claude), --no-slack (pas d'envoi Slack),
                                      --no-repair (ne tente pas de réparer les sources en échec du snapshot)
`;

/**
 * `doctor` : vérifie les credentials déclaratifs, teste la joignabilité
 * réelle de GA4/GSC/Shopify, sonde les métriques GA4 effectivement
 * disponibles sur la propriété, et explique quoi faire si le scope Shopify
 * `read_orders` manque. Ne lève JAMAIS — chaque section est isolée et
 * rapporte, comme les collecteurs eux-mêmes (§14 isolation des pannes).
 */
async function runDoctor() {
  let hasProblem = false;
  console.log("=== Lovebox Analytics — doctor ===\n");

  // --- 1. Credentials déclaratifs (.env) ---
  const problems = checkEnv(["google", "anthropic", "shopify", "slack"]);
  if (!problems.length) {
    console.log("OK  Credentials .env : tous présents.");
  } else {
    hasProblem = true;
    console.log("XX  Credentials manquants :");
    for (const p of problems) console.log(`    - ${p}`);
  }
  console.log(`    Modèle Claude (ANALYTICS_MODEL) : ${env.analyticsModel}`);
  console.log(`    Token Google (GOOGLE_TOKEN_PATH) : ${env.googleTokenPath}`);
  console.log();

  const month = latestClosedMonth();
  console.log(`(sonde effectuée sur le dernier mois clos : ${month})\n`);

  // --- 2. GA4 : joignabilité + sonde de métriques ---
  console.log("--- Google Analytics 4 ---");
  try {
    const results = await collectGa4ForMonth(month, { noCache: true });
    const entries = Object.entries(results);
    const available = entries.filter(([, r]) => r.ok);
    const unavailable = entries.filter(([, r]) => !r.ok);
    console.log(`    Rapports disponibles : ${available.length}/${entries.length}`);
    for (const [key, r] of available) {
      console.log(r.droppedFields.length ? `    OK  ${key} (dégradé — retiré: ${r.droppedFields.join(", ")})` : `    OK  ${key}`);
    }
    if (unavailable.length) {
      hasProblem = true;
      console.log("    Rapports indisponibles :");
      for (const [key, r] of unavailable) console.log(`    XX  ${key} — ${r.error}`);
    }
  } catch (err) {
    hasProblem = true;
    console.log(`    XX  GA4 injoignable : ${err.message}`);
  }
  console.log();

  // --- 3. Search Console : un site à la fois, tolérant ---
  console.log("--- Search Console ---");
  try {
    const results = await collectGscForMonth(allSites(), month, { noCache: true });
    for (const [key, r] of Object.entries(results)) {
      console.log(r.ok ? `    OK  ${key}` : `    ??  ${key} — injoignable (${r.error}) : rapport dégradé, pas d'échec global`);
    }
  } catch (err) {
    hasProblem = true;
    console.log(`    XX  Search Console injoignable : ${err.message}`);
  }
  console.log();

  // --- 4. Shopify : joignabilité + scope read_orders ---
  console.log("--- Shopify ---");
  let missingScope = false;
  try {
    const results = await collectShopifyForMonth(month, { noCache: true, skipCustomerSegments: true });
    for (const [key, r] of Object.entries(results)) {
      if (r.ok) {
        console.log(`    OK  ${key} — ${r.data.orders} commande(s) sur ${month}`);
      } else if (r.reason === "scope read_orders manquant") {
        missingScope = true;
        console.log(`    ??  ${key} — scope "read_orders" manquant (cas nominal aujourd'hui)`);
      } else {
        hasProblem = true;
        console.log(`    XX  ${key} — ${r.reason}`);
      }
    }
  } catch (err) {
    hasProblem = true;
    console.log(`    XX  Shopify injoignable : ${err.message}`);
  }
  if (missingScope) {
    console.log(
      "\n    → Pour lire les commandes réelles :\n" +
      "      1. Ouvre l'app custom de la boutique concernée (Partners Dashboard).\n" +
      "      2. Ajoute le scope \"read_orders\" (API access scopes).\n" +
      "      3. Relance : npm run auth-shopify (script du module `Suppression BLOG Useless`).\n" +
      "      En attendant, le rapport reste complet : le CA affiché vient de GA4 (pixel Shopify),\n" +
      "      pas des commandes réelles — ce sera noté explicitement."
    );
  }
  console.log();

  // --- 5. Slack : joignabilité + scope `files:write` (pièce jointe HTML, §12.3) ---
  console.log("--- Slack ---");
  if (!env.slackToken || !env.slackChannel) {
    console.log("    ??  Slack non configuré (SLACK_BOT_TOKEN/SLACK_CHANNEL_ID manquant — voir credentials ci-dessus) : étape sautée.");
  } else {
    try {
      const authRes = await fetch("https://slack.com/api/auth.test", {
        method: "POST",
        headers: { Authorization: `Bearer ${env.slackToken}` },
      }).then((r) => r.json());
      if (!authRes.ok) {
        hasProblem = true;
        console.log(`    XX  Slack injoignable ou token invalide — ${authRes.error}`);
      } else {
        console.log(`    OK  Slack joignable (workspace: ${authRes.team}, bot: ${authRes.user}).`);
        // Sonde inoffensive : on demande une URL d'upload sans jamais l'utiliser
        // (aucun fichier n'est réellement envoyé) — suffit à révéler si le
        // scope "files:write" est présent sur le bot token.
        const scopeRes = await fetch("https://slack.com/api/files.getUploadURLExternal", {
          method: "POST",
          headers: { Authorization: `Bearer ${env.slackToken}`, "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ filename: "doctor-check.txt", length: "1" }),
        }).then((r) => r.json());
        if (scopeRes.ok) {
          console.log("    OK  Scope \"files:write\" présent — le rapport HTML sera envoyé en pièce jointe.");
        } else if (scopeRes.error === "missing_scope" || scopeRes.error === "not_allowed_token_type") {
          console.log(
            "    ??  Scope \"files:write\" manquant sur le bot token (cas nominal aujourd'hui) — le rapport sera\n" +
            "        envoyé en message Slack seul, avec le chemin local du HTML. Pour activer la pièce jointe :\n" +
            "        1. https://api.slack.com/apps → l'app Lovebox → OAuth & Permissions.\n" +
            "        2. Bot Token Scopes : ajoute \"files:write\" (ne retire aucun scope existant).\n" +
            "        3. Réinstalle l'app dans le workspace (bouton \"Reinstall to Workspace\").\n" +
            "        4. Relance `npm run doctor` : le scope doit passer à OK."
          );
        } else {
          hasProblem = true;
          console.log(`    XX  files.getUploadURLExternal — ${scopeRes.error}`);
        }
      }
    } catch (err) {
      hasProblem = true;
      console.log(`    XX  Slack injoignable : ${err.message}`);
    }
  }
  console.log();

  console.log(hasProblem ? "=== Doctor : des problèmes ont été détectés (voir ci-dessus). ===" : "=== Doctor : tout est vert (ou dégradé proprement). ===");
  if (hasProblem) process.exitCode = 1;
}

async function main() {
  switch (command) {
    case "doctor":
      await runDoctor();
      break;
    case "collect": {
      const { runCollect } = await import("./routines/collect.js");
      await runCollect({ month: flags.get("month"), noCache, force });
      break;
    }
    case "backfill": {
      const { runBackfill } = await import("./routines/backfill.js");
      const months = Number(flags.get("months")) || 14;
      await runBackfill({ months, noCache, force });
      break;
    }
    case "report": {
      const { runReport } = await import("./routines/report.js");
      await runReport({ month: flags.get("month"), noAi, noSlack, noCache, force, noRepair });
      break;
    }
    case "monthly": {
      const { runMonthly } = await import("./routines/monthly.js");
      await runMonthly({ noCache, force });
      break;
    }
    default:
      console.log(HELP);
      if (command) process.exitCode = 1;
  }
}

main().catch((err) => {
  logger.error(err.stack || err.message);
  process.exitCode = 1;
});
