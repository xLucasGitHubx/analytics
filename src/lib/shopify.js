import { env, loadConfig } from "./env.js";
import { monthBounds } from "./period.js";
import { withCache, withCustomerCache } from "./cache.js";
import { logger } from "./logger.js";

const API_VERSION = "2024-10";
const channelLabels = loadConfig("shopify-channels").labels;
const shopifyThresholds = loadConfig("thresholds").shopify || {};
export const DEFAULT_MAX_CUSTOMERS_PER_STORE = shopifyThresholds.maxCustomersPerStore ?? 500;

/**
 * Traduit un canal de vente Shopify (`order.source_name`, clés de `byChannel`)
 * en libellé lisible pour le rapport (§4). Table de correspondance dans
 * `config/shopify-channels.json`, modifiable sans toucher au code. Un
 * identifiant purement numérique (app custom installée sans nom lisible côté
 * API, ex. `9764908`) devient « Application n°<id> » ; un canal texte déjà
 * lisible et absent de la table (ex. un nom d'app du App Store) est renvoyé
 * tel quel.
 */
export function channelLabel(channel) {
  if (!channel) return "Inconnu";
  if (channelLabels[channel]) return channelLabels[channel];
  if (/^\d+$/.test(channel)) return `Application n°${channel}`;
  return channel;
}

function parseNextLink(linkHeader) {
  if (!linkHeader) return null;
  const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
  return match ? match[1] : null;
}

/**
 * Requête Shopify avec backoff exponentiel + respect de `Retry-After` sur
 * 429/5xx. Détecte 401/403 (scope manquant) sans jamais lever — les apps
 * actuelles n'ont que `read_content`/`write_content`, pas `read_orders` :
 * c'est le cas nominal aujourd'hui, pas un bug. `scopeReason` paramètre le
 * message renvoyé sur 401/403 selon l'endpoint appelé (commandes vs client),
 * pour ne jamais accuser le mauvais scope Shopify dans les logs/le rapport.
 */
async function shopifyFetch(siteKey, url, attempt = 1, maxAttempts = 5, scopeReason = "scope read_orders manquant") {
  const { token } = env.shopify[siteKey];
  const res = await fetch(url, {
    headers: {
      "X-Shopify-Access-Token": token,
      "Content-Type": "application/json",
    },
  });

  if (res.status === 401 || res.status === 403) {
    return { ok: false, reason: scopeReason };
  }

  if (res.status === 429 || res.status >= 500) {
    if (attempt >= maxAttempts) {
      return { ok: false, reason: `Shopify ${siteKey}: rate limit/erreur serveur persistant (HTTP ${res.status})` };
    }
    const retryAfter = Number(res.headers.get("Retry-After") || 0);
    const waitMs = retryAfter > 0 ? retryAfter * 1000 : Math.min(30000, 500 * 2 ** attempt);
    logger.warn(`Shopify ${siteKey} HTTP ${res.status} — nouvelle tentative dans ${waitMs}ms (${attempt}/${maxAttempts})`);
    await new Promise((r) => setTimeout(r, waitMs));
    return shopifyFetch(siteKey, url, attempt + 1, maxAttempts, scopeReason);
  }

  if (!res.ok) {
    const body = await res.text();
    return { ok: false, reason: `Shopify ${siteKey} → HTTP ${res.status}: ${body.slice(0, 300)}` };
  }

  const data = await res.json();
  return { ok: true, data, next: parseNextLink(res.headers.get("link")) };
}

/** Toutes les commandes d'une boutique sur la fenêtre, paginées via l'en-tête `Link`. */
export async function fetchOrders(siteKey, startDate, endDate) {
  const store = env.shopify[siteKey];
  if (!store?.domain || !store?.token) {
    return { ok: false, reason: `Credentials Shopify manquants pour ${siteKey}`, orders: [] };
  }

  let url =
    `https://${store.domain}/admin/api/${API_VERSION}/orders.json` +
    `?status=any&created_at_min=${startDate}T00:00:00Z&created_at_max=${endDate}T23:59:59Z&limit=250`;
  const orders = [];

  while (url) {
    const result = await shopifyFetch(siteKey, url);
    if (!result.ok) return { ok: false, reason: result.reason, orders };
    orders.push(...(result.data.orders || []));
    url = result.next;
  }

  return { ok: true, reason: null, orders };
}

/**
 * Client Shopify par ID — `GET /admin/api/{version}/customers/{id}.json`.
 * Vérifié en direct (juillet 2026) : contrairement à l'objet `customer`
 * embarqué dans une commande (`order.customer`), qui ne porte JAMAIS
 * `orders_count`/`total_spent`/`last_order_id` — même avec le scope
 * `read_customers` actif —, cet endpoint dédié les renvoie bien. D'où l'appel
 * réseau supplémentaire par client unique pour calculer nouveau vs récurrent
 * (voir `resolveCustomerSegments`). Un 404 (client supprimé entre-temps) ou un
 * 401/403 (scope `read_customers` manquant) ne lève jamais — `{ ok:false, reason }`,
 * à charge de l'appelant d'exclure ce client du calcul sans jamais faire
 * échouer la boutique entière.
 */
export async function fetchCustomer(siteKey, customerId) {
  const store = env.shopify[siteKey];
  if (!store?.domain || !store?.token) {
    return { ok: false, reason: `Credentials Shopify manquants pour ${siteKey}`, customer: null };
  }
  const url = `https://${store.domain}/admin/api/${API_VERSION}/customers/${customerId}.json`;
  const result = await shopifyFetch(siteKey, url, 1, 5, "scope read_customers manquant");
  if (!result.ok) return { ok: false, reason: result.reason, customer: null };
  return { ok: true, reason: null, customer: result.data.customer };
}

/**
 * Segmente les commandes d'une boutique/période en nouveaux clients / clients
 * récurrents / invités (§8, défaut #3). `order.customer` embarqué ne portant
 * jamais `orders_count` (voir `fetchCustomer`), chaque client unique référencé
 * par au moins une commande est résolu via un appel réseau dédié — un de plus
 * par client unique, par mois collecté (coût documenté dans le README).
 *
 * **Limite native Shopify, incontournable** : `orders_count` est le nombre
 * TOTAL de commandes du client au moment de l'appel, pas "à la date de fin du
 * mois" — Shopify n'expose aucun moyen de demander "nouveau sur cette période
 * précise". Un client avec 1 commande en juin qui recommande en juillet
 * apparaîtra "récurrent" si le rapport de juin est régénéré après coup.
 * Nouveau ⇔ `orders_count <= 1` ; récurrent ⇔ `orders_count > 1`.
 *
 * Une commande sans client (`order.customer` null, invité) compte à part —
 * jamais classée nouveau/récurrent en silence. Un client dont la résolution
 * échoue (404, erreur réseau, scope manquant) est journalisé et exclu du
 * calcul, jamais un échec de boutique entière (§14).
 *
 * **Budget d'appels** : au-delà de `maxCustomers` clients uniques (défaut
 * `config/thresholds.json` → `shopify.maxCustomersPerStore`, 500), on arrête
 * d'en résoudre de nouveaux — résultat marqué `partial:true` avec
 * `resolvedCustomerCount`/`totalUniqueCustomerCount`, jamais un run bloqué. Si
 * le tout premier client tenté échoue par scope manquant, on arrête
 * immédiatement : le scope est au niveau de l'app, pas du client, inutile de
 * répéter le même échec des centaines de fois.
 */
export async function resolveCustomerSegments(
  siteKey,
  orders,
  { noCache = false, maxCustomers = DEFAULT_MAX_CUSTOMERS_PER_STORE, fetchCustomerFn = fetchCustomer } = {}
) {
  const revenueByCustomerId = new Map();
  const uniqueIds = [];
  let guestOrders = 0;
  let guestRevenue = 0;

  for (const order of orders || []) {
    const revenue = Number(order.total_price || 0);
    const customerId = order.customer?.id;
    if (customerId == null) {
      guestOrders++;
      guestRevenue += revenue;
      continue;
    }
    if (!revenueByCustomerId.has(customerId)) {
      revenueByCustomerId.set(customerId, 0);
      uniqueIds.push(customerId);
    }
    revenueByCustomerId.set(customerId, revenueByCustomerId.get(customerId) + revenue);
  }

  const totalUniqueCustomerCount = uniqueIds.length;
  if (totalUniqueCustomerCount > maxCustomers) {
    logger.warn(
      `Shopify ${siteKey}: ${totalUniqueCustomerCount} clients uniques à résoudre pour nouveau/récurrent, ` +
      `budget plafonné à ${maxCustomers} — résultat partiel.`
    );
  }
  const idsToResolve = uniqueIds.slice(0, maxCustomers);

  let newCustomers = 0;
  let returningCustomers = 0;
  let newCustomersRevenue = 0;
  let returningCustomersRevenue = 0;
  let resolvedCustomerCount = 0;
  let scopeMissingReason = null;

  for (const customerId of idsToResolve) {
    if (scopeMissingReason) break;
    let result;
    try {
      result = await withCustomerCache(siteKey, customerId, () => fetchCustomerFn(siteKey, customerId), { noCache });
    } catch (err) {
      logger.warn(`Shopify ${siteKey}: client ${customerId} exclu du calcul nouveau/récurrent (erreur inattendue: ${err.message}).`);
      continue;
    }
    if (!result.ok) {
      if (result.reason === "scope read_customers manquant") {
        scopeMissingReason = result.reason;
        break;
      }
      logger.warn(`Shopify ${siteKey}: client ${customerId} exclu du calcul nouveau/récurrent (${result.reason}).`);
      continue;
    }
    const ordersCount = result.customer?.orders_count;
    if (typeof ordersCount !== "number") {
      logger.warn(`Shopify ${siteKey}: client ${customerId} sans orders_count exploitable — exclu du calcul.`);
      continue;
    }
    resolvedCustomerCount++;
    const revenue = revenueByCustomerId.get(customerId) || 0;
    if (ordersCount <= 1) {
      newCustomers++;
      newCustomersRevenue += revenue;
    } else {
      returningCustomers++;
      returningCustomersRevenue += revenue;
    }
  }

  const totalCustomerRevenue = [...revenueByCustomerId.values()].reduce((sum, v) => sum + v, 0);

  // Indisponible seulement si des clients existaient à résoudre et qu'AUCUN
  // n'a pu l'être (scope manquant dès le premier essai, ou tous en échec
  // individuel) — jamais un faux 0. Un mois sans client enregistré du tout
  // (0 orders ou invités uniquement) n'est PAS "indisponible" : 0/0 est le
  // vrai décompte, pas une supposition.
  const unavailable = totalUniqueCustomerCount > 0 && resolvedCustomerCount === 0;
  const unavailableReason = !unavailable
    ? null
    : scopeMissingReason ||
      "tous les clients uniques référencés par les commandes ont échoué à être résolus (voir logs) : nouveau/récurrent non calculable ce mois.";

  return {
    newCustomers: unavailable ? null : newCustomers,
    returningCustomers: unavailable ? null : returningCustomers,
    newCustomersUnavailableReason: unavailableReason,
    newCustomersRevenue: unavailable ? null : newCustomersRevenue,
    returningCustomersRevenue: unavailable ? null : returningCustomersRevenue,
    guestOrders,
    guestRevenue,
    unresolvedCustomers: totalUniqueCustomerCount - resolvedCustomerCount,
    unresolvedRevenue: totalCustomerRevenue - newCustomersRevenue - returningCustomersRevenue,
    partial: resolvedCustomerCount > 0 && resolvedCustomerCount < totalUniqueCustomerCount,
    resolvedCustomerCount,
    totalUniqueCustomerCount,
    maxCustomers,
  };
}

/**
 * Agrégats métier par boutique (§8) : commandes, CA brut, remises,
 * remboursements, CA net, panier moyen, répartition pays, nouveau vs
 * récurrent, canal. Jamais de 0 implicite : `aov` est `null` sans commande.
 *
 * `newCustomers`/`returningCustomers` : Shopify ne renvoie `customer.orders_count`
 * (et `total_spent`, `last_order_id`) sur l'API commandes qu'avec le scope
 * `read_customers` — non accordé aujourd'hui. L'objet `customer` embarqué dans
 * chaque commande EST bien renvoyé avec `read_orders` seul (nom, email,
 * adresse — nécessaires à l'expédition), mais sans ces statistiques
 * cross-commandes. Si aucune commande n'expose `orders_count` alors que des
 * commandes avec client existent, on renvoie `null` (pas `0`) + la raison
 * dans `newCustomersUnavailableReason`, plutôt qu'un faux zéro.
 *
 * En pratique aujourd'hui, `order.customer.orders_count` n'est JAMAIS présent
 * (vérifié en direct, y compris avec le scope `read_customers` actif) : cette
 * détection reste ici comme repli défensif pur (fonction testable sans
 * réseau), mais `collectShopifyForMonth` écrase ses `newCustomers`/
 * `returningCustomers` avec le résultat de `resolveCustomerSegments`, qui
 * résout chaque client par un appel réseau dédié — voir cette fonction pour
 * le calcul réellement utilisé dans le rapport.
 */
export function aggregateOrders(orders) {
  let grossRevenue = 0;
  let discounts = 0;
  let refunds = 0;
  const byCountry = {};
  const byChannel = {};
  let newCustomers = 0;
  let returningCustomers = 0;
  let ordersWithCustomer = 0;
  let ordersWithOrdersCount = 0;

  for (const order of orders) {
    grossRevenue += Number(order.total_price || 0);
    discounts += Number(order.total_discounts || 0);
    refunds += (order.refunds || []).reduce(
      (sum, r) => sum + (r.transactions || []).reduce((s, t) => s + Number(t.amount || 0), 0),
      0
    );

    const country = order.shipping_address?.country_code || order.billing_address?.country_code || "inconnu";
    byCountry[country] = (byCountry[country] || 0) + 1;

    const channel = order.source_name || "inconnu";
    byChannel[channel] = (byChannel[channel] || 0) + 1;

    if (order.customer) ordersWithCustomer++;
    const ordersCount = order.customer?.orders_count;
    if (typeof ordersCount === "number") {
      ordersWithOrdersCount++;
      if (ordersCount === 1) newCustomers++;
      else if (ordersCount > 1) returningCustomers++;
    }
  }

  const netRevenue = grossRevenue - refunds;
  const count = orders.length;

  // Indisponible seulement si des commandes existent et qu'AUCUNE n'a pu
  // fournir `orders_count` — sinon (au moins une commande exploitable), les
  // compteurs restent des vrais décomptes, quitte à ignorer les quelques
  // commandes sans client rattaché.
  const unavailable = count > 0 && ordersWithOrdersCount === 0;
  const unavailableReason = !unavailable
    ? null
    : ordersWithCustomer > 0
      ? 'scope Shopify "read_customers" manquant : Shopify ne renvoie pas customer.orders_count sur l\'API commandes sans ce scope (le nom/email/adresse du client sont bien renvoyés avec read_orders seul, pas l\'historique cross-commandes).'
      : "aucune commande ne renvoie d'objet client (customer) — nouveau/récurrent non calculable.";

  return {
    orders: count,
    grossRevenue,
    discounts,
    refunds,
    netRevenue,
    aov: count > 0 ? netRevenue / count : null,
    currency: orders[0]?.currency || null,
    byCountry,
    byChannel,
    newCustomers: unavailable ? null : newCustomers,
    returningCustomers: unavailable ? null : returningCustomers,
    newCustomersUnavailableReason: unavailableReason,
  };
}

/**
 * Collecte Shopify pour toutes les boutiques déclarées dans .env (EN/FR/EU).
 * Une boutique morte ou sans le scope `read_orders` dégrade sa section
 * (`{ ok:false, reason }`), jamais le run global. Les commandes brutes sont
 * mises en cache disque par mois/boutique (seulement en cas de succès — une
 * panne ou un scope manquant n'est jamais mis en cache, pour qu'un simple
 * ajout du scope `read_orders` soit pris en compte au run suivant sans
 * `--no-cache`).
 *
 * Nouveau/récurrent/invité (§8, défaut #3) : `aggregateOrders` renvoie sa
 * propre détection (toujours `null` en pratique, voir son commentaire), mais
 * elle est ici volontairement écrasée par `resolveCustomerSegments`, qui
 * résout chaque client unique référencé par les commandes via un appel réseau
 * dédié (coût : un appel par client unique, par mois collecté — voir README).
 * Un échec total ou partiel de cette résolution (scope manquant, budget
 * d'appels dépassé, client individuel en erreur) dégrade uniquement ce
 * champ — jamais la boutique entière, qui reste `ok:true` avec ses commandes.
 */
export async function collectShopifyForMonth(month, { noCache = false, maxCustomersPerStore = DEFAULT_MAX_CUSTOMERS_PER_STORE, skipCustomerSegments = false } = {}) {
  const { start, end } = monthBounds(month);
  const out = {};
  for (const siteKey of Object.keys(env.shopify)) {
    const store = env.shopify[siteKey];
    if (!store.domain || !store.token) {
      out[siteKey] = { ok: false, reason: `Credentials Shopify manquants pour ${siteKey}`, data: null };
      continue;
    }
    try {
      const orders = await withCache(
        month,
        { source: "shopify", siteKey, start, end },
        async () => {
          const result = await fetchOrders(siteKey, start, end);
          if (!result.ok) throw new Error(result.reason);
          return result.orders;
        },
        { noCache }
      );
      const aggregated = aggregateOrders(orders);
      // Isolée dans son propre try/catch : un échec inattendu (pas seulement
      // un client individuel, déjà géré à l'intérieur) de la résolution
      // client ne doit jamais faire perdre les commandes/CA déjà agrégés.
      // `skipCustomerSegments` évite de payer un appel API par client unique
      // (des centaines par boutique) quand on veut juste vérifier que la
      // boutique répond (ex. `doctor`) — pas produire un rapport.
      let segments;
      if (skipCustomerSegments) {
        segments = {
          newCustomers: null,
          returningCustomers: null,
          newCustomersUnavailableReason: "résolution client ignorée (skipCustomerSegments)",
          newCustomersRevenue: null,
          returningCustomersRevenue: null,
          guestOrders: null,
          guestRevenue: null,
          unresolvedCustomers: null,
          unresolvedRevenue: null,
          partial: false,
          resolvedCustomerCount: 0,
          totalUniqueCustomerCount: null,
          maxCustomers: maxCustomersPerStore,
        };
      } else
      try {
        segments = await resolveCustomerSegments(siteKey, orders, { noCache, maxCustomers: maxCustomersPerStore });
      } catch (err) {
        logger.warn(`Shopify ${siteKey}: résolution nouveau/récurrent/invité en échec inattendu (${err.message}) — commandes conservées, détail client indisponible.`);
        segments = {
          newCustomers: null,
          returningCustomers: null,
          newCustomersUnavailableReason: `résolution client en échec inattendu : ${err.message}`,
          newCustomersRevenue: null,
          returningCustomersRevenue: null,
          guestOrders: null,
          guestRevenue: null,
          unresolvedCustomers: null,
          unresolvedRevenue: null,
          partial: false,
          resolvedCustomerCount: 0,
          totalUniqueCustomerCount: null,
          maxCustomers: maxCustomersPerStore,
        };
      }
      out[siteKey] = { ok: true, reason: null, data: { ...aggregated, ...segments } };
    } catch (err) {
      logger.warn(`Shopify ${siteKey}: ${err.message}`);
      out[siteKey] = { ok: false, reason: err.message, data: null };
    }
  }
  return out;
}
