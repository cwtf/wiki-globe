// Fetch submarine cable GeoJSON from TeleGeography's public repo and simplify
// it for the Wiki Globe cables layer.
//
// Source: https://github.com/telegeography/www.submarinecablemap.com
// License: CC BY-NC-SA (non-commercial hobby project usage)

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OUT_FILE = path.join(ROOT, "data/submarine-cables.latest.geojson");

// The repo layout has moved before — try the known path, fall back to search.
const SOURCE_URLS = [
  "https://raw.githubusercontent.com/curran/www.submarinecablemap.com/master/web/public/api/v3/cable/cable-geo.json",
  "https://raw.githubusercontent.com/telegeography/www.submarinecablemap.com/master/web/public/api/v3/cable/cable-geo.json",
  "https://raw.githubusercontent.com/telegeography/www.submarinecablemap.com/main/web/public/api/v3/cable/cable-geo.json",
];

async function tryFetch(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`${url} HTTP ${resp.status}`);
  return resp.json();
}

async function main() {
  let gj = null;
  let usedUrl = null;
  for (const url of SOURCE_URLS) {
    try {
      gj = await tryFetch(url);
      usedUrl = url;
      break;
    } catch (e) {
      console.warn(`Failed ${url}: ${e.message}`);
    }
  }
  if (!gj) throw new Error("All source URLs failed");
  if (!Array.isArray(gj.features) || gj.features.length < 300) {
    throw new Error(`expected >= 300 features, got ${gj.features?.length ?? 0}`);
  }

  // Simplify: round coords to 3 decimal places, keep only name + color
  const out = {
    type: "FeatureCollection",
    metadata: {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      sourceLabel: "TeleGeography Submarine Cable Map",
      sources: [{ name: "TeleGeography", url: usedUrl }],
      license: "CC BY-NC-SA",
      notes: [
        "Submarine cable routes from TeleGeography's submarinecablemap.com.",
        "Non-commercial use under CC BY-NC-SA.",
      ],
    },
    features: gj.features.map((f) => {
      const coords = f.geometry?.coordinates;
      const simplified = Array.isArray(coords)
        ? f.geometry.type === "MultiLineString"
          ? coords.map((line) => line.map(round3))
          : coords.map(round3)
        : coords;
      return {
        type: "Feature",
        properties: {
          name: f.properties?.name ?? "",
          color: f.properties?.color ?? "",
        },
        geometry: { type: f.geometry?.type ?? "LineString", coordinates: simplified },
      };
    }),
  };

  await mkdir(path.dirname(OUT_FILE), { recursive: true });
  await writeFile(OUT_FILE, `${JSON.stringify(out)}\n`, "utf8");
  console.log(`Wrote ${path.relative(ROOT, OUT_FILE)} (${out.features.length} cables)`);
}

function round3(n) {
  return Array.isArray(n) ? n.map(round3) : Math.round(n * 1000) / 1000;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
