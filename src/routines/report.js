import path from "node:path";
import fs from "node:fs";
import { paths } from "../lib/env.js";
import { logger } from "../lib/logger.js";
import { isDataReady, latestClosedMonth } from "../lib/period.js";
import {
  share,
  revenuePerSession,
  conversionRate,
  aov,
  funnel as computeFunnel,
  significantDelta,
  significanceThresholds,
  attributionGap,
} from "../lib/metrics.js";
import { runQualityChecks } from "../lib/quality.js";
import { buildSeoInsights } from "../lib/insights.js";
import { siteForHost, classifyUrl } from "../lib/normalize.js";
import { channelLabel } from "../lib/shopify.js";
import { collectSnapshot, repairSnapshot } from "../lib/collect.js";
import { readSnapshot, writeSnapshot } from "../lib/store.js";
import { runAnalysisAgents, skippedAgentResult, AGENT_KEYS } from "../lib/claude.js";
import { formatChartNumber } from "../report/charts.js";
import { renderMarkdown } from "../report/markdown.js";
import { renderHtml } from "../report/html.js";
import { sendReport, sendFailureAlert } from "../report/slack.js";

// `report` (§4) : charge le snapshot (le collecte s'il manque) → construit le
// modèle de rapport (KPI §9, qualité §10, dérivés SEO §7) → agents Claude
// (§11, sauf --no-ai) → écrit reports/YYYY-MM/{RAPPORT.md, rapport.html,
// data.json} → Slack (sauf --no-slack).

const MONTH_NAMES_FR = [
  "janvier", "février", "mars", "avril", "mai", "juin",
  "juillet", "août", "septembre", "octobre", "novembre", "décembre",
];

function monthLabel(month) {
  const [y, m] = month.split("-").map(Number);
  return `${MONTH_NAMES_FR[m - 1]} ${y}`;
}

const preciseFormatter = new Intl.NumberFormat("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function fmtPrecise(n) {
  return n == null || !Number.isFinite(n) ? "n/d" : preciseFormatter.format(n);
}

function median(values) {
  if (!values.length) return null;
  const arr = [...values].sort((a, b) => a - b);
  const mid = Math.floor(arr.length / 2);
  return arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
}

function sumField(rows, field) {
  return (rows || []).reduce((sum, r) => sum + (Number(r[field]) || 0), 0);
}

function aggregateBy(rows, keyField, valueFields) {
  const map = new Map();
  for (const row of rows || []) {
    const key = row[keyField] ?? "(non défini)";
    if (!map.has(key)) map.set(key, Object.fromEntries(valueFields.map((f) => [f, 0])));
    const entry = map.get(key);
    for (const f of valueFields) entry[f] += Number(row[f]) || 0;
  }
  return map;
}

function topAggregated(rows, keyField, valueField, topN = 15) {
  const map = aggregateBy(rows, keyField, [valueField]);
  return [...map.entries()]
    .map(([key, v]) => ({ [keyField]: key, [valueField]: v[valueField] }))
    .sort((a, b) => b[valueField] - a[valueField])
    .slice(0, topN);
}

function ga4Rows(periodSources, key) {
  return periodSources?.[key]?.ok ? periodSources[key].rows : [];
}

/** Un même chemin ("/", "/blogs/news/...") existe sur plusieurs sites — préfixe par le host pour lever l'ambiguïté dans les tableaux. */
function pageLabel(hostName, path) {
  return `${hostName || "(host inconnu)"}${path || ""}`;
}

function flattenGsc(gscPeriod, reportKey) {
  const out = [];
  for (const [siteKey, result] of Object.entries(gscPeriod || {})) {
    if (!result.ok) continue;
    const rows = result.reports?.[reportKey] || [];
    for (const r of rows) out.push({ ...r, siteKey });
  }
  return out;
}

/** §14 — jamais de zéro implicite : un rapport GA4 `overview` en échec renvoie des totaux `null`, pas des 0. */
function aggregateOverview(periodSources) {
  const result = periodSources?.overview;
  if (!result?.ok) {
    return { ok: false, sessions: null, totalUsers: null, newUsers: null, engagedSessions: null, screenPageViews: null, totalRevenue: null, transactions: null };
  }
  const out = { ok: true, sessions: 0, totalUsers: 0, newUsers: 0, engagedSessions: 0, screenPageViews: 0, totalRevenue: 0, transactions: 0 };
  for (const r of result.rows) {
    out.sessions += Number(r.sessions) || 0;
    out.totalUsers += Number(r.totalUsers) || 0;
    out.newUsers += Number(r.newUsers) || 0;
    out.engagedSessions += Number(r.engagedSessions) || 0;
    out.screenPageViews += Number(r.screenPageViews) || 0;
    out.totalRevenue += Number(r.totalRevenue) || 0;
    out.transactions += Number(r.transactions) || 0;
  }
  return out;
}

function buildChannelsModel(current) {
  const lastRows = ga4Rows(current, "channelsLastTouch");
  const firstRows = ga4Rows(current, "channelsFirstTouch");
  const lastMap = aggregateBy(lastRows, "sessionDefaultChannelGroup", ["sessions", "totalRevenue", "transactions", "totalUsers"]);
  const firstMap = aggregateBy(firstRows, "firstUserDefaultChannelGroup", ["sessions", "totalRevenue", "totalUsers"]);

  const lastTouchByChannel = {};
  for (const [ch, v] of lastMap) lastTouchByChannel[ch] = { sessions: v.sessions, revenue: v.totalRevenue };
  const firstTouchByChannel = {};
  for (const [ch, v] of firstMap) firstTouchByChannel[ch] = { sessions: v.sessions, revenue: v.totalRevenue };
  const gap = attributionGap(lastTouchByChannel, firstTouchByChannel);

  const totalSessions = [...lastMap.values()].reduce((s, v) => s + v.sessions, 0);
  const channels = [...lastMap.entries()]
    .map(([channel, v]) => ({
      channel,
      sessions: v.sessions,
      sharePct: share(v.sessions, totalSessions),
      revenue: v.totalRevenue,
      transactions: v.transactions,
      revenuePerSession: revenuePerSession(v.totalRevenue, v.sessions),
      sessionsGap: gap[channel]?.sessionsGap ?? null,
      revenueGap: gap[channel]?.revenueGap ?? null,
    }))
    .sort((a, b) => b.sessions - a.sessions);

  return { channels, attributionGap: gap };
}

function buildShopifyNote(shopify) {
  if (shopify.ok) {
    const sites = shopify.bySite.filter((s) => s.ok).map((s) => s.siteKey);
    return `Commandes réelles Shopify disponibles pour ${sites.join(", ")} — voir le détail dans cette section.`;
  }
  if (shopify.scopeMissing) {
    return "Le chiffre d'affaires et les commandes ci-dessus proviennent de GA4 (pixel Shopify), pas des commandes réelles : le scope Shopify \"read_orders\" manque encore sur les boutiques (voir `npm run doctor` pour la marche à suivre).";
  }
  return "Données Shopify indisponibles ce mois — le chiffre d'affaires et les commandes affichés proviennent de GA4 (pixel Shopify).";
}

function buildEcommerceModel(current, shopifyCurrent) {
  const ecomRows = ga4Rows(current, "ecommerce");
  const agg = { itemsViewed: 0, addToCarts: 0, checkouts: 0, ecommercePurchases: 0, purchaseRevenue: 0 };
  for (const r of ecomRows) {
    agg.itemsViewed += Number(r.itemsViewed) || 0;
    agg.addToCarts += Number(r.addToCarts) || 0;
    agg.checkouts += Number(r.checkouts) || 0;
    agg.ecommercePurchases += Number(r.ecommercePurchases) || 0;
    agg.purchaseRevenue += Number(r.purchaseRevenue) || 0;
  }
  const funnelResult = computeFunnel(agg);
  const funnelStages = [
    { label: "Vue produit", value: agg.itemsViewed },
    { label: "Ajout au panier", value: agg.addToCarts },
    { label: "Paiement démarré", value: agg.checkouts },
    { label: "Achat", value: agg.ecommercePurchases },
  ];

  const productRows = ga4Rows(current, "products");
  const topProducts = [...productRows]
    .sort((a, b) => (Number(b.itemRevenue) || 0) - (Number(a.itemRevenue) || 0))
    .slice(0, 10)
    .map((r) => ({ name: r.itemName, revenue: Number(r.itemRevenue) || 0, itemsPurchased: Number(r.itemsPurchased) || 0 }));

  const landingRows = ga4Rows(current, "landingPages");
  const convertingPages = [...landingRows]
    .filter((r) => (Number(r.transactions) || 0) > 0)
    .sort((a, b) => (Number(b.totalRevenue) || 0) - (Number(a.totalRevenue) || 0))
    .slice(0, 10)
    .map((r) => ({ page: pageLabel(r.hostName, r.landingPage), sessions: Number(r.sessions) || 0, revenue: Number(r.totalRevenue) || 0, transactions: Number(r.transactions) || 0 }));

  const shopify = buildShopifySection(shopifyCurrent);

  return { agg, funnel: funnelResult, funnelStages, topProducts, convertingPages, shopify };
}

/**
 * Modèle Shopify du rapport (§4, « Commandes réelles ») : jamais de somme
 * entre devises différentes. `bySite` porte la devise réelle de chaque
 * boutique (autorité Shopify — voir sites.json) ; `subtotalsByCurrency`
 * regroupe uniquement les boutiques qui partagent la même devise (un
 * sous-total par devise, jamais un total unique mélangeant EUR et USD).
 * `topCountries`/`channels` agrègent un simple COMPTAGE de commandes tous
 * sites confondus — pas un montant — donc aucun risque de devise.
 *
 * Nouveau/récurrent/invité : les décomptes viennent de
 * `resolveCustomerSegments` (résolution réseau par client unique, voir
 * `shopify.js`) — jamais un zéro implicite si indisponible. Les parts de CA
 * (`*RevenueSharePct`) sont des % du CA BRUT de la boutique (`share()`,
 * unité-agnostique — donc comparables/affichables même si chaque boutique a
 * sa propre devise), calculées uniquement quand le montant correspondant est
 * connu.
 */
function buildShopifySection(shopifyCurrent) {
  const entries = Object.entries(shopifyCurrent || {});
  const okEntries = entries.filter(([, r]) => r.ok && r.data);
  const scopeMissing = entries.length > 0 && entries.every(([, r]) => !r.ok && r.reason === "scope read_orders manquant");

  const bySite = entries.map(([siteKey, r]) => {
    if (!r.ok || !r.data) {
      return {
        siteKey, ok: false, reason: r.reason, currency: null, orders: null, grossRevenue: null,
        discounts: null, refunds: null, netRevenue: null, aov: null,
        newCustomers: null, returningCustomers: null, newCustomersUnavailableReason: null,
        guestOrders: null, guestRevenue: null, guestRevenueSharePct: null,
        newCustomersRevenue: null, newCustomersRevenueSharePct: null,
        returningCustomersRevenue: null, returningCustomersRevenueSharePct: null,
        customerResolutionPartial: null, resolvedCustomerCount: null, totalUniqueCustomerCount: null,
      };
    }
    const d = r.data;
    return {
      siteKey, ok: true, reason: null, currency: d.currency, orders: d.orders,
      grossRevenue: d.grossRevenue, discounts: d.discounts, refunds: d.refunds,
      netRevenue: d.netRevenue, aov: d.aov,
      newCustomers: d.newCustomers, returningCustomers: d.returningCustomers,
      newCustomersUnavailableReason: d.newCustomersUnavailableReason,
      guestOrders: d.guestOrders ?? null,
      guestRevenue: d.guestRevenue ?? null,
      guestRevenueSharePct: share(d.guestRevenue, d.grossRevenue),
      newCustomersRevenue: d.newCustomersRevenue ?? null,
      newCustomersRevenueSharePct: share(d.newCustomersRevenue, d.grossRevenue),
      returningCustomersRevenue: d.returningCustomersRevenue ?? null,
      returningCustomersRevenueSharePct: share(d.returningCustomersRevenue, d.grossRevenue),
      customerResolutionPartial: d.partial ?? null,
      resolvedCustomerCount: d.resolvedCustomerCount ?? null,
      totalUniqueCustomerCount: d.totalUniqueCustomerCount ?? null,
    };
  });

  const currencyGroups = new Map();
  for (const s of bySite) {
    if (!s.ok || !s.currency) continue;
    if (!currencyGroups.has(s.currency)) currencyGroups.set(s.currency, { currency: s.currency, orders: 0, netRevenue: 0, grossRevenue: 0, siteKeys: [] });
    const g = currencyGroups.get(s.currency);
    g.orders += s.orders;
    g.netRevenue += s.netRevenue;
    g.grossRevenue += s.grossRevenue;
    g.siteKeys.push(s.siteKey);
  }
  const subtotalsByCurrency = [...currencyGroups.values()].map((g) => ({ ...g, aov: aov(g.netRevenue, g.orders) }));

  const countryTotals = {};
  const channelTotals = {};
  for (const [, r] of okEntries) {
    for (const [c, n] of Object.entries(r.data.byCountry || {})) countryTotals[c] = (countryTotals[c] || 0) + n;
    for (const [c, n] of Object.entries(r.data.byChannel || {})) channelTotals[c] = (channelTotals[c] || 0) + n;
  }
  const topCountries = Object.entries(countryTotals)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([country, orders]) => ({ country, orders }));
  const channels = Object.entries(channelTotals)
    .sort((a, b) => b[1] - a[1])
    .map(([channel, orders]) => ({ channel, label: channelLabel(channel), orders }));

  return { ok: okEntries.length > 0, scopeMissing, bySite, subtotalsByCurrency, topCountries, channels };
}

function aggregateSiteTotals(rows) {
  if (!rows.length) return { clicks: null, impressions: null, position: null, ctr: null };
  let clicks = 0;
  let impressions = 0;
  let weightedPosition = 0;
  for (const r of rows) {
    clicks += Number(r.clicks) || 0;
    impressions += Number(r.impressions) || 0;
    weightedPosition += (Number(r.position) || 0) * (Number(r.impressions) || 0);
  }
  return {
    clicks,
    impressions,
    position: impressions > 0 ? weightedPosition / impressions : null,
    ctr: impressions > 0 ? (clicks / impressions) * 100 : null,
  };
}

function buildSeoModel(gscCurrent, gscPrevious) {
  const totals = aggregateSiteTotals(flattenGsc(gscCurrent, "siteTotals"));
  const totalsPrevious = aggregateSiteTotals(flattenGsc(gscPrevious, "siteTotals"));

  const queriesCurrent = flattenGsc(gscCurrent, "queries");
  const queriesPrevious = flattenGsc(gscPrevious, "queries");
  const pageQueryCurrent = flattenGsc(gscCurrent, "pageQuery");

  const seoInsights = buildSeoInsights({ queriesCurrent, queriesPrevious, pageQueryCurrent });
  const unreachableSites = Object.entries(gscCurrent || {}).filter(([, r]) => !r.ok).map(([k]) => k);

  return {
    totals,
    totalsDeltas: {
      clicks: significantDelta(totals.clicks, totalsPrevious.clicks, totalsPrevious.clicks, "sessions"),
      impressions: significantDelta(totals.impressions, totalsPrevious.impressions, totalsPrevious.impressions, "sessions"),
    },
    brandSplit: seoInsights.brandSplit,
    positionBuckets: seoInsights.positionBuckets,
    opportunities: seoInsights.strikingDistance.opportunities,
    ctrUnderperforming: seoInsights.ctrUnderperforming,
    winnersLosers: seoInsights.winnersLosers,
    appearedDisappeared: seoInsights.appearedDisappeared,
    cannibalization: seoInsights.cannibalization,
    unreachableSites,
  };
}

function buildBlogModel(current) {
  const landingRows = ga4Rows(current, "landingPages");
  const blogRows = landingRows
    .map((r) => {
      const site = siteForHost(r.hostName);
      return { ...r, site, isBlog: classifyUrl(r.landingPage, site) === "blog" };
    })
    .filter((r) => r.isBlog);

  const totalSessions = sumField(blogRows, "sessions");
  const totalRevenue = sumField(blogRows, "totalRevenue");

  // GA4 renvoie engagementRate en fraction (0..1) — converti en % pour l'affichage.
  const pages = blogRows.map((r) => ({
    page: pageLabel(r.hostName, r.landingPage),
    siteKey: r.site?.key || r.hostName,
    sessions: Number(r.sessions) || 0,
    revenue: Number(r.totalRevenue) || 0,
    engagementRate: r.engagementRate != null ? Number(r.engagementRate) * 100 : null,
  }));

  const topArticles = [...pages].sort((a, b) => b.sessions - a.sessions).slice(0, 10);

  const medianEngagement = median(pages.filter((p) => p.engagementRate != null).map((p) => p.engagementRate));
  const medianSessions = median(pages.map((p) => p.sessions));
  const toRework = pages
    .filter((p) => p.sessions >= Math.max(medianSessions || 0, 1) && p.engagementRate != null && medianEngagement != null && p.engagementRate < medianEngagement)
    .sort((a, b) => b.sessions - a.sessions)
    .slice(0, 10);

  return { totalSessions, totalRevenue, topArticles, toRework };
}

function buildAiVisibilityModel(current) {
  const rows = ga4Rows(current, "llm");
  const totalSessions = sumField(rows, "sessions");
  const totalRevenue = sumField(rows, "totalRevenue");
  const bySourceMap = aggregateBy(rows, "sessionSource", ["sessions", "totalRevenue"]);
  const bySource = [...bySourceMap.entries()]
    .map(([source, v]) => ({ source, sessions: v.sessions, revenue: v.totalRevenue }))
    .sort((a, b) => b.sessions - a.sessions);
  const topPages = [...rows]
    .sort((a, b) => (Number(b.sessions) || 0) - (Number(a.sessions) || 0))
    .slice(0, 10)
    .map((r) => ({ page: pageLabel(r.hostName, r.landingPage), source: r.sessionSource, sessions: Number(r.sessions) || 0 }));
  return { totalSessions, totalRevenue, bySource, topPages };
}

function buildDailySessionsSeries(current, bounds) {
  const rows = ga4Rows(current, "daily");
  const byDate = new Map();
  for (const r of rows) byDate.set(r.date, (byDate.get(r.date) || 0) + (Number(r.sessions) || 0));

  const series = [];
  const start = new Date(`${bounds.start}T00:00:00.000Z`);
  const end = new Date(`${bounds.end}T00:00:00.000Z`);
  for (let d = new Date(start); d.getTime() <= end.getTime(); d.setUTCDate(d.getUTCDate() + 1)) {
    const key = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
    series.push(byDate.has(key) ? byDate.get(key) : null);
  }
  return series;
}

function overallQualityLevel(checks) {
  if (checks.some((c) => c.level === "critical")) return "critical";
  if (checks.some((c) => c.level === "warn")) return "warn";
  return "ok";
}

function buildTiles(overviewCurrent, overviewPrevious, overviewYearAgo) {
  const conversionRateCurrent = conversionRate(overviewCurrent.transactions, overviewCurrent.sessions);
  const conversionRatePrevious = conversionRate(overviewPrevious.transactions, overviewPrevious.sessions);
  const conversionRateYearAgo = conversionRate(overviewYearAgo.transactions, overviewYearAgo.sessions);

  const aovCurrent = aov(overviewCurrent.totalRevenue, overviewCurrent.transactions);
  const aovPrevious = aov(overviewPrevious.totalRevenue, overviewPrevious.transactions);
  const aovYearAgo = aov(overviewYearAgo.totalRevenue, overviewYearAgo.transactions);

  function tile(key, label, current, previous, yearAgo, opts) {
    const { baseUnit, basePrevious, baseYearAgo, kind, valueLabel, direction = "up", green = 0, warn = -10 } = opts;
    return {
      key,
      label,
      value: current,
      valueLabel,
      direction,
      green,
      warn,
      baseUnit,
      mom: significantDelta(current, previous, basePrevious, kind),
      yoy: significantDelta(current, yearAgo, baseYearAgo, kind),
    };
  }

  return [
    tile("totalUsers", "Visiteurs", overviewCurrent.totalUsers, overviewPrevious.totalUsers, overviewYearAgo.totalUsers, {
      baseUnit: "sessions",
      basePrevious: overviewPrevious.sessions,
      baseYearAgo: overviewYearAgo.sessions,
      kind: "sessions",
      valueLabel: formatChartNumber(overviewCurrent.totalUsers),
    }),
    tile("sessions", "Sessions", overviewCurrent.sessions, overviewPrevious.sessions, overviewYearAgo.sessions, {
      baseUnit: "sessions",
      basePrevious: overviewPrevious.sessions,
      baseYearAgo: overviewYearAgo.sessions,
      kind: "sessions",
      valueLabel: formatChartNumber(overviewCurrent.sessions),
    }),
    tile("totalRevenue", "Chiffre d'affaires", overviewCurrent.totalRevenue, overviewPrevious.totalRevenue, overviewYearAgo.totalRevenue, {
      baseUnit: "transactions",
      basePrevious: overviewPrevious.transactions,
      baseYearAgo: overviewYearAgo.transactions,
      kind: "transactions",
      valueLabel: overviewCurrent.totalRevenue != null ? `${formatChartNumber(overviewCurrent.totalRevenue)} €` : "n/d",
    }),
    tile("transactions", "Commandes", overviewCurrent.transactions, overviewPrevious.transactions, overviewYearAgo.transactions, {
      baseUnit: "transactions",
      basePrevious: overviewPrevious.transactions,
      baseYearAgo: overviewYearAgo.transactions,
      kind: "transactions",
      valueLabel: formatChartNumber(overviewCurrent.transactions),
    }),
    tile("aov", "Panier moyen", aovCurrent, aovPrevious, aovYearAgo, {
      baseUnit: "transactions",
      basePrevious: overviewPrevious.transactions,
      baseYearAgo: overviewYearAgo.transactions,
      kind: "transactions",
      valueLabel: aovCurrent != null ? `${fmtPrecise(aovCurrent)} €` : "n/d",
      green: 0,
      warn: -5,
    }),
    tile("conversionRate", "Taux de conversion", conversionRateCurrent, conversionRatePrevious, conversionRateYearAgo, {
      baseUnit: "sessions",
      basePrevious: overviewPrevious.sessions,
      baseYearAgo: overviewYearAgo.sessions,
      kind: "sessions",
      valueLabel: conversionRateCurrent != null ? `${fmtPrecise(conversionRateCurrent)} %` : "n/d",
    }),
  ];
}

function buildAgentDatasets(model) {
  return {
    acquisition: {
      channels: model.acquisition.channels,
      sourceMedium: model.acquisition.sourceMedium,
      campaigns: model.acquisition.campaigns,
      geo: model.acquisition.geo,
      devices: model.acquisition.devices,
      attributionGap: model.acquisition.attributionGapRaw,
    },
    seo: model.seo,
    content: {
      totalSessions: model.blog.totalSessions,
      totalRevenue: model.blog.totalRevenue,
      topArticles: model.blog.topArticles,
      toRework: model.blog.toRework,
    },
    ecommerce: {
      funnel: model.ecommerce.funnel,
      funnelStages: model.ecommerce.funnelStages,
      topProducts: model.ecommerce.topProducts,
      convertingPages: model.ecommerce.convertingPages,
      shopify: model.ecommerce.shopify,
      aov: model.tiles.find((t) => t.key === "aov"),
      conversionRate: model.tiles.find((t) => t.key === "conversionRate"),
    },
    aiVisibility: model.aiVisibility,
    dataQuality: { checks: model.quality.checks },
    kpis: model.tiles.map((t) => ({ key: t.key, label: t.label, value: t.value, mom: t.mom, yoy: t.yoy })),
  };
}

/**
 * Construit le modèle de rapport (KPI §9, canaux, e-commerce, SEO, blog,
 * visibilité IA, qualité §10) à partir d'un snapshot déjà collecté (§13).
 * Fonction pure, testable sans réseau — `model.agents` reste `null` tant que
 * `attachAgents` n'a pas été appelé.
 */
export function buildModel(snapshot) {
  const { month, months, bounds } = snapshot;
  const ga4 = snapshot.sources.ga4;
  const gsc = snapshot.sources.gsc;
  const shopify = snapshot.sources.shopify;

  const overviewCurrent = aggregateOverview(ga4.current);
  const overviewPrevious = aggregateOverview(ga4.previous);
  const overviewYearAgo = aggregateOverview(ga4.yearAgo);

  const channelsModel = buildChannelsModel(ga4.current);
  const acquisition = {
    channels: channelsModel.channels,
    attributionGapRaw: channelsModel.attributionGap,
    sourceMedium: topAggregated(ga4Rows(ga4.current, "sourceMedium"), "sessionSourceMedium", "sessions"),
    campaigns: topAggregated(ga4Rows(ga4.current, "campaigns"), "sessionCampaignName", "sessions"),
    geo: topAggregated(ga4Rows(ga4.current, "geo"), "country", "sessions"),
    devices: topAggregated(ga4Rows(ga4.current, "devices"), "deviceCategory", "sessions"),
  };

  const ecommerce = buildEcommerceModel(ga4.current, shopify.current);
  const seo = buildSeoModel(gsc.current, gsc.previous);
  const blog = buildBlogModel(ga4.current);
  const aiVisibility = buildAiVisibilityModel(ga4.current);
  const tiles = buildTiles(overviewCurrent, overviewPrevious, overviewYearAgo);
  const qualityChecks = runQualityChecks(snapshot);

  return {
    month,
    monthLabel: monthLabel(month),
    generatedAt: new Date().toISOString(),
    bounds,
    months,
    dataReady: isDataReady(month),
    tiles,
    quality: { checks: qualityChecks, overallLevel: overallQualityLevel(qualityChecks) },
    acquisition,
    ecommerce,
    seo,
    blog,
    aiVisibility,
    significance: significanceThresholds(),
    shopifyNote: buildShopifyNote(ecommerce.shopify),
    dailySessionsSeries: buildDailySessionsSeries(ga4.current, bounds),
    agents: null,
    unverifiedFigures: [],
  };
}

/**
 * Exécute les 7 agents (§11) et les attache au modèle — ou les remplace par un
 * résultat « désactivé » si `--no-ai`.
 *
 * Le schéma JSON de l'agent exécutif ne peut pas imposer un nombre exact
 * d'actions (les contraintes de longueur de tableau ne sont pas fiabilisées
 * par la validation de sortie structurée de l'API) : le modèle peut renvoyer
 * plus de 3 actions malgré la consigne. On l'applique donc ici, une seule
 * fois, pour que markdown/HTML/Slack partagent la même liste tronquée.
 */
export async function attachAgents(model, { noAi = false } = {}) {
  let results;
  if (noAi) {
    results = Object.fromEntries(AGENT_KEYS.map((k) => [k, skippedAgentResult(k)]));
  } else {
    results = await runAnalysisAgents(buildAgentDatasets(model));
  }
  const executive = results.executive;
  if (executive?.ok && Array.isArray(executive.data?.actions) && executive.data.actions.length > 3) {
    logger.warn(`Agent "executive": ${executive.data.actions.length} actions reçues, tronqué aux 3 plus prioritaires (§11).`);
    executive.data.actions = [...executive.data.actions].sort((a, b) => a.priority - b.priority).slice(0, 3);
  }
  model.agents = results;
  model.unverifiedFigures = AGENT_KEYS.map((k) => ({ agent: k, figures: results[k].unverifiedFigures || [] })).filter((u) => u.figures.length > 0);
  return model;
}

/**
 * `report` (§4) : charge le snapshot du mois (le collecte s'il manque),
 * construit le rapport, écrit MD + HTML + JSON, envoie Slack. `--no-ai` et
 * `--no-slack` sont pleinement fonctionnels (aucun appel réseau correspondant
 * n'est fait quand ils sont actifs).
 *
 * `--no-repair` désactive la passe de réparation (§13) : par défaut, un
 * snapshot déjà existant contenant des sources en échec périmées (ex. scope
 * Shopify ajouté après coup) est réparé — uniquement les entrées en échec,
 * jamais les données déjà réussies — avant de construire le modèle, pour que
 * `scopeMissing` et la section CA réel reflètent l'état actuel des données.
 */
export async function runReport({ month, noAi = false, noSlack = false, noCache = false, force = false, noRepair = false } = {}) {
  const targetMonth = month || latestClosedMonth();

  let snapshot = readSnapshot(targetMonth);
  if (!snapshot) {
    logger.info(`Snapshot absent pour ${targetMonth} — collecte...`);
    snapshot = await collectSnapshot(targetMonth, { noCache });
    writeSnapshot(snapshot, { force });
  } else if (!noRepair) {
    const repair = await repairSnapshot(snapshot, { noCache });
    snapshot = repair.snapshot;
    if (repair.changed) {
      // Réécriture délibérée d'un snapshot par ailleurs immuable (§13) : seules
      // les entrées passées de ok:false à ok:true sont modifiées ci-dessus,
      // jamais une donnée déjà réussie — `force` ici n'est pas le flag CLI
      // utilisateur, c'est l'autorisation explicite de cette passe de réparation.
      writeSnapshot(snapshot, { force: true });
    }
  }

  logger.info(`Construction du rapport pour ${targetMonth}...`);
  const model = buildModel(snapshot);
  await attachAgents(model, { noAi });

  const reportDir = path.join(paths.reports, targetMonth);
  fs.mkdirSync(reportDir, { recursive: true });

  const mdPath = path.join(reportDir, "RAPPORT.md");
  const htmlPath = path.join(reportDir, "rapport.html");
  const dataPath = path.join(reportDir, "data.json");

  fs.writeFileSync(mdPath, renderMarkdown(model));
  fs.writeFileSync(htmlPath, renderHtml(model));
  // `model` porte déjà month/generatedAt/bounds/months (voir buildModel) — on
  // ne les duplique pas ici. `snapshot.sources` (lignes GA4/GSC/Shopify
  // brutes, ~20 Mo) reste dans data/monthly/YYYY-MM.json uniquement ; seule
  // `snapshot.collection` (trace de qualité de la collecte) est conservée.
  fs.writeFileSync(dataPath, JSON.stringify({ collection: snapshot.collection, model }, null, 2));

  logger.info(`Rapport écrit : ${mdPath} / ${htmlPath} / ${dataPath}`);

  if (noSlack) {
    logger.info("Envoi Slack désactivé (--no-slack).");
  } else {
    try {
      await sendReport(model, { htmlPath });
    } catch (err) {
      logger.error(`Échec de l'envoi Slack: ${err.message}`);
      await sendFailureAlert("report", err);
    }
  }

  return { month: targetMonth, mdPath, htmlPath, dataPath, model };
}
