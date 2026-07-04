import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const FILE = path.join(ROOT, "data/country-stats.latest.json");
const STAT_KEYS = ["gdpNominal", "gdpPpp", "hdi", "ihdi", "gni", "popDensity"];

const data = JSON.parse(await readFile(FILE, "utf8"));
const errors = [];

if (data.schemaVersion !== 1) errors.push("schemaVersion must be 1");
if (!data.meta?.generatedAt) errors.push("meta.generatedAt is required");
if (!data.countries || typeof data.countries !== "object") {
  errors.push("countries object is required");
}

for (const [iso3, row] of Object.entries(data.countries ?? {})) {
  if (!/^[A-Z]{3}$/.test(iso3)) errors.push(`${iso3}: key must be ISO3 uppercase`);
  if (!row.name || typeof row.name !== "string") errors.push(`${iso3}: name is required`);
  for (const key of STAT_KEYS) {
    const stat = row[key];
    if (stat == null) continue;
    if (typeof stat !== "object") {
      errors.push(`${iso3}.${key}: must be an object or null`);
      continue;
    }
    if (typeof stat.value !== "number" || !Number.isFinite(stat.value)) {
      errors.push(`${iso3}.${key}.value: must be a finite number`);
    }
    if ((key === "hdi" || key === "ihdi") && (stat.value < 0 || stat.value > 1)) {
      errors.push(`${iso3}.${key}.value: index values must be between 0 and 1`);
    }
    if ((key === "gdpNominal" || key === "gdpPpp" || key === "gni") && stat.value < 0) {
      errors.push(`${iso3}.${key}.value: money values must be non-negative`);
    }
    if (key === "popDensity" && stat.value < 0) {
      errors.push(`${iso3}.${key}.value: density must be non-negative`);
    }
    if (stat.year != null && (!Number.isInteger(stat.year) || stat.year < 1900 || stat.year > 2100)) {
      errors.push(`${iso3}.${key}.year: invalid year`);
    }
    if (!stat.source || typeof stat.source !== "string") {
      errors.push(`${iso3}.${key}.source: source is required`);
    }
  }
}

if (Object.keys(data.countries ?? {}).length < 150) {
  errors.push("expected at least 150 countries");
}

if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Validated ${Object.keys(data.countries).length} country rows`);
}
