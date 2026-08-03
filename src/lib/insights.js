import { loadConfig } from "./env.js";

// Détections déterministes (zéro IA, zéro réseau) sur les données GSC (§7).

const brandTerms = loadConfig("brand-terms").terms.map((t) => t.toLowerCase());
const seoThresholds = loadConfig("thresholds").seo;

function normalize(text) {
  return (text || "").toLowerCase().replace(/[-]/g, " ").trim();
}

function median(values) {
  if (!values.length) return null;
  const arr = [...values].sort((a, b) => a - b);
  const mid = Math.floor(arr.length / 2);
  return arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
}

/** true si la requête contient un terme de marque (brand-terms.json). */
export function isBranded(query) {
  const q = normalize(query);
  return brandTerms.some((term) => q.includes(normalize(term)));
}

/**
 * Split branded / non-branded (§7) sur des requêtes GSC { query, clicks,
 * impressions }. Un déclin non-branded est un vrai signal SEO ; un déclin
 * branded est un signal de notoriété — les deux doivent rester distincts.
 */
export function splitBranded(queryRows) {
  const branded = { clicks: 0, impressions: 0, queries: 0 };
  const nonBranded = { clicks: 0, impressions: 0, queries: 0 };
  for (const row of queryRows || []) {
    const bucket = isBranded(row.query) ? branded : nonBranded;
    bucket.clicks += row.clicks || 0;
    bucket.impressions += row.impressions || 0;
    bucket.queries += 1;
  }
  return { branded, nonBranded };
}

/** Buckets de position (1-3/4-10/11-20/21+, config/thresholds.json) — clics/impressions par bucket. */
export function positionBuckets(queryRows) {
  const buckets = seoThresholds.positionBuckets.map((b) => ({ ...b, clicks: 0, impressions: 0 }));
  for (const row of queryRows || []) {
    const pos = row.position;
    if (pos == null) continue;
    const bucket = buckets.find((b) => pos >= b.min && (b.max == null || pos <= b.max));
    if (bucket) {
      bucket.clicks += row.clicks || 0;
      bucket.impressions += row.impressions || 0;
    }
  }
  return buckets;
}

/** CTR médian observé pour les requêtes proches de la position 3 (référence "et si on était en position 3 ?"). */
function expectedCtrAtPosition3(queryRows) {
  const rows = (queryRows || []).filter((r) => r.impressions > 0 && r.position != null);
  const near3 = rows.filter((r) => r.position >= 2.5 && r.position < 3.5);
  const pool = near3.length ? near3 : rows.filter((r) => r.position >= 1 && r.position <= 3);
  if (!pool.length) return null;
  return median(pool.map((r) => r.clicks / r.impressions));
}

/**
 * Striking distance (§7) : position entre `minPosition` et `maxPosition` ET
 * impressions ≥ seuil → top N opportunités, triées par
 * impressions × (CTR attendu à position 3 − CTR actuel).
 */
export function strikingDistance(queryRows, overrides = {}) {
  const cfg = { ...seoThresholds.strikingDistance, ...overrides };
  const expectedCtr = expectedCtrAtPosition3(queryRows);

  const opportunities = (queryRows || [])
    .filter((r) => r.position != null && r.position >= cfg.minPosition && r.position <= cfg.maxPosition && (r.impressions || 0) >= cfg.minImpressions)
    .map((r) => {
      const actualCtr = r.impressions > 0 ? r.clicks / r.impressions : 0;
      const potentialCtrGain = expectedCtr != null ? Math.max(0, expectedCtr - actualCtr) : null;
      return {
        query: r.query,
        position: r.position,
        clicks: r.clicks,
        impressions: r.impressions,
        actualCtr,
        potentialCtrGain,
        opportunityScore: potentialCtrGain != null ? r.impressions * potentialCtrGain : null,
      };
    })
    .sort((a, b) => (b.opportunityScore ?? 0) - (a.opportunityScore ?? 0))
    .slice(0, cfg.topN);

  return { expectedCtrAtPosition3: expectedCtr, opportunities };
}

/**
 * CTR sous-performant (§7) : CTR réel < `ratioOfMedian` du CTR médian observé
 * à la même position (arrondie à l'entier) sur l'ensemble du corpus fourni.
 */
export function ctrUnderperforming(queryRows, overrides = {}) {
  const cfg = { ...seoThresholds.ctrUnderperforming, ...overrides };
  const rows = (queryRows || []).filter((r) => (r.impressions || 0) > 0 && r.position != null);

  const byPosition = new Map();
  for (const r of rows) {
    const p = Math.round(r.position);
    if (!byPosition.has(p)) byPosition.set(p, []);
    byPosition.get(p).push(r.clicks / r.impressions);
  }
  const medianCtrByPosition = new Map([...byPosition.entries()].map(([p, ctrs]) => [p, median(ctrs)]));

  const underperformers = [];
  for (const r of rows) {
    const p = Math.round(r.position);
    const medianCtr = medianCtrByPosition.get(p);
    const actualCtr = r.clicks / r.impressions;
    if (medianCtr != null && medianCtr > 0 && actualCtr < medianCtr * cfg.ratioOfMedian) {
      underperformers.push({ query: r.query, position: r.position, clicks: r.clicks, impressions: r.impressions, actualCtr, medianCtrAtPosition: medianCtr });
    }
  }
  return underperformers.sort((a, b) => b.impressions - a.impressions);
}

/** Gagnants / perdants MoM (§7) : Δclics ≥ seuil, dans les deux sens. `key`: "query" ou "page". */
export function winnersLosers(currentRows, previousRows, { key = "query", ...overrides } = {}) {
  const cfg = { ...seoThresholds.winnersLosers, ...overrides };
  const prevMap = new Map((previousRows || []).map((r) => [r[key], r]));
  const winners = [];
  const losers = [];
  for (const row of currentRows || []) {
    const before = prevMap.get(row[key]);
    const delta = (row.clicks || 0) - (before?.clicks || 0);
    const entry = { [key]: row[key], clicksNow: row.clicks || 0, clicksBefore: before?.clicks || 0, delta };
    if (delta >= cfg.minClickDelta) winners.push(entry);
    else if (delta <= -cfg.minClickDelta) losers.push(entry);
  }
  winners.sort((a, b) => b.delta - a.delta);
  losers.sort((a, b) => a.delta - b.delta);
  return { winners: winners.slice(0, cfg.topN), losers: losers.slice(0, cfg.topN) };
}

/** Requêtes/pages apparues (présentes maintenant, absentes avant) et disparues (l'inverse). */
export function appearedDisappeared(currentRows, previousRows, key = "query") {
  const currentSet = new Set((currentRows || []).map((r) => r[key]));
  const previousSet = new Set((previousRows || []).map((r) => r[key]));
  return {
    appeared: (currentRows || []).filter((r) => !previousSet.has(r[key])),
    disappeared: (previousRows || []).filter((r) => !currentSet.has(r[key])),
  };
}

/**
 * Cannibalisation (§7) : une même requête servie par ≥ `minPagesPerQuery`
 * pages ayant chacune ≥ `minImpressionsPerPage` impressions → à arbitrer.
 * Entrée : lignes GSC `pageQuery` ({ page, query, clicks, impressions, position }).
 */
export function cannibalization(pageQueryRows, overrides = {}) {
  const cfg = { ...seoThresholds.cannibalization, ...overrides };
  const byQuery = new Map();
  for (const row of pageQueryRows || []) {
    if (!byQuery.has(row.query)) byQuery.set(row.query, []);
    byQuery.get(row.query).push(row);
  }

  const conflicts = [];
  for (const [query, rows] of byQuery.entries()) {
    const eligible = rows.filter((r) => (r.impressions || 0) >= cfg.minImpressionsPerPage);
    if (eligible.length >= cfg.minPagesPerQuery) {
      conflicts.push({
        query,
        pages: eligible
          .map((r) => ({ page: r.page, clicks: r.clicks, impressions: r.impressions, position: r.position }))
          .sort((a, b) => b.impressions - a.impressions),
      });
    }
  }
  return conflicts.sort((a, b) => b.pages.length - a.pages.length || b.pages[0].impressions - a.pages[0].impressions);
}

/** Assemble tous les dérivés SEO (§7) pour un site à partir de ses rapports GSC courant/précédent. */
export function buildSeoInsights({ queriesCurrent, queriesPrevious, pageQueryCurrent }) {
  return {
    brandSplit: splitBranded(queriesCurrent),
    positionBuckets: positionBuckets(queriesCurrent),
    strikingDistance: strikingDistance(queriesCurrent),
    ctrUnderperforming: ctrUnderperforming(queriesCurrent),
    winnersLosers: winnersLosers(queriesCurrent, queriesPrevious, { key: "query" }),
    appearedDisappeared: appearedDisappeared(queriesCurrent, queriesPrevious, "query"),
    cannibalization: cannibalization(pageQueryCurrent),
  };
}
