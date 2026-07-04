import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const LANES_FILE = path.join(ROOT, "data/shipping-lanes.latest.geojson");

const errors = [];
const data = JSON.parse(await readFile(LANES_FILE, "utf8"));

if (data.type !== "FeatureCollection") errors.push("shipping lanes must be a GeoJSON FeatureCollection");
if (data.metadata?.schemaVersion !== 1) errors.push("shipping lanes metadata.schemaVersion must be 1");
if (!data.metadata?.method) errors.push("shipping lanes metadata.method is required");
if (!Array.isArray(data.features)) errors.push("shipping lanes features array is required");

const names = new Set();
let polarCount = 0;
let waypointCount = 0;

for (const [i, feature] of (data.features ?? []).entries()) {
  const label = `features[${i}]`;
  if (feature.type !== "Feature") errors.push(`${label}.type must be Feature`);

  const name = feature.properties?.name;
  if (!name || typeof name !== "string") {
    errors.push(`${label}.properties.name is required`);
  } else if (names.has(name)) {
    errors.push(`${label}.properties.name duplicate ${name}`);
  } else {
    names.add(name);
  }

  if (typeof feature.properties?.polar !== "boolean") {
    errors.push(`${label}.properties.polar must be boolean`);
  } else if (feature.properties.polar) {
    polarCount++;
  }

  const geometry = feature.geometry;
  if (geometry?.type !== "LineString" || !Array.isArray(geometry.coordinates)) {
    errors.push(`${label}.geometry must be a LineString`);
    continue;
  }
  if (geometry.coordinates.length < 2) errors.push(`${label}.geometry.coordinates must have at least two positions`);
  waypointCount += geometry.coordinates.length;

  for (const [j, position] of geometry.coordinates.entries()) {
    const pointLabel = `${label}.geometry.coordinates[${j}]`;
    if (!Array.isArray(position) || position.length < 2) {
      errors.push(`${pointLabel} must be [lon, lat]`);
      continue;
    }
    const lon = Number(position[0]);
    const lat = Number(position[1]);
    if (!Number.isFinite(lon) || lon < -180 || lon > 180) errors.push(`${pointLabel}[0] lon out of range`);
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) errors.push(`${pointLabel}[1] lat out of range`);
  }
}

if ((data.features?.length ?? 0) < 10) errors.push("expected at least 10 shipping lanes");
if (waypointCount < 100) errors.push("expected at least 100 total shipping lane waypoints");
if (polarCount < 1) errors.push("expected at least one polar shipping lane");

if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Validated ${data.features.length} shipping lanes with ${waypointCount} waypoints`);
}
