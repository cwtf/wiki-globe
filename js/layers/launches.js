// Launches layer: upcoming rocket launches from Launch Library 2 (The Space Devs).
// Unauthenticated quota ~15 req/hr — fetch once on toggle-on, refresh every 30 min.
// No bundled fallback. On 429, badge idle with rate-limited detail.

const FEED_URL = "https://ll.thespacedevs.com/2.2.0/launch/upcoming/?limit=30&mode=list";
const REFRESH_MS = 30 * 60 * 1000;
const FETCH_TIMEOUT_MS = 12_000;
const CACHE_KEY = "ll2-launches-v1";
const CACHE_MAX_AGE = 2 * 60 * 60 * 1000; // 2 hours

export class LaunchesLayer {
  constructor(viewer) {
    this.viewer = viewer;
    this.points = viewer.scene.primitives.add(new Cesium.PointPrimitiveCollection());
    this.launches = [];
    this.source = "loading";
    this.visible = false;
    this.lastFetch = 0;
    this.error = null;
  }

  async init() {
    this.points.show = false;
  }

  async _fetch() {
    this.source = "loading";
    this.error = null;
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
      const res = await fetch(FEED_URL, { signal: ctl.signal });
      clearTimeout(t);
      if (res.status === 429) throw new Error("rate limited (429)");
      if (!res.ok) throw new Error(`LL2 ${res.status}`);
      const data = await res.json();
      this._build(data);
      this.source = "live";
      this.lastFetch = Date.now();
      this._saveCache(data);
    } catch (e) {
      console.warn("[launches] fetch failed:", e.message);
      this.error = e.message;
      // try sessionStorage cache
      const cached = this._loadCache();
      if (cached) {
        this._build(cached);
        this.source = "cache";
      } else {
        this.source = "idle";
        this.points.removeAll();
        this.launches = [];
      }
    }
  }

  _build(data) {
    this.points.removeAll();
    this.launches = [];
    const results = data?.results ?? [];
    // Group by pad to stack multiple launches
    const padMap = new Map();
    for (const r of results) {
      const pad = r.pad;
      if (!pad?.latitude || !pad?.longitude) continue;
      const key = `${pad.latitude},${pad.longitude}`;
      if (!padMap.has(key)) {
        padMap.set(key, {
          lat: pad.latitude,
          lon: pad.longitude,
          location: pad.location?.name ?? "",
          padName: pad.name ?? "",
          launches: [],
        });
      }
      padMap.get(key).launches.push({
        name: r.name ?? "Unknown",
        net: r.net ?? "",
        lsp: r.launch_service_provider?.name ?? "",
        status: r.status?.abbrev ?? "",
        mission: r.mission?.name ?? "",
        rocket: r.rocket?.configuration?.name ?? "",
      });
    }
    for (const pad of padMap.values()) {
      pad.launches.sort((a, b) => new Date(a.net) - new Date(b.net));
      const point = this.points.add({
        position: Cesium.Cartesian3.fromDegrees(pad.lon, pad.lat),
        pixelSize: 8,
        color: Cesium.Color.fromCssColorString("rgba(168,85,247,0.85)"),
        outlineColor: Cesium.Color.fromCssColorString("rgba(147,51,234,0.5)"),
        outlineWidth: 2,
        scaleByDistance: new Cesium.NearFarScalar(2.0e5, 1.5, 4.0e7, 0.6),
        id: { kind: "launch", launch: null },
        show: this.visible,
      });
      const entry = {
        lat: pad.lat, lon: pad.lon,
        location: pad.location, padName: pad.padName,
        launches: pad.launches, point,
      };
      point.id = { kind: "launch", launch: entry };
      this.launches.push(entry);
    }
  }

  _saveCache(data) {
    try {
      sessionStorage.setItem(CACHE_KEY, JSON.stringify({ t: Date.now(), data }));
    } catch { /* storage full */ }
  }

  _loadCache() {
    try {
      const c = JSON.parse(sessionStorage.getItem(CACHE_KEY) ?? "null");
      if (c?.data && Date.now() - c.t < CACHE_MAX_AGE) return c.data;
    } catch { /* parse error */ }
    return null;
  }

  setVisible(v) {
    this.visible = v;
    this.points.show = v;
    if (v && Date.now() - this.lastFetch > REFRESH_MS) this._fetch();
  }

  tick(nowMs) {
    if (!this.visible) return;
    if (Date.now() - this.lastFetch > REFRESH_MS) this._fetch();
  }

  counts() {
    const count = this.launches.reduce((n, p) => n + p.launches.length, 0);
    return {
      count: this.visible ? count : 0,
      source: this.source,
      detail: this.error ?? `${count} launches · ${this.launches.length} pads · The Space Devs LL2`,
    };
  }
}

// Format a countdown from now to a launch net time.
export function formatCountdown(net) {
  const ms = new Date(net).getTime() - Date.now();
  if (isNaN(ms)) return "";
  if (ms < 0) return "T+0";
  const d = Math.floor(ms / 86400000);
  const h = Math.floor((ms % 86400000) / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  if (d > 0) return `T-${d}d ${h}h`;
  if (h > 0) return `T-${h}h ${m}m`;
  const s = Math.floor((ms % 60000) / 1000);
  return `T-${m}m ${s}s`;
}
