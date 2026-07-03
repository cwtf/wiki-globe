# Wiki Globe

A real-time interactive 3D globe that visualises three layers of global movement —
satellites, flights, and shipping lanes — and turns into a detailed OpenStreetMap
view as you zoom in. Click anywhere to browse Wikipedia articles near that point.

Built on [CesiumJS](https://cesium.com/platform/cesiumjs/) with no build step:
plain HTML/CSS/ES modules served statically.

Live demo: [https://cwtf.github.io/wiki-globe/](https://cwtf.github.io/wiki-globe/)

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
| Wet-bulb temp | [Open-Meteo](https://open-meteo.com) hourly 2 m temperature + relative humidity on a global grid (resolution slider: 20° down to 7.5°), combined with Stull's (2011) wet-bulb approximation. Off by default; toggling it on fetches the past 3 days of hourly data and drapes a bilinearly interpolated heat-map overlay over the globe, from cool blue to magenta (35 °C — the theoretical human survivability limit). Day + hour sliders scrub through the fetched history (a "Viewing …" readout shows the selected UTC time); hover anywhere for the local reading and a heat-stress rating. | — (layer hides if the API is unreachable) |
| Shipping | Live AIS: [aisstream.io](https://aisstream.io) WebSocket (global; paste a free API key via the "key" link or `?aiskey=`) or [Digitraffic Finland](https://www.digitraffic.fi/en/marine-traffic/) open REST data (no key, Baltic coverage), dead-reckoned between reports. Hover shows name, type, flag state, speed, heading. "Destination routes" resolves each vessel's reported AIS destination against a built-in port gazetteer and draws the path. | Simulated vessels along 17 curated corridors (which stay visible as a dim reference layer in live mode) |

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

## Data & attribution

- Map tiles © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors
  (the public tile server is fine for development; use a commercial tile provider
  for production traffic).
- Orbital elements: CelesTrak. Flight states: OpenSky Network (anonymous access is
  rate-limited; the app degrades to demo flights when unavailable). Flight routes:
  adsbdb. Article search: Wikipedia / Wikimedia APIs. Reverse geocoding: Nominatim.
- Night Earth texture from the [three-globe](https://github.com/vasturiano/three-globe)
  examples (NASA Earth Observatory "Black Marble").
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
js/layers/wetbulb.js    Open-Meteo grid fetch, Stull wet-bulb calc, heat-map overlay
js/shipping-lanes.js    hand-plotted corridor waypoints
js/demo-data.js         demo flights/satellites generators, airports
js/wiki-panel.js        geosearch + Nominatim context articles, radius slider
assets/earth-night.jpg  night base texture
```
