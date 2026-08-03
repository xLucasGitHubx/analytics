import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  isBranded, splitBranded, positionBuckets, strikingDistance, ctrUnderperforming,
  winnersLosers, appearedDisappeared, cannibalization,
} from "../src/lib/insights.js";
import { loadFixture } from "./helpers.js";

describe("insights — branded / non-branded", () => {
  test("détecte les variantes de marque (brand-terms.json)", () => {
    assert.equal(isBranded("lovebox avis"), true);
    assert.equal(isBranded("love box prix"), true);
    assert.equal(isBranded("Love-Box cadeau"), true);
    assert.equal(isBranded("boite a message longue distance"), false);
  });

  test("splitBranded agrège séparément (fixture GSC queries)", () => {
    const rows = loadFixture("gsc-queries-current.json");
    const { branded, nonBranded } = splitBranded(rows);
    // Seule "lovebox avis" est branded dans la fixture.
    assert.equal(branded.queries, 1);
    assert.equal(branded.clicks, 40);
    assert.equal(nonBranded.queries, 3);
  });
});

describe("insights — buckets de position", () => {
  test("répartit clics/impressions par bucket (1-3 / 4-10 / 11-20 / 21+)", () => {
    const rows = [
      { position: 2, clicks: 10, impressions: 100 },
      { position: 7, clicks: 5, impressions: 200 },
      { position: 25, clicks: 1, impressions: 300 },
    ];
    const buckets = positionBuckets(rows);
    assert.equal(buckets.find((b) => b.key === "1-3").clicks, 10);
    assert.equal(buckets.find((b) => b.key === "4-10").clicks, 5);
    assert.equal(buckets.find((b) => b.key === "21+").clicks, 1);
    assert.equal(buckets.find((b) => b.key === "11-20").clicks, 0);
  });
});

describe("insights — striking distance", () => {
  test("sélectionne les requêtes en position 4-15 avec assez d'impressions", () => {
    const rows = [
      { query: "reference-pos3", position: 3, clicks: 30, impressions: 1000 }, // sert de référence CTR pos.3 (3%)
      { query: "opportunite", position: 8, clicks: 1, impressions: 500 }, // CTR très faible pour sa position -> opportunité
      { query: "hors-plage-position", position: 20, clicks: 5, impressions: 1000 }, // position hors 4-15
      { query: "hors-seuil-impressions", position: 6, clicks: 2, impressions: 50 }, // sous le seuil d'impressions
    ];
    const { opportunities, expectedCtrAtPosition3 } = strikingDistance(rows, { minPosition: 4, maxPosition: 15, minImpressions: 100, topN: 20 });
    assert.equal(expectedCtrAtPosition3, 0.03);
    const queries = opportunities.map((o) => o.query);
    assert.ok(queries.includes("opportunite"));
    assert.ok(!queries.includes("hors-plage-position"));
    assert.ok(!queries.includes("hors-seuil-impressions"));
  });
});

describe("insights — CTR sous-performant", () => {
  test("détecte un CTR très inférieur à la médiane de sa position", () => {
    const rows = [
      { query: "ref1", position: 5, clicks: 50, impressions: 500 }, // CTR 10%
      { query: "ref2", position: 5, clicks: 45, impressions: 500 }, // CTR 9%
      { query: "faible", position: 5, clicks: 5, impressions: 500 }, // CTR 1% -> bien sous la médiane (9%)
    ];
    const under = ctrUnderperforming(rows, { ratioOfMedian: 0.5 });
    const queries = under.map((r) => r.query);
    assert.ok(queries.includes("faible"));
    assert.ok(!queries.includes("ref1"));
  });
});

describe("insights — gagnants / perdants MoM (fixtures current/previous)", () => {
  test("classe par delta de clics", () => {
    const current = loadFixture("gsc-queries-current.json");
    const previous = loadFixture("gsc-queries-previous.json");
    const { winners, losers } = winnersLosers(current, previous, { key: "query", minClickDelta: 3 });
    assert.ok(winners.some((w) => w.query === "lovebox avis")); // 40 vs 35 (+5)
    assert.ok(losers.some((l) => l.query === "cadeau longue distance")); // 12 vs 30 (-18)
  });
});

describe("insights — requêtes apparues / disparues (fixtures current/previous)", () => {
  test("détecte les nouvelles et les disparues", () => {
    const current = loadFixture("gsc-queries-current.json");
    const previous = loadFixture("gsc-queries-previous.json");
    const { appeared, disappeared } = appearedDisappeared(current, previous, "query");
    assert.ok(appeared.some((r) => r.query === "boite a message connectee"));
    assert.ok(appeared.some((r) => r.query === "nouvelle requete printemps"));
    assert.ok(disappeared.some((r) => r.query === "requete disparue hiver"));
  });
});

describe("insights — cannibalisation (fixture pageQuery)", () => {
  test("détecte une requête servie par ≥ 2 pages significatives", () => {
    const rows = loadFixture("gsc-page-query.json");
    const conflicts = cannibalization(rows, { minPagesPerQuery: 2, minImpressionsPerPage: 50 });
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].query, "cadeau longue distance");
    assert.equal(conflicts[0].pages.length, 2);
  });

  test("une requête servie par une seule page n'est pas une cannibalisation", () => {
    const rows = loadFixture("gsc-page-query.json");
    const conflicts = cannibalization(rows, { minPagesPerQuery: 2, minImpressionsPerPage: 50 });
    assert.ok(!conflicts.some((c) => c.query === "boite a message connectee"));
  });
});
