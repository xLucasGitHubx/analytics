import fs from "node:fs";
import path from "node:path";
import { paths } from "./env.js";
import { logger } from "./logger.js";

function snapshotPath(month) {
  return path.join(paths.monthly, `${month}.json`);
}

export function snapshotExists(month) {
  return fs.existsSync(snapshotPath(month));
}

export function readSnapshot(month) {
  const file = snapshotPath(month);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/**
 * Écrit le snapshot mensuel. Immuable une fois écrit (§13) : un second appel
 * sans `force` lève une erreur explicite plutôt que d'écraser en silence —
 * c'est ce qui garantit que le rapport de juin dit la même chose en
 * septembre qu'en juillet.
 */
export function writeSnapshot(snapshot, { force = false } = {}) {
  const file = snapshotPath(snapshot.month);
  if (fs.existsSync(file) && !force) {
    throw new Error(
      `Snapshot déjà existant pour ${snapshot.month} (${file}). ` +
      "Les snapshots sont immuables une fois écrits — relance avec --force pour l'écraser explicitement."
    );
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(snapshot, null, 2));
  logger.info(`Snapshot écrit : ${file}`);
  return file;
}

/** Liste les mois déjà collectés (noms de fichiers YYYY-MM.json triés). */
export function listSnapshots() {
  if (!fs.existsSync(paths.monthly)) return [];
  return fs
    .readdirSync(paths.monthly)
    .filter((f) => /^\d{4}-\d{2}\.json$/.test(f))
    .map((f) => f.replace(/\.json$/, ""))
    .sort();
}
