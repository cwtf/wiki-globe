// Time zones layer: reads committed GeoJSON from the data pipeline
// (scripts/data/update-time-zones.mjs → data/time-zones.latest.geojson).
// Renders translucent polygon bands colored by UTC offset (cyclic palette).

const DATA_URL = "data/time-zones.latest.geojson";

// Cyclic palette: 24 hues around the color wheel
function zoneColor(zone) {
  const hue = ((zone + 12) * 15) % 360;
  const sat = 45;
  const light = 50;
  return Cesium.Color.fromHsl(hue / 360, sat / 100, light / 100, 0.25);
}

export class TimeZonesLayer {
  constructor(viewer) {
    this.viewer = viewer;
    this.entities = [];
    this.source = "loading";
    this.visible = false;
    this.loaded = false;
  }

  async init() {
    try {
      const resp = await fetch(DATA_URL);
      if (!resp.ok) throw new Error(`${DATA_URL} HTTP ${resp.status}`);
      const gj = await resp.json();
      this._build(gj);
      this.source = "data";
      this.loaded = true;
    } catch (e) {
      console.warn("[time-zones] data load failed:", e.message);
      this.source = "idle";
    }
  }

  _build(gj) {
    const feats = gj?.features ?? [];
    for (const f of feats) {
      const zone = f.properties?.zone ?? 0;
      const utcFormat = f.properties?.utc_format ?? "";
      const color = zoneColor(zone);
      const geom = f.geometry;
      if (!geom) continue;

      const addPolygon = (coords) => {
        if (!Array.isArray(coords) || coords.length < 3) return;
        const positions = coords.map(([lon, lat]) => Cesium.Cartesian3.fromDegrees(lon, lat));
        const entity = this.viewer.entities.add({
          polygon: {
            hierarchy: new Cesium.PolygonHierarchy(positions),
            material: color,
            outline: true,
            outlineColor: Cesium.Color.fromHsl(color.hue, color.saturation, color.lightness, 0.5),
            classificationType: Cesium.ClassificationType.BOTH,
          },
          show: this.visible,
        });
        entity.id = { kind: "timezone", zone, utcFormat };
        this.entities.push(entity);
      };

      if (geom.type === "Polygon") {
        addPolygon(geom.coordinates[0]); // outer ring only
      } else if (geom.type === "MultiPolygon") {
        for (const poly of geom.coordinates) {
          addPolygon(poly[0]); // outer ring of each polygon
        }
      }
    }
  }

  setVisible(v) {
    this.visible = v;
    for (const e of this.entities) e.show = v;
  }

  counts() {
    return {
      count: this.visible ? this.entities.length : 0,
      source: this.source,
      detail: `${this.entities.length} zones · Natural Earth`,
    };
  }
}
