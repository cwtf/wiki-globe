// Power plants layer: reads committed JSON from the data pipeline
// (scripts/data/update-power-plants.mjs → data/power-plants.latest.json).
// Points colored by fuel type, sized by capacity (capped).

const DATA_URL = "data/power-plants.latest.json";

const FUEL_COLORS = {
  Solar:       [251, 191, 36],
  Hydro:       [59, 130, 246],
  Wind:        [45, 212, 191],
  Gas:         [251, 146, 60],
  Coal:        [120, 113, 108],
  Oil:         [168, 85, 247],
  Biomass:     [63, 217, 143],
  Waste:       [148, 163, 184],
  Nuclear:     [236, 72, 153],
  Geothermal:  [239, 68, 68],
  Storage:     [99, 102, 241],
  Other:       [161, 161, 170],
  Cogeneration:[217, 119, 6],
  Petcoke:     [87, 83, 78],
  "Wave and Tidal": [34, 197, 94],
};

export class PowerPlantsLayer {
  constructor(viewer) {
    this.viewer = viewer;
    this.points = viewer.scene.primitives.add(new Cesium.PointPrimitiveCollection());
    this.plants = [];
    this.source = "loading";
    this.visible = false;
    this.loaded = false;
    this.fuels = [];
  }

  async init() {
    this.points.show = false;
    try {
      const resp = await fetch(DATA_URL);
      if (!resp.ok) throw new Error(`${DATA_URL} HTTP ${resp.status}`);
      const data = await resp.json();
      this._build(data);
      this.source = "data";
      this.loaded = true;
    } catch (e) {
      console.warn("[power-plants] data load failed:", e.message);
      this.source = "idle";
    }
  }

  _build(data) {
    this.fuels = data.meta?.fuels ?? [];
    const plants = data.plants ?? [];
    for (const [lon, lat, fuelIdx, mw, name, country] of plants) {
      const fuelName = this.fuels[fuelIdx] ?? "Other";
      const color = FUEL_COLORS[fuelName] ?? FUEL_COLORS.Other;
      // Size: 4 + sqrt(mw)/4, capped at 14
      const size = Math.max(3, Math.min(14, 4 + Math.sqrt(mw) / 4));
      const point = this.points.add({
        position: Cesium.Cartesian3.fromDegrees(lon, lat),
        pixelSize: size,
        color: Cesium.Color.fromBytes(color[0], color[1], color[2], 200),
        outlineColor: Cesium.Color.fromBytes(color[0], color[1], color[2], 80),
        outlineWidth: 1,
        scaleByDistance: new Cesium.NearFarScalar(2.0e5, 1.4, 5.0e7, 0.4),
        id: { kind: "plant", plant: null },
        show: this.visible,
      });
      const p = { lon, lat, fuel: fuelName, mw, name, country, point };
      point.id = { kind: "plant", plant: p };
      this.plants.push(p);
    }
  }

  setVisible(v) {
    this.visible = v;
    this.points.show = v;
  }

  counts() {
    return {
      count: this.visible ? this.plants.length : 0,
      source: this.source,
      detail: `${this.plants.length} plants · WRI GPPD`,
    };
  }
}
