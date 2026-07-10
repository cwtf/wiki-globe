// Earthquake layer: live USGS feed (all_day / all_hour / all_week GeoJSON).
// No bundled fallback — the data is inherently ephemeral. On fetch failure the
// badge goes idle and the tooltip carries the error detail.

const FEEDS = {
  hour: "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_hour.geojson",
  day:  "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson",
  week: "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_week.geojson",
};
const REFRESH_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 12_000;

export class EarthquakesLayer {
  constructor(viewer) {
    this.viewer = viewer;
    this.points = viewer.scene.primitives.add(new Cesium.PointPrimitiveCollection());
    this.quakes = [];
    this.source = "loading";
    this.visible = false;
    this.feed = "day";
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
      const res = await fetch(FEEDS[this.feed], { signal: ctl.signal });
      clearTimeout(t);
      if (!res.ok) throw new Error(`USGS ${res.status}`);
      const geo = await res.json();
      this._build(geo);
      this.source = "live";
      this.lastFetch = Date.now();
    } catch (e) {
      console.warn("[earthquakes] fetch failed:", e.message);
      this.error = e.message;
      this.source = "idle";
      this.points.removeAll();
      this.quakes = [];
    }
  }

  _build(geo) {
    this.points.removeAll();
    this.quakes = [];
    const feats = geo?.features ?? [];
    for (const f of feats) {
      const c = f.geometry?.coordinates;
      if (!c || c.length < 2) continue;
      const lon = c[0];
      const lat = c[1];
      const depth = c[2] ?? 0;
      const p = f.properties ?? {};
      const mag = p.mag ?? 0;
      const size = Math.max(4, Math.min(28, 4 + Math.pow(2, mag - 3)));
      const color = depthColor(depth, mag);
      const point = this.points.add({
        position: Cesium.Cartesian3.fromDegrees(lon, lat),
        pixelSize: size,
        color,
        outlineColor: mag >= 6 ? Cesium.Color.fromCssColorString("#ff6b6b").withAlpha(0.6) : Cesium.Color.TRANSPARENT,
        outlineWidth: mag >= 6 ? 3 : 0,
        scaleByDistance: new Cesium.NearFarScalar(2.0e5, 1.6, 4.0e7, 0.6),
        id: { kind: "quake", quake: null },
        show: this.visible,
      });
      const q = {
        mag, depth, lon, lat,
        place: p.place ?? "",
        time: p.time ?? 0,
        url: p.url ?? "",
        tsunami: !!p.tsunami,
        point,
      };
      point.id = { kind: "quake", quake: q };
      this.quakes.push(q);
    }
  }

  setFeed(feed) {
    if (!FEEDS[feed]) return;
    this.feed = feed;
    this.lastFetch = 0;
    if (this.visible) this._fetch();
  }

  setVisible(v) {
    this.visible = v;
    this.points.show = v;
    if (v) {
      if (Date.now() - this.lastFetch > REFRESH_MS) this._fetch();
    }
  }

  tick(nowMs) {
    if (!this.visible) return;
    if (Date.now() - this.lastFetch > REFRESH_MS) this._fetch();
  }

  counts() {
    return {
      count: this.visible ? this.quakes.length : 0,
      source: this.source,
      detail: this.error ?? `${this.quakes.length} quakes · USGS · ${this.feed}`,
    };
  }
}

function depthColor(depthKm, mag) {
  const t = Math.max(0, Math.min(1, depthKm / 700));
  const r = Math.round(239 + (79 - 239) * t);
  const g = Math.round(68 + (125 - 68) * t);
  const b = Math.round(68 + (255 - 68) * t);
  const alpha = mag >= 6 ? 0.95 : 0.8;
  return new Cesium.Color(r / 255, g / 255, b / 255, alpha);
}
