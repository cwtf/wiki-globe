/**
 * Cross-origin isolation shim (wiki-globe fork).
 *
 * GitHub Pages cannot set response headers, and SharedArrayBuffer — which the
 * physics/render pipeline uses for its zero-copy telemetry block — is only
 * exposed to cross-origin-isolated documents. A service worker can synthesise
 * the missing COOP/COEP headers on every response it serves, which is enough
 * for the browser to isolate the page on the *next* navigation.
 *
 * Same idea as the widely used `coi-serviceworker` package, reimplemented here
 * so the fork carries no extra runtime dependency and so the scope stays
 * pinned under the sub-app's basePath: this file is served from
 * `/blackhole/coi-serviceworker.js`, so its default scope is `/blackhole/`
 * and it never intercepts the Cesium globe at `/`.
 *
 * The first load of a session is NOT isolated (no worker is controlling the
 * page yet). That is why the non-SAB fallback in `src/engine/physics-bridge.ts`
 * is a hard requirement, not an optimisation — see FORK.md.
 *
 * Registration lives in `src/components/fork/CrossOriginIsolation.tsx`.
 */

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) =>
  event.waitUntil(self.clients.claim()),
);

self.addEventListener("fetch", (event) => {
  const request = event.request;

  // `only-if-cached` is only legal with same-origin mode; re-issuing it any
  // other way throws, so leave those requests entirely alone.
  if (request.cache === "only-if-cached" && request.mode !== "same-origin") {
    return;
  }

  event.respondWith(
    fetch(
      // Cross-origin subresources must come back opaque for COEP:require-corp
      // to accept them, since third-party hosts do not send CORP headers.
      request.mode === "no-cors"
        ? new Request(request, { mode: "no-cors", credentials: "omit" })
        : request,
    )
      .then((response) => {
        // Opaque and error responses have immutable, unreadable headers.
        if (response.status === 0) return response;

        const headers = new Headers(response.headers);
        headers.set("Cross-Origin-Embedder-Policy", "require-corp");
        headers.set("Cross-Origin-Opener-Policy", "same-origin");
        // Same-origin assets must opt in to embedding under require-corp.
        headers.set("Cross-Origin-Resource-Policy", "same-origin");

        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      })
      // A failed fetch here would otherwise surface as a confusing service
      // worker error rather than the network error it actually is.
      .catch((err) => {
        console.error("coi-serviceworker:", err);
        throw err;
      }),
  );
});
