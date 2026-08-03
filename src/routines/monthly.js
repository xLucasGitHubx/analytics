import { runCollect } from "./collect.js";
import { runReport } from "./report.js";
import { logger } from "../lib/logger.js";
import { sendFailureAlert } from "../report/slack.js";

/**
 * `monthly` (§4) : le run du 3 du mois — `collect(mois précédent)` +
 * `report` complet (agents Claude + Slack). Les deux routines partagent le
 * même mois par défaut (`latestClosedMonth()`), on réutilise donc le mois
 * renvoyé par `runCollect` pour ne jamais désynchroniser collecte et rapport.
 * Une alerte Slack est envoyée si le run plante (§14).
 */
export async function runMonthly({ noCache = false, force = false } = {}) {
  try {
    const collectResult = await runCollect({ noCache, force });
    const month = collectResult.month;
    logger.info(`Run mensuel : collecte ${collectResult.skipped ? "déjà faite" : "terminée"} pour ${month}, génération du rapport complet...`);
    const reportResult = await runReport({ month, noAi: false, noSlack: false, noCache, force });
    logger.info(`Run mensuel terminé pour ${month}.`);
    return reportResult;
  } catch (err) {
    logger.error(`Run mensuel en échec: ${err.stack || err.message}`);
    await sendFailureAlert("monthly", err);
    throw err;
  }
}
