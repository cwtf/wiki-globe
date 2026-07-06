# Wiki Globe

A real-time interactive 3D globe that visualises three layers of global movement —
satellites, flights, and shipping lanes — and turns into a detailed OpenStreetMap
view as you zoom in. Click anywhere to browse Wikipedia articles near that point.

Built on [CesiumJS](https://cesium.com/platform/cesiumjs/) with no build step:
plain HTML/CSS/ES modules served statically.

Live demo: [https://cwtf.github.io/wiki-globe/](https://cwtf.github.io/wiki-globe/)

GitHub: [https://github.com/cwtf/](https://github.com/cwtf/)

## Run it

Any static file server works. From this folder:

```powershell
python -m http.server 8080
# or
npx serve -l 8080
```

Then open <http://localhost:8080>. (Opening `index.html` directly via `file://`
won't work — the texture and module fetches need an HTTP origin.)

## Features

| Layer | Live source | Fallback |
|---|---|---|
| Satellites | [CelesTrak](https://celestrak.org) TLEs ("visual" group), propagated client-side with SGP4 via satellite.js | Synthetic orbits (LEO constellation, sun-sync, MEO nav, GEO) |
| Flights | [OpenSky Network](https://opensky-network.org) anonymous state vectors, refreshed every 2 min and dead-reckoned in between; routes per callsign via [adsbdb](https://www.adsbdb.com) | ~200 great-circle flights between major world airports |
| Data overlay | A dropdown of overlay modes, off by default. **Weather** (live): wet-bulb temperature (Stull 2011 approximation; ~35 °C is the theoretical human survivability limit), air temperature, or relative humidity — [Open-Meteo](https://open-meteo.com) hourly data on a global grid (resolution slider: 20° down to 7.5°) with the past 3 days scrubbable via day + hour sliders (a "Viewing …" readout shows the selected UTC time), bilinearly interpolated and draped over the globe; hover anywhere for the local reading. **Country and regional indicators**: economy, development, demographics, health/access, inequality, climate/air, and energy metrics from World Bank, OWID, UNDP, and generated admin-1 data; hover a country or region for its value. **Built environment**: city skyscraper-count cells from Wikidata Q1575895 / Wikipedia, supplemented by grouped Wikidata Q11303 records for unlisted cities and normalized as towers per 10,000 km². **Conflict**: recent UCDP event cells with click-through to related Wikipedia articles. | Weather falls back to a localStorage cache of the last good fetch when rate-limited |
| Moon | Position from the Simon 1994 analytic lunar ephemeris evaluated at the real-time scene clock (IAU 2000 orientation), so it sits where the Moon actually is right now; lunar Wikipedia article markers from a Wikidata SPARQL query (Moon-globe coordinates with an English Wikipedia sitelink, ranked by sitelink count) | Bundled list of famous lunar sites (Apollo sites, major craters, maria) |
| Sun | Live astronomy-engine geocentric solar position, IAU rotation, labeled sky dot, flat Solar System Scope texture, and Mars-style scaled proxy focus transition | No surface article layer |
| Planets | Mercury, Venus, Mars, Jupiter, Saturn, Uranus, Neptune, and Pluto use live astronomy-engine geocentric positions, IAU rotation parameters, labeled sky dots, Mars-style scaled proxy transitions, body-specific Wikidata/Wikipedia surface markers, and textured Saturn rings | Sparse bodies can legitimately show `LIVE 0` when Wikidata has no mapped articles |
| Shipping | Live AIS: [aisstream.io](https://aisstream.io) WebSocket (global; paste a free API key via the "key" link or `?aiskey=`) or [Digitraffic Finland](https://www.digitraffic.fi/en/marine-traffic/) open REST data (no key, Baltic coverage), dead-reckoned between reports. Hover shows name, type, flag state, speed, heading. "Destination routes" resolves each vessel's reported AIS destination against a built-in port gazetteer and draws the path. | Simulated vessels along 17 curated corridors (which stay visible as a dim reference layer in live mode) |

OpenSky's public REST API does not currently expose `states/all` to arbitrary
browser origins, and anonymous requests are also credit-limited. Static
deployments therefore show the flight layer with a `CORS` or `LIMIT` badge and
use demo traffic unless you serve OpenSky through a same-origin/API-worker proxy.
Set a proxy endpoint with `?openskyUrl=/api/opensky/states/all`, by assigning
`window.WIKI_GLOBE_OPENSKY_URL` before loading `js/app.js`, or with
`localStorage.setItem("wikiGlobeOpenSkyUrl", "/api/opensky/states/all")`.

The globe is lit by the real sun: the day texture shows on the daylit side, the
night texture past the terminator, blended at the actual day/night boundary for
the current UTC time and moving at real-time rate (the scene clock runs at 1x).
Sun lighting is suspended once you zoom into street-level OSM so the map stays
readable on the night side.

- **Layer controls** (top-left): each layer toggles independently; orbit paths /
  flight routes / vessel routes toggle separately; per-layer count and a
  LIVE / DEMO badge show what you're looking at.
- **Globe**: night-view Earth texture, atmosphere, slow auto-rotation (pauses
  while you interact or read the Wikipedia panel). Drag to rotate, scroll to zoom,
  hover anything for a tooltip.
- **Zoom transition**: below ~2,600 km camera height, OpenStreetMap tiles fade in
  progressively over the night texture, reaching full detail by ~550 km — roads,
  place names and landmarks at street level. Zoom out to return to the globe.
- **Wikipedia panel**: click any point for nearby articles ranked by distance
  (Wikipedia geosearch). The radius slider goes from 500 m (hyperlocal) to
  800 km — past 10 km it blends in city / region / country context articles
  resolved via Nominatim reverse geocoding. Esc or × dismisses without moving
  the camera.
- **Moon**: rendered at its true live position and scale with NASA LRO imagery
  (CGI Moon Kit). Click the Moon to fly there (auto-rotate keeps orbiting it
  when idle); lunar Wikipedia markers load on the first visit and dot the whole
  surface while the Moon has focus. Click the surface or a marker for nearby
  lunar articles, and use "Back to Earth" to return. Lunar-mission markers
  (landers, probes, impact sites) carry the flag of their country of origin
  (Wikidata P495 → Commons flag thumbnails). Its day/night cycle (real solar
  terminator) toggles independently. Layers are scoped to the focused
  body: Earth overlays (satellites, flights, shipping, data overlays) pause at
  the Moon and resume on return; lunar markers never show from Earth.

## Data & attribution

- Map tiles © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors
  (the public tile server is fine for development; use a commercial tile provider
  for production traffic).
- Orbital elements: CelesTrak. Flight states: OpenSky Network (anonymous access is
  rate-limited; the app degrades to demo flights when unavailable). Flight routes:
  adsbdb. Article search: Wikipedia / Wikimedia APIs. Reverse geocoding: Nominatim.
- Skyscraper density: city counts from Wikidata Q1575895 / English Wikipedia,
  supplemented by grouped Wikidata Q11303 records for cities not in that list.
- Night Earth texture from the [three-globe](https://github.com/vasturiano/three-globe)
  examples (NASA Earth Observatory "Black Marble").
- Moon texture: [NASA SVS CGI Moon Kit](https://svs.gsfc.nasa.gov/4720/)
  (Lunar Reconnaissance Orbiter camera mosaic, public domain). Lunar article
  coordinates: Wikidata / Wikipedia.
- Solar System Scope textures for the Sun, Mercury, Venus, Mars,
  Jupiter, Saturn, Uranus, and Neptune (CC BY 4.0, NASA-derived). Pluto texture:
  NASA/JHUAPL/SwRI New Horizons global mosaic, public domain.
- Vessel positions are simulated along real corridors at an accelerated clock —
  there is no free global live AIS feed.

## Structure

```
index.html              shell + control panel / wiki panel markup
css/style.css
js/app.js               viewer setup, zoom crossfade, picking, tooltips, UI wiring
js/layers/satellites.js TLE fetch + SGP4 propagation + orbit paths
js/layers/flights.js    OpenSky states, dead reckoning, route arcs, adsbdb lookup
js/layers/shipping.js   lane rendering, flow pulses, simulated vessels
js/layers/heatmap.js    data overlays: Open-Meteo weather grid, choropleths, and conflict cells
js/country-data.js      bundled per-country GDP/HDI/IHDI/GNI estimates
js/shipping-lanes.js    generated shipping-lane GeoJSON loader + fallback
js/demo-data.js         demo flights/satellites generators, airports
js/layers/moon.js       live-ephemeris Moon + Wikidata lunar article markers
js/layers/sun.js        live-ephemeris Sun + scaled focus transition
js/layers/planets.js    generic sky-dot/proxy-focus layers for planets
js/wiki-panel.js        geosearch + Nominatim context articles, radius slider
data/shipping-lanes.latest.geojson  curated shipping corridor baseline
assets/earth-night.jpg  night base texture
assets/moon.jpg         NASA LRO color mosaic (CGI Moon Kit)
assets/sun.jpg ...      solar-system textures used by the body layers
```
