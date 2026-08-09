# Fork notes

This directory is a vendored fork of
**[steeltroops-ai/blackhole-simulation](https://github.com/steeltroops-ai/blackhole-simulation)**
(MIT, © Mayank Pratap Singh), adopted as the base app for wiki-globe's black
hole simulator per `docs/todo/black-hole-simulator-spec.md`.

- Upstream commit: `459c15a9750142a230c07bd1979456053380cc47` (`main`, 2026-04-30)
- Upstream licence: MIT — `LICENSE` is kept verbatim and must stay that way.

The spec calls for keeping this mergeable with upstream: **prefer additive
files over editing upstream ones**, and record every upstream file that has to
change here.

## Deployment shape

Upstream is a Vercel server build at its own domain. Here it is a **statically
exported sub-app mounted at `/blackhole/`** on `wikiglo.be`, published by
`.github/workflows/pages.yml` at the repository root alongside the (build-free)
Cesium globe.

Consequences:

- `output: "export"` — no server, so `next.config.mjs`'s `headers()` no longer
  applies at runtime and `next/image` optimisation is off.
- `basePath: "/blackhole"` — Next rewrites URLs it owns (`_next/*`, worker
  chunks, `next/image` sources, metadata routes). It does **not** rewrite plain
  string literals. Any `/foo.png`, `fetch("/…")` or texture URL added later must
  go through `asset()` / `BASE_PATH` in `src/configs/deployment.config.ts`.
- Local dev keeps upstream behaviour (real server, real COOP/COEP headers) and
  serves at <http://localhost:3000/blackhole>.

## Cross-origin isolation (COI)

`SharedArrayBuffer` — the zero-copy physics/render pipeline — requires a
cross-origin isolated document, which requires COOP/COEP response headers,
which **GitHub Pages cannot send**. Two-part answer, both required:

1. `public/coi-serviceworker.js` synthesises the headers for everything under
   `/blackhole/`, registered by `src/components/fork/CrossOriginIsolation.tsx`.
   A service worker cannot control the page it was registered from, so the shim
   only takes effect from the **next** navigation onward; the component reloads
   once, guarded by a `sessionStorage` flag so a browser that refuses isolation
   cannot loop.
2. The **non-SAB fallback is therefore load-bearing, not a nicety**: the first
   load of every session runs single-threaded. `PhysicsBridge` already had this
   path (the `new SharedArrayBuffer(...)` throw is caught and main-thread WASM
   is loaded instead); this fork hardens it — see the table below.

Check which path is live: `window.__bh.transport()` →
`"worker-sab"` | `"main-thread"`, and `self.crossOriginIsolated`.

## Files added by this fork (safe on merge)

| Path | Purpose |
| --- | --- |
| `FORK.md` | this file |
| `public/coi-serviceworker.js` | COOP/COEP shim for GitHub Pages |
| `src/configs/deployment.config.ts` | `BASE_PATH`, `SITE_URL`, `asset()` |
| `src/components/fork/CrossOriginIsolation.tsx` | registers the shim |
| `src/components/fork/BackToGlobe.tsx` | persistent "← Wiki Globe" link |
| `src/components/fork/DebugHooks.tsx` | `window.__bh` console handle |
| `src/components/fork/SkyCredit.tsx` | panorama credit + the stated galactic tilt |
| `src/configs/skybox.config.ts` | sky orientation, equirect mapping, spectral shift |
| `src/rendering/skybox.ts` | loads/uploads the panorama, publishes load state |
| `public/textures/milky-way-eso-4k.jpg` | the panorama, derived from the globe's copy |
| `src/components/fork/ApsisHandles.tsx` | draggable periapsis/apoapsis handles + preview |
| `src/physics/apsides.ts` | Newtonian preview ellipse and drag limits |
| `physics-engine/gravitas-core/src/physics/apsides.rs` | apsides → (E, L), separatrix |
| `physics-engine/gravitas-core/tests/apsides.rs` | §6.3's verification targets |

## Upstream files modified

| Path | Change | Why |
| --- | --- | --- |
| `next.config.mjs` | static export, `basePath`, `trailingSlash`, `images.unoptimized`; `headers()` gated to dev | GitHub Pages sub-path deployment |
| `package.json` | dropped `build:vercel`, `seo:ping`, `postinstall` | Vercel-only; `lefthook install` would write git hooks into the *wiki-globe* repo |
| `src/app/layout.tsx` | self-referential URLs → `SITE_URL`; Search Console token removed; `SearchAction` dropped; icons via `asset()`; mounts `CrossOriginIsolation` | upstream's SEO identity points at their domain — publishing it here would claim another site's identity |
| `src/app/manifest.ts` | `start_url`/`scope`/icon paths via `BASE_PATH` | manifest members are plain strings, unaffected by `basePath` |
| `src/app/page.tsx` | mounts `BackToGlobe` + `DebugHooks`; top-bar `pt` enlarged to clear the back pill; citation block points at the upstream repo | fork navigation + honest citation |
| `src/engine/physics-bridge.ts` | fallback terminates the orphaned worker and nulls `worker`/`sab`; records `transport`; `console.error` → `console.warn`; `solveApsides`; re-pushes mass/spin on `READY` | the worker is constructed *before* the SAB throw, so the fallback leaked a live thread; the fallback is an expected state, not an error; §6.3 needs a live apsides verdict, and the engine's metric was stale for the whole of startup |
| `src/hooks/usePhysicsState.ts` | dropped the `isReady()` gate around `updateParameters` | the gate is false during startup and the `useMemo` never re-ran, so the engine kept the spin it was constructed with — see milestone 9 below |
| `src/hooks/useTestObject.ts` | apsides state, live solve, measured apsides; takes `spin` | §6.3 |
| `src/physics/camera-projection.ts` | `screenToEquatorial` | §6.3: a dragged handle is a pixel that has to become a radius |
| `src/physics/worldline.ts` | `apsides` preset, `rPeri`, `radialExtent()` | §6.3 |
| `src/components/fork/TestObjectPanel.tsx` | apsides sliders + verdict; preset lifted to `page.tsx` | §6.3 |
| `src/components/fork/TestObjectOverlay.tsx` | trail budget 192 → 512 | long eccentric orbits made the polyline read as a polygon |
| `src/workers/physics.worker.ts` | `SOLVE_APSIDES`; passes `rPeri` through | §6.3 |
| `physics-engine/gravitas-wasm/src/lib.rs` | preset 5 + `r_peri` arg; `solve_apsides` | §6.3 |
| `physics-engine/gravitas-core/src/physics/worldline.rs` | `DropSpec::FromApsides`; `min_radius`/`max_radius` | §6.3 |
| `src/shaders/blackhole/chunks/metric.ts` | removed the Newtonian `M/r²` term from the null-geodesic force | shadow was 49.7% too large — see the physics audit below |
| `src/shaders/blackhole/chunks/disk.ts` | beaming exponent `δ^3.5` → `δ⁴`; `sample_relativistic_jets` rewritten against §1.4 | spec §1.3 requires exact `g⁴`; see the jets section below |
| `src/shaders/blackhole/chunks/background.ts` | procedural starfield demoted to a fallback; `sky()`, `sky_lod()`, `sky_shift()` added | spec §6.2 — the sky is a real panorama, lensed per ray |
| `src/shaders/blackhole/chunks/common.ts` | `u_skyTex`, `u_sky_enabled`, `u_sky_intensity`, `u_sky_basis_*` | uniforms for the above; three vec3s rather than a mat3 so `UniformBatcher` stays untouched |
| `src/shaders/blackhole/fragment.glsl.ts` | pass `rs` into the jet sampler; `starfield()` → `sky()`; 1st-person tint replaced by `sky_shift()` | jet emission carries the gravitational shift; §6.2 requires the colour shift in linear light |
| `src/rendering/webgl/renderer.ts` | owns a `SkyboxTexture`, binds it to unit 6, uploads the galactic basis | see the milestone 8 section below |
| `src/configs/simulation.config.ts` | `diskSize` default 50 → 24, unit `Rs` → `M` | the value multiplies M, so the old label was off by 2×; §1.3 wants ~12 r_s |
| `src/components/ui/ControlPanel.tsx` | jets toggle labelled "(kinematic)"; brand logo via `asset()`; "Background Stars" → "Milky Way Sky" + `SkyCredit` | §1.4/§5 require stating that the launch mechanism is not simulated; `images.unoptimized` emits the src verbatim so basePath is not applied; §6.2/licensing rule #4 want the panorama credited in-app |
| `src/components/ui/IdentityHUD.tsx` | brand logo via `asset()` | same: `/brand-logo.png` 404s under `/blackhole` |
| `tests/visual-regression/capture.ts` | ANGLE backend configurable, default SwiftShader; optional `SHADER_CHECK_CDP_URL`; waits for `window.__bh.skybox()` | upstream's `vulkan` hangs where no Vulkan ICD exists, GPU-captured goldens are not reproducible, and a capture must not shoot before the panorama lands |

## Upstream files deleted

| Path | Why |
| --- | --- |
| `.github/workflows/production.yml` | deploys to upstream's Vercel project with their secrets |
| `vercel.json`, `scripts/vercel-build.sh` | Vercel-only build path (its `RUSTFLAGS=-C target-feature=+bulk-memory` and `CARGO_BUILD_JOBS=1` are carried into the Pages workflow) |
| `lefthook.yml` | git hooks would install into the parent wiki-globe repo |
| `scripts/indexnow-ping.ts` | pings search engines for upstream's domain |
| `src/app/robots.ts`, `src/app/sitemap.ts` | `robots.txt` is only honoured at the origin root; the globe's root `robots.txt` / `sitemap.xml` own site-wide SEO |
| `src/app/google71f68cb94e351e26.html`, `public/c9f345b7cd2d289e01df73e6ca6c86e8.txt` | Search Console / IndexNow ownership proofs for upstream's domain |
| `public/textures/milkyway.jpg`, `milkyway_2020_4k.jpg`, `starmap.jpg` | sky imagery with no recorded provenance, referenced by nothing; §6.2 forbids shipping it without establishing a licence (see milestone 8 below) |
| `scripts/convert_exr.py` | produced one of the above from an `.exr` that is not in the tree |

## Physics audit (spec milestone 2)

Measured by transcribing the shader's own `kerr_geodesic_accel` and marching
loop into JS and bisecting the capture impact parameter (camera at r0 = 1000M,
step budget lifted so the result measures the *integrator*, not the step cap).
Reproduce from the console via `window.__bh`.

**Null geodesics were wrong at a = 0 and are now correct.** The radial force
carried a Newtonian `M/r²` term alongside the `3M·L²_eff/r⁴` term. Light does
not carry the Newtonian term — the Binet equation for photons is
`u'' + u = 3Mu²` — so every ray was over-deflected:

| | b_crit at a = 0 | error vs `3√3 M` |
| --- | --- | --- |
| upstream | 7.777 M | **+49.7%** |
| this fork | 5.194 M | −0.04% |

A ray just outside the corrected b_crit winds ≈ 11.9 rad (≥ 2π) before
escaping, satisfying the second §4 target. **The shadow was ~50% too large.**

**Kerr is still approximate.** With the fix, the critical curve at a = 0.5 is
~3.7 M prograde / 6.5 M retrograde against analytic ~4.8 / ~6.3, and at
a = 0.999 it is ~1.6 / ~7.6 against 2 / 7 — roughly 10–25% off. The force is an
effective-potential model with a spin-orbit `L_eff` and an added
frame-dragging cross term, not integration of the Kerr geodesic equations,
despite the "Kerr-Schild Hamiltonian" comment in `metric.ts`. Spec §4 states
its analytic targets for a = 0 only, so this is recorded as a limitation
rather than patched.

### §1.3 accretion disk — what upstream already satisfies

| §1.3 requirement | Status |
| --- | --- |
| Annulus anchored at the ISCO | ✅ `diskInner = isco` (exact Bardeen-Press-Teukolsky ISCO) |
| Keplerian orbits, Kerr-corrected Ω | ✅ `Ω = ±√M / (r^{3/2} + a√M)` |
| Total shift factor g (gravitational × Doppler) | ✅ exact `δ = 1/(u^t (1 − Ω L))` from the circular-orbit 4-velocity |
| `T ∝ r^(−3/4)` | ✅ better than asked — full Novikov-Thorne with the zero-torque inner boundary |
| `g⁴` beaming | ❌ was `δ^3.5` "for visual dynamic range"; **fixed to `δ⁴`** |
| Disk toggle | ✅ already a feature toggle (`accretionDisk` → `ENABLE_DISK`) |
| Outer edge ~12 r_s | ⚠️ default `diskSize` is 50 M = 25 r_s, roughly double the spec; it is a user slider, so this is a default to revisit, not a defect |

## Jets and disk (spec milestone 3)

`sample_relativistic_jets` was rewritten against §1.4. Upstream had a cone with
β = 0.92 (Γ ≈ 2.6), an exponential length falloff, and `δ^3.5` beaming. Now:

- Γ = 5 (§1.4 asks 5–10), half-opening angle 7° (asks 5–10°), emissivity
  ∝ r⁻², all from `src/configs/jet.config.ts`.
- Beaming is `g^(3−α)` with α = −1, i.e. exactly `g⁴` — the same law the disk
  uses, so the two are mutually consistent and §1.3's "non-negotiable" holds
  across the whole render. A band-limited synchrotron render would set
  α ≈ 0.7; the §4 check reads whatever is configured.
- `g` now includes the gravitational shift `√(1 − r_s/r)`, not just the
  kinematic Doppler factor, so jet light is shifted by the same factors as
  everything else.
- Emission knots advect at the bulk speed β, so the apparent transverse speed
  `β sinθ / (1 − β cosθ)` is produced by light-travel time rather than
  prescribed. At Γ = 5 the peak apparent speed is Γβ ≈ 4.9 c.

The physics lives in TS (`jet.config.ts`) and is injected into the GLSL, so
the beaming maths is unit-tested in `src/__tests__/physics/jet-beaming.test.ts`
(10 tests) and cannot drift from the shader.

**Still open on §1.4:** per-mass-preset jet defaults (on for M87\*, off for
Sgr A\* and stellar) depend on mass presets, which are §1.8 / milestone 6. The
toggle exists and is labelled "Relativistic Jets (kinematic)"; only the
preset-driven default is deferred.

**§1.3 disk outer edge:** `diskSize` is multiplied by M in the shader, so
upstream's "Rs" unit label understated the disk by 2×. Default changed from
50 (= 25 r_s) to 24 (= 12 r_s per §1.3) and the unit relabelled to M.

## Test object (spec milestone 4, physics half)

`physics/worldline.rs` in `gravitas-core` is the timelike trajectory primitive
that `plunge.rs` flagged as "its own change". It integrates a dropped test
object in **Kerr-Schild** coordinates, parameterised by proper time, with drop
presets (circular, ISCO knife-edge, radial free fall, eccentric, custom).
Exposed through `gravitas-wasm` as `integrate_test_object(...)` plus
`worldline_*` getters, in an append-only `impl` block.

Three things it had to add over `geodesic::integrate`:

- **Proper time.** With H = −1/2 the affine parameter *is* τ, but
  `AdaptiveStepper::step` returns the *next* recommended step, not the one it
  accepted, so τ cannot be accumulated through it. The worldline loop drives
  `adaptive_rkf45_step` directly.
- **Both clocks per sample**, so §1.6's two views sample one stored worldline
  rather than two integrations that would drift apart.
- **Crossing the horizon.** `integrate` stops at r < r_h·1.001; the inner
  radius is a caller parameter here and reaches ~0.02 r_s.

### The clock that freezes is not the coordinate time

The spec says the 3rd-person view samples "coordinate time t" so the object
freezes at the horizon. Taken literally against this engine that is **wrong**,
and a test caught it: Kerr-Schild time is *regular* at the horizon — that is
the entire point of horizon-penetrating coordinates — so an infalling object
crosses in finite `t` and would be seen sailing straight through.

The freeze lives in the **distant static observer's** (Boyer-Lindquist) clock.
Every sample therefore carries `t_far` alongside `t`, converted in closed form
by partial fractions over the horizon roots:

```text
t_far = t_KS − ∫ 2Mr/Δ dr,   Δ = r² − 2Mr + a²
```

`t_far` diverges logarithmically as r → r_+ and is reported as `Infinity` at
and inside the horizon, where no static observer exists. **The 3rd-person view
must sample by `t_far`; the 1st-person view samples the same buffer by `tau`.**

### §4 targets, verified by `cargo test -p gravitas-core --test worldline`

13 tests, all passing:

| Target | Result |
| --- | --- |
| Circular drop at r = 4 r_s holds ≥ 20 orbits, E/L drift < 1e-6 | radius varies < 1e-6 relative over 20+ orbits |
| Inside 3 r_s it plunges | holds, once perturbed — see below |
| Eccentric periapsis precession within 1% of `6πM/p` | 0.6% at p ≈ 960M |
| Radial-fall proper time matches the closed form | within 1e-3 relative |
| 3rd-person view never shows a crossing | `t_far` infinite for every sample inside r_h, while τ stays finite |
| Circular-orbit dilation `dt/dτ = 1/√(1−3M/r)` | within 1e-4 |

Two of those needed the test rewritten rather than the code:

- **"Inside the ISCO it plunges" is a statement about stability, not
  existence.** Circular geodesics exist at any r > 3M; inside the ISCO they are
  unstable *equilibria*, so an exactly circular start sits there forever in
  exact arithmetic. The test now nudges the orbit and asserts the nudge decays
  outside the ISCO and runs away inside it.
- **The 1% precession target only holds in the weak field.** `6πM/p` is the
  leading post-Newtonian term; at p ≈ 288M the fully relativistic integration
  sits 1.6% above it. A companion test confirms the residual shrinks roughly
  as M/p, which is what distinguishes a truncated formula from a wrong
  integrator. The 1% check runs at p ≈ 960M.

### Test object, UI half

- `src/physics/worldline.ts` — read-only interpretation of the one integrated
  buffer. `sampleByFarTime` (3rd person) and `sampleByProperTime` (1st person)
  index the *same* samples, so the two views cannot disagree about where the
  object is. 15 tests.
- `src/physics/camera-projection.ts` — world → screen, reproducing the
  shader's camera term for term (focal length 1.5, `u_zoom = zoom × 2`,
  X-then-Y rotation, `min(w,h)` normalisation). The marker is an SVG overlay,
  so a mismatch here would silently misplace it. 11 tests.
- `src/hooks/useTestObject.ts`, `components/fork/TestObjectPanel.tsx`,
  `components/fork/TestObjectOverlay.tsx` — drop presets, HUD readouts
  (r/r_s, both clocks, local velocity from the conserved E, tidal stretching,
  redshift, E/L drift), marker + trail with redshift fade.
- Transport: `DROP_OBJECT` / `WORLDLINE` over `postMessage` with a
  transferable, **not** the SAB ring. The ring is a fixed-layout per-frame
  telemetry channel; a worldline is one-shot and variable-length. Spec §1.5
  assumed the SAB pipeline; this is a deliberate deviation.

Two bugs the browser round-trip caught that no unit test would have:

- **Sample stride assumed the full step budget.** `max_steps / max_samples`
  gave 7 samples for an infall that terminated after ~300 steps. Now every
  accepted step is recorded and thinned once at the end (237 samples for the
  same drop).
- **"Radial" fall was not radial around a spinning hole.** Setting u^φ = 0
  leaves `p_φ = g_{tφ} u^t ≠ 0` for a ≠ 0, so the object carried angular
  momentum nobody gave it (L = −0.053 at a = 0.9). The preset now solves
  `p_φ = 0` for the ZAMO angular velocity, giving L ≈ 7e-18. Identical to
  u^φ = 0 at a = 0, which is why the Schwarzschild test suite never saw it.

Not done from §1.6: the object's own **lensed** primary/secondary images (the
stretch goal). The marker is drawn at its true projected position, so it does
not bend around the hole.

## First-person observer frame (spec milestone 5, physics half)

`physics/tetrad.rs` builds the orthonormal frame the 1st-person camera
generates rays through. §5 requires this be built **once**, with aberration,
Doppler and gravitational shift all falling out of it — "ad-hoc per-effect
redshift shaders are how it becomes a toy". Exposed as `observer_tetrad(...)`
and `tetrad_orthonormality_error(...)`.

### Second correction to the spec: no static observer exists inside the horizon

§1.6 specifies the frame as "the static-observer frame boosted by the object's
4-velocity". That recipe has no meaning exactly where the milestone's payoff
is: **inside the horizon nothing can be static**, so there is no frame to
boost. Building it by Gram-Schmidt from the object's own 4-velocity is defined
everywhere the object goes, and reduces to the same frame outside the horizon
up to a spatial rotation — which free-look absorbs anyway.

A test asserted this the wrong way first, constructing a "dropped from rest at
r" state *inside* r_h; that state is not timelike, and the frame came back with
an orthonormality error of 1.02. Using the 4-velocity the integrator actually
carried to that point gives < 1e-8 at every radius, horizon included.

That also forced a data change: `WorldlineSample` now carries `u^mu`, and the
JS buffer stride went 6 → 10. The frame has to be reconstructable at *any*
point on a stored worldline, and re-deriving u by differencing neighbouring
samples would approximate a quantity the integrator already knows exactly.

### §5 targets, verified by `cargo test -p gravitas-core --test tetrad`

11 tests: orthonormality on a circular orbit, at every radius of an infall
including inside the horizon, and at near-extremal spin; `e_0` is exactly the
4-velocity; the observer measures its own velocity as `(1,0,0,0)`; a null ray
stays null in the frame; project/lift round-trip; and light met head-on is
blueshifted while light overtaking from behind is redshifted.

That last one was tautological in its first form — both photons were lifted
*out of* the orbiting frame with unit time component, so both were seen at
unit frequency by construction. It now emits them from a **static** observer
(the starfield is at rest), equal-frequency in that frame, and asks what the
orbiting observer measures. Which spatial leg is "direction of travel" is
derived by projecting the orbiting 4-velocity into the static frame rather than
assumed: Gram-Schmidt fills ∂φ at index 2, not 3, and hardcoding 3 silently
compared two *transverse* photons that were both blueshifted by exactly γ.

### Ray construction and the shader path

`src/physics/first-person.ts` turns the frame into rays:
`p = e_0 + n_x e_1 + n_y e_2 + n_z e_3`, with `n` the look direction in the
observer's own frame. **There is no aberration function and no Doppler
function in the render path** — both are consequences of that sum, because
`e_0` is the *moving* observer's time leg.

20 tests check exactly that claim, comparing against closed forms the module
has never been told about: aberration matches `(cosθ + β)/(1 + β cosθ)` to
10 decimals at β up to 0.99, and the frequency shift matches
`1/(γ(1 + β cosθ))`. The flat-space frames in those tests are written by hand
rather than taken from the Rust Gram-Schmidt — if both used the same
construction, agreeing would prove nothing.

Free-look is applied to `n` **inside** the frame, before the combination.
Rotating the finished world-space ray instead would drag the forward
compression around with the view, which is the "toy" failure §5 warns about; a
test pins it.

Shader (`fragment.glsl.ts`, `chunks/common.ts`) gained a 1st-person branch
behind `u_fp_enabled`, taking the four legs as `vec4`s (xyz spatial, w = e^t).
Three exterior-camera assumptions had to be gated off, each of which would
have silently broken the crossing:

- the "kamikaze protection" that shoves the camera out to 1.5 r_h,
- the `impactParam < 0.9 r_h` shadow cull, which presumes a distant start,
- the `r < 1.15 r_h → captured` test, which would fire on the first step once
  the camera is inside. Inside the horizon only the singularity terminates a
  ray; anything climbing back out is light that fell in alongside the observer.

Sky colour is shifted by `g⁴` from the same `p^t` the ray construction
produced — the same Liouville law the disk and jet use.

### Milestone 5 completed

Wiring, view toggle, free-look, proper-time clock and the singularity card are
in, and the view has now been **seen rendering**. The frame is precomputed per
sample on the Rust side (buffer stride 10 → 26) rather than fetched per frame:
the engine lives in a worker, so an on-demand frame would put an async round
trip and the metric on the render path.

Three defects the rendered frame caught, none of which any test would have:

- **The camera looked 90° away from the hole.** A tetrad fixes no preferred
  spatial orientation, and Gram-Schmidt fills its legs in whatever order
  succeeds — radial, azimuthal, polar, with fallbacks. Treating local +z as
  "forward" landed on the *polar* axis, so the rider stared out of the orbital
  plane at empty sky. `orientFrame()` now identifies each leg by its
  coordinate components (`e[a][1]` is the ∂r part) and takes forward as inward
  radial, so the hole is in shot when the ride begins. Robust to the ordering
  changing, which it does between an orbiting and an infalling observer.
- **Both clocks read the same number.** `interpolate()` derived `t_far` from
  whichever column was being *searched*, so a proper-time lookup returned tau
  in the t_far slot — erasing precisely the disagreement §1.6 exists to show.
  Only reachable on the 1st-person path. Now each clock interpolates from its
  own column, taking the nearer sample where t_far diverges rather than
  producing NaN.
- **The singularity card fired for a stable orbit.** "Ran out of worldline" was
  being read as "arrived" — a circular orbit simply exhausts its step budget.
  Gated on the integration having terminated at the inner radius *and* the
  object being inside the horizon.

Verified against theory in the rendered HUD at r = 10 r_s: τ 200.42 vs
t_observer 211.24 (matches `1.0828 τ − 5.78`), v_local 23.3% c, tidal 2.5e-4,
redshift 0.9487, E/L drift 0.

Not yet seen: the free-look drag, and the horizon crossing and singularity card
in flight — a radial plunge takes ~66 s of wall clock at the current fixed
playback rate, which §1.9's speed slider will make practical to check.

### The renderer is not deterministic, so goldens cannot work yet

**This is the blocker for the whole visual-regression suite, and it is almost
certainly why upstream shipped the harness and the manifest but never captured
a single golden.**

Two mechanisms make the same scene render differently on consecutive runs:

- `PERFORMANCE_CONFIG.calibration.durationMs = 3000` — a three-second stress
  test at startup picks the ray-tracing quality tier from measured frame times.
- `PERFORMANCE_CONFIG.resolution.enableDynamicScaling = true` — a PID
  controller then continuously rescales render resolution between
  `minScale 0.5` and `maxScale 2.0` to hit a frame-time budget.

So the captured image depends on how fast and how loaded the machine was during
those first seconds. The evidence is in the goldens themselves: captured back to
back in one session from one manifest, `schwarzschild_face_on` reports
`QUALITY: medium` and `kerr_inclined` reports `QUALITY: high`. Neither frame
asks for a quality. Under SwiftShader at ~10 FPS the PID will also be pinning
resolution near its 0.5 floor.

Comparing that against SSIM thresholds of 0.996–0.998 would fail essentially at
random, and would fail hardest on the machine that did not capture it.

**Fixed, in two rounds — and the second only surfaced because the fix was
tested by hashing the output rather than by inspection.**

Round one: `?deterministic=1` (see `src/configs/capture-mode.ts`) skips
calibration outright — rather than ending it, since `finalizeCalibration()`
would still pick a tier from measured frame times — pins `rayTracingQuality`
to `ultra`, and forces render scale to 1.0 with the PID bypassed. Applied in
`PerformanceMonitor.setDeterministic()` before the first frame, and at the
single point in `renderer.ts` where the quality tier feeds both the shader
variant and the step budget.

That made every frame report the same quality tier, which *looked* like
success. Capturing twice and comparing SHA-256 showed it was not: the same
frame came back `09D68EF4…` and `BD6612DB…`.

Round two: **`u_time` was the remaining leak.** It advances `+0.01` per
rendered frame and drives the disk rotation phase, jet knot positions, jet
turbulence, and starfield twinkle — so the image depended on how many frames
the machine got through before the screenshot. Exactly the same machine-speed
dependency as the quality tier, arriving by a different route. Deterministic
captures now pin the clock to `CAPTURE_TIME`.

Round three: **TAA.** `ReprojectionManager.resolve` blends each frame with
accumulated history at 0.75, so its output depends on the number of frames
rendered — on a static scene it converges geometrically but never exactly.
Hashing again after the clock was pinned still showed the frame differing.
Deterministic captures now bypass the reprojection pass and present the scene
texture directly; anti-aliasing is not what a regression test measures.

Ordinary visitors are unaffected: the flag is opt-in and absent by default.

**Verify determinism by hash, never by eye.** Two captures of the same frame
must be byte-identical. Every intermediate state here looked like success:
after round one all three frames reported `ultra`; after round two the images
looked indistinguishable. Only SHA-256 told the truth, three times running.

**And read a comparison's provenance before believing it.** One A/B run
reported two frames `IDENTICAL` — but the second capture had aborted before
reaching them, so those files were untouched copies of the first run. A frame
that was never re-rendered will always compare equal.

Iterate with `--only=<frame>`; a full three-frame capture is ~12 minutes under
SwiftShader at ultra.

### What the first rendered frame caught

The first golden capture was also the first time this fork had been *seen*
rendering. It immediately surfaced two defects that every unit test, the type
checker and the shader compile check had all passed over:

- the fork's test-object panel at `top-28` **overprinted** upstream's identity
  HUD ("SIMULATION KERNEL / METRIC: KERR VACUUM STATE") — moved to `top-48`;
- the **brand logo was a broken image**, because `next/image` with
  `images.unoptimized` emits the `src` verbatim and `/brand-logo.png` does not
  exist under `/blackhole`.

Neither is subtle on screen and neither is detectable by any check in CI today.
That is the argument for arming the visual suite.

The physics in that frame reads correctly: a round shadow with a sharp photon
ring, and the accretion disk lensed into arcs above and below it — the
signature that light from the disk's far side is being bent over the top.

## Mass presets and playback (spec milestone 6)

`src/configs/mass-presets.ts` is the unit-conversion layer and nothing else —
it never touches the shader. The render is mass-invariant (everything is
computed with G = c = M = 1), so a preset changes only what the numbers mean.

The tests assert against the figures **the spec itself states** rather than
against whatever the code produces, which is what makes them worth having:
ISCO periods of 4.5 ms / 31 min / 34 days and comfort speeds of 1.5e-4× / 60× /
1e5× for the stellar / Sgr A* / M87* presets. Confirmed live in the browser at
4.55 ms / 31.5 min / 34.2 d and 1.5e-4× / 63× / 9.9e4×.

`src/physics/playback.ts` holds the §1.9 speed control: a log-scaled slider
across ten decades with clickable detents at 1× real time and the per-preset
comfort speed. Two details worth keeping:

- **Snapping is done in log space.** A fixed absolute tolerance would make the
  stellar preset's comfort detent (1.5e-4×) unreachable while swallowing whole
  decades at the top end.
- **1× means one second of simulated time per wall-clock second**, which is a
  wildly different *geometric* rate per preset. That is what ties §1.9's
  slider to §1.8's masses, and why `geometricRatePerSecond` takes the mass's
  time unit rather than assuming one.

Pause freezes the simulation clock only; rendering and both cameras stay live,
which falls out of the clock being a separate rAF loop from the renderer.
`Space` toggles it, ignored while a form control has focus.

**§1.4's per-preset jet default is now closed**, having been deferred since
milestone 3 for want of mass presets: verified in the browser as
`stellar:false, sgra:false, m87:true`.

§1.7's curvature grid turned out to be largely present already — upstream's
`spacetimeVisualization` renders the Flamm paraboloid via
`generate_embedding_mesh`. What was missing was the honesty label §1.7 and §5
both demand, so the toggle now reads "Curvature Grid (visual aid)". Note it is
a *mode* that replaces the ray-marched view rather than an overlay beneath the
equatorial plane as §1.7 describes; converting it to an overlay is still open.

## Performance (spec milestone 7) — and why the numbers here are not evidence

**This machine cannot measure rendering performance reliably, and two
conclusions drawn from it had to be retracted.** Recording that in full,
because the failure mode is subtle and will otherwise be repeated.

An ordered sweep of ray-march quality gave 67.7 / 86.7 / 86.3 / 88.3 ms for
low / medium / high / ultra, which reads as "8x the step budget costs only 30%
more — the march is not the bottleneck". An ordered sweep of render scale then
gave 58.7 / 74.5 / 81.9 ms for 1.0 / 0.75 / 0.5, i.e. *lower resolution is
slower*, which is impossible.

Both sweeps were measuring elapsed time. An interleaved A/B/A/B run makes it
plain:

| order | scale | frame ms |
| --- | --- | --- |
| 1 | 1.0 | 47.9 |
| 2 | 0.5 | 67.8 |
| 3 | 1.0 | 78.6 |
| 4 | 0.5 | 81.4 |
| 5 | 1.0 | 93.0 |
| 6 | 0.5 | 92.0 |

Frame time climbs monotonically with wall-clock position in the run whatever
is being set. Under SwiftShader on this host — software rasterisation, plus a
dev server and a headless browser competing for the same cores — the drift
swamps the effect. **Never trust an ordered performance sweep here; interleave
and repeat, and treat a monotonic trend as an artefact until proven
otherwise.**

Consequently milestone 7 ships only changes that are correct by construction
rather than by measurement:

- **Hidden-tab stop.** The physics worker already dropped to 1 Hz on
  `visibilitychange`; the renderer kept marching at full rate behind another
  window. Skipping render entirely when `document.hidden` removes 100% of that
  work — no benchmark needed to know that.
- **Frame cap** at `PERFORMANCE_CONFIG.scheduler.targetFPS`. Bounded work per
  second is arithmetic, not measurement; the win is largest on 120/144 Hz
  displays, which were previously doing 2-2.4x the necessary marches.
- **Render scale actually applies.** `params.renderScale` existed and was
  never read — only the PID controller drove resolution. And
  `params.adaptiveResolution` defaults to false while
  `PERFORMANCE_CONFIG.resolution.enableDynamicScaling` defaults to true, so
  the PID ran regardless of the flag meant to gate it. The flag now wins and
  the PID modulates around the user's scale. This is a plain bug fix.
- **Escape radius** (§1.2/§6.1). The step cap was 3.0 while `MAX_DIST` is
  10000, so reaching the escape test needed ~3300 steps against a budget of
  256: every escaping ray exhausted its whole budget in empty space and never
  escaped. Outward-bound rays past `ESCAPE_RADIUS` now stop, with the
  neglected residual deflection (~2 r_s b / r²) sub-pixel at r = 400. Bounded
  worst case, not a measured speed-up.
- **Power control** in the panel, stating what each level stops computing.

**Left unverified:** whether any of this helps on a real GPU. It needs
measuring on the target hardware, where `window.__bh.metrics()` and the debug
overlay report the same numbers used above — interleaved, please.

## Milky Way sky (spec milestone 8)

The procedural starfield is gone from the production path. The background is
now the ESO/S. Brunier panorama, sampled equirectangularly from the direction
each ray was travelling when it escaped — so it is lensed by the same
integration that produces the shadow, not pasted behind it. Everything below is
in `src/configs/skybox.config.ts` (the decisions and the maths, unit-tested),
`src/rendering/skybox.ts` (GL plumbing) and the `sky()` function in
`chunks/background.ts`.

**The asset is a derivative of the one the globe already ships**, per §6.2.
`scripts/data/generate-blackhole-skybox.ps1` (in the *parent* repo, next to the
existing `generate-skybox.ps1`) area-averages `assets/milky-way-panorama-hires.jpg`
from 6000×3000 down to 4096×2048 and writes
`public/textures/milky-way-eso-4k.jpg`, 2.8 MB. Two things about that script
matter:

- **It resamples in linear light.** The panorama is mostly point sources;
  averaging pixels in sRGB space loses flux non-linearly and the stars come out
  dim with flattened cores. Decode, average, re-encode.
- **Box filter, not bicubic.** GDI+'s `HighQualityBicubic` is a sharpening
  kernel and rings around every bright pixel on a starfield.

**Upstream's three sky JPEGs are deleted**, not shipped. §6.2 flagged that no
provenance was recorded for `milkyway.jpg`, `milkyway_2020_4k.jpg` or
`starmap.jpg`, and nothing referenced any of them. One clue did turn up while
checking: `scripts/convert_exr.py` (also deleted, and it referenced an `.exr`
that is not in the tree) converted `starmap_2020_4k_gal.exr` into
`milkyway_2020_4k.jpg`, which points at NASA/Goddard SVS *Deep Star Maps 2020*.
That is probably public domain — but "probably, from a filename" is not
establishing a licence, and there is no need to now.

### Orientation is a styling choice, and it says so

§6.2 asks for the galactic-plane/disk-plane question to be decided and stated.
The scene's +Y is the hole's spin axis, which fixes the disk in Y = 0. A black
hole's spin axis and the galactic plane are physically unrelated, so aligning
them would invent a correlation — and would also read as though the band were
part of the disk. `GALACTIC_ORIENTATION` therefore tilts the galactic pole 60°
away from the spin axis and puts the bulge 55° off the default camera axis so
the shadow does not eat the most interesting part of the photograph. The
`SkyCredit` line in the control panel states the tilt and that it is chosen
rather than measured.

The equirect convention is copied exactly from the globe's
`generate-skybox.ps1` (`longitude = atan2(z, x)`, `u = lon/2π + 0.5`,
`v = 0.5 − lat/π`), and a test asserts it, so both apps read the same pixel for
the same direction. Milestone 11's RA/Dec sky dots key off the same basis
rather than introducing a second one.

### Three details that are load-bearing

- **`SRGB8_ALPHA8`, not `RGBA8`.** §5 and §6.2 both require the shift by `g` to
  happen in linear light. Letting the sampler do the sRGB decode puts the
  photograph in the same space the rest of the shader already works in
  (`blackbody()` converts *up* to linear for exactly this reason, and the
  single gamma encode happens at the end of `main()` or in the post chain under
  `ENABLE_LINEAR_OUTPUT`). Sampling as RGBA8 and multiplying by `g⁴` would be
  wrong by a power of 2.2 while still looking plausible.
- **Mip level is computed, not left to the hardware.** Automatic LOD
  differentiates the UV, and at the longitude wrap `du` jumps by ~1 — which
  would select the 1×1 mip and draw a blurred vertical line down the sky.
  `sky_lod()` differentiates the ray *direction* instead: no seam, and it is
  also the physically right quantity, because near the critical curve
  neighbouring pixels genuinely do see wildly separated parts of the sky. The
  blur there is the demagnification, not an artefact. The `1/cos(latitude)`
  term is the usual equirect pole correction.
- **The tint hack is gone.** The 1st-person path multiplied the sky by `g⁴` and
  then `mix()`ed between a warm and a cool colour. That was defensible only
  while the sky was procedural. `sky_shift()` replaces it: the JPEG's three
  channels are treated as a piecewise-linear spectral density through the sRGB
  primaries (464.2 / 549.1 / 611.4 nm), and an observer's channel at `λ_c`
  resamples that curve at `λ_c · g`. Intensity still carries the exact `g⁴`
  from Liouville. **The approximation is the three-sample spectrum, and nothing
  else** — and outside 464–611 nm the photograph has no data, so the curve is
  held flat and a strong blueshift saturates rather than extrapolating a
  spectrum nobody measured. A grey pixel stays grey at every `g`, which is the
  test a tint cannot pass.

### The sky is one more thing a deterministic capture has to wait for

The panorama is fetched and uploaded asynchronously, and until it lands the
shader falls back to the procedural starfield — so a screenshot taken in that
window records a *different sky* with nothing in the frame to say so. That is
the same "depends on how fast the machine was" failure that the quality tier,
the simulation clock and TAA each produced in turn, arriving by a fourth route.
Nothing in `capture-mode.ts` can pin it, because it is a network fetch; both
capture harnesses now poll `window.__bh.skybox()` until it reads `ready` (or
`failed`, so a missing asset still produces a comparable frame instead of
hanging the run).

Goldens are unaffected in practice only because none were ever captured — every
manifest entry is still `captured_at: null`. When they are captured, they will
be captured against this sky.

### Seen rendering

The unit tests constrain the mapping and the shift; they cannot tell you the
GLSL applies them. These frames can, captured over CDP against `bun run dev`
(the preview pane does not composite, so `window.__bh.captureFrame()` plus
`Page.bringToFront` is the way to get pixels here — same trap as the golden
harness):

- **3rd person, disk off, `zoom = 8`.** The galactic band is bent into a bright
  arc wrapping the top and right of the shadow, and the stars around it are
  smeared *tangentially*. That is lensing acting on the photograph; a backdrop
  pasted behind the hole cannot do it.
- **3rd person, disk on, ultra.** Individual bright stars carry the source
  photograph's diffraction spikes, which no hashed-cell starfield produces.
  Round shadow, disk lensed above and below, approaching side beamed — the
  milestone 2/3 physics is unchanged.
- **1st person, circular orbit at 20 M, disk off.** The most informative frame.
  The band is lensed into arcs on both sides of the shadow, the Magellanic
  Clouds are recognisable, and the sky is visibly **brighter and denser toward
  the direction of travel** and dimmer behind — aberration plus `g⁴`, on real
  imagery, with no tint anywhere in the path.

`window.__bh.compileShader()` returns ok with every feature define set, and
`gl.getError()` is 0 after a frame.

Two notes for whoever repeats this. The 1st-person toggle stays disabled for
~3 s after `Drop` while the worldline integrates — clicking too early silently
does nothing and you get a 3rd-person frame that looks plausible. And a `const`
in an injected snippet that shadows a name in the harness's own IIFE throws a
TDZ error that surfaces only as `result.value === undefined`; log
`exceptionDetails`.

### Not done here

- **The WebGPU path keeps its procedural starfield.** `raymarching.wgsl.ts` has
  its own simplified port and is opt-in behind `?webgpu=true`; the WebGL
  renderer is what visitors get. Porting the panorama there is open.
- **`src/hooks/useWebGL.ts` and `useAnimation.ts` are untouched.** They are
  upstream's older render path and nothing imports them — `WebGLCanvas` uses
  `rendering/webgl/renderer.ts`. If either is ever revived it will simply not
  set `u_sky_enabled`, which defaults to 0 and leaves the procedural sky. Safe
  by construction, but worth knowing.
- **No measured cost.** §6.2 asks for the bandwidth to be measured against
  milestone 7's budget. This machine still cannot benchmark rendering (see
  above), so the honest statement is the shape of the change, not a number:
  one 2.8 MB fetch at startup, ~44 MB of VRAM with mips at 4096×2048, and one
  extra `textureLod` on the *escaped* rays only — rays that hit the horizon or
  saturate the disk never reach it.

## Draggable orbits (spec milestone 9)

The drop panel gains an **Apsides (drag)** trajectory: two handles on the
equatorial plane, one at the periapsis and one at the apoapsis. Drag either and
release, and the orbit that has those two turning points is integrated. The
presets stay — §6.3 is explicit that this is an addition.

`physics/apsides.rs` is the whole physics; `physics/apsides.ts` is the preview
geometry and nothing else.

### The algebra, and why it stays in Kerr-Schild

For an equatorial timelike geodesic the radial potential is usually written in
Boyer-Lindquist, and §5 forbids mixing coordinate systems near the horizon.
This does not mix them: `E = −p_t`, `L_z = p_φ`, `r` and `dr/dτ` are *identical*
in the two systems, because Kerr-Schild differs by `t_KS = t_BL + f(r)` and
`φ_KS = φ_BL + g(r)`, which leaves the Killing vectors `∂_t`/`∂_φ` and `r`
alone. What does **not** survive is `Ω = dφ/dt`, which is exactly why the
`FromApsides` branch of `initial_state` writes `p_μ` down directly instead of
going through an angular velocity like every other drop preset does.

Both `R(r_p) = 0` and `R(r_a) = 0` are quadratic in `(E, x)` with `x = L − aE`,
but their **difference loses the cross term** and is linear in `E²` and `x²`:

```text
  E² = α + β x²,   α = 1 − 2M/(r_p + r_a),   β = 2M / (r_p r_a (r_p + r_a))
```

Substituting back and squaring away the remaining `2aEx` leaves a quadratic in
`y = x²`. Closed form, no iteration. Squaring introduces the retrograde branch,
so the root is chosen by checking it against the *unsquared* relation.

### Two numerical traps, both of which produced plausible wrong answers

- **`disc < 0 → no solution` rejected every Schwarzschild input.** At `a = 0`
  that discriminant vanishes *identically*, so it comes back as ±1e-16 and half
  the inputs were refused on a rounding error. It also loses half its digits to
  `(−b ± √disc)/2a` when the roots are that close. Fixed with a collapse
  window — but the same window in `inner_turning_point` reports a turning point
  across a band of angular momenta that have none, because the separatrix *is*
  the sign change of that discriminant, and it dragged the bisected separatrix
  4% inward at a distant apoapsis. The two call sites need opposite tolerances;
  they now take it as a parameter.
- **`k = E² − 1` has no significant digits at large `r_apo`.** It is ≈ −2M/r,
  so at `r_a = 10⁶` every digit cancels, and the forward synthetic division
  `b = 2M + k·r_apo` then differences two equal numbers. Both are recovered from
  the fact that `r_apo` *is* a root — `k = −(c₂r² + c₁r + c₀)/r³`, and the
  division runs backwards from the constant term.

### Correction to the spec: the limit is the separatrix, not the ISCO

§6.3 says "`r_peri` inside the ISCO must **plunge**". That is not right, and the
test `a_periapsis_inside_the_isco_is_still_a_stable_orbit` pins it: an eccentric
orbit's periapsis can sit well inside the ISCO and stay perfectly bound. For
Schwarzschild the real limit is

```text
  r_p,min = 4 M r_a / (r_a − 2M)
```

which tends to **4M** for a distant apoapsis (the marginally bound orbit) and
meets 6M only where the two apsides merge — which is the ISCO, and is why the
ISCO is the special case rather than the rule. A periapsis of 5M from an
apoapsis of 20M is inside the ISCO and completely stable.

Kerr has no such closed form, so the production path bisects on `L` for the
angular momentum whose inner turning point is about to vanish, and the
Schwarzschild expression is kept only as the test's anchor — so the general
route is the one that gets exercised.

Inside the separatrix there is no orbit to return. Rather than clamping to the
nearest one that works — which is the "silent clamp" §6.3 forbids — the angular
momentum is scaled `L = L_sep · (r_peri / r_peri_sep)`. That is continuous at
the separatrix (ratio 1) and tends to zero as the inner handle reaches the
middle, where a zero-angular-momentum radial free fall is exactly right. The
launch radius stays the requested apoapsis either way, so the outer handle
always means what it says.

### The precession test caught the test, not the code

`integrated_precession_matches_the_exact_schwarzschild_formula` failed by 13%
on its first run. The integrator was right; the *expected value* was wrong. The
exact advance is

```text
  Δφ = 4 √(p / (p − 6 + 2e)) K(k) − 2π,   k² = 4e / (p − 6 + 2e)
```

and it had been written with `p − 6 − 2e`. The sign is checkable without any
reference: `k → 1` must reproduce the separatrix `p = 6 + 2e`, and with the
wrong sign it does not. The wrong version still agreed with the weak field and
still passed at `e = 0.01`, which is how it survived being read twice.

Worth keeping the exact formula rather than §4's "within 1% of the analytic
formula" reading of `6πM/p`: at `p = 60, e = 0.01` those two differ by 8%, so an
integration agreeing with `6πM/p` to 1% would have to be *wrong*.

### UI

- **Integrate on drag end, preview during.** §6.3's instruction, and the
  Newtonian ellipse it asks for is drawn dashed and captioned. The caption is
  *not* gated on the drag: once the integrated trail is on screen next to a
  closed dashed ellipse, an unlabelled ellipse reads as the orbit. It says
  `NEWTONIAN PREVIEW — THE INTEGRATED ORBIT PRECESSES`, and the two curves side
  by side make that concrete better than any label could.
- **Sliders as well as handles.** A handle that is edge-on cannot be grabbed,
  and a drag is not keyboard-reachable. Both write the same state.
- **The verdict is the solver's, live.** `physicsBridge.solveApsides` asks the
  same Rust code the integration will run — a TypeScript copy of the separatrix
  would be a second implementation of the same physics, which is how the two
  drift. Latest-wins rather than debounced.
- **The panel reports what was *reached*, not what was asked.** Verified live:
  peri 7 / apo 26 comes back `7.00 – 26.00 M`; peri 2.5 / apo 26, with the
  separatrix at 3.06 M, comes back `1.85 – 26.00 M` — the horizon for
  a\* = 0.5. It plunged; it did not clamp.
- `screenToEquatorial` inverts the shader's own camera onto `y = 0`. Exactly
  edge-on it returns null and the drag simply stops tracking, which is honest;
  the alternative is a handle that flies across the screen for a one-pixel move.
- Trail point budget 192 → 512. Draggable apsides make long eccentric orbits
  the easy thing to ask for, and at 192 the polyline cuts visible chords across
  periapsis — precisely where the curvature is.

### A bug this milestone surfaced: the engine had the wrong black hole

`usePhysicsState` pushed mass and spin to the engine only when
`physicsBridge.isReady()`, from inside a `useMemo`. During startup that is
false, and the memo does not re-run afterwards because `params` has not
changed — so the Rust engine kept the hard-coded `(1.0, 0.9)` it was
constructed with while the shader rendered the UI's `a* = 0.5`, until the user
happened to move a slider.

Nothing had noticed because nothing had asked the engine a question about the
geometry and compared it to the screen. The apsides panel does, and printed a
separatrix of 1.77 M — the a\* = 0.9 answer — next to an a\* = 0.5 hole. The
analytic shadow curve was reading from the same stale metric.

Fixed in two places: `page.tsx` pushes the parameters from an effect it owns
(declared above `useTestObject` so it registers first), and the bridge re-pushes
whatever it has on the worker's `READY`, since the first push happens before
there is a worker to push to.

### A trap worth knowing

The shader chunks are JS template literals. A backtick inside a GLSL comment
silently ends the string, and **neither `tsc` nor `next build` catches it** —
it surfaces only as a webpack parse error at runtime. In a throttled tab
nothing draws anyway, so a broken shader looks exactly like a paused one.
`window.__bh.compileShader()` compiles the production fragment shader with all
feature defines in a throwaway context and returns the driver info log, which
turns that into a one-line check.

### Other audit findings (not yet acted on)

- **The photon ring is partly painted on.** `fragment.glsl.ts` adds
  `exp(-|‖p‖ − r_ph|·40)` as a post-hoc glow rather than letting the ring
  emerge from the integration. Spec §1.2 says it must never be painted on.
  Now that b_crit is correct the ring should largely emerge on its own;
  the additive glow should be re-evaluated and probably removed.

  **Removed, and the goldens show why.** With the paint in place the ring was
  crisp at a = 0 and a = 0.5 but *absent* at a = 0.99 edge-on — a single-radius
  glow matches nothing once the critical curve stops being a circle (prograde
  photon sphere ~1.2M at that spin, retrograde near 4M).

  With it gone, re-captured at ultra quality:

  | spin | rendered result |
  | --- | --- |
  | 0 | no ring — but this frame sets `diskTemp: 0`, a cold disk, so there is no light to lens |
  | 0.5 | thin **asymmetric** rim, brighter on the prograde side |
  | 0.99 | shadow displaced and visibly **D-shaped**, with a rim along the flattened edge |

  That is the Bardeen critical curve emerging from the integration, which the
  painted circle could not have produced. The paint was both fake and
  *masking* the real thing.

  A first reading of the a = 0 frame suggested the emergent ring was missing
  entirely; that was wrong, and the cold disk in that frame's config is the
  explanation. Worth remembering when reading goldens: `diskTemp: 0` means
  there is almost nothing to lens.
- The ergosphere highlight is likewise an unlabelled painted overlay.
- **Jets already exist** (`sample_relativistic_jets`), which the spec's delta
  table lists as absent — a kinematic cone with β = 0.92 (Γ ≈ 2.6) and its own
  beaming. Still missing per §1.4: the `(3−α)` counter-jet suppression,
  per-mass-preset defaults, knots, and the "kinematic model" label. Its
  beaming exponent is still `δ^3.5` and is deliberately left for milestone 3,
  where the jet is reworked as a whole.
- **The starfield is procedural**, not the ESO panorama; `public/textures/`
  ships three sky JPEGs that no source file references. **Both closed in
  milestone 8** — the panorama is in and the three unprovenanced JPEGs are
  deleted.
- `renderer.ts` sets `u_spin = params.spin * params.mass` and the shader then
  computes `a = u_spin * M`, so `a = spin·M²`. Harmless at the default M = 1,
  wrong for any other mass.
- The step budget is 256 at "ultra". A ray from a camera at r ≫ 100 M cannot
  reach the hole within that budget, so shadow geometry degrades at large
  zoom independently of the physics.
- `ReprojectionManager: Framebuffer incomplete (36054)` logs on load —
  pre-existing, unrelated to the fork.
- **The visual-regression suite is unarmed.** `tests/golden/` contains only a
  manifest, every entry has `captured_at: null`, and no PNG was ever committed
  upstream, so `bun run shader:check` skips each frame and reports 4 passed
  without comparing anything. It also spawns its own dev server on port 3000;
  use `SHADER_CHECK_SKIP_DEV=1 SHADER_CHECK_BASE_URL=http://localhost:<port>/blackhole`
  against a running server instead.

  **Playwright cannot launch a browser at all on some Windows hosts.** Not a
  sandbox artefact — it reproduces in an ordinary shell, with both
  `chrome-headless-shell` and full `chrome.exe`. Playwright passes the DevTools
  channel over inherited handles (`--remote-debugging-pipe`); when security
  software blocks that, the browser starts, answers `--version`, and the launch
  then dies on a timeout with no diagnostic. `connectOverCDP` fails the same
  way, because Playwright's transport lives in its own driver process.

  `scripts/capture-goldens-cdp.ts` is the fallback: **no Playwright**, just
  Chromium started with a TCP debugging port and driven over Bun's built-in
  WebSocket, which connects to that same endpoint in ~14 ms on the machine
  where Playwright hangs. Same outputs and manifest stamping.

  ```
  bun run dev                     # in one shell
  SHADER_CHECK_BASE_URL=http://127.0.0.1:3000/blackhole \
    bun scripts/capture-goldens-cdp.ts --confirm
  ```

  Two things that will bite anyone writing a capture harness here:

  - **A CDP target that is not fronted has its rAF throttled to nothing**, so
    a "wait N animation frames" loop hangs forever. `Page.bringToFront` plus a
    wall-clock fallback on every frame wait. Same trap as a hidden preview pane.
  - **An unsized canvas reports 300x150** (the HTML default) and screenshots
    as a blank frame. Wait for a width greater than that, nudging with a
    `resize` event, before capturing.
  - SwiftShader takes **minutes per frame** for a 256-step ray-march at
    1280x720, so CDP command timeouts must be in the ten-minute range.

  **Or capture with the `Capture shader goldens` workflow**
  (`.github/workflows/goldens.yml`, manual dispatch). Two reasons to prefer CI:

  1. *Reproducibility.* Goldens are compared by SSIM at thresholds of
     0.996–0.998. Captured against a workstation GPU they encode that driver
     and can never match a runner, which has no GPU. `capture.ts` now pins
     ANGLE to **SwiftShader** — software rasterisation, identical pixels
     anywhere — and capturing on the same class of machine that verifies them
     keeps that true. Upstream pinned `--use-angle=vulkan`, which additionally
     hangs at launch on hosts with no usable Vulkan ICD.
  2. *Playwright does not run in every sandbox.* Its driver runs
     out-of-process and could not establish a browser transport in one
     environment tried here: `--remote-debugging-pipe` timed out at launch,
     and so did `connectOverCDP` — while Bun's own WebSocket to the very same
     CDP endpoint connected in 14 ms, and the browser answered `--version`
     fine. If you hit that, `capture.ts` accepts `SHADER_CHECK_CDP_URL` to
     attach to a browser you started yourself with `--remote-debugging-port`;
     it will not help if the driver itself is what's blocked.

  Once the PNGs are committed, drop `continue-on-error` from the QA step and
  add `shader:check` to CI so the baseline actually protects the render.

## Real black hole presets (spec milestone 10)

Seven named objects, each locked to published parameters, at
`/blackhole/{slug}/`.

**Where the data lives.** `src/data/real-black-holes.json` is canonical;
`src/configs/real-black-holes.ts` types it and adapts it to the existing
`MassPreset` shape so nothing downstream (unit readouts, comfort speed, the
test object) had to learn that real objects exist. The globe's copy at
`data/black-holes.json` is generated from it by
`scripts/data/generate-black-holes.mjs`, and `validate-black-holes.mjs` fails
`npm run data:validate` if the two drift — milestone 11 reads the same numbers
this app does, by construction rather than by discipline.

**Per-field citations, per-field uncertainty.** Every quantity carries
`{value, uncertainty, source}`. The flag matters because it varies *within* a
single object: Cygnus X-1's mass is known to 10% and its spin to three
significant figures, while V404 Cygni's spin is not known at all. Three states:

| flag | meaning |
| --- | --- |
| `measured` | published value with a real error bar |
| `contested` | methods disagree beyond their stated errors; the value is one defensible choice |
| `unconstrained` | no measurement worth quoting; the value is a placeholder so the renderer has something to draw, and the UI says "not measured" |

Sgr A* and V404 Cygni are `unconstrained` in spin. GRS 1915+105 is `contested`
in both spin and inclination (reflection fits want a* = 0.98 and i ≈ 71°;
continuum fitting with the Reid distance wants lower, and the inner disk may
simply be misaligned with the orbit). Several of the spec's starting figures
moved once checked: Cyg X-1's spin to > 0.9985 (Zhao et al. 2021), GRO
J1655−40's inclination to 69 ± 2°, A0620−00's mass to 6.61 ± 0.25 M☉.

**Two deviations from the spec, both deliberate.**

1. *Inclination does not break the lock.* §6.4 says mass/spin/inclination are
   fixed and changing any one drops to "custom". Inclination is applied on
   selection, but the 3rd-person camera is free-orbiting by design — making a
   camera drag flip the badge to `CUSTOM` would train users to ignore it. The
   badge tracks spin, which is the parameter the shader reads and the user can
   actually edit. `matchesLockedParameters` carries the reasoning.
2. *The generic presets were relabelled.* §1.8's "Sgr A*" and "M87*" became
   "Supermassive (4×10⁶ M☉)" and "Ultramassive (6.5×10⁹ M☉)". Two options with
   the same name, one cited and one not, in the same dropdown, would have
   defeated the point of the citations. Ids are unchanged so URL state still
   round-trips.

**Routing.** `src/app/[object]/page.tsx` with `generateStaticParams` +
`dynamicParams = false`. Under `output: "export"` this emits
`out/<slug>/index.html` per object — confirmed against a real build, not just
`next dev`. The 1000-line `src/app/page.tsx` moved to
`src/components/fork/SimulatorApp.tsx` so both the bare route and the per-object
routes can render it; `page.tsx` is now a five-line wrapper and nothing else
changed in the move.

**Two traps worth recording.**

- `massPresetForRealBlackHole` builds a fresh object every render, so the §1.4
  jet-default effect could not keep depending on the preset object identity —
  it would have re-fired every render and its `setParams` would have made that
  a render loop. It keys on `preset.id` and `preset.jetByDefault` instead.
- `params.verticalAngle` is **not** the live camera angle. The angle lives in a
  ref inside `useCamera` and `params.verticalAngle` reports the config default
  forever, so verifying "did the inclination apply?" through `__bh.params()`
  silently always says 97°. `useCamera` gained `setPolarAngle`, and
  `window.__bh.orientation()` was added to expose the real value.

**Verification.** 16 new unit tests (`src/__tests__/physics/real-black-holes.test.ts`),
which mostly assert the *discipline* — no field without a citation, no slug
that could collide with a route, no spin outside [0, 1) — rather than the
astrophysics; 531 tests pass overall. In-browser, on the real routes: correct
parameters and inclination applied per object, `CUSTOM` on a spin change and
back to `DATA` on Restore, and the generic presets clearing the object card.

Goldens are unaffected by construction: no shader, renderer, or default-param
file is touched, and `/blackhole/?deterministic=1` still opens at spin 0.5 and
polar angle 97° with the shader compiling. The golden suite itself could not be
run here — its runner spawns `bun run dev`, which needs `wasm-pack`, and
pointing it at an already-running server instead gets a Playwright browser that
never produces a canvas in this environment.

## Physical disk colour, and an honest auto-spin (post-milestone 10)

Two corrections that came out of asking what the disk temperature actually is.

### The disk is now rendered at the temperature the UI claims

Three separate bugs were stacked here, and each one hid the next.

1. **`u_disk_temp` was not the disk's temperature.** The Novikov-Thorne radial
   profile `x^0.75 * (1 - sqrt(x))^0.25` (x = isco/r) peaks at **0.48787** at
   r = 1.361 isco, and the shader multiplied `u_disk_temp` by it directly. So
   the hottest pixel was always 0.49x whatever the UI said. The profile is now
   divided by that constant, which makes `u_disk_temp` literally the peak
   effective temperature. Everything renders 2.05x hotter than the same
   `diskTemp` value used to produce.

2. **The default was a star, not a disk.** `diskTemp` defaulted to 9,500 K,
   giving a rendered peak of ~4,600 K — the familiar orange-to-white gradient,
   and roughly the surface of a K-type star. A real Shakura-Sunyaev disk around
   a 10 solar-mass black hole peaks near **10^7 K**, about 0.86 keV, which is
   the X-ray band those objects are named for. Measured soft-state inner-disk
   temperatures for Cygnus X-1 are 0.4-0.6 keV, so the module's existing
   `peakDiskTemperatureK` (anchored 10^7 K at 10 M_sun, scaling M^-1/4, the
   correct dependence at fixed Eddington ratio) was already right to within a
   factor of ~1.5 — it just was not wired to anything. It now drives
   `diskTemp` from the selected preset or real object.

3. **`blackbody()` could not represent those temperatures.** Upstream used the
   Tanner-Helland / Mitchell Charity fit, calibrated to roughly 40,000 K. At
   10^7 K it kept driving red and green down and returned about sRGB
   (71,121,255) — a saturated blue no blackbody has. Replaced with Kim et al.
   (2002)'s cubic approximation of the Planckian locus, then CIE xy -> XYZ ->
   linear sRGB. That fit's 1/T terms vanish as T grows, so it converges on its
   own to the Rayleigh-Jeans chromaticity **xy = (0.2404, 0.2351)**, about
   sRGB (148,176,255). No clamp, no special case.

**What this looks like, and why it is not a regression.** A truthful hot disk
is nearly featureless pale blue, because every part of it — 3x10^6 K at the
outer edge to 10^7 K at the peak — sits in the same Rayleigh-Jeans tail where
chromaticity no longer changes. The colour gradient in essentially every black
hole render, this one included until now, is false colour.

What survives is the thing that matters: the delta^4 beaming is an *intensity*
effect, so the approaching/receding asymmetry the spec calls "the signature of
a real render" is untouched. Measured on a real frame at 10^7 K: left half mean
luminance 78.3 vs right half 56.6, a **1.38x brightness ratio, with identical
hue on both sides** (69,79,101 vs 50,56,79 — same ratios, different brightness).
That is exactly the physical prediction, and it is a better demonstration than
the old version gave, because previously hue and brightness were confounded.

A differential capture confirms the colour flip: mean lit-disk pixel is
(62,71,95) at 10^7 K (blue-dominant) versus (91,86,84) at 9,500 K (warm).

The false-colour look is still one slider away, and `TestObjectPanel` now says
which of the two you are looking at rather than printing a physical peak
temperature above a disk drawn at a thousandth of it.

**Deliberately not fixed:** the simulator draws a thin disk for every object,
but Sgr A* and M87* do not have one. Both are radiatively inefficient flows
(~10^-9 and ~10^-5 Eddington), geometrically thick, optically thin, and
two-temperature, radiating optically thin synchrotron from electrons at
~10^9-10^11 K rather than blackbody from a photosphere — which is why the EHT
images them at 230 GHz. The thin-disk temperature quoted for them is the right
answer to "what if this were a quasar?" and not a description of the real
object. Modelling a RIAF is a much larger job; the panel wording was narrowed
to claim only that the colour matches the stated temperature.

### Auto-spin was framerate-dependent and 50x the globe

`state.theta += spinSpeed` was applied once per *frame*, with no `dt`, while
the config labelled the unit `rad/s`. At 60 fps the default 0.005 meant
0.3 rad/s — a full revolution every 21 seconds — and the whole scene visibly
sped up or slowed down with the frame rate, which on this renderer changes with
the quality preset.

Now multiplied by the `dt` the loop already computes, and the default set to
**0.006 rad/s** to match `AUTOROTATE_RATE` in the globe's `js/app.js`: one turn
every 17.5 minutes in both apps. Measured over 9 seconds in a live frame:
0.3438 deg/s = 0.006 rad/s exactly, which also confirms the integration is
framerate-independent.

### Goldens

**All three goldens are stale and will fail** — the disk colour changed by
design. They could not be re-captured here (the capture environment cannot
produce a canvas), so `tests/visual-regression/README.md` carries a notice
explaining what changed and how to regenerate. A failure there currently
proves nothing.

## Flying to the horizon, and through it (spec §1.6)

The free camera used to stop dead well outside the black hole. Three separate
fences did it, and each was hit before the next became relevant:

1. **`MIN_ZOOM = 2.5` in `useCamera`.** `renderer.ts` sets
   `u_zoom = params.zoom * 2`, so this fenced the camera at **r = 5M** — two
   and a half Schwarzschild horizon radii — for no physical reason. This was
   the wall a user actually hit by scrolling.
2. **The dive cinematic's "horizon crossing" test, `newR < 2.0`.** Same unit
   confusion as the auto-spin bug: `newR` is a zoom value, so the test fired
   at a true radius of **4M**, twice the horizon. Worse, on reaching it the
   dive *bounced* — an animated "recovery" back out to where it started, which
   is the one trajectory a black hole does not permit.
3. **The shader's "kamikaze protection", `length(ro) < rh * 1.5`.** Silently
   teleported the free camera back out to 1.5 r_h, so the view from just above
   the horizon — where the shadow swells to swallow most of the sky — was
   unreachable even if the other two had allowed it.

### What replaced them

**A horizon-aware floor.** `minZoomFor(mass, spin)` derives the limit from the
actual Kerr horizon `r_h = M(1 + sqrt(1 - a*^2))`, which moves from 2M at zero
spin to M at extremal, plus a 2% standoff. A constant could never have
expressed that. The shader standoff drops to 1.01 r_h, and a test asserts the
UI floor stays outside it by parsing the constant out of the shader source —
if they ever cross, the camera would be silently relocated and every readout,
including the handover radius, would describe a position the render is not
using.

**Crossing became a fall.** This is the physically load-bearing part. A
hovering camera at fixed r is a static observer, and static observers exist for
every r > r_h but *nowhere* inside: r is timelike in there, nothing holds
station, everything is carried inward. So the camera cannot simply be flown
further in. Pushing inward at the floor now hands over to the infalling rider
that milestone 5 already built — which owns the tetrad, the aberration, the
redshift, the horizon crossing and the singularity card. The dive does the same
thing instead of bouncing.

The plumbing has one wrinkle worth recording: `setView("first")` refuses while
`canRideAlong` is false, and the drop it depends on is integrated
asynchronously in the physics worker, so asking for the ride in the same tick
as the drop silently does nothing. The radius is latched and an effect
completes the handover once the worldline exists.

**The plunge is paced.** The comfort speed makes one *ISCO orbit* take 30
seconds, but a fall starting at the horizon is a different timescale entirely:
from rest at r0 the remaining proper time is `(pi/2) sqrt(r0^3 / 2M)`, which at
the handover radius is 2.917 M — **0.95 wall seconds** at comfort speed. Blink
and the singularity card is already up. The handover retargets playback so the
descent takes 12 seconds. Playback only, per §1.9: the worldline is integrated
once and is identical at every speed.

### Verification

Rust (`cargo test -p gravitas-core --test worldline`, 15 pass) covers the part
that actually matters, since the handover drop starts at 1.02 r_h — far harsher
than the r = 20M start every previous test used:

- a radial fall from 1.02 r_h reaches 0.02 r_s rather than stalling at the
  horizon, with proper time matching `(pi/2) sqrt(r0^3/2M)` to 5%;
- there are samples on **both sides** of the horizon, so the crossing has
  frames to render rather than being stepped over in one jump;
- the same holds at a* = 0.9, where r_h is only 1.436 M.

In the browser: scrolling in reaches r = 1.9033 M against a horizon at
1.8660 M (spin 0.5) where it used to stop at 5M; one further push flips
`view` to `"first"` with the worldline ready at that radius; and playback is
retargeted from 1.516e-4 to 1.197e-5, a predicted ride of exactly 12.0 s.
`window.__bh.rider()` was added for this — the view toggle renders its active
state purely through Tailwind classes, so asserting on the DOM would have been
asserting on styling.

**Not verified here:** the descent actually playing on screen, and the
near-horizon view. The preview tab in this environment runs rAF at ~0.3 fps
(even `setInterval` is throttled to ~1 tick in 5 s), so the playback clock
barely advances and `captureFrame` times out waiting for a draw. The playback
path itself is milestone 5's and unchanged; what changed is where the drop
starts, which is what the Rust tests cover.

## Known gaps (not yet addressed)

- `src/app/page.tsx` carries a large `sr-only` keyword-stuffed SEO section from
  upstream. It is not false, but it is written to rank upstream's domain and
  reads oddly under wiki-globe. Trimming it is a judgement call left open.
- The Pages workflow runs `lint`/`type-check`/`test` with `continue-on-error`.
  `bun run test` is **364 passed / 1 failed** on the pristine upstream tree as
  well: `src/__tests__/shaders/manager.test.ts` asserts that any two distinct
  `FeatureToggles` compile to distinct variants, but `generateCacheKey` in
  `src/shaders/manager.ts` (byte-identical to upstream) omits
  `spacetimeVisualization`, so a pair differing only in that field shares a
  cache key. fast-check draws a fresh seed each run, so this fails
  **intermittently** — it failed twice in a row and then passed on a later
  run with the identical tree. Either the key or the test is wrong upstream;
  fix it before making the CI step blocking, and do not read a single green
  run as evidence it is fixed. `lint` is clean apart from two upstream
  unused-variable warnings in `src/components/spacetime/`.
- No build has been run against this fork yet — see the milestone-1 status note
  in `docs/todo/black-hole-simulator-spec.md`.
