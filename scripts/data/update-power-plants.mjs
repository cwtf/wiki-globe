// Fetch the WRI Global Power Plant Database CSV and convert it to a compact
// JSON array-of-arrays for the Wiki Globe power plants layer.
//
// Source: https://github.com/wri/global-power-plant-database
// License: CC BY 4.0

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OUT_FILE = path.join(ROOT, "data/power-plants.latest.json");
const SOURCE_URL =
  "https://raw.githubusercontent.com/wri/global-power-plant-database/master/output_database/global_power_plant_database.csv";

// Fuel type → index (compact storage)
const FUELS = [
  "Solar", "Hydro", "Wind", "Gas", "Coal", "Oil", "Biomass", "Waste",
  "Nuclear", "Geothermal", "Storage", "Other", "Cogeneration", "Petcoke", "Wave and Tidal",
];
const FUEL_IDX = Object.fromEntries(FUELS.map((f, i) => [f, i]));

async function main() {
  const resp = await fetch(SOURCE_URL);
  if (!resp.ok) throw new Error(`${SOURCE_URL} HTTP ${resp.status}`);
  const text = await resp.text();
  const lines = text.split("\n");
  if (lines.length < 25000) throw new Error(`expected >= 25k rows, got ${lines.length}`);

  const header = parseCSVLine(lines[0]);
  const colLat = header.indexOf("latitude");
  const colLon = header.indexOf("longitude");
  const colFuel = header.indexOf("primary_fuel");
  const colCap = header.indexOf("capacity_mw");
  const colName = header.indexOf("name");
  const colCountry = header.indexOf("country_long");

  if (colLat < 0 || colLon < 0 || colFuel < 0 || colCap < 0) {
    throw new Error("missing required columns in CSV header");
  }

  const plants = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const cols = parseCSVLine(line);
    const lat = parseFloat(cols[colLat]);
    const lon = parseFloat(cols[colLon]);
    const fuel = cols[colFuel]?.trim();
    const mw = parseFloat(cols[colCap]);
    if (!isFinite(lat) || !isFinite(lon) || !fuel || !isFinite(mw)) continue;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) continue;
    const fuelIdx = FUEL_IDX[fuel] ?? FUEL_IDX["Other"];
    plants.push([
      Math.round(lon * 1000) / 1000,
      Math.round(lat * 1000) / 1000,
      fuelIdx,
      Math.round(mw),
      cols[colName]?.trim() ?? "",
      cols[colCountry]?.trim() ?? "",
    ]);
  }

  if (plants.length < 25000) {
    throw new Error(`only ${plants.length} valid plants parsed (expected >= 25k)`);
  }

  const out = {
    meta: {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      sourceLabel: "WRI Global Power Plant Database v1.3.0",
      sources: [{ name: "WRI GPPD", url: SOURCE_URL }],
      license: "CC BY 4.0",
      fuels: FUELS,
      count: plants.length,
    },
    plants,
  };

  await mkdir(path.dirname(OUT_FILE), { recursive: true });
  await writeFile(OUT_FILE, JSON.stringify(out), "utf8");
  console.log(`Wrote ${path.relative(ROOT, OUT_FILE)} (${plants.length} plants)`);
}

// Minimal CSV line parser (handles quoted fields with commas)
function parseCSVLine(line) {
  const result = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = false;
      } else cur += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ',') { result.push(cur); cur = ""; }
      else cur += ch;
    }
  }
  result.push(cur);
  return result;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
