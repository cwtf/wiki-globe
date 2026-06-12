# Wiki Globe

A real-time interactive 3D globe that visualises three layers of global movement —
satellites, flights, and shipping lanes — and turns into a detailed OpenStreetMap
view as you zoom in. Click anywhere to browse Wikipedia articles near that point.

Built on [CesiumJS](https://cesium.com/platform/cesiumjs/) with no build step:
plain HTML/CSS/ES modules served statically.

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
| Shipping | Curated waypoints for 17 major corridors (Pacific, Atlantic, Indian Ocean, Mediterranean, Suez/Cape, and both polar routes), animated flow pulses + simulated vessels | Always available (static data) |

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
js/shipping-lanes.js    hand-plotted corridor waypoints
js/demo-data.js         demo flights/satellites generators, airports
js/wiki-panel.js        geosearch + Nominatim context articles, radius slider
assets/earth-night.jpg  night base texture
```
