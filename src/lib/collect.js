import { previousMonth, sameMonthLastYear, monthBounds } from "./period.js";
import { collectGa4ForMonth } from "./ga4.js";
import { collectGscForMonth } from "./gsc.js";
import { collectShopifyForMonth } from "./shopify.js";
import { allSites, detectUnknownHosts } from "./normalize.js";
import { logger } from "./logger.js";

const PERIOD_KEYS = ["current", "previous", "yearAgo"];

function monthsForPeriods(month) {
  return {
    current: month,
    previous: previousMonth(month),
    yearAgo: sameMonthLastYear(month),
  };
}

/**
 * Collecte GA4 + GSC + Shopify pour le mois demandé ET ses deux mois de
 * comparaison (M-1, M-12) — les rapports GA4 (§6) et les KPI (§9) comparent
 * MoM/YoY directement à partir d'un seul snapshot, sans dépendre de
 * l'existence préalable d'autres fichiers `data/monthly/*.json`.
 *
 * Isolation des pannes (§14) : chaque source renvoie `{ ok, ..., error }` et
 * une source morte (site GSC introuvable, boutique Shopify sans scope,
 * rapport GA4 en échec) dégrade uniquement sa section — jamais le run entier.
 */
export async function collectSnapshot(month, { noCache = false } = {}) {
  const months = monthsForPeriods(month);
  const sites = allSites();

  const warnings = [];
  const failures = [];
  const droppedFields = [];

  const ga4 = {};
  const gsc = {};
  const shopify = {};
  let unknownHosts = { hosts: [], metricField: "sessions", totalUnknown: 0, totalMetric: 0, sharePct: null };

  for (const periodKey of PERIOD_KEYS) {
    const m = months[periodKey];

    logger.info(`Collecte GA4 [${periodKey}=${m}]...`);
    ga4[periodKey] = await collectGa4ForMonth(m, { noCache });
    for (const [reportKey, result] of Object.entries(ga4[periodKey])) {
      if (!result.ok) {
        failures.push(`GA4.${reportKey} [${periodKey}=${m}]: ${result.error}`);
      }
      if (result.droppedFields?.length) {
        droppedFields.push({ period: periodKey, month: m, source: "ga4", report: reportKey, fields: result.droppedFields });
        warnings.push(`GA4.${reportKey} [${periodKey}=${m}]: champ(s) retiré(s) par la sonde — ${result.droppedFields.join(", ")}`);
      }
    }
    if (periodKey === "current" && ga4.current.overview?.ok) {
      unknownHosts = detectUnknownHosts(ga4.current.overview.rows, { metricField: "sessions" });
      if (unknownHosts.hosts.length) {
        warnings.push(
          `Hosts GA4 inconnus (${m}): ${unknownHosts.hosts.map((h) => `${h.host} (${h.sessions} sessions)`).join(", ")} ` +
          `— ${unknownHosts.sharePct?.toFixed(1) ?? "?"}% du trafic total`
        );
      }
    }

    logger.info(`Collecte GSC [${periodKey}=${m}]...`);
    gsc[periodKey] = await collectGscForMonth(sites, m, { noCache });
    for (const [siteKey, result] of Object.entries(gsc[periodKey])) {
      if (!result.ok) warnings.push(`GSC.${siteKey} [${periodKey}=${m}]: ${result.error}`);
    }

    logger.info(`Collecte Shopify [${periodKey}=${m}]...`);
    shopify[periodKey] = await collectShopifyForMonth(m, { noCache });
    for (const [siteKey, result] of Object.entries(shopify[periodKey])) {
      if (!result.ok) warnings.push(`Shopify.${siteKey} [${periodKey}=${m}]: ${result.reason}`);
    }
  }

  return {
    month,
    generatedAt: new Date().toISOString(),
    bounds: monthBounds(month),
    months,
    unknownHosts,
    sources: { ga4, gsc, shopify },
    collection: { droppedFields, failures, warnings },
  };
}

const SOURCE_LABELS = { ga4: "GA4", gsc: "GSC", shopify: "Shopify" };

/** Toutes les entrées `{ periodKey, key }` d'une source (ga4/gsc/shopify) dont le résultat est `ok:false`. */
function findFailedEntries(bySource) {
  const failures = [];
  for (const [periodKey, byKey] of Object.entries(bySource || {})) {
    for (const [key, entry] of Object.entries(byKey || {})) {
      if (entry && entry.ok === false) failures.push({ periodKey, key });
    }
  }
  return failures;
}

function failureReason(entry) {
  return entry?.reason || entry?.error || "échec inconnu";
}

/**
 * Passe de réparation d'un snapshot déjà écrit (§13 — l'immuabilité doit
 * protéger les données *réussies*, pas des échecs devenus périmés : un
 * snapshot collecté avant l'ajout du scope Shopify `read_orders`, par
 * exemple, reste bloqué sur `{ ok:false }` indéfiniment sinon).
 *
 * On ne retente QUE les entrées en échec — jamais une recollecte complète —
 * en relançant `collectSnapshot` (paramètre `collectFn`, injectable pour les
 * tests) : le cache disque de chaque collecteur (ga4/gsc/shopify) ne
 * mémorise jamais un échec, seulement un succès (voir `withCache`), donc les
 * sources déjà `ok:true` reviennent instantanément du cache — aucun coût de
 * quota supplémentaire, seules les entrées réellement en échec déclenchent un
 * nouvel appel réseau. Ce qui réussit cette fois est fusionné dans le
 * snapshot d'origine ; ce qui échoue encore est conservé tel quel, sans
 * jamais planter.
 */
export async function repairSnapshot(snapshot, { noCache = false, collectFn = collectSnapshot } = {}) {
  const sourceNames = ["ga4", "gsc", "shopify"];
  const failuresBySource = {};
  let totalFailures = 0;
  for (const name of sourceNames) {
    const failures = findFailedEntries(snapshot.sources[name]);
    if (failures.length) {
      failuresBySource[name] = failures;
      totalFailures += failures.length;
    }
  }

  if (!totalFailures) return { snapshot, repaired: [], changed: false };

  logger.info(
    `Snapshot ${snapshot.month} : ${totalFailures} entrée(s) en échec détectée(s) — tentative de réparation ciblée ` +
    "(les sources déjà réussies ne sont jamais recollectées)..."
  );
  const candidate = await collectFn(snapshot.month, { noCache });

  const repaired = [];
  for (const [name, failures] of Object.entries(failuresBySource)) {
    for (const { periodKey, key } of failures) {
      const before = snapshot.sources[name]?.[periodKey]?.[key];
      const after = candidate.sources?.[name]?.[periodKey]?.[key];
      if (after?.ok) {
        snapshot.sources[name][periodKey][key] = after;
        repaired.push({ source: name, periodKey, key, previousReason: failureReason(before) });
      }
    }
  }

  if (!repaired.length) {
    logger.info(`Snapshot ${snapshot.month} : réparation tentée, toujours indisponible — échec conservé, run non bloqué.`);
    return { snapshot, repaired, changed: false };
  }

  snapshot.repairs = [
    ...(snapshot.repairs || []),
    ...repaired.map((r) => ({ ...r, repairedAt: new Date().toISOString() })),
  ];

  // Regroupe par (source, raison de l'échec précédent) pour un message par
  // groupe (ex. "Shopify EN/FR/EU") plutôt qu'une ligne par boutique/rapport/site.
  const groups = new Map();
  for (const r of repaired) {
    const groupKey = `${r.source}::${r.previousReason}`;
    if (!groups.has(groupKey)) groups.set(groupKey, { source: r.source, reason: r.previousReason, keys: [] });
    const g = groups.get(groupKey);
    if (!g.keys.includes(r.key)) g.keys.push(r.key);
  }
  for (const g of groups.values()) {
    const label = SOURCE_LABELS[g.source] || g.source;
    logger.info(`Réparation du snapshot ${snapshot.month} : ${label} ${g.keys.join("/")} récupéré (échec précédent : ${g.reason})`);
  }

  return { snapshot, repaired, changed: true };
}
