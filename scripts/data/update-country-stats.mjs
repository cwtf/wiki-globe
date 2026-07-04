import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const LEGACY_FILE = path.join(ROOT, "js/country-data.js");
const OUT_FILE = path.join(ROOT, "data/country-stats.latest.json");

const WORLD_BANK_INDICATORS = [
  {
    key: "gdpNominal",
    indicator: "NY.GDP.PCAP.CD",
    label: "GDP per capita (current US$)",
  },
  {
    key: "gdpPpp",
    indicator: "NY.GDP.PCAP.PP.CD",
    label: "GDP per capita, PPP (current international $)",
  },
  {
    key: "gni",
    indicator: "NY.GNP.PCAP.PP.CD",
    label: "GNI per capita, PPP (current international $)",
  },
  {
    key: "popDensity",
    indicator: "EN.POP.DNST",
    label: "Population density (people per sq. km of land area)",
  },
];

const HDR_DOWNLOADS = "https://hdr.undp.org/data-center/documentation-and-downloads";

async function main() {
  const legacy = await readLegacyCountryStats();
  const countries = legacyCountryRows(legacy);
  const sources = [];
  const warnings = [];

  for (const spec of WORLD_BANK_INDICATORS) {
    try {
      const values = await fetchWorldBankIndicator(spec);
      mergeIndicator(countries, values, spec.key);
      sources.push({
        name: "World Bank Indicators API",
        url: `https://api.worldbank.org/v2/country/all/indicator/${spec.indicator}?format=json`,
        indicators: [spec.indicator],
      });
    } catch (e) {
      warnings.push(`World Bank ${spec.indicator} failed: ${e.message}`);
    }
  }

  try {
    const hdr = await fetchHdrData();
    mergeHdr(countries, hdr);
    sources.push(hdr.source);
  } catch (e) {
    warnings.push(`UNDP HDR merge skipped: ${e.message}`);
  }

  const generatedAt = new Date().toISOString();
  const out = {
    schemaVersion: 1,
    meta: {
      generatedAt,
      sourceLabel: sourceLabel(sources),
      sources,
      warnings,
      notes: [
        "World Bank values are the latest non-null annual value returned by the Indicators API.",
        "UNDP HDR fields are merged when an HDR CSV URL is supplied or discoverable; otherwise legacy HDI/IHDI values remain marked as legacy.",
      ],
    },
    fields: {
      gdpNominal: {
        unit: "current US dollars per person",
        defaultSource: "World Bank",
        indicator: "NY.GDP.PCAP.CD",
      },
      gdpPpp: {
        unit: "current international dollars per person",
        defaultSource: "World Bank",
        indicator: "NY.GDP.PCAP.PP.CD",
      },
      hdi: {
        unit: "index",
        defaultSource: "UNDP HDR",
      },
      ihdi: {
        unit: "index",
        defaultSource: "UNDP HDR",
      },
      gni: {
        unit: "current international dollars per person",
        defaultSource: "World Bank",
        indicator: "NY.GNP.PCAP.PP.CD",
      },
      popDensity: {
        unit: "people per square kilometre of land area",
        defaultSource: "World Bank",
        indicator: "EN.POP.DNST",
      },
    },
    countries,
  };

  await mkdir(path.dirname(OUT_FILE), { recursive: true });
  await writeFile(OUT_FILE, `${JSON.stringify(out, null, 2)}\n`, "utf8");

  console.log(`Wrote ${path.relative(ROOT, OUT_FILE)} (${Object.keys(countries).length} countries)`);
  for (const warning of warnings) console.warn(`[warn] ${warning}`);
}

async function readLegacyCountryStats() {
  const js = await readFile(LEGACY_FILE, "utf8");
  const match = js.match(/export const COUNTRY_STATS = \{([\s\S]*?)\n\};/);
  if (!match) throw new Error("COUNTRY_STATS export not found");
  return Function(`"use strict"; return ({${match[1]}\n});`)();
}

function legacyCountryRows(legacy) {
  const countries = {};
  for (const [iso3, row] of Object.entries(legacy)) {
    countries[iso3] = {
      name: row[0],
      gdpNominal: legacyStat(row[1], "Bundled legacy snapshot"),
      gdpPpp: legacyStat(row[2], "Bundled legacy snapshot"),
      hdi: legacyStat(row[3], "Bundled legacy snapshot"),
      ihdi: legacyStat(row[4], "Bundled legacy snapshot"),
      gni: legacyStat(row[5], "Bundled legacy snapshot"),
    };
  }
  return countries;
}

function legacyStat(value, source) {
  return value == null ? null : { value, source };
}

async function fetchWorldBankIndicator(spec) {
  const url = new URL(`https://api.worldbank.org/v2/country/all/indicator/${spec.indicator}`);
  url.search = new URLSearchParams({ format: "json", per_page: "20000" });
  const json = await fetchJson(url);
  const rows = Array.isArray(json) ? json[1] : null;
  if (!Array.isArray(rows)) throw new Error("unexpected World Bank response");

  const latest = new Map();
  for (const row of rows) {
    const iso3 = row.countryiso3code;
    const year = Number(row.date);
    const value = row.value;
    if (!/^[A-Z]{3}$/.test(iso3) || value == null || !Number.isFinite(year)) continue;
    const prev = latest.get(iso3);
    if (!prev || year > prev.year) {
      latest.set(iso3, {
        countryName: row.country?.value,
        value: round(value),
        year,
        source: "World Bank",
        indicator: spec.indicator,
        label: spec.label,
      });
    }
  }
  return latest;
}

function mergeIndicator(countries, values, key) {
  for (const [iso3, stat] of values) {
    const { countryName, ...row } = stat;
    countries[iso3] ??= { name: countryName ?? iso3 };
    if (countries[iso3].name === iso3 && countryName) countries[iso3].name = countryName;
    countries[iso3][key] = row;
  }
}

async function fetchHdrData() {
  const url = process.env.HDR_CSV_URL || await discoverHdrCsvUrl();
  if (!url) throw new Error("set HDR_CSV_URL to merge UNDP HDI/IHDI data");
  const text = await fetchText(url);
  const rows = parseCsv(text);
  if (rows.length === 0) throw new Error("empty HDR CSV");
  return {
    rows,
    source: {
      name: "UNDP Human Development Reports",
      url,
      fields: ["hdi", "ihdi", "gni"],
    },
  };
}

async function discoverHdrCsvUrl() {
  const html = await fetchText(HDR_DOWNLOADS);
  const links = [...html.matchAll(/href="([^"]+)"/gi)]
    .map((m) => new URL(m[1], HDR_DOWNLOADS).href)
    .filter((href) => /\.csv(\?|$)/i.test(href));
  return links.find((href) => /composite|time.series|indices|all/i.test(href)) ?? links[0] ?? null;
}

function mergeHdr(countries, hdr) {
  for (const row of hdr.rows) {
    const iso3 = pick(row, ["iso3", "iso_code", "code", "country_code", "hdicode"])?.toUpperCase();
    if (!/^[A-Z]{3}$/.test(iso3 ?? "")) continue;
    countries[iso3] ??= { name: pick(row, ["country", "country_name", "name"]) ?? iso3 };
    countries[iso3].name ||= pick(row, ["country", "country_name", "name"]) ?? iso3;

    const hdi = latestYearValue(row, ["hdi"]);
    const ihdi = latestYearValue(row, ["ihdi"]);
    const gni = latestYearValue(row, ["gnipc", "gni_pc", "gni"]);
    if (hdi) countries[iso3].hdi = { ...hdi, source: "UNDP HDR" };
    if (ihdi) countries[iso3].ihdi = { ...ihdi, source: "UNDP HDR" };
    if (gni) countries[iso3].gni = { ...gni, source: "UNDP HDR" };
  }
}

function latestYearValue(row, prefixes) {
  let best = null;
  for (const [key, raw] of Object.entries(row)) {
    const norm = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (norm.includes("rank")) continue;
    if (!prefixes.some((p) => norm.startsWith(p))) continue;
    const year = Number(norm.match(/(?:19|20)\d{2}/)?.[0]);
    const value = Number(String(raw).replace(/,/g, ""));
    if (!Number.isFinite(year) || !Number.isFinite(value)) continue;
    if (!best || year > best.year) best = { value: round(value), year };
  }
  return best;
}

function pick(row, keys) {
  for (const key of keys) {
    const want = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    const found = Object.keys(row).find((k) => k.toLowerCase().replace(/[^a-z0-9]/g, "") === want);
    if (found && row[found] !== "") return String(row[found]).trim();
  }
  return null;
}

async function fetchJson(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`${url} HTTP ${resp.status}`);
  return resp.json();
}

async function fetchText(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`${url} HTTP ${resp.status}`);
  return resp.text();
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (ch !== "\r") {
      field += ch;
    }
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  const header = rows.shift()?.map((h) => h.trim()) ?? [];
  return rows
    .filter((r) => r.some((v) => v !== ""))
    .map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]?.trim() ?? ""])));
}

function round(value) {
  return Math.round(Number(value) * 1000) / 1000;
}

function sourceLabel(sources) {
  const names = [...new Set(sources.map((s) => s.name))];
  if (names.length === 0) return "bundled legacy country statistics";
  return names.join(" + ");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
