"use client";

import { PARENT_APP_URL } from "@/configs/deployment.config";

/**
 * wiki-globe fork only. The simulator is a separate statically exported app,
 * not a Cesium layer, so returning to the globe is a plain navigation rather
 * than a focus change. Browser back works too; this is the visible affordance
 * for users who arrived by typing the URL.
 *
 * Rendered outside the collapsible HUD so it stays available when the rest of
 * the interface is hidden (the `H` shortcut) — hiding the controls should not
 * strand the user in the sub-app.
 */
export function BackToGlobe() {
  return (
    <a
      href={PARENT_APP_URL}
      className="fixed top-3 left-4 z-[60] flex items-center gap-2 rounded-full border border-white/10 bg-black/40 px-3.5 py-1.5 font-mono text-[9px] uppercase tracking-[0.2em] text-white/60 backdrop-blur-md transition-colors hover:border-white/30 hover:text-white/90"
      aria-label="Return to the Wiki Globe interactive globe"
    >
      <span aria-hidden="true">&larr;</span>
      <span>Wiki Globe</span>
    </a>
  );
}
