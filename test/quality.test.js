import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  checkUnknownHosts, checkTrackingNoise, checkMissingRevenue, checkGa4ShopifyDiscrepancy,
  checkDataGaps, checkCardinality, checkGscCoverage, checkUnassignedTraffic, checkUnavailableMetrics,
} from "../src/lib/quality.js";
import { detectUnknownHosts } from "../src/lib/normalize.js";
import { loadFixture } from "./helpers.js";

describe("quality — #1 hosts inconnus", () => {
  test("ok si aucun host inconnu", () => {
    const r = checkUnknownHosts({ hosts: [], totalUnknown: 0, totalMetric: 1000, sharePct: 0 });
    assert.equal(r.level, "ok");
  });

  test("warn sous le seuil critique", () => {
    const r = checkUnknownHosts({ hosts: [{ host: "x", sessions: 20 }], totalUnknown: 20, totalMetric: 1000, sharePct: 2 }, { criticalPct: 5 });
    assert.equal(r.level, "warn");
  });

  test("critical au-dessus du seuil (intégration avec normalize.detectUnknownHosts sur fixture)", () => {
    const rows = loadFixture("ga4-overview.json");
    const unknownHosts = detectUnknownHosts(rows);
    const r = checkUnknownHosts(unknownHosts, { criticalPct: 2 }); // seuil bas pour forcer le critical sur la fixture
    assert.equal(r.level, "critical");
  });
});

describe("quality — #2 bruit de tracking", () => {
  test("ok sous le seuil", () => {
    const rows = [{ landingPage: "/", sessions: 950 }, { landingPage: "/web-pixels@1/", sessions: 10 }];
    assert.equal(checkTrackingNoise(rows, { warnPct: 5, criticalPct: 15 }).level, "ok");
  });

  test("warn entre les deux seuils", () => {
    const rows = [{ landingPage: "/", sessions: 920 }, { landingPage: "/web-pixels@1/", sessions: 80 }];
    assert.equal(checkTrackingNoise(rows, { warnPct: 5, criticalPct: 15 }).level, "warn");
  });

  test("critical au-dessus du seuil critique", () => {
    const rows = [{ landingPage: "/", sessions: 800 }, { landingPage: "/web-pixels@1/", sessions: 200 }];
    assert.equal(checkTrackingNoise(rows, { warnPct: 5, criticalPct: 15 }).level, "critical");
  });
});

describe("quality — #3 revenu manquant", () => {
  test("critical si sessions >= seuil et revenu nul", () => {
    const rows = [{ hostName: "buy.lovebox.love", sessions: 200, totalRevenue: 0 }];
    assert.equal(checkMissingRevenue(rows, { minSessions: 50 }).level, "critical");
  });

  test("ok sous le seuil de sessions", () => {
    const rows = [{ hostName: "buy.lovebox.love", sessions: 10, totalRevenue: 0 }];
    assert.equal(checkMissingRevenue(rows, { minSessions: 50 }).level, "ok");
  });

  test("ok si du revenu existe (fixture GA4 overview, EN/FR/CA — hors sites à 0 revenu)", () => {
    const rows = loadFixture("ga4-overview.json");
    const withRevenue = rows.filter((r) => ["en.lovebox.love", "fr.lovebox.love", "ca.lovebox.love"].includes(r.hostName));
    const result = checkMissingRevenue(withRevenue, { minSessions: 50 });
    assert.equal(result.level, "ok");
  });
});

describe("quality — #4 écart GA4 <-> Shopify", () => {
  test("warn si écart > seuil", () => {
    const r = checkGa4ShopifyDiscrepancy({ EN: 1000 }, { EN: { ok: true, data: { netRevenue: 800 } } }, { warnPct: 10 });
    assert.equal(r.level, "warn");
  });

  test("ok si écart sous le seuil", () => {
    const r = checkGa4ShopifyDiscrepancy({ EN: 1000 }, { EN: { ok: true, data: { netRevenue: 950 } } }, { warnPct: 10 });
    assert.equal(r.level, "ok");
  });

  test("ok (pas de comparaison possible) si Shopify indisponible — jamais un échec global", () => {
    const r = checkGa4ShopifyDiscrepancy({ EN: 1000 }, { EN: { ok: false, reason: "scope read_orders manquant" } });
    assert.equal(r.level, "ok");
  });

  test("devises différentes (Shopify vs GA4 supposé) -> comparaison neutralisée, jamais une somme/écart silencieux entre devises", () => {
    const r = checkGa4ShopifyDiscrepancy(
      { EN: 1000 },
      { EN: { ok: true, data: { netRevenue: 800, currency: "USD" } } },
      { warnPct: 10, ga4Currency: "EUR" }
    );
    assert.equal(r.level, "ok");
    assert.match(r.detail, /devises différentes/);
    assert.match(r.detail, /USD/);
  });

  test("même devise déclarée -> comparaison normale (pas neutralisée)", () => {
    const r = checkGa4ShopifyDiscrepancy(
      { EN: 1000 },
      { EN: { ok: true, data: { netRevenue: 800, currency: "EUR" } } },
      { warnPct: 10, ga4Currency: "EUR" }
    );
    assert.equal(r.level, "warn");
    assert.doesNotMatch(r.detail, /devises différentes/);
  });
});

describe("quality — #5 trous de données", () => {
  test("ok si tous les jours ont des sessions", () => {
    const bounds = { start: "2026-06-01", end: "2026-06-03" };
    const rows = [{ date: "20260601", sessions: 10 }, { date: "20260602", sessions: 5 }, { date: "20260603", sessions: 8 }];
    assert.equal(checkDataGaps(rows, bounds, { criticalDays: 3 }).level, "ok");
  });

  test("warn si un jour manque (sous le seuil critique)", () => {
    const bounds = { start: "2026-06-01", end: "2026-06-03" };
    const rows = [{ date: "20260601", sessions: 10 }, { date: "20260603", sessions: 8 }];
    assert.equal(checkDataGaps(rows, bounds, { criticalDays: 3 }).level, "warn");
  });

  test("critical si trop de jours manquent", () => {
    const bounds = { start: "2026-06-01", end: "2026-06-05" };
    const rows = [{ date: "20260601", sessions: 10 }];
    assert.equal(checkDataGaps(rows, bounds, { criticalDays: 3 }).level, "critical");
  });
});

describe("quality — #6 cardinalité", () => {
  test("ok sous le seuil", () => {
    const dims = [{ name: "channel", dimensionField: "channel", rows: [{ channel: "Organic Search", sessions: 950 }, { channel: "(not set)", sessions: 10 }] }];
    assert.equal(checkCardinality(dims, { warnPct: 5 }).level, "ok");
  });

  test("warn au-dessus du seuil", () => {
    const dims = [{ name: "channel", dimensionField: "channel", rows: [{ channel: "Organic Search", sessions: 900 }, { channel: "(not set)", sessions: 100 }] }];
    assert.equal(checkCardinality(dims, { warnPct: 5 }).level, "warn");
  });
});

describe("quality — #7 couverture Search Console", () => {
  test("ok si tous les sites répondent", () => {
    assert.equal(checkGscCoverage({ EN: { ok: true }, FR: { ok: true } }).level, "ok");
  });

  test("warn si un site sur plusieurs est injoignable (ex. site découvert sans propriété GSC)", () => {
    assert.equal(checkGscCoverage({ EN: { ok: true }, CA: { ok: false, error: "404" } }).level, "warn");
  });

  test("critical si tous les sites sont injoignables", () => {
    assert.equal(checkGscCoverage({ CA: { ok: false, error: "404" } }).level, "critical");
  });
});

describe("quality — #8 trafic non attribué", () => {
  test("ok sous le seuil", () => {
    const rows = [{ sessionDefaultChannelGroup: "Organic Search", sessions: 950 }, { sessionDefaultChannelGroup: "Unassigned", sessions: 10 }];
    assert.equal(checkUnassignedTraffic(rows, { warnPct: 10, criticalPct: 25 }).level, "ok");
  });

  test("critical au-dessus du seuil critique", () => {
    const rows = [{ sessionDefaultChannelGroup: "Organic Search", sessions: 700 }, { sessionDefaultChannelGroup: "Unassigned", sessions: 300 }];
    assert.equal(checkUnassignedTraffic(rows, { warnPct: 10, criticalPct: 25 }).level, "critical");
  });
});

describe("quality — #9 métriques GA4 indisponibles", () => {
  test("ok si aucun champ retiré et aucun rapport en échec", () => {
    assert.equal(checkUnavailableMetrics({ overview: { ok: true, droppedFields: [] } }).level, "ok");
  });

  test("warn si un champ a été retiré par la sonde", () => {
    assert.equal(checkUnavailableMetrics({ overview: { ok: true, droppedFields: ["sessionKeyEventRate"] } }).level, "warn");
  });

  test("warn si un rapport est entièrement en échec", () => {
    assert.equal(checkUnavailableMetrics({ ecommerce: { ok: false, droppedFields: [], error: "boom" } }).level, "warn");
  });
});
