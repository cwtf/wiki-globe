import { loadCountryGeo } from "../country-geo.js";

const AGENT_MARKER = "agent-session";
const PIN_COLOR = Cesium.Color.fromCssColorString("#facc15");
const ROUTE_COLOR = Cesium.Color.fromCssColorString("#facc15").withAlpha(0.72);
const HIGHLIGHT_COLOR = Cesium.Color.fromCssColorString("#6ef3ff").withAlpha(0.92);
const DEFAULT_HEIGHT_M = 2800;
const MAX_ROUTE_POINTS = 24;

export const OK_STATUS = "ok";
export const NO_DATA_STATUS = "no_data";

export function noData(reason, detail = null) {
  return { status: NO_DATA_STATUS, reason, detail, data: null };
}

export function ok(data = {}) {
  return { status: OK_STATUS, data };
}

export function isNoDataResult(result) {
  return result?.status === NO_DATA_STATUS;
}

export class AgentToolRegistry {
  constructor(viewer) {
    this.viewer = viewer;
    this.entities = new Set();
    this.sessionId = globalThis.crypto?.randomUUID?.() ?? String(Date.now());
    this.networkQueue = new ThrottleQueue();
  }

  schemas() {
    return [
      {
        type: "function",
        function: {
          name: "add_pin",
          description: "Add an agent-owned pin and optional label to the Earth globe at latitude/longitude.",
          parameters: {
            type: "object",
            properties: {
              lat: { type: "number", minimum: -90, maximum: 90 },
              lon: { type: "number", minimum: -180, maximum: 180 },
              label: { type: "string" },
            },
            required: ["lat", "lon"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "highlight_country",
          description: "Outline one present-day country by ISO-3166 alpha-3 code. Use only for current country borders already in the local country dataset.",
          parameters: {
            type: "object",
            properties: {
              iso3: { type: "string", minLength: 3, maxLength: 3 },
              color: { type: "string", description: "Optional CSS color for the outline." },
            },
            required: ["iso3"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "draw_route",
          description: "Draw an agent-owned geodesic route through ordered latitude/longitude points.",
          parameters: {
            type: "object",
            properties: {
              points: {
                type: "array",
                minItems: 2,
                maxItems: MAX_ROUTE_POINTS,
                items: {
                  type: "object",
                  properties: {
                    lat: { type: "number", minimum: -90, maximum: 90 },
                    lon: { type: "number", minimum: -180, maximum: 180 },
                  },
                  required: ["lat", "lon"],
                },
              },
              label: { type: "string" },
            },
            required: ["points"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "clear_agent_overlays",
          description: "Clear only overlays created by this agent session. Does not touch user or layer entities.",
          parameters: {
            type: "object",
            properties: {},
          },
        },
      },
    ];
  }

  async execute(name, args) {
    if (name === "add_pin") return this.addPin(args);
    if (name === "highlight_country") return this.highlightCountry(args);
    if (name === "draw_route") return this.drawRoute(args);
    if (name === "clear_agent_overlays") return this.clearAgentOverlays();
    return noData(`Unknown tool: ${name}`);
  }

  addPin({ lat, lon, label = "" }) {
    if (!validLatLon(lat, lon)) return noData("Pin coordinates are outside valid latitude/longitude bounds.");
    const entity = this._track(this.viewer.entities.add({
      position: Cesium.Cartesian3.fromDegrees(lon, lat, DEFAULT_HEIGHT_M),
      point: {
        pixelSize: 12,
        color: PIN_COLOR,
        outlineColor: Cesium.Color.BLACK.withAlpha(0.72),
        outlineWidth: 2,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      label: label ? {
        text: String(label).slice(0, 80),
        font: "12px Segoe UI, sans-serif",
        fillColor: Cesium.Color.WHITE,
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 3,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        pixelOffset: new Cesium.Cartesian2(0, -26),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      } : undefined,
      properties: { kind: "agent", tool: "add_pin", label },
    }));
    return ok({ entityId: entity.id, lat, lon, label });
  }

  async highlightCountry({ iso3, color = null }) {
    const id = String(iso3 ?? "").trim().toUpperCase();
    if (!id) return noData("Missing ISO3 country code.");
    const geo = await loadCountryGeo();
    const country = geo.find((feature) => feature.id === id);
    if (!country) return noData(`No present-day country polygon found for ISO3 ${id}.`);
    const material = safeColor(color, HIGHLIGHT_COLOR);
    let count = 0;
    for (const ring of country.rings) {
      if (ring.length < 2) continue;
      this._track(this.viewer.entities.add({
        polyline: {
          positions: ring.map(([lon, lat]) => Cesium.Cartesian3.fromDegrees(lon, lat, DEFAULT_HEIGHT_M)),
          width: 3,
          material,
          arcType: Cesium.ArcType.GEODESIC,
        },
        properties: { kind: "agent", tool: "highlight_country", iso3: id },
      }));
      count++;
    }
    return count
      ? ok({ iso3: id, name: country.name, rings: count })
      : noData(`Country ${id} had no drawable rings.`);
  }

  drawRoute({ points, label = "" }) {
    if (!Array.isArray(points) || points.length < 2) {
      return noData("A route needs at least two valid points.");
    }
    const clean = points
      .slice(0, MAX_ROUTE_POINTS)
      .map((point) => ({ lat: Number(point.lat), lon: Number(point.lon) }))
      .filter((point) => validLatLon(point.lat, point.lon));
    if (clean.length < 2) return noData("A route needs at least two valid points.");

    const positions = [];
    for (let i = 0; i < clean.length - 1; i++) {
      const a = clean[i];
      const b = clean[i + 1];
      const geodesic = new Cesium.EllipsoidGeodesic(
        Cesium.Cartographic.fromDegrees(a.lon, a.lat),
        Cesium.Cartographic.fromDegrees(b.lon, b.lat)
      );
      const samples = Math.max(8, Math.min(96, Math.ceil(geodesic.surfaceDistance / 120000)));
      for (let s = 0; s <= samples; s++) {
        if (i > 0 && s === 0) continue;
        const c = geodesic.interpolateUsingFraction(s / samples);
        positions.push(Cesium.Cartesian3.fromRadians(c.longitude, c.latitude, DEFAULT_HEIGHT_M));
      }
    }

    const entity = this._track(this.viewer.entities.add({
      polyline: {
        positions,
        width: 2.4,
        material: new Cesium.PolylineGlowMaterialProperty({
          color: ROUTE_COLOR,
          glowPower: 0.18,
          taperPower: 0.9,
        }),
        arcType: Cesium.ArcType.GEODESIC,
      },
      properties: { kind: "agent", tool: "draw_route", label },
    }));
    return ok({ entityId: entity.id, pointCount: clean.length, label });
  }

  clearAgentOverlays() {
    const count = this.entities.size;
    for (const entity of this.entities) this.viewer.entities.remove(entity);
    this.entities.clear();
    return ok({ cleared: count });
  }

  _track(entity) {
    entity[AGENT_MARKER] = this.sessionId;
    this.entities.add(entity);
    return entity;
  }
}

export class ThrottleQueue {
  constructor({ minDelayMs = 1100 } = {}) {
    this.minDelayMs = minDelayMs;
    this.lastRun = 0;
    this.tail = Promise.resolve();
  }

  enqueue(task) {
    this.tail = this.tail.then(async () => {
      const waitMs = Math.max(0, this.minDelayMs - (Date.now() - this.lastRun));
      if (waitMs) await delay(waitMs);
      this.lastRun = Date.now();
      return task();
    });
    return this.tail;
  }
}

function validLatLon(lat, lon) {
  return Number.isFinite(lat) && Number.isFinite(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
}

function safeColor(value, fallback) {
  if (!value) return fallback;
  try { return Cesium.Color.fromCssColorString(value).withAlpha(0.92); } catch { return fallback; }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
