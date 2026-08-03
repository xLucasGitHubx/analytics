import { loadConfig } from "./env.js";

// Toujours des dates absolues YYYY-MM-DD, jamais de fenêtre glissante type
// "NdaysAgo" — condition nécessaire pour que les snapshots mensuels soient
// reproductibles (relancer une collecte en septembre pour juin doit renvoyer
// exactement les mêmes bornes qu'en juillet).

const DEFAULT_MIN_DAYS_READY = loadConfig("thresholds").dataReadiness.minDaysAfterMonthEnd;

const MONTH_RE = /^(\d{4})-(\d{2})$/;

function parseMonth(month) {
  const m = MONTH_RE.exec(month);
  if (!m) throw new Error(`Mois invalide (attendu YYYY-MM) : "${month}"`);
  return { year: Number(m[1]), monthIndex: Number(m[2]) - 1 }; // monthIndex 0-based (Date)
}

function formatMonth(year, monthIndex) {
  // Normalise via Date pour absorber les débordements (monthIndex négatif ou > 11).
  const d = new Date(Date.UTC(year, monthIndex, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

/** Bornes ISO (début/fin inclus) d'un mois calendaire. */
export function monthBounds(month) {
  const { year, monthIndex } = parseMonth(month);
  const start = `${month}-01`;
  // Jour 0 du mois suivant = dernier jour du mois courant (gère les années bissextiles).
  const lastDay = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  const end = `${month}-${pad2(lastDay)}`;
  return { start, end };
}

/** Décale un mois "YYYY-MM" de `delta` mois (négatif = dans le passé). */
export function shiftMonth(month, delta) {
  const { year, monthIndex } = parseMonth(month);
  return formatMonth(year, monthIndex + delta);
}

/** Mois précédent (M-1). */
export function previousMonth(month) {
  return shiftMonth(month, -1);
}

/** Même mois l'année précédente (M-12). */
export function sameMonthLastYear(month) {
  return shiftMonth(month, -12);
}

function toUTCDateOnly(input) {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) throw new Error(`Date invalide : "${input}"`);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function currentMonthKey(today) {
  const d = today instanceof Date ? today : new Date(today);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}`;
}

/**
 * Dernier mois entièrement terminé par rapport à `today` (le mois en cours,
 * quel que soit le jour où on se trouve dedans, n'est jamais "clos").
 */
export function latestClosedMonth(today = new Date()) {
  return previousMonth(currentMonthKey(today));
}

/**
 * false si on est à moins de `minDays` jours de la fin du mois — les données
 * GSC (~3j de latence) ne sont pas encore consolidées. Le rapport doit le
 * signaler explicitement plutôt que de produire des chiffres partiels en
 * silence.
 */
export function isDataReady(month, today = new Date(), minDays = DEFAULT_MIN_DAYS_READY) {
  const { end } = monthBounds(month);
  const endMs = toUTCDateOnly(`${end}T00:00:00.000Z`);
  const todayMs = toUTCDateOnly(today);
  const diffDays = Math.floor((todayMs - endMs) / 86400000);
  return diffDays >= minDays;
}
