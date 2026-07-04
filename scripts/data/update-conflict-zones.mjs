// Generates data/conflict-events.latest.json: georeferenced armed-conflict
// events from the trailing twelve months, for the heatmap's "Active conflict
// zones" mode. Events come from the UCDP candidate GED monthly CSV releases
// (Uppsala Conflict Data Program), which are published openly about a month
// behind real time; each event carries coordinates, a best-estimate death
// toll, the dyad (parties) and the country. Events are stored as compact
// rows against string tables to keep the artifact small; the runtime
// aggregates them into grid cells for rendering.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OUT_FILE = path.join(ROOT, "data/conflict-events.latest.json");

const CANDIDATE_URL = (yy, m) =>
  `https://ucdp.uu.se/downloads/candidateged/GEDEvent_v${yy}_0_${m}.csv`;
const UCDP_HOME = "https://ucdp.uu.se/downloads/candidateged/";
const WINDOW_MONTHS = 12;
// candidate releases lag ~1 month; look a little further back so the window
// is fully covered even right after a month boundary
const LOOKBACK_MONTHS = 15;
const TYPE_LABELS = { 1: "state-based", 2: "non-state", 3: "one-sided" };

async function main() {
  const now = new Date();
  const months = [];
  for (let i = 0; i < LOOKBACK_MONTHS; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    months.push({ yy: d.getUTCFullYear() % 100, m: d.getUTCMonth() + 1 });
  }

  const warnings = [];
  const byId = new Map(); // newest release wins on duplicate event ids
  const fetched = [];
  for (const { yy, m } of [...months].reverse()) {
    const url = CANDIDATE_URL(yy, m);
    try {
      const rows = parseCsv(await fetchText(url));
      for (const row of rows) {
        const ev = parseEvent(row);
        if (ev) byId.set(ev.id, ev);
      }
      fetched.push(`${2000 + yy}-${String(m).padStart(2, "0")}`);
    } catch (e) {
      // recent months may simply not be released yet
      warnings.push(`candidate release ${yy}.0.${m} unavailable: ${e.message}`);
    }
  }
  if (fetched.length === 0) throw new Error("no UCDP candidate GED releases could be fetched");

  // trailing window: last WINDOW_MONTHS full months up to today
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (WINDOW_MONTHS - 1), 1));
  const startYm = ym(start);
  const events = [...byId.values()]
    .filter((ev) => ev.ym >= startYm)
    .sort((a, b) => (a.ym < b.ym ? -1 : a.ym > b.ym ? 1 : 0));

  const monthTable = [];
  const countryTable = [];
  const dyadTable = [];
  const monthIdx = new Map();
  const countryIdx = new Map();
  const dyadIdx = new Map();
  const intern = (table, idx, v) => {
    if (!idx.has(v)) { idx.set(v, table.length); table.push(v); }
    return idx.get(v);
  };

  let deaths = 0;
  const rows = events.map((ev) => {
    deaths += ev.best;
    return [
      ev.lat, ev.lon, ev.best,
      intern(monthTable, monthIdx, ev.ym),
      intern(countryTable, countryIdx, ev.country),
      intern(dyadTable, dyadIdx, ev.dyad),
      ev.type,
    ];
  });

  const out = {
    schemaVersion: 1,
    meta: {
      generatedAt: new Date().toISOString(),
      sourceLabel: "UCDP candidate GED (monthly releases)",
      sources: [{
        name: "UCDP Candidate Georeferenced Event Dataset",
        url: UCDP_HOME,
        note: "Uppsala Conflict Data Program; preliminary monthly event data, free for academic and non-commercial use",
      }],
      period: { start: startYm, end: monthTable[monthTable.length - 1] ?? startYm },
      releases: fetched,
      counts: {
        events: rows.length,
        deaths,
        countries: countryTable.length,
        dyads: dyadTable.length,
      },
      warnings,
      notes: [
        "columns per event row: [lat, lon, bestDeaths, monthIdx, countryIdx, dyadIdx, typeOfViolence]",
        "typeOfViolence: 1 state-based, 2 non-state, 3 one-sided (UCDP definitions)",
        "bestDeaths is UCDP's best estimate of fatalities for the event; zero-fatality clashes are retained",
        "candidate GED is preliminary data and is revised in later annual GED releases",
      ],
    },
    columns: ["lat", "lon", "deaths", "monthIdx", "countryIdx", "dyadIdx", "type"],
    months: monthTable,
    countries: countryTable,
    dyads: dyadTable,
    typeLabels: TYPE_LABELS,
    events: rows,
  };

  await mkdir(path.dirname(OUT_FILE), { recursive: true });
  await writeFile(OUT_FILE, `${JSON.stringify(out)}\n`, "utf8");
  console.log(
    `Wrote ${path.relative(ROOT, OUT_FILE)} — ${rows.length} events, ${deaths.toLocaleString()} deaths, ` +
    `${countryTable.length} countries, ${startYm} → ${out.meta.period.end}`
  );
  for (const w of warnings) console.warn(`[warn] ${w}`);
}

function parseEvent(row) {
  const id = Number(row.id);
  const lat = Number(row.latitude);
  const lon = Number(row.longitude);
  const best = Number(row.best);
  const date = row.date_start ?? "";
  const type = Number(row.type_of_violence);
  if (!Number.isFinite(id) || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  if (!/^\d{4}-\d{2}/.test(date)) return null;
  return {
    id,
    lat: Math.round(lat * 1000) / 1000,
    lon: Math.round(lon * 1000) / 1000,
    best: Number.isFinite(best) && best > 0 ? Math.round(best) : 0,
    ym: date.slice(0, 7),
    country: row.country || "Unknown",
    dyad: row.dyad_name || row.conflict_name || "Unknown parties",
    type: TYPE_LABELS[type] ? type : 1,
  };
}

function ym(d) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

async function fetchText(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.text();
}

// minimal CSV parser handling quoted fields with embedded commas/newlines
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

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
