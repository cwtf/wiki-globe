// Shared read access to the bundled per-country World Bank / UNDP indicators.
//
// Live-first, same as the heatmap layer: try the generated
// data/country-stats.latest.json (World Bank Indicators API + OWID + UNDP),
// and fall back to the hand-maintained legacy snapshot in country-data.js.
// The agent's country_stats tool and (potentially) other callers use this so
// the "is it live or bundled?" distinction stays honest per the LIVE/DATA
// badge convention.

import { COUNTRY_STATS } from "./country-data.js";

const COUNTRY_STATS_URL = "data/country-stats.latest.json";
const LOAD_TIMEOUT_MS = 12000;

// Queryable indicator fields with display metadata. Live data covers all of
// these; the bundled legacy snapshot only carries the first block (name +
// gdpNominal/gdpPpp/hdi/ihdi/gni), so on the fallback path other indicators
// resolve to null and the tool reports no_data for them — which is truthful.
export const STAT_INDICATORS = {
  gdpNominal: { label: "GDP per capita (nominal, current US$)", unit: "current US$ per person" },
  gdpPpp: { label: "GDP per capita (PPP)", unit: "international $ per person" },
  gni: { label: "GNI per capita (PPP)", unit: "international $ per person" },
  hdi: { label: "Human Development Index", unit: "index 0-1" },
  ihdi: { label: "Inequality-adjusted HDI", unit: "index 0-1" },
  lifeExpectancy: { label: "Life expectancy at birth", unit: "years" },
  infantMortality: { label: "Infant mortality rate", unit: "deaths per 1,000 live births" },
  fertility: { label: "Fertility rate", unit: "births per woman" },
  popDensity: { label: "Population density", unit: "people per km²" },
  popGrowth: { label: "Population growth", unit: "annual %" },
  urbanShare: { label: "Urban population", unit: "% of population" },
  internetUsers: { label: "Internet users", unit: "% of population" },
  electricityAccess: { label: "Access to electricity", unit: "% of population" },
  cleanWater: { label: "Basic drinking water access", unit: "% of population" },
  gini: { label: "Gini index", unit: "index" },
  poverty: { label: "Poverty headcount ($2.15/day)", unit: "% of population" },
  co2PerCapita: { label: "CO₂ emissions per capita", unit: "tonnes per person" },
};

// World Bank income groups are officially defined by GNI per capita, Atlas
// method (current US$). Wiki Globe's bundled data does not carry the Atlas GNI
// figure, so the classification uses GDP per capita (current US$) as the
// closest available proxy. This is disclosed in the tool result rather than
// presented as the authoritative World Bank list.
export const WORLD_BANK_INCOME_BANDS = {
  asOf: "World Bank FY2025 thresholds (2023 GNI, Atlas method)",
  officialBasis: "GNI per capita, Atlas method (current US$)",
  proxyBasis: "GDP per capita (current US$, World Bank NY.GDP.PCAP.CD)",
  disclaimer:
    "World Bank income groups are officially defined by GNI per capita (Atlas method). " +
    "Wiki Globe has no Atlas GNI figure bundled, so this classification uses GDP per capita " +
    "(current US$) as a proxy; countries near a boundary may differ from the official list.",
  bands: [
    { key: "low", label: "Low income", max: 1145 },
    { key: "lower_middle", label: "Lower-middle income", max: 4515 },
    { key: "upper_middle", label: "Upper-middle income", max: 14005 },
    { key: "high", label: "High income", max: Infinity },
  ],
};

let liveCache = null;

// Returns { countries, fields, sourceLabel, generatedAt, live }.
// Only a successful live load is cached, so a transient offline first call does
// not lock the whole session onto the bundled snapshot.
export async function loadCountryStats() {
  if (liveCache) return liveCache;
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(new DOMException("country stats load timed out", "TimeoutError")), LOAD_TIMEOUT_MS);
    let data;
    try {
      const resp = await fetch(COUNTRY_STATS_URL, { signal: ctl.signal });
      if (!resp.ok) throw new Error(`country stats HTTP ${resp.status}`);
      data = await resp.json();
    } finally {
      clearTimeout(timer);
    }
    if (data?.countries && typeof data.countries === "object") {
      liveCache = {
        countries: data.countries,
        fields: data.fields ?? null,
        sourceLabel: data.meta?.sourceLabel ?? "generated country statistics",
        generatedAt: data.meta?.generatedAt ?? null,
        live: true,
      };
      return liveCache;
    }
  } catch (e) {
    console.warn("[country-stats] generated stats unavailable, using bundled fallback:", e.message);
  }
  return {
    countries: legacyCountryStats(),
    fields: null,
    sourceLabel: "Bundled legacy snapshot (IMF/UNDP, approximate)",
    generatedAt: null,
    live: false,
  };
}

export function statValue(stat) {
  return stat && typeof stat === "object" ? stat.value ?? null : stat ?? null;
}

export function statYear(stat) {
  return stat && typeof stat === "object" ? stat.year ?? null : null;
}

// Classify a GDP-per-capita (current US$) value into a World Bank income band
// key, or null when the value is missing.
export function classifyIncome(gdpPerCapita) {
  if (!Number.isFinite(gdpPerCapita)) return null;
  for (const band of WORLD_BANK_INCOME_BANDS.bands) {
    if (gdpPerCapita <= band.max) return band.key;
  }
  return "high";
}

export function incomeBandLabel(key) {
  return WORLD_BANK_INCOME_BANDS.bands.find((b) => b.key === key)?.label ?? null;
}

// Map loose user/model phrasing ("upper middle", "UMIC", "upper-middle-income")
// to a canonical band key, or null if unrecognized.
export function normalizeIncomeGroup(group) {
  const s = String(group ?? "").toLowerCase().replace(/[^a-z]/g, "");
  if (!s) return null;
  if (s === "umic" || (s.includes("upper") && s.includes("mid")) || s === "upper" || s === "uppermiddle") return "upper_middle";
  if (s === "lmic" || (s.includes("lower") && s.includes("mid")) || s === "lower" || s === "lowermiddle") return "lower_middle";
  if (s === "hic" || s.includes("high")) return "high";
  if (s === "lic" || s === "low" || s === "lowincome") return "low";
  return null;
}

// Same normalization the heatmap layer applies to the bundled legacy array so
// both code paths present the identical { name, gdpNominal:{value,...}, ... }
// shape.
function legacyCountryStats() {
  const keys = ["name", "gdpNominal", "gdpPpp", "hdi", "ihdi", "gni"];
  const out = {};
  for (const [iso3, row] of Object.entries(COUNTRY_STATS)) {
    out[iso3] = { name: row[0] };
    for (let i = 1; i < keys.length; i++) {
      out[iso3][keys[i]] = { value: row[i], source: "Bundled legacy snapshot" };
    }
  }
  return out;
}
