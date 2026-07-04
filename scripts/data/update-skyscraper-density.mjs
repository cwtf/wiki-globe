import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OUT_FILE = path.join(ROOT, "data/skyscraper-density.latest.json");

const SOURCE_ITEM = "Q1575895"; // List of cities with the most skyscrapers
const WIKIDATA_ENTITY_URL = `https://www.wikidata.org/wiki/Special:EntityData/${SOURCE_ITEM}.json`;
const WIKIDATA_SPARQL = "https://query.wikidata.org/sparql";
const ENWIKI_API = "https://en.wikipedia.org/w/api.php";
const MIN_HEIGHT_M = 150;
const CELL_DEG = 0.5;
const R_KM = 6371.0088;

async function main() {
  const warnings = [];
  const source = await fetchSourcePage();
  const parsed = await fetchParsedPage(source.title);
  const table = selectCityCountTable(parsed.html);
  const rows = parseCityRows(table, warnings);
  const coords = await fetchCoordinates(rows.map((r) => r.title), warnings);

  const cities = [];
  for (const row of rows) {
    const coord = coords.get(row.title);
    if (!coord) {
      warnings.push(`Skipped ${row.city}: no coordinate for ${row.title}`);
      continue;
    }
    cities.push({
      rank: row.rank,
      city: row.city,
      title: row.title,
      country: row.country,
      count: row.count,
      lat: round(coord.lat, 5),
      lon: round(coord.lon, 5),
      qid: coord.qid ?? null,
      source: "q1575895",
    });
  }

  const sourceKeys = cityKeySet(cities);
  const sourceQids = cities.map((c) => c.qid).filter(Boolean);
  const supplements = await fetchSupplementalCities(sourceKeys, sourceQids, warnings);
  cities.push(...supplements);

  const aggregate = aggregateCells(cities);
  const out = {
    schemaVersion: 3,
    meta: {
      generatedAt: new Date().toISOString(),
      sourceLabel: "Q1575895 city counts + Wikidata Q11303 supplements",
      sources: [
        {
          name: "Wikidata item Q1575895",
          url: `https://www.wikidata.org/wiki/${SOURCE_ITEM}`,
          license: "CC0",
        },
        {
          name: source.title,
          url: source.url,
          license: "CC BY-SA",
          revisionId: parsed.revid ?? null,
        },
        {
          name: "Wikidata Query Service Q11303 supplemental city records",
          url: WIKIDATA_SPARQL,
          license: "CC0",
        },
      ],
      counts: {
        cities: cities.length,
        q1575895Cities: cities.filter((c) => c.source === "q1575895").length,
        supplementalCities: supplements.length,
        skyscrapers: cities.reduce((sum, c) => sum + c.count, 0),
        cells: aggregate.cells.length,
        tableRows: rows.length,
      },
      warnings,
      notes: [
        `Counts come from the English Wikipedia page linked from Wikidata ${SOURCE_ITEM}.`,
        `That list defines skyscrapers as completed high-rise buildings taller than ${MIN_HEIGHT_M} m.`,
        "Cities absent from that list are supplemented by grouping individual Wikidata Q11303 skyscraper records by city.",
        "Supplemental counts are lower-confidence minimums because Wikidata individual-building coverage is uneven.",
        `Density is city skyscraper count per ${CELL_DEG} degree cell, normalized to skyscrapers per 10,000 km2 using spherical cell area.`,
        "Each city's total is placed at that city's article or Wikidata coordinate.",
      ],
    },
    sourceItem: SOURCE_ITEM,
    minHeightM: MIN_HEIGHT_M,
    cellDeg: CELL_DEG,
    cities: aggregate.cities,
    countries: aggregate.countries,
    cells: aggregate.cells,
  };

  await mkdir(path.dirname(OUT_FILE), { recursive: true });
  await writeFile(OUT_FILE, `${JSON.stringify(out)}\n`, "utf8");
  console.log(
    `Wrote ${out.meta.counts.skyscrapers} skyscrapers from ${cities.length} cities ` +
    `(${out.meta.counts.q1575895Cities} Q1575895 + ${out.meta.counts.supplementalCities} supplemental) ` +
    `across ${aggregate.cells.length} cells`
  );
}

async function fetchSourcePage() {
  const data = await fetchJson(WIKIDATA_ENTITY_URL);
  const title = data?.entities?.[SOURCE_ITEM]?.sitelinks?.enwiki?.title;
  if (!title) throw new Error(`${SOURCE_ITEM} has no enwiki sitelink`);
  return {
    title,
    url: `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replaceAll(" ", "_"))}`,
  };
}

async function fetchParsedPage(title) {
  const data = await fetchWiki({
    action: "parse",
    page: title,
    prop: "text|revid",
  });
  const html = data?.parse?.text;
  if (!html) throw new Error(`Wikipedia parse response missing HTML for ${title}`);
  return { html, revid: data.parse.revid };
}

function selectCityCountTable(html) {
  const tables = html.match(/<table\b[\s\S]*?<\/table>/gi) ?? [];
  const table = tables.find((t) =>
    /wikitable/.test(t) &&
    /No\.\s*of\s*skyscrapers|Skyscrapers/i.test(stripHtml(t)) &&
    /Hong Kong/i.test(stripHtml(t)) &&
    /Shenzhen/i.test(stripHtml(t)) &&
    !/under construction/i.test(stripHtml(t)) &&
    !/Metropolitan area/i.test(stripHtml(t)) &&
    !/≥\s*150|&ge;\s*150/i.test(t)
  );
  if (!table) throw new Error("Could not find the city skyscraper count table");
  return table;
}

function parseCityRows(tableHtml, warnings) {
  const rows = [];
  const trs = tableHtml.match(/<tr\b[\s\S]*?<\/tr>/gi) ?? [];
  for (const tr of trs) {
    const cells = [...tr.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((m) => m[1]);
    if (cells.length < 4 || /<th\b/i.test(tr)) continue;
    const rank = parseInt(cleanText(cells[0]), 10);
    const cityCell = cells[1];
    const city = cleanText(cityCell);
    const title = wikiTitleFromCell(cityCell);
    const country = cleanText(cells[2]);
    const count = parseInt(cleanText(cells[cells.length - 1]).replace(/[^\d]/g, ""), 10);
    if (!Number.isInteger(rank) || !city || !title || !Number.isInteger(count)) {
      warnings.push(`Skipped malformed row: ${cleanText(tr).slice(0, 100)}`);
      continue;
    }
    rows.push({ rank, city, title, country, count });
  }
  if (rows.length < 10) throw new Error(`Parsed only ${rows.length} city rows from skyscraper table`);
  return rows;
}

async function fetchCoordinates(titles, warnings) {
  const coords = new Map();
  for (let i = 0; i < titles.length; i += 50) {
    const chunk = titles.slice(i, i + 50);
    const data = await fetchWiki({
      action: "query",
      prop: "coordinates|pageprops",
      redirects: "1",
      titles: chunk.join("|"),
      colimit: "max",
    });
    for (const page of Object.values(data?.query?.pages ?? {})) {
      if (page.missing) {
        warnings.push(`Missing coordinate page: ${page.title}`);
        continue;
      }
      const c = page.coordinates?.[0];
      if (c?.lat == null || c?.lon == null) {
        warnings.push(`No coordinates on page: ${page.title}`);
        continue;
      }
      coords.set(page.title, {
        lat: Number(c.lat),
        lon: Number(c.lon),
        qid: page.pageprops?.wikibase_item ?? null,
      });
    }
    for (const norm of data?.query?.normalized ?? []) {
      if (coords.has(norm.to) && !coords.has(norm.from)) coords.set(norm.from, coords.get(norm.to));
    }
    for (const redir of data?.query?.redirects ?? []) {
      if (coords.has(redir.to) && !coords.has(redir.from)) coords.set(redir.from, coords.get(redir.to));
    }
  }
  return coords;
}

async function fetchSupplementalCities(sourceKeys, sourceQids, warnings) {
  const rows = await fetchSparql(supplementQuery());
  const byCity = new Map();
  for (const row of rows) {
    const qid = entityId(row.city?.value);
    const city = row.cityLabel?.value;
    const height = Number(row.height?.value);
    const cityCoord = parsePoint(row.cityCoord?.value);
    const buildingCoord = parsePoint(row.buildingCoord?.value);
    if (!qid || !city || !Number.isFinite(height) || !buildingCoord) continue;
    const key = cityKey({ qid, city });
    if (sourceKeys.has(key)) continue;
    let item = byCity.get(qid);
    if (!item) {
      item = {
        rank: null,
        city,
        title: city,
        country: row.countryLabel?.value || "",
        count: 0,
        lat: cityCoord?.lat ?? 0,
        lon: cityCoord?.lon ?? 0,
        qid,
        source: "q11303",
        _latSum: 0,
        _lonSum: 0,
      };
      byCity.set(qid, item);
    }
    item.count++;
    item._latSum += buildingCoord.lat;
    item._lonSum += buildingCoord.lon;
    if (!item.country && row.countryLabel?.value) item.country = row.countryLabel.value;
  }

  let out = [];
  for (const item of byCity.values()) {
    if (item.count <= 0) continue;
    if (!item.lat || !item.lon) {
      item.lat = item._latSum / item.count;
      item.lon = item._lonSum / item.count;
    }
    delete item._latSum;
    delete item._lonSum;
    item.lat = round(item.lat, 5);
    item.lon = round(item.lon, 5);
    out.push(item);
  }
  const covered = await fetchCoveredSupplementCityQids(out.map((city) => city.qid), sourceQids);
  if (covered.size) {
    out = out.filter((city) => !covered.has(city.qid));
    warnings.push(`Excluded ${covered.size} supplemental cities already contained by Q1575895 cities.`);
  }
  out.sort((a, b) => b.count - a.count || a.city.localeCompare(b.city));
  warnings.push(`Supplemented ${out.length} cities from grouped Wikidata Q11303 records not present in ${SOURCE_ITEM}.`);
  return out;
}

function supplementQuery() {
  return `
SELECT DISTINCT ?building ?buildingLabel ?height ?buildingCoord ?city ?cityLabel ?cityCoord ?countryLabel WHERE {
  ?building wdt:P31/wdt:P279* wd:Q11303;
            wdt:P625 ?buildingCoord;
            p:P2048/psn:P2048 ?heightNode.
  ?heightNode wikibase:quantityAmount ?height.
  FILTER(?height >= ${MIN_HEIGHT_M} && ?height <= 1000)
  ?building wdt:P131* ?city.
  ?city wdt:P31/wdt:P279* wd:Q515.
  OPTIONAL { ?city wdt:P625 ?cityCoord. }
  OPTIONAL { ?building wdt:P17 ?country. }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}
`;
}

async function fetchCoveredSupplementCityQids(supplementQids, sourceQids) {
  if (!supplementQids.length || !sourceQids.length) return new Set();
  const rows = await fetchSparql(`
SELECT DISTINCT ?city WHERE {
  VALUES ?city { ${supplementQids.map((qid) => `wd:${qid}`).join(" ")} }
  VALUES ?listedCity { ${sourceQids.map((qid) => `wd:${qid}`).join(" ")} }
  FILTER(?city != ?listedCity)
  ?city wdt:P131* ?listedCity.
}
`);
  return new Set(rows.map((row) => entityId(row.city?.value)).filter(Boolean));
}

function aggregateCells(cityRows) {
  const cols = 360 / CELL_DEG;
  const rows = 180 / CELL_DEG;
  const byCell = new Map();
  for (const city of cityRows) {
    const x = Math.min(cols - 1, Math.max(0, Math.floor((city.lon + 180) / CELL_DEG)));
    const y = Math.min(rows - 1, Math.max(0, Math.floor((90 - city.lat) / CELL_DEG)));
    const key = y * cols + x;
    let cell = byCell.get(key);
    if (!cell) {
      cell = { x, y, count: 0, top: null, countries: new Map() };
      byCell.set(key, cell);
    }
    cell.count += city.count;
    if (!cell.top || city.count > cell.top.count) cell.top = city;
    bump(cell.countries, city.country, city.count);
  }

  const cities = [];
  const countries = [];
  const cityIdx = new Map();
  const countryIdx = new Map();

  const cells = [...byCell.values()]
    .sort((a, b) => (a.y - b.y) || (a.x - b.x))
    .map((cell) => {
      const density = (cell.count / cellAreaKm2(cell.y)) * 10000;
      return [
        cell.x,
        cell.y,
        cell.count,
        round(density, 2),
        intern(cities, cityIdx, cell.top?.city || ""),
        intern(countries, countryIdx, topKey(cell.countries)),
        cell.top?.rank ?? null,
        cell.top?.source === "q11303" ? 1 : 0,
      ];
    });

  return { cells, cities, countries };
}

function cellAreaKm2(y) {
  const latN = 90 - y * CELL_DEG;
  const latS = latN - CELL_DEG;
  const lonRad = (CELL_DEG * Math.PI) / 180;
  return R_KM * R_KM * lonRad *
    Math.abs(Math.sin((latN * Math.PI) / 180) - Math.sin((latS * Math.PI) / 180));
}

async function fetchWiki(params) {
  return fetchJson(`${ENWIKI_API}?${new URLSearchParams({
    format: "json",
    formatversion: "2",
    origin: "*",
    ...params,
  })}`);
}

async function fetchSparql(query) {
  const body = new URLSearchParams({ query, format: "json" });
  const resp = await fetch(WIKIDATA_SPARQL, {
    method: "POST",
    headers: {
      "accept": "application/sparql-results+json",
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": "Wiki Globe data updater/1.0 (https://cwtf.github.io/wiki-globe/)",
    },
    body,
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Wikidata SPARQL failed ${resp.status}: ${text.slice(0, 240)}`);
  }
  const data = await resp.json();
  if (!Array.isArray(data?.results?.bindings)) {
    throw new Error("Wikidata SPARQL response missing results.bindings");
  }
  return data.results.bindings;
}

async function fetchJson(url) {
  const resp = await fetch(url, {
    headers: {
      "accept": "application/json",
      "user-agent": "Wiki Globe data updater/1.0 (https://cwtf.github.io/wiki-globe/)",
    },
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`fetch failed ${resp.status}: ${url} ${text.slice(0, 240)}`);
  }
  return resp.json();
}

function wikiTitleFromCell(html) {
  const href = /<a\b[^>]*href="\/wiki\/([^"#?:]+)"/i.exec(html)?.[1];
  return href ? decodeURIComponent(href).replaceAll("_", " ") : "";
}

function parsePoint(wkt) {
  const m = /^Point\(([-\d.]+) ([-\d.]+)\)$/i.exec(wkt ?? "");
  if (!m) return null;
  const lon = Number(m[1]);
  const lat = Number(m[2]);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  return { lat, lon };
}

function entityId(url) {
  return /\/entity\/([^/]+)$/.exec(url ?? "")?.[1] ?? null;
}

function cityKeySet(cities) {
  return new Set(cities.map(cityKey));
}

function cityKey(city) {
  return city.qid ? `qid:${city.qid}` : `name:${normalizeName(city.city)}`;
}

function normalizeName(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function cleanText(html) {
  return stripHtml(html)
    .replace(/\[[^\]]*]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function stripHtml(html) {
  return String(html ?? "")
    .replace(/<style\b[\s\S]*?<\/style>/gi, "")
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/<sup\b[\s\S]*?<\/sup>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#160;/g, " ");
}

function bump(map, key, amount = 1) {
  if (!key) return;
  map.set(key, (map.get(key) ?? 0) + amount);
}

function topKey(map) {
  return [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? "";
}

function intern(values, index, value) {
  if (!value) return -1;
  let i = index.get(value);
  if (i == null) {
    i = values.length;
    values.push(value);
    index.set(value, i);
  }
  return i;
}

function round(value, decimals) {
  const m = 10 ** decimals;
  return Math.round(value * m) / m;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
