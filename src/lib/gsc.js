import { googleRequest } from "./google.js";
import { withCache } from "./cache.js";
import { monthBounds } from "./period.js";
import { logger } from "./logger.js";

const API = "https://searchconsole.googleapis.com/webmasters/v3";

// SPEC §7 — un rapport par clé, volume max par dimension.
const REPORTS = {
  siteTotals: { dimensions: [], rowLimit: 1 },
  queries: { dimensions: ["query"], rowLimit: 1000 },
  pages: { dimensions: ["page"], rowLimit: 1000 },
  pageQuery: { dimensions: ["page", "query"], rowLimit: 5000 },
  countries: { dimensions: ["country"], rowLimit: 100 },
  devices: { dimensions: ["device"], rowLimit: 10 },
  appearance: { dimensions: ["searchAppearance"], rowLimit: 25 },
};

function normalizeRow(row, dimensions) {
  const o = {};
  dimensions.forEach((d, i) => (o[d] = row.keys ? row.keys[i] : undefined));
  o.clicks = row.clicks ?? 0;
  o.impressions = row.impressions ?? 0;
  o.ctr = row.ctr ?? 0;
  o.position = row.position ?? null;
  return o;
}

async function runReport(siteUrl, startDate, endDate, reportDef, { noCache, month }) {
  const body = {
    startDate,
    endDate,
    dimensions: reportDef.dimensions,
    rowLimit: reportDef.rowLimit,
  };
  const url = `${API}/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`;
  const payload = { siteUrl, body };
  const data = await withCache(month, payload, () => googleRequest(url, body), { noCache });
  return (data.rows || []).map((r) => normalizeRow(r, reportDef.dimensions));
}

function errorMessage(err) {
  return err.response?.data?.error?.message || err.message || String(err);
}

/**
 * Collecte tous les rapports GSC (§7) pour un site sur un mois calendaire.
 * Chaque rapport est isolé (un rapport en échec n'empêche pas les autres) ;
 * si TOUS échouent, le site est considéré injoignable — un warn, jamais une
 * erreur qui casse le run global (propriété absente pour les hosts découverts
 * `ca`/`keep`, par exemple).
 */
export async function collectGscForSite(site, month, { noCache = false } = {}) {
  const { start, end } = monthBounds(month);
  const reports = {};
  const errors = [];

  for (const [key, reportDef] of Object.entries(REPORTS)) {
    try {
      reports[key] = await runReport(site.gscSiteUrl, start, end, reportDef, { noCache, month });
    } catch (err) {
      const message = errorMessage(err);
      logger.warn(`GSC ${site.key} (${site.gscSiteUrl}) — rapport "${key}" indisponible: ${message}`);
      reports[key] = null;
      errors.push(`${key}: ${message}`);
    }
  }

  const allFailed = Object.values(reports).every((r) => r === null);
  if (allFailed) {
    logger.warn(`GSC: site ${site.key} (${site.gscSiteUrl}) entièrement injoignable — section dégradée, run non bloqué`);
    return { ok: false, reports, errors, error: errors[0] || "site injoignable" };
  }
  return { ok: true, reports, errors, error: null };
}

/**
 * Collecte GSC pour tous les sites déclarés dans sites.json. Chaque site est
 * isolé : un site mort (propriété absente, accès refusé) ne bloque pas les
 * autres — voir SPEC §7 et l'entrée « angles morts » sur `ca`/`keep`.
 */
export async function collectGscForMonth(sites, month, { noCache = false } = {}) {
  const out = {};
  for (const site of sites) {
    out[site.key] = await collectGscForSite(site, month, { noCache });
  }
  return out;
}
