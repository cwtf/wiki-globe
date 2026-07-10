// Natural events layer: live NASA EONET feed (open events only).
// No bundled fallback — the data is inherently ephemeral. On fetch failure the
// badge goes idle and the tooltip carries the error detail.

const FEED_URL = "https://eonet.gsfc.nasa.gov/api/v3/events?status=open";
const REFRESH_MS = 15 * 60 * 1000;
const FETCH_TIMEOUT_MS = 12_000;

const CATEGORIES = {
  wildfires:      { label: "Wildfires",      color: [251, 146, 60],  glow: [239, 68, 68] },
  volcanoes:      { label: "Volcanoes",      color: [239, 68, 68],   glow: [220, 38, 38] },
  severeStorms:   { label: "Severe storms",  color: [79, 195, 247],  glow: [56, 189, 248] },
  seaLakeIce:     { label: "Sea & lake ice", color: [225, 225, 235], glow: [200, 200, 220] },
  snow:           { label: "Snow",           color: [200, 220, 255], glow: [180, 200, 240] },
  temperatureExt: { label: "Temp extremes",  color: [251, 146, 60],  glow: [239, 68, 68] },
  drought:        { label: "Drought",        color: [168, 85, 247],  glow: [147, 51, 234] },
  dustHaze:       { label: "Dust & haze",    color: [217, 119, 6],   glow: [180, 83, 9] },
  manmade:        { label: "Manmade",        color: [148, 163, 184], glow: [100, 116, 139] },
  waterColor:     { label: "Water color",    color: [34, 197, 94],   glow: [22, 163, 74] },
  landslides:     { label: "Landslides",     color: [180, 120, 60],  glow: [145, 95, 45] },
  earthquakes:    { label: "Earthquakes",    color: [239, 68, 68],   glow: [220, 38, 38] },
  floods:         { label: "Floods",         color: [59, 130, 246],  glow: [37, 99, 235] },
};

export class EventsLayer {
  constructor(viewer) {
    this.viewer = viewer;
    this.points = viewer.scene.primitives.add(new Cesium.PointPrimitiveCollection());
    this.events = [];
    this.source = "loading";
    this.visible = false;
    this.lastFetch = 0;
    this.error = null;
    this.enabledCats = new Set(Object.keys(CATEGORIES));
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
      if (!res.ok) throw new Error(`EONET ${res.status}`);
      const data = await res.json();
      this._build(data);
      this.source = "live";
      this.lastFetch = Date.now();
    } catch (e) {
      console.warn("[events] fetch failed:", e.message);
      this.error = e.message;
      this.source = "idle";
      this.points.removeAll();
      this.events = [];
    }
  }

  _build(data) {
    this.points.removeAll();
    this.events = [];
    const events = data?.events ?? [];
    for (const ev of events) {
      const cats = (ev.categories ?? []).map((c) => c.id).filter((id) => CATEGORIES[id]);
      if (cats.length === 0) continue;
      const catId = cats[0];
      const cat = CATEGORIES[catId];
      const geoms = ev.geometry ?? [];
      if (geoms.length === 0) continue;
      const g = geoms[geoms.length - 1];
      const coords = g.coordinates;
      if (!coords) continue;
      let lon, lat;
      if (typeof coords[0] === "number") {
        lon = coords[0]; lat = coords[1];
      } else if (Array.isArray(coords[0])) {
        const first = coords[0];
        lon = first[0]; lat = first[1];
      } else continue;
      const date = g.date ?? ev.closed ?? "";
      const point = this.points.add({
        position: Cesium.Cartesian3.fromDegrees(lon, lat),
        pixelSize: 7,
        color: Cesium.Color.fromCssColorString(
          `rgba(${cat.color[0]},${cat.color[1]},${cat.color[2]},0.85)`
        ),
        outlineColor: Cesium.Color.fromCssColorString(
          `rgba(${cat.glow[0]},${cat.glow[1]},${cat.glow[2]},0.5)`
        ),
        outlineWidth: 2,
        scaleByDistance: new Cesium.NearFarScalar(2.0e5, 1.5, 4.0e7, 0.6),
        id: { kind: "event", event: null },
        show: this.visible && this.enabledCats.has(catId),
      });
      const e = {
        id: ev.id ?? "",
        title: ev.title ?? "Unknown event",
        catId, catLabel: cat.label,
        lon, lat, date,
        point,
      };
      point.id = { kind: "event", event: e };
      this.events.push(e);
    }
  }

  setCategory(catId, enabled) {
    if (!CATEGORIES[catId]) return;
    if (enabled) this.enabledCats.add(catId);
    else this.enabledCats.delete(catId);
    for (const e of this.events) {
      if (e.catId === catId) e.point.show = this.visible && enabled;
    }
  }

  setVisible(v) {
    this.visible = v;
    this.points.show = v;
    if (v) {
      if (Date.now() - this.lastFetch > REFRESH_MS) this._fetch();
      for (const e of this.events) {
        e.point.show = this.enabledCats.has(e.catId);
      }
    }
  }

  tick(nowMs) {
    if (!this.visible) return;
    if (Date.now() - this.lastFetch > REFRESH_MS) this._fetch();
  }

  counts() {
    const visible = this.events.filter((e) => this.enabledCats.has(e.catId)).length;
    return {
      count: this.visible ? visible : 0,
      source: this.source,
      detail: this.error ?? `${visible} events · NASA EONET · open`,
    };
  }
}
