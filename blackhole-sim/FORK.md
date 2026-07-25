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

## Upstream files deleted

| Path | Why |
| --- | --- |
| `.github/workflows/production.yml` | deploys to upstream's Vercel project with their secrets |
| `vercel.json`, `scripts/vercel-build.sh` | Vercel-only build path (its `RUSTFLAGS=-C target-feature=+bulk-memory` and `CARGO_BUILD_JOBS=1` are carried into the Pages workflow) |
| `lefthook.yml` | git hooks would install into the parent wiki-globe repo |
| `scripts/indexnow-ping.ts` | pings search engines for upstream's domain |
| `src/app/robots.ts`, `src/app/sitemap.ts` | `robots.txt` is only honoured at the origin root; the globe's root `robots.txt` / `sitemap.xml` own site-wide SEO |
| `src/app/google71f68cb94e351e26.html`, `public/c9f345b7cd2d289e01df73e6ca6c86e8.txt` | Search Console / IndexNow ownership proofs for upstream's domain |

## Known gaps (not yet addressed)

- `src/app/page.tsx` carries a large `sr-only` keyword-stuffed SEO section from
  upstream. It is not false, but it is written to rank upstream's domain and
  reads oddly under wiki-globe. Trimming it is a judgement call left open.
- The Pages workflow runs `lint`/`type-check`/`test` with `continue-on-error`
  until the fork is verified green in CI.
- No build has been run against this fork yet — see the milestone-1 status note
  in `docs/todo/black-hole-simulator-spec.md`.
