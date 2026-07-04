import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OUT_FILE = path.join(ROOT, "data/skyscraper-density.latest.json");

const SOURCE_ITEM = "Q1575895"; // List of cities with the most skyscrapers
const WIKIDATA_ENTITY_URL = `https://www.wikidata.org/wiki/Special:EntityData/${SOURCE_ITEM}.json`;
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
    });
  }

  const aggregate = aggregateCells(cities);
  const out = {
    schemaVersion: 2,
    meta: {
      generatedAt: new Date().toISOString(),
      sourceLabel: "Wikipedia Q1575895 city skyscraper counts",
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
      ],
      counts: {
        cities: cities.length,
        skyscrapers: cities.reduce((sum, c) => sum + c.count, 0),
        cells: aggregate.cells.length,
        tableRows: rows.length,
      },
      warnings,
      notes: [
        `Counts come from the English Wikipedia page linked from Wikidata ${SOURCE_ITEM}.`,
        `That list defines skyscrapers as completed high-rise buildings taller than ${MIN_HEIGHT_M} m.`,
        `Density is city skyscraper count per ${CELL_DEG} degree cell, normalized to skyscrapers per 10,000 km2 using spherical cell area.`,
        "Counts are city-level totals from the list source, not individual building records; each city's total is placed at that city's article coordinate.",
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
  console.log(`Wrote ${out.meta.counts.skyscrapers} skyscrapers from ${cities.length} cities across ${aggregate.cells.length} cells`);
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
      prop: "coordinates",
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
      coords.set(page.title, { lat: Number(c.lat), lon: Number(c.lon) });
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
