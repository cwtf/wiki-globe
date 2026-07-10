// Submarine cables layer: reads committed GeoJSON from the data pipeline
// (scripts/data/update-submarine-cables.mjs → data/submarine-cables.latest.geojson).
// Renders thin glowing polylines colored per-cable from the dataset.

const CABLES_URL = "data/submarine-cables.latest.geojson";

const DEFAULT_COLOR = [100, 180, 255];
const GLOW_ALPHA = 0.5;

export class CablesLayer {
  constructor(viewer) {
    this.viewer = viewer;
    this.lines = viewer.scene.primitives.add(new Cesium.PolylineCollection());
    this.cables = [];
    this.source = "loading";
    this.visible = false;
    this.loaded = false;
  }

  async init() {
    this.lines.show = false;
    try {
      const resp = await fetch(CABLES_URL);
      if (!resp.ok) throw new Error(`${CABLES_URL} HTTP ${resp.status}`);
      const gj = await resp.json();
      this._build(gj);
      this.source = "data";
      this.loaded = true;
    } catch (e) {
      console.warn("[cables] data load failed:", e.message);
      this.source = "idle";
    }
  }

  _build(gj) {
    const feats = gj?.features ?? [];
    for (const f of feats) {
      const g = f.geometry;
      if (!g) continue;
      const props = f.properties ?? {};
      const color = parseColor(props.color) ?? DEFAULT_COLOR;
      const cesiumColor = Cesium.Color.fromBytes(color[0], color[1], color[2], Math.round(GLOW_ALPHA * 255));

      const addLine = (coords) => {
        if (!Array.isArray(coords) || coords.length < 2) return;
        const positions = coords.map(([lon, lat]) => Cesium.Cartesian3.fromDegrees(lon, lat));
        const cable = { name: props.name ?? "", color, positions };
        const poly = this.lines.add({
          positions,
          width: 1.5,
          material: Cesium.Material.fromType("Color", { color: cesiumColor }),
          id: { kind: "cable", cable },
          show: this.visible,
        });
        cable.polyline = poly;
        this.cables.push(cable);
      };

      if (g.type === "LineString") {
        addLine(g.coordinates);
      } else if (g.type === "MultiLineString") {
        for (const line of g.coordinates) addLine(line);
      }
    }
  }

  setVisible(v) {
    this.visible = v;
    this.lines.show = v;
  }

  counts() {
    return {
      count: this.visible ? this.cables.length : 0,
      source: this.source,
      detail: `${this.cables.length} cables · TeleGeography`,
    };
  }
}

function parseColor(hex) {
  if (!hex || typeof hex !== "string") return null;
  const m = hex.match(/^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!m) return null;
  return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
}
