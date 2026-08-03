import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { monthBounds, previousMonth, sameMonthLastYear, latestClosedMonth, isDataReady } from "../src/lib/period.js";

describe("period — monthBounds", () => {
  test("mois de 31 jours", () => {
    assert.deepEqual(monthBounds("2026-01"), { start: "2026-01-01", end: "2026-01-31" });
  });

  test("mois de 30 jours", () => {
    assert.deepEqual(monthBounds("2026-06"), { start: "2026-06-01", end: "2026-06-30" });
  });

  test("février, année bissextile (2024)", () => {
    assert.deepEqual(monthBounds("2024-02"), { start: "2024-02-01", end: "2024-02-29" });
  });

  test("février, année non bissextile (2023)", () => {
    assert.deepEqual(monthBounds("2023-02"), { start: "2023-02-01", end: "2023-02-28" });
  });

  test("mois invalide -> erreur explicite", () => {
    assert.throws(() => monthBounds("2026-6"));
    assert.throws(() => monthBounds("juin-2026"));
  });
});

describe("period — previousMonth / sameMonthLastYear", () => {
  test("previousMonth cas simple", () => {
    assert.equal(previousMonth("2026-06"), "2026-05");
  });

  test("previousMonth franchit une année", () => {
    assert.equal(previousMonth("2026-01"), "2025-12");
  });

  test("sameMonthLastYear (M-12)", () => {
    assert.equal(sameMonthLastYear("2026-06"), "2025-06");
    assert.equal(sameMonthLastYear("2026-01"), "2025-01");
  });
});

describe("period — latestClosedMonth", () => {
  test("le mois en cours n'est jamais considéré clos", () => {
    assert.equal(latestClosedMonth(new Date("2026-07-30T12:00:00Z")), "2026-06");
    assert.equal(latestClosedMonth(new Date("2026-07-01T00:00:00Z")), "2026-06");
  });

  test("franchissement d'année", () => {
    assert.equal(latestClosedMonth(new Date("2026-01-15T00:00:00Z")), "2025-12");
  });
});

describe("period — isDataReady", () => {
  test("false à moins de 3 jours de la fin du mois (défaut config)", () => {
    assert.equal(isDataReady("2026-06", new Date("2026-07-02T00:00:00.000Z")), false);
  });

  test("true à partir de 3 jours après la fin du mois", () => {
    assert.equal(isDataReady("2026-06", new Date("2026-07-03T00:00:00.000Z")), true);
    assert.equal(isDataReady("2026-06", new Date("2026-07-10T00:00:00.000Z")), true);
  });

  test("seuil personnalisable", () => {
    assert.equal(isDataReady("2026-06", new Date("2026-07-01T00:00:00.000Z"), 1), true);
    assert.equal(isDataReady("2026-06", new Date("2026-06-30T00:00:00.000Z"), 1), false);
  });
});
