import { loadConfig } from "./env.js";

const sitesConfig = loadConfig("sites");
const noisePatterns = loadConfig("noise-patterns").patterns.map((p) => new RegExp(p, "i"));

const sitesByHost = new Map(sitesConfig.sites.map((s) => [s.host, s]));
const sitesByKey = new Map(sitesConfig.sites.map((s) => [s.key, s]));

export function allSites() {
  return sitesConfig.sites;
}

export function editorialSites() {
  return sitesConfig.sites.filter((s) => s.type === "editorial");
}

export function siteForHost(host) {
  return sitesByHost.get(host) || null;
}

export function siteForKey(key) {
  return sitesByKey.get(key) || null;
}

/**
 * Hosts présents dans des lignes GA4 (dimension hostName) mais absents du
 * registre `sites.json` — remontés en alerte qualité (§10.1) plutôt que
 * silencieusement écartés comme le faisait `classifyArticles` dans l'existant.
 * Somme `metricField` (sessions par défaut) pour donner la part réelle de
 * trafic concernée, pas juste un nombre de lignes.
 */
export function detectUnknownHosts(rows, { hostField = "hostName", metricField = "sessions" } = {}) {
  const unknown = new Map();
  let totalMetric = 0;
  for (const row of rows) {
    const value = Number(row[metricField] || 0);
    totalMetric += value;
    const host = row[hostField];
    if (!host) continue;
    if (!siteForHost(host)) unknown.set(host, (unknown.get(host) || 0) + value);
  }
  const hosts = [...unknown.entries()]
    .map(([host, value]) => ({ host, [metricField]: value }))
    .sort((a, b) => b[metricField] - a[metricField]);
  const totalUnknown = hosts.reduce((sum, h) => sum + h[metricField], 0);
  return {
    hosts,
    metricField,
    totalUnknown,
    totalMetric,
    sharePct: totalMetric > 0 ? (totalUnknown / totalMetric) * 100 : null,
  };
}

/** true si le path/URL matche un pattern de bruit de tracking (noise-patterns.json). */
export function isNoise(pathOrUrl) {
  if (!pathOrUrl) return false;
  return noisePatterns.some((re) => re.test(pathOrUrl));
}

/** Filtre le bruit d'une liste de lignes portant un champ path/url. */
export function filterNoise(rows, field) {
  return rows.filter((row) => !isNoise(row[field]));
}

/** Sépare une liste de lignes en { clean, noise } sur le même critère que `filterNoise`. */
export function partitionNoise(rows, field) {
  const clean = [];
  const noise = [];
  for (const row of rows) (isNoise(row[field]) ? noise : clean).push(row);
  return { clean, noise };
}

/**
 * Classification simple d'une URL/path : "blog" (sous le blogPathPrefix du
 * site), "produit" (chemin /products/), sinon "autre". Lecture seule —
 * n'implique aucune action, contrairement à `classify.js` de
 * `Suppression BLOG Useless` qui alimente un pipeline de suppression.
 */
export function classifyUrl(pathOrUrl, site) {
  if (!pathOrUrl) return "autre";
  if (site?.blogPathPrefix && pathOrUrl.includes(site.blogPathPrefix)) return "blog";
  if (/\/products\//i.test(pathOrUrl)) return "produit";
  return "autre";
}

export { sitesConfig };
