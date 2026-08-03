import Anthropic from "@anthropic-ai/sdk";
import { env } from "./env.js";
import { logger } from "./logger.js";

// Agents Claude (§11). SDK @anthropic-ai/sdk, modèle par défaut claude-opus-5
// (surchargeable via ANALYTICS_MODEL). Streaming obligatoire (max_tokens élevé),
// output_config porte à la fois `format` et `effort` (pas de `output_format` au
// premier niveau — déprécié), aucun temperature/top_p/top_k, aucun budget_tokens
// (thinking: {type:"adaptive"} pilote la réflexion, effort pilote la profondeur).

let client = null;
function getClient() {
  if (!client) client = new Anthropic({ apiKey: env.anthropicKey });
  return client;
}

// Contrainte de style imposée mot pour mot par la SPEC §11.
const STYLE_CONSTRAINT =
  "Écris en français, pour quelqu'un qui ne fait pas de SEO. Pas de jargon non " +
  "expliqué (« CTR », « impressions », « bounce rate » doivent être traduits ou " +
  "définis en une incise). Chaque affirmation chiffrée doit citer un chiffre " +
  "présent dans les données fournies. Si une donnée manque ou est marquée peu " +
  "fiable, dis-le plutôt que d'estimer. Ne conclus jamais qu'un canal est non " +
  "rentable sur la seule base du dernier clic.";

const CONTEXT =
  "Tu analyses les données mensuelles (Google Analytics 4, Search Console, Shopify) " +
  "du groupe Lovebox (objet connecté pour couples/familles à distance). Sites " +
  "éditoriaux EN/FR/EU (blog + boutique Shopify) et sites d'achat BUY/BOUTIQUE/STORE, " +
  "plus CA/KEEP découverts en cours de route. Sois factuel, chiffré et actionnable.";

function buildSystemPrompt(role) {
  return `${CONTEXT}\n\n${role}\n\n${STYLE_CONSTRAINT}`;
}

/** Schéma commun aux 6 agents thématiques (§11). */
const THEMATIC_SCHEMA = {
  type: "object",
  properties: {
    summary: {
      type: "string",
      description: "3 à 6 phrases, en français courant, qui résument ce qui compte ce mois-ci pour ce thème",
    },
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          detail: { type: "string", description: "Une à deux phrases, chiffrées quand c'est possible, qui expliquent le constat" },
          severity: { type: "string", enum: ["positif", "neutre", "attention", "critique"] },
        },
        required: ["title", "detail", "severity"],
        additionalProperties: false,
      },
    },
    watchouts: {
      type: "array",
      items: { type: "string" },
      description: "Données manquantes, peu fiables, ou points de prudence à signaler explicitement au lecteur",
    },
  },
  required: ["summary", "findings", "watchouts"],
  additionalProperties: false,
};

/** Schéma de l'agent exécutif (§11) — le cœur du livrable. */
const EXECUTIVE_SCHEMA = {
  type: "object",
  properties: {
    synthesis: { type: "string", description: "5 phrases maximum, langage courant : ce qui a changé ce mois-ci" },
    keyFigures: {
      type: "array",
      items: { type: "string" },
      description: "3 chiffres clés, chacun formulé en une phrase courte et sourcée",
    },
    actions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          priority: { type: "integer" },
          action: { type: "string" },
          where: { type: "string" },
          expectedImpact: { type: "string" },
          owner: { type: "string" },
        },
        required: ["priority", "action", "where", "expectedImpact", "owner"],
        additionalProperties: false,
      },
      description: "Les 3 actions du mois, triées par priorité (1 = la plus urgente)",
    },
    alert: {
      type: "string",
      description: "1 alerte prioritaire à faire remonter immédiatement, chaîne vide si aucune",
    },
  },
  required: ["synthesis", "keyFigures", "actions", "alert"],
  additionalProperties: false,
};

const ROLES = {
  acquisition:
    "Ton rôle : expliquer d'où vient le trafic (canaux, sources, campagnes, géographie, appareils), " +
    "quel canal progresse ou décline, et l'écart entre premier contact et dernier clic (le champ " +
    "attributionGap fourni dans les données). Le blog est structurellement un canal de découverte : " +
    "fort en premier contact, plus faible en dernier clic — signale l'écart explicitement plutôt que " +
    "de conclure trop vite sur la rentabilité d'un canal.",
  seo: "Ton rôle : traduire les résultats Search Console fournis (clics, impressions, position moyenne, " +
    "marque vs hors marque, gagnants/perdants, cannibalisation, opportunités de striking distance) en " +
    "langage clair, et prioriser les opportunités concrètes.",
  content:
    "Ton rôle : analyser le blog éditorial (trafic, meilleurs articles, contribution au revenu) et " +
    "identifier ce qui marche et ce qui est à retravailler. Tu ne recommandes jamais de suppression " +
    "d'article — ce sujet relève d'un autre module, en lecture seule ici.",
  ecommerce:
    "Ton rôle : analyser l'entonnoir d'achat (vue → panier → paiement → achat), les produits, le panier " +
    "moyen et le taux de conversion. Si les données Shopify sont indisponibles (scope read_orders " +
    "manquant), dis-le explicitement et base ton analyse sur les données GA4 disponibles.",
  aiVisibility:
    "Ton rôle : analyser le trafic en provenance des assistants IA (ChatGPT, Perplexity, Claude, Gemini, " +
    "Copilot…) : quelles pages sont citées ou visitées depuis ces sources, et quelle intention probable " +
    "(découverte du produit vs intention d'achat directe).",
  dataQuality:
    "Ton rôle : traduire les contrôles techniques de qualité des données (§10) en langage clair pour une " +
    "équipe qui ne fait pas de data, et prioriser les corrections à apporter.",
};

const EXECUTIVE_ROLE =
  "Ton rôle : à partir des 6 analyses thématiques ci-dessous et des KPI du mois, produire la synthèse " +
  "exécutive : au maximum 5 phrases sur ce qui a changé, 3 chiffres clés, 3 actions concrètes triées par " +
  "priorité (où, impact attendu, qui), et 1 alerte si un point mérite une attention immédiate (chaîne vide " +
  "sinon). C'est le cœur du livrable : quelqu'un qui ne lit que cette section doit comprendre le mois.";

/**
 * Vérification des chiffres (§11, anti-hallucination) — NON BLOQUANT.
 *
 * Construit un `Set` de toutes les valeurs numériques (avec variantes
 * arrondies 0/1/2 décimales) du jeu de données `sourceData` réellement fourni
 * à l'agent — ce qui couvre à la fois les données brutes et tout ce que
 * `metrics.js` y a déjà calculé (deltas, %, ratios), puisque ces valeurs
 * calculées font partie de `sourceData` par construction (voir routines/report.js).
 *
 * Extrait ensuite les nombres présents dans les champs texte de la réponse de
 * l'agent (regex tolérante aux séparateurs `1 234`, `1,234`, `1234.5`, `+12 %`)
 * et renvoie ceux qui n'ont aucune correspondance à ±2% relatif. On ne
 * parcourt que les champs *texte* de la réponse (pas les champs numériques du
 * schéma comme `priority`), pour ne pas remonter de faux positifs sur des
 * nombres structurels (rangs, énumérations).
 */
export function verifyFigures(agentOutput, sourceData) {
  const known = collectKnownNumbers(sourceData);
  const strings = collectStrings(agentOutput);
  const seen = new Set();
  const unverified = [];

  for (const text of strings) {
    for (const candidate of extractTextNumbers(text)) {
      const key = String(candidate.value);
      if (seen.has(key)) continue;
      // Petits entiers sans décimale ni % : très probablement des nombres
      // d'énumération en prose ("3 actions", "2 sites"), pas des données
      // sourcées — on ne les fait pas remonter comme non vérifiés.
      if (Math.abs(candidate.value) < 10 && !candidate.hadDecimalOrPercent) continue;
      if (isKnownNumber(candidate.value, known)) continue;
      seen.add(key);
      unverified.push(candidate.value);
    }
  }
  return unverified;
}

function collectKnownNumbers(value, set = new Set()) {
  if (value == null) return set;
  if (typeof value === "number" && Number.isFinite(value)) {
    set.add(value);
    set.add(round(value, 0));
    set.add(round(value, 1));
    set.add(round(value, 2));
  } else if (Array.isArray(value)) {
    for (const item of value) collectKnownNumbers(item, set);
  } else if (typeof value === "object") {
    for (const v of Object.values(value)) collectKnownNumbers(v, set);
  }
  return set;
}

function collectStrings(value, list = []) {
  if (value == null) return list;
  if (typeof value === "string") {
    list.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, list);
  } else if (typeof value === "object") {
    for (const v of Object.values(value)) collectStrings(v, list);
  }
  return list;
}

function round(n, decimals) {
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

// Tolérante aux séparateurs "1 234" (espace), "1,234" (virgule), "1234.5"
// (décimal), "+12 %" / "+12%" (pourcentage avec ou sans espace).
const NUMBER_TOKEN_RE = /[+-]?\d[\d ,]*(?:\.\d+)?\s?%?/g;

function extractTextNumbers(text) {
  const tokens = text.match(NUMBER_TOKEN_RE) || [];
  const out = [];
  for (const raw of tokens) {
    const parsed = parseNumberToken(raw);
    if (parsed != null) out.push(parsed);
  }
  return out;
}

function parseNumberToken(raw) {
  let s = raw.trim();
  if (!s) return null;
  const hadPercent = s.endsWith("%");
  if (hadPercent) s = s.slice(0, -1).trim();
  const hadDecimal = /\.\d/.test(s);
  s = s.replace(/\s+/g, ""); // espace = séparateur de milliers
  s = s.replace(/,/g, ""); // virgule = séparateur de milliers
  const value = Number(s);
  if (!Number.isFinite(value)) return null;
  return { value, hadDecimalOrPercent: hadPercent || hadDecimal };
}

function isKnownNumber(candidate, known) {
  if (known.has(candidate)) return true;
  if (known.has(round(candidate, 0)) || known.has(round(candidate, 1)) || known.has(round(candidate, 2))) return true;
  for (const value of known) {
    if (value === 0) {
      if (Math.abs(candidate) < 0.05) return true;
      continue;
    }
    if (Math.abs(candidate - value) / Math.abs(value) <= 0.02) return true;
  }
  return false;
}

function unavailableResult(name, reason) {
  return { ok: false, name, data: null, unverifiedFigures: [], error: reason };
}

/**
 * Appelle un agent Claude (§11). Forme d'appel exacte imposée par la SPEC :
 * streaming obligatoire, `output_config` porte `format` ET `effort`, aucun
 * `temperature`/`top_p`/`top_k`, aucun `budget_tokens`. Un agent qui échoue
 * (refus, erreur réseau, clé absente…) ne tue jamais le run — sa section
 * affiche « analyse indisponible » avec la raison (voir report/markdown.js).
 */
async function callAgent({ name, role, data, schema, verifyAgainst }) {
  if (!env.anthropicKey) {
    return unavailableResult(name, "ANTHROPIC_API_KEY manquant");
  }
  try {
    logger.info(`Agent Claude "${name}" en cours…`);
    const stream = getClient().messages.stream({
      model: env.analyticsModel,
      max_tokens: 20000,
      system: [{ type: "text", text: buildSystemPrompt(role), cache_control: { type: "ephemeral" } }],
      thinking: { type: "adaptive" },
      output_config: { effort: "high", format: { type: "json_schema", schema } },
      messages: [{ role: "user", content: JSON.stringify(data) }],
    });
    const message = await stream.finalMessage();

    // Impératif : vérifier stop_reason AVANT de lire message.content (le
    // contenu peut être vide sur un refus pré-génération).
    if (message.stop_reason === "refusal") {
      throw new Error("le modèle a refusé de répondre (stop_reason=refusal)");
    }

    const text = message.content.find((b) => b.type === "text")?.text;
    if (!text) throw new Error("réponse vide (aucun bloc texte)");

    const parsed = JSON.parse(text);
    // Base de vérification : par défaut le payload envoyé au modèle (`data`),
    // mais surchargée par `verifyAgainst` pour l'agent exécutif — qui reçoit en
    // entrée les *textes* des 6 agents thématiques (summary/findings/watchouts,
    // des chaînes) plutôt que les données numériques brutes. `collectKnownNumbers`
    // ne collecte que des valeurs typées `number` : sans cet élargissement,
    // presque tout chiffre repris d'une analyse thématique dans la synthèse
    // remonterait à tort comme « non vérifié », alors qu'il est bien sourcé.
    const unverifiedFigures = verifyFigures(parsed, verifyAgainst ?? data);
    if (unverifiedFigures.length) {
      logger.warn(
        `Agent "${name}": ${unverifiedFigures.length} chiffre(s) non retrouvé(s) dans les données ` +
        `(§11, non bloquant) — ${unverifiedFigures.join(", ")}`
      );
    }
    logger.info(`Agent "${name}" terminé.`);
    return { ok: true, name, data: parsed, unverifiedFigures, error: null };
  } catch (err) {
    const reason = err.message || String(err);
    logger.warn(`Agent "${name}" indisponible: ${reason}`);
    return unavailableResult(name, reason);
  }
}

/**
 * Exécute les 7 agents (§11) : les 6 agents thématiques en parallèle, puis
 * l'agent exécutif qui synthétise leurs sorties + les KPI. `datasets` attend
 * les clés `acquisition`, `seo`, `content`, `ecommerce`, `aiVisibility`,
 * `dataQuality`, `kpis` — construites par routines/report.js à partir du
 * snapshot, de `metrics.js`, `quality.js` et `insights.js`.
 */
export async function runAnalysisAgents(datasets) {
  const [acquisition, seo, content, ecommerce, aiVisibility, dataQuality] = await Promise.all([
    callAgent({ name: "acquisition", role: ROLES.acquisition, data: datasets.acquisition, schema: THEMATIC_SCHEMA }),
    callAgent({ name: "seo", role: ROLES.seo, data: datasets.seo, schema: THEMATIC_SCHEMA }),
    callAgent({ name: "content", role: ROLES.content, data: datasets.content, schema: THEMATIC_SCHEMA }),
    callAgent({ name: "ecommerce", role: ROLES.ecommerce, data: datasets.ecommerce, schema: THEMATIC_SCHEMA }),
    callAgent({ name: "aiVisibility", role: ROLES.aiVisibility, data: datasets.aiVisibility, schema: THEMATIC_SCHEMA }),
    callAgent({ name: "dataQuality", role: ROLES.dataQuality, data: datasets.dataQuality, schema: THEMATIC_SCHEMA }),
  ]);

  const executiveData = {
    kpis: datasets.kpis,
    acquisition: acquisition.ok ? acquisition.data : { indisponible: acquisition.error },
    seo: seo.ok ? seo.data : { indisponible: seo.error },
    content: content.ok ? content.data : { indisponible: content.error },
    ecommerce: ecommerce.ok ? ecommerce.data : { indisponible: ecommerce.error },
    aiVisibility: aiVisibility.ok ? aiVisibility.data : { indisponible: aiVisibility.error },
    dataQuality: dataQuality.ok ? dataQuality.data : { indisponible: dataQuality.error },
  };
  // Vérification élargie : le payload envoyé au modèle (`executiveData`) ne
  // porte que les sorties textuelles des 6 agents thématiques, mais l'exécutif
  // reprend souvent des chiffres qui viennent de leurs données sources brutes
  // (celles qu'ils ont eux-mêmes reçues) — on les inclut donc dans la base de
  // vérification sans les ajouter au prompt (coût/cache inchangés).
  const executive = await callAgent({
    name: "executive",
    role: EXECUTIVE_ROLE,
    data: executiveData,
    schema: EXECUTIVE_SCHEMA,
    verifyAgainst: { ...executiveData, thematicSourceData: datasets },
  });

  return { acquisition, seo, content, ecommerce, aiVisibility, dataQuality, executive };
}

/** Résultat renvoyé pour chaque agent quand `--no-ai` est passé (aucun appel réseau). */
export function skippedAgentResult(name) {
  return unavailableResult(name, "agents désactivés (--no-ai)");
}

/** Les 7 clés d'agents, dans l'ordre de la SPEC §11 — pratique pour itérer côté rapport. */
export const AGENT_KEYS = ["acquisition", "seo", "content", "ecommerce", "aiVisibility", "dataQuality", "executive"];
