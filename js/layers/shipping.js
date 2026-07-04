// Shipping layer: live AIS vessel positions (aisstream.io or Digitraffic,
// see ais.js) with dead reckoning between reports, falling back to simulated
// vessels when no live feed is reachable. The curated lane arcs remain as a
// background reference layer either way.
// The routes toggle draws each vessel's path to its reported destination
// (AIS destination text resolved against a port gazetteer).

import { getShippingLanes, loadShippingLaneData } from "../shipping-lanes.js";
import { vesselName } from "../demo-data.js";
import { createLiveAis } from "../ais.js";
import { flagFromMmsi, shipTypeName, resolveDestination, loadMaritimeReferenceData } from "../ais-data.js";

const LANE_HEIGHT = 1500;       // metres — keeps segments clear of the ellipsoid
const VESSEL_HEIGHT = 1200;
const SAMPLE_KM = 120;          // lane densification step
const PULSE_SPEED_KMS = 120;    // visual flow speed of lane pulses
const SIM_SPEED_KMS = 5;        // ~16 kn sped up 600x so motion is perceptible

const MAX_LIVE_VESSELS = 4000;
const STALE_MS = 20 * 60 * 1000;
const UPDATE_SLICES = 30;       // frames per dead-reckoning sweep
const MAX_ROUTES = 400;
const ROUTE_REBUILD_MS = 90 * 1000;
const ROUTES_PER_FRAME = 10;

const LANE_COLOR = Cesium.Color.fromCssColorString("#3fd9ff").withAlpha(0.4);
const LANE_COLOR_DIM = Cesium.Color.fromCssColorString("#3fd9ff").withAlpha(0.16);
const POLAR_COLOR = Cesium.Color.fromCssColorString("#9fd4ff").withAlpha(0.42);
const POLAR_COLOR_DIM = Cesium.Color.fromCssColorString("#9fd4ff").withAlpha(0.18);
const PULSE_COLOR = Cesium.Color.fromCssColorString("#bdf3ff");
const VESSEL_COLOR = Cesium.Color.fromCssColorString("#7cfc9a");
const ROUTE_COLOR = Cesium.Color.fromCssColorString("#ffac4d").withAlpha(0.55);

export class ShippingLayer {
  constructor(viewer) {
    this.viewer = viewer;
    this.lines = viewer.scene.primitives.add(new Cesium.PolylineCollection());
    this.routeLines = viewer.scene.primitives.add(new Cesium.PolylineCollection());
    this.pulsePoints = viewer.scene.primitives.add(new Cesium.PointPrimitiveCollection());
    this.vesselPoints = viewer.scene.primitives.add(new Cesium.PointPrimitiveCollection());
    this.lanes = [];
    this.pulses = [];
    this.vessels = new Map();   // live vessels by MMSI
    this.meta = new Map();      // static AIS data by MMSI (may precede position)
    this.simVessels = [];
    this.list = [];             // iteration cache over live vessels
    this.listDirty = false;
    this.cursor = 0;
    this.visible = true;
    this.routesVisible = false;
    this.routeQueue = [];
    this.lastRouteBuild = 0;
    this.lastSweep = 0;
    this.lastTick = 0;
    this.mode = "sim";
    this.source = "loading";
  }

  async init() {
    await Promise.all([loadShippingLaneData(), loadMaritimeReferenceData()]);
    this._buildLanes(LANE_COLOR, POLAR_COLOR);

    this.live = await createLiveAis({
      onPosition: (u) => this._upsertLive(u),
      onStatic: (u) => this._mergeStatic(u),
    });

    if (this.live) {
      this.mode = "live";
      this.source = "live";
      // live vessels are the foreground now; mute the reference lanes
      this.lines.removeAll();
      this._buildLanes(LANE_COLOR_DIM, POLAR_COLOR_DIM);
    } else {
      console.warn("[shipping] no live AIS feed reachable, using simulated vessels");
      this.mode = "sim";
      this.source = "demo";
      this._buildSimVessels();
    }
  }

  _buildLanes(color, polarColor) {
    const firstBuild = this.lanes.length === 0;
    if (firstBuild) {
      for (const def of getShippingLanes()) this.lanes.push(densifyLane(def));
    }
    for (const lane of this.lanes) {
      this.lines.add({
        positions: lane.positions,
        width: 4.5,
        material: Cesium.Material.fromType("PolylineGlow", {
          color: lane.polar ? polarColor : color,
          glowPower: 0.22,
          taperPower: 1.0,
        }),
        id: { kind: "lane", lane },
      });
      if (firstBuild) {
        const pulseCount = clamp(Math.round(lane.lengthKm / 2500), 2, 8);
        for (let i = 0; i < pulseCount; i++) {
          this.pulses.push({
            lane,
            frac: i / pulseCount,
            point: this.pulsePoints.add({
              position: lane.positions[0],
              pixelSize: 5,
              color: PULSE_COLOR,
              scaleByDistance: new Cesium.NearFarScalar(2.0e5, 1.4, 4.0e7, 0.55),
              id: { kind: "lane", lane },
            }),
          });
        }
      }
    }
  }

  // --- live vessels ----------------------------------------------------------

  _upsertLive(u) {
    let v = this.vessels.get(u.mmsi);
    if (!v) {
      if (this.vessels.size >= MAX_LIVE_VESSELS) return;
      v = {
        kind: "vessel",
        live: true,
        mmsi: u.mmsi,
        flag: flagFromMmsi(u.mmsi),
        typeName: shipTypeName(null),
      };
      const m = this.meta.get(u.mmsi);
      if (m) this._applyMeta(v, m);
      v.point = this.vesselPoints.add({
        position: Cesium.Cartesian3.fromDegrees(u.lon, u.lat, VESSEL_HEIGHT),
        pixelSize: 3.5,
        color: VESSEL_COLOR,
        outlineColor: Cesium.Color.BLACK.withAlpha(0.6),
        outlineWidth: 1,
        scaleByDistance: new Cesium.NearFarScalar(2.0e5, 2.0, 4.0e7, 0.6),
        id: { kind: "vessel", vessel: v },
      });
      this.vessels.set(u.mmsi, v);
      this.listDirty = true;
    }
    v.lat = u.lat;
    v.lon = u.lon;
    v.sogKn = u.sogKn;
    v.cogDeg = u.cogDeg;
    v.headingDeg = u.headingDeg;
    v.ts = u.ts;
    if (u.name && !v.name) v.name = u.name;
    v.point.position = Cesium.Cartesian3.fromDegrees(v.lon, v.lat, VESSEL_HEIGHT);
  }

  _mergeStatic(u) {
    this.meta.set(u.mmsi, u);
    const v = this.vessels.get(u.mmsi);
    if (v) this._applyMeta(v, u);
  }

  _applyMeta(v, m) {
    if (m.name) v.name = m.name;
    if (m.typeCode != null) v.typeName = shipTypeName(m.typeCode);
    if (m.destination !== undefined) v.destination = m.destination;
  }

  // --- simulated fallback ------------------------------------------------------

  _buildSimVessels() {
    let idx = 0;
    const simTypes = [
      [70, "Cargo ship"], [70, "Cargo ship"], [80, "Tanker"], [60, "Passenger ship"],
    ];
    const simFlags = ["Panama", "Liberia", "Marshall Islands", "Hong Kong",
      "Singapore", "Malta", "Bahamas", "Greece", "Denmark", "Norway"];
    for (const lane of this.lanes) {
      const [endA, endB] = lane.endpoints.split(" – ");
      const count = clamp(Math.round(lane.lengthKm / 3500), 1, 4);
      for (let i = 0; i < count; i++) {
        const dir = i % 2 === 0 ? 1 : -1;
        const v = {
          kind: "vessel",
          live: false,
          name: vesselName(idx),
          typeName: simTypes[idx % simTypes.length][1],
          flag: simFlags[idx % simFlags.length],
          lane,
          frac: (i + 0.5) / count,
          dir,
          sogKn: 14 + (idx % 5),
          destination: dir === 1 ? (endB ?? "—") : (endA ?? "—"),
          endA, endB,
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
        this.simVessels.push(v);
        idx++;
      }
    }
  }

  // --- per-frame -----------------------------------------------------------------

  tick(nowMs) {
    if (!this.visible) return;
    const dt = this.lastTick ? Math.min((nowMs - this.lastTick) / 1000, 0.5) : 0;
    this.lastTick = nowMs;
    if (dt === 0) return;

    for (const p of this.pulses) {
      p.frac = (p.frac + (PULSE_SPEED_KMS * dt) / p.lane.lengthKm) % 1;
      p.point.position = positionOnLane(p.lane, p.frac);
    }

    if (this.mode === "sim") {
      for (const v of this.simVessels) {
        v.frac += (v.dir * SIM_SPEED_KMS * dt) / v.lane.lengthKm;
        if (v.frac >= 1) { v.frac = 1; v.dir = -1; v.destination = v.endA ?? "—"; }
        else if (v.frac <= 0) { v.frac = 0; v.dir = 1; v.destination = v.endB ?? "—"; }
        v.point.position = positionOnLane(v.lane, v.frac);
        v.headingDeg = headingOnLane(v.lane, v.frac, v.dir);
      }
    } else {
      this._tickLive(nowMs);
    }

    // incremental destination-route construction
    if (this.routesVisible) {
      if (nowMs - this.lastRouteBuild > ROUTE_REBUILD_MS) this._queueRoutes(nowMs);
      let budget = ROUTES_PER_FRAME;
      while (budget-- > 0 && this.routeQueue.length > 0) {
        this._buildRoute(this.routeQueue.shift());
      }
    }
  }

  _tickLive(nowMs) {
    if (this.listDirty) {
      this.list = [...this.vessels.values()];
      this.listDirty = false;
      this.cursor = 0;
    }
    const n = this.list.length;
    if (n === 0) return;

    // dead-reckon a slice of vessels from their last report
    const batch = Math.ceil(n / UPDATE_SLICES);
    for (let i = 0; i < batch; i++) {
      const v = this.list[this.cursor];
      this.cursor = (this.cursor + 1) % n;
      if (!this.vessels.has(v.mmsi)) continue; // evicted mid-sweep
      if ((v.sogKn ?? 0) > 0.3) {
        const dtSec = Math.min((nowMs - v.ts) / 1000, STALE_MS / 1000);
        const [lat2, lon2] = deadReckon(v.lat, v.lon, v.sogKn * 0.5144 * dtSec, v.cogDeg);
        v.point.position = Cesium.Cartesian3.fromDegrees(lon2, lat2, VESSEL_HEIGHT);
      }
    }

    // evict vessels that stopped reporting
    if (nowMs - this.lastSweep > 60 * 1000) {
      this.lastSweep = nowMs;
      for (const [mmsi, v] of this.vessels) {
        if (nowMs - v.ts > STALE_MS) {
          this.vesselPoints.remove(v.point);
          this.vessels.delete(mmsi);
          this.listDirty = true;
        }
      }
    }
  }

  // --- destination routes -----------------------------------------------------------

  _queueRoutes(nowMs) {
    this.routeLines.removeAll();
    this.lastRouteBuild = nowMs;
    if (this.mode === "sim") {
      this.routeQueue = this.simVessels.slice();
    } else {
      const moving = [];
      for (const v of this.vessels.values()) {
        if (!v.destination || (v.sogKn ?? 0) < 0.5) continue;
        const port = resolveDestination(v.destination);
        if (!port) continue;
        v.port = port;
        moving.push(v);
        if (moving.length >= MAX_ROUTES) break;
      }
      this.routeQueue = moving;
    }
  }

  _buildRoute(v) {
    let positions;
    if (v.live) {
      const geodesic = new Cesium.EllipsoidGeodesic(
        Cesium.Cartographic.fromDegrees(v.lon, v.lat),
        Cesium.Cartographic.fromDegrees(v.port.lon, v.port.lat)
      );
      const distKm = geodesic.surfaceDistance / 1000;
      if (distKm < 4) return;
      const samples = clamp(Math.ceil(distKm / 100), 8, 64);
      positions = [];
      for (let i = 0; i <= samples; i++) {
        const c = geodesic.interpolateUsingFraction(i / samples);
        positions.push(Cesium.Cartesian3.fromRadians(c.longitude, c.latitude, LANE_HEIGHT));
      }
    } else {
      // simulated vessels follow their lane to its end
      const idx = Math.round(v.frac * (v.lane.positions.length - 1));
      positions = v.dir === 1
        ? v.lane.positions.slice(idx)
        : v.lane.positions.slice(0, idx + 1).reverse();
      if (positions.length < 2) return;
    }
    this.routeLines.add({
      positions,
      width: 1.6,
      material: Cesium.Material.fromType("PolylineDash", { color: ROUTE_COLOR, dashLength: 14 }),
      id: { kind: "vessel", vessel: v },
    });
  }

  // --- visibility & status ---------------------------------------------------------

  setVisible(v) {
    this.visible = v;
    this.lines.show = v;
    this.pulsePoints.show = v;
    this.vesselPoints.show = v;
    this.routeLines.show = v && this.routesVisible;
  }

  setRoutesVisible(v) {
    this.routesVisible = v;
    this.routeLines.show = v && this.visible;
    if (v) this._queueRoutes(Date.now());
    else { this.routeQueue = []; this.routeLines.removeAll(); this.lastRouteBuild = 0; }
  }

  counts() {
    if (!this.visible) return { count: 0, detail: "", source: this.source };
    const vesselCount = this.mode === "sim" ? this.simVessels.length : this.vessels.size;
    return {
      count: vesselCount,
      detail: `${vesselCount} vessels · ${this.lanes.length} reference lanes`,
      source: this.source,
    };
  }
}

// --- geometry helpers ---------------------------------------------------------------

function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

// Sample a lane's waypoint chain into ~SAMPLE_KM segments along geodesics,
// precomputing per-point headings for simulated vessel tooltips.
function densifyLane(def) {
  const positions = [];
  const headings = [];
  const cartos = def.waypoints.map(([lon, lat]) => Cesium.Cartographic.fromDegrees(lon, lat));
  let lengthM = 0;
  let prevCarto = null;
  for (let i = 0; i < cartos.length - 1; i++) {
    const geo = new Cesium.EllipsoidGeodesic(cartos[i], cartos[i + 1]);
    const segM = geo.surfaceDistance;
    const steps = Math.max(1, Math.ceil(segM / (SAMPLE_KM * 1000)));
    for (let s = 0; s < steps; s++) {
      const c = geo.interpolateUsingFraction(s / steps);
      positions.push(Cesium.Cartesian3.fromRadians(c.longitude, c.latitude, LANE_HEIGHT));
      if (prevCarto) headings.push(bearingDeg(prevCarto, c));
      prevCarto = c;
    }
    lengthM += segM;
  }
  const last = cartos[cartos.length - 1];
  positions.push(Cesium.Cartesian3.fromRadians(last.longitude, last.latitude, LANE_HEIGHT));
  if (prevCarto) headings.push(bearingDeg(prevCarto, last));
  headings.push(headings[headings.length - 1] ?? 0);
  return {
    name: def.name,
    polar: def.polar,
    positions,
    headings,
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

function headingOnLane(lane, frac, dir) {
  const i = Math.min(Math.round(frac * (lane.positions.length - 1)), lane.headings.length - 1);
  const h = lane.headings[i];
  return dir === 1 ? h : (h + 180) % 360;
}

function bearingDeg(fromCarto, toCarto) {
  const dLon = toCarto.longitude - fromCarto.longitude;
  const y = Math.sin(dLon) * Math.cos(toCarto.latitude);
  const x = Math.cos(fromCarto.latitude) * Math.sin(toCarto.latitude) -
    Math.sin(fromCarto.latitude) * Math.cos(toCarto.latitude) * Math.cos(dLon);
  return (Cesium.Math.toDegrees(Math.atan2(y, x)) + 360) % 360;
}

function deadReckon(latDeg, lonDeg, distM, trackDeg) {
  const R = 6371000;
  const d = distM / R;
  const brng = (trackDeg * Math.PI) / 180;
  const la1 = (latDeg * Math.PI) / 180;
  const lo1 = (lonDeg * Math.PI) / 180;
  const la2 = Math.asin(
    Math.sin(la1) * Math.cos(d) + Math.cos(la1) * Math.sin(d) * Math.cos(brng)
  );
  const lo2 = lo1 + Math.atan2(
    Math.sin(brng) * Math.sin(d) * Math.cos(la1),
    Math.cos(d) - Math.sin(la1) * Math.sin(la2)
  );
  return [(la2 * 180) / Math.PI, ((((lo2 * 180) / Math.PI) + 540) % 360) - 180];
}
