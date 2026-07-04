import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const FILE = path.join(ROOT, "data/skyscraper-density.latest.json");

const data = JSON.parse(await readFile(FILE, "utf8"));
const errors = [];

if (data.schemaVersion !== 2) errors.push("schemaVersion must be 2");
if (data.sourceItem !== "Q1575895") errors.push("sourceItem must be Q1575895");
if (!Number.isFinite(data.minHeightM) || data.minHeightM < 100) {
  errors.push("minHeightM must be a plausible height threshold");
}
if (!Number.isFinite(data.cellDeg) || data.cellDeg <= 0 || 360 % data.cellDeg !== 0 || 180 % data.cellDeg !== 0) {
  errors.push("cellDeg must divide 360 and 180");
}
for (const key of ["cities", "countries", "cells"]) {
  if (!Array.isArray(data[key])) errors.push(`${key} must be an array`);
}

const cols = 360 / (data.cellDeg || 1);
const rows = 180 / (data.cellDeg || 1);
const seen = new Set();
let total = 0;

for (const [i, cell] of (data.cells ?? []).entries()) {
  if (!Array.isArray(cell) || cell.length !== 7) {
    errors.push(`cells[${i}] must be [x,y,count,density,cityIdx,countryIdx,rank]`);
    continue;
  }
  const [x, y, count, density, cityIdx, countryIdx, rank] = cell;
  if (!Number.isInteger(x) || x < 0 || x >= cols) errors.push(`cells[${i}]: invalid x`);
  if (!Number.isInteger(y) || y < 0 || y >= rows) errors.push(`cells[${i}]: invalid y`);
  if (!Number.isInteger(count) || count <= 0) errors.push(`cells[${i}]: invalid count`);
  if (!Number.isFinite(density) || density <= 0) errors.push(`cells[${i}]: invalid density`);
  if (!validIndex(cityIdx, data.cities)) errors.push(`cells[${i}]: invalid city index`);
  if (countryIdx !== -1 && !validIndex(countryIdx, data.countries)) errors.push(`cells[${i}]: invalid country index`);
  if (rank != null && (!Number.isInteger(rank) || rank <= 0)) errors.push(`cells[${i}]: invalid rank`);
  const key = `${x},${y}`;
  if (seen.has(key)) errors.push(`cells[${i}]: duplicate cell ${key}`);
  seen.add(key);
  total += Number.isInteger(count) ? count : 0;
}

if ((data.cells ?? []).length === 0) errors.push("expected at least one skyscraper cell");
if (data.meta?.counts?.skyscrapers != null && total !== data.meta.counts.skyscrapers) {
  errors.push(`cell counts sum to ${total}, expected ${data.meta.counts.skyscrapers}`);
}
if (data.meta?.counts?.cities != null && data.meta.counts.cities < data.cities.length) {
  errors.push("city count metadata is smaller than indexed city count");
}

if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Validated ${total} skyscrapers from ${data.meta.counts.cities} cities across ${data.cells.length} cells`);
}

function validIndex(value, array) {
  return Number.isInteger(value) && value >= 0 && value < array.length;
}
