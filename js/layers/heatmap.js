// Heat-map overlay layer: one dropdown-selected metric at a time.
// Weather metrics (wet-bulb temperature / air temperature / relative
// humidity) come from Open-Meteo hourly data on an adjustable sample grid
// with a scrubbable past-days timeline; the wet-bulb value is derived via
// Stull's 2011 approximation (~35 °C sustained is the theoretical limit of
// human survivability). Country metrics (GDP per capita, HDI, IHDI, GNI)
// are drawn as a choropleth from public-domain country polygons coloured by
// the bundled dataset in country-data.js.
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

const TIME_FMT = new Intl.DateTimeFormat("en", {
  month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  hour12: false, timeZone: "UTC",
});

const money = (x) => `$${Math.round(x).toLocaleString("en-US")}`;
const degC = (x) => `${x.toFixed(1)} °C`;

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
};

const FORMATTERS = {
  money,
  degC,
  percent: (x) => `${Math.round(x)}%`,
  fixed3: (x) => x.toFixed(3),
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
  } else if (metric.kind === "country") {
    out.statKey = metric.statKey;
  } else {
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
    this.countryStats = legacyCountryStats();
    this.countryStatsMeta = {
      sourceLabel: "bundled IMF/UNDP 2022-23 estimates",
      fallback: true,
    };
    this._geoLoading = false;
    this._statsLoading = false;
    this._retryTimer = null;
    this._rebuildTimer = null;
    this._gen = 0;                    // overlay rebuild generation (latest wins)
  }

  get metric() {
    return this.mode ? METRICS[this.mode] : null;
  }

  get _weatherActive() {
    return this.metric?.kind === "weather";
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
          tArr: null, rhArr: null,        // full hourly history
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
      if (Date.now() - this.lastFetch > REFRESH_MS) this._load();
      this.timer ??= setInterval(() => this._load(), REFRESH_MS);
      if (this.okCount > 0) this._scheduleRebuild();
    } else if (!this.geo || this.countryStatsMeta.fallback) {
      this._loadCountryData();
    } else {
      this._scheduleRebuild();
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
      if (t == null || rh == null) { s.t = s.rh = s.tw = null; continue; }
      s.t = t;
      s.rh = rh;
      s.tw = stullWetBulb(t, rh);
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
    this.loading = true;
    clearTimeout(this._retryTimer);
    try {
      const chunks = [];
      for (let i = 0; i < this.samples.length; i += CHUNK) {
        chunks.push(this.samples.slice(i, i + CHUNK));
      }
      this._rawTimes = null;
      let failures = 0;
      let quotaHit = false;
      for (const chunk of chunks) {
        try {
          await this._fetchChunk(chunk);
        } catch (e) {
          if (isQuotaError(e)) { quotaHit = true; break; } // rest would 429 too
          // transient failure (or the per-minute limit) — retry once
          await sleep(1500);
          try {
            await this._fetchChunk(chunk);
          } catch (e2) {
            if (isQuotaError(e2)) { quotaHit = true; break; }
            failures++;
            console.warn("[heatmap] chunk failed:", e2.message);
          }
        }
      }
      this.okCount = this.samples.filter((s) => s.tArr).length;
      if (this.okCount > 0 && this._rawTimes) {
        this._finalize();
        this.source = quotaHit ? "limited" : "live";
        this.lastFetch = Date.now();
        if (!quotaHit && failures === 0 && this.okCount === this.samples.length) {
          this._saveCache();
        }
      } else if (this._restoreCache()) {
        this.okCount = this.samples.filter((s) => s.tArr).length;
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
    this.times = this._rawTimes
      .map((t) => Date.parse(`${t}:00Z`))
      .filter((t) => t <= now);
    this.timeIdx = this.selTime == null
      ? this.times.length - 1
      : nearestIndex(this.times, this.selTime);
    this._applyTimeIdx();
    this._rebuildOverlay();
    this.onDataChanged?.();
  }

  _saveCache() {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({
        v: 1,
        step: this.step,
        savedAt: Date.now(),
        rawTimes: this._rawTimes,
        t: this.samples.map((s) => s.tArr.map(round1)),
        rh: this.samples.map((s) => s.rhArr.map(round1)),
      }));
    } catch { /* storage full or unavailable — the cache is best-effort */ }
  }

  _restoreCache() {
    try {
      const c = JSON.parse(localStorage.getItem(CACHE_KEY) ?? "null");
      if (c?.v !== 1 || c.step !== this.step) return false;
      if (Date.now() - c.savedAt > CACHE_MAX_AGE_MS) return false;
      if (c.t?.length !== this.samples.length || !c.rawTimes?.length) return false;
      this.samples.forEach((s, i) => { s.tArr = c.t[i]; s.rhArr = c.rh[i]; });
      this._rawTimes = c.rawTimes;
      return true;
    } catch {
      return false;
    }
  }

  async _fetchChunk(chunk) {
    const lats = chunk.map((s) => s.lat).join(",");
    const lons = chunk.map((s) => s.lon).join(",");
    const url = "https://api.open-meteo.com/v1/forecast" +
      `?latitude=${lats}&longitude=${lons}` +
      "&hourly=temperature_2m,relative_humidity_2m" +
      `&past_days=${PAST_DAYS}&forecast_days=1&timezone=UTC`;
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
      const hh = list[i]?.hourly;
      if (!hh?.time || !hh.temperature_2m || !hh.relative_humidity_2m) continue;
      const s = chunk[i];
      s.tArr = hh.temperature_2m;
      s.rhArr = hh.relative_humidity_2m;
      this._rawTimes ??= hh.time; // identical range for every location
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
      if (this.metric?.kind === "country") {
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

  // --- shared: tooltip lookup, canvas, overlay ------------------------------------

  // Weather modes: bilinear interpolation over the sample grid (longitude
  // wraps). Country modes: polygon lookup. Returns null where there is no
  // coverage under the cursor.
  valueAt(lat, lon) {
    const m = this.metric;
    if (!m) return null;
    if (m.kind === "country") {
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
    let tw = 0, t = 0, rh = 0, w = 0;
    for (const [s, wt] of corners) {
      if (s.tw == null || wt === 0) continue;
      tw += s.tw * wt; t += s.t * wt; rh += s.rh * wt; w += wt;
    }
    if (w < 0.25) return null; // mostly missing data around this point
    return {
      kind: "weather", metric: this.mode,
      tw: tw / w, t: t / w, rh: rh / w, when: this.timeLabel(),
    };
  }

  _renderCanvas() {
    return this.metric?.kind === "country"
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

  _renderCountryCanvas() {
    const m = this.metric;
    const canvas = document.createElement("canvas");
    canvas.width = COUNTRY_W;
    canvas.height = COUNTRY_H;
    const ctx = canvas.getContext("2d");
    const X = (lon) => ((lon + 180) * COUNTRY_W) / 360;
    const Y = (lat) => ((90 - lat) * COUNTRY_H) / 180;
    for (const f of this.geo ?? []) {
      const value = statValue(this.countryStats[f.id]?.[m.statKey]);
      if (value == null) {
        ctx.fillStyle = NO_DATA_FILL;
      } else {
        const [r, g, b] = colorFor(m.stops, value);
        ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${OVERLAY_ALPHA / 255})`;
      }
      ctx.beginPath();
      for (const ring of f.rings) {
        ctx.moveTo(X(ring[0][0]), Y(ring[0][1]));
        for (let i = 1; i < ring.length; i++) {
          ctx.lineTo(X(ring[i][0]), Y(ring[i][1]));
        }
        ctx.closePath();
      }
      ctx.fill("evenodd");
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
    if (m.kind === "country") {
      if (!this.geo) {
        return { count: 0, detail: "loading country boundaries…", source: "loading" };
      }
      const count = this.geo.filter((f) => statValue(this.countryStats[f.id]?.[m.statKey]) != null).length;
      return { count, detail: `${count} countries · ${this.countryStatsMeta.sourceLabel}`, source: "data" };
    }
    const note = {
      limited: " · API rate-limited, retrying later",
      cache: " · cached data (API rate-limited)",
    }[this.source] ?? "";
    return {
      count: this.okCount,
      detail: `${this.okCount} grid points · ${this.step}° grid · Open-Meteo${note}`,
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

function colorFor(stops, v) {
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
