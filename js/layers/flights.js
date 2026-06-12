// Flight layer: live aircraft states from OpenSky, dead-reckoned between
// refreshes; demo great-circle traffic between major airports when offline.
// Route arcs: demo flights know origin/destination; live flights are looked
// up on adsbdb by callsign (with a projected-track fallback).

import { makeDemoFlights } from "../demo-data.js";

const OPENSKY_URL = "https://opensky-network.org/api/states/all";
const REFRESH_MS = 120 * 1000;
const MAX_LIVE = 2500;
const UPDATE_SLICES = 60;
const ROUTES_PER_FRAME = 16;

const FLIGHT_COLOR = Cesium.Color.fromCssColorString("#ffb347");
const ROUTE_COLOR = Cesium.Color.fromCssColorString("#ffb347").withAlpha(0.14);
const ACTIVE_ROUTE_COLOR = Cesium.Color.fromCssColorString("#ffd28a").withAlpha(0.9);
const PROJECTED_COLOR = Cesium.Color.fromCssColorString("#ff8a5c").withAlpha(0.8);

export class FlightLayer {
  constructor(viewer) {
    this.viewer = viewer;
    this.points = viewer.scene.primitives.add(new Cesium.PointPrimitiveCollection());
    this.routeLines = viewer.scene.primitives.add(new Cesium.PolylineCollection());
    this.activeRoute = viewer.scene.primitives.add(new Cesium.PolylineCollection());
    this.flights = [];
    this.source = "loading";
    this.visible = true;
    this.routesVisible = false;
    this.cursor = 0;
    this.routeQueue = [];
    this.routeCache = new Map(); // callsign -> {origin, destination} | null
    this.hoverToken = 0;
    this.selected = null;
  }

  async init() {
    const live = await this._fetchLive();
    if (live) {
      this.source = "live";
      this._applyLiveStates(live);
      this.refreshTimer = setInterval(async () => {
        const next = await this._fetchLive();
        if (next) this._applyLiveStates(next);
        // on failure keep extrapolating the last snapshot and retry next tick
      }, REFRESH_MS);
    } else {
      console.warn("[flights] OpenSky unavailable, using demo flights");
      this.source = "demo";
      this._buildDemo();
    }
    this.points.show = this.visible;
  }

  async _fetchLive() {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 25000);
      const res = await fetch(OPENSKY_URL, { signal: ctl.signal });
      clearTimeout(t);
      if (!res.ok) return null;
      const data = await res.json();
      if (!data || !Array.isArray(data.states)) return null;
      return data;
    } catch {
      return null;
    }
  }

  _applyLiveStates(data) {
    const flights = [];
    for (const s of data.states) {
      const [icao24, callsign, country, , lastContact, lon, lat, baroAlt,
        onGround, vel, track, , , geoAlt] = s;
      if (onGround || lon == null || lat == null) continue;
      flights.push({
        live: true,
        icao24,
        callsign: (callsign || "").trim() || icao24.toUpperCase(),
        country,
        lon, lat,
        altM: geoAlt ?? baroAlt ?? 10000,
        velMs: vel ?? 230,
        track: track ?? 0,
        ts: (lastContact ?? data.time) * 1000,
      });
      if (flights.length >= MAX_LIVE) break;
    }

    this.points.removeAll();
    for (const f of flights) {
      f.point = this.points.add({
        position: Cesium.Cartesian3.fromDegrees(f.lon, f.lat, f.altM),
        pixelSize: 3.2,
        color: FLIGHT_COLOR,
        scaleByDistance: new Cesium.NearFarScalar(2.0e5, 2.0, 4.0e7, 0.6),
        id: { kind: "flight", flight: f },
      });
    }
    this.flights = flights;
    this.cursor = 0;
  }

  _buildDemo() {
    const specs = makeDemoFlights(200);
    this.points.removeAll();
    this.flights = [];
    for (const spec of specs) {
      const geodesic = new Cesium.EllipsoidGeodesic(
        Cesium.Cartographic.fromDegrees(spec.from.lon, spec.from.lat),
        Cesium.Cartographic.fromDegrees(spec.to.lon, spec.to.lat)
      );
      const distKm = geodesic.surfaceDistance / 1000;
      if (distKm < 700) continue;
      const f = {
        live: false,
        ...spec,
        geodesic,
        distKm,
        durS: (distKm / spec.speedKmh) * 3600,
      };
      f.point = this.points.add({
        position: this._demoPosition(f, Date.now()),
        pixelSize: 4,
        color: FLIGHT_COLOR,
        scaleByDistance: new Cesium.NearFarScalar(2.0e5, 1.8, 4.0e7, 0.7),
        id: { kind: "flight", flight: f },
      });
      this.flights.push(f);
    }
  }

  _demoPosition(f, nowMs) {
    const elapsed = (nowMs / 1000 + f.phase * f.durS) % f.durS;
    f.frac = elapsed / f.durS;
    const c = f.geodesic.interpolateUsingFraction(f.frac);
    f.lon = Cesium.Math.toDegrees(c.longitude);
    f.lat = Cesium.Math.toDegrees(c.latitude);
    return Cesium.Cartesian3.fromRadians(c.longitude, c.latitude, f.altM);
  }

  tick(nowMs) {
    if (!this.visible || this.flights.length === 0) return;

    const n = this.flights.length;
    const batch = Math.ceil(n / UPDATE_SLICES);
    for (let i = 0; i < batch; i++) {
      const f = this.flights[this.cursor];
      this.cursor = (this.cursor + 1) % n;
      if (f.live) {
        const dt = (nowMs - f.ts) / 1000;
        const [lat2, lon2] = deadReckon(f.lat, f.lon, f.velMs * dt, f.track);
        f.point.position = Cesium.Cartesian3.fromDegrees(lon2, lat2, Math.max(f.altM, 0));
        f.curLat = lat2;
        f.curLon = lon2;
      } else {
        f.point.position = this._demoPosition(f, nowMs);
      }
    }

    // incremental demo-route arc construction
    let budget = ROUTES_PER_FRAME;
    while (budget-- > 0 && this.routeQueue.length > 0) {
      const f = this.routeQueue.shift();
      this.routeLines.add({
        positions: arcPositions(f.geodesic, f.distKm),
        width: 1,
        material: Cesium.Material.fromType("Color", { color: ROUTE_COLOR }),
        id: { kind: "flight", flight: f },
      });
    }
  }

  setVisible(v) {
    this.visible = v;
    this.points.show = v;
    this.routeLines.show = v && this.routesVisible;
    this.activeRoute.show = v;
  }

  setRoutesVisible(v) {
    this.routesVisible = v;
    this.routeLines.show = v && this.visible;
    if (!v) {
      this.activeRoute.removeAll();
      this.selected = null;
    }
    if (v && this.source === "demo" && this.routeLines.length === 0 && this.routeQueue.length === 0) {
      this.routeQueue = this.flights.slice();
    }
  }

  // Hover/selection drives per-flight route display for live data, where the
  // origin/destination must be looked up per callsign.
  async showRouteFor(f, isSelection) {
    if (!this.routesVisible || !f) return;
    if (isSelection) this.selected = f;
    if (!f.live) return; // demo arcs are already drawn collectively

    const token = ++this.hoverToken;
    let route = this.routeCache.get(f.callsign);
    if (route === undefined) {
      route = await lookupRoute(f.callsign);
      this.routeCache.set(f.callsign, route);
    }
    if (token !== this.hoverToken) return; // a newer hover superseded this one

    this.activeRoute.removeAll();
    if (route) {
      const geodesic = new Cesium.EllipsoidGeodesic(
        Cesium.Cartographic.fromDegrees(route.olon, route.olat),
        Cesium.Cartographic.fromDegrees(route.dlon, route.dlat)
      );
      const distKm = geodesic.surfaceDistance / 1000;
      this.activeRoute.add({
        positions: arcPositions(geodesic, distKm),
        width: 2,
        material: Cesium.Material.fromType("Color", { color: ACTIVE_ROUTE_COLOR }),
        id: { kind: "flight", flight: f },
      });
      f.routeLabel = `${route.oname} → ${route.dname}`;
    } else {
      // no published route — project the current track 45 minutes ahead
      const positions = [];
      for (let i = 0; i <= 24; i++) {
        const dist = f.velMs * (i / 24) * 2700;
        const [la, lo] = deadReckon(f.curLat ?? f.lat, f.curLon ?? f.lon, dist, f.track);
        positions.push(Cesium.Cartesian3.fromDegrees(lo, la, f.altM));
      }
      this.activeRoute.add({
        positions,
        width: 1.6,
        material: Cesium.Material.fromType("PolylineDash", { color: PROJECTED_COLOR, dashLength: 12 }),
        id: { kind: "flight", flight: f },
      });
      f.routeLabel = "projected track (route unknown)";
    }
  }

  clearHoverRoute() {
    // keep a clicked flight's route until something else is selected
    if (!this.selected) {
      this.hoverToken++;
      this.activeRoute.removeAll();
    }
  }

  deselect() {
    this.selected = null;
    this.hoverToken++;
    this.activeRoute.removeAll();
  }

  counts() {
    return { count: this.visible ? this.flights.length : 0, source: this.source };
  }
}

// Stylized great-circle arc, gently elevated so routes read at globe scale.
function arcPositions(geodesic, distKm, samples = 48) {
  const apex = Math.min(Math.max(distKm * 25, 40000), 350000); // metres
  const positions = [];
  for (let i = 0; i <= samples; i++) {
    const f = i / samples;
    const c = geodesic.interpolateUsingFraction(f);
    const h = 1000 + apex * Math.sin(Math.PI * f);
    positions.push(Cesium.Cartesian3.fromRadians(c.longitude, c.latitude, h));
  }
  return positions;
}

// Great-circle dead reckoning from a point along a true-track bearing.
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

async function lookupRoute(callsign) {
  if (!callsign || callsign.length < 3) return null;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 8000);
    const res = await fetch(`https://api.adsbdb.com/v0/callsign/${encodeURIComponent(callsign)}`,
      { signal: ctl.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    const data = await res.json();
    const fr = data?.response?.flightroute;
    if (!fr?.origin || !fr?.destination) return null;
    return {
      olat: fr.origin.latitude, olon: fr.origin.longitude,
      oname: fr.origin.iata_code || fr.origin.name,
      dlat: fr.destination.latitude, dlon: fr.destination.longitude,
      dname: fr.destination.iata_code || fr.destination.name,
    };
  } catch {
    return null;
  }
}
