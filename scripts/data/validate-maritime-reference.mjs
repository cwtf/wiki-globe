import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MIDS_FILE = path.join(ROOT, "data/maritime-mids.latest.json");
const SHIP_TYPES_FILE = path.join(ROOT, "data/ais-ship-types.latest.json");

const errors = [];
const midsData = JSON.parse(await readFile(MIDS_FILE, "utf8"));
const shipTypesData = JSON.parse(await readFile(SHIP_TYPES_FILE, "utf8"));

if (midsData.schemaVersion !== 1) errors.push("maritime-mids schemaVersion must be 1");
if (!Array.isArray(midsData.mids)) errors.push("maritime-mids mids array is required");

const seenMids = new Set();
for (const [i, row] of (midsData.mids ?? []).entries()) {
  const label = `mids[${i}]`;
  if (!Number.isInteger(row.mid) || row.mid < 200 || row.mid > 799) {
    errors.push(`${label}.mid must be a 2xx-7xx integer`);
  }
  if (seenMids.has(row.mid)) errors.push(`${label}.mid duplicate ${row.mid}`);
  seenMids.add(row.mid);
  if (!row.flag || typeof row.flag !== "string") errors.push(`${label}.flag is required`);
}
if ((midsData.mids?.length ?? 0) < 150) errors.push("expected at least 150 MID rows");

if (shipTypesData.schemaVersion !== 1) errors.push("ais-ship-types schemaVersion must be 1");
if (!Array.isArray(shipTypesData.shipTypes)) errors.push("ais-ship-types shipTypes array is required");

const covered = new Set();
for (const [i, rule] of (shipTypesData.shipTypes ?? []).entries()) {
  const label = `shipTypes[${i}]`;
  if (!Number.isInteger(rule.from) || !Number.isInteger(rule.to) || rule.from < 0 || rule.to > 99 || rule.from > rule.to) {
    errors.push(`${label}: from/to must be an inclusive 0..99 range`);
    continue;
  }
  if (!rule.label || typeof rule.label !== "string") errors.push(`${label}.label is required`);
  for (let code = rule.from; code <= rule.to; code++) {
    if (covered.has(code)) errors.push(`${label}: code ${code} is covered by multiple rules`);
    covered.add(code);
  }
}
if ((shipTypesData.shipTypes?.length ?? 0) < 10) errors.push("expected at least 10 ship type rules");

if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Validated ${midsData.mids.length} MID rows and ${shipTypesData.shipTypes.length} ship type rules`);
}
