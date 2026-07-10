// Fetch OurAirports CSV and filter to large/medium airports for the Wiki Globe
// flights layer (ICAO code → named coordinates resolution).
//
// Source: https://davidmegginson.github.io/ourairports-data/airports.csv
// License: Public domain

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OUT_FILE = path.join(ROOT, "data/airports.latest.json");
const SOURCE_URL =
  "https://davidmegginson.github.io/ourairports-data/airports.csv";

async function main() {
  const resp = await fetch(SOURCE_URL);
  if (!resp.ok) throw new Error(`${SOURCE_URL} HTTP ${resp.status}`);
  const text = await resp.text();
  const lines = text.split("\n");
  if (lines.length < 30000) throw new Error(`expected >= 30k rows, got ${lines.length}`);

  const header = parseCSVLine(lines[0]);
  const colIdent = header.indexOf("ident");
  const colType = header.indexOf("type");
  const colName = header.indexOf("name");
  const colLat = header.indexOf("latitude_deg");
  const colLon = header.indexOf("longitude_deg");
  const colCountry = header.indexOf("iso_country");
  const colMunicipality = header.indexOf("municipality");

  if (colIdent < 0 || colLat < 0 || colLon < 0) {
    throw new Error("missing required columns in CSV header");
  }

  const airports = {};
  let count = 0;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const cols = parseCSVLine(line);
    const type = cols[colType]?.trim();
    if (type !== "large_airport" && type !== "medium_airport") continue;
    const ident = cols[colIdent]?.trim();
    const lat = parseFloat(cols[colLat]);
    const lon = parseFloat(cols[colLon]);
    if (!ident || !isFinite(lat) || !isFinite(lon)) continue;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) continue;
    airports[ident] = [
      Math.round(lon * 1000) / 1000,
      Math.round(lat * 1000) / 1000,
      cols[colName]?.trim() ?? "",
      cols[colCountry]?.trim() ?? "",
      cols[colMunicipality]?.trim() ?? "",
    ];
    count++;
  }

  if (count < 3000) throw new Error(`only ${count} airports parsed (expected >= 3k)`);

  const out = {
    meta: {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      sourceLabel: "OurAirports (large + medium airports)",
      sources: [{ name: "OurAirports", url: SOURCE_URL }],
      license: "Public domain",
      count,
    },
    airports,
  };

  await mkdir(path.dirname(OUT_FILE), { recursive: true });
  await writeFile(OUT_FILE, JSON.stringify(out), "utf8");
  console.log(`Wrote ${path.relative(ROOT, OUT_FILE)} (${count} airports)`);
}

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
