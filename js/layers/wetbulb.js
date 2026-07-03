// Wet-bulb temperature layer: a global heat-map overlay derived from
// Open-Meteo current conditions (2 m air temperature + relative humidity,
// combined via Stull's 2011 approximation). Wet-bulb temperature is the key
// heat-stress metric — around 35 °C sustained is the theoretical limit of
// human survivability, and harm starts well below that.
// A 15° sample grid is fetched lazily on first enable, bilinearly
// interpolated onto an equirectangular canvas, and draped over the globe as
// a single-tile imagery layer. valueAt() serves the cursor tooltip.

const LAT_MIN = -60;
const LAT_MAX = 75;
const LAT_STEP = 15;
const LON_STEP = 15;
const ROWS = (LAT_MAX - LAT_MIN) / LAT_STEP + 1;
const COLS = 360 / LON_STEP;
const REFRESH_MS = 20 * 60 * 1000;    // Open-Meteo models update ~hourly
const CHUNK = 60;                     // locations per batched API request
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

export class WetBulbLayer {
  constructor(viewer) {
    this.viewer = viewer;
    this.layer = null;                // current overlay ImageryLayer
    this.samples = this._buildGrid();
    this.visible = false;
    this.loading = false;
    this.lastFetch = 0;
    this.okCount = 0;
    this.source = "loading";
    this.timer = null;
  }

  _buildGrid() {
    const samples = [];
    for (let lat = LAT_MIN; lat <= LAT_MAX; lat += LAT_STEP) {
      for (let lon = -180; lon < 180; lon += LON_STEP) {
        samples.push({ lat, lon, tw: null, t: null, rh: null });
      }
    }
    return samples;
  }

  setVisible(v) {
    this.visible = v;
    if (this.layer) this.layer.show = v;
    if (v) {
      if (Date.now() - this.lastFetch > REFRESH_MS) this._load();
      this.timer ??= setInterval(() => this._load(), REFRESH_MS);
    } else if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async _load() {
    if (this.loading) return;
    this.loading = true;
    try {
      const chunks = [];
      for (let i = 0; i < this.samples.length; i += CHUNK) {
        chunks.push(this.samples.slice(i, i + CHUNK));
      }
      const results = await Promise.allSettled(chunks.map((c) => this._fetchChunk(c)));
      this.okCount = this.samples.filter((s) => s.tw != null).length;
      if (results.some((r) => r.status === "fulfilled") && this.okCount > 0) {
        await this._rebuildOverlay();
        this.source = "live";
        this.lastFetch = Date.now();
      } else {
        console.warn("[wetbulb] all Open-Meteo requests failed");
      }
    } finally {
      this.loading = false;
    }
  }

  async _fetchChunk(chunk) {
    const lats = chunk.map((s) => s.lat).join(",");
    const lons = chunk.map((s) => s.lon).join(",");
    const url = "https://api.open-meteo.com/v1/forecast" +
      `?latitude=${lats}&longitude=${lons}` +
      "&current=temperature_2m,relative_humidity_2m";
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`open-meteo ${resp.status}`);
    const data = await resp.json();
    const list = Array.isArray(data) ? data : [data];
    for (let i = 0; i < chunk.length && i < list.length; i++) {
      const cur = list[i]?.current;
      if (cur?.temperature_2m == null || cur?.relative_humidity_2m == null) continue;
      const s = chunk[i];
      s.t = cur.temperature_2m;
      s.rh = cur.relative_humidity_2m;
      s.tw = stullWetBulb(s.t, s.rh);
    }
  }

  // Bilinear interpolation over the sample grid (longitude wraps). Returns
  // { tw, t, rh } or null outside the covered latitudes / where data is missing.
  valueAt(lat, lon) {
    if (lat < LAT_MIN || lat > LAT_MAX) return null;
    lon = ((lon + 180) % 360 + 360) % 360 - 180;
    const fr = (lat - LAT_MIN) / LAT_STEP;
    const fc = (lon + 180) / LON_STEP;
    const r0 = Math.min(Math.floor(fr), ROWS - 1);
    const r1 = Math.min(r0 + 1, ROWS - 1);
    const c0 = Math.floor(fc) % COLS;
    const c1 = (c0 + 1) % COLS;
    const tr = fr - Math.floor(fr);
    const tc = fc - Math.floor(fc);
    const corners = [
      [this.samples[r0 * COLS + c0], (1 - tr) * (1 - tc)],
      [this.samples[r0 * COLS + c1], (1 - tr) * tc],
      [this.samples[r1 * COLS + c0], tr * (1 - tc)],
      [this.samples[r1 * COLS + c1], tr * tc],
    ];
    let tw = 0, t = 0, rh = 0, w = 0;
    for (const [s, wt] of corners) {
      if (s.tw == null || wt === 0) continue;
      tw += s.tw * wt; t += s.t * wt; rh += s.rh * wt; w += wt;
    }
    if (w < 0.25) return null; // mostly missing data around this point
    return { tw: tw / w, t: t / w, rh: rh / w };
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
        Math.max(0, (LAT_MAX - lat) / EDGE_FADE_DEG)
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
    const url = this._renderCanvas().toDataURL("image/png");
    const provider = await Cesium.SingleTileImageryProvider.fromUrl(url);
    const layer = this.viewer.imageryLayers.addImageryProvider(provider);
    layer.show = this.visible;
    if (this.layer) this.viewer.imageryLayers.remove(this.layer);
    this.layer = layer;
  }

  counts() {
    if (!this.visible) return { count: 0, detail: "", source: this.source };
    return {
      count: this.okCount,
      detail: `${this.okCount} grid readings · Open-Meteo`,
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
