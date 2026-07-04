import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const FILE = path.join(ROOT, "data/heatmap-metrics.json");
const FORMATTERS = new Set(["money", "degC", "percent", "fixed3", "density"]);
const VALUE_KEYS = new Set(["tw", "t", "rh"]);
const STAT_KEYS = new Set(["gdpNominal", "gdpPpp", "hdi", "ihdi", "gni", "popDensity"]);
const KINDS = new Set(["weather", "country", "region"]);

const data = JSON.parse(await readFile(FILE, "utf8"));
const errors = [];

if (data.schemaVersion !== 1) errors.push("schemaVersion must be 1");
if (!data.metrics || typeof data.metrics !== "object") errors.push("metrics object is required");

for (const [key, metric] of Object.entries(data.metrics ?? {})) {
  if (!metric.label || typeof metric.label !== "string") errors.push(`${key}: label is required`);
  if (!KINDS.has(metric.kind)) errors.push(`${key}: invalid kind`);
  if (!FORMATTERS.has(metric.formatter)) errors.push(`${key}: unknown formatter ${metric.formatter}`);

  if (metric.kind === "weather" && !VALUE_KEYS.has(metric.valueKey)) {
    errors.push(`${key}: unknown valueKey ${metric.valueKey}`);
  }
  if ((metric.kind === "country" || metric.kind === "region") && !STAT_KEYS.has(metric.statKey)) {
    errors.push(`${key}: unknown statKey ${metric.statKey}`);
  }

  validateStops(key, metric.stops);
  validateLegend(key, metric.legend);
}

if (Object.keys(data.metrics ?? {}).length < 8) {
  errors.push("expected at least 8 heatmap metrics");
}

if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Validated ${Object.keys(data.metrics).length} heatmap metrics`);
}

function validateStops(key, stops) {
  if (!Array.isArray(stops) || stops.length < 2) {
    errors.push(`${key}: stops must contain at least two entries`);
    return;
  }
  let prev = -Infinity;
  for (const [i, stop] of stops.entries()) {
    if (!Array.isArray(stop) || stop.length !== 2) {
      errors.push(`${key}.stops[${i}]: must be [value, rgb]`);
      continue;
    }
    const [value, rgb] = stop;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      errors.push(`${key}.stops[${i}]: value must be finite number`);
    }
    if (value < prev) errors.push(`${key}.stops[${i}]: values must be sorted ascending`);
    prev = value;
    if (!Array.isArray(rgb) || rgb.length !== 3 || rgb.some((c) => !Number.isInteger(c) || c < 0 || c > 255)) {
      errors.push(`${key}.stops[${i}]: rgb must be three 0..255 integers`);
    }
  }
}

function validateLegend(key, legend) {
  if (!Array.isArray(legend) || legend.length < 2) {
    errors.push(`${key}: legend must contain at least two entries`);
    return;
  }
  for (const [i, item] of legend.entries()) {
    if (!Array.isArray(item) || item.length !== 2 || typeof item[0] !== "string" || !/^#[0-9a-f]{6}$/i.test(item[1])) {
      errors.push(`${key}.legend[${i}]: must be [label, #rrggbb]`);
    }
  }
}
