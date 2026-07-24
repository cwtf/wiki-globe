# Black Hole Simulator — plan / spec

Status: **PLANNED — nothing implemented yet.**

A scientifically accurate interactive black hole, reachable from the body
dropdown (new group below "Pluto system") and from `wikiglo.be/blackhole`.
The user can drop a test object on a chosen orbital trajectory and watch it
from a free-orbiting 3rd-person camera or ride along in a 1st-person view
with full free-look, all the way through the horizon. Spacetime curvature is
visible through real gravitational lensing (plus an optional embedding-grid
visualization aid).

This is **not** a Cesium layer. Cesium cannot bend light; the simulator is a
separate full-screen WebGL2 ray tracer that takes over the viewport while
focused, behind the same sidebar/dropdown chrome as every other body.

---

## 1. Physics model (what "scientifically accurate" means here)

### 1.1 Metric

- **v1: Schwarzschild** (non-rotating, uncharged). All internal math in
  geometric units `G = c = M = 1`, so `r_s = 2`. Everything scales with the
  mass preset only when converting to display units (km, seconds, K).
- Integrate in **Gullstrand–Painlevé (rain) coordinates**, not Schwarzschild
  coordinates. GP coordinates are regular at the horizon, which is the only
  way the 1st-person camera can cross `r_s` without the integrator blowing up
  on the coordinate singularity. (Schwarzschild `t` diverges at the horizon;
  GP time is the proper time of radially infalling observers. See Hamilton &
  Lisle, "The river model of black holes", Am. J. Phys. 76 (2008).)
- **Stretch (v2): Kerr** with a spin slider. Everything below is written so
  the metric is swappable (the shader gets metric functions, the CPU
  integrator gets a right-hand side), but v1 ships Schwarzschild only.

### 1.2 Light — backward ray tracing of null geodesics

Per pixel: build the ray's initial 4-momentum in the camera's local frame,
transform to global coordinates, integrate the null geodesic **backwards**
until it either

1. crosses the horizon → black (the shadow),
2. crosses the equatorial plane inside the disk annulus → shade as disk, or
3. escapes past `r_out` (~30 r_s) → sample the lensed starfield skybox.

Integrator: RK4 with adaptive step ∝ r (small steps near the photon sphere,
large far away), fixed max iteration count for GLSL loop limits.
Optimization: rays whose impact parameter is ≫ `b_crit` skip integration and
use the analytic weak-field deflection `α ≈ 2 r_s / b` — this covers most of
the screen and is the main perf lever.

What must emerge from the integration (these are the verification targets,
never painted on):

- **Shadow** of apparent radius `b_crit = 3√3 GM/c² ≈ 2.598 r_s`.
- **Photon ring** at the shadow edge (light orbiting near `r = 1.5 r_s`).
- **Einstein ring** lensing of the background starfield; secondary images.
- The far side of the accretion disk lensed into arcs **above and below**
  the shadow (the "Interstellar" look — which is physics, not styling).

### 1.3 Accretion disk

Thin, equatorial, geometrically flat annulus from the **ISCO (`r = 3 r_s`)**
to `~12 r_s`:

- Emitters on circular Keplerian orbits, `Ω = √(M/r³)`.
- Per intersection compute the total shift factor `g = ν_obs/ν_emit`
  (gravitational redshift × orbital Doppler for the actual ray direction).
- Apply **relativistic beaming** via Liouville invariance `I_ν/ν³`:
  observed intensity scaled by `g⁴` (bolometric) — the approaching side is
  visibly brighter/bluer, the receding side dimmer/redder. Non-negotiable
  for accuracy; the asymmetric disk is the signature of a real render.
- Temperature profile `T(r) ∝ r^(−3/4)` (Shakura–Sunyaev shape, normalized
  per mass preset — smaller holes have hotter disks), mapped through a
  blackbody→sRGB table, then shifted by `g` before color mapping.
- Disk toggle in the sidebar (off = bare lensed starfield, the cleanest view
  of pure lensing).

### 1.4 Relativistic jets

Bipolar jets along the disk axis, with the honesty caveat stated up front:
real jet **launching** (Blandford–Znajek) requires spin and magnetic flux —
neither exists in a Schwarzschild v1. So v1 does not simulate the launch
mechanism; it renders a **parameterized kinematic jet** — a conical outflow
(half-opening angle ~5–10°, bulk Lorentz factor Γ ≈ 5–10, emissivity
falling as ~r⁻²) — whose light is traced through the **same null geodesics
and shift factors as everything else**. That is enough for the observable
physics to emerge rather than be painted on:

- **Doppler one-sidedness**: the approaching jet is boosted by the same
  `g⁴` beaming as the disk; the counter-jet is suppressed by the ratio
  `[(1+β cosθ)/(1−β cosθ)]^(3−α)` — at Γ ≈ 5 viewed near the axis the
  counter-jet is effectively invisible, exactly as in real VLBI images.
  Which side is bright flips as the camera orbits across the equatorial
  plane (a verification check).
- **Apparent superluminal motion**: optional slow-drifting emission knots
  in the jet show `β_app = β sinθ/(1−β cosθ) > 1` at small viewing angles —
  the HUD can display the apparent knot speed.
- **Lensing of the jet base**: the counter-jet's base is visible *around*
  the shadow via strongly bent rays, another effect that falls out of the
  shared geodesic tracing.

Sidebar toggle, with mass-preset-aware defaults matching reality: **on for
M87\*** (the archetypal jetted black hole), **off for Sgr A\*** (no
prominent jet) and the stellar preset — the user can override either way.
When Kerr lands in v2 the kinematic model's axis and energetics tie to the
spin parameter; until then the UI labels the jet "kinematic model".

### 1.5 Test object — timelike geodesic

- Integrated **on the CPU in JS** (RK4/RK45, `js/blackhole/geodesics.js`),
  parameterized by **proper time τ**, in GP coordinates so it crosses the
  horizon smoothly and continues to near the singularity.
- User sets the drop: initial radius `r₀`, speed (fraction of the local
  circular-orbit speed or of c), and direction angle in a chosen orbital
  plane; plus presets that demonstrate the physics:
  - stable circular orbit (`r > 3 r_s`),
  - ISCO knife-edge orbit,
  - eccentric orbit → visible **periapsis precession** (checked against the
    analytic `δφ = 6πGM/(c²a(1−e²))` per orbit),
  - unstable plunge / radial free fall.
- Conserved `E` and `L` are computed from the drop parameters and monitored
  each frame as an integration-drift check (log if drift > 1e-6).
- HUD shows: `r` in r_s and km, local velocity, **two clocks — object proper
  time τ and far-away coordinate time t** — and tidal acceleration
  (spaghettification readout, mass-dependent: lethal outside the horizon for
  the stellar preset, gentle at Sgr A* scale).

### 1.6 The two views — and why they must disagree

This disagreement **is** the physics and drives the implementation split:

- **3rd person** (distant observer): a **free-orbit camera identical in
  feel to every planet** (interaction-parity principle, CLAUDE.md #3):
  drag to orbit to any inclination and azimuth, wheel to zoom (clamped
  between ~3 r_s and ~150 r_s), inertia, and the global auto-rotate toggle
  honored. This camera is the **default view the moment the black hole is
  focused** — it does not require a dropped object — and orbiting it is
  itself a physics demo: the disk goes from face-on ring to the
  edge-on Interstellar arcs, and the bright jet side flips, purely from
  camera inclination. When an object has been dropped, the worldline is
  sampled by **coordinate time t**: the object asymptotically slows,
  freezes at the horizon, and redshifts/fades to black — it is never seen
  to cross. Its rendered color is dimmed and reddened by the
  emitted→observed `g` factor.
  - v1 draws the object marker + trail at its true coordinates (trail =
    polyline in the shader pass or a 2D overlay projection).
  - Stretch: render the object's lensed primary/secondary images by solving
    the point-source lens equation instead of drawing at the true position.
- **1st person** (riding the object): advance by **proper time τ**; the
  horizon is crossed in finite τ and nothing locally special happens there.
  Camera rays are generated in the object's **local orthonormal tetrad**
  (static-observer frame boosted by the object's 4-velocity). Free-look is a
  quaternion applied inside the tetrad before the boost. Doing it this way
  makes the correct effects fall out with no per-effect hacks:
  - **relativistic aberration** (sky compresses toward the direction of
    motion at high speed),
  - **Doppler + gravitational shift** of starfield and disk per ray
    (color-shift skybox samples by `g`),
  - gravitational lensing growing to dominate the whole sky,
  - inside the horizon: the outside universe confined to a shrinking bright
    disk, still visible — free-look keeps working to the end.
  - End the run at `r ≈ 0.02 r_s` with a fade + "reached the singularity"
    card and the final τ (Schwarzschild interior gives finite remaining
    proper time ≤ πGM/c³ from horizon crossing — display it).

### 1.7 Visible spacetime warping

- Primary: the lensing itself (starfield distortion, Einstein ring, disk
  arcs) — that is the physically honest warp.
- Secondary, toggleable **"curvature grid" aid**: a Flamm-paraboloid-style
  embedding grid rendered beneath the equatorial plane, explicitly labeled
  as a visualization aid in the UI (it is an embedding of spatial curvature,
  not something an observer would see).

### 1.8 Mass presets

`10 M☉` (stellar), `Sgr A*` (4.15×10⁶ M☉), `M87*` (6.5×10⁹ M☉).
Geometric-unit rendering is mass-invariant, so presets only change display
conversions: physical scale readouts, orbital timescales, disk temperature
normalization, tidal readout.

### 1.9 Fall-speed control

A **log-scaled speed slider from 10⁻⁵× to 10⁶×** (plus a pause button). It
scales how fast the simulation clock advances against wall-clock time — in
1st person that's the object's proper time τ, in 3rd person coordinate
time t — and never touches the physics: the worldline is identical at
every speed, only the playback rate changes.

- **1× is truthfully real time** (1 s of τ or t per wall-clock second) and
  gets a labeled snap detent on the slider ("1× real time").
- **Default = "comfort speed"**, defined physically per mass preset as the
  speed at which one ISCO orbital period plays in ~30 wall-clock seconds:
  `s_comfort = T_ISCO / 30 s`, where `T_ISCO = 2π √(r³/GM)|_{r=6GM/c²}
  ≈ 92.3 GM/c³`. It gets its own labeled snap detent ("comfort") and is
  recomputed when the mass preset changes. Concretely:
  - 10 M☉: `T_ISCO ≈ 4.5 ms` → comfort ≈ **1.5×10⁻⁴×** (slow motion —
    real time is a literally invisible blur at stellar mass),
  - Sgr A*: `T_ISCO ≈ 31 min` → comfort ≈ **60×**,
  - M87*: `T_ISCO ≈ 34 days` → comfort ≈ **10⁵×**.

  That spread — slow-motion for stellar, ~10⁵× for M87* — is exactly why
  the range must run 10⁻⁵× to 10⁶× rather than a fixed 0.1×–10× band, and
  why "comfortable" cannot be a single constant.
- The HUD always shows the current multiplier next to the clocks (§1.5),
  so the user can see at a glance whether they're watching real time,
  slow motion, or a time-lapse — keeping the accuracy framing honest while
  defaulting to something watchable.
- **Pause**: a dedicated pause/resume button next to the slider (plus
  `Space` as a keyboard shortcut, and the HUD multiplier reads "paused").
  Pause freezes the simulation clock only — the object holds its position
  on the worldline while **rendering and both cameras stay fully live**:
  3rd-person orbit/zoom and 1st-person free-look keep working, so the user
  can freeze mid-plunge (including inside the horizon) and look around a
  single frozen moment from any angle. Resume continues from the same
  worldline sample; pause/resume must not re-integrate or shift the
  trajectory.

---

## 2. Integration with the existing app

### 2.1 Entry points

- **Dropdown**: a new `<optgroup label="Black Hole">` with one option
  (`value="blackhole"`), appended after the groups from
  `BODY_CHOICE_GROUPS` in `js/app.js`. It is deliberately **not** added to
  `BODIES`/`BODY_ORDER` in `js/bodies.js` — it has no ephemeris, no
  Wikidata globe QID, no IAU orientation, and would poison every loop that
  assumes those exist. `focusBody()` gets an explicit `"blackhole"` branch
  before the `bodyLayers` lookup.
- **URL `wikiglo.be/blackhole`**: GitHub Pages is static, so add a
  `blackhole/index.html` stub that immediately redirects
  (`<meta http-equiv="refresh">` + JS fallback) to `/?focus=blackhole`.
  At boot, `app.js` reads `?focus=` and focuses that body after init —
  written generically so `?focus=mars` etc. work for free. Add the path to
  `sitemap.xml`.

### 2.2 Mode switch (in/out)

Focusing the black hole:

1. `focusBody("blackhole")` blurs the current body layer (existing path),
   suspends Earth-orbit layers exactly like any off-Earth focus
   (`onBodyFocusChanged` treatment), and sets
   `document.body.dataset.focus = "blackhole"` via `syncScopedUi` so
   `data-scope="blackhole"` sidebar rows appear.
2. Short fade to black (~0.6 s), then: hide the Cesium canvas, **stop the
   Cesium render loop** (`viewer.useDefaultRenderLoop = false`) so the ray
   tracer gets the whole GPU, and show the simulator's own `#bh-canvas`
   (sibling of the Cesium container, `position: fixed`, full viewport).
   No proxy-body flight — the black hole is not at a real solar-system
   location, and pretending otherwise would violate the accuracy framing.
3. Leaving: reverse fade, `useDefaultRenderLoop = true`, restore layers via
   the existing `onBodyFocusChanged(…, false)` path. The back button
   (`moonBack`) works unchanged.

### 2.3 New files

```
js/blackhole/
  blackhole.js    BlackHoleSim — owns canvas/GL context, focus()/blur(),
                  onFocusChanged callback (same contract app.js already
                  relies on for BodyLayer), render loop, mode state
  geodesics.js    GP-coordinate RK4/RK45 for the object worldline; shared
                  constants (r_s, ISCO, b_crit); drop-parameter → (E, L)
  shaders.js      GLSL as template literals (no build step): ray-tracer
                  fragment shader, blackbody LUT, skybox sampling
  ui.js           sidebar bindings (drop panel, view toggle, mass preset,
                  quality, time scale), HUD clocks/readouts
blackhole/index.html   redirect stub for the /blackhole path
assets/starmap.jpg     ESO Milky Way panorama (CC BY 4.0) as equirect skybox
```

- `index.html`: sidebar block with `data-scope="blackhole"` rows (mirroring
  the moon/mars blocks at index.html:477/502); attribution line for the ESO
  starmap in the `.attrib` block, and a README credit (project licensing
  rule).
- `app.js`: `"blackhole"` branch in `focusBody`, dropdown optgroup append,
  `?focus=` boot handling, add the instance to `window.__globe`.

### 2.4 Sidebar controls (all `data-scope="blackhole"`)

- Mass preset select · disk toggle · **jet toggle** (default follows mass
  preset, §1.4) · curvature-grid toggle · starfield toggle
- **Drop panel**: preset select + `r₀` / speed / angle sliders, "Drop" and
  "Reset" buttons
- **View toggle**: 3rd person ⇄ 1st person (1st person enabled only while
  an object is falling). 3rd person is the planet-parity free-orbit camera
  (§1.6): drag to any inclination/azimuth, wheel zoom, inertia,
  auto-rotate honored — available from the moment of focus, no dropped
  object needed. 1st person: drag to free-look; FOV is fixed at a stated
  value, because FOV changes would masquerade as aberration
- **Speed slider 10⁻⁵×–10⁶× (log-scaled)**, snap detents at 1× real time
  and the per-mass comfort speed (the default), plus a **pause/resume
  button** (`Space` shortcut; cameras stay live while paused) (§1.9)
- Quality: resolution scale (0.5 / 0.75 / 1.0) and integration-step budget
  (auto-drop resolution if frame time > 33 ms for 60 consecutive frames)

---

## 3. Milestones

Each lands independently runnable; verify per §4 before moving on.

1. **Scaffolding** — dropdown group, `/blackhole` stub + `?focus=` boot
   param, mode switch with fade, blank WebGL2 canvas rendering a flat-space
   starfield skybox with free-look camera. WebGL2-missing fallback message.
2. **Static lensed render** — geodesic fragment shader: shadow, photon
   ring, lensed starfield, weak-field fast path, quality controls, and the
   planet-parity free-orbit camera (any angle, zoom, auto-rotate).
3. **Accretion disk + jets** — annulus intersection, `g` factor, `g⁴`
   beaming, blackbody colors, disk toggle; kinematic jet cone with
   one-sided beaming, counter-jet lensing, jet toggle with per-preset
   defaults.
4. **Test object, 3rd person** — CPU geodesic integrator, drop panel +
   presets, trail, coordinate-time sampling with horizon freeze + redshift
   fade, HUD readouts, E/L drift check.
5. **1st person** — tetrad camera + aberration in the shader, proper-time
   advance, free-look, dual clocks, horizon crossing, singularity ending.
6. **Polish** — curvature-grid toggle, mass presets + tidal readout,
   speed slider (10⁻⁵×–10⁶×, comfort-speed default, 1× detent) + pause,
   attribution, README section, sitemap, mobile pass.

---

## 4. Verification (no test suite — checked live, per project convention)

Quantitative checks, via `preview_eval` against `window.__globe.blackhole`
(exposing `debugRay(px, py)` and the integrator for console probing):

- Shadow angular radius on screen matches `b_crit = 3√3 M` for the known
  camera distance/FOV (± a pixel).
- A ray at exactly `b_crit` winds ≥ 2π around the hole before escaping.
- Circular-orbit drop at `r = 4 r_s` stays circular for ≥ 20 orbits
  (E/L drift < 1e-6); at `r < 3 r_s` it plunges.
- Eccentric-orbit periapsis precession within 1% of the analytic formula.
- Radial-fall proper time from `r₀` to horizon matches the closed-form
  Schwarzschild result; 3rd-person view of the same drop never shows a
  crossing.
- Disk asymmetry: approaching side brighter (sample pixel luminance both
  sides); disk arcs visible above and below the shadow at near-edge-on
  inclination.
- Free-orbit camera parity: orbiting pole-to-pole morphs the disk from
  face-on ring to edge-on arcs continuously; zoom clamps hold
  (~3–150 r_s); auto-rotate toggle behaves as on planets.
- Jets: counter-jet/jet luminance ratio matches the analytic
  `[(1−β cosθ)/(1+β cosθ)]^(3−α)` for the configured Γ and camera angle
  within a few %; bright side flips when the camera crosses the equatorial
  plane; knot apparent speed matches `β sinθ/(1−β cosθ)` (superluminal at
  small θ).
- Speed slider: the same drop replayed at comfort speed, 1×, and 100×
  produces an identical worldline (compare stored `(τ, r, φ)` samples) —
  only playback rate differs; 1× advances the active clock at wall-clock
  rate ± 1%; comfort default recomputes on mass-preset change so one ISCO
  orbit plays in 30 ± 2 wall-clock seconds on every preset.
- Pause mid-plunge: clocks and object freeze, but free-look/orbit still
  responds while paused; resume continues from the identical worldline
  sample (no position jump, no re-integration).
- Mode-switch round trip (Earth → blackhole → Earth ×3): no WebGL context
  leak, Cesium resumes, layer checkboxes intact.

Known preview gotchas (same as spec doc §10): screenshots time out on
non-idle WebGL — prefer `preview_eval` state probes; rAF pauses in
backgrounded tabs, so pump frames manually if a fall "freezes" in an
inactive tab (that's throttling, not physics).

---

## 5. Pitfalls to design around (write-downs from planning)

- **Never integrate in Schwarzschild coordinates near/inside `r_s`** — GP
  coordinates end-to-end (shader *and* CPU) or the horizon crossing breaks.
- GLSL has no unbounded loops: fixed `MAX_STEPS` with early break; budget is
  the quality setting.
- `float` precision is fine because everything is in geometric units with
  the hole at the origin (radii span ~0.02–1000, no catastrophic scales) —
  do **not** import Cesium's ECEF/meter conventions into the shader.
- 1st-person correctness lives or dies on the tetrad: build it once
  (static frame + boost), generate rays only through it. Ad-hoc per-effect
  "redshift shaders" are how it becomes a toy.
- 3rd person vs 1st person must sample the *same* stored worldline by `t`
  vs `τ` respectively — two integrations would drift apart.
- Keep Cesium fully stopped while focused; two active WebGL contexts
  rendering per-frame will halve mobile framerates and trip context limits.
- Skybox color-shift by `g` needs the starmap sampled in linear light —
  decode sRGB before shifting, re-encode after.
- The embedding grid is an aid, not a claim — label it in the UI, or it
  undermines the "scientifically accurate" framing. Same for the jet: the
  emission is traced through real geodesics, but the launch mechanism is
  not simulated (needs Kerr + MHD) — keep the "kinematic model" label.

## 6. References

- Hamilton & Lisle, *The river model of black holes* (GP coordinates,
  horizon-crossing views), Am. J. Phys. 76, 519 (2008).
- Marck, *Short-cut method of solution of geodesic equations for
  Schwarzschild black hole* (planar null-geodesic reduction).
- Luminet (1979), *Image of a spherical black hole with thin accretion
  disk* — the disk-appearance ground truth.
- James, von Tunzelmann, Franklin & Thorne, *Gravitational lensing by
  spinning black holes in astrophysics, and in the movie Interstellar*,
  Class. Quantum Grav. 32 (2015) — rendering methodology.
- ESO Milky Way panorama (CC BY 4.0) — background starfield asset.
