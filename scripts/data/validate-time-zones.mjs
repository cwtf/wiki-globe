// Validate data/time-zones.latest.geojson
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const FILE = path.join(ROOT, "data/time-zones.latest.geojson");

async function main() {
  const raw = await readFile(FILE, "utf8");
  const gj = JSON.parse(raw);
  if (gj.type !== "FeatureCollection") throw new Error("not a FeatureCollection");
  const feats = gj.features;
  if (!Array.isArray(feats)) throw new Error("missing features array");
  if (feats.length < 80 || feats.length > 200) {
    throw new Error(`feature count ${feats.length} outside expected 80–200`);
  }
  let bad = 0;
  for (const f of feats) {
    const g = f.geometry;
    if (!g || (g.type !== "Polygon" && g.type !== "MultiPolygon")) { bad++; continue; }
    if (typeof f.properties?.zone !== "number") { bad++; continue; }
  }
  if (bad > feats.length * 0.05) {
    throw new Error(`${bad} features failed validation (> 5%)`);
  }
  const sizeMB = raw.length / 1024 / 1024;
  if (sizeMB > 2.0) {
    throw new Error(`file size ${sizeMB.toFixed(1)} MB exceeds 2.0 MB target`);
  }
  console.log(`OK: ${feats.length} time zones (${bad} minor issues, ${sizeMB.toFixed(1)} MB)`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
