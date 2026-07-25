"use client";

import { useEffect } from "react";

import { physicsBridge } from "@/engine/physics-bridge";

declare global {
  interface Window {
    __bh?: {
      crossOriginIsolated: boolean;
      transport: () => string;
      bridge: typeof physicsBridge;
    };
  }
}

/**
 * wiki-globe fork only. Console handle for the verification workflow, mirroring
 * the globe's own `window.__globe`.
 *
 * Deliberately minimal at this stage: enough to answer "did cross-origin
 * isolation take, and which physics transport came up" for the milestone-1
 * deployment check. Ray/integrator probes (`debugRay`, integrator access) land
 * with the physics audit in milestone 2.
 */
export function DebugHooks() {
  useEffect(() => {
    window.__bh = {
      crossOriginIsolated: window.crossOriginIsolated,
      transport: () => physicsBridge.getTransport(),
      bridge: physicsBridge,
    };
  }, []);

  return null;
}
