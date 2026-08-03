import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { paths } from "../src/lib/env.js";
import { readCustomerCache, writeCustomerCache, withCustomerCache } from "../src/lib/cache.js";

// Cache client dédié (distinct du cache mensuel des commandes) : clé par
// `customerId`, TTL courte (24h par défaut), pas liée au mois du rapport —
// voir shopify.js `resolveCustomerSegments` pour l'appelant réel.

const TEST_SITE = "__test_cache_site__";
const testCustomerDir = path.join(paths.cache, "customers", TEST_SITE);

after(() => {
  // Le cache est gitignored (data/cache) — on nettoie quand même les fichiers de test.
  fs.rmSync(testCustomerDir, { recursive: true, force: true });
});

describe("cache — cache client dédié (readCustomerCache/writeCustomerCache/withCustomerCache)", () => {
  test("aucune entrée -> null", () => {
    assert.equal(readCustomerCache(TEST_SITE, "absent-1"), null);
  });

  test("écriture puis lecture -> round-trip fidèle", () => {
    const data = { orders_count: 3, total_spent: "42.00" };
    writeCustomerCache(TEST_SITE, "roundtrip-1", data);
    assert.deepEqual(readCustomerCache(TEST_SITE, "roundtrip-1"), data);
  });

  test("noCache:true -> ni lecture ni écriture (bypass complet)", () => {
    writeCustomerCache(TEST_SITE, "nocache-1", { orders_count: 1 }, { noCache: true });
    assert.equal(
      fs.existsSync(path.join(testCustomerDir, "nocache-1.json")),
      false,
      "noCache doit empêcher l'écriture disque"
    );
    writeCustomerCache(TEST_SITE, "nocache-2", { orders_count: 1 });
    assert.equal(readCustomerCache(TEST_SITE, "nocache-2", { noCache: true }), null, "noCache doit empêcher la lecture même si le fichier existe");
  });

  test("entrée expirée (TTL dépassée) -> traitée comme absente", () => {
    const file = path.join(testCustomerDir, "expired-1.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const twentyFiveHoursAgo = Date.now() - 25 * 60 * 60 * 1000;
    fs.writeFileSync(file, JSON.stringify({ fetchedAt: twentyFiveHoursAgo, data: { orders_count: 5 } }));
    assert.equal(readCustomerCache(TEST_SITE, "expired-1"), null);
  });

  test("entrée récente (< TTL) -> renvoyée normalement", () => {
    const file = path.join(testCustomerDir, "fresh-1.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    fs.writeFileSync(file, JSON.stringify({ fetchedAt: oneHourAgo, data: { orders_count: 7 } }));
    assert.deepEqual(readCustomerCache(TEST_SITE, "fresh-1"), { orders_count: 7 });
  });

  test("withCustomerCache : un même client n'est fetché qu'une fois (cache hit -> fn non rappelée)", async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      return { orders_count: 2 };
    };
    const first = await withCustomerCache(TEST_SITE, "withcache-1", fn);
    const second = await withCustomerCache(TEST_SITE, "withcache-1", fn);
    assert.deepEqual(first, { orders_count: 2 });
    assert.deepEqual(second, { orders_count: 2 });
    assert.equal(calls, 1, "la 2e résolution doit venir du cache, pas d'un nouvel appel");
  });

  test("lecture d'un fichier corrompu -> null, jamais de plantage", () => {
    const file = path.join(testCustomerDir, "corrupt-1.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{ ceci n'est pas du json");
    assert.equal(readCustomerCache(TEST_SITE, "corrupt-1"), null);
  });
});
