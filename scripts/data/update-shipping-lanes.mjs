// Generates data/shipping-lanes.latest.geojson from the Global Shipping Lanes
// dataset (Benden 2022, doi:10.5281/zenodo.6361763, CC BY 4.0) — a
// georeferenced digitization of the CIA Map of the World's Oceans.
// The upstream file holds three MultiLineStrings (Major / Middle / Minor);
// this script explodes the Major and Middle tiers into per-corridor
// LineStrings, drops short fragments, simplifies the digitized curves, and
// names each corridor after the UN/LOCODE port nearest to each endpoint so
// the client can derive simulated-vessel destinations from the name.
// Run scripts/data/update-ports.mjs first so the port gazetteer exists.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OUT_FILE = path.join(ROOT, "data/shipping-lanes.latest.geojson");
const PORTS_FILE = path.join(ROOT, "data/ports.latest.json");

const SOURCE_URL = process.env.SHIPPING_LANES_SOURCE_URL ??
  "https://raw.githubusercontent.com/newzealandpaul/Shipping-Lanes/main/data/Shipping_Lanes_v1.geojson";

const KEEP_TYPES = new Set(["Major", "Middle"]); // Minor triples the points for little gain
const MIN_LENGTH_KM = 200;      // drop digitization fragments
const SIMPLIFY_TOLERANCE = 0.05; // degrees (~5.5 km); client resamples at 120 km anyway
const POLAR_LAT = 66;           // Arctic-circle-ish threshold for the polar styling flag

async function main() {
  const [upstream, ports] = await Promise.all([fetchUpstream(), loadPorts()]);

  const features = [];
  const counters = {};
  for (const feature of upstream.features) {
    const tier = feature.properties?.Type;
    if (!KEEP_TYPES.has(tier) || feature.geometry?.type !== "MultiLineString") continue;
    for (const rawLine of feature.geometry.coordinates) {
      const line = simplifyLine(rawLine.map(([lon, lat]) => [Number(lon), Number(lat)]), SIMPLIFY_TOLERANCE);
      const lengthKm = lineLengthKm(line);
      if (line.length < 2 || lengthKm < MIN_LENGTH_KM) continue;
      const type = tier.toLowerCase();
      const seq = (counters[type] = (counters[type] ?? 0) + 1);
      const from = nearestPortName(ports, line[0]);
      const to = nearestPortName(ports, line[line.length - 1]);
      features.push({
        type: "Feature",
        id: `shipping-lane-${type}-${String(seq).padStart(3, "0")}`,
        properties: {
          name: `${tier} corridor ${String(seq).padStart(2, "0")} (${from} – ${to})`,
          polar: line.some(([, lat]) => Math.abs(lat) >= POLAR_LAT),
          type,
          lengthKm: Math.round(lengthKm),
          method: "reference-derived",
        },
        geometry: { type: "LineString", coordinates: line },
      });
    }
  }

  if (features.length < 10) {
    throw new Error(`only ${features.length} lanes survived filtering — upstream layout may have changed`);
  }

  const collection = {
    type: "FeatureCollection",
    metadata: {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      sourceLabel: "Global Shipping Lanes (CIA World Oceans map digitization)",
      method: "reference-derived",
      sources: [
        {
          name: "Global Shipping Lanes",
          url: SOURCE_URL,
          citation: "Benden, P. (2022). Global Shipping Lanes [Data set]. Zenodo. https://doi.org/10.5281/zenodo.6361763",
          license: "CC BY-SA 4.0 (excluding Statista)",
          note: "Georeferenced from the CIA Map of the World's Oceans (October 2012).",
        },
        {
          name: "UNECE UN/LOCODE (data/ports.latest.json)",
          note: "Endpoint labels are the nearest UN/LOCODE port to each corridor end.",
        },
      ],
      notes: [
        `Major and Middle tiers only; fragments under ${MIN_LENGTH_KM} km dropped;` +
          ` geometry simplified with a ${SIMPLIFY_TOLERANCE}° Douglas-Peucker tolerance.`,
        "Endpoint port names are labels for display, not routing data.",
      ],
    },
    features,
  };

  await mkdir(path.dirname(OUT_FILE), { recursive: true });
  await writeFile(OUT_FILE, `${JSON.stringify(collection, null, 2)}\n`, "utf8");
  const points = features.reduce((n, f) => n + f.geometry.coordinates.length, 0);
  const polar = features.filter((f) => f.properties.polar).length;
  console.log(
    `Wrote ${path.relative(ROOT, OUT_FILE)} (${features.length} lanes, ${points} waypoints, ${polar} polar)`
  );
}

async function fetchUpstream() {
  const res = await fetch(SOURCE_URL);
  if (!res.ok) throw new Error(`shipping lanes source ${res.status} ${res.statusText}`);
  const data = await res.json();
  if (data?.type !== "FeatureCollection" || !Array.isArray(data.features)) {
    throw new Error("shipping lanes source is not a GeoJSON FeatureCollection");
  }
  return data;
}

// Seaports with verified UN/LOCODE entries only: function code 1 filters out
// inland rail/road towns and status RQ rows are unverified requests that
// occasionally carry wildly wrong coordinates. nameWoDiacritics sidesteps the
// mangled UTF-8 in the accented name column.
async function loadPorts() {
  const data = JSON.parse(await readFile(PORTS_FILE, "utf8"));
  const ports = (data?.ports ?? []).filter(
    (p) => (p.nameWoDiacritics || p.name) && p.functions?.[0] === "1" &&
      p.status !== "RQ" && Number.isFinite(p.lat) && Number.isFinite(p.lon)
  );
  if (ports.length < 1000) {
    throw new Error("data/ports.latest.json missing or too small — run update-ports.mjs first");
  }
  return ports;
}

function nearestPortName(ports, [lon, lat]) {
  let best = null;
  let bestKm = Infinity;
  for (const p of ports) {
    const d = haversineKm(lat, lon, p.lat, p.lon);
    if (d < bestKm) { bestKm = d; best = p; }
  }
  return best.nameWoDiacritics || best.name;
}

function lineLengthKm(line) {
  let km = 0;
  for (let i = 1; i < line.length; i++) {
    km += haversineKm(line[i - 1][1], line[i - 1][0], line[i][1], line[i][0]);
  }
  return km;
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

// Iterative Douglas-Peucker with a simple planar degree metric — fine at the
// tolerances used here, and the antimeridian never bisects a segment because
// the upstream lines are already split there.
function simplifyLine(line, tolerance) {
  if (line.length <= 2) return line;
  const keep = new Uint8Array(line.length);
  keep[0] = keep[line.length - 1] = 1;
  const stack = [[0, line.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let maxDist = 0;
    let maxIdx = -1;
    for (let i = a + 1; i < b; i++) {
      const d = pointSegmentDeg(line[i], line[a], line[b]);
      if (d > maxDist) { maxDist = d; maxIdx = i; }
    }
    if (maxDist > tolerance) {
      keep[maxIdx] = 1;
      stack.push([a, maxIdx], [maxIdx, b]);
    }
  }
  return line.filter((_, i) => keep[i]);
}

function pointSegmentDeg([px, py], [ax, ay], [bx, by]) {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
