import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const FILE = path.join(ROOT, "data/ports.latest.json");

const data = JSON.parse(await readFile(FILE, "utf8"));
const errors = [];
const seen = new Set();

if (data.schemaVersion !== 1) errors.push("schemaVersion must be 1");
if (!data.meta?.generatedAt) errors.push("meta.generatedAt is required");
if (!Array.isArray(data.ports)) errors.push("ports array is required");

for (const [i, port] of (data.ports ?? []).entries()) {
  const label = port.locode ?? `ports[${i}]`;
  if (!/^[A-Z]{2}[A-Z0-9]{3}$/.test(port.locode ?? "")) {
    errors.push(`${label}: locode must be compact UN/LOCODE`);
  }
  if (seen.has(port.locode)) errors.push(`${label}: duplicate locode`);
  seen.add(port.locode);
  if (!port.name || typeof port.name !== "string") errors.push(`${label}: name is required`);
  if (typeof port.lat !== "number" || port.lat < -90 || port.lat > 90) {
    errors.push(`${label}: lat must be -90..90`);
  }
  if (typeof port.lon !== "number" || port.lon < -180 || port.lon > 180) {
    errors.push(`${label}: lon must be -180..180`);
  }
  if (port.functions != null && !String(port.functions).includes("1") && port.source !== "Bundled legacy fallback") {
    errors.push(`${label}: generated ports must include function classifier 1`);
  }
  if (port.aliases != null && !Array.isArray(port.aliases)) {
    errors.push(`${label}: aliases must be an array when present`);
  }
}

if ((data.ports?.length ?? 0) < 1000) {
  errors.push("expected at least 1000 ports from UN/LOCODE");
}

if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Validated ${data.ports.length} port rows`);
}
