// Fetch Natural Earth 10m time zones GeoJSON and simplify it for the Wiki Globe
// time zones layer.
//
// Source: https://github.com/nvkelso/natural-earth-vector
// License: Public domain

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OUT_FILE = path.join(ROOT, "data/time-zones.latest.geojson");
const SOURCE_URL =
  "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_time_zones.geojson";

async function main() {
  const resp = await fetch(SOURCE_URL);
  if (!resp.ok) throw new Error(`${SOURCE_URL} HTTP ${resp.status}`);
  const gj = await resp.json();
  if (!Array.isArray(gj.features) || gj.features.length < 100) {
    throw new Error(`expected >= 100 features, got ${gj.features?.length ?? 0}`);
  }

  // Simplify: round coords to 2 dp (~1km precision), keep only zone + utc_format
  const out = {
    type: "FeatureCollection",
    metadata: {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      sourceLabel: "Natural Earth 10m time zones",
      sources: [{ name: "Natural Earth", url: SOURCE_URL }],
      license: "Public domain",
      notes: [
        "Time zone polygons from Natural Earth 10m cultural dataset.",
        "Coordinates rounded to 2 decimal places for file size.",
      ],
    },
    features: gj.features.map((f) => ({
      type: "Feature",
      properties: {
        zone: f.properties?.zone ?? 0,
        utc_format: f.properties?.utc_format ?? "",
        name: f.properties?.name ?? "",
      },
      geometry: simplifyGeometry(f.geometry),
    })),
  };

  const json = JSON.stringify(out);
  const sizeMB = json.length / 1024 / 1024;
  await mkdir(path.dirname(OUT_FILE), { recursive: true });
  await writeFile(OUT_FILE, `${json}\n`, "utf8");
  console.log(`Wrote ${path.relative(ROOT, OUT_FILE)} (${out.features.length} zones, ${sizeMB.toFixed(1)} MB)`);
}

function simplifyGeometry(geom) {
  if (!geom) return geom;
  const round = (n) => Math.round(n * 10) / 10;
  const dedup = (ring) => {
    const out = [];
    for (const [lon, lat] of ring) {
      const r = [round(lon), round(lat)];
      if (out.length === 0 || out[out.length - 1][0] !== r[0] || out[out.length - 1][1] !== r[1]) {
        out.push(r);
      }
    }
    // ensure ring is closed
    if (out.length > 1 && (out[0][0] !== out[out.length - 1][0] || out[0][1] !== out[out.length - 1][1])) {
      out.push(out[0]);
    }
    return out;
  };
  if (geom.type === "Polygon") {
    return { type: "Polygon", coordinates: geom.coordinates.map(dedup) };
  }
  if (geom.type === "MultiPolygon") {
    return { type: "MultiPolygon", coordinates: geom.coordinates.map((poly) => poly.map(dedup)) };
  }
  return geom;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
