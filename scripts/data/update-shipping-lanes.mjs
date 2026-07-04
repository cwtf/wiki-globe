import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SHIPPING_LANES_MODULE = path.join(ROOT, "js/shipping-lanes.js");
const OUT_FILE = path.join(ROOT, "data/shipping-lanes.latest.geojson");

async function main() {
  const SHIPPING_LANES = await readLegacyShippingLanes();
  const features = SHIPPING_LANES.map((lane, i) => ({
    type: "Feature",
    id: `shipping-lane-${String(i + 1).padStart(2, "0")}`,
    properties: {
      name: lane.name,
      polar: Boolean(lane.polar),
      method: "curated",
    },
    geometry: {
      type: "LineString",
      coordinates: lane.waypoints.map(([lon, lat]) => [Number(lon), Number(lat)]),
    },
  }));

  const collection = {
    type: "FeatureCollection",
    metadata: {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      sourceLabel: "Wiki Globe curated shipping lane baseline",
      method: "curated",
      sources: [
        {
          name: "Legacy Wiki Globe shipping lane waypoints",
          file: "js/shipping-lanes.js",
        },
      ],
      notes: [
        "This baseline preserves the existing hand-plotted reference corridors as data.",
        "Replace this file with AIS-density-derived corridors when a suitable source pipeline is available.",
      ],
    },
    features,
  };

  await mkdir(path.dirname(OUT_FILE), { recursive: true });
  await writeFile(OUT_FILE, `${JSON.stringify(collection, null, 2)}\n`, "utf8");
  console.log(`Wrote ${path.relative(ROOT, OUT_FILE)} (${features.length} lanes)`);
}

async function readLegacyShippingLanes() {
  const js = await readFile(SHIPPING_LANES_MODULE, "utf8");
  const match = js.match(/export const SHIPPING_LANES = (\[[\s\S]*?\n\]);/);
  if (!match) throw new Error("SHIPPING_LANES array not found");
  return Function(`"use strict"; return (${match[1]});`)();
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
