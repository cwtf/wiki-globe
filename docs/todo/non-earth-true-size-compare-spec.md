# Design spec: true-size Earth map comparison on non-Earth bodies

Status: **Initial implementation in progress.** This document captures the
design decisions from the true-size compare iteration: Earth keeps the original
click-to-copy workflow, while non-Earth bodies can spawn Earth countries,
continents, regions, and the whole world map as true-scale draggable overlays.

Read this alongside:

- `js/layers/truesize.js`
- `js/search.js`
- `js/app.js`
- `js/country-geo.js`
- `index.html`

---

## 1. Product Goal

Let users compare familiar Earth geography against other solar-system bodies.
The interaction should make the scale relationship obvious without implying
that Earth countries or continents actually exist on those bodies.

Core examples:

- Spawn China on the Moon at true Earth physical size.
- Spawn Asia on Mars at true Earth physical size.
- Spawn the entire Earth world map on Mercury, Ganymede, Pluto, etc.
- Drag, rotate, and remove these overlays with the same true-size controls
  used on Earth.

---

## 2. UX Rules

### Earth

Earth keeps the original true-size compare behavior.

- The `True-size compare` checkbox is visible only on Earth.
- When enabled, clicking an Earth country copies that country outline.
- The search bar lists countries, continents, and regions.
- Earth does **not** show the `World map` search option.
- Search result `+ compare` adds a draggable true-size overlay.
- Search result row click still flies to and highlights the selected place.

### Non-Earth Bodies

Non-Earth bodies do not need a true-size checkbox.

- The search bar remains visible while focused on a non-Earth body.
- Search lists countries, continents, regions, and a special `World map`
  option.
- Selecting a search result spawns that Earth feature directly onto the focused
  body.
- The `+ compare` button also spawns the feature directly.
- There is no click-to-copy by surface click on non-Earth bodies; bare-surface
  clicks should remain body wiki behavior.
- Search placeholder/ARIA text should switch with focus:
  - Earth: `Search a country or continent...`
  - Non-Earth: `Search a country, continent, or world map...`

Rationale: non-Earth bodies have no local countries. Treat Earth geography as
spawnable comparison objects, not a mode that remaps clicks on the body.

---

## 3. Search Behavior

`CountrySearch` owns the target-sensitive search list.

State:

- `entries`: countries + continent/region features.
- `worldEntry`: synthetic `World map` feature.
- `truesize.isEarthTarget()` decides whether to include `worldEntry`.

Expected behavior:

- Earth:
  - Empty query shows region/continent entries only.
  - Typed query searches countries + regions.
  - `World map` is excluded.
- Non-Earth:
  - Empty query shows `World map` first, then region/continent entries.
  - Typed query can match `World map`, countries, continents, and regions.
  - Choosing any result calls `truesize.add(feature)` instead of Earth fly-to.

Synthetic world feature shape:

```js
{
  id: "world-map",
  name: "World map",
  type: "World",
  searchKind: "region",
  areaKm2,
  anchorLon: 0,
  anchorLat: 0,
  rings: geo.flatMap((f) => f.rings),
}
```

The `anchorLon/anchorLat` fields give the whole-world map a stable center for
rotation/scaling.

---

## 4. True-Scale Projection Model

All Earth geography starts as unit vectors derived from Earth lon/lat rings.

For each selected feature:

1. Compute a feature center in Earth unit-vector space.
2. Scale every vertex's angular distance from that center by:

```js
EARTH_RADIUS_M / target.radius
```

3. Rotate the scaled feature from its base center to the current dropped center.
4. Apply local spin around the current center.
5. Convert the result to target-surface coordinates.

This preserves real Earth physical size on bodies with different radii. It does
not merely reuse Earth degrees.

Earth overlays:

- Use Cesium `Entity.polygon` + `Entity.polyline` in Earth coordinates.
- Height remains small, just enough to avoid z-fighting.

Non-Earth overlays:

- Use body-local coordinates.
- World positions are produced by multiplying local overlay points by the
  focused body's `modelMatrix`.
- Visibility is scoped by `targetKey`, so overlays for another body are hidden
  until that body is focused again.

---

## 5. Non-Earth Rendering

Cesium entity polygons are Earth-ellipsoid oriented. They can fail or render
only outlines when fed arbitrary off-Earth world coordinates. Therefore,
non-Earth overlays use a split rendering strategy:

- Entity polyline: crisp outline and pick/drag target.
- Primitive triangle mesh: translucent colored fill.

The fill mesh:

- Is built in the body-local frame.
- Uses `PerInstanceColorAppearance`.
- Has alpha blending enabled.
- Disables culling so the mesh is visible from the outside.
- Tracks the body's moving `modelMatrix`.
- Hovers above the target surface.

Current hover constants:

```js
OFF_EARTH_HEIGHT_FACTOR = 0.006
OFF_EARTH_MIN_HEIGHT = 12000
```

The actual hover height is:

```js
max(OFF_EARTH_MIN_HEIGHT, target.radius * OFF_EARTH_HEIGHT_FACTOR)
```

This avoids z-fighting and reduces visual clipping where large fills would cut
through the body surface.

The fill mesh should not use one huge flat fan for large polygons. Large
triangles are tessellated and each generated point is normalized back to the
raised target radius, so the fill curves around the body rather than spanning
flat chords through it.

---

## 6. Drag, Spin, Remove

Interaction parity with Earth is required.

- Left-drag moves the overlay over the focused body.
- Scroll while dragging spins the overlay around its own center.
- Shift+scroll spins the overlay under the cursor.
- Right-click removes the overlay.

Implementation notes:

- `_groundUnit(pos, target)` must use `target.layer.pickSurface(pos)` for
  non-Earth targets.
- Drag math should remain unit-vector based.
- Removing an overlay must remove both the entity outline and the off-Earth
  fill primitive.

---

## 7. Data Loading

Country outlines are shared by:

- Search.
- True-size compare.
- Heatmap country modes.

Primary source:

- `GEOJSON_URL` from `js/country-data.js`
  (`johan/world.geo.json` on GitHub).

Fallback:

- `data/admin1-population.latest.geojson`

Why this fallback exists:

- If the remote country GeoJSON is slow/blocked, the search bar can get stuck
  on `Loading places...`.
- True-size click selection on Earth also fails if country boundaries never
  load.

Required loader behavior:

- Remote country GeoJSON fetch should timeout quickly.
- On timeout/failure, build approximate country features by grouping bundled
  admin-1 features by `iso3`.
- If both sources fail, search must display a visible failure message instead
  of staying on `Loading places...`.

Fallback limitations:

- Admin-1 grouped countries are more detailed/heavier.
- Rings are grouped, not dissolved, so internal administrative borders may
  exist as extra rings. This is acceptable as a fallback for search and
  comparison.

---

## 8. Known Pitfalls

### Entity polygon fills off Earth

Symptom: outlines render, fills do not.

Cause: `Entity.polygon` expects Earth-style polygon semantics and can fail on
off-Earth arbitrary world coordinates.

Decision: keep entity polylines for outline/picking, and use a primitive mesh
for non-Earth fill.

### Flat fill meshes

Symptom: a country/continent appears to slice into the Moon/planet instead of
wrapping over it.

Cause: a large triangle fan uses straight Cartesian chords between vertices.

Decision: tessellate fill triangles and normalize generated points to the
raised target radius.

### World map on Earth

Symptom: Earth search shows `World map`, which is redundant and confusing.

Decision: exclude `World map` while `truesize.isEarthTarget()` is true.

### Mode confusion

Symptom: non-Earth body surface clicks spawn maps when the user expected wiki
surface behavior.

Decision: non-Earth spawning happens through search only. The Earth checkbox is
not part of non-Earth spawning behavior.

---

## 9. Verification Checklist

Earth:

- Search for `china`; results load.
- Enable `True-size compare`; click China on Earth; overlay appears.
- Search menu does not include `World map`.
- Drag, spin, right-click remove still work.

Non-Earth:

- Focus Moon/Mars/another body.
- Search placeholder mentions `world map`.
- Empty search shows `World map` with continent/region entries.
- Search for `china`; selecting it spawns China on the body.
- Search for `world`; selecting `World map` spawns the full Earth map.
- Spawned overlays are filled with translucent color, not just outlined.
- Fills hover above the surface and do not visibly sink into the body.
- Drag/spin/remove work.
- Bare surface clicks still open body wiki articles when wiki is enabled.

Data fallback:

- With remote country GeoJSON blocked or slow, search should recover after the
  timeout using bundled admin-1 fallback data.
- If both sources fail, search shows a visible failure message.

Suggested syntax checks:

```powershell
node --check js/country-geo.js
node --check js/search.js
node --check js/app.js
node --check js/layers/truesize.js
```

---

## 10. Future Improvements

- Add a small search result group header for `World map` vs continents vs
  countries.
- Add a subtle altitude/hover setting if users want overlays closer/farther
  from a body's surface.
- Consider a color mode where the whole world map uses continent-specific
  colors rather than a single overlay color.
- Cache the built world-map feature once per country dataset load.
- If performance degrades with the admin-1 fallback, create a bundled
  simplified country GeoJSON file instead of deriving countries from admin-1 at
  runtime.
