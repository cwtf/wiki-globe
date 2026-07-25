/**
 * Relativistic jet model — wiki-globe fork (spec §1.4).
 *
 * The launch mechanism (Blandford-Znajek) is NOT simulated: that needs
 * magnetised GRMHD. What is modelled is a **kinematic** conical outflow whose
 * emission is then traced through the same geodesic kernel and the same shift
 * factors as the disk, so the observable signatures — one-sidedness, the
 * lensed counter-jet base, superluminal knot motion — emerge rather than being
 * painted on. The UI must keep saying "kinematic model" for exactly this
 * reason.
 *
 * These constants live in TS rather than inline in the GLSL string so the
 * beaming maths can be unit-tested (`src/__tests__/physics/jet-beaming.test.ts`)
 * and so the shader and the tests cannot drift apart.
 */

export const JET_CONFIG = {
  /**
   * Bulk Lorentz factor. Spec §1.4 asks for Γ ≈ 5–10; 5 keeps the counter-jet
   * suppressed by ~3 orders of magnitude near the axis without making the
   * approaching side blow out the tone mapper.
   */
  lorentzFactor: 5.0,

  /** Half-opening angle of the cone, degrees. Spec §1.4: ~5–10°. */
  openingAngleDeg: 7.0,

  /**
   * Spectral index α in I_ν ∝ ν^(−α), which sets the beaming exponent 3 − α.
   *
   * α = −1 gives exponent 4, i.e. the bolometric δ⁴ that Liouville's theorem
   * requires and that §1.3 makes non-negotiable for the disk — the jet uses
   * the same law so the two are mutually consistent. A band-limited
   * synchrotron render would instead use α ≈ 0.7 (exponent 2.3); the §4
   * counter-jet check is written against whatever value is set here.
   */
  spectralIndex: -1.0,

  /** Emissivity falls as r^(−emissivityExponent). Spec §1.4: ~r⁻². */
  emissivityExponent: 2.0,

  /** Cone starts this many horizon radii above the pole. */
  baseHeightInHorizons: 1.8,

  /** Cone radius at its base, in M. */
  baseRadius: 0.35,

  /** Axial spacing of emission knots, in M. */
  knotSpacing: 6.0,

  /** Knot density contrast, 0 = smooth flow. */
  knotContrast: 0.45,

  /** Wall-clock → simulation time scale for knot advection. */
  knotTimeScale: 0.6,

  /** Overall emission scale, tuned so the jet reads against the disk. */
  brightness: 0.05,
} as const;

/** Bulk speed β from the Lorentz factor. */
export function betaFromLorentz(gamma: number): number {
  return Math.sqrt(Math.max(0, 1 - 1 / (gamma * gamma)));
}

/** Relativistic Doppler factor δ = 1 / (Γ(1 − β cosθ)). */
export function dopplerFactor(
  beta: number,
  cosTheta: number,
  gamma = 1 / Math.sqrt(1 - beta * beta),
): number {
  return 1 / (gamma * (1 - beta * cosTheta));
}

/** Beaming exponent 3 − α. */
export function beamingExponent(spectralIndex: number): number {
  return 3 - spectralIndex;
}

/**
 * Approaching/receding intensity ratio at viewing angle θ from the jet axis:
 *
 *   [(1 + β cosθ) / (1 − β cosθ)]^(3 − α)
 *
 * This is the §4 verification target. Γ cancels, so the ratio depends only on
 * β, θ and α.
 */
export function jetCounterJetRatio(
  beta: number,
  cosTheta: number,
  spectralIndex: number,
): number {
  const n = beamingExponent(spectralIndex);
  return Math.pow((1 + beta * cosTheta) / (1 - beta * cosTheta), n);
}

/**
 * Apparent transverse speed of an emission knot, in units of c:
 *
 *   β_app = β sinθ / (1 − β cosθ)
 *
 * Exceeds 1 for small θ — the classic superluminal illusion.
 */
export function apparentKnotSpeed(beta: number, thetaRad: number): number {
  return (
    (beta * Math.sin(thetaRad)) / (1 - beta * Math.cos(thetaRad))
  );
}

/** Viewing angle that maximises β_app, cosθ = β. */
export function maxApparentSpeedAngle(beta: number): number {
  return Math.acos(beta);
}

const BETA = betaFromLorentz(JET_CONFIG.lorentzFactor);

/** Values injected into the GLSL jet chunk. Keep in sync by construction. */
export const JET_SHADER_CONSTANTS = {
  gamma: JET_CONFIG.lorentzFactor,
  beta: BETA,
  tanTheta: Math.tan((JET_CONFIG.openingAngleDeg * Math.PI) / 180),
  baseRadius: JET_CONFIG.baseRadius,
  baseHeight: JET_CONFIG.baseHeightInHorizons,
  beamExponent: beamingExponent(JET_CONFIG.spectralIndex),
  emissivityExponent: JET_CONFIG.emissivityExponent,
  knotSpacing: JET_CONFIG.knotSpacing,
  knotContrast: JET_CONFIG.knotContrast,
  knotTimeScale: JET_CONFIG.knotTimeScale,
  brightness: JET_CONFIG.brightness,
} as const;
