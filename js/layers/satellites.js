// Satellite layer: live TLEs from CelesTrak propagated with SGP4 (satellite.js),
// falling back to synthetic-but-plausible demo orbits when offline.

import { makeDemoSatellites } from "../demo-data.js";

const TLE_URL = "https://celestrak.org/NORAD/elements/gp.php?GROUP=visual&FORMAT=tle";
const MAX_SATS = 300;
const UPDATE_SLICES = 40;        // frames to cycle through all sats once
const PATH_SAMPLES = 96;         // points per predicted orbit
const PATH_REBUILD_MS = 8 * 60 * 1000;
const PATHS_PER_FRAME = 12;      // incremental path building budget
const LIVE_RETRY_MS = 5 * 60 * 1000; // re-try CelesTrak while on demo orbits

const RE_KM = 6371;
const MU = 398600.4418;          // km^3/s^2
const OMEGA_E = 7.2921159e-5;    // earth rotation rad/s

const SAT_COLOR = Cesium.Color.fromCssColorString("#6ef3ff");
const PATH_COLOR = Cesium.Color.fromCssColorString("#6ef3ff").withAlpha(0.16);
const SELECTED_PATH_COLOR = Cesium.Color.fromCssColorString("#aef8ff").withAlpha(0.85);

export class SatelliteLayer {
  constructor(viewer) {
    this.viewer = viewer;
    this.points = viewer.scene.primitives.add(new Cesium.PointPrimitiveCollection());
    this.paths = viewer.scene.primitives.add(new Cesium.PolylineCollection());
    this.selectedPath = viewer.scene.primitives.add(new Cesium.PolylineCollection());
    this.sats = [];
    this.source = "loading";
    this.visible = true;
    this.pathsVisible = false;
    this.cursor = 0;
    this.pathQueue = [];
    this.lastPathBuild = 0;
    this.selected = null;
  }

  async init() {
    const parsed = await this._fetchTLEs();
    if (parsed) {
      this._build(parsed.slice(0, MAX_SATS), "live");
    } else {
      console.warn("[satellites] CelesTrak unavailable, using demo orbits until it responds");
      this._build(makeDemoSatellites().map((s) => ({ ...s, demo: true })), "demo");
      this.retryTimer = setInterval(() => this._retryLive(), LIVE_RETRY_MS);
    }
    this.points.show = this.visible;
  }

  async _fetchTLEs() {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 12000);
      const res = await fetch(TLE_URL, { signal: ctl.signal });
      clearTimeout(t);
      if (res.ok) {
        const parsed = parseTLEs(await res.text());
        if (parsed.length > 10) return parsed;
      }
    } catch (e) {
      console.warn("[satellites] CelesTrak fetch failed:", e.message);
    }
    return null;
  }

  _build(sats, source) {
    this.sats = sats;
    this.source = source;
    const now = new Date();
    const gmst = satellite.gstime(now);
    for (const s of this.sats) {
      const p = this._position(s, now, gmst);
      s.point = this.points.add({
        position: p ? p.cart : Cesium.Cartesian3.fromDegrees(0, 0, 4e5),
        pixelSize: 5,
        color: SAT_COLOR,
        scaleByDistance: new Cesium.NearFarScalar(2.0e5, 1.6, 4.0e7, 0.65),
        id: { kind: "sat", sat: s },
        show: !!p,
      });
      if (p) s.altKm = p.altKm;
    }
  }

  // Periodic re-attempt while on demo orbits, so a session that started
  // offline swaps to the real constellation once CelesTrak is reachable.
  async _retryLive() {
    const parsed = await this._fetchTLEs();
    if (!parsed) return;
    clearInterval(this.retryTimer);
    this.retryTimer = null;
    this.points.removeAll();
    this.paths.removeAll();
    this.selectedPath.removeAll();
    this.selected = null;
    this.pathQueue = [];
    this.cursor = 0;
    this._build(parsed.slice(0, MAX_SATS), "live");
    if (this.pathsVisible) this._queueAllPaths(Date.now());
    console.info("[satellites] CelesTrak recovered, demo orbits retired");
  }

  // ECEF position (m) at a given time; null if propagation fails.
  _position(s, date, gmst) {
    if (s.demo) {
      const t = date.getTime() / 1000;
      const a = RE_KM + s.altKm;
      const n = Math.sqrt(MU / (a * a * a)); // rad/s
      const M = s.m0 + n * t;
      const raan = s.raan0 - OMEGA_E * t;
      const x = a * Math.cos(M);
      const y = a * Math.sin(M);
      const yi = y * Math.cos(s.inc);
      const zi = y * Math.sin(s.inc);
      const X = x * Math.cos(raan) - yi * Math.sin(raan);
      const Y = x * Math.sin(raan) + yi * Math.cos(raan);
      return { cart: new Cesium.Cartesian3(X * 1000, Y * 1000, zi * 1000), altKm: s.altKm };
    }
    const pv = satellite.propagate(s.satrec, date);
    if (!pv || !pv.position) return null;
    const ecf = satellite.eciToEcf(pv.position, gmst);
    const r = Math.sqrt(ecf.x * ecf.x + ecf.y * ecf.y + ecf.z * ecf.z);
    return {
      cart: new Cesium.Cartesian3(ecf.x * 1000, ecf.y * 1000, ecf.z * 1000),
      altKm: r - RE_KM,
    };
  }

  _periodSec(s) {
    if (s.demo) {
      const a = RE_KM + s.altKm;
      return 2 * Math.PI * Math.sqrt((a * a * a) / MU);
    }
    return (2 * Math.PI) / s.satrec.no * 60; // satrec.no is rad/min
  }

  _buildPath(s, color, collection) {
    const periodMs = this._periodSec(s) * 1000;
    const start = Date.now();
    const positions = [];
    for (let i = 0; i <= PATH_SAMPLES; i++) {
      const d = new Date(start + (i / PATH_SAMPLES) * periodMs);
      const p = this._position(s, d, satellite.gstime(d));
      if (p) positions.push(p.cart);
    }
    if (positions.length < 2) return null;
    return collection.add({
      positions,
      width: 1,
      material: Cesium.Material.fromType("Color", { color }),
      id: { kind: "sat", sat: s },
    });
  }

  tick(nowMs) {
    if (!this.visible || this.sats.length === 0) return;

    // round-robin position refresh — full sweep every UPDATE_SLICES frames
    const n = this.sats.length;
    const batch = Math.ceil(n / UPDATE_SLICES);
    const date = new Date(nowMs);
    const gmst = satellite.gstime(date);
    for (let i = 0; i < batch; i++) {
      const s = this.sats[this.cursor];
      this.cursor = (this.cursor + 1) % n;
      const p = this._position(s, date, gmst);
      if (p) {
        s.point.position = p.cart;
        s.point.show = true;
        s.altKm = p.altKm;
      } else {
        s.point.show = false;
      }
    }

    // incremental orbit-path construction so we never block a frame
    if (this.pathsVisible) {
      if (nowMs - this.lastPathBuild > PATH_REBUILD_MS) this._queueAllPaths(nowMs);
      let budget = PATHS_PER_FRAME;
      while (budget-- > 0 && this.pathQueue.length > 0) {
        this._buildPath(this.pathQueue.shift(), PATH_COLOR, this.paths);
      }
    }
  }

  _queueAllPaths(nowMs) {
    this.paths.removeAll();
    this.pathQueue = this.sats.slice();
    this.lastPathBuild = nowMs;
  }

  setVisible(v) {
    this.visible = v;
    this.points.show = v;
    this.paths.show = v && this.pathsVisible;
    this.selectedPath.show = v;
  }

  setPathsVisible(v) {
    this.pathsVisible = v;
    this.paths.show = v && this.visible;
    if (v && this.paths.length === 0 && this.pathQueue.length === 0 && this.sats.length) {
      this._queueAllPaths(Date.now());
    }
  }

  // Clicking a satellite highlights its own predicted orbit even when the
  // layer-wide paths toggle is off.
  select(sat) {
    this.selectedPath.removeAll();
    this.selected = sat;
    if (sat) this._buildPath(sat, SELECTED_PATH_COLOR, this.selectedPath);
  }

  counts() {
    return { count: this.visible ? this.sats.length : 0, source: this.source };
  }
}

function parseTLEs(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.length > 0);
  const sats = [];
  for (let i = 0; i + 2 < lines.length + 1; i++) {
    if (lines[i + 1] && lines[i + 1].startsWith("1 ") && lines[i + 2] && lines[i + 2].startsWith("2 ")) {
      try {
        const satrec = satellite.twoline2satrec(lines[i + 1], lines[i + 2]);
        if (satrec && satrec.error === 0) {
          sats.push({ name: lines[i].trim(), satrec });
        }
      } catch { /* skip malformed entries */ }
      i += 2;
    }
  }
  return sats;
}
