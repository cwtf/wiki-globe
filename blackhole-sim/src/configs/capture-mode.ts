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
 * Simulation clock every deterministic capture renders at.
 *
 * `u_time` advances once per rendered frame and drives the disk's rotation
 * phase, the jet knot positions, the jet turbulence field, and the starfield
 * twinkle. So without pinning it, the captured image depends on how many
 * frames the machine managed to render before the screenshot — which is the
 * same machine-speed dependency the quality tier had, arriving by a different
 * route. Pinning quality and resolution alone still produced goldens that
 * differed byte-for-byte between runs; this is what closed that gap.
 *
 * Non-zero so the turbulence and rotation fields are sampled somewhere
 * representative rather than at their t = 0 origin.
 */
export const CAPTURE_TIME = 10.0;

/**
 * One more thing a capture has to wait for: the sky.
 *
 * The Milky Way panorama (spec §6.2) is fetched and uploaded asynchronously,
 * and until it arrives the shader draws the procedural starfield instead. A
 * screenshot taken in that window records a different image with no flag to
 * say so — the same "depends on how fast the machine was" failure that the
 * quality tier, the simulation clock and TAA each produced in turn. Nothing
 * here can pin it, because it is a network fetch; the capture harness must
 * poll `window.__bh.skybox() === "ready"` before shooting.
 */
export const CAPTURE_REQUIRES_SKYBOX = true;

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
