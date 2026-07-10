// Validate data/power-plants.latest.json
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const FILE = path.join(ROOT, "data/power-plants.latest.json");

async function main() {
  const raw = await readFile(FILE, "utf8");
  const data = JSON.parse(raw);
  if (!data.meta?.fuels || !Array.isArray(data.plants)) {
    throw new Error("invalid structure: missing meta.fuels or plants array");
  }
  const fuels = data.meta.fuels;
  const plants = data.plants;
  if (plants.length < 25000) {
    throw new Error(`plant count ${plants.length} < 25000`);
  }
  let bad = 0;
  for (const p of plants) {
    if (!Array.isArray(p) || p.length < 4) { bad++; continue; }
    const [lon, lat, fuelIdx, mw] = p;
    if (typeof lon !== "number" || typeof lat !== "number" ||
        lon < -180 || lon > 180 || lat < -90 || lat > 90) { bad++; continue; }
    if (typeof fuelIdx !== "number" || fuelIdx < 0 || fuelIdx >= fuels.length) { bad++; continue; }
    if (typeof mw !== "number" || mw < 0) { bad++; continue; }
  }
  if (bad > plants.length * 0.01) {
    throw new Error(`${bad} plants failed validation (> 1%)`);
  }
  console.log(`OK: ${plants.length} plants, ${fuels.length} fuel types (${bad} minor issues)`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
