"use client";

import { useEffect } from "react";

import { BASE_PATH } from "@/configs/deployment.config";

const RELOAD_FLAG = "coi-reloaded";

/**
 * wiki-globe fork only. Registers `public/coi-serviceworker.js` so the page
 * becomes cross-origin isolated on GitHub Pages, where response headers cannot
 * be set (see next.config.mjs and FORK.md).
 *
 * Renders nothing. Deliberately does *not* block or gate the app: the very
 * first load of a session is uncontrolled and therefore not isolated, and the
 * simulator must render correctly in that state via the main-thread WASM
 * fallback in `src/engine/physics-bridge.ts`. The one reload below upgrades
 * the session to the SharedArrayBuffer path; it is guarded by a sessionStorage
 * flag so a browser that refuses isolation cannot be put into a reload loop.
 */
export function CrossOriginIsolation() {
  useEffect(() => {
    // Dev server sets COOP/COEP itself; nothing to shim.
    if (window.crossOriginIsolated) return;
    if (!("serviceWorker" in navigator)) return;

    let cancelled = false;

    navigator.serviceWorker
      .register(`${BASE_PATH}/coi-serviceworker.js`)
      .then((registration) => {
        if (cancelled) return;

        // Already controlling but still not isolated means the browser has
        // declined isolation (or an extension strips the headers). Reloading
        // would not change that, so stop here and let the fallback carry it.
        if (navigator.serviceWorker.controller) return;

        if (sessionStorage.getItem(RELOAD_FLAG)) return;
        sessionStorage.setItem(RELOAD_FLAG, "1");

        registration.addEventListener("updatefound", () => {
          const installing = registration.installing;
          if (!installing) return;
          installing.addEventListener("statechange", () => {
            if (installing.state === "activated") window.location.reload();
          });
        });

        // The worker may already be active from a previous visit even though
        // this document was loaded uncontrolled — reload immediately in that
        // case rather than waiting for an `updatefound` that never fires.
        if (registration.active) window.location.reload();
      })
      .catch((err) => {
        // Non-fatal: the app runs single-threaded without isolation.
        console.warn("Cross-origin isolation unavailable:", err);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return null;
}
