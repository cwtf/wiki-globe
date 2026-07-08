import { countryAreaKm2, formatArea, loadCountryGeo } from "../country-geo.js";
import { fillFeature } from "../layers/heatmap.js";
import {
  classifyIncome,
  incomeBandLabel,
  loadCountryStats,
  normalizeIncomeGroup,
  STAT_INDICATORS,
  statValue,
  statYear,
  WORLD_BANK_INCOME_BANDS,
} from "../country-stats.js";

const AGENT_MARKER = "agent-session";
const PIN_COLOR = Cesium.Color.fromCssColorString("#facc15");
const ROUTE_COLOR = Cesium.Color.fromCssColorString("#facc15").withAlpha(0.72);
const HIGHLIGHT_COLOR = Cesium.Color.fromCssColorString("#6ef3ff").withAlpha(0.92);
const DEFAULT_HEIGHT_M = 2800;
const LABEL_HEIGHT_M = 5200;
const MAX_ROUTE_POINTS = 24;
const MAX_COUNTRY_LABELS = 250;
const MAX_COLOR_COUNTRIES = 250;
const CHOROPLETH_W = 1440;
const CHOROPLETH_H = 720;
const DEFAULT_CHOROPLETH_COLORS = [[79, 195, 247], [250, 204, 21], [239, 68, 68]];
const WIKIPEDIA_API_URL = "https://en.wikipedia.org/w/api.php";
const WIKIPEDIA_SUMMARY_URL = "https://en.wikipedia.org/api/rest_v1/page/summary/";
const DEFAULT_WIKI_LIMIT = 5;
const WIKIDATA_SPARQL_URL = "https://query.wikidata.org/sparql";
const DEFAULT_SPARQL_LIMIT = 100;
const MAX_SPARQL_LIMIT = 300;
const NOMINATIM_SEARCH_URL = "https://nominatim.openstreetmap.org/search";
const DEFAULT_GEOCODE_LIMIT = 5;
const MAX_GEOCODE_LIMIT = 5;
const NETWORK_TIMEOUT_MS = 15000;
const MAX_STATS_ROWS = 250;

export const OK_STATUS = "ok";
export const NO_DATA_STATUS = "no_data";
export const ERROR_STATUS = "error";

export function noData(reason, detail = null) {
  return { status: NO_DATA_STATUS, reason, detail, data: null };
}

// A transient/retryable failure (network throw, timeout, rate limit, 5xx) —
// distinct from no_data, which means the requested data is genuinely outside
// tool coverage. The model must treat these differently: retry/report an error
// vs. state the data is unavailable. It must never invent a failure reason.
export function toolError(reason, detail = null) {
  return { status: ERROR_STATUS, reason, detail, data: null };
}

export function ok(data = {}) {
  return { status: OK_STATUS, data };
}

export function isNoDataResult(result) {
  return result?.status === NO_DATA_STATUS;
}

export function isErrorResult(result) {
  return result?.status === ERROR_STATUS;
}

export class AgentToolRegistry {
  constructor(viewer) {
    this.viewer = viewer;
    this.entities = new Set();
    this.layers = new Set();
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
          name: "country_stats",
          description: "Read Wiki Globe's bundled per-country World Bank / UNDP indicators (GDP per capita, GNI, HDI, life expectancy, population density, internet users, and more) by ISO-3166 alpha-3 code, with NO network call. PREFER THIS over wiki_search/wikidata_sparql for standard country economic and development statistics and for World Bank income-group classification — Wikidata does not reliably carry GDP-per-capita or income group. Optionally filter to a World Bank income group; every returned country also includes its income-group classification. Feed the returned values straight into color_countries or label_countries.",
          parameters: {
            type: "object",
            properties: {
              indicator: {
                type: "string",
                enum: Object.keys(STAT_INDICATORS),
                description: "Which indicator value to return. Defaults to gdpNominal (GDP per capita, current US$).",
              },
              iso3: { type: "string", minLength: 3, maxLength: 3, description: "Optional single ISO3 code; omit to return every country with data." },
              incomeGroup: {
                type: "string",
                enum: ["low", "lower_middle", "upper_middle", "high"],
                description: "Optional World Bank income-group filter (approximate; see the incomeGroupBasis disclaimer in the result).",
              },
              sort: { type: "string", enum: ["asc", "desc"], description: "Optional sort of the returned indicator value." },
              limit: { type: "integer", minimum: 1, maximum: MAX_STATS_ROWS, description: "Optional cap on the number of countries returned." },
            },
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
          name: "color_countries",
          description: "Create an agent-owned choropleth overlay for present-day countries from a map of ISO-3166 alpha-3 codes to numeric values. Uses the same country canvas fill and piecewise-linear color stops as the heatmap layer, but is driven by arbitrary tool-returned values instead of fixed app metrics.",
          parameters: {
            type: "object",
            properties: {
              values: {
                type: "object",
                description: "Map of ISO3 country code to numeric value.",
                additionalProperties: { type: "number" },
              },
              stops: {
                type: "array",
                description: "Optional color ramp as [value, [r,g,b]] stops. If omitted, a blue-yellow-red ramp is generated from the supplied values.",
                minItems: 2,
                maxItems: 12,
                items: {
                  type: "array",
                  minItems: 2,
                  maxItems: 2,
                },
              },
            },
            required: ["values"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "country_area",
          description: "Return the computed present-day area of one country from the local country polygon dataset. Use this for area-ratio questions without network calls; only ISO-3166 alpha-3 countries in the local boundary dataset are covered.",
          parameters: {
            type: "object",
            properties: {
              iso3: { type: "string", minLength: 3, maxLength: 3 },
            },
            required: ["iso3"],
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
    if (name === "country_stats") return this.countryStats(args);
    if (name === "geocode") return this.geocode(args);
    if (name === "label_countries") return this.labelCountries(args);
    if (name === "color_countries") return this.colorCountries(args);
    if (name === "country_area") return this.countryArea(args);
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
    const res = await this.networkQueue.enqueue(() => fetchWithTimeout(url));
    if (!res.ok) return httpFailure(res.status, "Wikipedia search");
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
    const res = await this.networkQueue.enqueue(() => fetchWithTimeout(`${WIKIPEDIA_SUMMARY_URL}${encodeURIComponent(t)}`));
    if (res.status === 404) return noData(`No Wikipedia summary found for "${t}".`);
    if (!res.ok) return httpFailure(res.status, "Wikipedia summary");
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
    const res = await this.networkQueue.enqueue(() => fetchWithTimeout(url, {
      headers: { Accept: "application/sparql-results+json" },
    }));
    if (!res.ok) return httpFailure(res.status, "Wikidata SPARQL");
    const data = await res.json();
    const rows = normalizeSparqlRows(data?.results?.bindings ?? []);
    if (rows.length === 0) return noData("Wikidata SPARQL query returned zero rows.");
    return ok({
      variables: data?.head?.vars ?? Object.keys(rows[0] ?? {}),
      rowCount: rows.length,
      rows,
    });
  }

  async countryStats({ indicator = "gdpNominal", iso3 = null, incomeGroup = null, sort = null, limit = null }) {
    const key = String(indicator ?? "gdpNominal").trim();
    if (!STAT_INDICATORS[key]) {
      return noData(`Unknown indicator "${indicator}". Available: ${Object.keys(STAT_INDICATORS).join(", ")}.`);
    }
    let wantGroup = null;
    if (incomeGroup != null && String(incomeGroup).trim() !== "") {
      wantGroup = normalizeIncomeGroup(incomeGroup);
      if (!wantGroup) return noData(`Unknown income group "${incomeGroup}". Use low, lower_middle, upper_middle, or high.`);
    }

    // May throw (network/timeout) → the harness converts that into a
    // retryable error result, distinct from a genuine no_data.
    const stats = await loadCountryStats();
    const meta = STAT_INDICATORS[key];

    // The World Bank feed mixes in region/income aggregates (e.g. "LTE" =
    // Late-demographic dividend) that pass an ISO3 regex but are not countries.
    // Restrict to codes present in the polygon dataset, which is also what
    // color_countries / label_countries need to render anything.
    const geo = await loadCountryGeo();
    const realCountries = new Set(geo.map((feature) => feature.id));

    const wantIso3 = iso3 != null ? String(iso3).trim().toUpperCase() : null;
    if (wantIso3 && !/^[A-Z]{3}$/.test(wantIso3)) {
      return noData("country_stats iso3 must be an ISO-3166 alpha-3 country code.");
    }
    if (wantIso3 && !realCountries.has(wantIso3)) {
      return noData(`ISO3 ${wantIso3} is not a mappable country in the dataset.`);
    }
    const ids = wantIso3 ? [wantIso3] : Object.keys(stats.countries);
    if (wantIso3 && !stats.countries[wantIso3]) {
      return noData(`No bundled statistics for ISO3 ${wantIso3}.`);
    }

    const rows = [];
    for (const id of ids) {
      if (!realCountries.has(id)) continue;
      const row = stats.countries[id];
      if (!row) continue;
      const value = statValue(row[key]);
      if (!Number.isFinite(value)) continue;
      const groupKey = classifyIncome(statValue(row.gdpNominal));
      if (wantGroup && groupKey !== wantGroup) continue;
      rows.push({
        iso3: id,
        name: row.name ?? id,
        value,
        year: statYear(row[key]),
        incomeGroup: groupKey,
        incomeGroupLabel: incomeBandLabel(groupKey),
      });
    }

    if (rows.length === 0) {
      const scope = wantGroup ? ` in income group "${wantGroup}"` : "";
      return noData(`No bundled "${key}" values found${scope}${wantIso3 ? ` for ${wantIso3}` : ""}.`);
    }

    if (sort === "asc") rows.sort((a, b) => a.value - b.value);
    else if (sort === "desc") rows.sort((a, b) => b.value - a.value);
    const capped = limit ? rows.slice(0, clampInteger(limit, 1, MAX_STATS_ROWS, MAX_STATS_ROWS)) : rows.slice(0, MAX_STATS_ROWS);

    return ok({
      indicator: key,
      indicatorLabel: meta.label,
      unit: meta.unit,
      dataSource: stats.sourceLabel,
      live: stats.live,
      generatedAt: stats.generatedAt,
      incomeGroupBasis: {
        note: WORLD_BANK_INCOME_BANDS.disclaimer,
        asOf: WORLD_BANK_INCOME_BANDS.asOf,
        proxyBasis: WORLD_BANK_INCOME_BANDS.proxyBasis,
      },
      count: capped.length,
      totalMatched: rows.length,
      countries: capped,
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
    const res = await this.networkQueue.enqueue(() => fetchWithTimeout(url));
    if (!res.ok) return httpFailure(res.status, "Nominatim geocode");
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

  async colorCountries({ values, stops = null }) {
    if (!values || typeof values !== "object" || Array.isArray(values)) {
      return noData("color_countries needs an object mapping ISO3 country codes to numeric values.");
    }
    if (!globalThis.document?.createElement) {
      return noData("color_countries needs a browser canvas environment.");
    }
    if (!this.viewer.imageryLayers?.addImageryProvider) {
      return noData("color_countries needs a Cesium viewer with imageryLayers.");
    }
    const entries = Object.entries(values)
      .map(([iso3, value]) => ({ iso3: String(iso3 ?? "").trim().toUpperCase(), value: Number(value) }))
      .filter((entry) => /^[A-Z]{3}$/.test(entry.iso3) && Number.isFinite(entry.value))
      .slice(0, MAX_COLOR_COUNTRIES);
    if (entries.length === 0) return noData("No valid ISO3 numeric country values were supplied.");

    const colorStops = normalizeColorStops(stops, entries.map((entry) => entry.value));
    if (!colorStops) return noData("Invalid color_countries stops. Use [value, [r,g,b]] entries with finite values and RGB components 0-255.");

    const geo = await loadCountryGeo();
    const countries = new Map(geo.map((feature) => [feature.id, feature]));
    const canvas = document.createElement("canvas");
    canvas.width = CHOROPLETH_W;
    canvas.height = CHOROPLETH_H;
    const ctx = canvas.getContext("2d");
    if (!ctx) return noData("Unable to create choropleth canvas context.");

    const missing = [];
    const colored = [];
    for (const entry of entries) {
      const country = countries.get(entry.iso3);
      if (!country) {
        missing.push(entry.iso3);
        continue;
      }
      fillFeature(ctx, country, entry.value, colorStops);
      colored.push({ iso3: entry.iso3, name: country.name, value: entry.value });
    }
    if (colored.length === 0) return noData("No supplied ISO3 country codes matched the local country dataset.", { missing });

    const provider = await Cesium.SingleTileImageryProvider.fromUrl(canvas.toDataURL("image/png"));
    const layer = this._trackLayer(this.viewer.imageryLayers.addImageryProvider(provider));
    layer.show = true;
    layer.alpha = 1;
    layer.agentMetadata = { kind: "agent", tool: "color_countries", count: colored.length };
    return ok({
      layerId: layer[AGENT_MARKER],
      colored: colored.length,
      missing,
      range: valueRange(colored.map((entry) => entry.value)),
      stops: colorStops,
      countries: colored,
    });
  }

  async countryArea({ iso3 }) {
    const id = String(iso3 ?? "").trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(id)) return noData("country_area needs an ISO-3166 alpha-3 country code.");
    const geo = await loadCountryGeo();
    const country = geo.find((feature) => feature.id === id);
    if (!country) return noData(`No present-day country polygon found for ISO3 ${id}.`);
    const areaKm2 = country.areaKm2 ?? countryAreaKm2(country);
    if (!Number.isFinite(areaKm2)) return noData(`Unable to compute area for ISO3 ${id}.`);
    return ok({
      iso3: id,
      name: country.name,
      areaKm2,
      areaLabel: formatArea(areaKm2),
      source: "local simplified country polygons",
    });
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
    const entityCount = this.entities.size;
    const layerCount = this.layers.size;
    for (const entity of this.entities) this.viewer.entities.remove(entity);
    for (const layer of this.layers) this.viewer.imageryLayers?.remove?.(layer);
    this.entities.clear();
    this.layers.clear();
    return ok({ cleared: entityCount + layerCount, entities: entityCount, layers: layerCount });
  }

  _track(entity) {
    entity[AGENT_MARKER] = this.sessionId;
    this.entities.add(entity);
    return entity;
  }

  _trackLayer(layer) {
    layer[AGENT_MARKER] = `${this.sessionId}:layer:${this.layers.size + 1}`;
    this.layers.add(layer);
    return layer;
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

// fetch with a hard timeout so one slow/expensive endpoint (e.g. an overweight
// SPARQL query) cannot hang the whole agent loop. On timeout the returned
// promise rejects, which the harness turns into a retryable tool error.
function fetchWithTimeout(input, init = {}, ms = NETWORK_TIMEOUT_MS) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new DOMException(`request timed out after ${ms} ms`, "TimeoutError")), ms);
  return fetch(input, { ...init, signal: ctl.signal }).finally(() => clearTimeout(timer));
}

// Classify an HTTP failure: 408/429/5xx are transient (retryable error), other
// 4xx are treated as no_data (the request itself won't succeed on retry).
function httpFailure(status, label) {
  const transient = status === 408 || status === 429 || status >= 500;
  const msg = `${label} HTTP ${status}.`;
  return transient ? toolError(msg, { status, retryable: true }) : noData(msg, { status });
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

function normalizeColorStops(stops, values) {
  if (!Array.isArray(stops) || stops.length === 0) return defaultColorStops(values);
  const out = stops.map((stop) => {
    if (!Array.isArray(stop) || stop.length < 2) return null;
    const value = Number(stop[0]);
    const color = stop[1];
    if (!Number.isFinite(value) || !Array.isArray(color) || color.length < 3) return null;
    const rgb = color.slice(0, 3).map((component) => Math.round(Number(component)));
    if (!rgb.every((component) => Number.isFinite(component) && component >= 0 && component <= 255)) return null;
    return [value, rgb];
  });
  if (out.some((stop) => !stop) || out.length < 2) return null;
  return out.sort((a, b) => a[0] - b[0]);
}

function defaultColorStops(values) {
  const range = valueRange(values);
  if (!range) return null;
  const min = range.min;
  const max = range.max;
  const mid = min === max ? min : min + (max - min) / 2;
  if (min === max) {
    return [[min - 1, DEFAULT_CHOROPLETH_COLORS[0]], [min, DEFAULT_CHOROPLETH_COLORS[1]], [min + 1, DEFAULT_CHOROPLETH_COLORS[2]]];
  }
  return [[min, DEFAULT_CHOROPLETH_COLORS[0]], [mid, DEFAULT_CHOROPLETH_COLORS[1]], [max, DEFAULT_CHOROPLETH_COLORS[2]]];
}

function valueRange(values) {
  const clean = values.filter(Number.isFinite);
  if (clean.length === 0) return null;
  return { min: Math.min(...clean), max: Math.max(...clean) };
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
