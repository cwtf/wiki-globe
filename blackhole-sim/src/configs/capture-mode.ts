/**
 * Deterministic capture mode (wiki-globe fork).
 *
 * The renderer adapts itself to the machine it is running on in two ways:
 *
 *   - `PERFORMANCE_CONFIG.calibration.durationMs` — a 3 s stress test at
 *     startup picks a ray-tracing quality tier from measured frame times;
 *   - `PERFORMANCE_CONFIG.resolution.enableDynamicScaling` — a PID controller
 *     then rescales render resolution between 0.5x and 2.0x to hold a frame
 *     budget.
 *
 * Both are the right behaviour for a visitor and fatal for a visual-regression
 * baseline: the same scene renders differently depending on how loaded the
 * machine was in its first seconds. Two goldens captured seconds apart in one
 * session came out at different quality tiers, which is why this exists.
 *
 * With `?deterministic=1` the app pins quality and resolution and skips
 * calibration, so a capture is reproducible on any machine. Nothing changes
 * for ordinary visitors — the flag is opt-in and off by default.
 */

import type { RayTracingQuality } from "@/types/features";

/** Quality tier every deterministic capture renders at. */
export const CAPTURE_QUALITY: RayTracingQuality = "ultra";

/** Render scale every deterministic capture renders at. */
export const CAPTURE_RENDER_SCALE = 1.0;

/**
 * Whether this page load is a deterministic capture.
 *
 * Read from the query string rather than the hash, because the hash is
 * already owned by `useUrlState` for simulation parameters and round-trips
 * through it; the two must not interfere.
 */
export function isDeterministicCapture(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return new URLSearchParams(window.location.search).get("deterministic") === "1";
  } catch {
    return false;
  }
}
