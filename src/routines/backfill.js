import { runCollect } from "./collect.js";
import { previousMonth, latestClosedMonth } from "../lib/period.js";
import { logger } from "../lib/logger.js";

/**
 * Collecte les `months` derniers mois clos (§4 : `npm run backfill -- --months=14`)
 * pour disposer de M-1 et M-12 dès le premier rapport. Chaque mois est
 * indépendant : l'échec (ou le skip si le snapshot existe déjà) de l'un ne
 * bloque jamais les suivants.
 */
export async function runBackfill({ months = 14, noCache = false, force = false } = {}) {
  const results = [];
  let cursor = latestClosedMonth();

  for (let i = 0; i < months; i++) {
    try {
      const result = await runCollect({ month: cursor, noCache, force });
      results.push(result);
    } catch (err) {
      logger.error(`Backfill ${cursor}: échec — ${err.message}`);
      results.push({ month: cursor, error: err.message });
    }
    cursor = previousMonth(cursor);
  }

  const failed = results.filter((r) => r.error);
  const skipped = results.filter((r) => r.skipped);
  logger.info(
    `Backfill terminé : ${results.length - failed.length}/${results.length} mois traités ` +
    `(${skipped.length} déjà existants, ${failed.length} échec(s)).`
  );
  return results;
}
