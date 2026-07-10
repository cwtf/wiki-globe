// Heat-map overlay layer: one dropdown-selected metric at a time.
// Weather metrics (wet-bulb temperature / air temperature / relative
// humidity) come from Open-Meteo hourly data on an adjustable sample grid
// with a scrubbable past-days timeline; the wet-bulb value is derived via
// Stull's 2011 approximation (~35 °C sustained is the theoretical limit of
// human survivability). Country metrics (economy, development, access,
// inequality, air/climate, and energy indicators) are drawn as a choropleth
// from public-domain country polygons coloured by generated country stats.
// Region metrics (population
// density, fertility) colour generated admin-1 polygons where data exists
// and fall back to the country-level statistic elsewhere. The conflict
// metric aggregates generated UCDP event points into half-degree cells, while
// skyscraper density aggregates city counts from Wikidata Q1575895, supplemented
// by grouped Q11303 records for unlisted cities, into half-degree cells.
// Either way the overlay renders to an equirectangular canvas draped over
// the globe as a single-tile imagery layer, and valueAt() serves the
// cursor tooltip.
// Open-Meteo chunks are fetched sequentially with one retry: firing them in
// parallel can trip the per-minute rate limit; hourly/daily quota errors
// abort the load, back off, and fall back to the localStorage cache.

import { COUNTRY_STATS } from "../country-data.js";
import { loadCountryGeo, countryAt } from "../country-geo.js";

const LAT_MIN = -60;
const LAT_MAX = 80;
export const RES_STEPS = [20, 15, 10, 7.5]; // degrees, coarse → fine
const DEFAULT_STEP = 10;
const PAST_DAYS = 3;                  // hourly history window for the timeline
const REFRESH_MS = 20 * 60 * 1000;    // Open-Meteo models update ~hourly
const RETRY_MS = 90 * 1000;           // re-attempt after failed/partial loads
const QUOTA_COOLDOWN_MS = 15 * 60 * 1000; // back-off after hourly/daily 429
const CHUNK = 60;                     // locations per batched API request
const CACHE_KEY = "wetbulb-cache-v1"; // last good dataset, for rate-limited sessions
const AQ_CACHE_KEY = "aq-cache-v1";   // separate cache for air-quality data
const FLOOD_CACHE_KEY = "flood-cache-v1"; // separate cache for flood data
const CLIMATE_CACHE_KEY = "climate-cache-v1"; // separate cache for climate projection data
const CACHE_MAX_AGE_MS = 24 * 3600 * 1000;
const CANVAS_W = 720;                 // 0.5°/px weather overlay
const CANVAS_H = 360;
const COUNTRY_W = 1440;               // 0.25°/px choropleth (crisper borders)
const COUNTRY_H = 720;
const OVERLAY_ALPHA = 160;            // 0-255 baked into the overlay pixels
const EDGE_FADE_DEG = 7.5;            // fade to transparent at grid edges
const NO_DATA_FILL = "rgba(125, 135, 150, 0.16)";
const COUNTRY_STATS_URL = "data/country-stats.latest.json";
const HEATMAP_METRICS_URL = "data/heatmap-metrics.json";
const ADMIN1_URL = "data/admin1-population.latest.geojson";
const CONFLICT_URL = "data/conflict-events.latest.json";
const SKYSCRAPER_URL = "data/skyscraper-density.latest.json";
const CONFLICT_CELL_DEG = 0.5;        // aggregation cell for events (~55 km)

const TIME_FMT = new Intl.DateTimeFormat("en", {
  month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  hour12: false, timeZone: "UTC",
});

const money = (x) => `$${Math.round(x).toLocaleString("en-US")}`;
const degC = (x) => `${x.toFixed(1)} °C`;
const percent1 = (x) => `${x.toFixed(Math.abs(x) >= 10 ? 0 : 1)}%`;
const years = (x) => `${x.toFixed(1)} years`;
const per1000 = (x) => `${x.toFixed(x >= 10 ? 0 : 1)}/1k`;
const tonnes = (x) => `${x.toFixed(x >= 10 ? 0 : 1)} t`;
const kgOil = (x) => `${Math.round(x).toLocaleString("en-US")} kg`;
const micrograms = (x) => `${x.toFixed(x >= 10 ? 0 : 1)} µg/m³`;
const millimetres = (x) => `${Math.round(x).toLocaleString("en-US")} mm`;
const towerDensity = (x) => `${x.toFixed(x >= 10 ? 0 : 1)}/10k km2`;
const perKm2 = (x) =>
  `${x >= 100 ? Math.round(x).toLocaleString("en-US") : x.toFixed(x >= 10 ? 0 : 1)}/km²`;

// Fallback metric definitions. loadHeatmapMetrics() replaces these from
// data/heatmap-metrics.json during app boot.
// stops: [value, [r,g,b]] colour ramp (piecewise-linear);
// legend: evenly spaced [label, css] ticks for the panel gradient bar.
// Weather metrics read interpolated grid samples via value(); country
// metrics index generated country-stat rows via statKey.
export const METRICS = {
  wetbulb: {
    label: "Wet-bulb temp", kind: "weather",
    value: (v) => v.tw, fmt: degC,
    stops: [
      [-20, [122, 165, 255]], [0, [79, 195, 247]], [10, [63, 217, 143]],
      [18, [168, 221, 78]], [24, [250, 204, 21]], [28, [251, 146, 60]],
      [31, [239, 68, 68]], [35, [217, 70, 239]],
    ],
    legend: [
      ["0°", "#4fc3f7"], ["15°", "#43d98c"], ["24°", "#facc15"],
      ["28°", "#fb923c"], ["31°", "#ef4444"], ["35°C", "#d946ef"],
    ],
  },
  temp: {
    label: "Temperature", kind: "weather",
    value: (v) => v.t, fmt: degC,
    stops: [
      [-40, [110, 90, 220]], [-20, [122, 165, 255]], [0, [79, 195, 247]],
      [12, [63, 217, 143]], [22, [250, 204, 21]], [32, [251, 146, 60]],
      [40, [239, 68, 68]], [48, [217, 70, 239]],
    ],
    legend: [
      ["-40°", "#6e5adc"], ["-20°", "#7aa5ff"], ["0°", "#4fc3f7"],
      ["12°", "#3fd98f"], ["22°", "#facc15"], ["32°", "#fb923c"], ["48°C", "#ef4444"],
    ],
  },
  humidity: {
    label: "Humidity", kind: "weather",
    value: (v) => v.rh, fmt: (x) => `${Math.round(x)}%`,
    stops: [
      [0, [217, 119, 6]], [25, [250, 204, 21]], [50, [63, 217, 143]],
      [75, [79, 195, 247]], [100, [74, 125, 255]],
    ],
    legend: [
      ["0%", "#d97706"], ["25%", "#facc15"], ["50%", "#3fd98f"],
      ["75%", "#4fc3f7"], ["100%", "#4a7dff"],
    ],
  },
  pm25: {
    label: "PM2.5", kind: "weather", dataSource: "airquality",
    value: (v) => v.pm25, fmt: micrograms,
    stops: [
      [0, [63, 217, 143]], [12, [250, 204, 21]], [35, [251, 146, 60]],
      [55, [239, 68, 68]], [150, [168, 85, 247]], [250, [136, 19, 55]],
    ],
    legend: [
      ["0", "#3fd98f"], ["12", "#facc15"], ["35", "#fb923c"],
      ["55", "#ef4444"], ["150", "#a855f7"], ["250+", "#881337"],
    ],
  },
  aqi: {
    label: "Air quality (US AQI)", kind: "weather", dataSource: "airquality",
    value: (v) => v.aqi, fmt: (x) => `${Math.round(x)} AQI`,
    stops: [
      [0, [63, 217, 143]], [50, [250, 204, 21]], [100, [251, 146, 60]],
      [150, [239, 68, 68]], [200, [168, 85, 247]], [300, [136, 19, 55]],
    ],
    legend: [
      ["0", "#3fd98f"], ["50", "#facc15"], ["100", "#fb923c"],
      ["150", "#ef4444"], ["200", "#a855f7"], ["300+", "#881337"],
    ],
  },
  riverDischarge: {
    label: "River discharge", kind: "weather", dataSource: "flood",
    value: (v) => v.discharge, fmt: (x) => `${x.toFixed(x >= 100 ? 0 : 1)} m³/s`,
    stops: [
      [0, [63, 217, 143]], [10, [79, 195, 247]], [100, [74, 125, 255]],
      [500, [168, 85, 247]], [2000, [239, 68, 68]], [10000, [136, 19, 55]],
    ],
    legend: [
      ["0", "#3fd98f"], ["10", "#4fc3f7"], ["100", "#4a7dff"],
      ["500", "#a855f7"], ["2k", "#ef4444"], ["10k+", "#881337"],
    ],
  },
  temp2050: {
    label: "Temp 2050 (projection)", kind: "weather", dataSource: "climate",
    value: (v) => v.tempMax, fmt: degC,
    stops: [
      [-40, [110, 90, 220]], [-20, [122, 165, 255]], [0, [79, 195, 247]],
      [12, [63, 217, 143]], [22, [250, 204, 21]], [32, [251, 146, 60]],
      [40, [239, 68, 68]], [48, [217, 70, 239]],
    ],
    legend: [
      ["-40°", "#6e5adc"], ["-20°", "#7aa5ff"], ["0°", "#4fc3f7"],
      ["12°", "#3fd98f"], ["22°", "#facc15"], ["32°", "#fb923c"], ["48°C", "#ef4444"],
    ],
  },
  aurora: {
    label: "Aurora oval", kind: "aurora",
    value: (v) => v.probability, fmt: (x) => `${Math.round(x)}% chance`,
    stops: [
      [0, [63, 255, 143]], [10, [63, 255, 143]], [25, [100, 255, 180]],
      [50, [130, 255, 220]], [75, [180, 255, 240]], [100, [220, 255, 250]],
    ],
    legend: [
      ["0%", "#3fff8f"], ["25%", "#64ffb4"], ["50%", "#82ffdc"],
      ["75%", "#b4fff0"], ["100%", "#dcfffa"],
    ],
  },
  gdpNominal: {
    label: "GDP per capita (nominal)", kind: "country",
    statKey: "gdpNominal", fmt: money,
    stops: [
      [500, [239, 68, 68]], [2000, [251, 146, 60]], [6000, [250, 204, 21]],
      [15000, [168, 221, 78]], [40000, [63, 217, 143]], [90000, [79, 195, 247]],
    ],
    legend: [
      ["$500", "#ef4444"], ["$2k", "#fb923c"], ["$6k", "#facc15"],
      ["$15k", "#a8dd4e"], ["$40k", "#3fd98f"], ["$90k+", "#4fc3f7"],
    ],
  },
  gdpPpp: {
    label: "GDP per capita (PPP)", kind: "country",
    statKey: "gdpPpp", fmt: money,
    stops: [
      [1000, [239, 68, 68]], [4000, [251, 146, 60]], [12000, [250, 204, 21]],
      [25000, [168, 221, 78]], [60000, [63, 217, 143]], [120000, [79, 195, 247]],
    ],
    legend: [
      ["$1k", "#ef4444"], ["$4k", "#fb923c"], ["$12k", "#facc15"],
      ["$25k", "#a8dd4e"], ["$60k", "#3fd98f"], ["$120k+", "#4fc3f7"],
    ],
  },
  hdi: {
    label: "HDI", kind: "country",
    statKey: "hdi", fmt: (x) => x.toFixed(3),
    stops: [
      [0.40, [239, 68, 68]], [0.55, [251, 146, 60]], [0.70, [250, 204, 21]],
      [0.80, [168, 221, 78]], [0.90, [63, 217, 143]], [0.97, [79, 195, 247]],
    ],
    legend: [
      ["0.40", "#ef4444"], ["0.55", "#fb923c"], ["0.70", "#facc15"],
      ["0.80", "#a8dd4e"], ["0.90", "#3fd98f"], ["0.97", "#4fc3f7"],
    ],
  },
  ihdi: {
    label: "IHDI", kind: "country",
    statKey: "ihdi", fmt: (x) => x.toFixed(3),
    stops: [
      [0.25, [239, 68, 68]], [0.40, [251, 146, 60]], [0.55, [250, 204, 21]],
      [0.68, [168, 221, 78]], [0.80, [63, 217, 143]], [0.92, [79, 195, 247]],
    ],
    legend: [
      ["0.25", "#ef4444"], ["0.40", "#fb923c"], ["0.55", "#facc15"],
      ["0.68", "#a8dd4e"], ["0.80", "#3fd98f"], ["0.92", "#4fc3f7"],
    ],
  },
  gni: {
    label: "GNI per capita (PPP)", kind: "country",
    statKey: "gni", fmt: money,
    stops: [
      [800, [239, 68, 68]], [3000, [251, 146, 60]], [9000, [250, 204, 21]],
      [22000, [168, 221, 78]], [50000, [63, 217, 143]], [100000, [79, 195, 247]],
    ],
    legend: [
      ["$800", "#ef4444"], ["$3k", "#fb923c"], ["$9k", "#facc15"],
      ["$22k", "#a8dd4e"], ["$50k", "#3fd98f"], ["$100k+", "#4fc3f7"],
    ],
  },
  imfGdpGrowth: {
    label: "GDP growth (IMF)", kind: "country",
    statKey: "imfGdpGrowth", fmt: percent1,
    stops: [
      [-10, [217, 70, 239]], [-3, [239, 68, 68]], [0, [251, 146, 60]],
      [3, [250, 204, 21]], [6, [168, 221, 78]], [10, [63, 217, 143]], [20, [79, 195, 247]],
    ],
    legend: [
      ["-10%", "#d946ef"], ["-3%", "#ef4444"], ["0%", "#fb923c"],
      ["3%", "#facc15"], ["6%", "#a8dd4e"], ["10%+", "#3fd98f"],
    ],
  },
  imfInflation: {
    label: "Inflation (IMF)", kind: "country",
    statKey: "imfInflation", fmt: percent1,
    stops: [
      [0, [79, 195, 247]], [3, [63, 217, 143]], [6, [168, 221, 78]],
      [10, [250, 204, 21]], [20, [251, 146, 60]], [50, [239, 68, 68]], [200, [217, 70, 239]],
    ],
    legend: [
      ["0%", "#4fc3f7"], ["3%", "#3fd98f"], ["6%", "#a8dd4e"],
      ["10%", "#facc15"], ["20%", "#fb923c"], ["50%+", "#ef4444"],
    ],
  },
  imfUnemployment: {
    label: "Unemployment (IMF)", kind: "country",
    statKey: "imfUnemployment", fmt: percent1,
    stops: [
      [2, [63, 217, 143]], [5, [168, 221, 78]], [8, [250, 204, 21]],
      [12, [251, 146, 60]], [20, [239, 68, 68]], [40, [217, 70, 239]],
    ],
    legend: [
      ["2%", "#3fd98f"], ["5%", "#a8dd4e"], ["8%", "#facc15"],
      ["12%", "#fb923c"], ["20%", "#ef4444"], ["40%+", "#d946ef"],
    ],
  },
  imfDebtGdp: {
    label: "Gov debt % GDP (IMF)", kind: "country",
    statKey: "imfDebtGdp", fmt: percent,
    stops: [
      [20, [63, 217, 143]], [50, [168, 221, 78]], [80, [250, 204, 21]],
      [120, [251, 146, 60]], [200, [239, 68, 68]], [300, [217, 70, 239]],
    ],
    legend: [
      ["20%", "#3fd98f"], ["50%", "#a8dd4e"], ["80%", "#facc15"],
      ["120%", "#fb923c"], ["200%", "#ef4444"], ["300%+", "#d946ef"],
    ],
  },
  owidLifeExpectancy: {
    label: "Life expectancy (OWID)", kind: "country",
    statKey: "owidLifeExpectancy", fmt: years,
    stops: [
      [50, [239, 68, 68]], [60, [251, 146, 60]], [70, [250, 204, 21]],
      [76, [168, 221, 78]], [82, [63, 217, 143]], [86, [79, 195, 247]],
    ],
    legend: [
      ["50", "#ef4444"], ["60", "#fb923c"], ["70", "#facc15"],
      ["76", "#a8dd4e"], ["82", "#3fd98f"], ["86+", "#4fc3f7"],
    ],
  },
  owidInternet: {
    label: "Internet users (OWID)", kind: "country",
    statKey: "owidInternet", fmt: percent,
    stops: [
      [5, [239, 68, 68]], [20, [251, 146, 60]], [40, [250, 204, 21]],
      [60, [168, 221, 78]], [80, [63, 217, 143]], [95, [79, 195, 247]],
    ],
    legend: [
      ["5%", "#ef4444"], ["20%", "#fb923c"], ["40%", "#facc15"],
      ["60%", "#a8dd4e"], ["80%", "#3fd98f"], ["95%+", "#4fc3f7"],
    ],
  },
  owidRenewableShare: {
    label: "Renewable energy (OWID)", kind: "country",
    statKey: "owidRenewableShare", fmt: percent,
    stops: [
      [0, [239, 68, 68]], [10, [251, 146, 60]], [25, [250, 204, 21]],
      [50, [168, 221, 78]], [75, [63, 217, 143]], [100, [79, 195, 247]],
    ],
    legend: [
      ["0%", "#ef4444"], ["10%", "#fb923c"], ["25%", "#facc15"],
      ["50%", "#a8dd4e"], ["75%", "#3fd98f"], ["100%", "#4fc3f7"],
    ],
  },
  owidHumanRights: {
    label: "Human rights (V-Dem)", kind: "country",
    statKey: "owidHumanRights", fmt: fixed3,
    stops: [
      [0.1, [239, 68, 68]], [0.3, [251, 146, 60]], [0.5, [250, 204, 21]],
      [0.7, [168, 221, 78]], [0.85, [63, 217, 143]], [0.95, [79, 195, 247]],
    ],
    legend: [
      ["0.1", "#ef4444"], ["0.3", "#fb923c"], ["0.5", "#facc15"],
      ["0.7", "#a8dd4e"], ["0.85", "#3fd98f"], ["0.95+", "#4fc3f7"],
    ],
  },
  whoLifeExpectancy: {
    label: "Life expectancy (WHO)", kind: "country",
    statKey: "whoLifeExpectancy", fmt: years,
    stops: [
      [50, [239, 68, 68]], [60, [251, 146, 60]], [70, [250, 204, 21]],
      [76, [168, 221, 78]], [82, [63, 217, 143]], [86, [79, 195, 247]],
    ],
    legend: [
      ["50", "#ef4444"], ["60", "#fb923c"], ["70", "#facc15"],
      ["76", "#a8dd4e"], ["82", "#3fd98f"], ["86+", "#4fc3f7"],
    ],
  },
  popDensity: {
    label: "Population density", kind: "region",
    statKey: "popDensity", regionKey: "density", regionYearKey: "popYear", fmt: perKm2,
    stops: [
      [1, [79, 195, 247]], [10, [63, 217, 143]], [50, [168, 221, 78]],
      [150, [250, 204, 21]], [500, [251, 146, 60]], [2000, [239, 68, 68]],
      [10000, [217, 70, 239]],
    ],
    legend: [
      ["1", "#4fc3f7"], ["10", "#3fd98f"], ["50", "#a8dd4e"],
      ["150", "#facc15"], ["500", "#fb923c"], ["2k", "#ef4444"], ["10k+", "#d946ef"],
    ],
  },
  fertility: {
    label: "Fertility rate", kind: "region",
    statKey: "fertility", regionKey: "fertility", regionYearKey: "fertilityYear",
    fmt: (x) => x.toFixed(2),
    stops: [
      [1, [79, 195, 247]], [1.5, [63, 217, 143]], [2.1, [168, 221, 78]],
      [3, [250, 204, 21]], [4.5, [251, 146, 60]], [6, [239, 68, 68]],
    ],
    legend: [
      ["1", "#4fc3f7"], ["1.5", "#3fd98f"], ["2.1", "#a8dd4e"],
      ["3", "#facc15"], ["4.5", "#fb923c"], ["6+", "#ef4444"],
    ],
  },
  conflicts: {
    label: "Conflict deaths", kind: "conflict",
    fmt: (x) => Math.round(x).toLocaleString("en-US"),
    stops: [
      [1, [250, 204, 21]], [10, [251, 146, 60]],
      [100, [239, 68, 68]], [1000, [217, 70, 239]],
    ],
    legend: [
      ["1", "#facc15"], ["10", "#fb923c"], ["100", "#ef4444"], ["1k+", "#d946ef"],
    ],
  },
  skyscraperDensity: {
    label: "Skyscraper density", kind: "skyscraper",
    fmt: towerDensity,
    stops: [
      [0.5, [79, 195, 247]], [2, [63, 217, 143]], [8, [168, 221, 78]],
      [25, [250, 204, 21]], [80, [251, 146, 60]], [250, [239, 68, 68]],
      [800, [217, 70, 239]],
    ],
    legend: [
      ["0.5", "#4fc3f7"], ["2", "#3fd98f"], ["8", "#a8dd4e"],
      ["25", "#facc15"], ["80", "#fb923c"], ["250", "#ef4444"], ["800+", "#d946ef"],
    ],
  },
};

const FORMATTERS = {
  money,
  degC,
  percent: (x) => `${Math.round(x)}%`,
  percent1,
  fixed2: (x) => x.toFixed(2),
  fixed3: (x) => x.toFixed(3),
  density: perKm2,
  integer: (x) => Math.round(x).toLocaleString("en-US"),
  years,
  per1000,
  tonnes,
  kgOil,
  micrograms,
  millimetres,
  towerDensity,
};

const VALUE_GETTERS = {
  tw: (v) => v.tw,
  t: (v) => v.t,
  rh: (v) => v.rh,
};

let metricsPromise = null;

export function loadHeatmapMetrics() {
  metricsPromise ??= fetch(HEATMAP_METRICS_URL)
    .then((resp) => {
      if (!resp.ok) throw new Error(`heatmap metrics ${resp.status}`);
      return resp.json();
    })
    .then((data) => {
      if (!data?.metrics || typeof data.metrics !== "object") {
        throw new Error("heatmap metrics payload missing metrics");
      }
      applyMetricConfig(data.metrics);
      return METRICS;
    })
    .catch((e) => {
      console.warn("[heatmap] generated metric config unavailable, using bundled fallback:", e.message);
      metricsPromise = null;
      return METRICS;
    });
  return metricsPromise;
}

function applyMetricConfig(config) {
  for (const key of Object.keys(METRICS)) delete METRICS[key];
  for (const [key, metric] of Object.entries(config)) {
    METRICS[key] = hydrateMetric(key, metric);
  }
}

function hydrateMetric(key, metric) {
  const fmt = FORMATTERS[metric.formatter];
  if (!fmt) throw new Error(`unknown formatter for metric ${key}: ${metric.formatter}`);
  const out = {
    label: metric.label,
    kind: metric.kind,
    fmt,
    stops: metric.stops,
    legend: metric.legend,
  };
  if (metric.kind === "weather") {
    const value = VALUE_GETTERS[metric.valueKey];
    if (!value) throw new Error(`unknown valueKey for metric ${key}: ${metric.valueKey}`);
    out.value = value;
  } else if (metric.kind === "country" || metric.kind === "region") {
    out.statKey = metric.statKey;
    if (metric.kind === "region") {
      out.regionKey = metric.regionKey;
      out.regionYearKey = metric.regionYearKey;
    }
  } else if (metric.kind !== "conflict" && metric.kind !== "skyscraper") {
    throw new Error(`unknown metric kind for ${key}: ${metric.kind}`);
  }
  return out;
}

export class HeatmapLayer {
  constructor(viewer) {
    this.viewer = viewer;
    this.layer = null;                // current overlay ImageryLayer
    this.mode = null;                 // METRICS key, or null = off
    this.step = DEFAULT_STEP;
    this._buildGrid();
    this.visible = false;
    this.loading = false;
    this.lastFetch = 0;
    this.okCount = 0;
    this.source = "loading";
    this.timer = null;
    this.times = [];                  // hourly timestamps (ms UTC) up to now
    this.timeIdx = -1;                // index into times currently displayed
    this.selTime = null;              // pinned timestamp; null = follow latest
    this.onDataChanged = null;        // app hook: timeline bounds changed
    this.geo = null;                  // country polygons (lazy)
    this.regions = null;              // admin-1 polygons + demographics (lazy)
    this.regionsMeta = null;
    this.conflict = null;             // aggregated UCDP event cells (lazy)
    this.conflictMeta = null;
    this.skyscrapers = null;          // aggregated city skyscraper-count cells (lazy)
    this.skyscrapersMeta = null;
    this.countryStats = legacyCountryStats();
    this.countryStatsMeta = {
      sourceLabel: "bundled IMF/UNDP 2022-23 estimates",
      fallback: true,
    };
    this._geoLoading = false;
    this._statsLoading = false;
    this._regionsLoading = false;
    this._conflictLoading = false;
    this._skyscrapersLoading = false;
    this._retryTimer = null;
    this._rebuildTimer = null;
    this._gen = 0;                    // overlay rebuild generation (latest wins)
    this._loadedSources = new Set();  // which data sources have been fetched
    this._sourceLastFetch = {};       // per-source last fetch timestamp
    this.aurora = null;               // NOAA SWPC aurora grid (lazy)
    this._auroraLoading = false;
  }

  get metric() {
    return this.mode ? METRICS[this.mode] : null;
  }

  get _weatherActive() {
    return this.metric?.kind === "weather";
  }

  get _dataSource() {
    return this.metric?.dataSource ?? "weather";
  }

  _buildGrid() {
    this.samples = [];
    this.cols = Math.round(360 / this.step);
    this.rows = 0;
    for (let lat = LAT_MIN; lat <= LAT_MAX + 1e-9; lat += this.step) {
      this.rows++;
      for (let c = 0; c < this.cols; c++) {
        this.samples.push({
          lat, lon: -180 + c * this.step,
          tw: null, t: null, rh: null,   // values at the displayed hour
          pm25: null, aqi: null,         // air quality at the displayed hour
          discharge: null,               // river discharge at the displayed day
          tempMax: null,                 // climate projection max temp
          tArr: null, rhArr: null,        // full hourly history (weather)
          pm25Arr: null, aqiArr: null,    // full hourly history (air quality)
          dischargeArr: null,             // full daily history (flood)
          tempMaxArr: null,               // full daily history (climate)
          probability: null,              // aurora probability at this cell
        });
      }
    }
    this.maxLat = LAT_MIN + (this.rows - 1) * this.step;
  }

  setMode(mode) {
    this.mode = METRICS[mode] ? mode : null;
    this.visible = this.mode !== null;
    if (this.layer) this.layer.show = this.visible;
    if (!this._weatherActive) {
      // no periodic refresh needed while off or showing country statistics
      if (this.timer) { clearInterval(this.timer); this.timer = null; }
      if (this._retryTimer) { clearTimeout(this._retryTimer); this._retryTimer = null; }
    }
    if (!this.mode) return;
    if (this._weatherActive) {
      const src = this._dataSource;
      const srcFresh = this._loadedSources.has(src) &&
        Date.now() - (this._sourceLastFetch[src] ?? 0) < REFRESH_MS;
      if (!srcFresh && (Date.now() - this.lastFetch > REFRESH_MS || !this._loadedSources.has(src)))
        this._load();
      this.timer ??= setInterval(() => this._load(), REFRESH_MS);
      if (this.okCount > 0) this._scheduleRebuild();
    } else if (this.metric.kind === "conflict") {
      if (this.conflict) this._scheduleRebuild();
      else this._loadConflict();
    } else if (this.metric.kind === "skyscraper") {
      if (this.skyscrapers) this._scheduleRebuild();
      else this._loadSkyscrapers();
    } else if (this.metric.kind === "aurora") {
      if (this.aurora) this._scheduleRebuild();
      else this._loadAurora();
    } else {
      // country/region choropleths; region modes also need admin-1 polygons
      const needCountry = !this.geo || this.countryStatsMeta.fallback;
      const needRegions = this.metric.kind === "region" && !this.regions;
      if (needCountry) this._loadCountryData();
      if (needRegions) this._loadRegions();
      if (!needCountry && !needRegions) this._scheduleRebuild();
    }
  }

  // step must be one of RES_STEPS (divides 360). Keeps the pinned timeline
  // position (selTime) so the view is restored after the refetch.
  setResolution(step) {
    if (step === this.step) return;
    this.step = step;
    this._buildGrid();
    this.okCount = 0;
    this.times = [];
    this.timeIdx = -1;
    this.lastFetch = 0;
    this.source = "loading";
    this._loadedSources = new Set();
    this._sourceLastFetch = {};
    if (this._weatherActive) this._load();
  }

  // i indexes this.times (0 = oldest, last = current hour)
  setTimeIndex(i) {
    if (this.times.length === 0) return;
    i = Math.max(0, Math.min(this.times.length - 1, Math.round(i)));
    this.timeIdx = i;
    this.selTime = i === this.times.length - 1 ? null : this.times[i];
    this._applyTimeIdx();
    if (this._weatherActive) this._scheduleRebuild();
  }

  timeLabel(i = this.timeIdx) {
    const last = this.times.length - 1;
    if (last < 0) return "now";
    // cached data can end hours ago — only call a fresh final hour "now"
    if (i >= last && Date.now() - this.times[last] < 90 * 60 * 1000) return "now";
    return `${TIME_FMT.format(new Date(this.times[Math.min(i, last)]))} UTC`;
  }

  _applyTimeIdx() {
    const i = this.timeIdx;
    for (const s of this.samples) {
      const t = s.tArr?.[i];
      const rh = s.rhArr?.[i];
      if (t == null || rh == null) { s.t = s.rh = s.tw = null; }
      else { s.t = t; s.rh = rh; s.tw = stullWetBulb(t, rh); }
      const pm = s.pm25Arr?.[i];
      const aq = s.aqiArr?.[i];
      s.pm25 = pm ?? null;
      s.aqi = aq ?? null;
      const dc = s.dischargeArr?.[i];
      s.discharge = dc ?? null;
      const tm = s.tempMaxArr?.[i];
      s.tempMax = tm ?? null;
    }
  }

  _scheduleRebuild() {
    // debounced: collapses slider scrubbing into one canvas/layer rebuild
    clearTimeout(this._rebuildTimer);
    this._rebuildTimer = setTimeout(() => this._rebuildOverlay(), 90);
  }

  // --- weather data ----------------------------------------------------------

  async _load() {
    if (!this._weatherActive) return;
    if (this.loading || Date.now() < (this.cooldownUntil ?? 0)) return;

    const src = this._dataSource;
    if (this._loadedSources.has(src) &&
        Date.now() - (this._sourceLastFetch[src] ?? 0) < REFRESH_MS) {
      this._applyTimeIdx();
      this._scheduleRebuild();
      return;
    }

    this.loading = true;
    clearTimeout(this._retryTimer);
    try {
      const chunks = [];
      for (let i = 0; i < this.samples.length; i += CHUNK) {
        chunks.push(this.samples.slice(i, i + CHUNK));
      }
      // Reset _rawTimes only when fetching a source for the first time;
      // if both sources share the same grid, times are identical.
      if (!this._loadedSources.has(src)) this._rawTimes = null;
      let failures = 0;
      let quotaHit = false;
      for (const chunk of chunks) {
        try {
          await this._fetchChunk(chunk, src);
        } catch (e) {
          if (isQuotaError(e)) { quotaHit = true; break; } // rest would 429 too
          // transient failure (or the per-minute limit) — retry once
          await sleep(1500);
          try {
            await this._fetchChunk(chunk, src);
          } catch (e2) {
            if (isQuotaError(e2)) { quotaHit = true; break; }
            failures++;
            console.warn("[heatmap] chunk failed:", e2.message);
          }
        }
      }
      const okField = { airquality: "pm25Arr", flood: "dischargeArr", climate: "tempMaxArr" }[src] ?? "tArr";
      this.okCount = this.samples.filter((s) => s[okField]).length;
      if (this.okCount > 0 && this._rawTimes) {
        this._finalize();
        this.source = quotaHit ? "limited" : "live";
        this.lastFetch = Date.now();
        this._loadedSources.add(src);
        this._sourceLastFetch[src] = this.lastFetch;
        if (!quotaHit && failures === 0 && this.okCount === this.samples.length) {
          this._saveCache(src);
        }
      } else if (this._restoreCache(src)) {
        this.okCount = this.samples.filter((s) => s[okField]).length;
        this._finalize();
        this.source = "cache";
      } else if (quotaHit) {
        this.source = "limited";
      }
      if (quotaHit) {
        console.warn("[heatmap] Open-Meteo request quota exceeded; backing off");
        this.cooldownUntil = Date.now() + QUOTA_COOLDOWN_MS;
      }
      if (failures > 0 || quotaHit || this.okCount === 0) {
        this._retryTimer = setTimeout(() => {
          if (this._weatherActive) { this.lastFetch = 0; this._load(); }
        }, quotaHit ? QUOTA_COOLDOWN_MS : RETRY_MS);
      }
    } finally {
      this.loading = false;
    }
  }

  // times/timeline bookkeeping shared by live loads and cache restores
  _finalize() {
    const now = Date.now();
    const isDaily = this._dataSource === "flood" || this._dataSource === "climate";
    this.times = this._rawTimes
      .map((t) => isDaily ? Date.parse(`${t}T00:00Z`) : Date.parse(`${t}:00Z`))
      .filter((t) => this._dataSource === "climate" || t <= now);
    this.timeIdx = this.selTime == null
      ? this.times.length - 1
      : nearestIndex(this.times, this.selTime);
    this._applyTimeIdx();
    this._rebuildOverlay();
    this.onDataChanged?.();
  }

  _saveCache(src = "weather") {
    const key = { airquality: AQ_CACHE_KEY, flood: FLOOD_CACHE_KEY, climate: CLIMATE_CACHE_KEY }[src] ?? CACHE_KEY;
    const payload = {
      v: 1,
      step: this.step,
      savedAt: Date.now(),
      rawTimes: this._rawTimes,
    };
    if (src === "airquality") {
      payload.pm25 = this.samples.map((s) => s.pm25Arr?.map(round1) ?? []);
      payload.aqi = this.samples.map((s) => s.aqiArr?.map(round1) ?? []);
    } else if (src === "flood") {
      payload.discharge = this.samples.map((s) => s.dischargeArr?.map(round1) ?? []);
    } else if (src === "climate") {
      payload.tempMax = this.samples.map((s) => s.tempMaxArr?.map(round1) ?? []);
    } else {
      payload.t = this.samples.map((s) => s.tArr?.map(round1) ?? []);
      payload.rh = this.samples.map((s) => s.rhArr?.map(round1) ?? []);
    }
    try { localStorage.setItem(key, JSON.stringify(payload)); }
    catch { /* storage full or unavailable — the cache is best-effort */ }
  }

  _restoreCache(src = "weather") {
    const key = { airquality: AQ_CACHE_KEY, flood: FLOOD_CACHE_KEY, climate: CLIMATE_CACHE_KEY }[src] ?? CACHE_KEY;
    try {
      const c = JSON.parse(localStorage.getItem(key) ?? "null");
      if (c?.v !== 1 || c.step !== this.step) return false;
      if (Date.now() - c.savedAt > CACHE_MAX_AGE_MS) return false;
      if (src === "airquality") {
        if (c.pm25?.length !== this.samples.length) return false;
        this.samples.forEach((s, i) => { s.pm25Arr = c.pm25[i]; s.aqiArr = c.aqi[i]; });
      } else if (src === "flood") {
        if (c.discharge?.length !== this.samples.length) return false;
        this.samples.forEach((s, i) => { s.dischargeArr = c.discharge[i]; });
      } else if (src === "climate") {
        if (c.tempMax?.length !== this.samples.length) return false;
        this.samples.forEach((s, i) => { s.tempMaxArr = c.tempMax[i]; });
      } else {
        if (c.t?.length !== this.samples.length || !c.rawTimes?.length) return false;
        this.samples.forEach((s, i) => { s.tArr = c.t[i]; s.rhArr = c.rh[i]; });
      }
      if (!this._rawTimes && c.rawTimes) this._rawTimes = c.rawTimes;
      return true;
    } catch {
      return false;
    }
  }

  async _fetchChunk(chunk, src = "weather") {
    const lats = chunk.map((s) => s.lat).join(",");
    const lons = chunk.map((s) => s.lon).join(",");
    let url;
    if (src === "airquality") {
      url = "https://air-quality-api.open-meteo.com/v1/air-quality" +
        `?latitude=${lats}&longitude=${lons}` +
        "&hourly=pm2_5,us_aqi" +
        `&past_days=${PAST_DAYS}&forecast_days=1&timezone=UTC`;
    } else if (src === "flood") {
      url = "https://flood-api.open-meteo.com/v1/flood" +
        `?latitude=${lats}&longitude=${lons}` +
        "&daily=river_discharge" +
        `&past_days=${PAST_DAYS}&forecast_days=7&timezone=UTC`;
    } else if (src === "climate") {
      url = "https://climate-api.open-meteo.com/v1/climate" +
        `?latitude=${lats}&longitude=${lons}` +
        "&daily=temperature_2m_max" +
        "&start_date=2050-01-01&end_date=2050-12-31" +
        "&models=MRI_AGCM3_2_S";
    } else {
      url = "https://api.open-meteo.com/v1/forecast" +
        `?latitude=${lats}&longitude=${lons}` +
        "&hourly=temperature_2m,relative_humidity_2m" +
        `&past_days=${PAST_DAYS}&forecast_days=1&timezone=UTC`;
    }
    const resp = await fetch(url);
    if (!resp.ok) {
      let reason = "";
      try { reason = (await resp.json()).reason ?? ""; } catch { /* not JSON */ }
      const err = new Error(`open-meteo ${resp.status}${reason ? ` — ${reason}` : ""}`);
      err.status = resp.status;
      err.reason = reason;
      throw err;
    }
    const data = await resp.json();
    const list = Array.isArray(data) ? data : [data];
    for (let i = 0; i < chunk.length && i < list.length; i++) {
      const s = chunk[i];
      if (src === "airquality") {
        const hh = list[i]?.hourly;
        if (!hh?.time) continue;
        if (hh.pm2_5) s.pm25Arr = hh.pm2_5;
        if (hh.us_aqi) s.aqiArr = hh.us_aqi;
        this._rawTimes ??= hh.time;
      } else if (src === "flood") {
        const dd = list[i]?.daily;
        if (!dd?.time) continue;
        if (dd.river_discharge) s.dischargeArr = dd.river_discharge;
        this._rawTimes ??= dd.time;
      } else if (src === "climate") {
        const dd = list[i]?.daily;
        if (!dd?.time) continue;
        if (dd.temperature_2m_max) s.tempMaxArr = dd.temperature_2m_max;
        this._rawTimes ??= dd.time;
      } else {
        const hh = list[i]?.hourly;
        if (!hh?.time || !hh.temperature_2m || !hh.relative_humidity_2m) continue;
        s.tArr = hh.temperature_2m;
        s.rhArr = hh.relative_humidity_2m;
        this._rawTimes ??= hh.time;
      }
    }
  }

  // --- country data ------------------------------------------------------------

  async _loadCountryData() {
    if (this._geoLoading || this._statsLoading) return;
    this._geoLoading = true;
    this._statsLoading = true;
    try {
      const [geo] = await Promise.all([
        loadCountryGeo(), // shared with search / true-size compare
        this._loadCountryStats(),
      ]);
      this.geo = geo;
      const kind = this.metric?.kind;
      if (kind === "country" || kind === "region") {
        this._rebuildOverlay();
        this.onDataChanged?.();
      }
    } catch (e) {
      console.warn("[heatmap] country data failed to load:", e.message);
      this.geo = null;
    } finally {
      this._geoLoading = false;
      this._statsLoading = false;
    }
  }

  async _loadCountryStats() {
    if (!this.countryStatsMeta.fallback) return;
    try {
      const resp = await fetch(COUNTRY_STATS_URL);
      if (!resp.ok) throw new Error(`country stats ${resp.status}`);
      const data = await resp.json();
      if (!data?.countries || typeof data.countries !== "object") {
        throw new Error("country stats payload missing countries");
      }
      this.countryStats = data.countries;
      this.countryStatsMeta = {
        sourceLabel: data.meta?.sourceLabel ?? "generated country statistics",
        generatedAt: data.meta?.generatedAt ?? data.generatedAt,
        fallback: false,
      };
    } catch (e) {
      console.warn("[heatmap] generated country stats unavailable, using bundled fallback:", e.message);
    }
  }

  _countryAt(lat, lon) {
    return countryAt(this.geo, lat, lon);
  }

  // --- admin-1 region data -------------------------------------------------------

  // Generated admin-1 polygons with population density (see
  // scripts/data/update-population-density.mjs). Parsed into the same
  // { rings, bbox } shape as country features so countryAt() can search them.
  async _loadRegions() {
    if (this._regionsLoading || this.regions) return;
    this._regionsLoading = true;
    try {
      const resp = await fetch(ADMIN1_URL);
      if (!resp.ok) throw new Error(`admin1 population ${resp.status}`);
      const gj = await resp.json();
      if (!Array.isArray(gj?.features)) throw new Error("admin1 payload missing features");
      this.regions = gj.features.map((f) => {
        const p = f.properties ?? {};
        const rings = (f.geometry?.type === "MultiPolygon" ? f.geometry.coordinates
          : f.geometry?.type === "Polygon" ? [f.geometry.coordinates] : []).flat();
        let w = 180, e = -180, s = 90, n = -90;
        for (const ring of rings) {
          for (const [lon, lat] of ring) {
            if (lon < w) w = lon;
            if (lon > e) e = lon;
            if (lat < s) s = lat;
            if (lat > n) n = lat;
          }
        }
        return {
          id: f.id, name: p.name ?? f.id, iso3: p.iso3,
          population: p.population, popYear: p.popYear,
          areaKm2: p.areaKm2, density: p.density,
          fertility: p.fertility, fertilityYear: p.fertilityYear,
          rings, bbox: [w, s, e, n],
        };
      });
      this.regionsMeta = {
        sourceLabel: gj.meta?.sourceLabel ?? "generated admin-1 population",
        generatedAt: gj.meta?.generatedAt,
      };
      if (this.metric?.kind === "region") {
        this._scheduleRebuild();
        this.onDataChanged?.();
      }
    } catch (e) {
      console.warn("[heatmap] admin-1 population unavailable, falling back to country level:", e.message);
      // still draw the country-level base coat
      if (this.metric?.kind === "region" && this.geo) this._scheduleRebuild();
    } finally {
      this._regionsLoading = false;
    }
  }

  // --- conflict data -------------------------------------------------------------

  // Generated UCDP event rows (see scripts/data/update-conflict-zones.mjs),
  // aggregated into half-degree cells: total deaths, event count, and the
  // single worst incident for the tooltip.
  async _loadConflict() {
    if (this._conflictLoading || this.conflict) return;
    this._conflictLoading = true;
    try {
      const resp = await fetch(CONFLICT_URL);
      if (!resp.ok) throw new Error(`conflict events ${resp.status}`);
      const data = await resp.json();
      if (!Array.isArray(data?.events)) throw new Error("conflict payload missing events");
      const cols = 360 / CONFLICT_CELL_DEG;
      const rows = 180 / CONFLICT_CELL_DEG;
      const cells = new Map();
      let deaths = 0;
      for (const [lat, lon, best, , ci, di] of data.events) {
        const cx = Math.min(cols - 1, Math.max(0, Math.floor((lon + 180) / CONFLICT_CELL_DEG)));
        const cy = Math.min(rows - 1, Math.max(0, Math.floor((90 - lat) / CONFLICT_CELL_DEG)));
        const key = cy * cols + cx;
        let cell = cells.get(key);
        if (!cell) {
          cell = { deaths: 0, events: 0, worst: -1, country: null, dyad: null, dyads: new Map() };
          cells.set(key, cell);
        }
        cell.deaths += best;
        cell.events++;
        const dyad = data.dyads[di];
        // rank dyads by deaths, breaking ties by event count
        cell.dyads.set(dyad, (cell.dyads.get(dyad) ?? 0) + best + 0.001);
        if (best > cell.worst) {
          cell.worst = best;
          cell.country = data.countries[ci];
          cell.dyad = dyad;
        }
        deaths += best;
      }
      for (const cell of cells.values()) {
        cell.topDyads = [...cell.dyads.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([dyad]) => dyad);
        delete cell.dyads;
      }
      this.conflict = { cells, totalEvents: data.events.length, totalDeaths: deaths };
      this.conflictMeta = {
        sourceLabel: data.meta?.sourceLabel ?? "generated conflict events",
        period: data.meta?.period ?? null,
      };
      if (this.metric?.kind === "conflict") {
        this._scheduleRebuild();
        this.onDataChanged?.();
      }
    } catch (e) {
      console.warn("[heatmap] conflict events unavailable:", e.message);
    } finally {
      this._conflictLoading = false;
    }
  }

  _conflictCellAt(lat, lon) {
    if (!this.conflict) return null;
    const cols = 360 / CONFLICT_CELL_DEG;
    const cx = Math.floor((lon + 180) / CONFLICT_CELL_DEG);
    const cy = Math.floor((90 - lat) / CONFLICT_CELL_DEG);
    return this.conflict.cells.get(cy * cols + cx) ?? null;
  }

  // Click-through lookup for the wiki panel: the cell under the cursor, or —
  // since the rendered squares have a visibility halo — the heaviest
  // immediately neighbouring cell. Returns null away from any conflict zone.
  conflictAt(lat, lon) {
    if (!this.conflict) return null;
    let cell = this._conflictCellAt(lat, lon);
    if (!cell) {
      const cols = 360 / CONFLICT_CELL_DEG;
      const rows = 180 / CONFLICT_CELL_DEG;
      const cx = Math.floor((lon + 180) / CONFLICT_CELL_DEG);
      const cy = Math.floor((90 - lat) / CONFLICT_CELL_DEG);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const y = cy + dy;
          if (y < 0 || y >= rows) continue;
          const n = this.conflict.cells.get(y * cols + (((cx + dx) % cols) + cols) % cols);
          if (n && (!cell || n.deaths > cell.deaths)) cell = n;
        }
      }
    }
    if (!cell) return null;
    return {
      deaths: cell.deaths,
      events: cell.events,
      country: cell.country,
      topDyads: cell.topDyads,
      period: this.conflictMeta?.period ?? null,
      source: this.conflictMeta?.sourceLabel ?? "conflict events",
    };
  }

  // --- skyscraper density --------------------------------------------------------

  // Generated from the city-count table linked by Wikidata Q1575895 (see
  // scripts/data/update-skyscraper-density.mjs), aggregated into grid cells as
  // skyscrapers per 10,000 km2. Each cell also carries its highest-count city.
  async _loadSkyscrapers() {
    if (this._skyscrapersLoading || this.skyscrapers) return;
    this._skyscrapersLoading = true;
    try {
      const resp = await fetch(SKYSCRAPER_URL);
      if (!resp.ok) throw new Error(`skyscraper density ${resp.status}`);
      const data = await resp.json();
      if (!Array.isArray(data?.cells)) throw new Error("skyscraper payload missing cells");
      const cellDeg = data.cellDeg ?? 0.5;
      const cols = Math.round(360 / cellDeg);
      const cells = new Map();
      let totalBuildings = 0;
      let densest = null;
      for (const row of data.cells) {
        const [x, y, count, density, cityIdx, countryIdx, rank, sourceFlag] = row;
        if (![x, y, count, density].every(Number.isFinite)) continue;
        const cell = {
          x, y, count, density, rank: rank ?? null,
          sourceKind: sourceFlag === 1 ? "q11303" : "q1575895",
          city: data.cities?.[cityIdx] ?? null,
          country: data.countries?.[countryIdx] ?? null,
        };
        cells.set(y * cols + x, cell);
        totalBuildings += count;
        if (!densest || cell.density > densest.density) densest = cell;
      }
      this.skyscrapers = { cells, cellDeg, cols, totalBuildings, densest };
      this.skyscrapersMeta = {
        sourceLabel: data.meta?.sourceLabel ?? "Q1575895 + Q11303 skyscraper city counts",
        generatedAt: data.meta?.generatedAt,
        minHeightM: data.minHeightM ?? 150,
      };
      if (this.metric?.kind === "skyscraper") {
        this._scheduleRebuild();
        this.onDataChanged?.();
      }
    } catch (e) {
      console.warn("[heatmap] skyscraper density unavailable:", e.message);
    } finally {
      this._skyscrapersLoading = false;
    }
  }

  // --- aurora data ---------------------------------------------------------------

  // NOAA SWPC ovation aurora forecast: a full-globe grid of aurora
  // probability (0–100) at ~1° resolution. We map it onto the existing
  // sample grid for bilinear interpolation and canvas rendering.
  async _loadAurora() {
    if (this._auroraLoading || this.aurora) return;
    this._auroraLoading = true;
    this.source = "loading";
    try {
      const resp = await fetch(
        "https://services.swpc.noaa.gov/json/ovation_aurora_latest.json"
      );
      if (!resp.ok) throw new Error(`NOAA SWPC ${resp.status}`);
      const data = await resp.json();
      if (!Array.isArray(data?.coordinates)) throw new Error("aurora payload missing coordinates");
      // Build a Map keyed by rounded lat,lon for fast lookup
      const grid = new Map();
      for (const [lon, lat, prob] of data.coordinates) {
        // NOAA uses lon 0–359 east; convert to -180…180
        const adjLon = lon > 180 ? lon - 360 : lon;
        grid.set(`${Math.round(lat)},${Math.round(adjLon)}`, prob);
      }
      // Populate sample grid by finding nearest NOAA point
      for (const s of this.samples) {
        const key = `${Math.round(s.lat)},${Math.round(s.lon)}`;
        s.probability = grid.get(key) ?? null;
      }
      this.aurora = { grid, totalPoints: data.coordinates.length };
      this.source = "live";
      this.okCount = this.samples.filter((s) => s.probability != null).length;
      this._scheduleRebuild();
      this.onDataChanged?.();
    } catch (e) {
      console.warn("[heatmap] aurora data unavailable:", e.message);
      this.source = "idle";
    } finally {
      this._auroraLoading = false;
    }
  }

  _skyscraperCellAt(lat, lon) {
    if (!this.skyscrapers) return null;
    const { cellDeg, cols, cells } = this.skyscrapers;
    const rows = Math.round(180 / cellDeg);
    lon = ((lon + 180) % 360 + 360) % 360;
    const x = Math.min(cols - 1, Math.max(0, Math.floor(lon / cellDeg)));
    const y = Math.min(rows - 1, Math.max(0, Math.floor((90 - lat) / cellDeg)));
    return cells.get(y * cols + x) ?? null;
  }

  // --- shared: tooltip lookup, canvas, overlay ------------------------------------

  // Weather modes: bilinear interpolation over the sample grid (longitude
  // wraps). Country modes: polygon lookup. Returns null where there is no
  // coverage under the cursor.
  valueAt(lat, lon) {
    const m = this.metric;
    if (!m) return null;
    if (m.kind === "conflict") {
      const cell = this._conflictCellAt(lat, lon);
      if (!cell) return null;
      return {
        kind: "conflict",
        metric: this.mode,
        value: cell.deaths,
        events: cell.events,
        country: cell.country,
        dyad: cell.dyad,
        period: this.conflictMeta?.period,
        source: this.conflictMeta?.sourceLabel ?? "conflict events",
      };
    }
    if (m.kind === "skyscraper") {
      const cell = this._skyscraperCellAt(lat, lon);
      if (!cell) return null;
      return {
        kind: "skyscraper",
        metric: this.mode,
        value: cell.density,
        count: cell.count,
        city: cell.city,
        country: cell.country,
        rank: cell.rank,
        sourceKind: cell.sourceKind,
        minHeightM: this.skyscrapersMeta?.minHeightM ?? 150,
        source: this.skyscrapersMeta?.sourceLabel ?? "Q1575895 + Q11303 skyscraper city counts",
      };
    }
    if (m.kind === "country" || m.kind === "region") {
      // region metrics: prefer the admin-1 polygon under the cursor when it
      // carries its own value, else fall back to the country statistic
      if (m.kind === "region") {
        const r = countryAt(this.regions, lat, lon);
        if (r?.[m.regionKey] != null) {
          return {
            kind: "region",
            metric: this.mode,
            name: r.name,
            country: this.countryStats[r.iso3]?.name ?? r.iso3 ?? "",
            value: r[m.regionKey],
            year: r[m.regionYearKey] ?? null,
            population: r.population,
            popYear: r.popYear,
            areaKm2: r.areaKm2,
            source: this.regionsMeta?.sourceLabel ?? "admin-1 demographics",
          };
        }
      }
      const f = this._countryAt(lat, lon);
      if (!f) return null;
      const stat = this.countryStats[f.id]?.[m.statKey] ?? null;
      return {
        kind: "country",
        metric: this.mode,
        name: f.name,
        value: statValue(stat),
        stat,
      };
    }
    if (lat < LAT_MIN || lat > this.maxLat) return null;
    lon = ((lon + 180) % 360 + 360) % 360 - 180;
    const fr = (lat - LAT_MIN) / this.step;
    const fc = (lon + 180) / this.step;
    const r0 = Math.min(Math.floor(fr), this.rows - 1);
    const r1 = Math.min(r0 + 1, this.rows - 1);
    const c0 = Math.floor(fc) % this.cols;
    const c1 = (c0 + 1) % this.cols;
    const tr = fr - Math.floor(fr);
    const tc = fc - Math.floor(fc);
    const corners = [
      [this.samples[r0 * this.cols + c0], (1 - tr) * (1 - tc)],
      [this.samples[r0 * this.cols + c1], (1 - tr) * tc],
      [this.samples[r1 * this.cols + c0], tr * (1 - tc)],
      [this.samples[r1 * this.cols + c1], tr * tc],
    ];
    if (m.kind === "aurora") {
      let prob = 0, w = 0;
      for (const [s, wt] of corners) {
        if (s.probability == null || wt === 0) continue;
        prob += s.probability * wt; w += wt;
      }
      if (w < 0.25) return null;
      return {
        kind: "weather", metric: this.mode,
        probability: prob / w,
        when: this.timeLabel(),
      };
    }
    let tw = 0, t = 0, rh = 0, pm25 = 0, aqi = 0, discharge = 0, tempMax = 0, w = 0;
    const src = this._dataSource;
    const checkField = { airquality: "pm25", flood: "discharge", climate: "tempMax" }[src] ?? "tw";
    for (const [s, wt] of corners) {
      if (s[checkField] == null || wt === 0) continue;
      if (s.tw != null) { tw += s.tw * wt; t += s.t * wt; rh += s.rh * wt; }
      if (s.pm25 != null) { pm25 += s.pm25 * wt; aqi += (s.aqi ?? 0) * wt; }
      if (s.discharge != null) discharge += s.discharge * wt;
      if (s.tempMax != null) tempMax += s.tempMax * wt;
      w += wt;
    }
    if (w < 0.25) return null; // mostly missing data around this point
    return {
      kind: "weather", metric: this.mode,
      tw: tw / w, t: t / w, rh: rh / w,
      pm25: pm25 / w, aqi: aqi / w,
      discharge: discharge / w, tempMax: tempMax / w,
      when: this.timeLabel(),
    };
  }

  _renderCanvas() {
    const kind = this.metric?.kind;
    if (kind === "conflict") return this._renderConflictCanvas();
    if (kind === "skyscraper") return this._renderSkyscraperCanvas();
    if (kind === "aurora") return this._renderWeatherCanvas();
    return kind === "country" || kind === "region"
      ? this._renderCountryCanvas()
      : this._renderWeatherCanvas();
  }

  _renderWeatherCanvas() {
    const m = this.metric;
    const canvas = document.createElement("canvas");
    canvas.width = CANVAS_W;
    canvas.height = CANVAS_H;
    const ctx = canvas.getContext("2d");
    const img = ctx.createImageData(CANVAS_W, CANVAS_H);
    const d = img.data;
    for (let y = 0; y < CANVAS_H; y++) {
      const lat = 90 - ((y + 0.5) * 180) / CANVAS_H;
      const fade = Math.min(
        1,
        Math.max(0, (lat - LAT_MIN) / EDGE_FADE_DEG),
        Math.max(0, (this.maxLat - lat) / EDGE_FADE_DEG)
      );
      if (fade === 0) continue;
      for (let x = 0; x < CANVAS_W; x++) {
        const lon = -180 + ((x + 0.5) * 360) / CANVAS_W;
        const v = this.valueAt(lat, lon);
        if (!v) continue;
        const val = m.value(v);
        if (val == null) continue;
        const [r, g, b] = colorFor(m.stops, val);
        const i = (y * CANVAS_W + x) * 4;
        d[i] = r; d[i + 1] = g; d[i + 2] = b;
        d[i + 3] = Math.round(OVERLAY_ALPHA * fade);
      }
    }
    ctx.putImageData(img, 0, 0);
    return canvas;
  }

  // Country choropleth; for region metrics the country fill is the fallback
  // base coat and admin-1 polygons with their own value are painted on top.
  _renderCountryCanvas() {
    const m = this.metric;
    const canvas = document.createElement("canvas");
    canvas.width = COUNTRY_W;
    canvas.height = COUNTRY_H;
    const ctx = canvas.getContext("2d");
    for (const f of this.geo ?? []) {
      const value = statValue(this.countryStats[f.id]?.[m.statKey]);
      fillFeature(ctx, f, value, m.stops);
    }
    if (m.kind === "region") {
      for (const r of this.regions ?? []) {
        if (r[m.regionKey] != null) fillFeature(ctx, r, r[m.regionKey], m.stops);
      }
    }
    return canvas;
  }

  // Conflict cells as small squares with a faint halo so isolated events
  // stay visible at globe scale; colour ramps on deaths in the cell.
  _renderConflictCanvas() {
    const m = this.metric;
    const canvas = document.createElement("canvas");
    canvas.width = COUNTRY_W;
    canvas.height = COUNTRY_H;
    const ctx = canvas.getContext("2d");
    if (!this.conflict) return canvas;
    const cols = 360 / CONFLICT_CELL_DEG;
    const px = COUNTRY_W / cols; // canvas pixels per cell (2 at 0.25°/px)
    for (const pass of [{ pad: 2, alpha: 0.22 }, { pad: 0, alpha: OVERLAY_ALPHA / 255 }]) {
      for (const [key, cell] of this.conflict.cells) {
        const cx = key % cols;
        const cy = Math.floor(key / cols);
        const [r, g, b] = colorFor(m.stops, Math.max(cell.deaths, 1));
        ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${pass.alpha})`;
        ctx.fillRect(cx * px - pass.pad, cy * px - pass.pad, px + 2 * pass.pad, px + 2 * pass.pad);
      }
    }
    return canvas;
  }

  // Skyscraper cells use the same visible-at-a-distance halo treatment as
  // conflict cells, but colour by city-count skyscrapers per 10,000 km2.
  _renderSkyscraperCanvas() {
    const m = this.metric;
    const canvas = document.createElement("canvas");
    canvas.width = COUNTRY_W;
    canvas.height = COUNTRY_H;
    const ctx = canvas.getContext("2d");
    if (!this.skyscrapers) return canvas;
    const px = (COUNTRY_W * this.skyscrapers.cellDeg) / 360;
    for (const pass of [{ pad: 2, alpha: 0.2 }, { pad: 0, alpha: OVERLAY_ALPHA / 255 }]) {
      for (const cell of this.skyscrapers.cells.values()) {
        const [r, g, b] = colorFor(m.stops, cell.density);
        ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${pass.alpha})`;
        ctx.fillRect(cell.x * px - pass.pad, cell.y * px - pass.pad, px + 2 * pass.pad, px + 2 * pass.pad);
      }
    }
    return canvas;
  }

  async _rebuildOverlay() {
    if (!this.mode) return;
    const gen = ++this._gen;
    const url = this._renderCanvas().toDataURL("image/png");
    const provider = await Cesium.SingleTileImageryProvider.fromUrl(url);
    if (gen !== this._gen) return; // superseded by a newer rebuild
    const layer = this.viewer.imageryLayers.addImageryProvider(provider);
    layer.show = this.visible;
    if (this.layer) this.viewer.imageryLayers.remove(this.layer);
    this.layer = layer;
  }

  counts() {
    if (!this.visible) return { count: 0, detail: "", source: this.source };
    const m = this.metric;
    if (m.kind === "conflict") {
      if (!this.conflict) {
        return { count: 0, detail: "loading conflict events…", source: "loading" };
      }
      const p = this.conflictMeta.period;
      return {
        count: this.conflict.totalEvents,
        detail: `${this.conflict.totalEvents.toLocaleString("en-US")} events · ` +
          `${this.conflict.totalDeaths.toLocaleString("en-US")} deaths` +
          `${p ? ` · ${p.start} → ${p.end}` : ""} · ${this.conflictMeta.sourceLabel}`,
        source: "data",
      };
    }
    if (m.kind === "skyscraper") {
      if (!this.skyscrapers) {
        return { count: 0, detail: "loading skyscraper density...", source: "loading" };
      }
      const d = this.skyscrapers.densest;
      const where = [d?.city, d?.country].filter(Boolean).join(", ");
      return {
        count: this.skyscrapers.totalBuildings,
        detail: `${this.skyscrapers.totalBuildings.toLocaleString("en-US")} skyscrapers ` +
          `>=${this.skyscrapersMeta.minHeightM} m across ${this.skyscrapers.cells.size.toLocaleString("en-US")} city cells` +
          `${where ? ` - densest near ${where}` : ""} - ${this.skyscrapersMeta.sourceLabel}`,
        source: "data",
      };
    }
    if (m.kind === "region") {
      if (!this.geo && !this.regions) {
        return { count: 0, detail: "loading region boundaries…", source: "loading" };
      }
      const regions = (this.regions ?? []).filter((r) => r[m.regionKey] != null).length;
      const countries = (this.geo ?? [])
        .filter((f) => statValue(this.countryStats[f.id]?.[m.statKey]) != null).length;
      const src = this.regions
        ? this.regionsMeta.sourceLabel
        : `country-level only · ${this.countryStatsMeta.sourceLabel}`;
      return {
        count: regions + countries,
        detail: `${regions} regions · ${countries} country fallbacks · ${src}`,
        source: "data",
      };
    }
    if (m.kind === "country") {
      if (!this.geo) {
        return { count: 0, detail: "loading country boundaries…", source: "loading" };
      }
      const count = this.geo.filter((f) => statValue(this.countryStats[f.id]?.[m.statKey]) != null).length;
      return { count, detail: `${count} countries · ${this.countryStatsMeta.sourceLabel}`, source: "data" };
    }
    if (m.kind === "aurora") {
      if (!this.aurora) {
        return { count: 0, detail: "loading aurora forecast…", source: "loading" };
      }
      return {
        count: this.okCount,
        detail: `${this.okCount} grid points · ${this.step}° grid · NOAA SWPC`,
        source: this.source,
      };
    }
    const note = {
      limited: " · API rate-limited, retrying later",
      cache: " · cached data (API rate-limited)",
    }[this.source] ?? "";
    const api = { airquality: "Open-Meteo Air Quality", flood: "Open-Meteo Flood", climate: "Open-Meteo Climate (MRI-AGCM3-2-S 2050)" }[this._dataSource] ?? "Open-Meteo";
    return {
      count: this.okCount,
      detail: `${this.okCount} grid points · ${this.step}° grid · ${api}${note}`,
      source: this.loading && this.okCount === 0 ? "loading" : this.source,
    };
  }
}

// Stull (2011) wet-bulb approximation from dry-bulb temperature (°C) and
// relative humidity (%). Accurate to ~±0.3 °C over normal surface conditions.
function stullWetBulb(t, rh) {
  return (
    t * Math.atan(0.151977 * Math.sqrt(rh + 8.313659)) +
    Math.atan(t + rh) -
    Math.atan(rh - 1.676331) +
    0.00391838 * Math.pow(rh, 1.5) * Math.atan(0.023101 * rh) -
    4.686035
  );
}

// Paint one { rings } feature onto the equirectangular choropleth canvas.
export function fillFeature(ctx, f, value, stops) {
  if (value == null) {
    ctx.fillStyle = NO_DATA_FILL;
  } else {
    const [r, g, b] = colorFor(stops, value);
    ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${OVERLAY_ALPHA / 255})`;
  }
  ctx.beginPath();
  for (const ring of f.rings) {
    ctx.moveTo(((ring[0][0] + 180) * COUNTRY_W) / 360, ((90 - ring[0][1]) * COUNTRY_H) / 180);
    for (let i = 1; i < ring.length; i++) {
      ctx.lineTo(((ring[i][0] + 180) * COUNTRY_W) / 360, ((90 - ring[i][1]) * COUNTRY_H) / 180);
    }
    ctx.closePath();
  }
  ctx.fill("evenodd");
}

export function colorFor(stops, v) {
  if (v <= stops[0][0]) return stops[0][1];
  for (let i = 1; i < stops.length; i++) {
    if (v <= stops[i][0]) {
      const [t0, c0] = stops[i - 1];
      const [t1, c1] = stops[i];
      const f = (v - t0) / (t1 - t0);
      return [
        Math.round(c0[0] + (c1[0] - c0[0]) * f),
        Math.round(c0[1] + (c1[1] - c0[1]) * f),
        Math.round(c0[2] + (c1[2] - c0[2]) * f),
      ];
    }
  }
  return stops[stops.length - 1][1];
}

function statValue(stat) {
  return stat && typeof stat === "object" ? stat.value ?? null : stat ?? null;
}

function legacyCountryStats() {
  const keys = ["name", "gdpNominal", "gdpPpp", "hdi", "ihdi", "gni"];
  const out = {};
  for (const [iso3, row] of Object.entries(COUNTRY_STATS)) {
    out[iso3] = { name: row[0] };
    for (let i = 1; i < keys.length; i++) {
      out[iso3][keys[i]] = {
        value: row[i],
        source: "Bundled legacy snapshot",
      };
    }
  }
  return out;
}

// Human heat-stress context for the wet-bulb tooltip.
export function heatStressLabel(tw) {
  if (tw >= 35) return "Beyond the theoretical human survivability limit";
  if (tw >= 31) return "Extremely dangerous — heat stroke risk even at rest";
  if (tw >= 28) return "Dangerous — strenuous activity unsafe";
  if (tw >= 25) return "High heat stress — limit exertion";
  if (tw >= 21) return "Moderate heat stress";
  return "Safe range";
}

// 429 with an hourly/daily quota message — retrying now is pointless.
// (The *minutely* limit is transient and worth a short-pause retry instead.)
function isQuotaError(e) {
  return e.status === 429 && !/minutely/i.test(e.reason ?? "");
}

function round1(x) {
  return x == null ? null : Math.round(x * 10) / 10;
}

function nearestIndex(sorted, target) {
  let best = 0;
  for (let i = 1; i < sorted.length; i++) {
    if (Math.abs(sorted[i] - target) < Math.abs(sorted[best] - target)) best = i;
  }
  return best;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
