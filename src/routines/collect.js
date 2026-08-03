import { collectSnapshot } from "../lib/collect.js";
import { writeSnapshot, snapshotExists } from "../lib/store.js";
import { latestClosedMonth, isDataReady } from "../lib/period.js";
import { logger } from "../lib/logger.js";

/**
 * Collecte + snapshot pour un mois donné (§4 : `npm run collect -- --month=2026-06`).
 * Aucun appel IA, aucun envoi Slack — uniquement GA4 + GSC + Shopify →
 * `data/monthly/YYYY-MM.json`. N'écrase jamais un snapshot existant sans
 * `--force` (§13, immuabilité).
 */
export async function runCollect({ month, noCache = false, force = false } = {}) {
  const targetMonth = month || latestClosedMonth();

  if (!isDataReady(targetMonth)) {
    logger.warn(
      `${targetMonth}: données probablement pas encore consolidées (moins de 3 jours après la fin du mois, ` +
      "latence GA4/GSC) — collecte quand même, le rapport le signalera plutôt que de mentir."
    );
  }

  if (snapshotExists(targetMonth) && !force) {
    logger.info(`Snapshot déjà existant pour ${targetMonth} — rien à faire (relance avec --force pour recollecter).`);
    return { month: targetMonth, skipped: true };
  }

  logger.info(`Collecte du mois ${targetMonth} (courant + M-1 + M-12)...`);
  const snapshot = await collectSnapshot(targetMonth, { noCache });
  const file = writeSnapshot(snapshot, { force });

  logger.info(
    `Collecte terminée pour ${targetMonth} : ${snapshot.collection.failures.length} échec(s), ` +
    `${snapshot.collection.warnings.length} avertissement(s).`
  );
  return { month: targetMonth, file, snapshot, skipped: false };
}
