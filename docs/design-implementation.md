# Wiki Globe — Design & Implementation Document

This document is a complete, self-contained specification of Wiki Globe. It is
written so that an engineer (human or LLM) can implement the entire program
from scratch using only this document, without access to the original source.
It describes the architecture, every module's responsibilities and algorithms,
the exact DOM contract, all external API endpoints, the bundled-data schemas,
and the non-obvious rendering constraints that were learned the hard way.

---

## 1. What the product is

Wiki Globe is a real-time, interactive 3D globe web app built on **CesiumJS**.
On Earth it visualizes live moving layers (satellites, flights, ships), static
infrastructure layers (submarine cables, power plants, time zones), event
layers (earthquakes, natural events, rocket launches), a large family of data
overlays (weather, air quality, choropleths of economic/health indicators,
conflict zones, skyscraper density, aurora), a "true-size" country comparison
tool, and a click-anywhere → "nearby Wikipedia articles" panel. Zooming in
crossfades the night-texture globe into OpenStreetMap street detail.

The app extends beyond Earth: the Moon, Sun, all planets (Mercury → Neptune),
Pluto, and major moons (Io, Europa, Ganymede, Callisto, Titan, Charon) are
rendered at their **live ephemeris positions** with correct IAU orientation,
each focusable as its own textured globe with Wikidata/Wikipedia surface
markers and mission flags.

Finally, an embedded **LLM agent panel** ("Globe agent") lets the user chat
with a tool-using model (OpenRouter / DeepSeek / Ollama, user-supplied key)
that can search Wikipedia/Wikidata, read bundled country statistics, and draw
pins, routes, labels, outlines, and choropleths directly on the globe.

### 1.1 Core design principles (apply everywhere)

1. **Live data first; bundled data is fallback only.** Never replace a live
   fetch with a hardcoded list. Small bundled lists may *back up* a live feed.
   Layers that start on fallback data keep retrying the live source and
   promote themselves when it recovers.
2. **Badges tell the truth.** Every layer shows a status badge:
   `LIVE` (fetched from the network now), `DEMO` (synthetic fallback),
   `DATA` (bundled/generated dataset), `CACHED` (last good dataset from
   localStorage), `LIMIT` (API quota hit, backing off), `CORS` (browser origin
   blocked), `…` (loading), `—` (idle / loads on demand). Never lie about
   provenance.
3. **Interaction parity across bodies.** Hover tooltips, click-to-articles,
   auto-rotate work identically on every body — but per-body controls (e.g.
   Earth's day/night toggle) exist only where they genuinely apply.
4. **Only open/permissively-licensed imagery and data**, each with an
   attribution line in the sidebar and README.
5. **No build step.** Plain HTML + CSS + native ES modules, served statically.
   Libraries load from CDN `<script>` tags (globals), not npm.

---

## 2. Tech stack & runtime constraints

- **CesiumJS 1.120** (CDN: `https://cesium.com/downloads/cesiumjs/releases/1.120/Build/Cesium/Cesium.js`
  plus its `widgets.css`). Used as a global `Cesium`.
- **satellite.js 5.0.0** (CDN jsdelivr, global `satellite`) — SGP4 TLE propagation.
- **astronomy-engine 2** (CDN jsdelivr `astronomy.browser.min.js`, global
  `Astronomy`) — planetary/solar ephemerides, Jupiter moon positions,
  eclipse search.
- App code: ES modules under `js/`, entry point `js/app.js` loaded via
  `<script type="module">` from `index.html`.
- **Serving:** any static HTTP server (`python -m http.server 8080` or
  `npx serve -l 8080`). `file://` does NOT work (texture/module/data fetches
  need an HTTP origin). Node is needed only for the offline data pipeline.
- **No tests, no linter, no bundler.** Verification is running the app.
- All external APIs are called directly from the browser and must therefore be
  CORS-friendly (`origin=*` for MediaWiki APIs, open CORS for Open-Meteo,
  USGS, EONET, Digitraffic, etc.).

### 2.1 Directory layout

```
index.html                  — the entire DOM shell + SEO/meta + CDN scripts
css/style.css               — all styling (~1900 lines, dark theme)
assets/*.jpg|png            — body textures (earth day/night, moon, planets,
                              saturn-rings.png, venus-atmosphere.jpg, …)
js/app.js                   — entry point; boot, wiring, focus system, tooltips
js/bodies.js                — single source of truth for body metadata
js/layers/                  — one class per globe layer (see §6–§10)
    satellites.js flights.js shipping.js earthquakes.js events.js
    launches.js cables.js power-plants.js timezones.js heatmap.js
    truesize.js body.js moon.js mars.js sun.js planets.js moons.js
js/wiki-panel.js            — Wikipedia article panel + globe overlays
js/search.js                — country/continent type-ahead search
js/country-geo.js           — shared country polygon dataset + geometry utils
js/continent-geo.js         — continent/region definitions assembled from countries
js/country-data.js          — legacy bundled per-country stats (fallback)
js/country-stats.js         — live-first country stats access + income bands
js/demo-data.js             — deterministic demo flights/satellites/vessel names
js/airports-data.js         — OurAirports lookup for route enrichment
js/ais.js                   — live AIS providers (aisstream WS, Digitraffic REST)
js/ais-data.js              — MMSI→flag, ship type codes, port gazetteer
js/shipping-lanes.js        — lane loader (generated GeoJSON + bundled fallback)
js/agent/harness.js         — agentic tool-call loop + grounding system prompt
js/agent/providers.js       — OpenAI-compatible provider registry + storage
js/agent/tools.js           — tool registry (schemas + implementations)
js/agent/chat-panel.js      — chat UI, sessions/history, overlay replay
data/*.latest.json|geojson  — generated datasets (committed; runtime fallbacks)
data/*-missions.json        — hand-curated mission supplements per body
data/heatmap-metrics.json   — generated metric/legend config for the heatmap
scripts/data/update-*.mjs   — Node fetch-and-generate scripts
scripts/data/validate-*.mjs — schema/sanity validators
package.json                — only `data:update*` / `data:validate` scripts
.claude/launch.json         — dev server config (python http.server, port 8080)
```

---

## 3. The DOM contract (`index.html`)

`index.html` contains **all** UI markup; JS only toggles/hides/fills it. The
`<body>` carries `data-focus="earth"` (updated to the focused body key). Key
structure and required element IDs:

- `#cesiumContainer` — the Cesium viewer mount.
- `#search` (`data-scope="earth"`) with `#search-input` and `#search-results`
  — place search.
- `#sel-body` — `<select>` body switcher, populated at boot from
  `BODY_CHOICE_GROUPS` with `<optgroup>` per planetary system.
- `#panel` — the left control panel with two tab buttons (`#panel-toggle`
  "Menu", `#about-toggle` "About") and two panes (`#panel-menu`,
  `#panel-about`). The menu pane contains:
  - A collapsible `<details class="layer-group" data-scope="earth">`
    ("Map layers") containing per-layer rows. Each layer row is
    `<label class="row main">` with an `<input type=checkbox id="chk-XXX">`,
    a colored `<span class="dot dot-XXX">`, a name, a
    `<span class="badge" id="badge-XXX">` and a
    `<span class="count" id="count-XXX">`. Layers with sub-options add
    `row sub` rows. IDs used:
    - satellites: `chk-sats`, `chk-sat-paths`, `badge-sats`, `count-sats`
    - flights: `chk-flights`, `chk-flight-routes`, `badge-flights`, `count-flights`
    - shipping: `chk-ships`, `chk-vessel-routes`, `badge-ships`, `count-ships`
    - cables: `chk-cables`, `badge-cables`, `count-cables`
    - power plants: `chk-plants`, `badge-plants`, `count-plants`
    - time zones: `chk-timezones`, `badge-timezones`, `count-timezones`
    - earthquakes: `chk-quakes`, `badge-quakes`, `count-quakes`, plus a
      `#sel-quake-feed` select (`hour`/`day` (default)/`week`)
    - natural events: `chk-events`, `badge-events`, `count-events`, plus a
      block of category checkboxes `.chk-event-cat[data-cat=…]` for
      wildfires/volcanoes/severeStorms/seaLakeIce/floods (checked by default)
      and drought/temperatureExt/dustHaze/landslides/manmade/waterColor/snow
      (unchecked)
    - launches: `chk-launches`, `badge-launches`, `count-launches`
  - **Data overlay** row (`data-scope="earth"`): `#sel-heatmap` select with
    ~35 options in `<optgroup>`s (weather live, air quality live, hydrology,
    climate projection, space weather, country statistics, demographics,
    health & access, inequality, climate/air/energy, IMF outlook, OWID,
    WHO, built environment, conflict), plus badge `#badge-heat` /
    `#count-heat`, and a `#wb-controls` block (hidden until a mode is active)
    containing a legend gradient `.wb-bar`, tick labels `.wb-ticks`, and
    `#wb-weather-rows` with three sliders: `#wb-res` (0–3, default 2 → 10°),
    `#wb-day`, `#wb-hour`, plus labels `#wb-res-label`, `#wb-day-label`,
    `#wb-hour-label`, `#wb-when-val`.
  - **True-size compare** row: `#chk-truesize`, `#count-truesize`, a help
    block `#ts-help` (hidden) with a `#ts-clear` link.
  - **Moon** rows (`data-scope="moon"`): `#chk-moon` (checked), `#badge-moon`,
    `#count-moon`, `#chk-moon-wiki` (checked), `#sel-moon-category`
    (all/missions(default)/craters/maria/mountains/basins/other).
  - **Mars** rows (`data-scope="mars"`): `#chk-mars`, `#badge-mars`,
    `#count-mars`, `#chk-mars-wiki`, `#sel-mars-category`
    (all/missions(default)/craters/mountains/regions/other).
  - **Generic planet** rows (`data-scope="sun mercury venus jupiter io europa
    ganymede callisto saturn titan uranus neptune pluto charon"` — a single
    row reused for whichever of these is focused): `#dot-planet`,
    `#name-planet`, `#badge-planet`, `#count-planet`, `#chk-planet-wiki`,
    `#sel-planet-category` (same options as Mars).
  - **Auto-rotate** row (universal, no data-scope): `#chk-rotate` (checked).
  - **Day/night cycle** row (`data-scope="earth"`): `#chk-daynight` (checked).
  - A `<details class="howto" open>` "How to explore Wikipedia" guide.
  - An attribution `.attrib` block naming every data/imagery source, with an
    `#ais-key-link` anchor ("key") to set the aisstream API key, and
    GitHub/LinkedIn SVG logo links.
- `#tooltip` — floating hover tooltip div (hidden by default).
- `#wiki-panel` — right-side Wikipedia panel: resize handle
  `#wiki-resize-handle.right-panel-resize-handle`, collapse tab `#wp-toggle`
  ("Wiki"), header with `#wp-close`, `#wp-coords`, radius slider block
  (`#wp-radius` range 0–100 default 55, `#wp-radius-label`), and `#wp-results`.
- `#agent-panel` (starts with class `collapsed`) — right-side agent panel:
  resize handle `#agent-resize-handle`, tab `#agent-toggle` ("Agent"), header
  with title, `#agent-status` subtitle, `#agent-badge`, icon buttons
  `#agent-settings-toggle` (⚙), `#agent-history-toggle` (↺),
  `#agent-new-session` (+), `#agent-close` (×); a settings form
  `#agent-settings` (provider select `#agent-provider`, key input
  `#agent-key`, base URL `#agent-base-url` row hidden unless configurable,
  model select `#agent-model`, `#agent-model-override` text input, save button
  `#agent-save-settings` + `#agent-settings-save-msg`, `#agent-provider-note`,
  `#agent-ollama-hint`); a history pane `#agent-history` /
  `#agent-history-list`; the transcript `#agent-transcript` containing an
  empty-state with example prompt buttons
  (`.agent-example-prompt[data-agent-example-prompt]`), a checkpoint block
  `#agent-checkpoint` (with `#agent-checkpoint-msg`, `#agent-continue`,
  `#agent-terminate`), `#agent-output`, `#agent-tool-log`; a usage footer
  `#agent-usage` ("Tokens: input 0, output 0"); and the composer `#agent-form`
  with `#agent-input` textarea, `#agent-submit`, and hidden `#agent-cancel`.
- `#hint` — onboarding hint bar ("Drag to rotate · Scroll to zoom · Click
  anywhere to explore Wikipedia"); JS adds class `faded` after 15 s.
- `#moon-back` — hidden "← Back to Earth" button, shown whenever a non-Earth
  body is focused.
- `#error` — hidden fatal-error banner (WebGL/boot failure).
- `<noscript>` fallback text block.

**Scoping rule:** every element with a `data-scope` attribute lists one or
more body keys (space-separated). On focus change the app sets
`document.body.dataset.focus = bodyKey` and hides each scoped element unless
its scope list contains the current key. Unscoped elements are universal.

`index.html` also contains: SEO/meta/OpenGraph/Twitter tags, JSON-LD
`WebApplication` schema, analytics snippets (Clarity, gtag — optional),
preconnect/preload hints for cesium.com, jsdelivr, tile.openstreetmap.org and
the two Earth textures.

---

## 4. Boot sequence and app wiring (`js/app.js`)

`boot()` is async and is the only top-level entry; failures render into
`#error` ("Could not start the globe (…). WebGL is required.").

### 4.1 Viewer construction

```js
await loadHeatmapMetrics();               // hydrate METRICS from data JSON first
const viewer = new Cesium.Viewer("cesiumContainer", {
  baseLayer: Cesium.ImageryLayer.fromProviderAsync(
    Cesium.SingleTileImageryProvider.fromUrl("assets/earth-night.jpg")),
  baseLayerPicker:false, geocoder:false, homeButton:false,
  sceneModePicker:false, navigationHelpButton:false, animation:false,
  timeline:false, fullscreenButton:false, selectionIndicator:false, infoBox:false,
});
```

Scene setup:
- `globe.showGroundAtmosphere = true`, `globe.baseColor = #06090f`.
- **`scene.camera.frustum.far = 1e13`** — must contain Neptune's true
  distance; Cesium's logarithmic depth buffer makes this workable.
- `screenSpaceCameraController.minimumZoomDistance = 120`,
  `maximumZoomDistance = 4.5e7`.
- Remove the default `LEFT_DOUBLE_CLICK` input action (it zooms to entities
  and fights the click-to-Wikipedia UX).
- Initial camera: `setView` to lon 10, lat 22, height 2.3e7 m (this is also
  the shared "home view" used when returning from other bodies).

Real-time solar illumination: `clock.currentTime = now`, `multiplier = 1`,
`clockStep = SYSTEM_CLOCK`, `shouldAnimate = true`,
`globe.enableLighting = true`, `dynamicAtmosphereLighting(+FromSun) = true`.
A **day texture layer** (`assets/earth-day.jpg` as a second
SingleTileImageryProvider) is added above the night base with
`dayLayer.nightAlpha = 0` — with lighting on, the day texture fades out on the
night side revealing the night-lights texture, blending at the terminator.

An **OSM detail layer** (`Cesium.OpenStreetMapImageryProvider`, url
`https://tile.openstreetmap.org/`) is added with `alpha = 0`. Every frame:
`osmLayer.alpha = clamp((FADE_START − cameraHeight)/(FADE_START − FADE_END), 0, 1)`
with `FADE_START = 2.6e6` m and `FADE_END = 5.5e5` m — streets fade in below
2,600 km and are fully opaque by 550 km.

`syncDayNight()` (called every frame and on toggle): when the day/night
checkbox is off, `dayLayer.nightAlpha = 1` (whole globe day-lit); sun lighting
is enabled only when day/night is on **and** `osmLayer.alpha < 0.8` **and** no
heat overlay is visible (so street maps and overlays stay readable at night).

### 4.2 Layer instantiation

Construct one instance of each layer class with the viewer:
`SatelliteLayer, FlightLayer, ShippingLayer, EarthquakesLayer, EventsLayer,
LaunchesLayer, CablesLayer, PowerPlantsLayer, TimeZonesLayer, HeatmapLayer
(lazy), TrueSizeLayer, SunLayer, MoonLayer, MarsLayer`, plus
`PlanetLayer(viewer, key)` for each of `PLANET_BODY_KEYS`
(mercury, venus, jupiter, saturn, uranus, neptune, pluto) and
`ChildMoonLayer(viewer, key)` for each of `CHILD_MOON_BODY_KEYS`
(io, europa, ganymede, callisto, titan, charon), a `WikiPanel(viewer)`,
`CountrySearch(viewer, truesize, onInteract)` and `AgentChatPanel(viewer)`.

Set each Earth layer's initial visibility from its checkbox (all unchecked by
default → hidden), then call `init()` on every layer.

`bodyLayers = { sun, ...planets, ...childMoons, moon, mars }` — keyed by body
key; `focusedBody` starts as `"earth"`.

At the very end of boot expose everything for console debugging:
`window.__globe = { viewer, sats, flights, ships, quakes, events, launches,
cables, plants, timezones, heat, wiki, truesize, search, agent, sun, moon,
mars, planets, childMoons, bodyLayers }`.

### 4.3 Body focus system

State: `focusedBody` (key or `"earth"`), `pendingFocusBody`,
`departingTarget`, `heatModeSuspended`.

`focusBody(body)`:
- `"earth"`: blur the current body layer (which flies home); if a departure
  flight was in progress, cancel it and fly to home view directly.
- other body: determine `isLocalBodyHop(from, to)` — true when the two bodies
  are parent/child/siblings **and neither** has `config.transition.proxy`
  (bodies needing a proxy are at true interplanetary distance; a "local" hop
  between e.g. Jupiter and Io still breaks Cesium's flight-arc math, so those
  route through the proxy anyway). Then:
  - if some body is currently focused: `current.blur({flyHome:false})` then
    `target.focus({direct: localHop})`;
  - if coming from Earth: `departEarth(target)` — fly the camera straight up
    from its current lat/lon to `1.5 × target.proxyDistance` over 1.2 s, then
    `target.focus()`. This prevents the incoming proxy globe (anchored near
    Earth) from popping in next to the camera.

`onBodyFocusChanged(bodyKey, focused)` (wired as each layer's
`onFocusChanged`):
- on focus: record `focusedBody`; run `syncBodyControls`; if we left Earth,
  **suspend** all Earth layers (`setVisible(false)` on each — checkbox states
  untouched) and stash + clear the heatmap mode.
- on blur: if no other focus is pending and no body layer remains focused,
  restore `focusedBody = "earth"`, `syncBodyControls("earth")`, restore each
  Earth layer's visibility from its checkbox, and re-apply the suspended
  heatmap mode.

`syncBodyControls(body)` = show/hide `#moon-back`, sync `#sel-body`,
`syncScopedUi` (the data-scope rule from §3), `syncChildSky`,
`syncPlanetControls` (fills the generic planet row: name, dot color from
`skyDot.color ?? markerColor`, wiki checkbox/category/badge/count — all hidden
when `config.wikiEnabled === false`, i.e. the Sun), close the wiki panel, and
call `setArticlesVisible(key === body)` on every body layer (article markers
exist only in their own focus context).

`syncChildSky(body)` decides, for every body layer, whether it is a "context
body" (the parent of the focused body, a child of it, or a sibling sharing its
parent) → `setContextVisible(true)` renders its real textured globe in the sky
instead of a dot; whether its sky dot shows (parents/top-level bodies show
their dot except when they are context; child moons show dots only when the
camera is inside their system: focused body is their parent, themselves, or a
sibling); context bodies also get an HTML overlay label (see §10.6).

### 4.4 Per-frame loop

A `scene.preUpdate` listener runs every frame:
- compute `dt` (clamped to 0.25 s) from `Date.now()`;
- `tick(now)` on sats, flights, ships, quakes, events, launches; `tick()` on
  every body layer;
- OSM alpha fade + `syncDayNight()` (§4.1);
- **auto-rotate**: when `#chk-rotate` is on, `dt > 0`, more than 8 s since the
  last user interaction (`pointerdown`/`wheel`/`touchstart` on the canvas, or
  a search fly-to), and the wiki panel is closed:
  - if a body layer is focused and `tracking`, `camera.rotateLeft(−0.006·dt)`
    (orbits inside the look-at frame);
  - else if on Earth and camera height > 1.2e6 m,
    `camera.rotate(UNIT_Z, −0.006·dt)`.

### 4.5 Picking, tooltips, clicks

One `ScreenSpaceEventHandler` on the canvas.

**MOUSE_MOVE** (throttled to ≥30 ms): `scene.pick`; a pick target is valid if
`picked.id.kind` exists (every primitive/entity in the app sets
`id = { kind, …payload }`). Hover transitions drive flight route preview
(`flights.showRouteFor(f, false)` on enter, `clearHoverRoute()` on leave).
Tooltip HTML comes from `tooltipHtml(id)` — a switch over `kind` producing
2–3 line cards (title / stat line / provenance note). Special cases when
nothing is picked: on a non-Earth body, hovering the Earth ellipsoid shows
"Earth — click to return"; on Earth with a heat overlay visible, sample
`heat.valueAt(lat, lon)` and show the overlay tooltip. Tooltip is positioned
at cursor + (16, 14), clamped to the window. Cursor style: `grab/grabbing`
over true-size overlays, `pointer` over any pick or Earth-return hover.

Tooltip kinds and their content (implement all): `sat` (name, altitude km,
demo vs "Live TLE · SGP4"), `flight` (callsign, alt km + km/h, route label or
origin→destination, "demo flight" marker), `vessel` (name or MMSI, type +
flag, speed kn + heading + destination, live vs simulated), `heat` (per-kind
formats for region/conflict/skyscraper/country/weather samples incl. wet-bulb
heat-stress label), `truesize` (name, area, drag/rotate/remove key guide),
`quake` (M + depth, place, time-ago + tsunami flag + USGS), `event` (title,
category + date, EONET), `launch` (pad name, up to 3 launches with T-minus
countdowns, LL2), `cable` (name, TeleGeography), `plant` (name, fuel + MW,
country + WRI GPPD), `timezone` (UTC offset, computed local time, Natural
Earth), `lane` (name, tier + length km), `moon`/`body` (name, live distance
from Earth km, ephemeris/imagery note, "click to visit"),
`moonwiki`/`marswiki`/`bodywiki` (article title, lat/lon + body + mission
country, category, "click to open article"), `wiki` (title, distance away).

**LEFT_CLICK** dispatch by `kind`:
- `sat` → `sats.select(sat)` (highlight its orbit); `flight` →
  `flights.showRouteFor(f, true)`; `vessel`/`truesize` → no-op (handled
  elsewhere); `quake`/`event`/`launch` → `wiki.open(lat, lon)`;
- `wiki` → `wiki.focusArticle(article, {openPopup:true})`;
- `moonwiki` → `focusBody("moon")` + `moon.openArticle(...)`; `marswiki`
  similarly; `bodywiki` → focus that body + `layer.openArticle(...)`;
- `moon`/`body` → if not focused, `focusBody(key)`; if focused and wiki
  enabled, `pickSurface(click)` → `openArticlesAt(lat, lon, wiki)`;
- if `focusedBody !== "earth"`: clicking the Earth ellipsoid returns home;
  anything else is a no-op;
- otherwise (empty Earth globe / a shipping lane): deselect sat + flight,
  `pickEllipsoid` → lat/lon; if true-size mode is enabled and
  `truesize.tryAdd(lat,lon)` consumed the click, stop; else if the conflict
  heatmap is active, look up `heat.conflictAt(lat,lon)`; then
  `wiki.open(lat, lon, { conflict })`.

### 4.6 Control wiring

- `bind(id, fn)` helper attaches `change` → `fn(checked)` for every checkbox
  (each simply calls the layer's `setVisible` / feature setter).
- Quake feed select → `quakes.setFeed(value)`; event category checkboxes →
  `events.setCategory(cat, checked)`.
- Heatmap select (`#sel-heatmap`, enhanced — see §4.9): on change,
  `heat.setMode(value||null)`; show `#wb-controls` when a mode is active; show
  the weather rows only for `METRICS[mode].kind === "weather"`; paint the
  legend bar as a `linear-gradient` of the metric's `legend` colors and the
  tick labels from its labels.
- Resolution slider: `RES_STEPS = [20,15,10,7.5]` degrees;
  `heat.setResolution(step)`.
- Day/hour sliders index `heat.times` (hourly UTC, oldest day midnight →
  now): `idx = day*24 + hour`, clamped; `heat.setTimeIndex(idx)`;
  `wbSyncTimeUI()` recomputes slider maxima (the final day ends at the current
  hour), labels ("today"/"Jul 9"), and the "Viewing …" caption with an
  "(now)" suffix on the newest hour; it is also registered as
  `heat.onDataChanged`.
- True-size: checkbox → `setEnabled`; `#ts-clear` → `clear()`;
  `truesize.onChanged` updates `#count-truesize` and shows `#ts-help` while
  mode is on or overlays exist.
- Moon/Mars/planet wiki checkboxes and category selects call
  `setWikiEnabled`/`setCategory` on the respective layer (the generic planet
  controls act on `bodyLayers[focusedBody]`), closing the wiki panel when it
  is showing a body list that just changed.
- `#ais-key-link` → `prompt()` for an aisstream.io key; `setAisKey(key)` and
  `location.reload()`.

### 4.7 Status badges

`setBadge(el, source)` maps source → `[label, cssClass]`:
`live→LIVE/live`, `demo→DEMO/demo`, `static→ROUTES/static`, `loading→…/loading`,
`limited→LIMIT/demo`, `blocked→CORS/demo`, `cache→CACHED/static`,
`data→DATA/static`, `idle→—/static`. A 1 Hz `setInterval` polls every layer's
`counts()` → `{count, source, detail?}` and updates badge text/class, count
text, and `title` tooltips with the detail string. Additionally
`hideIfLiveLimited`: the first time a layer reports source `limited` or
`blocked`, auto-uncheck and hide it (once per layer per state entry) so a
rate-limited feed doesn't sit there spinning.

### 4.8 Responsive panels & right-panel resize

`setupResponsiveSideMenus()` manages three panels: left `controls` panel
(with menu/about tabs) and the two **right panels** (`wiki`, `agent`) which
share a single slot — at most one is expanded ("active") at a time; the other
shows only its edge tab. Rules:
- Right panels start collapsed (`agent-panel` has class `collapsed` in HTML;
  both get `collapsed right-panel-pane-inactive` at init).
- Clicking a right panel's tab: if it is the active one, collapse the slot;
  otherwise activate it (adds `right-panel-pane-active`, removes `collapsed`;
  activating wiki also forces class `open`).
- Custom DOM events: `right-panel:activate` (detail `{panel}`) activates a
  panel (dispatched by WikiPanel/AgentChatPanel when they want to open);
  `right-panel:closed` collapses the slot if that panel was active.
- Compact media query `(max-width: 1199px)`: on compact screens everything
  defaults collapsed; on desktop, if the user hasn't manually toggled, the
  default right panel is the first one without `defaultCollapsed` (the agent
  panel — wiki has `defaultCollapsed: true`).
- The left panel: menu/about are tabs; clicking the active tab collapses the
  panel; clicking the other switches panes. ARIA `aria-expanded`/labels are
  kept in sync throughout.

`setupRightPanelResize()`: both right panels share a CSS variable
`--right-panel-width` (default 392 px, min 320, max 760, clamped to
`window.innerWidth − 46`). Drag on `.right-panel-resize-handle`
(pointer-capture; width = `innerWidth − clientX`), keyboard on the handle
(arrows ±24 px, Shift ±64, Home/End to min/max), persisted in
localStorage key `wikiglobe.agent.panelWidth`, re-clamped on window resize.
`body.right-panel-resizing` class is set during drags (CSS disables
transitions/selection).

### 4.9 Enhanced heatmap select

`enhanceHeatmapSelect(select)` converts `#sel-heatmap` into a searchable
combo-box: hides the native select (kept for state + change events, made
`aria-hidden`, `tabIndex −1`), builds `.heat-combo` with a
`.heat-combo-button` (current label + chevron) and a `.heat-combo-menu`
(hidden) containing a `.heat-combo-search` input and a
`role="listbox"` `.heat-combo-list`. Options are flattened from
option/optgroup with lowercase keyword strings (label + value + group).
Typing filters (substring); grouped headers re-render; arrow keys/Home/End
move the active option, Enter chooses, Escape closes. Choosing sets
`select.value` and dispatches a bubbling `change` event. Clicking outside
closes; clicking the select's `<label>` opens the menu.

---

## 5. Shared Earth data modules

### 5.1 `country-geo.js`

Shared country polygon dataset, loaded once (memoized promise) and reused by
the heatmap choropleth, true-size compare, search, and agent tools.
- Primary source `GEOJSON_URL` (exported from `country-data.js`; the
  public-domain *world.geo.json* countries file), fallback
  `data/country-boundaries.latest.geojson` (generated copy).
- Each feature is normalized to `{ id (ISO3), name, rings, bbox:[w,s,e,n] }`
  where `rings` is a flat array of every ring (outer + holes; even-odd tests
  disambiguate).
- `countryAt(geo, lat, lon)`: bbox reject then even-odd ray-casting over all
  rings (`pointInRing` toggles per containing ring).
- `countryAreaKm2(f)`: spherical polygon area (Chamberlain–Duquette; signed
  ring sums so holes subtract), R = 6371.0088 km, with antimeridian dLon
  wrapping.
- `formatArea(km2)`: 3 significant figures above 1000, "12,300 km²" style.

### 5.2 `continent-geo.js`

`REGION_DEFS`: hardcoded ISO3 membership lists for continents (Asia, Europe,
North America, South America, Oceania, Africa) and regions (Central America,
Southeast Asia, East Asia, Middle East, South Asia). `buildContinentGeo
(countries)` assembles pseudo-features `{ id, name, type, searchKind:
"region", memberIds, rings (concatenated member rings), bbox, areaKm2 (sum) }`
so continents behave exactly like countries in search and true-size compare.

### 5.3 `country-data.js` / `country-stats.js`

`country-data.js` exports `GEOJSON_URL` and `COUNTRY_STATS`: a legacy bundled
snapshot `{ ISO3: [name, gdpNominal, gdpPpp, hdi, ihdi, gni] }` (~190 rows,
IMF/UNDP 2022–23 estimates) used only as fallback.

`country-stats.js` is the live-first accessor used by the agent:
- `loadCountryStats()` fetches `data/country-stats.latest.json` (12 s
  timeout), falling back to the legacy snapshot (wrapping each value as
  `{value, source:"Bundled legacy snapshot"}`); result cached.
- `STAT_INDICATORS`: metadata (label, unit) for 17 indicator keys
  (gdpNominal, gdpPpp, gni, hdi, ihdi, lifeExpectancy, infantMortality,
  fertility, popDensity, popGrowth, urbanShare, internetUsers,
  electricityAccess, cleanWater, gini, poverty, co2PerCapita).
- `WORLD_BANK_INCOME_BANDS`: FY2025 thresholds (low ≤1145, lower-middle
  ≤4515, upper-middle ≤14005, high above) **using GDP per capita as a proxy**
  for Atlas GNI, with an explicit disclaimer string that must be surfaced in
  tool results. Helpers `classifyIncome`, `incomeBandLabel`,
  `normalizeIncomeGroup`, `statValue` (unwraps `{value}` objects),
  `statYear`.

### 5.4 `demo-data.js`

Deterministic (Mulberry32 PRNG, fixed seeds) offline fallbacks:
- `AIRPORTS`: 48 major airports `{c, name, lat, lon}`.
- `makeDemoFlights(count=200)`: random airport pairs (rejecting near pairs),
  callsign = airline code + number, altM 9800–12400, speed 820–950 km/h,
  `phase` ∈ [0,1) as a time offset along the route.
- `makeDemoSatellites()`: synthetic orbital elements covering familiar
  regimes — an ISS-class station, HST-class telescope, an 8-plane × 6-sat
  Starlink-like constellation (550 km, 53°), 16 sun-sync observers (~97.6°),
  3×4 MEO nav (20,180 km, 55°), 6 GEO slots, 12 misc research sats. Angles
  pre-converted to radians (`inc`, `raan0`, `m0`).
- `vesselName(i)`: "MV {Adjective} {Noun}" generator.

### 5.5 `airports-data.js`

Loads `data/airports.latest.json` once (fire-and-forget);
`lookupAirport(code)` returns `[lon, lat, name, country, municipality]`-backed
records by ICAO/name for enriching flight route endpoint names with
municipalities; returns null until loaded.

### 5.6 `shipping-lanes.js`

`loadShippingLaneData()` fetches `data/shipping-lanes.latest.geojson`
(generated from a digitized CIA World Oceans shipping-lanes dataset; features
carry `name`, `type` "major"/"middle", `polar` flag, LineString waypoints);
on failure the module's bundled `SHIPPING_LANES` array (~20 hand-plotted
corridors with `[lon,lat]` waypoint chains, e.g. Trans-Pacific North,
Asia–Europe via Suez, Trans-Atlantic…) is used. `getShippingLanes()` returns
whichever is loaded.

### 5.7 `ais-data.js`

Maritime reference data: `flagFromMmsi(mmsi)` via a bundled MID→flag-state
table (3-digit MMSI prefix); `shipTypeName(code)` via AIS type-code ranges
(bundled rules, replaceable by `data/ais-ship-types.latest.json`);
`resolveDestination(text)` fuzzy-matches free-text AIS destination strings
("SGSIN", "ROTTERDAM") against a port gazetteer loaded from
`data/ports.latest.json` (UN/LOCODE-derived; legacy list as fallback);
`loadMaritimeReferenceData()` loads all of the above.

---

## 6. Earth movement layers

All layers follow the same informal contract:

```
class SomeLayer {
  constructor(viewer)      // create primitive collections, initial state
  init()                   // async fetch + build (may fall back)
  tick(nowMs)              // per-frame update; cheap, budgeted
  setVisible(v)            // show/hide, checkbox-driven
  counts() → {count, source, detail?}   // for the 1 Hz badge poll
}
```

All moving objects are `PointPrimitiveCollection` points with
`id = {kind, …}` for picking, and `scaleByDistance: NearFarScalar` so dots
shrink when zoomed out. Heavy geometry building is **incremental** — a queue
consumed with a fixed per-frame budget so no frame ever stalls.

### 6.1 Satellites (`layers/satellites.js`)

- **Live**: fetch TLEs from
  `https://celestrak.org/NORAD/elements/gp.php?GROUP=visual&FORMAT=tle`
  (12 s timeout). Parse name/line1/line2 triples via
  `satellite.twoline2satrec`, skip `satrec.error !== 0`, require >10 sats.
  Keep the first `MAX_SATS = 300`.
- **Fallback**: `makeDemoSatellites()` marked `demo:true`; source `demo`;
  retry CelesTrak every 5 min and rebuild everything on recovery (retire
  demo, log "CelesTrak recovered").
- **Position**: live → `satellite.propagate(satrec, date)` then
  `eciToEcf(pos, gstime(date))`, ×1000 to metres; `altKm = |r| − 6371`.
  Demo → closed-form circular orbit: mean motion `n = √(μ/a³)`
  (μ = 398600.4418 km³/s²), `M = m0 + n·t`, RAAN drifts by −ωE·t
  (ωE = 7.2921159e-5 rad/s) so ground tracks precess correctly; rotate the
  in-plane (x, y·cos i, y·sin i) point by RAAN.
- **tick**: round-robin position refresh — update `⌈n/40⌉` sats per frame
  (full sweep every 40 frames). Hide points whose propagation fails.
- **Orbit paths** ("Orbit paths ahead" toggle): per sat, sample one full
  period into 96 points from *now*; polyline width 1, color `#6ef3ff` @0.16.
  Paths are queued and built ≤12 per frame; the whole set is rebuilt every
  8 minutes (positions march forward). Clicking a satellite always draws its
  own highlighted path (`#aef8ff` @0.85) in a separate collection regardless
  of the layer toggle; clicking empty space clears it.
- Point style: 5 px `#6ef3ff`, NearFarScalar(2e5→1.6, 4e7→0.65).

### 6.2 Flights (`layers/flights.js`)

- **Live**: OpenSky `https://opensky-network.org/api/states/all` (25 s
  timeout), refreshed every 120 s. State vector array indices used:
  `[icao24, callsign, country, _, lastContact, lon, lat, baroAlt, onGround,
  vel, track, _, _, geoAlt]`. Skip on-ground/​null-position; cap
  `MAX_LIVE = 2500`. `altM = geoAlt ?? baroAlt ?? 10000`,
  `velMs = vel ?? 230`, `ts = lastContact*1000`.
- **CORS guard**: the public OpenSky endpoint does not allow browser origins
  other than its own — if the configured URL is the default and
  `location.origin !== "https://opensky-network.org"`, report source
  `blocked` immediately (retry only hourly) with a message advising an
  OpenSky proxy. The URL is overridable via `window.WIKI_GLOBE_OPENSKY_URL`,
  `?openskyUrl=`, or localStorage `wikiGlobeOpenSkyUrl`.
- **429 handling**: honor `x-rate-limit-retry-after-seconds`, else back off
  5 min; source `limited`. Other failures → source `demo`, retry 5 min. On
  recovery, retire demo traffic and clear route caches.
- **Demo**: `makeDemoFlights(200)` → `EllipsoidGeodesic` per route (skip
  <700 km); position = `interpolateUsingFraction(((t/1000 + phase·durS) mod
  durS)/durS)`; `durS = distKm/speedKmh·3600`.
- **tick**: round-robin over `⌈n/60⌉` flights per frame; live flights are
  **dead-reckoned** from their last report along their true track
  (great-circle `deadReckon(lat, lon, velMs·dt, track)`).
- **Routes** ("Flight routes" toggle): demo flights draw all their arcs
  incrementally (16/frame), elevated great-circle arcs with apex
  `clamp(distKm·25, 40 km, 350 km)·sin(π·f)` over 48 samples. Live flights
  resolve routes per callsign on hover/click via **adsbdb**
  (`https://api.adsbdb.com/v0/callsign/{cs}`, 8 s timeout, cached in a Map,
  hover-token guarded against races): draw origin→destination arc (width 2,
  `#ffd28a` @0.9) and set `routeLabel = "OName → DName"` with airport names
  enriched by OurAirports municipality; if no published route, draw a dashed
  45-minute projected track along the current heading (`PolylineDash`,
  `#ff8a5c`), label "projected track (route unknown)". A clicked
  (selected) flight's route persists until deselection; hover routes clear on
  leave.
- Point style: 3.2 px (live) / 4 px (demo) `#ffb347`.

### 6.3 Shipping (`layers/shipping.js`) + AIS (`ais.js`)

Three visual parts: **reference lanes** (always drawn), **pulses** riding the
major lanes, and **vessels** (live AIS or simulated).

Lanes: `densifyLane(def)` samples each waypoint chain along geodesics every
~120 km at 1500 m height, precomputing per-point bearings and total length;
`endpoints` is parsed from a "(A – B)" suffix of the name. Rendered as
`PolylineGlow` polylines — width 4.5 (major) / 2.6 (middle), color
`#3fd9ff` @0.4 (or polar `#9fd4ff` @0.42), with per-style shared materials so
the whole network batches into a handful of draw calls. When live AIS is
active the lanes are rebuilt dimmed (alpha 0.16/0.18) as background reference.
Pulses: `clamp(round(lengthKm/2500),2,8)` per major lane, advancing at
120 km/s of visual flow, positions lerped along the densified polyline.

Live AIS (`createLiveAis(callbacks)`), tried in order:
1. **aisstream.io** WebSocket `wss://stream.aisstream.io/v0/stream` — used
   only if the user supplied an API key (`?aiskey=` param or localStorage
   `wikiglobe.aiskey`, set via the sidebar "key" link) or configured a proxy
   WS URL (`?aisstreamWs=`, `window.WIKI_GLOBE_AISSTREAM_WS`, localStorage).
   On open, send `{APIKey, BoundingBoxes:[[[-90,-180],[90,180]]],
   FilterMessageTypes:["PositionReport","ShipStaticData"]}`. Position
   reports → `onPosition({mmsi, lat, lon, sogKn, cogDeg, headingDeg
   (TrueHeading unless 511, else Cog), ts:now, name?})`; static data →
   `onStatic({mmsi, name, typeCode, destination})`. A 15 s watchdog fails the
   attempt if no usable message arrived (bad keys connect silently);
   reconnect 10 s after drops.
2. **Digitraffic Finland** REST (no key; Baltic coverage):
   `https://meri.digitraffic.fi/api/ais/v1/locations` (GeoJSON; poll 60 s;
   skip features older than 15 min; `sog < 102.3` = available) and
   `/vessels` metadata (poll 10 min).
Returns `{kind, detail, stop()}` or null → simulated mode.

Vessels: live vessels live in a `Map` by MMSI (cap 4000), created on first
position with flag from MMSI MID and metadata merged when static data
arrives; each has a 3.5 px `#7cfc9a` point. tick dead-reckons a
1/30-per-frame slice of vessels along their COG at SOG (dt capped at the
20-min staleness limit), and evicts vessels silent for >20 min (sweep every
60 s). Simulated mode: 1–4 vessels per lane (by length) ping-ponging along
the lane at ~16 kn ×600 speed-up (5 km/s), destination = the lane endpoint
they're heading to; retry live AIS every 5 min and swap over on success.

Destination routes ("Destination routes" toggle): every 90 s, collect up to
400 moving vessels whose free-text destination resolves against the port
gazetteer; build ≤10 routes per frame as dashed `#ffac4d` geodesics from the
vessel to the port (samples ∝ distance, 8–64). Simulated vessels use their
remaining lane polyline instead.

### 6.4 Earthquakes (`layers/earthquakes.js`)

USGS GeoJSON summary feeds (`all_hour` / `all_day` / `all_week`), selected by
`setFeed`; fetch on show and every 5 min while visible; 12 s timeout; no
bundled fallback (ephemeral data) — on failure the badge goes `idle` and the
detail carries the error. Points: size `max(4, min(28, 4 + 2^(mag−3)))`,
color lerped red→blue by depth/700 km, red outline halo for M≥6; id kind
`quake` with `{mag, depth, place, time, url, tsunami}`.

### 6.5 Natural events (`layers/events.js`)

NASA EONET v3 `https://eonet.gsfc.nasa.gov/api/v3/events?status=open`, fetch
on show + every 15 min. 13 category defs (id → label/color/glow):
wildfires, volcanoes, severeStorms, seaLakeIce, snow, temperatureExt,
drought, dustHaze, manmade, waterColor, landslides, earthquakes, floods.
Each event uses its **last** geometry entry (point or first coord of a
polygon). 7 px points colored by category with glow outline. Category
checkboxes toggle `point.show` per event; `counts()` counts only enabled
categories.

### 6.6 Launches (`layers/launches.js`)

Launch Library 2: `https://ll.thespacedevs.com/2.2.0/launch/upcoming/?limit=30&mode=list`.
Unauthenticated quota is ~15 req/hr, so: fetch on toggle-on, refresh every
30 min, cache the raw payload in sessionStorage (`ll2-launches-v1`, 2 h max
age) and serve it (source `cache`) on failure/429. Launches are **grouped by
pad** (lat/lon key) and sorted by NET; one 8 px purple point per pad; tooltip
lists up to 3 with `formatCountdown(net)` ("T-2d 4h" / "T-3h 12m" /
"T-8m 30s" / "T+0").

### 6.7 Submarine cables (`layers/cables.js`)

Reads committed `data/submarine-cables.latest.geojson` (TeleGeography-derived;
features have `name` and a `#rrggbb` `color`). Renders 1.5 px color polylines
at alpha 0.5; LineString and MultiLineString both supported; source `data`.

### 6.8 Power plants (`layers/power-plants.js`)

Reads `data/power-plants.latest.json`: `{meta:{fuels:[…]}, plants:[[lon, lat,
fuelIdx, mw, name, country],…]}` (WRI Global Power Plant Database v1.3.0,
~35k plants). Fuel→color table (Solar amber, Hydro blue, Wind teal, Gas
orange, Coal stone, Oil purple, Nuclear pink, …). Point size
`max(3, min(14, 4 + √mw/4))`, alpha 200/255.

### 6.9 Time zones (`layers/timezones.js`)

Reads `data/time-zones.latest.geojson` (Natural Earth; properties `zone`
(UTC offset, may be fractional) and `utc_format`). Renders translucent
polygon **entities** (alpha 0.25) colored by a cyclic 24-hue palette
(`hue = ((zone+12)·15) mod 360`, HSL 45%/50%), outer rings only. Tooltip
computes the current local time from the offset.

---

## 7. Heatmap / data-overlay layer (`layers/heatmap.js`)

One dropdown-selected metric at a time. The overlay is always rendered to an
**equirectangular canvas**, encoded as a PNG data URL, and draped over the
globe as a `SingleTileImageryProvider` imagery layer (rebuilds are
generation-counted; the newest wins, the old layer is removed after the new
one is added). `valueAt(lat, lon)` serves the hover tooltip.

### 7.1 Metric registry

`METRICS` maps mode key → `{label, kind, fmt, stops, legend, …}` where
- `stops` = piecewise-linear color ramp `[[value, [r,g,b]], …]`
  (`colorFor(stops, v)` interpolates; clamps at both ends);
- `legend` = evenly spaced `[label, cssColor]` ticks for the panel bar;
- `kind` ∈ `weather | aurora | country | region | conflict | skyscraper`;
- weather metrics carry `value(sample)` getters and optionally
  `dataSource` ∈ `airquality | flood | climate` (default weather);
- country/region metrics carry `statKey` (and `regionKey`/`regionYearKey`).

A bundled copy of `METRICS` ships in code as a fallback;
`loadHeatmapMetrics()` (awaited at boot) replaces the whole registry from
`data/heatmap-metrics.json` (`{metrics:{key:{label, kind, formatter,
valueKey?, statKey?, regionKey?, regionYearKey?, stops, legend}}}`),
hydrating `formatter` through a named-formatter table (money, degC, percent,
percent1, fixed2, fixed3, density, integer, years, per1000, tonnes, kgOil,
micrograms, millimetres, towerDensity) and `valueKey` through
`{tw, t, rh}` getters. Unknown names throw (fallback registry is then kept).

Bundled metric set (≈35): weather wetbulb/temp/humidity; air quality
pm25/aqi; riverDischarge; temp2050; aurora; country stats gdpNominal, gdpPpp,
hdi, ihdi, gni; IMF imfGdpGrowth/imfInflation/imfUnemployment/imfDebtGdp;
OWID owidLifeExpectancy/owidInternet/owidRenewableShare/owidHumanRights;
whoLifeExpectancy; plus (from the generated config) lifeExpectancy,
infantMortality, cleanWater, electricityAccess, internetUsers, gini, poverty,
annualPrecipitation, co2PerCapita, renewableElectricity, energyUse,
fertility, popGrowth, urbanShare; region popDensity/fertility; conflict
`conflicts`; skyscraper `skyscraperDensity`.

### 7.2 Weather grid modes (kind `weather`)

- Sample grid: lat −60…+80 at `step` degrees (RES_STEPS 20/15/10/7.5,
  default 10), lon full 360. Each sample holds current-hour values and full
  hourly/daily history arrays per data source.
- **Open-Meteo endpoints** (all support batched lat/lon lists, 60 locations
  per request):
  - weather: `https://api.open-meteo.com/v1/forecast?latitude=…&longitude=…
    &hourly=temperature_2m,relative_humidity_2m&past_days=3&forecast_days=1&timezone=UTC`
  - air quality: `https://air-quality-api.open-meteo.com/v1/air-quality`
    `…&hourly=pm2_5,us_aqi&past_days=3&forecast_days=1&timezone=UTC`
  - flood: `https://flood-api.open-meteo.com/v1/flood`
    `…&daily=river_discharge&past_days=3&forecast_days=7&timezone=UTC`
  - climate: `https://climate-api.open-meteo.com/v1/climate`
    `…&daily=temperature_2m_max&start_date=2050-01-01&end_date=2050-12-31&models=MRI_AGCM3_2_S`
- Chunks are fetched **sequentially** (parallel fetches trip the per-minute
  rate limit) with one retry after 1.5 s. A 429 whose reason does *not*
  mention "minutely" is a quota error: abort remaining chunks, set a 15-min
  cooldown, source `limited`. Successful complete loads are cached in
  localStorage (per-source keys `wetbulb-cache-v1`, `aq-cache-v1`,
  `flood-cache-v1`, `climate-cache-v1`; values rounded to 0.1; 24 h max age,
  step must match); cache restore → source `cache`. Refresh every 20 min
  while a weather mode is active; failed/partial loads retry after 90 s.
- **Wet-bulb temperature** is derived per sample via Stull (2011):
  `tw = t·atan(0.151977·√(rh+8.313659)) + atan(t+rh) − atan(rh−1.676331)
  + 0.00391838·rh^1.5·atan(0.023101·rh) − 4.686035` (±0.3 °C).
  `heatStressLabel(tw)`: ≥35 "Beyond the theoretical human survivability
  limit", ≥31 "Extremely dangerous…", ≥28 "Dangerous…", ≥25 "High heat
  stress…", ≥21 "Moderate heat stress", else "Safe range".
- Timeline: `times[]` = parsed hourly (or daily for flood/climate)
  timestamps filtered to ≤ now (climate keeps future 2050 dates);
  `setTimeIndex(i)` re-applies the indexed value to every sample and pins
  `selTime` (null = follow latest). `timeLabel()` only says "now" when the
  newest hour is <90 min old (cached data can end hours ago).
- `valueAt`: bilinear interpolation over the 4 surrounding grid samples with
  longitude wrap; returns null when the summed weight of non-null corners
  < 0.25. Returns `{kind:"weather", metric, tw, t, rh, pm25, aqi, discharge,
  tempMax, when}`.
- Canvas: 720×360 (0.5°/px). Per-pixel `valueAt` → ramp color, alpha 160
  faded to 0 across 7.5° at the grid's lat edges.

### 7.3 Aurora (kind `aurora`)

NOAA SWPC `https://services.swpc.noaa.gov/json/ovation_aurora_latest.json` —
`coordinates: [[lon 0–359, lat, probability], …]`. Build a Map keyed by
`"round(lat),round(lon±360)"`, assign each grid sample its nearest point's
probability, then render through the weather canvas path (green→white ramp).

### 7.4 Country & region choropleths

- Country data: `loadCountryGeo()` + `data/country-stats.latest.json`
  (`{countries: {ISO3: {name, indicator: {value, year, source}}}, meta}`),
  legacy bundled snapshot as fallback (meta flag `fallback: true` keeps a
  one-shot retry alive).
- Region modes (popDensity, fertility): additionally load
  `data/admin1-population.latest.geojson` — admin-1 polygons with
  `{name, iso3, population, popYear, areaKm2, density, fertility,
  fertilityYear}` — normalized to the same `{rings, bbox}` shape so
  `countryAt` works on them.
- Canvas: 1440×720 (0.25°/px, crisper borders). `fillFeature` paints each
  feature's rings as one even-odd path in equirectangular pixel space; value
  null → `rgba(125,135,150,0.16)` "no data" fill. Region modes paint the
  country base coat first, then admin-1 polygons that carry their own value.
- `valueAt` for regions prefers the admin-1 polygon under the cursor (with
  population/area/year context), falling back to the country statistic.

### 7.5 Conflict cells (kind `conflict`)

`data/conflict-events.latest.json`:
`{meta:{sourceLabel, period:{start,end}}, events:[[lat, lon, best(deaths),
_, countryIdx, dyadIdx],…], countries:[…], dyads:[…]}` (UCDP candidate GED,
trailing ~12 months). Aggregate into 0.5° cells: total deaths, event count,
worst single incident (its country/dyad shown in the tooltip), and the top 3
dyads by deaths (tie-broken by event count via a +0.001 per-event epsilon).
Render as squares (2 px at canvas scale) with a faint 2 px halo pass (alpha
0.22) under the solid pass, ramp on `max(deaths,1)` (yellow→orange→red→
magenta at 1/10/100/1000). `conflictAt(lat,lon)` (used by click-through):
the cell under the cursor or, because of the halo, the heaviest of the 8
neighbors — returns `{deaths, events, country, topDyads, period, source}`.

### 7.6 Skyscraper density (kind `skyscraper`)

`data/skyscraper-density.latest.json`: `{cellDeg, minHeightM, cities:[…],
countries:[…], cells:[[x, y, count, density, cityIdx, countryIdx, rank,
sourceFlag],…]}` (density = skyscrapers ≥150 m per 10,000 km²; sourceFlag 1
= supplemental Wikidata Q11303 city). Rendered like conflict cells; tooltip
shows city/country, count, density, rank.

### 7.7 Mode switching

`setMode(mode)`: weather modes start/continue the 20-min refresh timer and
load their data source if stale; conflict/skyscraper/aurora load their file
once then rebuild; country/region modes ensure geo + stats (+ admin-1) are
loaded. Non-weather modes cancel the weather timers. Rebuilds are debounced
90 ms (`_scheduleRebuild`) so slider scrubbing collapses into one repaint.
`setResolution(step)` rebuilds the grid, wipes loaded-source bookkeeping, and
refetches, preserving the pinned timeline instant (`selTime`).

---

## 8. True-size compare, search, wiki panel

### 8.1 True-size compare (`layers/truesize.js`)

thetruesize.com-style draggable country outlines. Key insight: on a 3D globe
there is no projection distortion, so **any rigid rotation of the outline on
the sphere preserves shape and area exactly**.

- Each copy stores its rings as **unit vectors** (`baseVecs`), a normalized
  vector-sum center (`baseCenter` — robust across the antimeridian), the
  current center (`curCenter`), and a `spin` angle. The applied transform is
  `spinQ(curCenter, spin) ∘ rotationBetween(baseCenter, curCenter)`
  (shortest-arc quaternion; antipodal fallback picks any perpendicular
  axis), producing positions at 2000 m height (z-fighting avoidance).
- Rendered as one entity per ring with both `polygon` (fill alpha 0.3,
  `CallbackProperty` hierarchy) and `polyline` (width 2, alpha 0.95),
  `arcType: GEODESIC`; entity gets `kind="truesize"` / `ts=item` for picking.
  Colors cycle through 6 hues.
- `tryAdd(lat, lon)`: resolves the clicked country via `countryAt`; if geo is
  still loading, consume the click and add when loaded.
- `add(feature)` also works for continent/region pseudo-features (search's
  "+ compare" button).
- **Dragging** (own ScreenSpaceEventHandler; every handler registered both
  with and without the SHIFT modifier so pressing Shift mid-drag doesn't
  stall): LEFT_DOWN over a copy (drill-pick 5 deep — flights/pins often sit
  on top) grabs it, storing `grabQ = rotationBetween(groundPoint,
  curCenter)` so the outline doesn't jump to the cursor; all camera controls
  (rotate/translate/tilt/zoom) are disabled during the drag and restored on
  release (window-level `pointerup` too, for releases outside the canvas).
  MOUSE_MOVE re-derives the center as `grabQ · groundUnit(cursor)`.
- **Wheel** during a drag spins the grabbed outline (5°/notch of delta 120);
  **Shift+wheel** spins the copy under the cursor without grabbing.
  **Right-click** removes a copy.
- `onChanged` hook fires on add/remove/mode change (updates the panel count
  and help row). Area label uses `feature.areaKm2 ?? countryAreaKm2(f)`.

### 8.2 Country search (`search.js`)

Type-ahead over `loadCountryGeo()` + `buildContinentGeo()`. Focus with empty
input lists the region/continent entries; typing ranks prefix matches before
substring matches, max 8. Rows show name, type chip, area, and a
"+ compare" button (adds a true-size overlay; button flips to "✓ added").
Keyboard: arrows cycle, Enter chooses, Escape closes. Choosing flies the
camera to the feature: `Rectangle.fromCartographicArray` over all ring points
(handles antimeridian countries), height = `clamp(maxSpanRad · 6.371e6 ·
1.35, 3e5, 2.2e7)`, duration 1.8 s, and draws a temporary cyan outline
(polylines at 2000 m) for 5 s. Both fly start and completion call
`onInteract()` so auto-rotate doesn't immediately swing away.

### 8.3 Wikipedia panel (`wiki-panel.js`)

Two modes:

**Earth mode** — `open(lat, lon, {conflict?})`:
- Draws a center pin (11 px `#ff5470` point entity, depth-test disabled), a
  translucent radius **disc** (ellipse entity whose semi-axes are a
  `CallbackProperty` returning `radiusM`) and a glowing **ring** (polyline of
  128 geodesic circle points, `PolylineGlowMaterialProperty` `#ff7aa2`; a
  wide polyline is used because ellipse outlines are limited to 1 px).
- Radius slider is exponential: `km = 0.5 · (800/0.5)^(value/100)` (0.5–800
  km; default value 55 ≈ 25 km). The circle tracks the slider instantly;
  the network search is debounced 450 ms.
- **Search** (sequence-numbered; stale responses dropped), three parallel
  parts merged with title dedupe in order [conflict, context, nearby], capped
  at 25 items:
  1. `geosearch`: MediaWiki `action=query&list=geosearch&gscoord=lat|lon&
     gsradius=min(radius, 10000)&gslimit=20` — **the API caps radius at
     10 km** — followed by one batched `prop=extracts|info&exintro&
     explaintext&exchars=260&inprop=url` request by pageids. Items:
     `{title, lat, lon, distKm, extract, url}`.
  2. `contextArticles` (only when radius > 10 km): Nominatim reverse geocode
     (`zoom=10&format=jsonv2&accept-language=en`) → candidate titles: city
     (always), state (radius > 50), country (radius > 200; widest radii
     reverse the order so the broadest context leads); each resolved via the
     Wikipedia REST summary endpoint (`/api/rest_v1/page/summary/{title}`,
     skipping disambiguation pages) into items badged City/Region/Country
     with coordinates when the summary has them.
  3. `conflictArticles` (when a conflict cell was clicked): for up to 3
     dominant dyads, normalize "Government of X (…) - Y" → "X Y" and run
     MediaWiki full-text `list=search` for `"{query} conflict"` (3 hits
     each); dedupe pageids; fetch extracts for ≤6; items badged "Conflict",
     no coordinates.
- Every located result gets a **"W" pin** billboard (canvas-drawn pink
  teardrop with a white W, drawn at 2× and displayed at scale 0.5 / 0.82
  selected). List rows and markers cross-highlight (`_select`); clicking a
  row locates its pin, clicking a pin highlights the row (scrolling it into
  view) and opens the article in a centered popup window
  (`window.open(url, "wikiGlobeArticle", popup features ~72%×82% of the
  screen)`). Markers on the far side of the globe are hidden each preRender
  frame via `EllipsoidalOccluder.isPointVisible`.
- The results list renders title + badge + "◉ map" chip (when located) +
  distance + extract + "Read on Wikipedia ↗" external link. A conflict cell
  adds a header note with deaths/events/period.

**Body mode** — `openBody(bodyName, lat, lon, items)`: used by off-Earth
layers, which pass a pre-sorted article list (markers already live on the
body); no geosearch, no Earth overlays; panel gets class `moon` (CSS hides
the radius block); coordinates header shows "{Body} · 12.34° N, 56.78° E".
`moonMode` flag distinguishes the modes.

Panel chrome: `close()` clears everything and dispatches
`right-panel:closed`; opening dispatches `right-panel:activate`; Escape
closes; `isOpen()` requires classes `open` + `right-panel-pane-active` and
not `collapsed` (auto-rotate and occlusion checks consult it).

---

## 9. Off-Earth bodies: configuration (`js/bodies.js`)

`BODIES` is the single source of truth for every body. Per-body fields:

| field | meaning |
|---|---|
| `key`, `name`, `label` | id, display name, dropdown label (Earth/Moon/Sun get emoji labels) |
| `radius` | metres (e.g. Moon 1,737,400; Sun 695,700,000; Jupiter 69,911,000) |
| `textureUrl` | `assets/*.jpg` equirectangular texture |
| `nightTextureUrl` / `atmosphereTextureUrl` / `ringTextureUrl` | optional extras (Earth night, Venus clouds, Saturn rings PNG) |
| `rings` | Saturn only: `{innerRadius: 74.5e6, outerRadius: 140.22e6, textureUrl}` |
| `dotColor` / `markerColor` | sky-dot color / surface-marker color |
| `wikidataGlobe` | the Wikidata `geoGlobe` QID scoping that body's coordinates (Moon Q405, Mars Q111, Mercury Q308, Venus Q313, Jupiter Q319, Io Q3123, Europa Q3143, Ganymede Q3169, Callisto Q3134, Saturn Q193, Titan Q2565, Uranus Q324, Neptune Q332, Pluto Q339, Charon Q1063) |
| `parentBody` | for child moons: parent's key (io/europa/ganymede/callisto → jupiter, titan → saturn, charon → pluto) |
| `ephemeris` | one of: `{type:"moon"}` (Cesium Simon-1994 lunar ephemeris); `{type:"astronomy-engine", body:"Mars"}` (geocentric vector); `{type:"jupiter-moon", parent:"jupiter", moon:"io"}` (Astronomy.JupiterMoons offsets); `{type:"parent-orbit", semiMajorAxis, periodDays, phaseDeg}` (analytic circular orbit in the parent's equatorial plane — Titan: a=1.22187e9 m, P=15.945421 d, phase 40°; Charon: a=1.9596e7 m, P=6.38723 d, phase 180°) |
| `orientation` | one of: `{type:"moon"}` (Cesium `IauOrientationAxes` if available, else tidal-lock construction); `{type:"iau", ra, dec, w}` — each term is a number or `[base, rate, "T"\|"d"]` (linear in Julian centuries or days since J2000); `{type:"iau-neptune", n, ra, raSin, dec, decCos, w, wSin}` (adds the sin/cos(N) periodic terms of the IAU Neptune model); `{type:"tidal-parent"}` (child moon locked facing its parent) |

IAU coefficients shipped (from the IAU WGCCRE reports), e.g. Mars
`ra=[317.68143,−0.1061,"T"], dec=[52.88650,−0.0609,"T"],
w=[176.630, 350.89198226,"d"]`; Sun `ra=286.13, dec=63.87,
w=[84.176, 14.1844,"d"]`; Neptune's full periodic model with
`n=[357.85, 52.316,"T"]`.

`BODY_ORDER` fixes display order (sun, mercury, venus, earth, moon, mars,
jupiter+its moons, saturn+titan, uranus, neptune, pluto+charon).
`bodyChoiceGroups()` groups the `#sel-body` options into `<optgroup>`s: each
top-level body forms a group with its children ("Jupiter system", "Pluto
system"; the Moon is treated as Earth's child so the Earth group contains
Earth + Moon; the Sun's group is just "Sun").

Adding a new body with no special behavior is **config-only**: add its entry
to `BODIES`, its key to `BODY_ORDER`, and to `PLANET_BODY_KEYS` (or
`CHILD_MOON_BODY_KEYS` with a `parentBody`), plus a texture + attribution.

## 10. Off-Earth bodies: `BodyLayer` (`js/layers/body.js`)

The shared class implementing all off-Earth behavior. Subclasses are thin
configs (§10.8). A layer's `config` extends the body metadata with UX fields:
`markerAlt`, `markerColor`, `markerScale` (NearFarScalar), `maxArticles`,
`liveMinItems`, `allowEmptyLive`, `fallbackSites`, `missionSupplementUrl`,
`overwriteSupplementCoords`, `defaultCategory`, `categoryDefs`
(`[{value,label}]`), `articleKind`/`articlePickId`, `articleProps`,
`bodyPickId(layer)`, `skyDot {color, pixelSize}`, `transition {proxy:true,
proxyDistance, proxyRadius, duration}`, `showBodyWhenUnfocused`,
`focusDuration`/`blurDuration`, `minZoomMargin`, `focusOffset(radius)`,
`cpuProjectMarkers`, `flat` (unlit material — the Sun), `hideCesiumMoon`,
`wikiEnabled`, `normalizeLon`, `categoryFor(article)`, `homeView`,
`parentBody`.

### 10.1 Geometry & appearance

- The body is a `Cesium.Primitive` wrapping an `EllipsoidGeometry`
  (64 stacks × 128 slices, TEXTURED vertex format), `MaterialAppearance` with
  an Image material of the texture (`flat: true` for self-luminous bodies),
  `asynchronous: false`, `allowPicking: true`, `id = config.bodyPickId(this)`.
- **Texture-seam constant:** `EllipsoidGeometry` starts its texture seam on
  the body-fixed +X axis. Multiply the *rendered primitive's* modelMatrix by
  a constant `Rz(π)` (`TEXTURE_SEAM_ROT`) so map longitude 0 sits on +X —
  but keep markers and surface picking in the true body-fixed frame
  (do NOT apply the seam rotation to them).
- Proxy primitive (when `transition.proxy`): a second identical ellipsoid
  (radius `proxyRadius`) with its own appearance, non-pickable, hidden until
  a transition runs.
- Sky dot (when `skyDot`): a point (7 px default, colored, white outline,
  `disableDepthTestDistance: ∞`) + an 11 px label with the body name offset
  (8, 0), both positioned at the body's true world position each tick, both
  carrying `bodyPickId`. Context bodies instead get an HTML
  `<div class="context-body-label">` appended to the viewer container,
  positioned each tick via `wgs84ToWindowCoordinates` (+10, −8 px), hidden
  offscreen (±90/±40 px margins).
- `config.hideCesiumMoon`: the Moon layer disables Cesium's built-in
  `scene.moon`.

### 10.2 Live transform composition (every tick)

```
icrfToFixed = Transforms.computeIcrfToFixedMatrix(time)
              ?? computeTemeToPseudoFixedMatrix(time)   // early-frame fallback
posIcrf     = ephemeris position (metres, Earth-centered ICRF)
rotIcrf     = orientation rotation (body-fixed → ICRF)
modelMatrix = fromRotationTranslation(icrfToFixed·rotIcrf, icrfToFixed·posIcrf)
```

Ephemeris types:
- `moon`: `Simon1994PlanetaryPositions.computeMoonPositionInEarthInertialFrame`.
- `astronomy-engine`: `Astronomy.GeoVector(Body[name], date, true)` × 1 AU
  (1.495978707e11 m).
- `jupiter-moon`: `GeoVector(Jupiter) + Astronomy.JupiterMoons(date)[moon]`
  offsets, × AU.
- `parent-orbit`: parent's GeoVector plus a circular offset in the parent's
  equatorial plane: take columns 0 and 1 of the parent's orientation matrix
  as the plane basis, angle = `phase + 360·d/periodDays` degrees (d = days
  since J2000), radius = `semiMajorAxis`. (The child-moon config injects
  `parentEphemerisBody` and `parentOrientation` from the parent's entry.)

Orientation types:
- `iau`: with `d`, `T` = days/centuries since J2000 12:00 UTC and
  `linearTerm([base, rate, "d"|"T"])`, compute ra/dec/w in degrees, then
  `R = Rz(ra+90°) · Rx(90°−dec) · Rz(w)`.
- `iau-neptune`: same but ra/dec/w get `raSin·sin(N)`, `decCos·cos(N)`,
  `wSin·sin(N)` corrections with `N = linearTerm(n)`.
- `moon`: `Cesium.IauOrientationAxes().evaluate(time)` **transposed**
  (Cesium returns the inverse of what's needed — the most common bug class
  here is a missing/extra transpose; verify with the sub-Earth point, §17);
  fallback when the class is absent: construct a tidal-lock frame with
  +X pointing at Earth (−posIcrf normalized), Y = eclipticNorth × X,
  Z = X × Y (eclipticNorth ≈ (0, −0.3977772, 0.9174821) in ICRF).
- `tidal-parent`: X = normalize(parentPos − childPos) (facing the parent),
  Y = parentSpinAxis × X (degenerate fallbacks: UNIT_Z × X, then UNIT_X × X),
  Z = X × Y; columns assembled into the matrix.

All math uses preallocated scratch objects (Matrix3/4, Cartesian3) — this
runs every frame for every body.

### 10.3 Sky dots, distance, picking

`position()` = modelMatrix translation. `distanceKm()` = |position|/1000
(shown in tooltips as live distance from Earth). `pickSurface(windowPos)`:
ray-sphere intersection against `BoundingSphere(position, radius)`, transform
the hit into the body frame via the **inverse modelMatrix**, then
`lat = asin(z/r)`, `lon = atan2(y, x)` in degrees.

### 10.4 Focus / blur & the proxy transition

**Never tween a real camera flight across true interplanetary distances** —
Cesium's flight-arc math breaks. Two paths:

- `_focusDirect()` (Moon, or `direct` local hops): mark focused, restore the
  primitive, clear look-at, raise `maximumZoomDistance` to ≥ radius×40, then
  `camera.flyToBoundingSphere(BoundingSphere(position, radius·2),
  {duration: focusDuration≈3})`; on completion set `minimumZoomDistance =
  radius + minZoomMargin`, convert the camera position into the body frame,
  and enter **tracking**: `camera.lookAtTransform(modelMatrix, offset)`.
- `_focusViaProxy()` (everything beyond the Moon): hide the true body and
  markers; place the **proxy** — same orientation as the true body, but
  translated to `normalize(truePos) · proxyDistance` (Mars ≈ 4.5e8 m; Sun
  radius×8; generic `max(4.5e8, radius·8)`) so it sits in the same sky
  direction at a flyable distance; show it and
  `flyToBoundingSphere(proxyCenter, proxyRadius·1.15, duration≈2.4)`;
  on complete (or cancel while still focused) `_enterTrueFocus()`: hide the
  proxy, show the true body, refresh transform + CPU markers, and snap
  `camera.lookAtTransform(modelMatrix, focusOffset(radius))` (default offset
  `(0, −4.4r, 0.55r)`), enabling tracking. The swap is invisible because
  proxy and body subtend the same angle in the same direction.
- **Tracking re-anchor:** every tick, while tracking, capture
  `camera.position` (which is in the look-at frame), update the transform,
  then re-issue `camera.lookAtTransform(modelMatrix, savedOffset)` — the
  camera rides the moving/rotating body.
- `blur({flyHome})`: cancel flights, clear focus/tracking/proxy, restore the
  saved min/max zoom distances, `lookAtTransform(IDENTITY)`, and (unless
  `flyHome:false` — used when hopping directly to another body) fly to the
  shared home view (lon 10, lat 22, 2.3e7 m, duration ≈ blurDuration).
- `onFocusChanged(focused)` callback notifies the app (§4.3). Focus also
  calls `setArticlesVisible(true)`.

Visibility predicates (used consistently by setVisible/setContextVisible/
setSkyVisible/blur):
- body primitive shows when visible AND (`showBodyWhenUnfocused !== false` OR
  truly focused OR contextVisible OR no transition configured);
- sky dot/label show when visible AND skyVisible AND NOT contextVisible AND
  NOT focused;
- context label shows when visible AND contextVisible AND has a parentBody
  AND not focused.

### 10.5 Wikipedia surface markers

Lazy: the first `setArticlesVisible(true) && wikiEnabled` triggers
`_loadArticles()` exactly once (source `loading` → `live`/`data`).

1. **Live query** — Wikidata SPARQL (`https://query.wikidata.org/sparql?format=json&query=…`,
   25 s abort, Accept `application/sparql-results+json`):

```sparql
SELECT ?lat ?lon ?links ?article ?countryName ?flag WHERE {
  ?item p:P625 ?st .  ?st psv:P625 ?v .
  ?v wikibase:geoGlobe wd:<GLOBE_QID> ;
     wikibase:geoLatitude ?lat ; wikibase:geoLongitude ?lon .
  ?item wikibase:sitelinks ?links .
  ?article schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> .
  OPTIONAL { ?item wdt:P495 ?country .
    OPTIONAL { ?country wdt:P41 ?flag . }
    OPTIONAL { ?country rdfs:label ?countryName FILTER(LANG(?countryName)="en") } }
} ORDER BY DESC(?links) LIMIT <maxArticles+20>
```

   Rows → articles `{title (decoded from the /wiki/ slug), lat, lon
   (normalized to −180…180 — planetary coords are often 0–360 east), url,
   country, badge, flagUrl:null, _flagFile (decoded from the
   `Special:FilePath/` URL)}`. Live is accepted when `count > liveMinItems`
   (Moon 10, others 0) or `allowEmptyLive` (planets — an empty live result is
   truthful for e.g. Uranus).
2. **Fallback** — `config.fallbackSites` `[[title, lat, lon, country?,
   flagFile?], …]` (Moon: 16 curated sites; Mars: 8; planets/moons: empty),
   source `data`.
3. **Mission supplements** — fetch `config.missionSupplementUrl`
   (`data/{body}-missions.json`, `schemaVersion 1`,
   `missions:[{title, lat?, lon?, siteTitle?, country?, flagFile?, kind?,
   url?}]`). Merge by normalized title (NFKC, collapse whitespace/underscores,
   lowercase): existing articles get coords patched (or **overwritten** when
   `overwriteSupplementCoords` — Mars & planets — because Wikidata mission
   coords are often wrong), country/flag/kind attached, `missionSupplement:
   true`; unknown titles are appended (coords may be inherited from their
   `siteTitle` article). Then dedupe by title.
4. **Categorization** — `config.categoryFor(article)` assigns a category
   (regex heuristics over the lowercase title: mission keywords / "crater" /
   nomenclature prefixes like mare|mons|vallis|planitia|regio… / country
   presence ⇒ missions; `missionSupplement` always ⇒ missions). The UI select
   filters via `filteredArticles()`; `setCategory` rebuilds markers.
5. **Flag resolution — CORS-safe:** Wikidata `Special:FilePath` image URLs
   fail CORS for WebGL billboards. Resolve up to 50 distinct flag filenames
   through the Commons API
   (`https://commons.wikimedia.org/w/api.php?action=query&titles=File:…|…&
   prop=imageinfo&iiprop=url&iiurlwidth=48&format=json&origin=*`), honoring
   the `normalized` title map, yielding direct `upload.wikimedia.org`
   thumbnail URLs.

Markers (`_buildMarkers`): for each filtered article compute its body-fixed
position at `radius + markerAlt` from lat/lon; add a 5 px point
(markerColor, white outline, `scaleByDistance` from `markerScale` — default
NearFarScalar(radius·1.7 → 1.3, radius·250 → 0.45)) and, if `flagUrl`, a
21×14 billboard offset (±8, 0); both share the article pick id
(`{kind: articleKind, article}` or `articlePickId(layer, article)`).

**CPU marker projection (critical):** when `config.cpuProjectMarkers` (Mars,
planets, child moons — everything at true interplanetary distance), do NOT
set a collection `modelMatrix` (GPU precision loss makes markers flash/
scatter). Instead every tick multiply each article's body-fixed position by
the modelMatrix on the CPU (`Matrix4.multiplyByPoint`) and assign world
positions directly; set `disableDepthTestDistance: ∞` and cull the far side
manually: a marker is near-side when `dot(bodyPos, cameraLocal) ≥ radius²`
(camera transformed into the body frame). The Moon (close enough) uses the
collection modelMatrix path instead. Flags flip to the outside of the disc:
compare marker vs body-center window x-coordinates and swap
horizontalOrigin/pixelOffset (left/right) when crossing.

Marker visibility: shown only when `visible && articlesVisible &&
wikiEnabled` and NOT while in proxy focus (between proxy start and true
focus).

### 10.6 Nearest articles & the wiki panel

`nearest(lat, lon, n)`: haversine great-circle distance on the body's own
radius over filtered articles, sorted, top n, each annotated with `distKm`.
`openArticlesAt(lat, lon, panel)`: top 20 → `_ensureExtracts` →
`panel.openBody(name, lat, lon, items)`. `openArticle(article, panel,
{openPopup})`: optionally open the article popup immediately, then show the
list led by that article. `_ensureExtracts(items)`: one batched MediaWiki
`prop=extracts|info&exintro&explaintext&exchars=240&redirects=1` query for
≤20 titles missing extracts, following redirect + normalization chains to
match pages back to items (failures set extract "" so they're not retried).

`counts()` → `{source, count: filteredArticles().length}`.

### 10.7 Saturn's rings (`layers/planets.js`)

`ringGeometry(inner, outer, 256 segments)`: a custom annulus — two vertices
per spoke (inner/outer), positions Float64, normals +Z, texture coords
u = 0/1 across the ring width (the ring texture is a radial 1-D gradient),
v = 0.5; two triangles per segment; explicit bounding sphere. Appearance:
Image material with `transparent: true`, `translucent`, `closed:false`,
`faceForward`. One ring primitive follows the body modelMatrix; a second
follows the proxy during transitions. Rings show only when truly focused or
context-visible (`proxyRadius` is enlarged to the ring outer radius so the
proxy flight frames them).

### 10.8 Subclass configs

- **MoonLayer**: Simon-1994 ephemeris, IAU axes orientation, NASA LRO
  texture, `hideCesiumMoon`, always rendered in the sky
  (`showBodyWhenUnfocused: true`, no transition → direct focus), pick kind
  `moon`, article kind `moonwiki`, categories missions/craters/maria/
  mountains/basins/other, 16 fallback sites, `data/lunar-missions.json`,
  maxArticles 400, liveMinItems 10, markerScale NearFarScalar(3e6→1.3,
  4.4e8→0.45).
- **MarsLayer**: astronomy-engine + IAU rotation, sky dot `#c1583c`, proxy
  transition (distance 4.5e8), hidden when unfocused, `cpuProjectMarkers`,
  article kind `marswiki`, `overwriteSupplementCoords`, 8 fallback sites,
  `data/mars-missions.json`, maxArticles 420. **Mars is the reference
  implementation** for the proxy + CPU-marker pattern.
- **SunLayer**: `wikiEnabled: false` (no marker layer), `flat: true` unlit
  material, proxyDistance = radius×8, minZoomMargin = radius×0.02.
- **PlanetLayer(key)**: generic config from `BODIES[key]` — markerAlt
  `max(15000, r·0.004)`, maxArticles 420, `allowEmptyLive`, mission
  supplements for mercury/venus/jupiter/saturn, proxy
  `max(4.5e8, r·8)` with `proxyRadius = rings?.outerRadius ?? r`,
  minZoomMargin `max(50000, r·0.015)`, `cpuProjectMarkers`, article kind
  `bodywiki` with `articlePickId` carrying `{body, layer, article}`.
- **ChildMoonLayer(key)**: same as PlanetLayer plus `parentBody`; injects the
  parent's ephemeris body + orientation into `parent-orbit`/`tidal-parent`
  configs; markerAlt `max(12000, r·0.006)`, maxArticles 300, default
  category `all`, proxy `max(4.5e8, r·10)`, duration 2.2, focusOffset
  `(0, −4.6r, 0.65r)`.

---

## 11. LLM agent subsystem (`js/agent/`)

An OpenAI-compatible tool-calling agent embedded in the right panel. Four
modules: providers, tools, harness, chat panel.

### 11.1 Providers (`providers.js`)

Registry of three providers (all speak the OpenAI `/chat/completions`
protocol):

| id | baseUrl | key? | models |
|---|---|---|---|
| openrouter | `https://openrouter.ai/api/v1` | yes | shortlist (gpt-4.1, gpt-4.1-mini, claude-sonnet-4, gemini-2.5-pro/flash, deepseek-chat/r1) filtered against the live `/api/v1/models` list |
| deepseek | `https://api.deepseek.com` | yes | deepseek-chat, deepseek-reasoner |
| ollama | `http://localhost:11434/v1` | no (configurable base URL) | live from `{root}/api/tags`, seeds llama3.1/qwen2.5/mistral-nemo |

Settings persist in localStorage under `wikiglobe.agent.*` (provider, and
per-provider key, baseUrl, model, modelOverride); URL params can inject them
(`?agentProvider=`, `?{id}Key=`, `?key=`, `?{id}BaseUrl=`). OpenRouter
requests add `HTTP-Referer` and `X-Title: Wiki Globe` headers.

`completeChat({providerId, model, key, baseUrl, messages, tools, signal})`
POSTs `{model, messages, tools, tool_choice:"auto"}` and normalizes the
response to `{message: {role:"assistant", content, tool_calls?}, usage:
{input, output, total}, finishReason}`. **Compatibility note:** omit
`tool_calls` entirely from plain-text assistant messages (never send `[]`) —
DeepSeek rejects an empty array when history is replayed.

### 11.2 Tool registry (`tools.js`)

Every tool returns a typed envelope:
- `ok(data)` → `{status:"ok", data}`
- `noData(reason)` → `{status:"no_data", reason, data:null}` — the data is
  genuinely outside coverage (authoritative);
- `toolError(reason)` → `{status:"error", reason, data:null}` — transient
  failure (network/timeout/429/5xx); retryable, and must never be
  presented as "data doesn't exist".

`AgentToolRegistry(viewer)` owns a Set of created entities + imagery layers
(so overlays can be cleared per-session), a session id, and a
**ThrottleQueue** serializing network calls (rate-limit friendly; 15 s fetch
timeout). Tools (OpenAI function schemas exposed via `schemas()`):

*Knowledge / data tools:*
- `wiki_search {query, limit≤10}` — MediaWiki `list=search`; returns titles,
  pageIds, stripped snippets, urls.
- `wiki_extract {title}` — Wikipedia REST summary (lead paragraph only);
  no_data for 404/disambiguation/empty.
- `wiki_article {title, section?}` — MediaWiki `action=parse` of the full
  rendered HTML, parsed with DOMParser into text + tables; bounded (≤10
  tables, ≤500 rows total, ≤160 chars/cell, ≤6000 chars text) so a 230-row
  visa table can't blow context. Use when the answer lives in a table the
  summary drops.
- `wikidata_sparql {query}` — read-only SELECT against the Wikidata endpoint
  (limit clamped ≤300). Preferred for scalar per-entity properties at scale.
- `country_stats {indicator?, incomeGroup?}` — bundled/generated World
  Bank/UNDP/OWID data via `country-stats.js`; no network needed; includes the
  income-group proxy disclaimer.
- `country_area {iso3}` — computed polygon area from the local dataset.
- `geocode {query, limit≤5}` — Nominatim forward search (throttled).
- `eclipse_path {start?}` — compute-heavy: astronomy-engine search for the
  next total/annular solar eclipse (≤24 events scanned), sampling the central
  line every 2 min across ±4.5 h; **requires user approval** via the
  `confirmCompute` callback before running; draws the path as a route.

*Overlay tools* (mutate the globe; `OVERLAY_TOOL_NAMES` set — a session's
globe state is reconstructable by replaying these calls in order):
- `add_pin {lat, lon, label?}` — 12 px yellow point + optional label at
  2800 m.
- `highlight_country {iso3}` — cyan outline polylines of the country rings.
- `draw_route {points[≤24], label?}` — geodesic polyline through ordered
  lat/lon points.
- `label_countries {labels: {ISO3: text}, ≤250}` — text labels at country
  centroids at 5200 m with distance culling.
- `color_countries {values: {ISO3: number}, stops?}` — an agent-owned
  choropleth rendered exactly like the heatmap's country canvas (1440×720,
  `fillFeature`, piecewise-linear stops; auto blue→yellow→red ramp from the
  value range when stops are omitted) added as an imagery layer.
- `clear_agent_overlays {}` — removes only this session's entities/layers.

All entities are tracked and tagged (`properties.kind = "agent"`).

### 11.3 Harness (`harness.js`)

`AgentHarness(toolRegistry, opts)` holds the message history
(`[{role:"system", content: GROUNDED_SYSTEM_PROMPT}, …]`) and runs the
agentic loop:

```
push user message
loop:
  response = completeChat(messages + tool schemas)
  if no tool_calls:
     empty content or finishReason=="tool_calls" → error message
     detect leading "[UNVERIFIED]" tag → strip, status "unverified"
     else status = error>no_data>ok based on what tools returned
     return {content, usage, status}
  if usedCalls + calls > budget (50):
     checkpoint via callbacks.onCheckpoint({usedCalls, budget, pending})
       "continue" → budget += 50
       else → push a no_data tool result FOR EVERY pending call id
              (dangling tool_calls corrupt the next turn) and return
              status "stopped"
  for each call: parse args (malformed → no_data), execute
     (thrown → toolError retryable), track hadNoData/hadError,
     push {role:"tool", tool_call_id, name, content: JSON(result)}
```

Callbacks: `onStatus("thinking")`, `onUsage(cumulative)`,
`onTool({name,args,status,result?})` (before/after each call),
`onMessage(content, {usage, status})`, `onCheckpoint`, `onConfirmCompute`.
Usage accumulates across iterations of one run.

**The grounded system prompt** (verbatim intent — reproduce all rules):
1. Tools first for factual/geographic/quantitative/visual claims; when a
   tool returns data, answer only from it; never present memory as
   tool-sourced.
2. Explains the three result statuses; `error` ≠ "data doesn't exist" —
   report the actual reason, offer retry, never invent causes.
3. Country economics/development stats → `country_stats` first (bundled, no
   network); don't use Wikidata for GDP/income group.
4. **Last-resort memory fallback**: only after applicable tools returned
   no_data (or unresolvable errors), the model MAY answer from its own
   knowledge — and for geographic asks it MUST still render the
   visualization with best-effort remembered values rather than refuse. It
   must then (a) start the reply with the exact tag `[UNVERIFIED]`,
   (b) disclose that the answer/overlay is model knowledge (approximate
   scope), (c) still call the map tools. Never mix unverified facts into a
   grounded answer silently — any unverified part tags the whole reply.
5. **Proactive visualization**: geographic answers must be drawn on the
   globe in the same turn (label_countries/color_countries for sets,
   highlight_country for one country, add_pin for a place, draw_route for a
   path) before the prose summary; skip only single-fact answers.
6. Prefer clearing previous agent overlays before a new independent request.

The UI badges answers by status: ok (grounded), no_data, error, unverified.

### 11.4 Chat panel (`chat-panel.js`)

`AgentChatPanel(viewer)` wires the DOM from §3 to the harness + registry:
- **Settings pane**: provider select (repopulated from `providers()`),
  key/base-url/model/override inputs, explicit Save button (with "saved"
  flash), provider setup notes, an Ollama CORS hint
  (`OLLAMA_ORIGINS=http://localhost:8080`). Model list refreshes async per
  provider (`availableModels`). A setup guide renders in the empty state
  when no provider is usable (key missing).
- **Submit flow**: disable composer, status "Thinking…", run the harness
  with an AbortController (Cancel button aborts); tool calls stream into a
  grouped tool log (name + args + status per line, with a summary line);
  usage footer updates live ("Tokens: input N, output M"); the final message
  renders as **markdown** (a small local renderer: headings, paragraphs,
  lists, tables, inline code/bold/links — no external lib, escaped by
  construction).
- **Checkpoint UI**: `onCheckpoint`/`onConfirmCompute` show the
  `#agent-checkpoint` block with Continue/Terminate buttons returning a
  promise decision.
- **Sessions & history**: sessions persist in localStorage
  (`wikiglobe.agent.chatSessions.v1`; ≤20 sessions, ≤80 messages/session,
  ≤12000 chars/message, ≤200 overlay ops). Each session stores the harness
  messages, a rendered-transcript item list, and an **overlay-op log** (the
  ordered `OVERLAY_TOOL_NAMES` calls). Loading a session restores the
  harness history, re-renders the transcript, and **replays the overlay ops
  through the tool registry** to reconstruct the globe drawings. New-session
  (+) clears overlays and starts fresh; history pane lists sessions with
  delete/clear-all.
- Example prompts in the empty state fill the composer on click.
- The panel participates in the shared right-panel slot via the
  `right-panel:activate`/`closed` events (§4.8).

---

## 12. Offline data pipeline (`scripts/data/`)

Node ESM scripts (no dependencies beyond node:fs/path/fetch) that fetch live
upstream sources and write versioned JSON/GeoJSON into `data/`, which is
**committed** — the app consumes it directly at runtime with no build step.
Every generated file carries `schemaVersion` and a `meta` block:
`{generatedAt (ISO), sourceLabel, sources:[{name, url, license?, note?}],
counts?, warnings?, notes?}`.

npm scripts: `data:update` runs every `update-*.mjs` in sequence;
`data:update:<target>` runs one; `data:validate` runs every
`validate-*.mjs` (shape, ranges, row counts — each update script has a
matching validator).

| script | upstream | output |
|---|---|---|
| update-country-stats | World Bank Indicators API (NY.GDP.PCAP.CD, NY.GDP.PCAP.PP.CD, NY.GNP.PCAP.PP.CD, EN.POP.DNST, SP.DYN.TFRT.IN, SP.POP.GROW, SP.URB.TOTL.IN.ZS, SP.DYN.LE00.IN, SP.DYN.IMRT.IN, SH.H2O.BASW.ZS, EG.ELC.ACCS.ZS, IT.NET.USER.ZS, SI.POV.GINI, SI.POV.DDAY, EN.ATM.CO2E.PC, precipitation, renewables, energy use…) + OWID + UNDP HDR + IMF DataMapper + WHO GHO | `country-stats.latest.json` — `{countries:{ISO3:{name, key:{value, year, source}}}}` |
| update-country-boundaries | world.geo.json mirror | `country-boundaries.latest.geojson` (fallback copy) |
| update-ports | UNECE UN/LOCODE CSV zip (function classifier contains 1 = port) | `ports.latest.json` gazetteer |
| update-maritime-reference | AIS ship-type tables / MID registry | `maritime-mids.latest.json`, `ais-ship-types.latest.json` |
| update-shipping-lanes | Global Shipping Lanes dataset (digitized CIA World Oceans map) | `shipping-lanes.latest.geojson` |
| update-population-density | admin-1 boundaries + population/fertility tables | `admin1-population.latest.geojson` |
| update-conflict-zones | UCDP candidate GED monthly releases | `conflict-events.latest.json` (compact event rows + string tables) |
| update-skyscraper-density | Wikidata Q1575895 city list + Wikipedia "cities with most skyscrapers" + Q11303 supplements | `skyscraper-density.latest.json` (0.5° cells) |
| update-submarine-cables | TeleGeography submarine cable map data | `submarine-cables.latest.geojson` |
| update-power-plants | WRI Global Power Plant Database v1.3.0 CSV | `power-plants.latest.json` (compact rows + fuel table) |
| update-airports | OurAirports CSV (large + medium) | `airports.latest.json` |
| update-time-zones | Natural Earth time zones | `time-zones.latest.geojson` |

Hand-curated (NOT generated): `data/{lunar,mars,mercury,venus,jupiter,
saturn}-missions.json` — mission supplements patching gaps/wrong coords in
live Wikidata results (schema in §10.5), sourced from NASA catalogues and
Wikipedia lists; and `data/heatmap-metrics.json` (metric config, §7.1).

Design rule: generated data files are *fallbacks and bundled datasets*, not
replacements for live fetching where a live API exists.

---

## 13. Visual design & CSS

Single dark-theme stylesheet (`css/style.css`, ~1900 lines). Reproduce the
following system (exact pixel values are flexible except where stated):

- **Palette**: near-black blue background `#05070c`/`#06090f`; panel glass
  `rgba(10–16, 14–22, 26–34, 0.82–0.92)` with 1px `rgba(255,255,255,0.06–0.1)`
  borders, backdrop-filter blur, 10–14 px radii. Text `#dfe7f3`; muted
  `#8b96ad`. Accent colors are the layer colors themselves: satellites
  `#6ef3ff`, flights `#ffb347`, ships/lanes `#3fd9ff`/`#7cfc9a`, wiki pink
  `#ff5470`, agent yellow `#facc15`.
- **Left panel** (`#panel`): fixed top-left, ~272 px wide, vertically
  scrollable; `.row.main` layer rows (checkbox, 8 px colored `.dot` with
  glow box-shadow, name, badge, count); `.row.sub` indented sub-options;
  collapsed state slides it off-canvas leaving the edge tab buttons
  (`.side-collapse-toggle` — vertical text tabs attached to the panel edge).
  `.badge` variants: `.live` green, `.demo` orange, `.static` gray-blue,
  `.loading` pulsing.
- **Right panels** (`#wiki-panel`, `#agent-panel`): fixed right, width
  `var(--right-panel-width, 392px)`, full height; `.collapsed` slides them
  off leaving their tabs stacked on the right edge;
  `.right-panel-pane-active/inactive` control which of the two occupies the
  slot; `.right-panel-resize-handle` is a 6 px grab strip on the left edge.
- **Search** (`#search`): pill input top-center-left; results dropdown with
  `.sr-item` rows (name, `.sr-type` chip color-coded country/region,
  area, `+ compare` button), `.active` highlight.
- `#sel-body`: compact select next to search.
- **Tooltip** (`#tooltip`): fixed, pointer-events none, dark card with
  `.tt-title` / `.tt-line` / `.tt-note` (muted, smaller) / `.tt-key` chips.
- **Wiki panel internals**: `.wp-item` cards with hover + `.selected`
  states, `.wp-badge` chips, `.wp-status` muted status rows, spinner.
- **Agent internals**: chat bubbles by role, `.agent-tool-log` monospace
  collapsed group, status badge states, example-prompt buttons, settings
  form grid, markdown styles (tables scroll horizontally).
- `.context-body-label`: absolutely positioned small glassy label following
  context bodies (transform set from JS).
- `#hint`: bottom-center pill, `.faded` opacity transition.
- `#moon-back`: bottom-left pill button.
- `.heat-combo*`: the searchable overlay dropdown (button, menu, search
  input, grouped options, `.active` row).
- Compact breakpoint `max-width: 1199px` collapses panels by default;
  `body.right-panel-resizing` disables transitions and text selection.
- Accessibility: `.sr-only` class, aria-expanded/labels maintained by JS,
  keyboard support for search, combo, resize handles.

Assets required (equirectangular JPGs unless noted): earth-day, earth-night,
moon (NASA LRO), sun/mercury/venus(+venus-atmosphere)/mars/jupiter/saturn/
uranus/neptune (Solar System Scope), saturn-rings.png (radial strip with
alpha), pluto/charon (NASA New Horizons), io/europa/ganymede/callisto
(NASA/JPL/USGS), titan (Bjorn Jonsson / J N Squire). Every texture gets an
attribution line in the sidebar `.attrib` block and README.

---

## 14. External services summary (all browser-side, CORS-required)

| service | used for |
|---|---|
| CelesTrak `gp.php?GROUP=visual&FORMAT=tle` | satellite TLEs |
| OpenSky `/api/states/all` | live aircraft (CORS-blocked from foreign origins → proxy config) |
| adsbdb `/v0/callsign/{cs}` | flight route lookup |
| aisstream.io WebSocket | global live AIS (user key) |
| Digitraffic `meri.digitraffic.fi/api/ais/v1/*` | Baltic AIS (no key) |
| USGS earthquake GeoJSON feeds | earthquakes |
| NASA EONET v3 | natural events |
| The Space Devs LL2 `launch/upcoming` | launches (~15 req/hr unauth) |
| Open-Meteo forecast / air-quality / flood / climate APIs | weather-grid overlays |
| NOAA SWPC `ovation_aurora_latest.json` | aurora oval |
| en.wikipedia.org `w/api.php` (`origin=*`) | geosearch, extracts, full-text search, parse |
| en.wikipedia.org `api/rest_v1/page/summary/` | context/summary lookups |
| query.wikidata.org SPARQL | body surface articles; agent queries |
| commons.wikimedia.org `w/api.php` | CORS-safe flag thumbnails |
| nominatim.openstreetmap.org | reverse (wiki context) + forward (agent geocode; throttled) |
| tile.openstreetmap.org | OSM detail layer |
| openrouter.ai / api.deepseek.com / localhost Ollama | agent LLM completions |

Every fetch has an explicit timeout (AbortController) and a defined failure
path (fallback data, cached data, or an honest `idle`/`blocked`/`limited`
badge). No API keys ship with the app; user-supplied keys live in
localStorage only.

---

## 15. Known pitfalls & non-obvious constraints (do not rediscover these)

1. **`frustum.far = 1e13`** is required to render Neptune; rely on the
   logarithmic depth buffer.
2. **Never real-fly the camera across interplanetary distances** — use the
   scaled proxy transition (§10.4). This applies even to "short" hops
   between a planet and its own moon, because the *absolute* coordinates are
   huge.
3. **CPU-project markers at planetary distances** (§10.5); a collection
   `modelMatrix` scatters/flashes billboards due to GPU float precision.
   Mars is the reference implementation.
4. **IAU transpose bugs** are the most common orientation error. Cesium's
   `IauOrientationAxes.evaluate` needs a transpose. Verify orientation
   empirically: the tidally-locked Moon's sub-Earth point must face Earth;
   for planets check the sub-solar longitude or a known feature (e.g. Olympus
   Mons at 18.65°N, 133.8°W).
5. **Texture seam**: `EllipsoidGeometry`'s texture starts on +X; rotate only
   the rendered sphere by Rz(π), never the marker/picking frame.
6. **Wikipedia geosearch is Earth-only and radius-capped at 10 km.**
   Off-Earth bodies must use the Wikidata SPARQL + client-side
   great-circle-sort pattern; never call geosearch for another body.
7. **Wikidata `Special:FilePath` URLs fail CORS for WebGL** — resolve flags
   through the Commons imageinfo API into upload.wikimedia.org thumbnails.
8. **Planetary longitudes** from Wikidata are frequently 0–360°E — normalize
   to −180…180.
9. **Open-Meteo**: fetch chunks sequentially; distinguish minutely-rate-limit
   429s (retry) from hourly/daily quota 429s (cooldown + cache fallback).
10. **OpenSky blocks foreign browser origins** — detect and badge `CORS`
    rather than hammering it; support a proxy URL override.
11. **aisstream with a bad key connects silently and never sends data** —
    use a 15 s usable-message watchdog.
12. **DeepSeek rejects empty `tool_calls: []`** in replayed history — omit
    the field.
13. **Dangling tool_calls corrupt the conversation** — when terminating the
    agent loop early, synthesize a tool result for every pending call id.
14. **Cesium Entity.plane/ellipse & fully custom Geometry can crash the
    render loop in this Cesium build** in some contexts — prefer
    points/billboards/polylines (the ring geometry in §10.7 is the one
    vetted exception).
15. In a backgrounded tab `requestAnimationFrame` pauses — camera flights
    and ticks appear frozen; it's a throttled-tab artifact. Pump
    `viewer.render()` manually if automation needs progress. WebGL never
    goes idle, so headless screenshot tools tend to time out — inspect state
    via `window.__globe` instead.
16. Register drag handlers **with and without the SHIFT modifier** —
    modifier changes mid-drag otherwise stall Cesium input events.
17. True-size overlays must be **rigid rotations of unit vectors** — any
    lat/lon-offset approach distorts area. Use vector-sum centers for
    antimeridian robustness and shortest-arc quaternions with an antipodal
    fallback axis.
18. localStorage writes can throw in private mode — wrap all of them.
19. All demo/fallback data must be deterministic (seeded PRNG) so reloads
    look identical, and every fallback must keep retrying the live source
    and promote itself on recovery.

---

## 16. Suggested implementation order

1. **Shell**: `index.html` DOM contract (§3) + `css/style.css` skeleton +
   static server; Cesium viewer boot with night/day/OSM crossfade and
   auto-rotate (§4.1, §4.4).
2. **Shared geometry**: `country-geo.js`, `continent-geo.js`,
   `country-data.js` (any ~190-country stats snapshot works as the legacy
   fallback).
3. **Wiki panel** (§8.3) + click-to-open wiring + tooltips scaffold — this is
   the product's core interaction.
4. **Movement layers**: satellites → flights → shipping (with demo fallbacks
   first, then live feeds), then the simple point layers (§6.4–6.9).
5. **Heatmap** (§7): country choropleth first (bundled stats), then the
   Open-Meteo weather grid with timeline, then conflict/skyscraper/aurora.
6. **True-size + search** (§8.1–8.2).
7. **Bodies**: `bodies.js` + `BodyLayer` with the Moon (direct focus, no
   proxy), then Mars (proxy + CPU markers — the hard part), then generic
   planets/moons/Sun/rings; the focus system in app.js (§4.3).
8. **Agent** (§11): providers → tools → harness → chat panel.
9. **Data pipeline** (§12) — can come last; until then bundle any snapshot
   matching the schemas.

### 16.1 Acceptance checklist

- Load: night globe with day-side lighting and a moving terminator; zooming
  into a city fades in OSM streets; sun lighting drops when zoomed.
- Toggling each layer shows an honest badge + count; killing the network at
  boot yields DEMO satellites/flights/ships that animate plausibly and later
  promote to LIVE.
- Clicking anywhere opens the wiki panel with a pin, glowing radius ring
  that tracks the slider live, pins per located article, cross-highlighting,
  and popup articles.
- Search "Africa" → fly-to + outline; "+ compare" drops a draggable outline
  that keeps its area anywhere on the globe, spins with Shift+scroll, and
  removes on right-click.
- Wet-bulb overlay paints in chunks, tooltip reads interpolated values with
  heat-stress labels, timeline scrubs 3 past days, resolution refetches.
- Body dropdown → Moon: camera flies to a correctly-oriented Moon
  (sub-Earth point faces Earth), article dots with mission flags, category
  filter, clicking a dot opens the panel list. Earth layers are suspended
  and restored on return.
- Mars/Jupiter/Neptune: sky dot + label; focusing runs the pull-back +
  proxy swap with no visible pop; markers stay glued to the surface with no
  flicker while the camera orbits; hovering Earth from there offers "click
  to return".
- Saturn shows rings when focused; Io/Titan/Charon orbit their parents,
  which render as context globes with HTML labels.
- Agent: with a key set, "Show the countries where Malaysian passport
  holders can travel to visa-free" produces tool calls (wiki_article /
  SPARQL), a colored/labelled map, and a grounded summary; unplugging the
  network yields an `[UNVERIFIED]`-badged best-effort map, not a refusal;
  the tool-budget checkpoint pauses at 50 calls; reloading a history session
  redraws its overlays.
- `window.__globe` exposes every layer for console inspection.


