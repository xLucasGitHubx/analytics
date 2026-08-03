import { loadConfig, env } from "./env.js";
import { previousMonth, sameMonthLastYear } from "./period.js";

// Fonctions pures, zéro réseau. Entrée : valeurs/snapshots déjà collectés.
// Sortie : objets chiffrés. Aucune donnée absente n'est remplacée par 0 —
// toute division impossible (dénominateur nul/absent) renvoie `null`.

const defaultSignificance = loadConfig("thresholds").significance; // { minSessions, minTransactions }

/**
 * Seuils de significativité effectifs : config/thresholds.json, surchargeable
 * par SIGNIFICANCE_MIN_SESSIONS / SIGNIFICANCE_MIN_TRANSACTIONS (.env) sans
 * toucher au fichier de config.
 */
export function significanceThresholds() {
  return {
    minSessions: env.significanceOverrides.minSessions ?? defaultSignificance.minSessions,
    minTransactions: env.significanceOverrides.minTransactions ?? defaultSignificance.minTransactions,
  };
}

function safeRatio(numerator, denominator, multiplier = 1) {
  if (numerator == null || denominator == null || denominator === 0) return null;
  return (numerator / denominator) * multiplier;
}

/** Variation absolue + relative entre deux valeurs. `pct` est `null` si non calculable (base nulle ou valeur manquante). */
export function delta(current, previous) {
  if (current == null || previous == null) return { abs: null, pct: null, direction: null };
  const abs = current - previous;
  const pct = previous !== 0 ? (abs / Math.abs(previous)) * 100 : null;
  const direction = abs > 0 ? "up" : abs < 0 ? "down" : "flat";
  return { abs, pct, direction };
}

/** Mois sur mois : `series` = { "YYYY-MM": valeur }. Compare `month` à son M-1. */
export function mom(series, month) {
  return delta(series?.[month] ?? null, series?.[previousMonth(month)] ?? null);
}

/** Année sur année : compare `month` au même mois l'année précédente (M-12). */
export function yoy(series, month) {
  return delta(series?.[month] ?? null, series?.[sameMonthLastYear(month)] ?? null);
}

/** Part de `value` dans `total`, en %. `null` si `total` nul/absent. */
export function share(value, total) {
  return safeRatio(value, total, 100);
}

export function revenuePerSession(revenue, sessions) {
  return safeRatio(revenue, sessions, 1);
}

/** Taux de conversion (%) : transactions / sessions. */
export function conversionRate(transactions, sessions) {
  return safeRatio(transactions, sessions, 100);
}

/** Panier moyen : revenu / transactions. */
export function aov(revenue, transactions) {
  return safeRatio(revenue, transactions, 1);
}

/** CTR (%) : clics / impressions. */
export function ctr(clicks, impressions) {
  return safeRatio(clicks, impressions, 100);
}

/** Taux d'engagement (%) : sessions engagées / sessions. */
export function engagementRate(engagedSessions, sessions) {
  return safeRatio(engagedSessions, sessions, 100);
}

/**
 * Entonnoir d'achat : taux de passage vue → panier → checkout → achat, à
 * partir du rapport GA4 `ecommerce` (itemsViewed, addToCarts, checkouts,
 * ecommercePurchases). Chaque taux est `null` si l'étape précédente est nulle.
 */
export function funnel(ecommerce) {
  const { itemsViewed, addToCarts, checkouts, ecommercePurchases } = ecommerce || {};
  return {
    viewToCart: share(addToCarts, itemsViewed),
    cartToCheckout: share(checkouts, addToCarts),
    checkoutToPurchase: share(ecommercePurchases, checkouts),
    viewToPurchase: share(ecommercePurchases, itemsViewed),
  };
}

/**
 * Garde-fou de significativité (§9) : si `base` (le volume sur lequel porte
 * la variation — sessions ou transactions) est sous le seuil, la variation
 * n'est pas jugée fiable.
 */
export function significanceGuard(base, kind = "sessions", overrides = {}) {
  const thresholds = { ...significanceThresholds(), ...overrides };
  const minBase = kind === "transactions" ? thresholds.minTransactions : thresholds.minSessions;
  const insufficient = base == null || base < minBase;
  return { insufficient, base: base ?? null };
}

/**
 * Comme `delta(current, previous)`, mais avec le garde-fou de
 * significativité appliqué en amont : si `base` est sous le seuil, la
 * variation en % n'est PAS calculée — on renvoie `{ insufficient: true, base }`
 * au lieu de laisser un rapport écrire « +300 % » sur 4 sessions. `base` est
 * typiquement la valeur `previous` (le dénominateur du %) mais peut être
 * fournie explicitement (ex. total sessions du site quand la variation
 * porte sur une sous-métrique).
 */
export function significantDelta(current, previous, base, kind = "sessions", overrides = {}) {
  const guard = significanceGuard(base, kind, overrides);
  if (guard.insufficient) return guard;
  return { insufficient: false, base: guard.base, ...delta(current, previous) };
}

/**
 * Écart d'attribution par canal entre dernier clic (lastTouch) et premier
 * contact (firstTouch) — pour ne jamais déclarer un canal « non rentable »
 * sur la seule base du dernier clic (le blog est structurellement un canal
 * de découverte : fort en first-touch, faible en last-touch).
 *
 * `lastTouch`/`firstTouch` : objets `{ [channel]: { sessions, revenue } }`
 * (déjà agrégés tous sites confondus par l'appelant).
 */
export function attributionGap(lastTouch, firstTouch) {
  const channels = new Set([...Object.keys(lastTouch || {}), ...Object.keys(firstTouch || {})]);
  const out = {};
  for (const channel of channels) {
    const lt = lastTouch?.[channel] || {};
    const ft = firstTouch?.[channel] || {};
    const ltSessions = lt.sessions ?? null;
    const ftSessions = ft.sessions ?? null;
    const ltRevenue = lt.revenue ?? null;
    const ftRevenue = ft.revenue ?? null;
    out[channel] = {
      lastTouch: { sessions: ltSessions, revenue: ltRevenue },
      firstTouch: { sessions: ftSessions, revenue: ftRevenue },
      sessionsGap: ltSessions != null && ftSessions != null ? ftSessions - ltSessions : null,
      revenueGap: ltRevenue != null && ftRevenue != null ? ftRevenue - ltRevenue : null,
    };
  }
  return out;
}
