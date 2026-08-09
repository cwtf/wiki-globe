/**
 * Mass presets and physical-unit conversion (spec §1.8, §1.9).
 *
 * wiki-globe fork. The renderer is mass-invariant: everything is computed in
 * geometric units with G = c = M = 1, so the *picture* does not change with
 * the preset at all. What changes is what the numbers mean — kilometres,
 * seconds, kelvin, and how violently the tides pull. This module is that
 * translation layer and nothing else; nothing here feeds the shader.
 *
 * Keeping it pure also keeps it testable, which matters because the spec
 * states several of these values outright (4.5 ms, 31 min, 34 days for the
 * ISCO periods; 1.5e-4x, 60x, 1e5x for the comfort speeds) and the tests
 * below assert against those rather than against whatever the code happens
 * to produce.
 */

/** Newtonian constant, m^3 kg^-1 s^-2. */
const G = 6.6743e-11;
/** Speed of light, m/s. */
const C = 2.99792458e8;
/** Solar mass, kg. */
const M_SUN = 1.98847e30;

/** Gravitational radius GM/c^2 of the Sun, in metres. */
const RG_SUN_M = (G * M_SUN) / (C * C); // ~1476.6 m
/** Light-crossing time GM/c^3 of the Sun, in seconds. */
const TG_SUN_S = RG_SUN_M / C; // ~4.9255e-6 s

/**
 * Orbital period at the Schwarzschild ISCO in units of GM/c^3.
 *
 * T = 2*pi*sqrt(r^3/M) evaluated at r = 6M, i.e. 2*pi*6^(3/2) ~ 92.34.
 * Spec §1.9 quotes ~92.3.
 */
export const ISCO_PERIOD_GEOMETRIC = 2 * Math.PI * Math.pow(6, 1.5);

/** Wall-clock seconds one ISCO orbit should take at "comfort" speed (§1.9). */
export const COMFORT_ORBIT_SECONDS = 30;

export interface MassPreset {
  id: string;
  label: string;
  /** Mass in solar masses. */
  solarMasses: number;
  /** Short description of what the preset is for. */
  hint: string;
  /**
   * Whether a prominent jet is expected for this object.
   *
   * Spec §1.4 wants the jet toggle to default per preset: on for M87*, the
   * archetypal jetted black hole; off for Sgr A*, which has no prominent jet,
   * and for the stellar case. The user can always override.
   */
  jetByDefault: boolean;
}

export const MASS_PRESETS: MassPreset[] = [
  {
    id: "stellar",
    label: "Stellar (10 M☉)",
    solarMasses: 10,
    hint: "Tides are lethal far outside the horizon",
    jetByDefault: false,
  },
  // Relabelled for §6.4: these two used to be called "Sgr A*" and "M87*",
  // but those names now belong to the cited entries in
  // `real-black-holes.json`, which sit in the same dropdown. Two options
  // called "M87*" — one sourced, one not — would defeat the entire point of
  // the citation discipline, so the generic presets went back to describing
  // the *scale* of hole they are, which is all they ever were: the masses
  // below are round numbers for feeling the difference, not measurements.
  {
    id: "sgra",
    label: "Supermassive (4×10⁶ M☉)",
    solarMasses: 4.154e6,
    hint: "Galactic-centre scale; survivable tides at the horizon",
    jetByDefault: false,
  },
  {
    id: "m87",
    label: "Ultramassive (6.5×10⁹ M☉)",
    solarMasses: 6.5e9,
    hint: "The largest scale imaged so far; jet on by default",
    jetByDefault: true,
  },
];

export const DEFAULT_MASS_PRESET = "stellar";

export function findPreset(id: string): MassPreset {
  return MASS_PRESETS.find((p) => p.id === id) ?? MASS_PRESETS[0]!;
}

/** Gravitational radius r_g = GM/c^2, in kilometres. */
export function gravitationalRadiusKm(solarMasses: number): number {
  return (RG_SUN_M * solarMasses) / 1000;
}

/** Schwarzschild radius r_s = 2GM/c^2, in kilometres. */
export function schwarzschildRadiusKm(solarMasses: number): number {
  return 2 * gravitationalRadiusKm(solarMasses);
}

/** One geometric time unit GM/c^3, in seconds. */
export function timeUnitSeconds(solarMasses: number): number {
  return TG_SUN_S * solarMasses;
}

/** Convert a radius in units of M (geometric) to kilometres. */
export function radiusToKm(rGeometric: number, solarMasses: number): number {
  return rGeometric * gravitationalRadiusKm(solarMasses);
}

/** Convert a duration in geometric units to seconds. */
export function durationToSeconds(
  tGeometric: number,
  solarMasses: number,
): number {
  return tGeometric * timeUnitSeconds(solarMasses);
}

/** Orbital period at the ISCO, in seconds. */
export function iscoPeriodSeconds(solarMasses: number): number {
  return durationToSeconds(ISCO_PERIOD_GEOMETRIC, solarMasses);
}

/**
 * "Comfort" playback multiplier: the rate at which one ISCO orbit takes
 * `COMFORT_ORBIT_SECONDS` of wall clock (§1.9).
 *
 * This is why the speed slider needs ten orders of magnitude rather than a
 * 0.1x–10x band: it is ~1.5e-4 for a stellar-mass hole (real time is an
 * invisible blur) and ~1e5 for M87* (real time is geological).
 */
export function comfortSpeed(solarMasses: number): number {
  return iscoPeriodSeconds(solarMasses) / COMFORT_ORBIT_SECONDS;
}

/**
 * Tidal acceleration across a separation `separationM` metres, at radius
 * `rGeometric` in units of GM/c^2.
 *
 * Newtonian tidal term 2GM*dx/r^3 expressed in geometric radii:
 *
 *   a = 2 * dx * c^6 / (G^2 M^2 x^3),   x = r / r_g
 *
 * Note the inverse-square dependence on mass: a bigger hole has *gentler*
 * tides at the same number of gravitational radii, which is the whole reason
 * a person could cross Sgr A*'s horizon intact and would be shredded far
 * outside a stellar one.
 */
export function tidalAccelerationSI(
  rGeometric: number,
  solarMasses: number,
  separationM = 1,
): number {
  if (rGeometric <= 0) return Infinity;
  const m = solarMasses * M_SUN;
  return (
    (2 * separationM * Math.pow(C, 6)) /
    (G * G * m * m * Math.pow(rGeometric, 3))
  );
}

/** Tidal acceleration expressed in Earth gravities. */
export function tidalAccelerationG(
  rGeometric: number,
  solarMasses: number,
  separationM = 1,
): number {
  return tidalAccelerationSI(rGeometric, solarMasses, separationM) / 9.80665;
}

/**
 * Peak accretion-disk temperature in kelvin.
 *
 * A Shakura-Sunyaev thin disk radiating near the Eddington limit has
 * T_peak proportional to M^(-1/4): smaller holes run hotter. Anchored at
 * 1e7 K for a 10 M☉ stellar-mass black hole, which is the standard
 * order-of-magnitude figure for a hard-state X-ray binary.
 *
 * This normalises the `T ∝ r^(-3/4)` profile §1.3 already renders; it does
 * not change the profile's shape.
 */
export function peakDiskTemperatureK(solarMasses: number): number {
  const ANCHOR_MASS = 10;
  const ANCHOR_TEMP = 1e7;
  return ANCHOR_TEMP * Math.pow(solarMasses / ANCHOR_MASS, -0.25);
}

/** Format a duration in seconds using whatever unit reads naturally. */
export function formatDuration(seconds: number): string {
  const abs = Math.abs(seconds);
  if (abs < 1e-6) return `${(seconds * 1e9).toPrecision(3)} ns`;
  if (abs < 1e-3) return `${(seconds * 1e6).toPrecision(3)} µs`;
  if (abs < 1) return `${(seconds * 1e3).toPrecision(3)} ms`;
  if (abs < 60) return `${seconds.toPrecision(3)} s`;
  if (abs < 3600) return `${(seconds / 60).toPrecision(3)} min`;
  if (abs < 86400) return `${(seconds / 3600).toPrecision(3)} h`;
  if (abs < 31557600) return `${(seconds / 86400).toPrecision(3)} d`;
  return `${(seconds / 31557600).toPrecision(3)} yr`;
}

/** Format a length in kilometres, escalating to AU and light-years. */
export function formatLength(km: number): string {
  const abs = Math.abs(km);
  if (abs < 1) return `${(km * 1000).toPrecision(3)} m`;
  if (abs < 1.495979e8) return `${km.toPrecision(4)} km`;
  if (abs < 9.4607e12) return `${(km / 1.495979e8).toPrecision(3)} AU`;
  return `${(km / 9.4607e12).toPrecision(3)} ly`;
}
