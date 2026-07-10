// Validate data/submarine-cables.latest.geojson
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const FILE = path.join(ROOT, "data/submarine-cables.latest.geojson");

async function main() {
  const raw = await readFile(FILE, "utf8");
  const gj = JSON.parse(raw);
  if (gj.type !== "FeatureCollection") throw new Error("not a FeatureCollection");
  const feats = gj.features;
  if (!Array.isArray(feats)) throw new Error("missing features array");
  if (feats.length < 300 || feats.length > 800) {
    throw new Error(`feature count ${feats.length} outside expected 300–800`);
  }
  let bad = 0;
  for (const f of feats) {
    const g = f.geometry;
    if (!g || (g.type !== "LineString" && g.type !== "MultiLineString")) { bad++; continue; }
    const coords = g.coordinates;
    if (!Array.isArray(coords) || coords.length === 0) { bad++; continue; }
    // Check first coordinate pair is valid lon/lat
    const first = g.type === "MultiLineString" ? coords[0]?.[0] : coords[0];
    if (!Array.isArray(first) || first.length < 2) { bad++; continue; }
    const [lon, lat] = first;
    if (typeof lon !== "number" || typeof lat !== "number" ||
        lon < -180 || lon > 180 || lat < -90 || lat > 90) { bad++; continue; }
    if (!f.properties?.name) { bad++; continue; }
  }
  if (bad > feats.length * 0.05) {
    throw new Error(`${bad} features failed validation (> 5%)`);
  }
  console.log(`OK: ${feats.length} cables (${bad} minor issues)`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
