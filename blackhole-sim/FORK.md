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
| `src/components/ui/ControlPanel.tsx` | jets toggle labelled "(kinematic)" | §1.4/§5 require stating that the launch mechanism is not simulated |

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
  against a running server instead. Capturing goldens now would fix the
  baseline *after* the geodesic correction — do it before milestone 3 so the
  jet/disk work has something to regress against.

## Known gaps (not yet addressed)

- `src/app/page.tsx` carries a large `sr-only` keyword-stuffed SEO section from
  upstream. It is not false, but it is written to rank upstream's domain and
  reads oddly under wiki-globe. Trimming it is a judgement call left open.
- The Pages workflow runs `lint`/`type-check`/`test` with `continue-on-error`.
  `bun run test` is **364 passed / 1 failed** on the pristine upstream tree as
  well: `src/__tests__/shaders/manager.test.ts` asserts that any two distinct
  `FeatureToggles` compile to distinct variants, but `generateCacheKey` in
  `src/shaders/manager.ts` (byte-identical to upstream) omits
  `spacetimeVisualization`, so fast-check reliably finds a pair that shares a
  cache key. Either the key or the test is wrong upstream. Fix that before
  making the CI step blocking. `lint` is clean apart from two upstream
  unused-variable warnings in `src/components/spacetime/`.
- No build has been run against this fork yet — see the milestone-1 status note
  in `docs/todo/black-hole-simulator-spec.md`.
