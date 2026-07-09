import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OUT_FILE = path.join(ROOT, "data/country-boundaries.latest.geojson");
const SOURCE_URL =
  "https://raw.githubusercontent.com/johan/world.geo.json/master/countries.geo.json";

async function main() {
  const resp = await fetch(SOURCE_URL);
  if (!resp.ok) throw new Error(`${SOURCE_URL} HTTP ${resp.status}`);
  const gj = await resp.json();
  if (!Array.isArray(gj.features) || gj.features.length < 150) {
    throw new Error(`expected >= 150 features, got ${gj.features?.length ?? 0}`);
  }

  const out = {
    type: "FeatureCollection",
    metadata: {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      sourceLabel: "world.geo.json (public-domain country outlines)",
      sources: [{ name: "world.geo.json", url: SOURCE_URL }],
      notes: [
        "Bundled fallback for js/country-geo.js's live fetch of the same URL.",
        "Used by the choropleth heat-map, true-size comparison, country search, and agent color_countries/label_countries tools when the live raw.githubusercontent.com fetch is unavailable.",
      ],
    },
    features: gj.features.map((f) => ({
      type: "Feature",
      id: f.id,
      properties: { name: f.properties?.name ?? f.id },
      geometry: f.geometry,
    })),
  };

  await mkdir(path.dirname(OUT_FILE), { recursive: true });
  await writeFile(OUT_FILE, `${JSON.stringify(out, null, 2)}\n`, "utf8");
  console.log(`Wrote ${path.relative(ROOT, OUT_FILE)} (${out.features.length} countries)`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
