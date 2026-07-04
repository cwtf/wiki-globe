import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const FILE = path.join(ROOT, "data/admin1-population.latest.geojson");

const data = JSON.parse(await readFile(FILE, "utf8"));
const errors = [];

if (data.type !== "FeatureCollection") errors.push("must be a GeoJSON FeatureCollection");
if (data.meta?.schemaVersion !== 1) errors.push("meta.schemaVersion must be 1");
if (!data.meta?.generatedAt) errors.push("meta.generatedAt is required");
if (!Array.isArray(data.features)) errors.push("features array is required");

let withDensity = 0;
let withFertility = 0;
const ids = new Set();
for (const [i, f] of (data.features ?? []).entries()) {
  const tag = f.id ?? `features[${i}]`;
  if (f.id == null || ids.has(f.id)) errors.push(`${tag}: missing or duplicate feature id`);
  ids.add(f.id);
  const p = f.properties ?? {};
  if (!p.name || typeof p.name !== "string") errors.push(`${tag}: properties.name is required`);
  if (p.iso3 != null && !/^[A-Z]{3}$/.test(p.iso3)) errors.push(`${tag}: iso3 must be ISO3 uppercase or null`);
  if (p.population != null && (!Number.isInteger(p.population) || p.population < 0)) {
    errors.push(`${tag}: population must be a non-negative integer or null`);
  }
  if (p.density != null && (!Number.isFinite(p.density) || p.density < 0)) {
    errors.push(`${tag}: density must be a non-negative number or null`);
  }
  if (p.density != null && (p.population == null || !(p.areaKm2 > 0))) {
    errors.push(`${tag}: density requires population and a positive areaKm2`);
  }
  if (p.density != null) withDensity++;
  if (p.fertility != null && (!Number.isFinite(p.fertility) || p.fertility < 0 || p.fertility > 12)) {
    errors.push(`${tag}: fertility rate out of plausible range`);
  }
  if (p.fertility != null) withFertility++;
  if (f.geometry?.type !== "MultiPolygon" || !Array.isArray(f.geometry.coordinates)) {
    errors.push(`${tag}: geometry must be a MultiPolygon`);
    continue;
  }
  outer: for (const poly of f.geometry.coordinates) {
    for (const ring of poly) {
      if (ring.length < 4) { errors.push(`${tag}: ring with fewer than 4 points`); break outer; }
      for (const pt of ring) {
        if (!Array.isArray(pt) || pt.length !== 2 ||
            pt[0] < -180 || pt[0] > 180 || pt[1] < -90 || pt[1] > 90) {
          errors.push(`${tag}: coordinate out of lon/lat range`);
          break outer;
        }
      }
    }
  }
}

if ((data.features ?? []).length < 3000) errors.push("expected at least 3000 admin-1 regions");
if (withDensity < 2000) errors.push("expected at least 2000 regions with density");

if (errors.length) {
  console.error(errors.slice(0, 40).join("\n"));
  if (errors.length > 40) console.error(`…and ${errors.length - 40} more`);
  process.exitCode = 1;
} else {
  console.log(`Validated ${data.features.length} admin-1 regions (${withDensity} with density, ${withFertility} with fertility)`);
}
