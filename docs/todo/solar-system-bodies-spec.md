# Design spec: extending Wiki Globe to the rest of the solar system

Status: **Mars shipped; remaining planets TODO.** This document is a
self-contained hand-off. It records the design philosophy already shipped for
Earth + Moon + Mars, the exact patterns to reuse, the data that has already
been downloaded, and the technical decisions (with pitfalls) for adding
Mercury, Venus, Jupiter, Saturn, Uranus, Neptune, and Pluto.

Read this alongside the code — everything referenced here exists and works
today for the Moon and/or Mars; the job is to generalize it.

---

## 1. Current state (what already exists)

| Piece | Where | What it does |
|---|---|---|
| Moon layer | `js/layers/moon.js` | The template for future solid-body behavior. Live-ephemeris position, textured ellipsoid primitive, focus/tracking camera, lazy Wikipedia markers, mission flags. |
| Mars layer | `js/layers/mars.js` | First shipped planet. Live astronomy-engine ephemeris, IAU Mars rotation, scaled interplanetary focus transition, Mars sky dot, Wikipedia categories, mission flags, and CPU-projected surface markers to avoid GPU precision loss at true Mars distance. |
| App wiring | `js/app.js` | Click routing by `picked.id.kind`, focus-change handler (layer suspension + sidebar scoping), body switcher, tooltips, per-frame `tick()` calls. |
| Wiki panel | `js/wiki-panel.js` | `openBody(bodyName, lat, lon, items)` renders a pre-built, distance-sorted article list with no Earth geosearch. |
| Sidebar scoping | `index.html` + `css/style.css` | `.layer.earth-only`, `.layer.moon-only`, and `.layer.mars-only` rows scope controls to the focused body. Generic `data-scope` is still the desired refactor before adding many more bodies. |
| Body switcher | `index.html` `#sel-body` | Dropdown next to the search bar: `earth` / `moon` / `mars`. Two-way synced with focus in `app.js`. Designed to grow — add one `<option>` per new body. |
| Textures | `assets/` | **Already downloaded** for all planets + Pluto (see §7). |

### Interaction model already proven for the Moon and Mars

- The body is rendered at **true scale and true live position** in Earth-fixed
  coordinates, recomputed every frame from the real-time scene clock.
- Clicking the body (or selecting it in the dropdown) **flies the camera there**
  and engages a per-frame `lookAtTransform` tracking frame (bodies move fast in
  Earth-fixed coordinates; the camera must re-anchor every frame).
- While focused: idle **auto-rotate orbits the body** (`camera.rotateLeft` in
  the tracked frame), scroll zoom is clamped above the surface
  (`minimumZoomDistance = radius + margin`, restored on exit).
- **Day/night** exists for Earth. Moon/Mars intentionally shipped without a
  sidebar day/night toggle after iteration; keep the per-body decision
  explicit instead of assuming every future body needs the same control.
- **Wikipedia markers** load lazily on first focus (never fetched while another
  body has the camera), display across the surface, and are click/hover
  targets. Clicking bare surface opens the panel with the nearest articles
  (client-side great-circle sort — do NOT use Wikipedia geosearch off-Earth,
  its radius caps at 10 km).
- **Mission flags**: items with Wikidata country-of-origin (P495) get a small
  flag billboard beside their marker (see §8 for the CORS-safe pipeline).
- **Wiki category filters**: Moon and Mars both expose a `Category` dropdown.
  Mars defaults to `Missions & landing sites`, then offers craters, mountains
  and valleys, regions and plains, and other.
- **Focus scoping**: only the focused body's overlays and sidebar rows exist.
  Earth layers (satellites/flights/shipping/heatmap/true-size/search) are
  suspended without touching their checkboxes, and restored from checkbox
  state on return.
- Clicking the previous body visible in the sky returns focus to it (Earth is
  clickable from the Moon). Escape hatch: the `#moon-back` button
  (generalize to "Back to Earth" from any body).

### Design principles (do not violate)

1. **Live/generated data first; bundled data is fallback-only.** Positions come
   from ephemerides evaluated at the real clock, articles from live Wikidata/
   Wikipedia queries. A small hardcoded list may back up a failed fetch, never
   replace it.
2. **Open-source imagery only**, credited in the sidebar `.attrib` block and
   README (`Data & attribution`).
3. **Interaction parity**: whatever works on Earth should feel identical on
   every body (hover tooltips, click-to-articles, auto-rotate, and
   body-appropriate lighting controls).
4. **The sidebar shows only what applies to the body in focus.**
5. Badges tell the truth: `LIVE` (fetched), `DATA` (bundled fallback),
   `—`/idle (not loaded yet), `…` (loading).

---

## 2. Target UX for planets

### 2.1 Sky dots (unfocused representation)

Planets are sub-pixel at true scale from Earth, so each planet is marked by:

- a **clickable dot** (`PointPrimitiveCollection`, `pixelSize` ~6–7,
  fixed pixel size — no `scaleByDistance` needed at these distances), colored
  to match the planet (see table below), placed at the planet's **true
  Earth-fixed position**;
- a **name label** (`LabelCollection`, e.g. 11px sans, `--text` color at ~0.8
  alpha, `pixelOffset` a few px right of the dot, `HorizontalOrigin.LEFT`);
- `id: { kind: "body", body }` on both dot and label so the existing pick
  router in `app.js` handles hover (pointer cursor + tooltip with live
  distance from Earth) and click (→ focus).

The Moon keeps its rendered disc (it is genuinely visible from Earth); dots are
for bodies too small to see. Consider also adding a dot+label for the Moon at
extreme zoom-out for consistency, and for **Earth as seen from other planets**
(Earth is sub-pixel from Jupiter outward — the "click Earth to return"
affordance must therefore also exist as a labeled dot in every planet's sky).

Suggested dot colors (match visual appearance of the body):

| Body | Color |
|---|---|
| Mercury | `#9c9389` |
| Venus | `#e6c89c` |
| Mars | `#c1583c` |
| Jupiter | `#c8a06e` |
| Saturn | `#e0c188` |
| Uranus | `#9bd4d6` |
| Neptune | `#4f7bd0` |
| Pluto | `#c9b29a` |

### 2.2 Focused view

For solid bodies, keep the Moon/Mars experience: textured true-scale ellipsoid,
idle auto-orbit, Wikipedia markers where Wikidata has articles with coordinates
on that globe, and mission flags where P495 exists. Lighting controls are
per-body: Moon keeps a day/night toggle; Mars shipped without one because the
Mars menu worked better when it matched Moon's wiki controls but stayed simpler.
Gas giants may have few or no articles — the layer must handle an empty result
gracefully: badge `LIVE 0`, no dots, surface clicks show "No articles found
near this point".

### 2.3 Sidebar & switcher

- `#sel-body` gains one option per body, in solar-system order:
  ☿ Mercury, ♀ Venus, 🌍 Earth, 🌕 Moon, ♂ Mars, ♃ Jupiter, ♄ Saturn,
  ♅ Uranus, ♆ Neptune, ♇ Pluto (emoji optional; text labels are what matter).
- Replace the binary `earth-only` / `moon-only` CSS classes with a generic
  mechanism, e.g. `document.body.dataset.focus = "mars"` plus
  `.layer[data-scope]` rows shown only when `data-scope` matches the current
  focus (`data-scope="earth"`, `data-scope="mars"`, …; rows without
  `data-scope` are universal, like Auto-rotate).
- Each planet's sidebar block: visibility checkbox, `Wiki articles` sub-toggle,
  optional category filter, badge + count, and only body-specific controls that
  genuinely apply. Moon/Mars deliberately has no `Day/night cycle` row.
- The "Back to Earth" button generalizes: always offer one-click return to
  Earth from any focused body.

---

## 3. Architecture: refactor `moon.js` → generic `BodyLayer`

Extract a `BodyLayer` class (suggested: `js/layers/body.js`) parameterized by a
per-body config; `MoonLayer` becomes `new BodyLayer(viewer, BODIES.moon)` (the
Moon's only specialization is its Cesium-provided ephemeris + IAU axes).

```js
// js/bodies.js (new) — single source of truth
export const BODIES = {
  mercury: {
    name: "Mercury",
    radius: 2439700,                    // metres (mean)
    texture: "assets/mercury.jpg",
    dotColor: "#9c9389",
    wikidataGlobe: "Q308",              // geoGlobe QID for SPARQL
    rotation: { ra0: [281.0103, -0.0328], dec0: [61.4155, -0.0049],
                w: [329.5988, 6.1385108] },   // see §6
    ephemeris: "Mercury",               // astronomy-engine body name
  },
  // … venus, mars, jupiter, saturn, uranus, neptune, pluto
};
```

Radii (m): Mercury 2,439,700 · Venus 6,051,800 · Mars 3,389,500 ·
Jupiter 69,911,000 · Saturn 58,232,000 · Uranus 25,362,000 ·
Neptune 24,622,000 · Pluto 1,188,300. (Oblateness can wait; spheres shipped
fine for the Moon.)

A tiny `FocusManager` in `app.js` replaces the current moon-only handler:
tracks `focusedBody` (`"earth"` or a BODIES key), runs the suspend/restore
logic, syncs `#sel-body`, the back button, and `document.body.dataset.focus`.
Only one body is ever focused; switching planet→planet goes through the same
code path (blur current → focus next; no need to route via Earth).

Per-frame cost: each body's `tick()` recomputes ephemeris + model matrix.
Nine bodies × cheap analytic math is fine; if profiling says otherwise,
update unfocused bodies every Nth frame (their dots move imperceptibly).

---

## 4. Ephemeris (planet positions)

Cesium ships `Simon1994PlanetaryPositions` for **Sun and Moon only** — it does
NOT cover planets. Recommended: **astronomy-engine** (MIT, pure JS, ~150 kB,
VSOP87-based, includes Pluto):

```html
<script src="https://cdn.jsdelivr.net/npm/astronomy-engine@2/astronomy.browser.min.js"></script>
```

Pipeline per frame (mirrors `MoonLayer._updateTransform`):

```js
const AU = 1.495978707e11;
const date = Cesium.JulianDate.toDate(time);
const v = Astronomy.GeoVector(Astronomy.Body[cfg.ephemeris], date, true);
// GeoVector returns geocentric J2000 equatorial (EQJ) in AU.
// J2000 ≈ ICRF to well under an arcsecond — treat as ICRF directly.
const posIcrf = new Cesium.Cartesian3(v.x * AU, v.y * AU, v.z * AU);
const icrfToFixed = Cesium.Transforms.computeIcrfToFixedMatrix(time)
                 ?? Cesium.Transforms.computeTemeToPseudoFixedMatrix(time);
Cesium.Matrix3.multiplyByVector(icrfToFixed, posIcrf, posFixed);
```

Sanity check after wiring: `Astronomy.GeoVector(Body.Moon,…)` should agree
with Cesium's Simon1994 moon position to a small fraction of a degree.

---

## 5. Rendering at solar-system distances (the hard part)

Four practical problems the Moon never hit:

1. **Far plane.** Default `camera.frustum.far = 5e8 m` barely contains the
   Moon (3.6–4.1e8 m). Neptune is ~4.5e12 m. Set
   `scene.camera.frustum.far = 1e13` at boot. Cesium's logarithmic depth
   buffer (`scene.logarithmicDepthBuffer`, on by default) makes this workable
   without z-fighting.
2. **Float precision / travel.** Cesium's RTC rendering handles large model
   matrices, but verify visually for jitter when parked at Saturn+
   (camera-relative errors grow with |position|). And do NOT tween a camera
   flight across 1e12 m — `flyToBoundingSphere` easing through interplanetary
   space is numerically and visually pointless.

   **Recommended focus transition, learned from Mars:** use a scaled
   interplanetary mode. A fake full-distance fly-through looked strange, and a
   fade/teleport or hybrid cinematic still did not feel spatially honest. The
   shipped Mars approach renders a temporary proxy Mars along the true
   Earth→Mars direction at a manageable distance (`TRANSITION_PROXY_DISTANCE`),
   flies to that proxy, then swaps into the true Mars `lookAtTransform` frame
   on completion. Hide the true body/markers until `_enterTrueFocus()` so they
   do not pop into view during the proxy flight. Keep true `flyToBoundingSphere`
   only for short hops like Earth↔Moon.

   Fallback plan if true-scale placement jitters unacceptably at Neptune:
   keep dots at true positions (they're pixel-sized, jitter-immune) but render
   the **focused** body in a private reference frame near the origin (only one
   body is ever focused, and its sky only needs dots + the Sun). Prefer plan A;
   document measurements before switching.

3. **Surface marker precision.** Mars exposed a GPU precision pitfall: a
   `PointPrimitiveCollection`/`BillboardCollection` with Mars-local marker
   positions plus a huge collection `modelMatrix` can flash markers briefly,
   then scatter or disappear at true interplanetary distances. The fix that
   stuck: store each article's body-fixed position, then every tick project it
   to absolute world coordinates on the CPU with `Matrix4.multiplyByPoint` and
   assign that world position directly to the point/billboard. Also give dots
   and flag billboards `disableDepthTestDistance: Number.POSITIVE_INFINITY` and
   enough surface clearance (`MARKER_ALT = 120000` for Mars).

4. **Lighting.** `scene.light` is a `SunLight` positioned from the real sun —
   it is correct at every planet automatically. The lit/flat appearance swap
   from the Moon transfers when wanted, but Mars currently ships as a simpler
   always-textured planet without a sidebar day/night toggle. `scene.sun.show`
   stays on (the Sun disc is genuinely visible from everywhere).

---

## 6. Body orientation (IAU rotation models)

`Cesium.IauOrientationAxes` is Moon-only. For planets, implement the standard
IAU/WGCCRE model: north pole (α₀, δ₀) + prime-meridian angle W, all in degrees;
`d` = days since J2000 TDB, `T = d / 36525`:

| Body | α₀ | δ₀ | W |
|---|---|---|---|
| Mercury | 281.0103 − 0.0328 T | 61.4155 − 0.0049 T | 329.5988 + 6.1385108 d |
| Venus | 272.76 | 67.16 | 160.20 − 1.4813688 d |
| Mars | 317.68143 − 0.1061 T | 52.88650 − 0.0609 T | 176.630 + 350.89198226 d |
| Jupiter | 268.056595 − 0.006499 T | 64.495303 + 0.002413 T | 284.95 + 870.5360000 d |
| Saturn | 40.589 − 0.036 T | 83.537 − 0.004 T | 38.90 + 810.7939024 d |
| Uranus | 257.311 | −15.175 | 203.81 − 501.1600928 d |
| Neptune | 299.36 + 0.70 sin N | 43.46 − 0.51 cos N | 249.978 + 541.1397757 d − 0.48 sin N |
| Pluto | 132.993 | −6.163 | 302.695 + 56.3625225 d |

(N = 357.85 + 52.316 T, degrees. Venus/Uranus retrograde spin is already
encoded in the signs. Values are the simplified IAU tables — fine at this
app's fidelity; Mars/Mercury trig refinements are not worth it.)

Body-fixed → ICRF rotation matrix:

```
R = Rz(α₀ + 90°) · Rx(90° − δ₀) · Rz(W)
```

then compose exactly like the Moon: `fixed = icrfToFixed · R`, model matrix
`fromRotationTranslation(fixed, posFixed)`.

**Pitfall learned the hard way:** `IauOrientationAxes.evaluate` returns
ICRF→moon-fixed and needed a transpose (see `moon.js` `_updateTransform`).
For the hand-rolled R above no transpose is needed — but VERIFY with the
sub-solar / sub-Earth trick (§10) before trusting any orientation.

Texture alignment: Cesium's `EllipsoidGeometry` maps texture u = 0.5 at
body-fixed +X (longitude 0), which matches all downloaded maps (they are
centered on the prime meridian). Same convention as the shipped Moon.

---

## 7. Textures — ALREADY DOWNLOADED to `assets/`

| File | Body | Size | Source / license |
|---|---|---|---|
| `mercury.jpg` | Mercury | 2048×1024 | Solar System Scope textures, CC BY 4.0 (NASA-derived) |
| `venus.jpg` | Venus surface (Magellan radar) | 2048×1024 | Solar System Scope, CC BY 4.0 |
| `venus-atmosphere.jpg` | Venus cloud deck | 2048×1024 | Solar System Scope, CC BY 4.0 |
| `mars.jpg` | Mars | 2048×1024 | Solar System Scope, CC BY 4.0 |
| `jupiter.jpg` | Jupiter | 2048×1024 | Solar System Scope, CC BY 4.0 |
| `saturn.jpg` | Saturn | 2048×1024 | Solar System Scope, CC BY 4.0 |
| `saturn-rings.png` | Saturn ring strip (radial, RGBA) | 2048×125 | Solar System Scope, CC BY 4.0 |
| `uranus.jpg` | Uranus | 2048×1024 | Solar System Scope, CC BY 4.0 |
| `neptune.jpg` | Neptune | 2048×1024 | Solar System Scope, CC BY 4.0 |
| `pluto.jpg` | Pluto | 3840×1920 | NASA/JHUAPL/SwRI New Horizons global mosaic via Wikimedia Commons ("Pluto color mapmosaic.jpg"), public domain |

(For reference, existing: `earth-day.jpg`, `earth-night.jpg`, `moon.jpg` —
NASA LRO CGI Moon Kit.)

Notes:
- **CC BY 4.0 requires attribution**: when planets ship, add
  "Solar System Scope" to the sidebar `.attrib` line and README.
- **Venus decision**: default to `venus.jpg` (surface topography — consistent
  with "topography" philosophy) and consider `venus-atmosphere.jpg` as the
  unzoomed/lit look or a sub-toggle. Document whichever is chosen.
- **Saturn's rings** (stretch goal): flat annulus, inner radius ≈ 74,500 km,
  outer ≈ 140,220 km, textured radially with `saturn-rings.png`
  (u = (r − inner)/(outer − inner)), two-sided, in Saturn's equatorial plane
  (body-fixed XY plane — the rotation model provides it). Ship Saturn without
  rings first if needed, but it will look wrong to users; prioritize.

---

## 8. Wikipedia articles & mission flags per body

Reuse the Moon pipeline verbatim; only the globe QID changes:

| Body | Wikidata geoGlobe |
|---|---|
| Moon (shipped) | Q405 |
| Mercury | Q308 |
| Venus | Q313 |
| Mars | Q111 |
| Jupiter | Q319 |
| Saturn | Q193 |
| Uranus | Q324 |
| Neptune | Q332 |
| Pluto | Q339 |

SPARQL template (parameterize the existing `SPARQL_QUERY` in `moon.js`):
`?v wikibase:geoGlobe wd:<GLOBE_QID>` — everything else (sitelink ranking,
enwiki article, P495 country + P41 flag, LIMIT ~420) stays identical.
Expectations: Mars returns hundreds (craters, rovers, landing sites — flags
for US/USSR/China/ESA/India/Japan missions), Mercury/Venus/Pluto return
dozens (craters/regions), gas giants may return near zero — handle empty
gracefully.

**Flag CORS pitfall (solved, keep the solution):** never feed Wikidata's
`Special:FilePath` URLs to Cesium billboards — they fail CORS for WebGL.
Batch-resolve file names via the Commons API
(`action=query&prop=imageinfo&iiurlwidth=48&origin=*`) into direct
`upload.wikimedia.org` thumbnails. This is `MoonLayer._resolveFlags` — reuse.

Longitude conventions vary (some planetary coordinates are 0–360°E,
Mars mixes east/west historically in articles but Wikidata P625 values are
normalized): keep the existing `lon > 180 → lon − 360` normalization and
spot-check a known feature per body (e.g. Olympus Mons ≈ 18.65°N, 226.2°E →
−133.8° in app coordinates).

---

## 9. Implementation checklist (suggested order)

1. **Done: Mars standalone layer.** `js/layers/mars.js` ships astronomy-engine
   ephemeris, IAU Mars rotation, scaled proxy transition, sky dot/label,
   live Wikidata/Wikipedia markers for globe Q111, Commons-resolved flags,
   category filtering defaulted to `Missions & landing sites`, and CPU-projected
   marker positions.
2. **Next refactor, no behavior change:** extract the common Moon/Mars behavior
   into `BodyLayer`; keep Moon and Mars working identically after extraction.
3. **FocusManager cleanup:** migrate `earth-only`/`moon-only`/`mars-only` CSS to
   `data-scope` / `body[data-focus]`; have `#sel-body` read from `BODIES`.
4. **General planet config:** add Mercury/Venus/Jupiter/Saturn/Uranus/Neptune/
   Pluto entries with radius, texture, dot color, Wikidata globe QID,
   ephemeris body name, and IAU rotation parameters.
5. **Reuse the Mars transition pattern:** sky dot + label while unfocused;
   scaled proxy flight; swap into true focused body frame; track with
   per-frame `lookAtTransform`; back to Earth.
6. **Reuse the Mars marker pattern:** live SPARQL, fallback list, Commons flag
   thumbnail resolution, category filters where useful, CPU-projected marker
   positions, and empty-result handling for sparse bodies.
7. **Saturn rings:** add the ring primitive once Saturn's sphere works.
8. Sidebar blocks per body, attribution updates (Solar System Scope,
   NASA New Horizons), README feature table row, JSON-LD featureList.
9. Stretch: Galilean moons / Titan / Charon as children of their planet
   (same BodyLayer, parent-relative ephemeris from astronomy-engine's
   `JupiterMoons`), body search integration, "tour" mode.

---

## 10. Verification playbook (project-specific, hard-won)

- **No screenshots.** `preview_screenshot` times out on this app (WebGL never
  goes idle). Verify with `preview_eval` against `window.__globe`
  (add each new layer to the `window.__globe` export).
- **Throttled-tab trap:** in a backgrounded preview tab `requestAnimationFrame`
  is paused — camera flights freeze mid-air with `_currentFlight` set and
  per-frame `tick()`s stop. This looks exactly like a broken flight; it is not.
  Pump frames manually from a `setInterval` calling `viewer.render()`
  (~1 Hz still fires) until `complete` runs. Long-lived eval promises also
  time out — write results to `window.__x` and poll with follow-up evals.
- **Orientation proof (the transpose catch):** for any body, compute a known
  direction in body-fixed coordinates and check it:
  - Moon-style: sub-Earth point within ±8° of (0°, 0°) — Moon only (tidal lock);
  - Planets: sub-solar longitude — compute the Sun's direction in body-fixed
    coordinates from the model matrix and compare with an independent
    almanac value (astronomy-engine can supply it); or verify a marker
    dropped at a named crater's Wikidata coordinates lands on that feature
    in the texture.
- **Live-data checks:** article `source` badge must be `live` with a plausible
  count; flags must reach `_imageIndex >= 0` in the billboard atlas (a
  `-1` index with 0-byte network entries = the CORS trap of §8).
- **Marker persistence check:** changing a category dropdown should rebuild and
  leave body wiki dots visible. If dots appear for one frame and then vanish,
  suspect large-distance marker precision first: avoid collection `modelMatrix`
  for body-local marker coordinates and CPU-project them to world positions
  each tick, as Mars does.
- **Focus scoping:** after focus/blur round-trip, every Earth layer's `show`
  must equal its checkbox, `heat.mode` restored, dropdown synced, sidebar rows
  correct — see the checks used in the Moon iterations for exact assertions.

---

## 11. Out of scope (explicitly)

- Real-time spacecraft positions off-Earth, planetary weather overlays,
  OSM-style zoom detail on other bodies (no tile servers), n-body accuracy,
  barycentric wobble, relativistic light-time correction (astronomy-engine's
  `GeoVector` already applies light-time aberration — good enough).
- Asteroids/comets: possible later via the same dot pattern + Horizons/SBDB
  APIs, but keep the body list curated — the dropdown is a navigation tool,
  not a catalog.
