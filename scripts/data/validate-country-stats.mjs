import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const FILE = path.join(ROOT, "data/country-stats.latest.json");
const STAT_KEYS = [
  "gdpNominal", "gdpPpp", "hdi", "ihdi", "gni", "popDensity", "fertility",
  "popGrowth", "urbanShare", "lifeExpectancy", "infantMortality", "cleanWater",
  "electricityAccess", "internetUsers", "gini", "poverty", "co2PerCapita",
  "renewableElectricity", "energyUse", "pm25", "annualPrecipitation",
];
const PERCENT_KEYS = new Set([
  "urbanShare", "cleanWater", "electricityAccess", "internetUsers",
  "poverty", "renewableElectricity",
]);

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
    if (key === "fertility" && (stat.value < 0 || stat.value > 12)) {
      errors.push(`${iso3}.${key}.value: fertility rate out of plausible range`);
    }
    if (key === "popGrowth" && (stat.value < -20 || stat.value > 20)) {
      errors.push(`${iso3}.${key}.value: population growth out of plausible range`);
    }
    if (PERCENT_KEYS.has(key) && (stat.value < 0 || stat.value > 100)) {
      errors.push(`${iso3}.${key}.value: percent values must be between 0 and 100`);
    }
    if (key === "lifeExpectancy" && (stat.value < 20 || stat.value > 100)) {
      errors.push(`${iso3}.${key}.value: life expectancy out of plausible range`);
    }
    if (key === "infantMortality" && (stat.value < 0 || stat.value > 250)) {
      errors.push(`${iso3}.${key}.value: infant mortality out of plausible range`);
    }
    if (key === "gini" && (stat.value < 0 || stat.value > 100)) {
      errors.push(`${iso3}.${key}.value: Gini values must be between 0 and 100`);
    }
    if (key === "co2PerCapita" && (stat.value < 0 || stat.value > 100)) {
      errors.push(`${iso3}.${key}.value: CO2 per-capita value out of plausible range`);
    }
    if (key === "energyUse" && (stat.value < 0 || stat.value > 50000)) {
      errors.push(`${iso3}.${key}.value: energy use out of plausible range`);
    }
    if (key === "pm25" && (stat.value < 0 || stat.value > 150)) {
      errors.push(`${iso3}.${key}.value: PM2.5 value out of plausible range`);
    }
    if (key === "annualPrecipitation" && (stat.value < 0 || stat.value > 12000)) {
      errors.push(`${iso3}.${key}.value: annual precipitation out of plausible range`);
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
