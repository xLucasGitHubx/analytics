import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { paths, loadConfig } from "./env.js";
import { logger } from "./logger.js";

function hashPayload(payload) {
  return crypto.createHash("sha1").update(JSON.stringify(payload)).digest("hex");
}

function cacheFile(month, payload) {
  return path.join(paths.cache, month, `${hashPayload(payload)}.json`);
}

/** Lit le cache disque pour ce `payload` (objet JSON-sérialisable identifiant la requête). */
export function readCache(month, payload, { noCache = false } = {}) {
  if (noCache) return null;
  const file = cacheFile(month, payload);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    logger.warn(`Cache illisible, ignoré: ${file} (${err.message})`);
    return null;
  }
}

export function writeCache(month, payload, data, { noCache = false } = {}) {
  if (noCache) return;
  const file = cacheFile(month, payload);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data));
}

/**
 * Cache disque par requête : `data/cache/<mois>/<sha1(payload)>.json`. Un
 * relancement de collecte/rapport ne recoûte rien. `--no-cache` (flag global
 * CLI) contourne lecture ET écriture.
 */
export async function withCache(month, payload, fn, { noCache = false } = {}) {
  const cached = readCache(month, payload, { noCache });
  if (cached !== null) return cached;
  const data = await fn();
  writeCache(month, payload, data, { noCache });
  return data;
}

const CUSTOMER_CACHE_TTL_MS = (loadConfig("thresholds").shopify?.customerCacheTtlHours ?? 24) * 60 * 60 * 1000;

function customerCacheFile(siteKey, customerId) {
  return path.join(paths.cache, "customers", siteKey, `${customerId}.json`);
}

/**
 * Cache clients Shopify, séparé du cache mensuel des commandes ci-dessus :
 * `data/cache/customers/<siteKey>/<customerId>.json`, clé par client (pas par
 * mois de rapport) avec une durée de vie courte (`shopify.customerCacheTtlHours`
 * de `config/thresholds.json`, 24h par défaut) au lieu de la durée de vie
 * indéfinie du cache mensuel. Contrairement aux commandes d'un mois clos
 * (figées une fois collectées), les stats client (`orders_count`,
 * `total_spent`) évoluent en continu — une entrée expirée est traitée comme
 * absente. Un même client vu sur plusieurs commandes du mois, ou sur
 * plusieurs relances du rapport le même jour, n'est donc re-fetché qu'une
 * fois par fenêtre de 24h, jamais à chaque commande ni à chaque relance.
 */
export function readCustomerCache(siteKey, customerId, { noCache = false } = {}) {
  if (noCache) return null;
  const file = customerCacheFile(siteKey, customerId);
  if (!fs.existsSync(file)) return null;
  try {
    const entry = JSON.parse(fs.readFileSync(file, "utf8"));
    if (Date.now() - entry.fetchedAt > CUSTOMER_CACHE_TTL_MS) return null;
    return entry.data;
  } catch (err) {
    logger.warn(`Cache client illisible, ignoré: ${file} (${err.message})`);
    return null;
  }
}

export function writeCustomerCache(siteKey, customerId, data, { noCache = false } = {}) {
  if (noCache) return;
  const file = customerCacheFile(siteKey, customerId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ fetchedAt: Date.now(), data }));
}

/** Équivalent de `withCache` ci-dessus, mais sur le cache client à TTL (par `customerId`, pas par mois). */
export async function withCustomerCache(siteKey, customerId, fn, { noCache = false } = {}) {
  const cached = readCustomerCache(siteKey, customerId, { noCache });
  if (cached !== null) return cached;
  const data = await fn();
  writeCustomerCache(siteKey, customerId, data, { noCache });
  return data;
}
