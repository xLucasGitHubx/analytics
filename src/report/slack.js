import fs from "node:fs";
import path from "node:path";
import { env } from "../lib/env.js";
import { logger } from "../lib/logger.js";

// Envoi Slack du rapport (§12.3, correction : plus de rapport détaillé posté
// en messages — l'équipe le veut en pièce jointe téléchargeable). Un seul
// message court (titre + mois + 6 tuiles KPI + 3 actions) et le fichier
// `rapport.html` joint au message. `sendFailureAlert` (pattern existant) est
// inchangé.

const MAX_TEXT = 2900;

async function post(blocks, { text = "Rapport Lovebox Analytics" } = {}) {
  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.slackToken}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      channel: env.slackChannel,
      text,
      blocks,
      unfurl_links: false,
    }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Slack: ${data.error}`);
  return data.ts;
}

const divider = { type: "divider" };
const section = (text) => ({ type: "section", text: { type: "mrkdwn", text: text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) + "…" : text } });
const header = (text) => ({ type: "header", text: { type: "plain_text", text: text.slice(0, 150), emoji: true } });
const context = (text) => ({ type: "context", elements: [{ type: "mrkdwn", text: text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) + "…" : text }] });

const decimalFormatter = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1, minimumFractionDigits: 1 });

function fmtDelta(delta, unitLabel) {
  if (!delta || delta.insufficient) return `volume trop faible pour conclure (${delta?.base ?? 0} ${unitLabel})`;
  if (delta.pct == null) return "n/d";
  const sign = delta.pct > 0 ? "+" : "";
  return `${sign}${decimalFormatter.format(delta.pct)} %`;
}

/**
 * Construit le contenu du message court (§12.3) : titre + mois + 6 tuiles
 * KPI + 3 actions du mois. Rien de plus — le détail par section (canaux,
 * SEO, blog, e-commerce, IA, qualité) vit uniquement dans `rapport.html`.
 * `text` (mrkdwn brut) sert à la fois de `initial_comment` pour la pièce
 * jointe et de corps de message pour le fallback `chat.postMessage`.
 */
function buildShortMessage(model) {
  const title = `Lovebox Analytics — ${model.monthLabel}`;
  const tilesText = model.tiles
    .map((t) => `• *${t.label}* : ${t.valueLabel} — M-1 ${fmtDelta(t.mom, t.baseUnit)} · M-12 ${fmtDelta(t.yoy, t.baseUnit)}`)
    .join("\n");

  const exec = model.agents.executive;
  const actionsText = exec.ok
    ? [...exec.data.actions]
        .sort((a, b) => a.priority - b.priority)
        .map((a) => `*${a.priority}. ${a.action}*\n   ↳ où : ${a.where} · impact : ${a.expectedImpact} · qui : ${a.owner}`)
        .join("\n\n")
    : `_actions indisponibles (${exec.error})._`;

  const text =
    `*${title}*\n` +
    `Généré le ${model.generatedAt} · qualité des données : ${model.quality.overallLevel}\n\n` +
    `*En un coup d'œil*\n${tilesText}\n\n` +
    `*Les 3 actions du mois*\n\n${actionsText}`;

  return { title, tilesText, actionsText, text };
}

function buildShortMessageBlocks(msg, model) {
  return [
    header(msg.title),
    context(`Généré le ${model.generatedAt} · qualité des données : ${model.quality.overallLevel}`),
    divider,
    section(`*En un coup d'œil*\n${msg.tilesText}`),
    divider,
    section(`*Les 3 actions du mois*\n\n${msg.actionsText}`),
  ];
}

const SCOPE_ERROR_CODES = new Set(["missing_scope", "not_allowed_token_type"]);

function logMissingFilesWriteScope(errorCode) {
  logger.warn(
    `Slack: impossible d'envoyer le rapport HTML en pièce jointe (${errorCode}). ` +
    "Le bot token n'a aujourd'hui que le scope \"chat:write\". Marche à suivre pour activer la pièce jointe :\n" +
    "  1. https://api.slack.com/apps → l'app Lovebox → OAuth & Permissions.\n" +
    "  2. Bot Token Scopes : ajoute \"files:write\" (ne retire aucun scope existant).\n" +
    "  3. Réinstalle l'app dans le workspace (bouton \"Reinstall to Workspace\").\n" +
    "  4. Relance le rapport (ou `npm run doctor` pour vérifier) : le fichier sera joint automatiquement."
  );
}

/** Étape 1/3 — obtient une URL d'upload signée pour ce fichier (requiert `files:write`). */
async function getUploadUrl(filename, length) {
  const res = await fetch("https://slack.com/api/files.getUploadURLExternal", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.slackToken}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ filename, length: String(length) }),
  });
  return res.json();
}

/** Étape 2/3 — dépose le contenu du fichier sur l'URL signée (pas d'auth Slack ici, l'URL fait foi). */
async function uploadFileContent(uploadUrl, buffer, filename) {
  const form = new FormData();
  form.append("file", new Blob([buffer]), filename);
  const res = await fetch(uploadUrl, { method: "POST", body: form });
  if (!res.ok) throw new Error(`Slack upload (dépôt du fichier) : HTTP ${res.status}`);
}

/** Étape 3/3 — finalise l'upload : poste le fichier dans le channel avec le message court en commentaire. */
async function completeUpload(fileId, title, channelId, initialComment) {
  const res = await fetch("https://slack.com/api/files.completeUploadExternal", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.slackToken}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      files: [{ id: fileId, title }],
      channel_id: channelId,
      initial_comment: initialComment,
    }),
  });
  return res.json();
}

/**
 * Upload du HTML en pièce jointe via le flux en 3 temps actuel de Slack
 * (`files.upload` est déprécié et retiré — voir la doc `files.getUploadURLExternal`
 * / `files.completeUploadExternal`). Nécessite le scope `files:write` sur le
 * bot token. Sur `missing_scope`/`not_allowed_token_type` (scope absent), ne
 * lève jamais : renvoie `{ ok:false, scopeMissing:true }` pour dégrader
 * proprement vers un message seul (voir `sendReport`).
 */
async function tryUploadHtmlAttachment(htmlPath, { title, initialComment }) {
  const filename = path.basename(htmlPath);
  const buffer = fs.readFileSync(htmlPath);

  const uploadUrlRes = await getUploadUrl(filename, buffer.length);
  if (!uploadUrlRes.ok) {
    if (SCOPE_ERROR_CODES.has(uploadUrlRes.error)) return { ok: false, scopeMissing: true, error: uploadUrlRes.error };
    throw new Error(`Slack files.getUploadURLExternal: ${uploadUrlRes.error}`);
  }

  await uploadFileContent(uploadUrlRes.upload_url, buffer, filename);

  const completeRes = await completeUpload(uploadUrlRes.file_id, title, env.slackChannel, initialComment);
  if (!completeRes.ok) {
    if (SCOPE_ERROR_CODES.has(completeRes.error)) return { ok: false, scopeMissing: true, error: completeRes.error };
    throw new Error(`Slack files.completeUploadExternal: ${completeRes.error}`);
  }
  return { ok: true };
}

/**
 * Rapport (§12.3) : un message court (titre, mois, 6 tuiles KPI, 3 actions)
 * et le fichier `rapport.html` en pièce jointe — plus de rapport détaillé
 * posté en thread. `htmlPath` : chemin du fichier HTML généré.
 *
 * Dégradation propre : si le scope `files:write` manque (ou tout autre échec
 * de l'upload), on poste le message court seul via `chat.postMessage` en
 * indiquant le chemin local du HTML à ouvrir dans un navigateur — jamais de
 * plantage du run pour un problème d'upload Slack.
 */
export async function sendReport(model, { htmlPath } = {}) {
  const msg = buildShortMessage(model);

  if (!htmlPath) {
    const ts = await post(buildShortMessageBlocks(msg, model), { text: msg.title });
    logger.info(`Rapport Slack envoyé (ts=${ts}) — pas de fichier HTML fourni, message seul.`);
    return ts;
  }

  try {
    const upload = await tryUploadHtmlAttachment(htmlPath, {
      title: `Rapport Lovebox Analytics — ${model.monthLabel}`,
      initialComment: msg.text,
    });
    if (upload.ok) {
      logger.info(`Rapport Slack envoyé avec rapport.html en pièce jointe (${htmlPath}).`);
      return upload;
    }
    logMissingFilesWriteScope(upload.error);
  } catch (err) {
    logger.error(`Échec de l'upload Slack du rapport HTML (${err.message}) — dégradation en message seul.`);
  }

  const fallbackBlocks = buildShortMessageBlocks(msg, model);
  fallbackBlocks.push(divider, context(`📄 Rapport complet (HTML) : \`${htmlPath}\` — à ouvrir dans un navigateur (Slack ne le prévisualise pas).`));
  const ts = await post(fallbackBlocks, { text: msg.title });
  logger.info(`Rapport Slack envoyé (ts=${ts}) — message seul avec le chemin local du HTML (voir logs ci-dessus pour activer la pièce jointe).`);
  return ts;
}

/** Notification d'échec d'un run (pattern `sendFailureAlert` existant). */
export async function sendFailureAlert(routine, error) {
  try {
    await post(
      [
        header(`❌ Lovebox Analytics — ${routine} a échoué`),
        section(`\`\`\`${String(error.stack || error.message || error).slice(0, 2500)}\`\`\``),
        context(`${new Date().toISOString()} — vérifier les logs et relancer manuellement.`),
      ],
      { text: `Échec ${routine}` }
    );
  } catch (slackErr) {
    logger.error(`Impossible d'envoyer l'alerte Slack: ${slackErr.message}`);
  }
}
