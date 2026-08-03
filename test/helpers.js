import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));

/** Charge une fixture JSON depuis test/fixtures/. */
export function loadFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(DIR, "fixtures", name), "utf8"));
}
