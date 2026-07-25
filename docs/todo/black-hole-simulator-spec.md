# Black Hole Simulator — plan / spec

Status: **PLANNED — nothing implemented yet.**

A scientifically accurate interactive black hole, reachable from the body
dropdown (new group below "Pluto system") and at `wikiglo.be/blackhole`.
The user can drop a test object on a chosen orbital trajectory and watch it
from a free-orbiting 3rd-person camera or ride along in a 1st-person view
with full free-look, all the way through the horizon. Spacetime curvature is
visible through real gravitational lensing (plus an optional embedding-grid
visualization aid).

This is **not** a Cesium layer, and (revised) it is **not built from
scratch**: it is built on a fork of an existing open-source simulator whose
UI and rendering engine we adopt as the base, with this spec's features
added on top.

---

## 0. Base code: `steeltroops-ai/blackhole-simulation`

**Decision: fork <https://github.com/steeltroops-ai/blackhole-simulation>
(MIT, © 2026 Mayank / steeltroops-ai) and use it as the base app** — its UI
is the look and interaction model we want (live demo:
<https://blackhole-simulation.vercel.app/>). We keep its panels/HUD/canvas
chrome and extend them, rather than building a new WebGL app behind the
wiki-globe sidebar.

### 0.1 What the base already provides (do not rebuild)

- **Stack**: Next.js 14 + React 18 + TypeScript; physics in **Rust compiled
  to WASM** (`physics-engine/gravitas-core` math library +
  `gravitas-wasm` FFI); WebGL 2.0 ray-marching renderer (WebGPU path in
  alpha); Bun for builds (`bun install`, `bun run build:wasm`,
  `bun run dev`).
- **Metric & integration**: numerically regularized **Kerr-Schild metric**
  supporting near-extremal spin (a = 0.999), **RKF45 adaptive
  integration** (f64 in Rust) on the CPU side, Velocity-Verlet on the GPU
  side. Kerr-Schild is horizon-penetrating (regular at the horizon), which
  is exactly the property this spec needs for horizon-crossing cameras —
  it fills the role Gullstrand–Painlevé coordinates played in the
  pre-fork draft of this spec. **All new physics (CPU and shader) stays in
  Kerr-Schild coordinates end-to-end** for consistency with the base.
- **Rendering**: geodesic ray-marching shaders (`src/shaders/`), temporal
  anti-aliasing (variance clipping in YCoCg), bloom, **spectral basis
  rendering** with pre-computed Planckian lookup tables for Doppler +
  gravitational redshift, adaptive quality/dynamic resolution per GPU tier.
- **Architecture**: multi-threaded physics workers (`src/workers/`) with a
  **zero-copy SharedArrayBuffer pipeline** between physics and rendering
  (`src/engine/`); UI in `src/components/` (`canvas`, `ui`, `debug`,
  `fallback`, `spacetime`, `quantum`) with hooks-based state
  (`src/hooks/`), configs in `src/configs/`.
- **UI**: the control-panel/HUD design we are adopting wholesale. New
  controls from this spec (drop panel, view toggle, speed slider, mass
  presets, jet toggle, curvature grid) are added as new components in the
  base's `src/components/ui` style — not as wiki-globe sidebar rows.

### 0.2 Delta: what this spec adds on top of the fork

| Area | Base status | Work |
| --- | --- | --- |
| Kerr metric, spin, lensing, shadow, photon ring | ✅ shipped | verify against §4 targets, expose spin slider if not already |
| Accretion disk + redshift/Doppler/beaming | partial (spectral pipeline exists; audit disk model vs §1.3) | close gaps: ISCO-anchored annulus, `g⁴` beaming, `T ∝ r^(−3/4)` normalization per mass preset, disk toggle |
| Relativistic jets | ❌ | add kinematic jet (§1.4) traced through the existing geodesic kernels |
| Test-object timelike geodesic + drop presets | ❌ | extend `gravitas-core` (Rust) with a timelike RKF45 worldline integrator; expose via `gravitas-wasm`; store worldline in the SAB pipeline (§1.5) |
| 3rd-person coordinate-time view / 1st-person proper-time tetrad view | ❌ (base has a free camera; no dual-clock split) | add both views + view toggle (§1.6) |
| Mass presets & display units (km, s, K, tidal readout) | ❌ (dimensionless) | add (§1.8) |
| Fall-speed slider + pause | ❌ | add (§1.9) |
| Curvature-grid embedding aid | possibly partial (`components/spacetime`) | audit; add toggle + "visualization aid" label (§1.7) |
| Starfield skybox (ESO panorama) | audit what base uses | ensure a licensed equirect starmap with attribution |
| wiki-globe integration + static deployment | ❌ | §2 |

### 0.3 Licensing / attribution

MIT base: keep the upstream `LICENSE` and copyright notice in the fork; add
a credit line ("Black hole simulator based on *blackhole-simulation* by
steeltroops-ai, MIT") to the simulator's own about/credits UI **and** to
wiki-globe's README + sidebar `.attrib` block (project licensing rule #4).
Same for the starfield asset (ESO Milky Way panorama, CC BY 4.0) if we
carry it over.

---

## 1. Physics model (what "scientifically accurate" means here)

### 1.1 Metric

- **v1: Kerr (from the base), in Kerr-Schild coordinates.** The base ships
  a regularized Kerr-Schild implementation at near-extremal spin, so —
  reversing the pre-fork plan — **spin is a v1 feature, not a stretch
  goal**: expose a spin slider `a ∈ [0, 0.999]`. Schwarzschild is the
  `a = 0` case and is what the analytic verification targets in §4 check
  against (ISCO = 3 r_s, `b_crit = 3√3 M`, the precession formula).
- All internal math in geometric units `G = c = M = 1`, so `r_s = 2` at
  `a = 0`. Everything scales with the mass preset only when converting to
  display units (km, seconds, K).
- Kerr-Schild is regular at the horizon — the reason the pre-fork spec
  demanded Gullstrand–Painlevé coordinates. GP is no longer used anywhere;
  do not mix coordinate systems between the shader and the Rust integrator.

### 1.2 Light — backward ray tracing of null geodesics

The base's ray-marching kernels already do this. Requirements to verify
(and patch in the fork if missing) — per pixel: build the ray's initial
4-momentum in the camera's local frame, transform to global coordinates,
integrate the null geodesic **backwards** until it either

1. crosses the horizon → black (the shadow),
2. crosses the equatorial plane inside the disk annulus → shade as disk, or
3. escapes past `r_out` (~30 r_s) → sample the lensed starfield skybox.

Integration budget: fixed max iteration count for GLSL loop limits, with
the base's adaptive-quality system as the lever. Optimization worth
porting into the fork if absent: rays whose impact parameter is ≫ `b_crit`
skip integration and use the analytic weak-field deflection
`α ≈ 2 r_s / b` — this covers most of the screen.

What must emerge from the integration (verification targets, never painted
on):

- **Shadow** of apparent radius `b_crit = 3√3 GM/c² ≈ 2.598 r_s` at
  `a = 0` (spin-deformed at high `a`).
- **Photon ring** at the shadow edge (light orbiting near `r = 1.5 r_s`
  at `a = 0`).
- **Einstein ring** lensing of the background starfield; secondary images.
- The far side of the accretion disk lensed into arcs **above and below**
  the shadow (the "Interstellar" look — which is physics, not styling).

### 1.3 Accretion disk

Thin, equatorial, geometrically flat annulus from the **ISCO** (spin-
dependent; `r = 3 r_s` at `a = 0`) to `~12 r_s`. Audit the base's disk
against this list and close gaps in the fork:

- Emitters on circular Keplerian orbits, `Ω = √(M/r³)` (Kerr-corrected
  where the base's metric functions provide it).
- Per intersection compute the total shift factor `g = ν_obs/ν_emit`
  (gravitational redshift × orbital Doppler for the actual ray direction).
  The base's spectral/Planckian LUT pipeline is the implementation vehicle.
- Apply **relativistic beaming** via Liouville invariance `I_ν/ν³`:
  observed intensity scaled by `g⁴` (bolometric) — the approaching side is
  visibly brighter/bluer, the receding side dimmer/redder. Non-negotiable
  for accuracy; the asymmetric disk is the signature of a real render.
- Temperature profile `T(r) ∝ r^(−3/4)` (Shakura–Sunyaev shape, normalized
  per mass preset — smaller holes have hotter disks), mapped through the
  base's blackbody tables, then shifted by `g` before color mapping.
- Disk toggle in the control panel (off = bare lensed starfield, the
  cleanest view of pure lensing).

### 1.4 Relativistic jets

Bipolar jets along the spin axis. With Kerr in v1 the axis and energetics
tie to the spin parameter, but the honesty caveat still holds: real jet
**launching** (Blandford–Znajek) needs magnetized MHD, which we do not
simulate. So the fork renders a **parameterized kinematic jet** — a
conical outflow (half-opening angle ~5–10°, bulk Lorentz factor Γ ≈ 5–10,
emissivity falling as ~r⁻²) — whose light is traced through the **same
geodesic kernels and shift factors as everything else**. That is enough
for the observable physics to emerge rather than be painted on:

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

Control-panel toggle, with mass-preset-aware defaults matching reality:
**on for M87\*** (the archetypal jetted black hole), **off for Sgr A\***
(no prominent jet) and the stellar preset — the user can override either
way. The UI labels the jet "kinematic model".

### 1.5 Test object — timelike geodesic

- Integrated in **Rust inside `gravitas-core`** (new timelike RKF45
  right-hand side alongside the existing null one), exposed through
  `gravitas-wasm`, running in the base's physics worker with the worldline
  samples published through the existing SharedArrayBuffer pipeline —
  **not** a separate JS integrator. Parameterized by **proper time τ**, in
  Kerr-Schild coordinates so it crosses the horizon smoothly and continues
  to near the singularity.
- User sets the drop: initial radius `r₀`, speed (fraction of the local
  circular-orbit speed or of c), and direction angle in a chosen orbital
  plane; plus presets that demonstrate the physics:
  - stable circular orbit (`r > 3 r_s` at `a = 0`),
  - ISCO knife-edge orbit,
  - eccentric orbit → visible **periapsis precession** (checked at `a = 0`
    against the analytic `δφ = 6πGM/(c²a(1−e²))` per orbit),
  - unstable plunge / radial free fall.
- Conserved `E` and `L` are computed from the drop parameters and monitored
  each frame as an integration-drift check (log if drift > 1e-6).
- HUD shows: `r` in r_s and km, local velocity, **two clocks — object proper
  time τ and far-away coordinate time t** — and tidal acceleration
  (spaghettification readout, mass-dependent: lethal outside the horizon for
  the stellar preset, gentle at Sgr A* scale). Implement as an extension of
  the base's HUD/debug components.

### 1.6 The two views — and why they must disagree

This disagreement **is** the physics and drives the implementation split:

- **3rd person** (distant observer): the base's free camera, constrained to
  a **free-orbit feel**: drag to orbit to any inclination and azimuth,
  wheel to zoom (clamped between ~3 r_s and ~150 r_s), inertia, optional
  auto-rotate. This is the **default view on load** — it does not require
  a dropped object — and orbiting it is itself a physics demo: the disk
  goes from face-on ring to the edge-on Interstellar arcs, and the bright
  jet side flips, purely from camera inclination. When an object has been
  dropped, the worldline is sampled by **coordinate time t**: the object
  asymptotically slows, freezes at the horizon, and redshifts/fades to
  black — it is never seen to cross. Its rendered color is dimmed and
  reddened by the emitted→observed `g` factor.
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
    (color-shift skybox samples by `g`, through the base's spectral LUTs),
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
  not something an observer would see). Audit `src/components/spacetime` —
  the base may already have a metric-field visualization to adapt.

### 1.8 Mass presets

`10 M☉` (stellar), `Sgr A*` (4.15×10⁶ M☉), `M87*` (6.5×10⁹ M☉).
Geometric-unit rendering is mass-invariant, so presets only change display
conversions: physical scale readouts, orbital timescales, disk temperature
normalization, tidal readout. The base is dimensionless — this whole layer
(preset select + unit conversion module) is new.

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

## 2. Integration with wiki-globe (revised for the fork)

The base app is a built, multi-threaded Next.js application — it cannot be
loaded as an ES module inside the Cesium page, and its SharedArrayBuffer
pipeline requires cross-origin isolation (COOP/COEP), which also rules out
casually iframing it. So the pre-fork "swap the canvas behind the same
sidebar" design is **dropped**. The simulator is a **separate sub-app at
`/blackhole/`** with its own (base-project) UI, and the globe hands off to
it by navigation.

### 2.1 Repo & deployment layout

- Vendor the fork in-repo under **`blackhole-sim/`** (its own
  `package.json`, `physics-engine/`, `src/` — untouched wiki-globe rule:
  the globe itself stays build-free; the build step is scoped entirely to
  this subdirectory).
- Configure the fork for **static export**: `output: 'export'` +
  `basePath: '/blackhole'` in `next.config.mjs`. The base does not
  currently use static export (it's a standard server build with header
  config) — verify nothing depends on server features; the physics is all
  client-side, so this should be config-only.
- **GitHub Pages cannot set COOP/COEP response headers**, which
  SharedArrayBuffer requires. Two-pronged fix, both in the fork:
  1. ship `coi-serviceworker` (the standard client-side COOP/COEP shim)
     with the exported app, and
  2. require a **non-SAB fallback path** (postMessage/transferables or
     single-threaded) so the first load — before the service worker
     controls the page — and browsers without SAB still work. Audit
     whether the base already falls back (`src/components/fallback`
     suggests partial coverage); if not, add it.
- **CI**: a GitHub Actions workflow builds the sub-app (Rust toolchain +
  wasm-pack + Bun, `bun run build:wasm && bun run build`) and deploys the
  Pages artifact as: repo root (globe, verbatim, no build) + the exported
  sub-app under `/blackhole/`. The globe remains previewable locally with
  a bare static server exactly as before; the sub-app runs locally with
  `bun run dev` in `blackhole-sim/`.
- Alternative (fallback if vendoring bloats the repo or CI): keep the fork
  as a separate repo with its own Pages/Vercel deployment and point
  `wikiglo.be/blackhole` → redirect stub. Primary plan is vendored + CI,
  which keeps one repo and one domain.

### 2.2 Entry points

- **Dropdown**: a new `<optgroup label="Black Hole">` with one option
  (`value="blackhole"`), appended after the groups from
  `BODY_CHOICE_GROUPS` in `js/app.js`. It is deliberately **not** added to
  `BODIES`/`BODY_ORDER` in `js/bodies.js` — it has no ephemeris, no
  Wikidata globe QID, no IAU orientation, and would poison every loop that
  assumes those exist. Selecting it does **not** call `focusBody()`; it
  navigates: `location.href = '/blackhole/'`. (Restore the dropdown to the
  previously focused body first, so the globe is in a sane state if the
  user navigates back via browser history.)
- **URL `wikiglo.be/blackhole`** is now the sub-app itself, not a redirect
  stub. For symmetry, `app.js` still gains generic `?focus=` boot handling
  (`?focus=mars` etc. work for free; `?focus=blackhole` redirects to
  `/blackhole/`). Add `/blackhole/` to `sitemap.xml`.
- **Back to the globe**: the sub-app gets a small persistent "← Wiki
  Globe" control (styled in the base UI's own idiom, top-left, matching
  where the globe's back button lives) linking to `/`. Browser back also
  works — it's a plain navigation.

### 2.3 What is *not* needed anymore (deleted from the pre-fork plan)

- No `js/blackhole/` module tree, no hand-rolled `shaders.js` /
  `geodesics.js` — superseded by the fork's `src/shaders/` and
  `gravitas-core`.
- No Cesium render-loop suspension, fade-out canvas swap, or
  `data-scope="blackhole"` sidebar rows — the two apps never share a page
  or a WebGL context.
- No `blackhole/index.html` redirect stub — the exported app owns the path.

### 2.4 Simulator controls (in the fork's own UI, not the globe sidebar)

Extend the base's control panels with:

- Mass preset select (§1.8) · spin slider `a` · disk toggle · **jet
  toggle** (default follows mass preset, §1.4) · curvature-grid toggle ·
  starfield toggle
- **Drop panel**: preset select + `r₀` / speed / angle sliders, "Drop" and
  "Reset" buttons
- **View toggle**: 3rd person ⇄ 1st person (1st person enabled only while
  an object is falling). 3rd person is the free-orbit camera (§1.6),
  available from load, no dropped object needed. 1st person: drag to
  free-look; FOV is fixed at a stated value, because FOV changes would
  masquerade as aberration.
- **Speed slider 10⁻⁵×–10⁶× (log-scaled)**, snap detents at 1× real time
  and the per-mass comfort speed (the default), plus a **pause/resume
  button** (`Space` shortcut; cameras stay live while paused) (§1.9)
- Quality: keep the base's adaptive-quality system as-is; surface its
  resolution scale / step budget in the panel if it doesn't already.

Follow the base's component conventions (TypeScript, `src/components/ui`,
hooks for state) — the fork should still look and feel like the upstream
app, only with more physics.

---

## 3. Milestones

Each lands independently runnable; verify per §4 before moving on.

1. **Fork & deploy** — vendor the fork under `blackhole-sim/`, get it
   building locally (Bun + wasm-pack), switch to static export with
   `basePath: '/blackhole'`, add `coi-serviceworker` + verify (or add) the
   non-SAB fallback, stand up the CI Pages workflow, and wire the
   dropdown/`?focus=` navigation + "← Wiki Globe" back link. Ship the
   *unmodified* simulator at `wikiglo.be/blackhole` before touching
   physics.
2. **Audit & baseline** — run the §4 lensing/shadow checks against the
   stock fork at `a = 0`; document what the base's disk/redshift pipeline
   already satisfies from §1.3 and patch the gaps (`g⁴` beaming,
   ISCO-anchored annulus, disk toggle). Expose `window.__bh` debug hooks
   (`debugRay(px, py)`, integrator access) for the verification workflow.
3. **Accretion-disk gaps + jets** — finish §1.3; kinematic jet cone with
   one-sided beaming, counter-jet lensing, jet toggle with per-preset
   defaults.
4. **Test object, 3rd person** — timelike integrator in `gravitas-core` +
   WASM FFI + worker/SAB plumbing, drop panel + presets, trail,
   coordinate-time sampling with horizon freeze + redshift fade, HUD
   readouts, E/L drift check.
5. **1st person** — tetrad camera + aberration in the shader, proper-time
   advance, free-look, dual clocks, horizon crossing, singularity ending.
6. **Polish** — curvature-grid toggle, mass presets + tidal readout,
   speed slider (10⁻⁵×–10⁶×, comfort-speed default, 1× detent) + pause,
   attribution (upstream MIT credit + starmap), README section, sitemap,
   mobile pass.

---

## 4. Verification (no wiki-globe test suite — but use the fork's)

The base has `src/__tests__` — new Rust/TS logic (integrator RHS, unit
conversions, comfort-speed math) gets tests there and runs in the sub-app's
CI. Rendering/behavioral checks stay live-in-browser, via `preview_eval`
against the sub-app's exposed `window.__bh` debug hooks (milestone 2).
Quantitative targets (analytic values are the `a = 0` cases):

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
- Free-orbit camera: orbiting pole-to-pole morphs the disk from face-on
  ring to edge-on arcs continuously; zoom clamps hold (~3–150 r_s).
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
- Deployment: `wikiglo.be/blackhole` loads cross-origin-isolated
  (`self.crossOriginIsolated === true` once the service worker controls
  the page) *and* renders correctly on the very first uncontrolled load
  via the non-SAB fallback; globe → simulator → back navigation is clean
  in both directions.

Known preview gotchas (same as the solar-system spec §10): screenshots
time out on non-idle WebGL — prefer `preview_eval` state probes; rAF
pauses in backgrounded tabs, so pump frames manually if a fall "freezes"
in an inactive tab (that's throttling, not physics).

---

## 5. Pitfalls to design around (write-downs from planning)

- **Stay in Kerr-Schild coordinates end-to-end** (shader *and* Rust
  integrator) — they are horizon-regular; mixing in Schwarzschild or
  Boyer-Lindquist coordinates near/inside the horizon breaks the crossing.
- **SharedArrayBuffer needs COOP/COEP, and GitHub Pages can't set
  headers** — the `coi-serviceworker` shim only takes effect after first
  load, so the non-SAB fallback path is a hard requirement, not a
  nice-to-have (§2.1).
- Static export changes behavior vs the base's dev server (its
  `next.config.mjs` header config stops applying) — test the exported
  build, not just `bun run dev`.
- **Keep the fork mergeable**: prefer additive components/modules over
  editing upstream files in place, and record any upstream file we must
  modify in the fork's README, so pulling upstream fixes stays feasible.
- The build step is scoped to `blackhole-sim/` only — nothing in the
  globe's `js/` may ever import from it or acquire a build dependency.
- GLSL has no unbounded loops: fixed `MAX_STEPS` with early break; the
  base's adaptive-quality budget is the knob.
- `float` precision is fine because everything is in geometric units with
  the hole at the origin (radii span ~0.02–1000, no catastrophic scales) —
  do **not** import Cesium's ECEF/meter conventions into the fork.
- 1st-person correctness lives or dies on the tetrad: build it once
  (static frame + boost), generate rays only through it. Ad-hoc per-effect
  "redshift shaders" are how it becomes a toy.
- 3rd person vs 1st person must sample the *same* stored worldline by `t`
  vs `τ` respectively — two integrations would drift apart.
- Skybox color-shift by `g` needs the starmap sampled in linear light —
  decode sRGB before shifting, re-encode after (route through the base's
  spectral pipeline rather than a per-effect hack).
- The embedding grid is an aid, not a claim — label it in the UI, or it
  undermines the "scientifically accurate" framing. Same for the jet: the
  emission is traced through real geodesics, but the launch mechanism is
  not simulated (no MHD) — keep the "kinematic model" label.

## 6. References

- Base project: steeltroops-ai, *blackhole-simulation* (MIT) —
  <https://github.com/steeltroops-ai/blackhole-simulation>, live demo
  <https://blackhole-simulation.vercel.app/>.
- Hamilton & Lisle, *The river model of black holes* (horizon-penetrating
  coordinates, horizon-crossing views), Am. J. Phys. 76, 519 (2008).
- Marck, *Short-cut method of solution of geodesic equations for
  Schwarzschild black hole* (planar null-geodesic reduction).
- Luminet (1979), *Image of a spherical black hole with thin accretion
  disk* — the disk-appearance ground truth.
- James, von Tunzelmann, Franklin & Thorne, *Gravitational lensing by
  spinning black holes in astrophysics, and in the movie Interstellar*,
  Class. Quantum Grav. 32 (2015) — rendering methodology.
- ESO Milky Way panorama (CC BY 4.0) — background starfield asset.
