// Wet-bulb temperature layer: a global heat-map overlay derived from
// Open-Meteo hourly data (2 m air temperature + relative humidity, combined
// via Stull's 2011 approximation). Wet-bulb temperature is the key
// heat-stress metric — around 35 °C sustained is the theoretical limit of
// human survivability, and harm starts well below that.
// A sample grid (resolution user-adjustable via setResolution) is fetched
// lazily on first enable together with the past PAST_DAYS of hourly history,
// so a timeline slider can scrub into the past without refetching. The grid
// is bilinearly interpolated onto an equirectangular canvas and draped over
// the globe as a single-tile imagery layer. valueAt() serves the tooltip.
// Chunks are fetched sequentially with one retry: firing them in parallel
// can trip Open-Meteo's per-minute rate limit, which used to silently drop
// whole bands of the grid.

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
const CANVAS_W = 720;                 // 0.5°/px equirectangular overlay
const CANVAS_H = 360;
const OVERLAY_ALPHA = 160;            // 0-255 baked into the overlay pixels
const EDGE_FADE_DEG = 7.5;            // fade to transparent at grid edges

// colour stops for the wet-bulb scale (°C → rgb)
const STOPS = [
  [-20, [122, 165, 255]],  // #7aa5ff
  [0, [79, 195, 247]],     // #4fc3f7
  [10, [63, 217, 143]],    // #3fd98f
  [18, [168, 221, 78]],    // #a8dd4e
  [24, [250, 204, 21]],    // #facc15
  [28, [251, 146, 60]],    // #fb923c
  [31, [239, 68, 68]],     // #ef4444
  [35, [217, 70, 239]],    // #d946ef
];

const TIME_FMT = new Intl.DateTimeFormat("en", {
  month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  hour12: false, timeZone: "UTC",
});

export class WetBulbLayer {
  constructor(viewer) {
    this.viewer = viewer;
    this.layer = null;                // current overlay ImageryLayer
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
    this._retryTimer = null;
    this._rebuildTimer = null;
    this._gen = 0;                    // overlay rebuild generation (latest wins)
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

  setVisible(v) {
    this.visible = v;
    if (this.layer) this.layer.show = v;
    if (v) {
      if (Date.now() - this.lastFetch > REFRESH_MS) this._load();
      this.timer ??= setInterval(() => this._load(), REFRESH_MS);
    } else {
      if (this.timer) { clearInterval(this.timer); this.timer = null; }
      if (this._retryTimer) { clearTimeout(this._retryTimer); this._retryTimer = null; }
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
    if (this.visible) this._load();
  }

  // i indexes this.times (0 = oldest, last = current hour)
  setTimeIndex(i) {
    if (this.times.length === 0) return;
    i = Math.max(0, Math.min(this.times.length - 1, Math.round(i)));
    this.timeIdx = i;
    this.selTime = i === this.times.length - 1 ? null : this.times[i];
    this._applyTimeIdx();
    // debounce the canvas/layer rebuild while the slider is being dragged
    clearTimeout(this._rebuildTimer);
    this._rebuildTimer = setTimeout(() => this._rebuildOverlay(), 90);
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

  async _load() {
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
            console.warn("[wetbulb] chunk failed:", e2.message);
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
        console.warn("[wetbulb] Open-Meteo request quota exceeded; backing off");
        this.cooldownUntil = Date.now() + QUOTA_COOLDOWN_MS;
      }
      if (failures > 0 || quotaHit || this.okCount === 0) {
        this._retryTimer = setTimeout(() => {
          if (this.visible) { this.lastFetch = 0; this._load(); }
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

  // Bilinear interpolation over the sample grid (longitude wraps). Returns
  // { tw, t, rh, when } or null outside the covered latitudes / missing data.
  valueAt(lat, lon) {
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
    return { tw: tw / w, t: t / w, rh: rh / w, when: this.timeLabel() };
  }

  _renderCanvas() {
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
        const [r, g, b] = colorFor(v.tw);
        const i = (y * CANVAS_W + x) * 4;
        d[i] = r; d[i + 1] = g; d[i + 2] = b;
        d[i + 3] = Math.round(OVERLAY_ALPHA * fade);
      }
    }
    ctx.putImageData(img, 0, 0);
    return canvas;
  }

  async _rebuildOverlay() {
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

function colorFor(tw) {
  if (tw <= STOPS[0][0]) return STOPS[0][1];
  for (let i = 1; i < STOPS.length; i++) {
    if (tw <= STOPS[i][0]) {
      const [t0, c0] = STOPS[i - 1];
      const [t1, c1] = STOPS[i];
      const f = (tw - t0) / (t1 - t0);
      return [
        Math.round(c0[0] + (c1[0] - c0[0]) * f),
        Math.round(c0[1] + (c1[1] - c0[1]) * f),
        Math.round(c0[2] + (c1[2] - c0[2]) * f),
      ];
    }
  }
  return STOPS[STOPS.length - 1][1];
}

// Human heat-stress context for the tooltip.
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
