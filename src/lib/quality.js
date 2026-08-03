import { loadConfig } from "./env.js";
import { isNoise, siteForHost, sitesConfig } from "./normalize.js";

// Fonctions pures (zéro réseau) : chaque contrôle prend des données déjà
// collectées et renvoie { id, level: "ok"|"warn"|"critical", title, detail, impact }.
// `impact` est `null` quand level === "ok" (rien à signaler).

const thresholds = loadConfig("thresholds").quality;

function pct(n) {
  return n == null ? "n/d" : `${n.toFixed(1)}%`;
}

/** §10.1 — hosts GA4 (hostName) absents de sites.json. */
export function checkUnknownHosts(unknownHosts, { criticalPct = thresholds.unknownHostsCriticalPct } = {}) {
  const { hosts, totalUnknown, sharePct, metricField = "sessions" } = unknownHosts;
  const level = !hosts.length ? "ok" : sharePct != null && sharePct >= criticalPct ? "critical" : "warn";
  return {
    id: "unknown-hosts",
    level,
    title: "Hosts GA4 non déclarés",
    detail: hosts.length
      ? `${hosts.length} host(s) inconnu(s) de sites.json : ${hosts.map((h) => `${h.host} (${h[metricField]} ${metricField})`).join(", ")} — ${totalUnknown} ${metricField} au total (${pct(sharePct)} du trafic).`
      : "Tous les hosts vus par GA4 sont déclarés dans sites.json.",
    impact: hosts.length ? "Ce trafic est exclu des analyses par site tant que le host n'est pas déclaré (ou marqué `discovered`)." : null,
  };
}

/** §10.2 — % de sessions sur des landing pages bruitées (noise-patterns.json). */
export function checkTrackingNoise(landingPageRows, { warnPct = thresholds.noiseShareWarnPct, criticalPct = thresholds.noiseShareCriticalPct } = {}) {
  let total = 0;
  let noise = 0;
  for (const row of landingPageRows || []) {
    const sessions = Number(row.sessions || 0);
    total += sessions;
    if (isNoise(row.landingPage)) noise += sessions;
  }
  const sharePct = total > 0 ? (noise / total) * 100 : null;
  const level = sharePct == null ? "ok" : sharePct >= criticalPct ? "critical" : sharePct >= warnPct ? "warn" : "ok";
  return {
    id: "tracking-noise",
    level,
    title: "Bruit de tracking",
    detail: sharePct != null
      ? `${noise} sessions (${pct(sharePct)}) sur des landing pages bruitées (pixels, paramètres, sandbox…).`
      : "Pas de données de landing pages pour évaluer le bruit.",
    impact: level !== "ok" ? "Les analyses de trafic/pages sont faussées par du trafic non exploitable tant qu'il n'est pas filtré." : null,
  };
}

/** §10.3 — site avec sessions ≥ seuil et revenu = 0 €. */
export function checkMissingRevenue(overviewRows, { minSessions = thresholds.revenueMissingMinSessions } = {}) {
  const offenders = [];
  for (const row of overviewRows || []) {
    const sessions = Number(row.sessions || 0);
    const revenue = Number(row.totalRevenue || 0);
    if (sessions >= minSessions && revenue === 0) {
      const site = siteForHost(row.hostName);
      offenders.push({ host: row.hostName, siteKey: site?.key || null, sessions });
    }
  }
  return {
    id: "missing-revenue",
    level: offenders.length ? "critical" : "ok",
    title: "Revenu manquant malgré du trafic",
    detail: offenders.length
      ? offenders.map((o) => `${o.siteKey || o.host}: ${o.sessions} sessions, 0 € de revenu`).join(" · ")
      : `Aucun site avec ≥ ${minSessions} sessions et 0 € de revenu.`,
    impact: offenders.length ? "Conversion probablement non trackée (pixel Shopify cassé, ou site sans vocation e-commerce à confirmer)." : null,
  };
}

/**
 * §10.4 — écart entre CA GA4 (pixel) et CA Shopify (commandes réelles), par
 * site. GA4 (une seule propriété) reporte dans UNE SEULE devise pour tout le
 * compte (`sites.json.ga4ReportingCurrency`), indépendamment de la devise
 * réelle de chaque boutique Shopify (`result.data.currency`, qui fait
 * autorité — voir sites.json) : si les deux diffèrent (ex. EN facturé en USD
 * alors que GA4 reporte en EUR), la comparaison brute n'a pas de sens (pas de
 * conversion de change disponible ici) — le site est neutralisé plutôt que
 * silencieusement comparé entre devises différentes.
 */
export function checkGa4ShopifyDiscrepancy(
  ga4RevenueBySite,
  shopifyResults,
  { warnPct = thresholds.ga4ShopifyDiscrepancyWarnPct, ga4Currency = sitesConfig.ga4ReportingCurrency } = {}
) {
  const offenders = [];
  const compared = [];
  const currencyMismatches = [];
  for (const [siteKey, result] of Object.entries(shopifyResults || {})) {
    if (!result.ok || result.data == null) continue; // pas de comparaison possible sans données Shopify
    const shopifyRevenue = result.data.netRevenue;
    const shopifyCurrency = result.data.currency;
    const ga4Revenue = ga4RevenueBySite[siteKey];
    if (ga4Revenue == null || shopifyRevenue == null || shopifyRevenue === 0) continue;
    if (shopifyCurrency && ga4Currency && shopifyCurrency !== ga4Currency) {
      currencyMismatches.push({ siteKey, shopifyCurrency, ga4Currency });
      continue; // devises différentes : comparaison neutralisée, jamais silencieuse
    }
    const diffPct = (Math.abs(ga4Revenue - shopifyRevenue) / Math.abs(shopifyRevenue)) * 100;
    compared.push(siteKey);
    if (diffPct > warnPct) offenders.push({ siteKey, ga4Revenue, shopifyRevenue, diffPct });
  }
  const mismatchNote = currencyMismatches.length
    ? `Comparaison neutralisée pour ${currencyMismatches.map((m) => `${m.siteKey} (Shopify ${m.shopifyCurrency} vs GA4 supposé ${m.ga4Currency})`).join(", ")} : devises différentes, aucune conversion de change fiable disponible ici.`
    : "";
  return {
    id: "ga4-shopify-discrepancy",
    level: offenders.length ? "warn" : "ok",
    title: "Écart GA4 ↔ Shopify",
    detail:
      (offenders.length
        ? offenders.map((o) => `${o.siteKey}: GA4 ${Math.round(o.ga4Revenue)} vs Shopify ${Math.round(o.shopifyRevenue)} (écart ${o.diffPct.toFixed(0)}%)`).join(" · ") + "."
        : compared.length
          ? `Écart < ${warnPct}% sur ${compared.join(", ")}.`
          : "Comparaison impossible (Shopify indisponible, revenu Shopify nul, ou devises différentes)."
      ) + (mismatchNote ? ` ${mismatchNote}` : ""),
    impact: offenders.length
      ? "Le CA affiché dans un des deux systèmes est probablement mal attribué (pixel, remboursements, commandes hors ligne)."
      : currencyMismatches.length
        ? "Écart non évalué pour ces boutiques : GA4 et Shopify ne sont pas dans la même devise, un rapprochement fiable nécessiterait une conversion de change non disponible ici."
        : null,
  };
}

/** §10.5 — jours manquants ou à zéro dans la série quotidienne (rapport GA4 `daily`). */
export function checkDataGaps(dailyRows, bounds, { criticalDays = thresholds.dataGapsCriticalDays } = {}) {
  const byDate = new Map();
  for (const row of dailyRows || []) {
    byDate.set(row.date, (byDate.get(row.date) || 0) + Number(row.sessions || 0));
  }
  const gaps = [];
  const start = new Date(`${bounds.start}T00:00:00.000Z`);
  const end = new Date(`${bounds.end}T00:00:00.000Z`);
  for (let d = new Date(start); d.getTime() <= end.getTime(); d.setUTCDate(d.getUTCDate() + 1)) {
    const key = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
    if ((byDate.get(key) || 0) === 0) {
      gaps.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`);
    }
  }
  return {
    id: "data-gaps",
    level: !gaps.length ? "ok" : gaps.length >= criticalDays ? "critical" : "warn",
    title: "Trous dans la série quotidienne",
    detail: gaps.length ? `${gaps.length} jour(s) à 0 session : ${gaps.join(", ")}.` : "Aucun jour à 0 session sur le mois.",
    impact: gaps.length ? "Tracking probablement interrompu ces jours-là — à vérifier avant de conclure sur une tendance." : null,
  };
}

/**
 * §10.6 — part de `(not set)`/`(other)` sur des dimensions clés.
 * `dimensions` : [{ name, rows, dimensionField, metricField? }].
 */
export function checkCardinality(dimensions, { warnPct = thresholds.cardinalityWarnPct } = {}) {
  const results = (dimensions || []).map(({ name, rows, dimensionField, metricField = "sessions" }) => {
    let total = 0;
    let unresolved = 0;
    for (const row of rows || []) {
      const v = Number(row[metricField] || 0);
      total += v;
      if (row[dimensionField] === "(not set)" || row[dimensionField] === "(other)") unresolved += v;
    }
    return { name, sharePct: total > 0 ? (unresolved / total) * 100 : null };
  });
  const worst = results.reduce(
    (a, b) => ((b.sharePct ?? -1) > (a?.sharePct ?? -1) ? b : a),
    results[0] || { name: null, sharePct: null }
  );
  const level = !results.length || worst.sharePct == null ? "ok" : worst.sharePct >= warnPct ? "warn" : "ok";
  return {
    id: "cardinality",
    level,
    title: "Cardinalité des dimensions clés",
    detail: results.length
      ? results.map((r) => `${r.name}: ${pct(r.sharePct)}`).join(" · ")
      : "Pas de dimension à évaluer.",
    impact: level !== "ok" ? `Dimension "${worst.name}" peu fiable (≥ ${warnPct}% en (not set)/(other)) — les segments qui en dépendent sont à prendre avec prudence.` : null,
  };
}

/** §10.7 — propriétés Search Console injoignables, mois incomplet. */
export function checkGscCoverage(gscResultsBySite) {
  const entries = Object.entries(gscResultsBySite || {});
  const unreachable = entries.filter(([, r]) => !r.ok).map(([key]) => key);
  return {
    id: "gsc-coverage",
    level: !unreachable.length ? "ok" : unreachable.length === entries.length ? "critical" : "warn",
    title: "Couverture Search Console",
    detail: unreachable.length
      ? `${unreachable.length}/${entries.length} propriété(s) injoignable(s) : ${unreachable.join(", ")}.`
      : `Les ${entries.length} propriété(s) déclarée(s) ont répondu.`,
    impact: unreachable.length ? "Section SEO incomplète pour ces sites — chiffres GSC affichés « indisponibles », jamais remplacés par 0." : null,
  };
}

/** §10.8 — part du trafic dans le channel group "Unassigned". */
export function checkUnassignedTraffic(channelRows, { warnPct = thresholds.unassignedWarnPct, criticalPct = thresholds.unassignedCriticalPct } = {}) {
  let total = 0;
  let unassigned = 0;
  for (const row of channelRows || []) {
    const sessions = Number(row.sessions || 0);
    total += sessions;
    if (row.sessionDefaultChannelGroup === "Unassigned") unassigned += sessions;
  }
  const sharePct = total > 0 ? (unassigned / total) * 100 : null;
  const level = sharePct == null ? "ok" : sharePct >= criticalPct ? "critical" : sharePct >= warnPct ? "warn" : "ok";
  return {
    id: "unassigned-traffic",
    level,
    title: "Trafic non attribué",
    detail: sharePct != null
      ? `${unassigned} sessions (${pct(sharePct)}) en canal "Unassigned".`
      : "Pas de données de canaux pour évaluer l'attribution.",
    impact: level !== "ok" ? "Une part significative du trafic n'est attribuée à aucun canal — l'analyse d'acquisition sous-estime les vrais moteurs." : null,
  };
}

/** §10.9 — champs GA4 retirés par la sonde de métriques (ou rapport entièrement en échec). */
export function checkUnavailableMetrics(ga4Results) {
  const dropped = [];
  for (const [reportKey, result] of Object.entries(ga4Results || {})) {
    if (result.droppedFields?.length) dropped.push({ report: reportKey, fields: result.droppedFields, error: null });
    else if (!result.ok) dropped.push({ report: reportKey, fields: [], error: result.error });
  }
  return {
    id: "unavailable-metrics",
    level: dropped.length ? "warn" : "ok",
    title: "Métriques/dimensions GA4 indisponibles",
    detail: dropped.length
      ? dropped.map((d) => (d.fields.length ? `${d.report}: ${d.fields.join(", ")} retiré(s)` : `${d.report}: en échec (${d.error})`)).join(" · ")
      : "Tous les champs GA4 catalogués (config/metrics.json) sont disponibles sur cette propriété.",
    impact: dropped.length ? "Certaines colonnes du rapport sont absentes — vérifier la config du compte GA4 (Événements clés, e-commerce…)." : null,
  };
}

/**
 * Exécute les 9 contrôles qualité (§10) à partir d'un snapshot (§13) déjà
 * collecté. Construit les vues dérivées nécessaires (revenu GA4 par site,
 * canaux tous sites confondus…) puis délègue à chaque contrôle unitaire.
 */
export function runQualityChecks(snapshot) {
  const current = snapshot.sources.ga4.current;
  const gscCurrent = snapshot.sources.gsc.current;
  const shopifyCurrent = snapshot.sources.shopify.current;

  const overviewRows = current.overview?.ok ? current.overview.rows : [];
  const landingPageRows = current.landingPages?.ok ? current.landingPages.rows : [];
  const channelRows = current.channelsLastTouch?.ok ? current.channelsLastTouch.rows : [];
  const sourceMediumRows = current.sourceMedium?.ok ? current.sourceMedium.rows : [];
  const dailyRows = current.daily?.ok ? current.daily.rows : [];

  // Revenu GA4 par clé de site Shopify (EN/FR/EU), agrégé sur les hosts qui pointent vers cette boutique.
  const ga4RevenueBySite = {};
  for (const row of overviewRows) {
    const site = siteForHost(row.hostName);
    if (!site?.shopifyEnv) continue;
    ga4RevenueBySite[site.shopifyEnv] = (ga4RevenueBySite[site.shopifyEnv] || 0) + Number(row.totalRevenue || 0);
  }

  return [
    checkUnknownHosts(snapshot.unknownHosts),
    checkTrackingNoise(landingPageRows),
    checkMissingRevenue(overviewRows),
    checkGa4ShopifyDiscrepancy(ga4RevenueBySite, shopifyCurrent),
    checkDataGaps(dailyRows, snapshot.bounds),
    checkCardinality([
      { name: "sessionDefaultChannelGroup", rows: channelRows, dimensionField: "sessionDefaultChannelGroup" },
      { name: "sessionSourceMedium", rows: sourceMediumRows, dimensionField: "sessionSourceMedium" },
    ]),
    checkGscCoverage(gscCurrent),
    checkUnassignedTraffic(channelRows),
    checkUnavailableMetrics(current),
  ];
}
