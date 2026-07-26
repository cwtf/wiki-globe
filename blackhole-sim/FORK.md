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

## Upstream files modified

| Path | Change | Why |
| --- | --- | --- |
| `next.config.mjs` | static export, `basePath`, `trailingSlash`, `images.unoptimized`; `headers()` gated to dev | GitHub Pages sub-path deployment |
| `package.json` | dropped `build:vercel`, `seo:ping`, `postinstall` | Vercel-only; `lefthook install` would write git hooks into the *wiki-globe* repo |
| `src/app/layout.tsx` | self-referential URLs → `SITE_URL`; Search Console token removed; `SearchAction` dropped; icons via `asset()`; mounts `CrossOriginIsolation` | upstream's SEO identity points at their domain — publishing it here would claim another site's identity |
| `src/app/manifest.ts` | `start_url`/`scope`/icon paths via `BASE_PATH` | manifest members are plain strings, unaffected by `basePath` |
| `src/app/page.tsx` | mounts `BackToGlobe` + `DebugHooks`; top-bar `pt` enlarged to clear the back pill; citation block points at the upstream repo | fork navigation + honest citation |
| `src/engine/physics-bridge.ts` | fallback terminates the orphaned worker and nulls `worker`/`sab`; records `transport`; `console.error` → `console.warn` | the worker is constructed *before* the SAB throw, so the fallback leaked a live thread; the fallback is an expected state, not an error |
| `src/shaders/blackhole/chunks/metric.ts` | removed the Newtonian `M/r²` term from the null-geodesic force | shadow was 49.7% too large — see the physics audit below |
| `src/shaders/blackhole/chunks/disk.ts` | beaming exponent `δ^3.5` → `δ⁴`; `sample_relativistic_jets` rewritten against §1.4 | spec §1.3 requires exact `g⁴`; see the jets section below |
| `src/shaders/blackhole/fragment.glsl.ts` | pass `rs` into the jet sampler | jet emission now carries the gravitational shift |
| `src/configs/simulation.config.ts` | `diskSize` default 50 → 24, unit `Rs` → `M` | the value multiplies M, so the old label was off by 2×; §1.3 wants ~12 r_s |
| `src/components/ui/ControlPanel.tsx` | jets toggle labelled "(kinematic)"; brand logo via `asset()` | §1.4/§5 require stating that the launch mechanism is not simulated; `images.unoptimized` emits the src verbatim so basePath is not applied |
| `src/components/ui/IdentityHUD.tsx` | brand logo via `asset()` | same: `/brand-logo.png` 404s under `/blackhole` |
| `tests/visual-regression/capture.ts` | ANGLE backend configurable, default SwiftShader; optional `SHADER_CHECK_CDP_URL` | upstream's `vulkan` hangs where no Vulkan ICD exists, and GPU-captured goldens are not reproducible |

## Upstream files deleted

| Path | Why |
| --- | --- |
| `.github/workflows/production.yml` | deploys to upstream's Vercel project with their secrets |
| `vercel.json`, `scripts/vercel-build.sh` | Vercel-only build path (its `RUSTFLAGS=-C target-feature=+bulk-memory` and `CARGO_BUILD_JOBS=1` are carried into the Pages workflow) |
| `lefthook.yml` | git hooks would install into the parent wiki-globe repo |
| `scripts/indexnow-ping.ts` | pings search engines for upstream's domain |
| `src/app/robots.ts`, `src/app/sitemap.ts` | `robots.txt` is only honoured at the origin root; the globe's root `robots.txt` / `sitemap.xml` own site-wide SEO |
| `src/app/google71f68cb94e351e26.html`, `public/c9f345b7cd2d289e01df73e6ca6c86e8.txt` | Search Console / IndexNow ownership proofs for upstream's domain |

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

**Outstanding for milestone 5:** the React wiring that computes the frame each
frame from the worldline and sets `renderer.firstPerson`, the view toggle
(1st person enabled only while an object is falling), free-look input, the
proper-time playback clock, and the singularity ending card at r ≈ 0.02 r_s
with the final τ. **Nothing in the 1st-person view has been seen rendering** —
it compiles and the maths is tested, that is all.

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

**Fixed.** `?deterministic=1` (see `src/configs/capture-mode.ts`) skips
calibration outright — rather than ending it, since `finalizeCalibration()`
would still pick a tier from measured frame times — pins `rayTracingQuality` to
`ultra`, and forces render scale to 1.0 with the PID bypassed. Applied in
`PerformanceMonitor.setDeterministic()` before the first frame, and at the
single point in `renderer.ts` where the quality tier feeds both the shader
variant and the step budget. The capture script appends the flag automatically.

Ordinary visitors are unaffected: the flag is opt-in and absent by default.

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

  **The rendered goldens show this failing.** At a = 0 and a = 0.5 the ring is
  crisp; at a = 0.99 edge-on it is *absent* — the shadow has no rim at all.
  That is what a single-radius glow test does when the real critical curve
  stops being a circle: `r_ph` is the prograde photon sphere (~1.2M at this
  spin) while the retrograde side sits near 4M, so the painted ring matches
  neither. An emergent ring would simply deform into the D-shape instead of
  disappearing. Good evidence that the glow has to go rather than be tuned.
- The ergosphere highlight is likewise an unlabelled painted overlay.
- **Jets already exist** (`sample_relativistic_jets`), which the spec's delta
  table lists as absent — a kinematic cone with β = 0.92 (Γ ≈ 2.6) and its own
  beaming. Still missing per §1.4: the `(3−α)` counter-jet suppression,
  per-mass-preset defaults, knots, and the "kinematic model" label. Its
  beaming exponent is still `δ^3.5` and is deliberately left for milestone 3,
  where the jet is reworked as a whole.
- **The starfield is procedural**, not the ESO panorama; `public/textures/`
  ships three sky JPEGs that no source file references.
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
