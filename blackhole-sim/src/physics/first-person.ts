/**
 * First-person ray construction through the observer's tetrad (spec §1.6, §5).
 *
 * wiki-globe fork. §5: "1st-person correctness lives or dies on the tetrad:
 * build it once (static frame + boost), generate rays only through it. Ad-hoc
 * per-effect 'redshift shaders' are how it becomes a toy."
 *
 * So there is no aberration function in the render path, and no Doppler
 * function either. A pixel's ray is built as
 *
 * ```text
 *   p = e_0 + n_x e_1 + n_y e_2 + n_z e_3
 * ```
 *
 * where `n` is the unit look direction in the observer's own frame. Because
 * `e_0` is the *moving* observer's time leg, adding it tilts every direction
 * toward the motion — that tilt IS relativistic aberration, and it appears
 * without anything in this file mentioning aberration. The same construction
 * yields the observed frequency, so Doppler and gravitational shift come from
 * the same place.
 */

export type Vec3 = [number, number, number];

/** A tetrad flattened row-major from Rust: `e[a][mu]`, 16 numbers. */
export type TetradArray = ArrayLike<number>;

/** One frame leg resolved into the shader's Cartesian world frame. */
export interface CartesianLeg {
  /** Spatial part, in the shader's Y-up Cartesian axes. */
  spatial: Vec3;
  /** Time component `e_(a)^t`, kept for the frequency shift. */
  time: number;
}

export interface CartesianTetrad {
  e0: CartesianLeg;
  e1: CartesianLeg;
  e2: CartesianLeg;
  e3: CartesianLeg;
}

/**
 * Coordinate basis vectors at (r, theta, phi), expressed in the shader's
 * Cartesian axes.
 *
 * The shader uses Y as the spin axis, so
 * `x = r sin(theta) cos(phi)`, `y = r cos(theta)`, `z = r sin(theta) sin(phi)`.
 * These are the partial derivatives of that map — note they are NOT unit
 * vectors: `d/dtheta` scales with r and `d/dphi` with r sin(theta), which is
 * exactly what makes the tetrad components come out dimensionally right.
 */
export function coordinateBasis(
  r: number,
  theta: number,
  phi: number,
): { dr: Vec3; dtheta: Vec3; dphi: Vec3 } {
  const st = Math.sin(theta);
  const ct = Math.cos(theta);
  const sp = Math.sin(phi);
  const cp = Math.cos(phi);

  return {
    dr: [st * cp, ct, st * sp],
    dtheta: [r * ct * cp, -r * st, r * ct * sp],
    dphi: [-r * st * sp, 0, r * st * cp],
  };
}

/** Position in the shader's Cartesian frame. */
export function toCartesian(r: number, theta: number, phi: number): Vec3 {
  const st = Math.sin(theta);
  return [r * st * Math.cos(phi), r * Math.cos(theta), r * st * Math.sin(phi)];
}

/**
 * Resolve a coordinate-basis tetrad into Cartesian legs.
 *
 * `tetrad[a * 4 + mu]` with mu ordered (t, r, theta, phi).
 */
export function tetradToCartesian(
  tetrad: TetradArray,
  r: number,
  theta: number,
  phi: number,
): CartesianTetrad {
  const { dr, dtheta, dphi } = coordinateBasis(r, theta, phi);

  const leg = (a: number): CartesianLeg => {
    const et = tetrad[a * 4] ?? 0;
    const er = tetrad[a * 4 + 1] ?? 0;
    const eth = tetrad[a * 4 + 2] ?? 0;
    const eph = tetrad[a * 4 + 3] ?? 0;
    return {
      spatial: [
        er * dr[0] + eth * dtheta[0] + eph * dphi[0],
        er * dr[1] + eth * dtheta[1] + eph * dphi[1],
        er * dr[2] + eth * dtheta[2] + eph * dphi[2],
      ],
      time: et,
    };
  };

  return { e0: leg(0), e1: leg(1), e2: leg(2), e3: leg(3) };
}

export interface FirstPersonRay {
  /** Direction to march, in the shader's Cartesian frame (unit length). */
  direction: Vec3;
  /** Contravariant time component `p^t` of the photon. */
  timeComponent: number;
}

/**
 * Build the photon direction for a look direction `n` in the observer's frame.
 *
 * `n` must be a unit vector; it is the direction the observer is looking,
 * already including any free-look rotation. Free-look belongs here — applied
 * to `n` *inside* the frame, before this combination — because rotating the
 * final world-space ray instead would rotate the aberration pattern along with
 * the view, which is precisely the "toy" failure §5 warns about.
 */
export function buildRay(frame: CartesianTetrad, n: Vec3): FirstPersonRay {
  const sx: Vec3 = frame.e1.spatial;
  const sy: Vec3 = frame.e2.spatial;
  const sz: Vec3 = frame.e3.spatial;
  const s0: Vec3 = frame.e0.spatial;

  const px = s0[0] + n[0] * sx[0] + n[1] * sy[0] + n[2] * sz[0];
  const py = s0[1] + n[0] * sx[1] + n[1] * sy[1] + n[2] * sz[1];
  const pz = s0[2] + n[0] * sx[2] + n[1] * sy[2] + n[2] * sz[2];

  const len = Math.hypot(px, py, pz) || 1;

  return {
    direction: [px / len, py / len, pz / len],
    timeComponent:
      frame.e0.time +
      n[0] * frame.e1.time +
      n[1] * frame.e2.time +
      n[2] * frame.e3.time,
  };
}

/**
 * Ratio of observed to emitted frequency for light from a static source at
 * infinity, arriving along this ray.
 *
 * The photon's conserved energy is `E = -p_t = (1 - r_s/r) p^t` in
 * Schwarzschild; the observer measures unit frequency by construction (the
 * frame-time component of `p` is 1), so the shift is `1/E`. Greater than 1 is
 * a blueshift.
 *
 * Both the gravitational and the Doppler parts are in here at once, because
 * `p^t` already carries the observer's motion through `e_0`.
 */
export function frequencyShift(
  ray: FirstPersonRay,
  r: number,
  rs: number,
): number {
  const lapse = 1 - rs / r;
  const energy = lapse * ray.timeComponent;
  if (!(Math.abs(energy) > 1e-12)) return 0;
  return 1 / energy;
}

/** Rotate a vector by a unit quaternion (x, y, z, w) — the free-look input. */
export function rotateByQuaternion(
  v: Vec3,
  q: [number, number, number, number],
): Vec3 {
  const [qx, qy, qz, qw] = q;
  // t = 2 * (q_vec x v); v' = v + qw * t + q_vec x t
  const tx = 2 * (qy * v[2] - qz * v[1]);
  const ty = 2 * (qz * v[0] - qx * v[2]);
  const tz = 2 * (qx * v[1] - qy * v[0]);
  return [
    v[0] + qw * tx + (qy * tz - qz * ty),
    v[1] + qw * ty + (qz * tx - qx * tz),
    v[2] + qw * tz + (qx * ty - qy * tx),
  ];
}

/**
 * Fixed field of view for the 1st-person camera, as the tangent of the
 * half-angle used to build look directions.
 *
 * Spec §2.4 requires this be fixed and stated: a variable FOV would change the
 * apparent compression of the sky and masquerade as aberration, which is the
 * one effect this view exists to show honestly.
 */
export const FIRST_PERSON_FOCAL_LENGTH = 1.2;

/**
 * Which frame leg the camera should treat as right / up / forward.
 *
 * A tetrad fixes no preferred spatial orientation — any rotation of the three
 * spatial legs is an equally valid frame — so the camera has to choose one,
 * and choosing wrongly is not a physics error but it does point the viewer at
 * empty sky. Gram-Schmidt fills the legs in whatever order succeeds
 * (radial, then azimuthal, then polar, with fallbacks when a candidate is
 * degenerate), so the order cannot be assumed: a radially infalling observer
 * produces a different assignment from an orbiting one.
 *
 * The legs are therefore identified by what they physically are, using their
 * coordinate components: `e[a][1]` is the ∂r part, `e[a][2]` the ∂θ part,
 * `e[a][3]` the ∂φ part. Forward is taken as **inward radial**, so the hole is
 * on screen when the ride begins; up is the polar axis; right completes it.
 *
 * Returns leg indices (1..3) and signs.
 */
export function orientFrame(tetrad: TetradArray): {
  right: { index: number; sign: number };
  up: { index: number; sign: number };
  forward: { index: number; sign: number };
} {
  const component = (a: number, mu: number) => Math.abs(tetrad[a * 4 + mu] ?? 0);

  const pick = (mu: number, used: Set<number>) => {
    let best = -1;
    let bestVal = -1;
    for (let a = 1; a <= 3; a++) {
      if (used.has(a)) continue;
      const v = component(a, mu);
      if (v > bestVal) {
        bestVal = v;
        best = a;
      }
    }
    return best;
  };

  const used = new Set<number>();
  const radial = pick(1, used);
  used.add(radial);
  const polar = pick(2, used);
  used.add(polar);
  let azimuthal = -1;
  for (let a = 1; a <= 3; a++) if (!used.has(a)) azimuthal = a;

  // Forward points inward: flip if this leg's ∂r component is positive
  // (outward).
  const radialSign = (tetrad[radial * 4 + 1] ?? 0) >= 0 ? -1 : 1;

  return {
    right: { index: azimuthal, sign: 1 },
    up: { index: polar, sign: 1 },
    forward: { index: radial, sign: radialSign },
  };
}

/** Look direction for a normalised screen coordinate, before free-look. */
export function lookDirection(u: number, v: number): Vec3 {
  const len = Math.hypot(u, v, FIRST_PERSON_FOCAL_LENGTH) || 1;
  return [u / len, v / len, FIRST_PERSON_FOCAL_LENGTH / len];
}
