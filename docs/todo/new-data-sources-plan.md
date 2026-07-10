# Implementation plan: new keyless data sources

Status: **Phases 1–2 + 3.1–3.4 complete** (2026-07-10). Phases 1.1–1.3, 2.1–2.3,
3.1, 3.2, 3.3, and 3.4 are implemented and bootable. Phase 3.5–4 remain proposed.

This is a self-contained work plan for adding new data layers/overlays to Wiki
Globe. Every source below requires **no API key**. Read this whole file, then
pick up phases in order — each source is independently shippable and phases are
ordered by payoff-per-effort.

---

## 0. Codebase conventions you must follow (read first)

These are the load-bearing patterns; deviating from them is the main way to get
a change rejected. See `CLAUDE.md` for the full version.

1. **Live data first.** A live fetch is the primary path; a bundled
   `data/*.latest.json` file is fallback only. Never ship a hardcoded list as
   the primary source.
2. **Badges tell the truth.** Every layer reports a source status consumed by
   `js/app.js` (`setBadge`, ~line 748): `LIVE` (fetched from upstream), `DATA`
   (bundled fallback), `…` (loading), idle (not loaded). New layers/modes must
   expose the same `counts()`-style status object other layers do (see
   `js/layers/satellites.js` or `js/layers/heatmap.js` for the shape) and get a
   `badge-*` element wired in the `badgeEls` map in `js/app.js` (~line 715).
3. **Layer shape.** Everything drawing on the globe is a class taking
   `(viewer, ...)`, with `init()` / `show` / `update()` lifecycle, constructed
   and wired in `js/app.js` (single entry point). Add new layer instances to
   `window.__globe` at the end of `js/app.js` boot for console debugging.
4. **Sidebar scoping.** Sidebar rows in `index.html` carry
   `data-scope="earth"` (or other body keys); Earth-only overlays must have it.
   Follow the existing `.layer` row markup (checkbox + label + badge span),
   e.g. the satellites row at `index.html` ~line 144.
5. **Heatmap modes** live in the `METRICS` map in `js/layers/heatmap.js`
   (~line 74). Each metric declares `label`, `kind` (`"weather"` = sampled
   grid, `"country"` = choropleth by country stat, `"region"` = admin-1
   choropleth), a value accessor, `fmt`, and color `stops`. Weather-kind
   metrics are sampled on the Open-Meteo grid and bilinearly interpolated
   (~line 839). A new grid-shaped overlay should be a new `kind` or reuse
   `"weather"` plumbing; a new point-event overlay (earthquakes, fires) fits
   better as its own layer class than as a heatmap mode — decide per source
   below.
6. **Data pipeline.** Generated files are committed as
   `data/<name>.latest.json|geojson` with `schemaVersion` and
   `meta.generatedAt` stamps, produced by `scripts/data/update-<name>.mjs` and
   checked by `scripts/data/validate-<name>.mjs`. Both get npm scripts:
   `data:update:<name>` / appended to the `data:update` chain, and the
   validator is picked up by `npm run data:validate`. Copy the structure of
   `scripts/data/update-ports.mjs` (smallest clean example).
7. **Attribution.** Any new upstream source gets an attribution line in the
   sidebar `.attrib` block in `index.html` and a mention in `README.md`.
   Only open/permissive sources are acceptable (all sources below qualify).
8. **No build step.** Plain ES modules; no npm runtime deps; anything
   third-party comes from a CDN `<script>` tag in `index.html` (avoid adding
   any — none of the work below needs one).

### Verification (no test suite)

Run the app (`python -m http.server 8080` or `preview_start` with the
`wiki-globe` launch config) and exercise the feature. Gotchas:

- `preview_screenshot` times out (WebGL never idles) — inspect state via
  `preview_eval` against `window.__globe` instead.
- Backgrounded tabs pause `requestAnimationFrame`; pump
  `setInterval(() => viewer.render())` if flights/ticks seem frozen.
- Don't `await` long promises in `preview_eval`; write to `window.__x` and
  poll.
- For each new source, verify all badge states: `LIVE` on success, and `DATA`
  or a graceful empty state when the fetch is blocked (test by temporarily
  pointing the URL at a garbage host).

---

## Phase 1 — highest payoff, lowest risk

### 1.1 USGS Earthquakes (live point layer) — ✅ DONE

- **Endpoint:** `https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson`
  (variants: `all_hour`, `all_week`, `2.5_week`, `4.5_month`). Plain GeoJSON,
  CORS-enabled, no key, updated every minute. Public domain (USGS).
- **Shape:** FeatureCollection of Points; `properties.mag`, `.place`, `.time`
  (epoch ms), `.url`, `.tsunami`; `geometry.coordinates = [lon, lat, depthKm]`.
- **Design:** new standalone layer `js/layers/earthquakes.js` (class
  `EarthquakesLayer(viewer)`), modeled on `js/layers/satellites.js` wiring.
  Point primitives sized by magnitude (e.g. `4 + 2^(mag-3)` px, clamp 4–28),
  colored by depth (shallow red → deep blue), slight glow for mag ≥ 6.
  Hover tooltip: `M5.4 · 23 km deep · 112 km SE of Tokyo · 2 h ago` (reuse the
  existing tooltip mechanism other layers use).
- **Click behavior:** open the Wikipedia panel at the quake location via the
  same path Earth globe clicks use (`js/wiki-panel.js` geosearch) — this gets
  interaction parity for free.
- **Refresh:** re-fetch every 5 min while the layer is visible; keep a
  timestamp and skip if hidden.
- **Fallback:** none bundled (data is inherently ephemeral). On fetch failure
  show idle badge + tooltip with the error; do NOT fabricate data.
- **UI:** new sidebar `.layer` row (`data-scope="earth"`), checkbox
  `chk-quakes`, badge `badge-quakes`; a small `<select>` for the time window
  (hour / day / week) following the pattern of existing per-layer selects.
  Feed period selection changes the URL only.
- **Wire-up checklist:** construct in `js/app.js`; add to Earth-orbit
  suspend/restore set (it's an Earth layer — must hide when a body is
  focused, same list as satellites/flights); add badge to `badgeEls`; add to
  `window.__globe`; attribution line “Earthquakes: USGS”.
- **Verify:** toggle on, `window.__globe.earthquakes` count > 0, badge LIVE,
  hover a dot, click opens panel, focus Moon → layer hides, back → restores.

### 1.2 Open-Meteo Air Quality (new heatmap weather modes) — ✅ DONE

- **Endpoint:** `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=…&longitude=…&hourly=pm2_5,us_aqi&…`
  — same provider, request/response shape, and multi-point batching as the
  existing weather fetch in `js/layers/heatmap.js`. No key, CORS ok. CC-BY 4.0.
- **Design:** cheapest addition in this plan. Add `pm25` and `aqi` entries to
  `METRICS` with `kind: "weather"`. The complication: the current weather
  sampler hits `api.open-meteo.com/v1/forecast`; air quality lives on a
  different host with different `hourly=` params. Extend the grid-fetch path
  to select endpoint + params by metric (keep one shared grid/interpolation
  path; only the fetch URL/param builder branches). Cache air-quality samples
  separately from weather samples so switching modes doesn't refetch both.
- **Color stops:** follow US AQI breakpoints — 0–50 green `[63,217,143]`,
  51–100 yellow `[250,204,21]`, 101–150 orange `[251,146,60]`, 151–200 red
  `[239,68,68]`, 201–300 purple `[168,85,247]`, 300+ maroon `[136,19,55]`.
  PM2.5 stops: 0, 12, 35, 55, 150, 250 µg/m³ over the same ramp.
- **UI:** the heatmap mode `<select>` in `index.html` gains two options; no
  new rows or badges (heatmap badge already exists).
- **Fallback:** none (live-only, like the existing weather grid — it shows
  idle/error rather than a bundled fallback).
- **Verify:** select AQI mode, badge → `…` → `LIVE`, hover shows formatted
  value, tooltip fmt correct, mode switching back to temperature still works.

### 1.3 More Open-Meteo grid modes (same plumbing as 1.2) — ✅ DONE

Once 1.2 lands the endpoint-per-metric branching, each of these is one more
`METRICS` entry plus a URL/param builder. Both keyless, CORS ok, same
provider attribution.

- **Flood API:** `https://flood-api.open-meteo.com/v1/flood?latitude=…&longitude=…&daily=river_discharge`
  — GloFAS river discharge, global coverage. Mode: `River discharge`, log
  color ramp (discharge spans orders of magnitude), `m³/s` fmt.
- **Climate API:** `https://climate-api.open-meteo.com/v1/climate?…&start_date=2050-01-01&end_date=2050-12-31&models=MRI_AGCM3_2_S&daily=temperature_2m_max`
  — downscaled CMIP6 projections out to 2050. Mode: `Temp 2050 (projection)`
  reusing the temperature color stops. Label the legend/tooltip explicitly as
  a model projection, not a measurement — badge stays `LIVE` (it is fetched
  live) but the mode label carries "(projection)".

---

## Phase 2 — strong visuals, moderate effort

### 2.1 NASA EONET natural events (live point/category layer) — ✅ DONE

- **Endpoint:** `https://eonet.gsfc.nasa.gov/api/v3/events?status=open` —
  wildfires, volcanoes, severe storms, sea/lake ice. No key, CORS ok, NASA
  open data.
- **Shape:** `events[]`, each with `categories[].id` (`wildfires`,
  `volcanoes`, `severeStorms`, `seaLakeIce`, …) and `geometry[]` (Points,
  sometimes many per event = storm track; take the latest for the marker,
  optionally draw the track as a polyline for storms).
- **Design:** standalone layer `js/layers/events.js`, one icon/color per
  category (🔥 wildfire orange, 🌋 volcano red, 🌀 storm cyan, 🧊 ice white —
  use colored points or small billboards, no external images needed).
  Category filter checkboxes follow the category-filter pattern already used
  by `BodyLayer` markers. Click → Wikipedia panel at location.
- **Refresh:** 15 min. Fallback: none. Badges/sidebar/wire-up identical to
  the checklist in 1.1.
- **Overlap note:** deliberately chosen over GDACS (similar coverage, EONET
  has the cleaner API). Do not add both.

### 2.2 NOAA SWPC aurora oval (live polar overlay) — ✅ DONE

- **Endpoint:** `https://services.swpc.noaa.gov/json/ovation_aurora_latest.json`
  — `coordinates: [[lon 0–359, lat -90–90, probability 0–100], …]` full-globe
  grid, ~30 min cadence. Also `https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json`
  for a Kp readout in the tooltip/legend. No key. US Gov public domain.
- **Design:** render as a translucent canvas texture on a
  `SingleTileImageryProvider`-style overlay or reuse the heatmap canvas path:
  the existing heatmap already rasterizes a grid to a canvas draped on the
  globe — the cleanest route is a new heatmap `kind: "aurora"` metric that
  bypasses Open-Meteo sampling and instead ingests this prebaked grid
  (probability → green-glow alpha ramp: 0 transparent → 100 bright
  `[63,255,143]`). Longitude is 0–359 east — convert to −180…180 before
  gridding.
- **Verify:** with mode on, high-latitude glow visible over Scandinavia/
  Canada; probability tooltip matches raw JSON spot-checks; equator fully
  transparent.

### 2.3 Launch Library 2 — upcoming rocket launches (live markers) — ✅ DONE

- **Endpoint:** `https://ll.thespacedevs.com/2.2.0/launch/upcoming/?limit=30&mode=list`
  — unauthenticated quota ~15 req/hr, so fetch once on toggle-on and refresh
  no more than every 30 min; cache in `sessionStorage` with timestamp to
  survive reloads. CORS ok.
- **Shape:** `results[].name`, `.net` (ISO launch time), `.pad.latitude/
  longitude`, `.pad.location.name`, `.launch_service_provider.name`,
  `.status.abbrev`.
- **Design:** standalone layer `js/layers/launches.js`; marker at each pad
  (one marker per pad, stacking multiple launches into one tooltip list);
  tooltip shows `Falcon 9 · Starlink G10-23 · T-3d 4h · Cape Canaveral SLC-40`
  with a live-updating countdown (recompute in `update()`, no extra fetches).
  Click → Wikipedia panel (geosearch finds the launch site article).
- **Fallback:** none. On 429, badge idle with "rate limited" tooltip detail.
- **Attribution:** “Launch data: The Space Devs (Launch Library 2)”.

---

## Phase 3 — data-pipeline datasets (new `update-*.mjs` + committed files)

Each of these follows conventions §0.6 exactly: fetch script + validator +
npm scripts + committed `.latest` file. They are static-ish datasets, so the
runtime path reads the committed file directly (badge `DATA` is the honest
steady state; there is no live fetch at runtime).

### 3.1 Submarine cables — ✅ DONE

- **Source:** GeoJSON from the TeleGeography submarine cable map repo:
  `https://raw.githubusercontent.com/telegeography/www.submarinecablemap.com/master/web/public/api/v3/cable/cable-geo.json`
  (verify path at implementation time — the repo layout has moved before;
  search the repo for `cable-geo.json` if 404). CC BY-NC-SA — **check the
  current license file in that repo before shipping**; if it's still NC, keep
  the layer but confirm this project's usage is acceptable (non-commercial
  hobby project) and attribute prominently; if unacceptable, drop 3.1.
- **Pipeline:** `update-submarine-cables.mjs` → simplify geometry (round
  coords to 3 dp, drop properties except name/color) →
  `data/submarine-cables.latest.geojson`. Validator: FeatureCollection of
  (Multi)LineStrings, count in 400–700 range, coords in bounds.
- **Runtime:** polyline layer `js/layers/cables.js` styled like
  `js/layers/shipping.js` corridors (thin glowing lines, per-cable color from
  the dataset). Sidebar row next to Shipping.

### 3.2 Global Power Plant Database (WRI) — ✅ DONE

- **Source:** `https://datasets.wri.org/dataset/globalpowerplantdatabase` —
  CSV (~35k rows: name, capacity_mw, primary_fuel, lat/lon). CC-BY 4.0. The
  direct CSV URL must be resolved at implementation time from that page.
- **Pipeline:** `update-power-plants.mjs` → keep name, fuel, capacity, coords;
  bucket to `data/power-plants.latest.json` (array-of-arrays to keep the file
  small: `[lon, lat, fuelIdx, mw]` + a `fuels` legend in `meta`). Validator:
  row count > 25k, coords valid, fuel indices in range.
- **Runtime:** either a point layer colored by fuel (coal grey, gas orange,
  hydro blue, nuclear violet, solar yellow, wind teal) with capacity-scaled
  size, or a new heatmap country/cell mode. Point layer is the better visual;
  size cap needed so China/India don't wash out.

### 3.3 OurAirports (reference data for flights layer) — ✅ DONE

- **Source:** `https://davidmegginson.github.io/ourairports-data/airports.csv`
  — public domain, all world airports (ident, type, name, lat, lon,
  iso_country).
- **Pipeline:** `update-airports.mjs` → filter `type in (large_airport,
  medium_airport)` (~5k rows) → `data/airports.latest.json`.
- **Runtime:** not a standalone layer initially — use it inside
  `js/layers/flights.js` to resolve OpenSky origin/destination ICAO codes to
  named coordinates in the flight tooltip, and optionally draw a faint
  great-circle from origin when a flight is hovered. This is an enhancement
  to an existing layer, so keep the diff scoped to tooltip/hover code.

### 3.4 Natural Earth time zones — ✅ DONE

- **Source:** `https://naciscdn.org/naturalearth/10m/cultural/ne_10m_time_zones.zip`
  (shapefile; convert via `mapshaper` in the update script — it can run via
  `npx mapshaper` without becoming a runtime dep) or a pre-converted GeoJSON
  mirror (`nvkelso/natural-earth-vector` GitHub repo has
  `geojson/ne_10m_time_zones.geojson`). Public domain.
- **Pipeline:** simplify aggressively (this is a large file; target < 1.5 MB)
  → `data/time-zones.latest.geojson`.
- **Runtime:** choropleth-style translucent bands colored by UTC offset
  (cyclic palette), rendered through the heatmap polygon path (`kind:
  "country"`-like lookup but from its own file), or as its own thin layer.
  Tooltip: `UTC+5:30 · 14:22 local`. Lower priority than 3.1–3.3 — do last.

---

## Phase 3.5 — global statistical indicators (new country choropleth modes)

All of these land the same way: fetch in the Node pipeline (CORS is
irrelevant there), merge into `data/country-stats.latest.json` (or a sibling
file) keyed by ISO3, then add a `kind: "country"` entry to `METRICS` in
`js/layers/heatmap.js` — roughly 30 lines per indicator once the fetcher
exists. `scripts/data/update-country-stats.mjs` (World Bank + UNDP HDR + OWID)
is the template and probably the file to extend.

**Scope rule (settled — don't relitigate):** national open-data portals
(data.gov.sg, data.gov.my, data.gov, data.gov.uk, …) are NOT added as their
own layers — one-country coverage breaks the globe's interaction parity. A
national source is acceptable only as a regional gap-filler inside an
existing global layer (the Digitraffic-inside-AIS pattern in `js/ais.js`).
The sources below are the global harmonizers to use instead.

### IMF DataMapper (do this one first)

- **Endpoint:** `https://www.imf.org/external/datamapper/api/v1/{code}` →
  `{ values: { {CODE}: { {ISO3}: { {year}: value } } } }`. Keyless. Multiple
  codes per request via `/{code1}/{code2}`.
- **Indicator codes:** `NGDP_RPCH` (real GDP growth %), `PCPIPCH` (inflation
  %), `LUR` (unemployment %), `GGXWDG_NGDP` (gov gross debt % of GDP).
- **Unique angle:** WEO data includes *projections* ~5 years ahead — a
  "GDP growth (IMF forecast)" mode showing a future year is something no
  other source here offers. Store the year per value; label forecast years
  explicitly in the tooltip (`2030 · IMF projection`).
- Entities include aggregates (e.g. `WEOWORLD`, region groups) — filter to
  ISO3 country codes when merging.

### Our World in Data grapher CSVs (path of least resistance)

- Already used for CO₂ in `update-country-stats.mjs`. Any OWID grapher chart
  is downloadable as `https://ourworldindata.org/grapher/{slug}.csv` with
  harmonized ISO3 `Code` column. When OWID carries an indicator, prefer this
  over the underlying source's API — one CSV, no pagination, pre-cleaned.
  Candidates: `life-expectancy`, `share-of-individuals-using-the-internet`,
  `renewable-share-energy`, `human-rights-index-vdem`.

### WHO GHO (health indicators)

- **Endpoint:** `https://ghoapi.azureedge.net/api/{IndicatorCode}` — OData,
  keyless. E.g. `WHOSIS_000001` (life expectancy at birth; filter
  `Dim1 eq 'SEX_BTSX'` for both sexes). Country dim is ISO3
  (`SpatialDimType eq 'COUNTRY'`).

### UN SDG Indicators API (feasible but clunky — lowest priority in 3.5)

- **Endpoint:** `https://unstats.un.org/sdgapi/v1/sdg/Series/Data?seriesCode={code}&pageSize=…`
  — keyless JSON, paginated, slow. Take the latest year per country.
- Only ship series with wide coverage — e.g. `SI_POV_DAY1` (extreme poverty
  %), `EG_FEC_RNWX` (renewable energy share). Many series are sparse or lag
  2–4 years; the validator must enforce a minimum country count (≥ 120) and
  drop the series otherwise rather than shipping a mostly-grey map.

### FAOSTAT (agriculture/food)

- Keyless API/bulk CSV (`fenixservices.fao.org/faostat` — resolve the exact
  data URL at implementation time). Candidates: cropland share of land area,
  dietary energy supply (kcal/capita/day).

### UNHCR Population API (two deliverables)

- **Endpoint:** `https://api.unhcr.org/population/v1/population/?year=…&coo_all=true&coa_all=true`
  — keyless JSON: refugees + asylum seekers by country of origin (`coo`) and
  asylum (`coa`), ISO3-coded.
- **Deliverable A (cheap):** choropleth modes `Refugees hosted` /
  `Refugees hosted per 1k population` through the standard pipeline path.
- **Deliverable B (standout visual, more work):** an origin→asylum **arc
  layer** — great-circle arcs weighted by population, styled like
  `js/layers/shipping.js` corridors. Top ~150 corridors only. This is its own
  layer class + pipeline file (`data/refugee-flows.latest.json`), not a
  heatmap mode. Treat as optional stretch after Deliverable A.

---

## Phase 4 — wildcard / fun

### 4.1 Wikimedia pageviews → “what the world is reading” (marker weighting)

- **Endpoint:** `https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/all-access/user/{title}/daily/{start}/{end}`
  — no key; requires a descriptive `User-Agent`/`Api-User-Agent` header; CORS
  ok. One request per article, so **batch carefully**: only fetch for
  articles currently in view (the panel list or visible markers), cap ~50 per
  interaction, cache results in-memory for the session.
- **Design:** no new layer — enhance existing Wikipedia markers (`BodyLayer`
  markers and/or Earth click results in `js/wiki-panel.js`): scale marker
  size/brightness by `log10(views/day)`, add `12k views/day` to the panel row
  metadata. Ship behind a small toggle in the panel header, off by default,
  so the extra request volume is opt-in.
- **Note:** works for Earth and off-Earth article markers alike (titles are
  en.wikipedia titles in both paths) — a genuinely cross-body feature, which
  fits interaction-parity principle §0 (CLAUDE.md #3).

### 4.2 NASA CNEOS fireballs (historical bolide events)

- **Endpoint:** `https://ssd-api.jpl.nasa.gov/fireball.api?req-loc=true&limit=500`
  — fields `date`, `energy` (kt), `lat`, `lat-dir`, `lon`, `lon-dir` (convert
  N/S/E/W to signed). No key, CORS ok. Some rows lack coordinates even with
  `req-loc=true` — skip them.
- **Design:** standalone layer, energy-scaled orange dots with year-range
  slider optional (start without it). Chelyabinsk (2013, 440 kt) should
  visibly dominate — good sanity check. Refresh: daily at most; effectively
  static per session.

### 4.3 NHC active tropical storms

- **Endpoint:** `https://www.nhc.noaa.gov/CurrentStorms.json` — active
  Atlantic/E-Pacific storms with position, intensity, movement. **CORS is
  unverified** — check `Access-Control-Allow-Origin` first; if blocked,
  drop this item rather than adding a proxy (project has no server side).
  Coverage is seasonal and basin-limited; EONET severeStorms (2.1) already
  covers the global case, so treat this as an optional upgrade giving richer
  intensity data, not a required item.

---

## Explicitly rejected (do not implement)

| Source | Reason |
| --- | --- |
| OpenAQ | Requires API key since v3 (2024). Open-Meteo AQ (1.2) replaces it. |
| NASA FIRMS active fires | Requires (free) MAP_KEY. EONET wildfires (2.1) covers it keyless. |
| GDACS | Overlaps EONET; EONET API is cleaner. |
| Blitzortung lightning | Unofficial websocket protocol, unstable, unclear ToS. |
| aisstream.io expansion | Already integrated; requires key (existing exception, not a pattern to grow). |
| ECB Data Portal | Keyless SDMX, but euro-area/EU coverage only; its one global dataset (EUR reference FX rates) maps awkwardly onto a country choropleth. |
| Eurostat / OECD APIs | Clean and keyless, but member-state coverage only — breaks global parity. |
| UN Comtrade | Requires a subscription key for useful request volumes since the 2023 API migration. |
| National open-data portals as layers (data.gov.sg, data.gov.my, data.gov, …) | One-country coverage; see the scope rule in Phase 3.5 — only usable as regional gap-fillers inside a global layer. |

## Suggested commit granularity

One source per commit, following the existing message style, e.g.
`feat(layers): add USGS earthquake layer`, `feat(heatmap): add air quality
modes`, `feat(data): add submarine cable pipeline and layer`. Each commit
must leave `npm run data:validate` passing and the app bootable with the new
sidebar row functional.
