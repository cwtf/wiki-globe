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
const MAX_ECLIPSE_ROUTE_POINTS = 160;
const MAX_COUNTRY_LABELS = 250;
const MAX_COLOR_COUNTRIES = 250;
const CHOROPLETH_W = 1440;
const CHOROPLETH_H = 720;
const DEFAULT_CHOROPLETH_COLORS = [[79, 195, 247], [250, 204, 21], [239, 68, 68]];
const WIKIPEDIA_API_URL = "https://en.wikipedia.org/w/api.php";
const WIKIPEDIA_SUMMARY_URL = "https://en.wikipedia.org/api/rest_v1/page/summary/";
const DEFAULT_WIKI_LIMIT = 5;
// wiki_article body-extraction caps: the summary endpoint returns only the
// lead paragraph, so wiki_article parses the full rendered HTML — bounded so a
// long article (e.g. a ~230-row visa-requirement table) can't blow the context.
const MAX_WIKI_TABLES = 10;
const MAX_WIKI_ROWS_TOTAL = 500;
const MAX_WIKI_CELL_CHARS = 160;
const MAX_WIKI_TEXT_CHARS = 6000;
const WIKIDATA_SPARQL_URL = "https://query.wikidata.org/sparql";
const DEFAULT_SPARQL_LIMIT = 100;
const MAX_SPARQL_LIMIT = 300;
const NOMINATIM_SEARCH_URL = "https://nominatim.openstreetmap.org/search";
const DEFAULT_GEOCODE_LIMIT = 5;
const MAX_GEOCODE_LIMIT = 5;
const NETWORK_TIMEOUT_MS = 15000;
const MAX_STATS_ROWS = 250;
const AU_M = 149597870700;
const KM_PER_AU = 149597870.69098932;
const SUN_RADIUS_KM = 695700.0;
const MOON_MEAN_RADIUS_KM = 1737.4;
const ECLIPSE_SEARCH_LIMIT = 24;
const ECLIPSE_SAMPLE_MINUTES = 2;
const ECLIPSE_SAMPLE_WINDOW_HOURS = 4.5;
const ECLIPSE_ROUTE_HEIGHT_M = 9000;

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

// Tools that mutate the globe's visible agent overlays (as opposed to
// knowledge/data tools like wiki_search). A chat session's "globe state" is
// fully reconstructable by replaying this subset of its tool calls in order.
export const OVERLAY_TOOL_NAMES = new Set([
  "add_pin",
  "highlight_country",
  "draw_route",
  "label_countries",
  "color_countries",
  "clear_agent_overlays",
]);

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
          description: "Fetch a concise English Wikipedia REST LEAD SUMMARY (intro paragraph only) for an exact page title returned by wiki_search or supplied by the user. This omits the article body — when the answer lives in a data table or section list (e.g. a visa-requirement or medal table), use wiki_article instead, which returns the tabulated content the summary drops.",
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
          name: "wiki_article",
          description: "Fetch the FULL body of an English Wikipedia article for an exact page title — its section prose AND its data tables (wikitables) parsed into structured header/row arrays. Use this whenever the answer is a list or table inside the article body rather than a scalar fact or the lead summary: e.g. 'Visa requirements for <nationality> citizens', discographies, medal counts, election results. wiki_extract only returns the one-paragraph lead and will miss this content. Still prefer wikidata_sparql first when the same fact is a structured per-entity Wikidata property at scale.",
          parameters: {
            type: "object",
            properties: {
              title: { type: "string", minLength: 1, description: "Exact article title, e.g. from wiki_search." },
              section: { type: "integer", minimum: 0, description: "Optional section index to fetch just one section's tables/prose instead of the whole article." },
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
          name: "eclipse_path",
          description: "Compute and draw the central path of the next total or annular solar eclipse from an optional start date using local astronomy-engine ephemeris. This is compute-heavy and requires user approval before execution. Returns NO DATA if no central eclipse is found in range.",
          parameters: {
            type: "object",
            properties: {
              date: {
                type: "string",
                description: "Optional ISO date/time to start searching from. Defaults to now.",
              },
            },
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

  async execute(name, args, opts = {}) {
    if (name === "add_pin") return this.addPin(args);
    if (name === "wiki_search") return this.wikiSearch(args);
    if (name === "wiki_extract") return this.wikiExtract(args);
    if (name === "wiki_article") return this.wikiArticle(args);
    if (name === "wikidata_sparql") return this.wikidataSparql(args);
    if (name === "country_stats") return this.countryStats(args);
    if (name === "geocode") return this.geocode(args);
    if (name === "label_countries") return this.labelCountries(args);
    if (name === "color_countries") return this.colorCountries(args);
    if (name === "country_area") return this.countryArea(args);
    if (name === "eclipse_path") return this.eclipsePath(args, opts);
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

  async wikiArticle({ title, section = null }) {
    const t = String(title ?? "").trim();
    if (!t) return noData("Missing Wikipedia page title.");
    if (!globalThis.DOMParser) {
      return toolError("wiki_article needs a browser DOMParser environment.");
    }
    const params = {
      action: "parse",
      page: t,
      prop: "text",
      redirects: "1",
      formatversion: "2",
      disablelimitreport: "1",
      disableeditsection: "1",
      format: "json",
      origin: "*",
    };
    let sectionIndex = null;
    if (section != null && String(section).trim() !== "") {
      sectionIndex = clampInteger(section, 0, 999, null);
      if (sectionIndex == null) return noData("wiki_article section must be a non-negative integer index.");
      params.section = String(sectionIndex);
    }
    const url = new URL(WIKIPEDIA_API_URL);
    url.search = new URLSearchParams(params);
    const res = await this.networkQueue.enqueue(() => fetchWithTimeout(url));
    if (!res.ok) return httpFailure(res.status, "Wikipedia parse");
    const data = await res.json();
    if (data?.error) {
      const code = data.error.code ?? "";
      if (code === "missingtitle" || code === "nosuchpageid" || code === "nosuchsection") {
        return noData(`No Wikipedia article content found for "${t}"${sectionIndex != null ? ` section ${sectionIndex}` : ""}.`);
      }
      return noData(`Wikipedia parse failed for "${t}": ${data.error.info ?? code}.`);
    }
    const resolvedTitle = data?.parse?.title ?? t;
    const rawHtml = typeof data?.parse?.text === "string" ? data.parse.text : data?.parse?.text?.["*"];
    if (!rawHtml) return noData(`Wikipedia article "${resolvedTitle}" returned no parseable content.`);
    const { tables, text, truncated } = extractWikiArticle(rawHtml);
    if (tables.length === 0 && !text) {
      return noData(`Wikipedia article "${resolvedTitle}"${sectionIndex != null ? ` section ${sectionIndex}` : ""} had no extractable tables or prose.`);
    }
    return ok({
      title: resolvedTitle,
      url: wikiArticleUrl(resolvedTitle),
      section: sectionIndex,
      tableCount: tables.length,
      tables,
      text,
      truncated,
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

    const positions = routePositions(clean);

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

  async eclipsePath({ date = null } = {}, opts = {}) {
    const start = parseEclipseStartDate(date);
    if (!start) return noData("eclipse_path date must be a valid ISO date/time.");
    if (!globalThis.Astronomy?.SearchGlobalSolarEclipse || !globalThis.Astronomy?.Illumination) {
      return noData("astronomy-engine is not loaded, so eclipse_path cannot compute an ephemeris.");
    }
    if (!globalThis.Cesium?.Transforms || !this.viewer?.entities?.add) {
      return noData("eclipse_path needs the Cesium viewer and Earth transform helpers.");
    }

    const approved = await requestComputeApproval(opts, {
      tool: "eclipse_path",
      title: "Compute solar-eclipse path",
      detail: `Search from ${start.toISOString()} and sample the Moon shadow axis for the next central solar eclipse.`,
      estimate: `Up to ${ECLIPSE_SEARCH_LIMIT} eclipses checked; about ${(ECLIPSE_SAMPLE_WINDOW_HOURS * 60 * 2) / ECLIPSE_SAMPLE_MINUTES + 1} ephemeris samples.`,
    });
    if (!approved) return noData("Stopped before running the compute-heavy eclipse_path tool.");

    const found = findNextCentralSolarEclipse(start);
    if (!found) {
      return noData(`No total or annular solar eclipse with a central path was found within ${ECLIPSE_SEARCH_LIMIT} global solar eclipses after ${start.toISOString()}.`);
    }

    const path = sampleEclipseCentralPath(found.eclipse);
    if (path.length < 2) {
      return noData(`The ${found.kind} solar eclipse on ${astroDate(found.eclipse.peak).toISOString()} did not produce enough central-line points to draw.`);
    }

    const entity = this._track(this.viewer.entities.add({
      polyline: {
        positions: routePositions(path, ECLIPSE_ROUTE_HEIGHT_M),
        width: 3,
        material: new Cesium.PolylineGlowMaterialProperty({
          color: Cesium.Color.fromCssColorString(found.kind === "total" ? "#facc15" : "#6ef3ff").withAlpha(0.82),
          glowPower: 0.24,
          taperPower: 0.8,
        }),
        arcType: Cesium.ArcType.GEODESIC,
      },
      properties: { kind: "agent", tool: "eclipse_path", eclipseKind: found.kind },
    }));

    const peakDate = astroDate(found.eclipse.peak);
    const peak = {
      lat: numberOrNull(found.eclipse.latitude),
      lon: normalizeLongitude(numberOrNull(found.eclipse.longitude)),
      time: peakDate.toISOString(),
    };
    return ok({
      entityId: entity.id,
      eclipseKind: found.kind,
      searchStart: start.toISOString(),
      peak,
      peakDistanceKm: numberOrNull(found.eclipse.distance),
      obscuration: numberOrNull(found.eclipse.obscuration),
      source: "local astronomy-engine ephemeris sampled against Cesium WGS84 ellipsoid",
      verificationReference: {
        note: "For the 2026-08-12 total eclipse, NASA Saros 126 lists greatest eclipse near 65.2N, 25.2W at 17:47:06 TD.",
        url: "https://eclipse.gsfc.nasa.gov/SEsaros/SEsaros126.html",
      },
      sampledPoints: path.length,
      path,
    });
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

function routePositions(clean, height = DEFAULT_HEIGHT_M) {
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
      positions.push(Cesium.Cartesian3.fromRadians(c.longitude, c.latitude, height));
    }
  }
  return positions;
}

async function requestComputeApproval(opts, info) {
  if (!opts?.confirmCompute) return false;
  const decision = await opts.confirmCompute(info);
  return decision === "proceed" || decision === true;
}

function parseEclipseStartDate(value) {
  if (value == null || String(value).trim() === "") return new Date();
  const date = new Date(String(value).trim());
  return Number.isFinite(date.getTime()) ? date : null;
}

function findNextCentralSolarEclipse(startDate) {
  const A = globalThis.Astronomy;
  let cursor = startDate;
  for (let i = 0; i < ECLIPSE_SEARCH_LIMIT; i++) {
    const eclipse = A.SearchGlobalSolarEclipse(cursor);
    const kind = String(eclipse?.kind ?? "").toLowerCase();
    if ((kind === "total" || kind === "annular") && Number.isFinite(eclipse.latitude) && Number.isFinite(eclipse.longitude)) {
      return { eclipse, kind };
    }
    const peak = eclipse?.peak;
    cursor = peak?.AddDays ? astroDate(peak.AddDays(10)) : new Date(astroDate(peak).getTime() + 10 * 86400000);
  }
  return null;
}

function sampleEclipseCentralPath(eclipse) {
  const peak = eclipse.peak;
  const points = [];
  const stepDays = ECLIPSE_SAMPLE_MINUTES / 1440;
  const windowDays = ECLIPSE_SAMPLE_WINDOW_HOURS / 24;
  for (let dt = -windowDays; dt <= windowDays + 1e-9; dt += stepDays) {
    const time = peak.AddDays(dt);
    const point = eclipseSurfacePoint(time);
    if (point) points.push(point);
  }
  return thinRoutePoints(points, MAX_ECLIPSE_ROUTE_POINTS);
}

function eclipseSurfacePoint(time) {
  const shadow = moonShadow(time);
  const rot = earthFixedRotation(time);
  if (!rot) return null;

  const moonIcrf = Cesium.Cartesian3.fromElements(
    shadow.moon.x * AU_M,
    shadow.moon.y * AU_M,
    shadow.moon.z * AU_M
  );
  const axisIcrf = Cesium.Cartesian3.fromElements(shadow.dir.x, shadow.dir.y, shadow.dir.z);
  if (Cesium.Cartesian3.magnitudeSquared(axisIcrf) === 0) return null;
  Cesium.Cartesian3.normalize(axisIcrf, axisIcrf);

  const moonFixed = Cesium.Matrix3.multiplyByVector(rot, moonIcrf, new Cesium.Cartesian3());
  const axisFixed = Cesium.Matrix3.multiplyByVector(rot, axisIcrf, new Cesium.Cartesian3());
  Cesium.Cartesian3.normalize(axisFixed, axisFixed);

  const ellipsoid = Cesium.Ellipsoid.WGS84;
  const tMeters = rayEllipsoidDistance(moonFixed, axisFixed, ellipsoid.radii);
  if (!Number.isFinite(tMeters)) return null;

  const hit = Cesium.Cartesian3.add(
    moonFixed,
    Cesium.Cartesian3.multiplyByScalar(axisFixed, tMeters, new Cesium.Cartesian3()),
    new Cesium.Cartesian3()
  );
  const carto = ellipsoid.cartesianToCartographic(hit);
  if (!carto) return null;

  const dirAu = vectorLength(shadow.dir);
  const uSurface = (tMeters / AU_M) / dirAu;
  const umbraRadiusKm = SUN_RADIUS_KM - (1 + uSurface) * (SUN_RADIUS_KM - MOON_MEAN_RADIUS_KM);
  const kind = umbraRadiusKm > 0.014 ? "total" : "annular";
  const date = astroDate(time);
  return {
    lat: roundCoord(Cesium.Math.toDegrees(carto.latitude)),
    lon: roundCoord(normalizeLongitude(Cesium.Math.toDegrees(carto.longitude))),
    time: date.toISOString(),
    kind,
    umbraRadiusKm: Math.round(umbraRadiusKm * 1000) / 1000,
  };
}

function moonShadow(time) {
  const A = globalThis.Astronomy;
  const illum = A.Illumination(A.Body.Moon, time);
  const moon = illum.gc;
  const target = { x: -moon.x, y: -moon.y, z: -moon.z };
  const dir = { x: illum.hc.x, y: illum.hc.y, z: illum.hc.z };
  const u = dot(dir, target) / dot(dir, dir);
  const dx = (u * dir.x) - target.x;
  const dy = (u * dir.y) - target.y;
  const dz = (u * dir.z) - target.z;
  return {
    time,
    u,
    r: KM_PER_AU * Math.hypot(dx, dy, dz),
    k: SUN_RADIUS_KM - (1 + u) * (SUN_RADIUS_KM - MOON_MEAN_RADIUS_KM),
    moon: { x: moon.x, y: moon.y, z: moon.z },
    dir,
  };
}

function earthFixedRotation(time) {
  const jd = Cesium.JulianDate.fromDate(astroDate(time));
  return Cesium.Transforms.computeIcrfToFixedMatrix(jd) ??
    Cesium.Transforms.computeTemeToPseudoFixedMatrix(jd);
}

function rayEllipsoidDistance(origin, direction, radii) {
  const ox = origin.x / radii.x;
  const oy = origin.y / radii.y;
  const oz = origin.z / radii.z;
  const dx = direction.x / radii.x;
  const dy = direction.y / radii.y;
  const dz = direction.z / radii.z;
  const a = dx * dx + dy * dy + dz * dz;
  const b = 2 * (ox * dx + oy * dy + oz * dz);
  const c = ox * ox + oy * oy + oz * oz - 1;
  const disc = b * b - 4 * a * c;
  if (disc <= 0 || a === 0) return null;
  const root = Math.sqrt(disc);
  const t1 = (-b - root) / (2 * a);
  const t2 = (-b + root) / (2 * a);
  const hits = [t1, t2].filter((t) => t > 0);
  return hits.length ? Math.min(...hits) : null;
}

function thinRoutePoints(points, maxPoints) {
  if (points.length <= maxPoints) return points;
  const out = [];
  for (let i = 0; i < maxPoints; i++) {
    out.push(points[Math.round(i * (points.length - 1) / (maxPoints - 1))]);
  }
  return out;
}

function astroDate(time) {
  return time?.date instanceof Date ? time.date : new Date(time);
}

function dot(a, b) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function vectorLength(v) {
  return Math.hypot(v.x, v.y, v.z);
}

function roundCoord(value) {
  return Math.round(value * 10000) / 10000;
}

function normalizeLongitude(lon) {
  if (!Number.isFinite(lon)) return null;
  let x = lon % 360;
  if (x <= -180) x += 360;
  else if (x > 180) x -= 360;
  return x;
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

// Parse the rendered HTML from action=parse into structured wikitables plus
// body prose. The REST summary endpoint (wiki_extract) only carries the lead
// paragraph, so table/list-driven questions need the full DOM walked here.
function extractWikiArticle(html) {
  const doc = new DOMParser().parseFromString(String(html), "text/html");
  const root = doc.body;
  if (!root) return { tables: [], text: "", truncated: false };
  // Strip editorial/reference noise so cell + paragraph text stays clean
  // ("[1]" citation markers, edit links, empty spacers).
  root.querySelectorAll("style, sup.reference, .reference, .mw-editsection, .noprint, .mw-empty-elt")
    .forEach((el) => el.remove());

  let truncated = false;
  let rowBudget = MAX_WIKI_ROWS_TOTAL;
  const tables = [];
  for (const tableEl of root.querySelectorAll("table.wikitable")) {
    if (tables.length >= MAX_WIKI_TABLES || rowBudget <= 0) {
      truncated = true;
      break;
    }
    const parsed = parseWikiTable(tableEl, rowBudget);
    if (!parsed) continue;
    rowBudget -= parsed.rows.length;
    if (parsed.truncated) truncated = true;
    tables.push({ caption: parsed.caption, headers: parsed.headers, rowCount: parsed.rows.length, rows: parsed.rows });
  }

  const paragraphs = [];
  let textLen = 0;
  for (const p of root.querySelectorAll("p")) {
    if (p.closest("table")) continue; // skip prose nested inside tables
    const s = collapseWs(p.textContent ?? "");
    if (!s) continue;
    if (textLen + s.length > MAX_WIKI_TEXT_CHARS) {
      truncated = true;
      break;
    }
    paragraphs.push(s);
    textLen += s.length;
  }

  return { tables, text: paragraphs.join("\n\n"), truncated };
}

function parseWikiTable(tableEl, rowBudget) {
  const caption = collapseWs(tableEl.querySelector("caption")?.textContent ?? "");
  let headers = [];
  const rows = [];
  let truncated = false;
  for (const tr of tableEl.querySelectorAll("tr")) {
    const cells = Array.from(tr.querySelectorAll("th, td"));
    if (cells.length === 0) continue;
    const values = cells.map((cell) => clampCellText(collapseWs(cell.textContent ?? "")));
    // The first all-<th> row is the header; later rows keep their leading
    // scope="row" <th> (e.g. the country name) as an ordinary cell value.
    if (headers.length === 0 && cells.every((cell) => cell.tagName === "TH")) {
      headers = values;
      continue;
    }
    if (rows.length >= rowBudget) {
      truncated = true;
      break;
    }
    rows.push(values);
  }
  if (headers.length === 0 && rows.length === 0) return null;
  return { caption, headers, rows, truncated };
}

function collapseWs(value) {
  return String(value).replace(/\s+/g, " ").trim();
}

function clampCellText(value) {
  return value.length > MAX_WIKI_CELL_CHARS ? `${value.slice(0, MAX_WIKI_CELL_CHARS - 1)}…` : value;
}

function wikiArticleUrl(title) {
  return `https://en.wikipedia.org/wiki/${encodeURIComponent(String(title).replace(/ /g, "_"))}`;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
