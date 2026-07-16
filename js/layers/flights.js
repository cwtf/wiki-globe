// Flight layer: live aircraft states from OpenSky, dead-reckoned between
// refreshes; demo great-circle traffic between major airports when offline.
// OpenSky's CORS policy blocks direct browser reads from any other origin, so
// without a configured proxy (see proxy/README.md) the global view shows demo
// arcs — but when the camera zooms below REGIONAL_ENTER_M, real aircraft
// around the view are fetched keylessly from airplanes.live (CORS-open,
// 250 nm point queries) and replace the demo traffic.
// Route arcs: demo flights know origin/destination; live flights are looked
// up on adsbdb by callsign (with a projected-track fallback).

import { makeDemoFlights } from "../demo-data.js";
import { loadAirportsData, lookupAirport } from "../airports-data.js";

const DEFAULT_OPENSKY_URL = "https://opensky-network.org/api/states/all";
const OPENSKY_URL = configuredOpenSkyUrl();
const REFRESH_MS = 120 * 1000;
const CORS_RETRY_MS = 60 * 60 * 1000;
const ERROR_RETRY_MS = 5 * 60 * 1000;
const MAX_LIVE = 2500;
const UPDATE_SLICES = 60;
const ROUTES_PER_FRAME = 16;

// Keyless regional live mode (airplanes.live) used while OpenSky is unreachable
const REGIONAL_URL = "https://api.airplanes.live/v2/point";
const REGIONAL_RADIUS_NM = 250;          // API maximum
const REGIONAL_REFRESH_MS = 15 * 1000;   // well under the ~1 req/s anonymous limit
const REGIONAL_ERROR_MS = 60 * 1000;
const REGIONAL_ENTER_M = 1.8e6;          // camera height to switch demo -> regional live
const REGIONAL_EXIT_M = 2.2e6;           // hysteresis so the boundary doesn't flicker

const FLIGHT_COLOR = Cesium.Color.fromCssColorString("#ffb347");
const ROUTE_COLOR = Cesium.Color.fromCssColorString("#ffb347").withAlpha(0.14);
const ACTIVE_ROUTE_COLOR = Cesium.Color.fromCssColorString("#ffd28a").withAlpha(0.9);
const PROJECTED_COLOR = Cesium.Color.fromCssColorString("#ff8a5c").withAlpha(0.8);

export class FlightLayer {
  constructor(viewer) {
    this.viewer = viewer;
    this.points = viewer.scene.primitives.add(new Cesium.PointPrimitiveCollection());
    this.regionalPoints = viewer.scene.primitives.add(new Cesium.PointPrimitiveCollection());
    this.routeLines = viewer.scene.primitives.add(new Cesium.PolylineCollection());
    this.activeRoute = viewer.scene.primitives.add(new Cesium.PolylineCollection());
    this.flights = [];
    this.regional = [];
    this.regionalActive = false;
    this.regionalCursor = 0;
    this.nextRegionalFetch = 0;
    this.source = "loading";
    this.visible = true;
    this.routesVisible = false;
    this.cursor = 0;
    this.routeQueue = [];
    this.routeCache = new Map(); // callsign -> {origin, destination} | null
    this.hoverToken = 0;
    this.selected = null;
    this.nextLiveAttempt = 0;
    this.statusDetail = "Loading OpenSky aircraft states";
  }

  async init() {
    loadAirportsData(); // fire-and-forget; lookupAirport returns null until loaded
    const result = await this._fetchLive();
    if (result.data) {
      this.source = "live";
      this.statusDetail = "OpenSky live aircraft states";
      this._applyLiveStates(result.data);
    } else {
      console.warn(`[flights] ${result.detail}`);
      this.source = result.source;
      this.statusDetail = result.detail;
      this._buildDemo();
    }
    // one timer both refreshes live states and re-tries OpenSky from demo mode
    this.refreshTimer = setInterval(() => this._refresh(), REFRESH_MS);
    this._syncShow();
  }

  async _refresh() {
    const next = await this._fetchLive();
    // on failure keep extrapolating the last snapshot (or keep the demo
    // traffic animating) and retry on the next tick
    if (!next.data) {
      if (next.source === "limited" || this.source !== "live") {
        this.source = next.source;
        this.statusDetail = next.detail;
      }
      return;
    }
    if (this.source !== "live") {
      // retire the demo arcs; live routes are drawn per hover/selection
      this.routeQueue = [];
      this.routeLines.removeAll();
      this.activeRoute.removeAll();
      this.selected = null;
      this.hoverToken++;
      console.info("[flights] OpenSky recovered, demo flights retired");
    }
    this.source = "live";
    this.statusDetail = "OpenSky live aircraft states";
    this._applyLiveStates(next.data);
  }

  async _fetchLive() {
    if (Date.now() < this.nextLiveAttempt) {
      return {
        source: this.source === "limited" ? "limited" : this.source,
        detail: this.statusDetail,
      };
    }

    if (isDirectOpenSkyBlockedByCors()) {
      this.nextLiveAttempt = Date.now() + CORS_RETRY_MS;
      return {
        source: "blocked",
        detail: "OpenSky does not allow this browser origin to read states/all; demo arcs at global zoom, live aircraft via airplanes.live when zoomed in. Configure an OpenSky proxy URL for global live flights.",
      };
    }

    let timeout = null;
    try {
      const ctl = new AbortController();
      timeout = setTimeout(() => ctl.abort(), 25000);
      const res = await fetch(OPENSKY_URL, { signal: ctl.signal });
      if (!res.ok) {
        if (res.status === 429) {
          const retrySeconds = Number(res.headers.get("x-rate-limit-retry-after-seconds"));
          this.nextLiveAttempt = Date.now() + (
            Number.isFinite(retrySeconds) && retrySeconds > 0
              ? retrySeconds * 1000
              : ERROR_RETRY_MS
          );
          return {
            source: "limited",
            detail: "OpenSky rate limit reached; using demo flights until the quota window reopens.",
          };
        }
        this.nextLiveAttempt = Date.now() + ERROR_RETRY_MS;
        return {
          source: "demo",
          detail: `OpenSky returned HTTP ${res.status}; using demo flights.`,
        };
      }
      const data = await res.json();
      if (!data || !Array.isArray(data.states)) {
        this.nextLiveAttempt = Date.now() + ERROR_RETRY_MS;
        return {
          source: "demo",
          detail: "OpenSky returned an unexpected response; using demo flights.",
        };
      }
      this.nextLiveAttempt = 0;
      return { data };
    } catch (e) {
      this.nextLiveAttempt = Date.now() + ERROR_RETRY_MS;
      const reason = e?.name === "AbortError"
        ? "OpenSky request timed out"
        : "OpenSky request failed";
      return {
        source: "demo",
        detail: `${reason}; using demo flights.`,
      };
    } finally {
      if (timeout) clearTimeout(timeout);
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
    if (!this.visible) return;
    this._regionalTick(nowMs);

    const n = this.flights.length;
    const batch = n === 0 ? 0 : Math.ceil(n / UPDATE_SLICES);
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

    const rn = this.regional.length;
    const rbatch = this.regionalActive && rn > 0 ? Math.ceil(rn / UPDATE_SLICES) : 0;
    for (let i = 0; i < rbatch; i++) {
      const f = this.regional[this.regionalCursor];
      this.regionalCursor = (this.regionalCursor + 1) % rn;
      const dt = (nowMs - f.ts) / 1000;
      const [lat2, lon2] = deadReckon(f.lat, f.lon, f.velMs * dt, f.track);
      f.point.position = Cesium.Cartesian3.fromDegrees(lon2, lat2, Math.max(f.altM, 0));
      f.curLat = lat2;
      f.curLon = lon2;
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

  // --- regional live mode (airplanes.live) -----------------------------------

  // Runs every frame while visible: switches between global demo traffic and
  // real aircraft around the camera, and paces the regional fetches.
  _regionalTick(nowMs) {
    if (this.source === "live") {
      if (this.regionalActive) this._setRegionalActive(false);
      return;
    }
    const carto = this.viewer.camera.positionCartographic;
    if (!carto) return;
    if (!this.regionalActive && carto.height < REGIONAL_ENTER_M) this._setRegionalActive(true);
    else if (this.regionalActive && carto.height > REGIONAL_EXIT_M) this._setRegionalActive(false);
    if (!this.regionalActive || this._regionalInFlight || nowMs < this.nextRegionalFetch) return;
    this._fetchRegional(
      Cesium.Math.toDegrees(carto.latitude),
      Cesium.Math.toDegrees(carto.longitude)
    );
  }

  _setRegionalActive(on) {
    this.regionalActive = on;
    if (on) this.nextRegionalFetch = 0; // fetch immediately on entry
    this._syncShow();
  }

  async _fetchRegional(lat, lon) {
    this._regionalInFlight = true;
    let timeout = null;
    try {
      const ctl = new AbortController();
      timeout = setTimeout(() => ctl.abort(), 10000);
      const res = await fetch(
        `${REGIONAL_URL}/${lat.toFixed(3)}/${lon.toFixed(3)}/${REGIONAL_RADIUS_NM}`,
        { signal: ctl.signal }
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!Array.isArray(data?.ac)) throw new Error("unexpected response");
      this._applyRegional(data.ac);
      this.nextRegionalFetch = Date.now() + REGIONAL_REFRESH_MS;
    } catch {
      this.nextRegionalFetch = Date.now() + REGIONAL_ERROR_MS;
    } finally {
      if (timeout) clearTimeout(timeout);
      this._regionalInFlight = false;
    }
  }

  _applyRegional(ac) {
    const now = Date.now();
    const flights = [];
    for (const a of ac) {
      if (a.lat == null || a.lon == null || a.alt_baro === "ground") continue;
      const altFt = typeof a.alt_geom === "number" ? a.alt_geom
        : typeof a.alt_baro === "number" ? a.alt_baro : 33000;
      flights.push({
        live: true,
        regional: true,
        icao24: a.hex,
        callsign: (a.flight ?? "").trim() || (a.r ?? "").trim() || (a.hex ?? "").toUpperCase(),
        country: a.desc || a.t || "",
        lat: a.lat,
        lon: a.lon,
        altM: altFt * 0.3048,
        velMs: (a.gs ?? 450) * 0.51444,
        track: a.track ?? a.true_heading ?? 0,
        ts: now - (a.seen_pos ?? 0) * 1000,
      });
    }
    this.regionalPoints.removeAll();
    for (const f of flights) {
      f.point = this.regionalPoints.add({
        position: Cesium.Cartesian3.fromDegrees(f.lon, f.lat, f.altM),
        pixelSize: 3.6,
        color: FLIGHT_COLOR,
        scaleByDistance: new Cesium.NearFarScalar(2.0e5, 2.0, 4.0e7, 0.6),
        id: { kind: "flight", flight: f },
      });
    }
    this.regional = flights;
    this.regionalCursor = 0;
  }

  // ----------------------------------------------------------------------------

  _syncShow() {
    this.points.show = this.visible && !this.regionalActive;
    this.regionalPoints.show = this.visible && this.regionalActive;
    // demo route arcs are global-scale clutter under regional live traffic
    this.routeLines.show = this.visible && this.routesVisible && !this.regionalActive;
    this.activeRoute.show = this.visible;
  }

  setVisible(v) {
    this.visible = v;
    this._syncShow();
  }

  setRoutesVisible(v) {
    this.routesVisible = v;
    if (!v) {
      this.activeRoute.removeAll();
      this.selected = null;
    }
    // any non-live source means the demo fleet is flying (incl. CORS-blocked)
    if (v && this.source !== "live" && this.routeLines.length === 0 && this.routeQueue.length === 0) {
      this.routeQueue = this.flights.slice();
    }
    this._syncShow();
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
    if (this.visible && this.regionalActive) {
      return {
        count: this.regional.length,
        source: "live",
        detail: `airplanes.live aircraft within ${REGIONAL_RADIUS_NM} nm of the view; zoom out for global demo arcs`,
      };
    }
    return {
      count: this.visible ? this.flights.length : 0,
      // "blocked" would auto-hide the layer; demo arcs + zoom-in live is the
      // intended default experience, so report it as demo
      source: this.source === "blocked" ? "demo" : this.source,
      detail: this.statusDetail,
    };
  }
}

function configuredOpenSkyUrl() {
  if (typeof window === "undefined") return DEFAULT_OPENSKY_URL;
  let stored = null;
  try {
    stored = window.localStorage.getItem("wikiGlobeOpenSkyUrl");
  } catch {
    stored = null;
  }
  const params = new URLSearchParams(window.location.search);
  return (
    cleanUrl(window.WIKI_GLOBE_OPENSKY_URL) ||
    cleanUrl(params.get("openskyUrl")) ||
    cleanUrl(stored) ||
    DEFAULT_OPENSKY_URL
  );
}

function cleanUrl(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isDirectOpenSkyBlockedByCors() {
  if (typeof window === "undefined" || OPENSKY_URL !== DEFAULT_OPENSKY_URL) return false;
  return window.location.origin !== "https://opensky-network.org";
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
    // Enrich names with OurAirports municipality data when available
    const oAp = lookupAirport(fr.origin.icao_code || fr.origin.name);
    const dAp = lookupAirport(fr.destination.icao_code || fr.destination.name);
    return {
      olat: fr.origin.latitude, olon: fr.origin.longitude,
      oname: oAp?.municipality ? `${fr.origin.iata_code || oAp.name} (${oAp.municipality})` : (fr.origin.iata_code || fr.origin.name),
      dlat: fr.destination.latitude, dlon: fr.destination.longitude,
      dname: dAp?.municipality ? `${fr.destination.iata_code || dAp.name} (${dAp.municipality})` : (fr.destination.iata_code || fr.destination.name),
    };
  } catch {
    return null;
  }
}
