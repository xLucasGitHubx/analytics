import { env, loadConfig } from "./env.js";
import { googleRequest } from "./google.js";
import { withCache } from "./cache.js";
import { monthBounds } from "./period.js";
import { logger } from "./logger.js";

const API = "https://analyticsdata.googleapis.com/v1beta";
const reportsConfig = loadConfig("metrics").reports;
const llmSources = loadConfig("llm-sources").sources;

const MAX_DEGRADATIONS = 3;

function buildDimensionFilter(reportDef) {
  if (reportDef.filter !== "llmSources") return undefined;
  return {
    orGroup: {
      expressions: llmSources.map((source) => ({
        filter: { fieldName: "sessionSource", stringFilter: { matchType: "CONTAINS", value: source } },
      })),
    },
  };
}

function buildOrderBys(reportDef) {
  if (!reportDef.orderBy) return undefined;
  const { type, name, desc } = reportDef.orderBy;
  return type === "dimension"
    ? [{ dimension: { dimensionName: name }, desc: !!desc }]
    : [{ metric: { metricName: name }, desc: !!desc }];
}

function buildBody(reportDef, dateRanges, dimensions, metrics) {
  const body = {
    dateRanges,
    dimensions: dimensions.map((name) => ({ name })),
    metrics: metrics.map((name) => ({ name })),
    limit: reportDef.limit || 1000,
  };
  const filter = buildDimensionFilter(reportDef);
  if (filter) body.dimensionFilter = filter;
  const orderBys = buildOrderBys(reportDef);
  if (orderBys) body.orderBys = orderBys;
  return body;
}

async function runReportRaw(body) {
  return googleRequest(`${API}/properties/${env.ga4PropertyId}:runReport`, body);
}

/**
 * Comme runReport, mais pagine via `offset` tant que rowCount (annoncé par
 * l'API) n'est pas atteint — évite les troncatures silencieuses sur les
 * rapports volumineux (pattern `runReportPaged` de `Suppression BLOG Useless`).
 */
async function runReportPaged(body) {
  const pageSize = body.limit || 25000;
  let offset = 0;
  let merged = null;
  let rowCount = 0;
  for (;;) {
    const report = await runReportRaw({ ...body, limit: pageSize, offset });
    rowCount = report.rowCount ?? (report.rows || []).length;
    if (!merged) merged = { dimensionHeaders: report.dimensionHeaders, metricHeaders: report.metricHeaders, rows: [] };
    const rows = report.rows || [];
    merged.rows.push(...rows);
    offset += rows.length;
    if (rows.length === 0 || merged.rows.length >= rowCount) break;
  }
  if (rowCount && merged.rows.length < rowCount) {
    logger.warn(`GA4 runReportPaged: troncature — ${merged.rows.length}/${rowCount} lignes récupérées`);
  }
  return merged;
}

function rowsToObjects(report) {
  const dims = (report.dimensionHeaders || []).map((d) => d.name);
  const mets = (report.metricHeaders || []).map((m) => m.name);
  return (report.rows || []).map((row) => {
    const o = {};
    dims.forEach((d, i) => (o[d] = row.dimensionValues[i].value));
    mets.forEach((m, i) => (o[m] = Number(row.metricValues[i].value)));
    return o;
  });
}

/**
 * Extrait le nom du champ (dimension ou métrique) fautif d'un message
 * d'erreur GA4 400 en le cherchant comme mot entier parmi les champs connus
 * du rapport — évite les faux positifs de sous-chaîne.
 */
function extractFaultyField(message, knownFields) {
  if (!message) return null;
  for (const field of knownFields) {
    if (new RegExp(`\\b${field}\\b`).test(message)) return field;
  }
  return null;
}

/**
 * Sonde de métriques (SPEC §6) : tente le rapport complet ; sur 400
 * mentionnant une métrique/dimension du rapport, retire le champ fautif et
 * réessaie (max 3 dégradations), en journalisant chaque retrait. Ne lève
 * JAMAIS pour un rapport secondaire — renvoie toujours
 * `{ ok, rows, droppedFields, error }`.
 */
export async function runNamedReport(key, dateRanges, { noCache = false, month = "unscoped" } = {}) {
  const reportDef = reportsConfig[key];
  if (!reportDef) {
    return { ok: false, rows: [], droppedFields: [], error: `Rapport GA4 inconnu dans config/metrics.json: "${key}"` };
  }

  let dimensions = [...reportDef.dimensions];
  let metrics = [...reportDef.metrics];
  const droppedFields = [];

  for (let degradation = 0; degradation <= MAX_DEGRADATIONS; degradation++) {
    if (!metrics.length || !dimensions.length) {
      return { ok: false, rows: [], droppedFields, error: `${key}: plus aucun champ exploitable après dégradations` };
    }
    const body = buildBody(reportDef, dateRanges, dimensions, metrics);
    const payload = { key, body };
    try {
      const report = await withCache(month, payload, () => runReportPaged(body), { noCache });
      const rows = rowsToObjects(report);
      if (droppedFields.length) {
        logger.warn(`GA4 ${key}: rapport dégradé, champ(s) retiré(s): ${droppedFields.join(", ")}`);
      }
      return { ok: true, rows, droppedFields, error: null };
    } catch (err) {
      const status = err.response?.status;
      const message = err.response?.data?.error?.message || err.message || String(err);

      if (status !== 400 || degradation === MAX_DEGRADATIONS) {
        logger.warn(`GA4 ${key}: échec définitif (${status ?? "?"}) — ${message}`);
        return { ok: false, rows: [], droppedFields, error: message };
      }

      const faulty = extractFaultyField(message, [...dimensions, ...metrics]);
      if (!faulty) {
        logger.warn(`GA4 ${key}: erreur 400 sans champ identifiable — ${message}`);
        return { ok: false, rows: [], droppedFields, error: message };
      }

      if (metrics.includes(faulty)) metrics = metrics.filter((m) => m !== faulty);
      else dimensions = dimensions.filter((d) => d !== faulty);
      droppedFields.push(faulty);
      logger.warn(`GA4 ${key}: champ "${faulty}" retiré après 400, nouvelle tentative (dégradation ${degradation + 1}/${MAX_DEGRADATIONS})`);
    }
  }
  /* istanbul ignore next */
  return { ok: false, rows: [], droppedFields, error: "sonde de métriques: boucle épuisée" };
}

/** Clés de rapports déclarées dans config/metrics.json. */
export function reportKeys() {
  return Object.keys(reportsConfig);
}

/**
 * Exécute tous les rapports GA4 catalogués (config/metrics.json) pour un mois
 * calendaire donné. Chaque rapport est indépendant : l'échec de l'un ne casse
 * jamais la collecte des autres.
 */
export async function collectGa4ForMonth(month, { noCache = false } = {}) {
  const { start, end } = monthBounds(month);
  const dateRanges = [{ startDate: start, endDate: end }];
  const out = {};
  for (const key of reportKeys()) {
    out[key] = await runNamedReport(key, dateRanges, { noCache, month });
  }
  return out;
}

/** Sonde `doctor` : quels rapports/métriques sont réellement disponibles sur cette propriété. */
export async function probeAvailableMetrics(month) {
  return collectGa4ForMonth(month, { noCache: true });
}
