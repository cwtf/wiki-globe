/**
 * Draggable orbits: the *preview* half (spec §6.3, milestone 9).
 *
 * wiki-globe fork. Everything relativistic about an apsis pair lives in Rust
 * (`physics/apsides.rs`) and is reached through `physicsBridge.solveApsides`.
 * What is here is deliberately only what must run at pointer-move rate:
 *
 * - the **Newtonian ellipse** drawn while a handle is being dragged, which §6.3
 *   asks for explicitly ("preview the ellipse during the drag with a cheap
 *   Newtonian approximation clearly marked as a preview"), because
 *   re-integrating a geodesic per pointer-move is not affordable;
 * - the arithmetic converting a screen drag into a radius.
 *
 * The preview is wrong on purpose, and the UI says so. A real orbit precesses:
 * the drawn ellipse closes, and the integrated one does not. That gap is
 * visible the instant the drag ends and the true trajectory replaces it, which
 * is a better demonstration of relativistic precession than any label.
 */

export interface ApsisPair {
  /** Inner turning point, in units of M. */
  periapsis: number;
  /** Outer turning point, in units of M. */
  apoapsis: number;
}

/** Order a dragged pair. §6.3: dragging one handle past the other swaps them. */
export function orderApsides(a: number, b: number): ApsisPair {
  return { periapsis: Math.min(a, b), apoapsis: Math.max(a, b) };
}

/** Eccentricity of the Newtonian ellipse through a pair of apsides. */
export function eccentricity({ periapsis, apoapsis }: ApsisPair): number {
  const sum = apoapsis + periapsis;
  return sum > 0 ? (apoapsis - periapsis) / sum : 0;
}

/** Semi-latus rectum of the Newtonian ellipse, in units of M. */
export function semiLatusRectum({ periapsis, apoapsis }: ApsisPair): number {
  const sum = apoapsis + periapsis;
  return sum > 0 ? (2 * apoapsis * periapsis) / sum : 0;
}

/**
 * Points on the Newtonian ellipse, in the shader's equatorial Cartesian frame
 * (`x = r cos φ`, `y = 0`, `z = r sin φ`), matching `Worldline.toCartesian`.
 *
 * The **apoapsis is placed at φ = 0** because that is where the integrator
 * launches the object — `initial_state` releases it at the outer turning point
 * with `x[3] = 0`. Putting the periapsis there instead (the usual convention
 * for `r = p / (1 + e cos φ)`) would draw a preview rotated half a turn from
 * the trajectory that follows, and the handles would jump on drop.
 */
export function newtonianEllipse(
  pair: ApsisPair,
  segments = 128,
): [number, number, number][] {
  const e = eccentricity(pair);
  const p = semiLatusRectum(pair);
  const points: [number, number, number][] = [];
  for (let i = 0; i <= segments; i++) {
    const phi = (i / segments) * Math.PI * 2;
    // r = p / (1 - e cos φ): apoapsis at φ = 0, periapsis at φ = π.
    const denominator = 1 - e * Math.cos(phi);
    if (denominator <= 1e-6) continue;
    const r = p / denominator;
    points.push([r * Math.cos(phi), 0, r * Math.sin(phi)]);
  }
  return points;
}

/**
 * Where the two handles sit, in the same frame. Apoapsis at φ = 0, periapsis
 * at φ = π — the two ends of the ellipse's major axis.
 */
export function apsisHandlePositions(pair: ApsisPair): {
  apoapsis: [number, number, number];
  periapsis: [number, number, number];
} {
  return {
    apoapsis: [pair.apoapsis, 0, 0],
    periapsis: [-pair.periapsis, 0, 0],
  };
}

/**
 * Drag limits, in M.
 *
 * The inner limit is *not* the ISCO or the separatrix: §6.3 is explicit that a
 * periapsis inside the separatrix must plunge rather than be prevented, and
 * dragging to the middle is how you ask for a radial free fall. The only real
 * floor is the horizon, and even that is allowed — a periapsis below it is a
 * capture, which is a thing the simulator should be able to show.
 */
export const APSIS_DRAG_LIMITS = { min: 0.2, max: 400 } as const;

/** Clamp a dragged radius into the range the panel can represent. */
export function clampApsis(r: number): number {
  if (!Number.isFinite(r)) return APSIS_DRAG_LIMITS.min;
  return Math.min(APSIS_DRAG_LIMITS.max, Math.max(APSIS_DRAG_LIMITS.min, r));
}
