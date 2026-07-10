// Validate data/airports.latest.json
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const FILE = path.join(ROOT, "data/airports.latest.json");

async function main() {
  const raw = await readFile(FILE, "utf8");
  const data = JSON.parse(raw);
  if (!data.meta || !data.airports || typeof data.airports !== "object") {
    throw new Error("invalid structure: missing meta or airports object");
  }
  const entries = Object.entries(data.airports);
  if (entries.length < 3000) {
    throw new Error(`airport count ${entries.length} < 3000`);
  }
  let bad = 0;
  for (const [ident, arr] of entries) {
    if (!Array.isArray(arr) || arr.length < 2) { bad++; continue; }
    const [lon, lat] = arr;
    if (typeof lon !== "number" || typeof lat !== "number" ||
        lon < -180 || lon > 180 || lat < -90 || lat > 90) { bad++; continue; }
    if (!ident) { bad++; continue; }
  }
  if (bad > entries.length * 0.01) {
    throw new Error(`${bad} airports failed validation (> 1%)`);
  }
  console.log(`OK: ${entries.length} airports (${bad} minor issues)`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
