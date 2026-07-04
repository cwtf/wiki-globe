import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const FILE = path.join(ROOT, "data/conflict-events.latest.json");

const data = JSON.parse(await readFile(FILE, "utf8"));
const errors = [];

if (data.schemaVersion !== 1) errors.push("schemaVersion must be 1");
if (!data.meta?.generatedAt) errors.push("meta.generatedAt is required");
if (!/^\d{4}-\d{2}$/.test(data.meta?.period?.start ?? "")) errors.push("meta.period.start must be YYYY-MM");
if (!/^\d{4}-\d{2}$/.test(data.meta?.period?.end ?? "")) errors.push("meta.period.end must be YYYY-MM");
for (const table of ["months", "countries", "dyads"]) {
  if (!Array.isArray(data[table]) || data[table].some((v) => typeof v !== "string" || v === "")) {
    errors.push(`${table} must be an array of non-empty strings`);
  }
}
if (!Array.isArray(data.events)) errors.push("events array is required");

let deaths = 0;
for (const [i, ev] of (data.events ?? []).entries()) {
  if (!Array.isArray(ev) || ev.length !== 7) {
    errors.push(`events[${i}]: must have 7 columns`);
    continue;
  }
  const [lat, lon, best, mi, ci, di, type] = ev;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) errors.push(`events[${i}]: coordinate out of range`);
  if (!Number.isInteger(best) || best < 0) errors.push(`events[${i}]: deaths must be a non-negative integer`);
  if (!data.months?.[mi]) errors.push(`events[${i}]: bad month index`);
  if (!data.countries?.[ci]) errors.push(`events[${i}]: bad country index`);
  if (!data.dyads?.[di]) errors.push(`events[${i}]: bad dyad index`);
  if (![1, 2, 3].includes(type)) errors.push(`events[${i}]: type_of_violence must be 1, 2 or 3`);
  deaths += best;
  if (errors.length > 40) break;
}

if ((data.events ?? []).length < 1000) errors.push("expected at least 1000 conflict events");
if (data.meta?.counts?.events !== data.events?.length) errors.push("meta.counts.events does not match events length");

if (errors.length) {
  console.error(errors.slice(0, 40).join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Validated ${data.events.length} conflict events (${deaths.toLocaleString()} deaths, ${data.meta.period.start} → ${data.meta.period.end})`);
}
