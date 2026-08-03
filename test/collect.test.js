import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { repairSnapshot } from "../src/lib/collect.js";

// Passe de réparation (§13 — correction : l'immuabilité des snapshots doit
// protéger les données *réussies*, pas des échecs périmés, ex. le scope
// Shopify `read_orders` ajouté après l'écriture du snapshot). `collectFn` est
// injectable précisément pour pouvoir tester cette logique sans réseau — en
// production, le paramètre par défaut est `collectSnapshot` (vrai
// collecteur), dont le cache disque ne mémorise jamais un échec (voir
// `withCache`/`shopify.js`) : c'est ce qui garantit qu'une source déjà
// `ok:true` n'est jamais recollectée pour de vrai, même si `repairSnapshot`
// relance formellement une collecte complète.

function baseSnapshot(overrides = {}) {
  return {
    month: "2026-06",
    sources: {
      shopify: {
        current: {
          EN: { ok: true, reason: null, data: { orders: 10, netRevenue: 500 } },
          FR: { ok: true, reason: null, data: { orders: 5, netRevenue: 200 } },
          EU: { ok: true, reason: null, data: { orders: 3, netRevenue: 100 } },
        },
        previous: {
          EN: { ok: true, reason: null, data: { orders: 8, netRevenue: 400 } },
          FR: { ok: true, reason: null, data: { orders: 4, netRevenue: 180 } },
          EU: { ok: true, reason: null, data: { orders: 2, netRevenue: 90 } },
        },
        yearAgo: {
          EN: { ok: true, reason: null, data: { orders: 9, netRevenue: 420 } },
          FR: { ok: true, reason: null, data: { orders: 3, netRevenue: 150 } },
          EU: { ok: true, reason: null, data: { orders: 1, netRevenue: 40 } },
        },
      },
    },
    ...overrides,
  };
}

describe("collect — repairSnapshot", () => {
  test("aucun échec dans le snapshot -> pas de recollecte, rien ne change", async () => {
    const snapshot = baseSnapshot();
    let called = false;
    const collectFn = async () => {
      called = true;
      throw new Error("ne doit jamais être appelé : aucune source en échec à réparer");
    };

    const result = await repairSnapshot(snapshot, { collectFn });

    assert.equal(called, false, "collectFn ne doit pas être invoqué s'il n'y a rien à réparer");
    assert.equal(result.changed, false);
    assert.deepEqual(result.repaired, []);
  });

  test("une source en échec redevenue disponible est fusionnée dans le snapshot et journalisée", async () => {
    const snapshot = baseSnapshot();
    snapshot.sources.shopify.current.EN = { ok: false, reason: "scope read_orders manquant", data: null };

    const collectFn = async (month) => {
      assert.equal(month, "2026-06");
      const candidate = baseSnapshot();
      candidate.sources.shopify.current.EN = { ok: true, reason: null, data: { orders: 12, netRevenue: 600 } };
      return candidate;
    };

    const result = await repairSnapshot(snapshot, { collectFn });

    assert.equal(result.changed, true);
    assert.equal(result.snapshot.sources.shopify.current.EN.ok, true);
    assert.equal(result.snapshot.sources.shopify.current.EN.data.orders, 12);
    assert.equal(result.repaired.length, 1);
    assert.deepEqual(result.repaired[0], {
      source: "shopify",
      periodKey: "current",
      key: "EN",
      previousReason: "scope read_orders manquant",
    });
    // Les données déjà réussies (FR, EU, previous, yearAgo) ne sont jamais recollectées ni modifiées.
    assert.equal(result.snapshot.sources.shopify.current.FR.data.orders, 5);
    assert.equal(result.snapshot.sources.shopify.previous.EN.data.orders, 8);
  });

  test("échec toujours présent après tentative -> conservé tel quel, jamais de plantage", async () => {
    const snapshot = baseSnapshot();
    snapshot.sources.shopify.current.EU = { ok: false, reason: "scope read_orders manquant", data: null };

    const collectFn = async () => {
      const candidate = baseSnapshot();
      candidate.sources.shopify.current.EU = { ok: false, reason: "scope read_orders manquant", data: null };
      return candidate;
    };

    const result = await repairSnapshot(snapshot, { collectFn });

    assert.equal(result.changed, false);
    assert.deepEqual(result.repaired, []);
    assert.equal(result.snapshot.sources.shopify.current.EU.ok, false);
    assert.equal(result.snapshot.sources.shopify.current.EU.reason, "scope read_orders manquant");
  });

  test("--no-repair (appelant) : ne pas invoquer repairSnapshot du tout revient à ignorer les échecs — vérifié au niveau de la routine report, pas ici", () => {
    // Le flag --no-repair est géré par `runReport` (routines/report.js), qui
    // saute simplement l'appel à `repairSnapshot`. Rien à tester ici de plus :
    // ce test documente où vérifier le comportement (voir test/report.test.js
    // pour le modèle, et une vérification manuelle `--no-repair` en CLI).
    assert.ok(true);
  });

  test("regroupe le message de réparation par source ET raison (ex. Shopify EN/FR/EU) plutôt qu'une ligne par boutique", async () => {
    const snapshot = baseSnapshot();
    for (const key of ["EN", "FR", "EU"]) {
      snapshot.sources.shopify.current[key] = { ok: false, reason: "scope read_orders manquant", data: null };
    }

    const collectFn = async () => {
      const candidate = baseSnapshot();
      return candidate; // toutes les boutiques ok:true dans le candidat
    };

    const originalLog = console.log;
    const lines = [];
    console.log = (...args) => lines.push(args.join(" "));
    try {
      await repairSnapshot(snapshot, { collectFn });
    } finally {
      console.log = originalLog;
    }

    const repairLine = lines.find((l) => l.includes("Réparation du snapshot"));
    assert.ok(repairLine, "un message « Réparation du snapshot » doit être journalisé");
    assert.match(repairLine, /Shopify/);
    assert.match(repairLine, /EN\/FR\/EU/);
    assert.match(repairLine, /scope read_orders manquant/);
  });
});
