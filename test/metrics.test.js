import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  delta, mom, yoy, share, revenuePerSession, conversionRate, aov, ctr, engagementRate,
  funnel, significanceGuard, significantDelta, attributionGap,
} from "../src/lib/metrics.js";

describe("metrics — delta", () => {
  test("hausse", () => {
    const d = delta(150, 100);
    assert.deepEqual(d, { abs: 50, pct: 50, direction: "up" });
  });

  test("baisse", () => {
    const d = delta(80, 100);
    assert.deepEqual(d, { abs: -20, pct: -20, direction: "down" });
  });

  test("stable", () => {
    const d = delta(100, 100);
    assert.deepEqual(d, { abs: 0, pct: 0, direction: "flat" });
  });

  test("division par zéro : previous=0 -> abs défini, pct null (jamais Infinity)", () => {
    const d = delta(10, 0);
    assert.equal(d.abs, 10);
    assert.equal(d.pct, null);
    assert.equal(d.direction, "up");
  });

  test("valeur manquante -> tout null, jamais un 0 implicite", () => {
    assert.deepEqual(delta(null, 100), { abs: null, pct: null, direction: null });
    assert.deepEqual(delta(100, undefined), { abs: null, pct: null, direction: null });
  });
});

describe("metrics — mom / yoy", () => {
  test("mom compare au mois précédent (M-1)", () => {
    const series = { "2026-05": 100, "2026-06": 120 };
    assert.equal(mom(series, "2026-06").abs, 20);
  });

  test("yoy compare à M-12", () => {
    const series = { "2025-06": 100, "2026-06": 130 };
    assert.equal(yoy(series, "2026-06").abs, 30);
  });

  test("mois de comparaison absent -> null (pas de crash)", () => {
    assert.deepEqual(mom({ "2026-06": 120 }, "2026-06"), { abs: null, pct: null, direction: null });
    assert.deepEqual(yoy({}, "2026-06"), { abs: null, pct: null, direction: null });
  });
});

describe("metrics — ratios (division par zéro protégée)", () => {
  test("share", () => {
    assert.equal(share(25, 100), 25);
    assert.equal(share(25, 0), null);
    assert.equal(share(null, 100), null);
  });

  test("revenuePerSession", () => {
    assert.equal(revenuePerSession(1000, 200), 5);
    assert.equal(revenuePerSession(1000, 0), null);
  });

  test("conversionRate", () => {
    assert.equal(conversionRate(5, 100), 5);
    assert.equal(conversionRate(5, 0), null);
  });

  test("aov", () => {
    assert.equal(aov(500, 10), 50);
    assert.equal(aov(500, 0), null);
  });

  test("ctr", () => {
    assert.equal(ctr(10, 200), 5);
    assert.equal(ctr(10, 0), null);
  });

  test("engagementRate", () => {
    assert.equal(engagementRate(60, 100), 60);
    assert.equal(engagementRate(60, 0), null);
  });
});

describe("metrics — funnel", () => {
  test("taux de passage vue -> panier -> checkout -> achat", () => {
    const f = funnel({ itemsViewed: 1000, addToCarts: 200, checkouts: 100, ecommercePurchases: 40 });
    assert.equal(f.viewToCart, 20);
    assert.equal(f.cartToCheckout, 50);
    assert.equal(f.checkoutToPurchase, 40);
    assert.equal(f.viewToPurchase, 4);
  });

  test("étape à 0 -> null, pas de division par zéro", () => {
    const f = funnel({ itemsViewed: 0, addToCarts: 0, checkouts: 0, ecommercePurchases: 0 });
    assert.equal(f.viewToCart, null);
    assert.equal(f.cartToCheckout, null);
  });
});

describe("metrics — garde-fou de significativité", () => {
  test("base sous le seuil -> insufficient=true", () => {
    const g = significanceGuard(4, "sessions", { minSessions: 100 });
    assert.deepEqual(g, { insufficient: true, base: 4 });
  });

  test("base au-dessus du seuil -> insufficient=false", () => {
    const g = significanceGuard(150, "sessions", { minSessions: 100 });
    assert.equal(g.insufficient, false);
  });

  test("seuil distinct pour les transactions", () => {
    assert.equal(significanceGuard(3, "transactions", { minTransactions: 5 }).insufficient, true);
    assert.equal(significanceGuard(10, "transactions", { minTransactions: 5 }).insufficient, false);
  });

  test("significantDelta n'affiche pas de % sous le seuil (empêche un +300% sur 4 sessions)", () => {
    const d = significantDelta(4, 1, 4, "sessions", { minSessions: 100 });
    assert.deepEqual(d, { insufficient: true, base: 4 });
    assert.equal("pct" in d, false);
  });

  test("significantDelta calcule normalement au-dessus du seuil", () => {
    const d = significantDelta(150, 100, 100, "sessions", { minSessions: 100 });
    assert.equal(d.insufficient, false);
    assert.equal(d.pct, 50);
  });
});

describe("metrics — attributionGap", () => {
  test("écart par canal (le blog : fort en first-touch, faible en last-touch)", () => {
    const lastTouch = { blog: { sessions: 100, revenue: 500 }, ads: { sessions: 300, revenue: 3000 } };
    const firstTouch = { blog: { sessions: 400, revenue: 500 }, ads: { sessions: 200, revenue: 3000 } };
    const gap = attributionGap(lastTouch, firstTouch);
    assert.equal(gap.blog.sessionsGap, 300);
    assert.equal(gap.blog.revenueGap, 0);
    assert.equal(gap.ads.sessionsGap, -100);
  });

  test("canal absent d'un des deux jeux -> null, pas de crash", () => {
    const gap = attributionGap({ blog: { sessions: 10, revenue: 5 } }, {});
    assert.equal(gap.blog.firstTouch.sessions, null);
    assert.equal(gap.blog.sessionsGap, null);
  });
});
