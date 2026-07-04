// Generates data/admin1-population.latest.geojson: first-level administrative
// regions (states/provinces) with population density, for the heatmap's
// "Population density" mode. Boundaries come from Natural Earth 50m admin-1
// (public domain); population and official area come from Wikidata (P1082 /
// P2046) joined via the wikidataid each Natural Earth feature carries. Where
// Wikidata lacks an area (or reports one wildly inconsistent with the
// polygon), density falls back to the spherical area of the boundary itself.
// Regions without a resolvable population are still emitted so the runtime
// can name them in tooltips while colouring them from country-level data.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OUT_FILE = path.join(ROOT, "data/admin1-population.latest.geojson");

// 10m is the only Natural Earth admin-1 layer with global coverage (50m only
// carries a few large countries); simplification below keeps the output
// display-grade for the 0.25°/px overlay canvas.
const NE_ADMIN1_URL =
  "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_1_states_provinces.geojson";
const SPARQL_URL = "https://query.wikidata.org/sparql";
const USER_AGENT = "wiki-globe-data-update/1.0 (static globe visualization; admin-1 population refresh)";
const SPARQL_BATCH = 150;
const SPARQL_PAUSE_MS = 750;

const R_KM = 6371.0088;
const QUANT = 1000;        // quantize coordinates to 0.001° (~110 m)
const SIMPLIFY_DEG = 0.02; // Douglas-Peucker tolerance (~2 km; canvas px is 0.25°)

async function main() {
  console.log("Fetching Natural Earth 10m admin-1 boundaries…");
  const gj = await fetchJson(NE_ADMIN1_URL);
  if (!Array.isArray(gj?.features)) throw new Error("unexpected Natural Earth payload");

  const regions = [];
  for (const f of gj.features) {
    const p = f.properties ?? {};
    const polys = f.geometry?.type === "Polygon" ? [f.geometry.coordinates]
      : f.geometry?.type === "MultiPolygon" ? f.geometry.coordinates : [];
    if (polys.length === 0) continue;
    const iso3 = /^[A-Z]{3}$/.test(p.adm0_a3 ?? "") ? p.adm0_a3 : null;
    const qid = /^Q\d+$/.test(p.wikidataid ?? p.wikidata_id ?? "")
      ? (p.wikidataid ?? p.wikidata_id)
      : null;
    regions.push({
      id: p.adm1_code || `${iso3 ?? "XXX"}-${regions.length}`,
      name: p.name || p.name_en || p.adm1_code || "Unnamed region",
      iso3,
      qid,
      computedAreaKm2: polys.reduce((sum, rings) => sum + sphericalAreaKm2(rings), 0),
      coordinates: polys
        .map((rings) => rings.map(cleanRing).filter(Boolean))
        .filter((rings) => rings.length > 0),
    });
  }
  console.log(`Parsed ${regions.length} admin-1 regions`);

  const qids = [...new Set(regions.map((r) => r.qid).filter(Boolean))];
  console.log(`Querying Wikidata for ${qids.length} entities in batches of ${SPARQL_BATCH}…`);
  const facts = new Map(); // qid -> { population, popYear, areaKm2 }
  const warnings = [];
  for (let i = 0; i < qids.length; i += SPARQL_BATCH) {
    const batch = qids.slice(i, i + SPARQL_BATCH);
    try {
      mergeSparqlRows(facts, await querySparql(batch));
    } catch (e) {
      await sleep(5000); // transient throttle — one retry per batch
      try {
        mergeSparqlRows(facts, await querySparql(batch));
      } catch (e2) {
        warnings.push(`Wikidata batch ${i / SPARQL_BATCH + 1} failed: ${e2.message}`);
      }
    }
    process.stdout.write(`\r  ${Math.min(i + SPARQL_BATCH, qids.length)}/${qids.length}`);
    await sleep(SPARQL_PAUSE_MS);
  }
  process.stdout.write("\n");

  // Countries with a single admin-1 feature (microstates, small islands) are
  // already at their smallest denomination; their Wikidata match is often a
  // ward or capital entity, so leave density to the country-level statistic.
  const regionsPerCountry = new Map();
  for (const r of regions) {
    if (r.iso3) regionsPerCountry.set(r.iso3, (regionsPerCountry.get(r.iso3) ?? 0) + 1);
  }

  let withPopulation = 0;
  let withDensity = 0;
  let wikidataArea = 0;
  const features = regions.map((r) => {
    const soleRegion = !r.iso3 || regionsPerCountry.get(r.iso3) === 1;
    const fact = r.qid && !soleRegion ? facts.get(r.qid) : null;
    const population = fact?.population ?? null;
    // Wikidata official area is preferred, but a value wildly off from the
    // polygon's own area is usually a bad statement (wrong unit or entity);
    // fall back to the computed boundary area in that case.
    let areaKm2 = r.computedAreaKm2 > 0 ? round(r.computedAreaKm2, 1) : null;
    let areaSource = "boundary geometry";
    if (fact?.areaKm2 > 0 &&
        (r.computedAreaKm2 <= 0 || ratio(fact.areaKm2, r.computedAreaKm2) < 5)) {
      areaKm2 = round(fact.areaKm2, 1);
      areaSource = "Wikidata P2046";
      wikidataArea++;
    }
    const density = population != null && areaKm2 > 0
      ? round(population / areaKm2, population / areaKm2 < 10 ? 2 : 1)
      : null;
    if (population != null) withPopulation++;
    if (density != null) withDensity++;
    return {
      type: "Feature",
      id: r.id,
      properties: {
        name: r.name,
        iso3: r.iso3,
        wikidata: r.qid,
        population,
        popYear: fact?.popYear ?? null,
        areaKm2,
        areaSource,
        density,
      },
      geometry: { type: "MultiPolygon", coordinates: r.coordinates },
    };
  });

  const out = {
    type: "FeatureCollection",
    meta: {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      sourceLabel: "Natural Earth admin-1 + Wikidata population",
      sources: [
        { name: "Natural Earth 10m admin-1 states/provinces", url: NE_ADMIN1_URL, license: "public domain" },
        { name: "Wikidata (P1082 population, P2046 area)", url: SPARQL_URL, license: "CC0" },
      ],
      counts: {
        regions: features.length,
        withPopulation,
        withDensity,
        wikidataArea,
        countries: new Set(regions.map((r) => r.iso3).filter(Boolean)).size,
      },
      warnings,
      notes: [
        "density is people per km²; regions without a Wikidata population have density null and rely on the country-level fallback at runtime.",
        "Countries with a single admin-1 feature carry no region density; the country-level statistic is the smallest available denomination there.",
        "areaKm2 prefers the Wikidata official area and falls back to the spherical area of the (simplified) boundary polygons.",
        "Coordinates are quantized to 0.001°.",
      ],
    },
    features,
  };

  await mkdir(path.dirname(OUT_FILE), { recursive: true });
  await writeFile(OUT_FILE, `${JSON.stringify(out)}\n`, "utf8");
  console.log(
    `Wrote ${path.relative(ROOT, OUT_FILE)} — ${features.length} regions, ` +
    `${withDensity} with density (${withPopulation} with population, ${wikidataArea} Wikidata areas)`
  );
  for (const w of warnings) console.warn(`[warn] ${w}`);
}

// Latest non-deprecated population (dated statements beat undated ones) and
// the largest normalized official area for each entity in the batch.
async function querySparql(qids) {
  const query = `
    SELECT ?item ?pop ?popDate ?areaM2 WHERE {
      VALUES ?item { ${qids.map((q) => `wd:${q}`).join(" ")} }
      OPTIONAL {
        ?item p:P1082 ?popStmt .
        ?popStmt ps:P1082 ?pop .
        MINUS { ?popStmt wikibase:rank wikibase:DeprecatedRank }
        OPTIONAL { ?popStmt pq:P585 ?popDate }
      }
      OPTIONAL {
        ?item p:P2046 ?areaStmt .
        MINUS { ?areaStmt wikibase:rank wikibase:DeprecatedRank }
        ?areaStmt psn:P2046/wikibase:quantityAmount ?areaM2 .
      }
    }`;
  const resp = await fetch(SPARQL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/sparql-results+json",
      "User-Agent": USER_AGENT,
    },
    body: new URLSearchParams({ query }),
  });
  if (!resp.ok) throw new Error(`Wikidata SPARQL HTTP ${resp.status}`);
  const json = await resp.json();
  return json?.results?.bindings ?? [];
}

function mergeSparqlRows(facts, rows) {
  for (const row of rows) {
    const qid = row.item?.value?.split("/").pop();
    if (!qid) continue;
    const fact = facts.get(qid) ?? { population: null, popYear: null, popDate: null, areaKm2: null };
    const pop = Number(row.pop?.value);
    if (Number.isFinite(pop) && pop >= 0) {
      const date = row.popDate?.value ?? null;
      const newer = fact.population == null ||
        (date ?? "") > (fact.popDate ?? "") ||
        (date === fact.popDate && pop > fact.population);
      if (newer) {
        fact.population = Math.round(pop);
        fact.popDate = date;
        fact.popYear = date ? Number(date.slice(0, 4)) || null : null;
      }
    }
    const areaM2 = Number(row.areaM2?.value);
    if (Number.isFinite(areaM2) && areaM2 > 0) {
      fact.areaKm2 = Math.max(fact.areaKm2 ?? 0, areaM2 / 1e6);
    }
    facts.set(qid, fact);
  }
}

// Chamberlain & Duquette spherical polygon area; holes wind oppositely and
// subtract via the signed sum.
function sphericalAreaKm2(rings) {
  let total = 0;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      let dLon = ring[i][0] - ring[j][0];
      if (dLon > 180) dLon -= 360;
      else if (dLon < -180) dLon += 360;
      total += toRad(dLon) * (2 + Math.sin(toRad(ring[j][1])) + Math.sin(toRad(ring[i][1])));
    }
  }
  return (Math.abs(total) / 2) * R_KM * R_KM;
}

function cleanRing(ring) {
  // strip the closing duplicate before simplifying, re-close afterwards
  let open = ring;
  if (open.length > 1 &&
      open[0][0] === open[open.length - 1][0] &&
      open[0][1] === open[open.length - 1][1]) {
    open = open.slice(0, -1);
  }
  const out = [];
  for (const pt of douglasPeucker(open, SIMPLIFY_DEG)) {
    const lon = Math.round(pt[0] * QUANT) / QUANT;
    const lat = Math.round(pt[1] * QUANT) / QUANT;
    const last = out[out.length - 1];
    if (!last || last[0] !== lon || last[1] !== lat) out.push([lon, lat]);
  }
  if (out.length >= 2) {
    const [first, last] = [out[0], out[out.length - 1]];
    if (first[0] !== last[0] || first[1] !== last[1]) out.push([first[0], first[1]]);
  }
  return out.length >= 4 ? out : null;
}

// iterative Douglas-Peucker in degree space (fine at display scale)
function douglasPeucker(pts, tol) {
  if (pts.length <= 4) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    if (b - a < 2) continue;
    let worst = -1;
    let worstDist = tol;
    for (let i = a + 1; i < b; i++) {
      const d = pointSegDist(pts[i], pts[a], pts[b]);
      if (d > worstDist) { worstDist = d; worst = i; }
    }
    if (worst > 0) {
      keep[worst] = 1;
      stack.push([a, worst], [worst, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

function pointSegDist([px, py], [ax, ay], [bx, by]) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  const ex = ax + t * dx - px;
  const ey = ay + t * dy - py;
  return Math.hypot(ex, ey);
}

function ratio(a, b) {
  return a > b ? a / b : b / a;
}

function round(x, digits) {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}

function toRad(d) {
  return (d * Math.PI) / 180;
}

async function fetchJson(url) {
  const resp = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!resp.ok) throw new Error(`${url} HTTP ${resp.status}`);
  return resp.json();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
