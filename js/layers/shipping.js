// Shipping layer: curated major maritime corridors rendered as glowing
// animated paths, with simulated vessels crawling along each lane.
// (There is no free global live AIS feed, so vessel motion is simulated at
// an accelerated clock and labelled as such.)

import { SHIPPING_LANES } from "../shipping-lanes.js";
import { vesselName } from "../demo-data.js";

const LANE_HEIGHT = 1500;       // metres — keeps segments clear of the ellipsoid
const SAMPLE_KM = 120;          // lane densification step
const PULSE_SPEED_KMS = 120;    // visual flow speed of lane pulses
const VESSEL_SPEED_KMS = 5;     // ~16 kn sped up 600x so motion is perceptible

const LANE_COLOR = Cesium.Color.fromCssColorString("#3fd9ff").withAlpha(0.4);
const POLAR_COLOR = Cesium.Color.fromCssColorString("#9fd4ff").withAlpha(0.42);
const PULSE_COLOR = Cesium.Color.fromCssColorString("#bdf3ff");
const VESSEL_COLOR = Cesium.Color.fromCssColorString("#7cfc9a");
const ROUTE_HILIGHT = Cesium.Color.fromCssColorString("#ffac4d").withAlpha(0.95);

export class ShippingLayer {
  constructor(viewer) {
    this.viewer = viewer;
    this.lines = viewer.scene.primitives.add(new Cesium.PolylineCollection());
    this.highlight = viewer.scene.primitives.add(new Cesium.PolylineCollection());
    this.pulsePoints = viewer.scene.primitives.add(new Cesium.PointPrimitiveCollection());
    this.vesselPoints = viewer.scene.primitives.add(new Cesium.PointPrimitiveCollection());
    this.lanes = [];
    this.pulses = [];
    this.vessels = [];
    this.visible = true;
    this.vesselRoutesVisible = false;
    this.highlightedLane = null;
    this.lastTick = 0;
    this.source = "static";
  }

  init() {
    let vesselIdx = 0;
    for (const def of SHIPPING_LANES) {
      const lane = densifyLane(def);
      this.lanes.push(lane);

      this.lines.add({
        positions: lane.positions,
        width: 4.5,
        material: Cesium.Material.fromType("PolylineGlow", {
          color: def.polar ? POLAR_COLOR : LANE_COLOR,
          glowPower: 0.22,
          taperPower: 1.0,
        }),
        id: { kind: "lane", lane },
      });

      const pulseCount = clamp(Math.round(lane.lengthKm / 2500), 2, 8);
      for (let i = 0; i < pulseCount; i++) {
        this.pulses.push({
          lane,
          frac: i / pulseCount,
          point: this.pulsePoints.add({
            position: lane.positions[0],
            pixelSize: 5.5,
            color: PULSE_COLOR,
            scaleByDistance: new Cesium.NearFarScalar(2.0e5, 1.4, 4.0e7, 0.55),
            id: { kind: "lane", lane },
          }),
        });
      }

      const vesselCount = clamp(Math.round(lane.lengthKm / 3500), 1, 4);
      for (let i = 0; i < vesselCount; i++) {
        const v = {
          name: vesselName(vesselIdx++),
          lane,
          frac: (i + 0.5) / vesselCount,
          dir: i % 2 === 0 ? 1 : -1,
          speedKn: 14 + (vesselIdx % 5),
        };
        v.point = this.vesselPoints.add({
          position: lane.positions[0],
          pixelSize: 5,
          color: VESSEL_COLOR,
          outlineColor: Cesium.Color.BLACK.withAlpha(0.6),
          outlineWidth: 1,
          scaleByDistance: new Cesium.NearFarScalar(2.0e5, 1.6, 4.0e7, 0.7),
          id: { kind: "vessel", vessel: v },
        });
        this.vessels.push(v);
      }
    }
  }

  tick(nowMs) {
    if (!this.visible) return;
    const dt = this.lastTick ? Math.min((nowMs - this.lastTick) / 1000, 0.5) : 0;
    this.lastTick = nowMs;
    if (dt === 0) return;

    for (const p of this.pulses) {
      p.frac = (p.frac + (PULSE_SPEED_KMS * dt) / p.lane.lengthKm) % 1;
      p.point.position = positionOnLane(p.lane, p.frac);
    }
    for (const v of this.vessels) {
      v.frac += (v.dir * VESSEL_SPEED_KMS * dt) / v.lane.lengthKm;
      if (v.frac >= 1) { v.frac = 1; v.dir = -1; }
      else if (v.frac <= 0) { v.frac = 0; v.dir = 1; }
      v.point.position = positionOnLane(v.lane, v.frac);
    }
  }

  setVisible(v) {
    this.visible = v;
    this.lines.show = v;
    this.pulsePoints.show = v;
    this.vesselPoints.show = v;
    this.highlight.show = v && this.vesselRoutesVisible;
  }

  setVesselRoutesVisible(v) {
    this.vesselRoutesVisible = v;
    this.highlight.show = v && this.visible;
    if (!v) this.clearHighlight();
  }

  // Hovering / selecting a vessel highlights its full route.
  highlightVessel(vessel) {
    if (!this.vesselRoutesVisible) return;
    if (this.highlightedLane === vessel?.lane) return;
    this.highlight.removeAll();
    this.highlightedLane = vessel ? vessel.lane : null;
    if (vessel) {
      this.highlight.add({
        positions: vessel.lane.positions.map((p) => liftPosition(p, 1200)),
        width: 2.2,
        material: Cesium.Material.fromType("PolylineDash", {
          color: ROUTE_HILIGHT,
          dashLength: 16,
        }),
        id: { kind: "vessel", vessel },
      });
    }
  }

  clearHighlight() {
    this.highlight.removeAll();
    this.highlightedLane = null;
  }

  counts() {
    if (!this.visible) return { count: 0, detail: "", source: this.source };
    return {
      count: this.lanes.length,
      detail: `${this.lanes.length} lanes · ${this.vessels.length} vessels`,
      source: this.source,
    };
  }
}

function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

// Sample a lane's waypoint chain into ~SAMPLE_KM segments along geodesics.
function densifyLane(def) {
  const positions = [];
  const cartos = def.waypoints.map(([lon, lat]) => Cesium.Cartographic.fromDegrees(lon, lat));
  let lengthM = 0;
  for (let i = 0; i < cartos.length - 1; i++) {
    const geo = new Cesium.EllipsoidGeodesic(cartos[i], cartos[i + 1]);
    const segM = geo.surfaceDistance;
    const steps = Math.max(1, Math.ceil(segM / (SAMPLE_KM * 1000)));
    for (let s = 0; s < steps; s++) {
      const c = geo.interpolateUsingFraction(s / steps);
      positions.push(Cesium.Cartesian3.fromRadians(c.longitude, c.latitude, LANE_HEIGHT));
    }
    lengthM += segM;
  }
  const last = cartos[cartos.length - 1];
  positions.push(Cesium.Cartesian3.fromRadians(last.longitude, last.latitude, LANE_HEIGHT));
  return {
    name: def.name,
    polar: def.polar,
    positions,
    lengthKm: lengthM / 1000,
    endpoints: def.name.match(/\(([^)]+)\)/)?.[1] ?? "",
  };
}

const scratchLerp = new Cesium.Cartesian3();

function positionOnLane(lane, frac) {
  const t = frac * (lane.positions.length - 1);
  const i = Math.min(Math.floor(t), lane.positions.length - 2);
  return Cesium.Cartesian3.lerp(lane.positions[i], lane.positions[i + 1], t - i, scratchLerp);
}

function liftPosition(cart, extraM) {
  const c = Cesium.Cartographic.fromCartesian(cart);
  return Cesium.Cartesian3.fromRadians(c.longitude, c.latitude, c.height + extraM);
}
