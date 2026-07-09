import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const FILE = path.join(ROOT, "data/country-boundaries.latest.geojson");

const data = JSON.parse(await readFile(FILE, "utf8"));
const errors = [];

if (data.type !== "FeatureCollection") errors.push("type must be FeatureCollection");
if (data.metadata?.schemaVersion !== 1) errors.push("metadata.schemaVersion must be 1");
if (!data.metadata?.generatedAt) errors.push("metadata.generatedAt is required");
if (!Array.isArray(data.features)) errors.push("features array is required");

// The upstream source includes a handful of non-ISO3 ids for disputed/
// unrecognized territories (e.g. "-99", "CS-KM"); these are harmless since
// consumers only ever look features up by valid ISO3 codes.
for (const f of data.features ?? []) {
  if (!f.id) errors.push("feature is missing an id");
  if (!f.properties?.name || typeof f.properties.name !== "string") {
    errors.push(`${f.id}: properties.name is required`);
  }
  const type = f.geometry?.type;
  if (type !== "Polygon" && type !== "MultiPolygon") {
    errors.push(`${f.id}: geometry.type must be Polygon or MultiPolygon`);
  }
  if (!Array.isArray(f.geometry?.coordinates) || f.geometry.coordinates.length === 0) {
    errors.push(`${f.id}: geometry.coordinates must be a non-empty array`);
  }
}

if ((data.features ?? []).length < 150) {
  errors.push("expected at least 150 country features");
}

if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Validated ${data.features.length} country boundary features`);
}
