import { loadCountryGeo } from "../country-geo.js";

const AGENT_MARKER = "agent-session";
const PIN_COLOR = Cesium.Color.fromCssColorString("#facc15");
const ROUTE_COLOR = Cesium.Color.fromCssColorString("#facc15").withAlpha(0.72);
const HIGHLIGHT_COLOR = Cesium.Color.fromCssColorString("#6ef3ff").withAlpha(0.92);
const DEFAULT_HEIGHT_M = 2800;
const LABEL_HEIGHT_M = 5200;
const MAX_ROUTE_POINTS = 24;
const MAX_COUNTRY_LABELS = 250;
const WIKIPEDIA_API_URL = "https://en.wikipedia.org/w/api.php";
const WIKIPEDIA_SUMMARY_URL = "https://en.wikipedia.org/api/rest_v1/page/summary/";
const DEFAULT_WIKI_LIMIT = 5;
const WIKIDATA_SPARQL_URL = "https://query.wikidata.org/sparql";
const DEFAULT_SPARQL_LIMIT = 100;
const MAX_SPARQL_LIMIT = 300;
const NOMINATIM_SEARCH_URL = "https://nominatim.openstreetmap.org/search";
const DEFAULT_GEOCODE_LIMIT = 5;
const MAX_GEOCODE_LIMIT = 5;

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
          name: "wiki_search",
          description: "Search English Wikipedia for relevant page titles. Use this for fuzzy concepts or contested prose-list facts when no structured Wikidata property tool fits.",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string", minLength: 1 },
              limit: { type: "integer", minimum: 1, maximum: 10, description: "Maximum number of candidate pages to return." },
            },
            required: ["query"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "wiki_extract",
          description: "Fetch a concise English Wikipedia REST summary for an exact page title returned by wiki_search or supplied by the user.",
          parameters: {
            type: "object",
            properties: {
              title: { type: "string", minLength: 1 },
            },
            required: ["title"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "wikidata_sparql",
          description: "Run a read-only Wikidata SPARQL SELECT query for structured facts. Prefer this over wiki_search whenever the fact is a scalar per-entity property at scale, such as country calling codes (P474), area (P2046), population, coordinates, identifiers, or other Wikidata properties. Include labels and a LIMIT in the query when possible.",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string", minLength: 1, description: "A read-only SPARQL SELECT query for Wikidata Query Service." },
              limit: { type: "integer", minimum: 1, maximum: MAX_SPARQL_LIMIT, description: "Maximum rows returned to the model; appended as LIMIT when the query has no LIMIT." },
            },
            required: ["query"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "geocode",
          description: "Forward-geocode a named place with Nominatim search and return candidate latitude/longitude points. Use this to turn place names into coordinates before add_pin or draw_route; results are throttled because the public Nominatim service is rate-limited.",
          parameters: {
            type: "object",
            properties: {
              placeName: { type: "string", minLength: 1 },
              limit: { type: "integer", minimum: 1, maximum: MAX_GEOCODE_LIMIT, description: "Maximum number of candidate places to return." },
            },
            required: ["placeName"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "label_countries",
          description: "Add agent-owned text labels to present-day countries by ISO-3166 alpha-3 code. Use this after structured tools like wikidata_sparql return per-country scalar facts. Labels use distance-based culling so dense maps stay readable at globe zoom.",
          parameters: {
            type: "object",
            properties: {
              labels: {
                type: "object",
                description: "Map of ISO3 country code to short label text.",
                additionalProperties: { type: "string" },
              },
              color: { type: "string", description: "Optional CSS label color." },
            },
            required: ["labels"],
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
    if (name === "wiki_search") return this.wikiSearch(args);
    if (name === "wiki_extract") return this.wikiExtract(args);
    if (name === "wikidata_sparql") return this.wikidataSparql(args);
    if (name === "geocode") return this.geocode(args);
    if (name === "label_countries") return this.labelCountries(args);
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

  async wikiSearch({ query, limit = DEFAULT_WIKI_LIMIT }) {
    const q = String(query ?? "").trim();
    if (!q) return noData("Missing Wikipedia search query.");
    const n = clampInteger(limit, 1, 10, DEFAULT_WIKI_LIMIT);
    const url = new URL(WIKIPEDIA_API_URL);
    url.search = new URLSearchParams({
      action: "query",
      list: "search",
      srsearch: q,
      srlimit: String(n),
      srprop: "snippet",
      format: "json",
      origin: "*",
    });
    const res = await this.networkQueue.enqueue(() => fetch(url));
    if (!res.ok) return noData(`Wikipedia search HTTP ${res.status}.`);
    const data = await res.json();
    const hits = data?.query?.search ?? [];
    if (hits.length === 0) return noData(`No relevant Wikipedia pages found for "${q}".`);
    return ok({
      query: q,
      results: hits.map((hit) => ({
        title: hit.title,
        pageId: hit.pageid,
        snippet: stripHtml(hit.snippet ?? ""),
        url: wikiArticleUrl(hit.title),
      })),
    });
  }

  async wikiExtract({ title }) {
    const t = String(title ?? "").trim();
    if (!t) return noData("Missing Wikipedia page title.");
    const res = await this.networkQueue.enqueue(() => fetch(`${WIKIPEDIA_SUMMARY_URL}${encodeURIComponent(t)}`));
    if (res.status === 404) return noData(`No Wikipedia summary found for "${t}".`);
    if (!res.ok) return noData(`Wikipedia summary HTTP ${res.status}.`);
    const summary = await res.json();
    if (summary.type === "disambiguation") {
      return noData(`"${summary.title ?? t}" is a disambiguation page; use wiki_search to choose a specific page.`);
    }
    const extract = String(summary.extract ?? "").trim();
    if (!extract) return noData(`Wikipedia summary for "${summary.title ?? t}" had no extract.`);
    return ok({
      title: summary.title ?? t,
      extract,
      description: summary.description ?? "",
      url: summary.content_urls?.desktop?.page ?? wikiArticleUrl(summary.title ?? t),
      lat: summary.coordinates?.lat ?? null,
      lon: summary.coordinates?.lon ?? null,
    });
  }

  async wikidataSparql({ query, limit = DEFAULT_SPARQL_LIMIT }) {
    const q = String(query ?? "").trim();
    if (!q) return noData("Missing Wikidata SPARQL query.");
    if (!isSelectSparql(q)) return noData("Wikidata SPARQL tool only accepts read-only SELECT queries.");
    const rowLimit = clampInteger(limit, 1, MAX_SPARQL_LIMIT, DEFAULT_SPARQL_LIMIT);
    const boundedQuery = withSparqlLimit(q, rowLimit);
    const url = new URL(WIKIDATA_SPARQL_URL);
    url.search = new URLSearchParams({ format: "json", query: boundedQuery });
    const res = await this.networkQueue.enqueue(() => fetch(url, {
      headers: { Accept: "application/sparql-results+json" },
    }));
    if (!res.ok) return noData(`Wikidata SPARQL HTTP ${res.status}.`);
    const data = await res.json();
    const rows = normalizeSparqlRows(data?.results?.bindings ?? []);
    if (rows.length === 0) return noData("Wikidata SPARQL query returned zero rows.");
    return ok({
      variables: data?.head?.vars ?? Object.keys(rows[0] ?? {}),
      rowCount: rows.length,
      rows,
    });
  }

  async geocode({ placeName, limit = DEFAULT_GEOCODE_LIMIT }) {
    const q = String(placeName ?? "").trim();
    if (!q) return noData("Missing place name to geocode.");
    const n = clampInteger(limit, 1, MAX_GEOCODE_LIMIT, DEFAULT_GEOCODE_LIMIT);
    const url = new URL(NOMINATIM_SEARCH_URL);
    url.search = new URLSearchParams({
      q,
      format: "jsonv2",
      limit: String(n),
      addressdetails: "1",
      namedetails: "1",
      "accept-language": "en",
    });
    const res = await this.networkQueue.enqueue(() => fetch(url));
    if (!res.ok) return noData(`Nominatim geocode HTTP ${res.status}.`);
    const places = await res.json();
    if (!Array.isArray(places) || places.length === 0) return noData(`No geocoding results found for "${q}".`);
    const results = places.map(normalizeNominatimPlace).filter(Boolean);
    if (results.length === 0) return noData(`No valid geocoding coordinates found for "${q}".`);
    return ok({ query: q, results });
  }

  async labelCountries({ labels, color = null }) {
    if (!labels || typeof labels !== "object" || Array.isArray(labels)) {
      return noData("label_countries needs an object mapping ISO3 country codes to text labels.");
    }
    const entries = Object.entries(labels)
      .map(([iso3, text]) => ({ iso3: String(iso3 ?? "").trim().toUpperCase(), text: String(text ?? "").trim() }))
      .filter((entry) => /^[A-Z]{3}$/.test(entry.iso3) && entry.text)
      .slice(0, MAX_COUNTRY_LABELS);
    if (entries.length === 0) return noData("No valid ISO3 country labels were supplied.");

    const geo = await loadCountryGeo();
    const countries = new Map(geo.map((feature) => [feature.id, feature]));
    const material = safeColor(color, Cesium.Color.WHITE);
    const missing = [];
    const placed = [];
    for (const entry of entries) {
      const country = countries.get(entry.iso3);
      if (!country) {
        missing.push(entry.iso3);
        continue;
      }
      const center = countryLabelPoint(country);
      const density = labelDensityFor(country, entries.length);
      const entity = this._track(this.viewer.entities.add({
        position: Cesium.Cartesian3.fromDegrees(center.lon, center.lat, LABEL_HEIGHT_M),
        label: {
          text: entry.text.slice(0, 48),
          font: "bold 13px Segoe UI, sans-serif",
          fillColor: material,
          outlineColor: Cesium.Color.BLACK.withAlpha(0.78),
          outlineWidth: 3,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          pixelOffset: new Cesium.Cartesian2(0, 0),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          scaleByDistance: new Cesium.NearFarScalar(4.0e5, density.nearScale, density.farDistance, density.farScale),
          translucencyByDistance: new Cesium.NearFarScalar(4.0e5, 1.0, density.farDistance, 0.0),
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, density.farDistance),
        },
        properties: { kind: "agent", tool: "label_countries", iso3: entry.iso3, text: entry.text },
      }));
      placed.push({ iso3: entry.iso3, name: country.name, label: entry.text.slice(0, 48), lat: center.lat, lon: center.lon, entityId: entity.id });
    }
    return placed.length
      ? ok({ placed: placed.length, missing, labels: placed })
      : noData("No supplied ISO3 country codes matched the local country dataset.", { missing });
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

function clampInteger(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function isSelectSparql(query) {
  return /^(?:\s*(?:PREFIX|BASE)\s+[^\n\r]+[\n\r]+)*\s*SELECT\b/i.test(query);
}

function withSparqlLimit(query, limit) {
  return /\bLIMIT\s+\d+\b/i.test(query) ? query : `${query.replace(/;?\s*$/, "")}\nLIMIT ${limit}`;
}

function normalizeSparqlRows(bindings) {
  return bindings.map((row) => Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, normalizeSparqlValue(value)])
  ));
}

function normalizeSparqlValue(value) {
  const out = { type: value?.type ?? "literal", value: value?.value ?? "" };
  if (value?.datatype) out.datatype = value.datatype;
  if (value?.["xml:lang"]) out.lang = value["xml:lang"];
  return out;
}

function normalizeNominatimPlace(place) {
  const lat = Number(place?.lat);
  const lon = Number(place?.lon);
  if (!validLatLon(lat, lon)) return null;
  return {
    displayName: place.display_name ?? place.name ?? "",
    lat,
    lon,
    category: place.category ?? place.class ?? null,
    type: place.type ?? null,
    importance: numberOrNull(place.importance),
    osmType: place.osm_type ?? null,
    osmId: place.osm_id ?? null,
    boundingBox: normalizeBoundingBox(place.boundingbox),
    address: place.address ?? null,
    name: place.name ?? place.namedetails?.name ?? null,
  };
}

function normalizeBoundingBox(value) {
  if (!Array.isArray(value) || value.length < 4) return null;
  const [south, north, west, east] = value.map(Number);
  if (![south, north, west, east].every(Number.isFinite)) return null;
  return { south, north, west, east };
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function countryLabelPoint(country) {
  const [w, s, e, n] = country.bbox;
  return { lon: (w + e) / 2, lat: (s + n) / 2 };
}

function labelDensityFor(country, totalLabels) {
  const [w, s, e, n] = country.bbox;
  const span = Math.max(0.1, Math.abs(e - w)) * Math.max(0.1, Math.abs(n - s));
  const crowd = totalLabels > 120 ? 0.72 : totalLabels > 60 ? 0.86 : 1;
  const farDistance = span > 500 ? 5.2e7 : span > 120 ? 3.6e7 : span > 25 ? 2.2e7 : 1.2e7;
  return {
    farDistance: farDistance * crowd,
    nearScale: span > 120 ? 1.0 : 0.86,
    farScale: span > 120 ? 0.52 : 0.28,
  };
}

function safeColor(value, fallback) {
  if (!value) return fallback;
  try { return Cesium.Color.fromCssColorString(value).withAlpha(0.92); } catch { return fallback; }
}

function stripHtml(value) {
  return String(value).replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}

function wikiArticleUrl(title) {
  return `https://en.wikipedia.org/wiki/${encodeURIComponent(String(title).replace(/ /g, "_"))}`;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
