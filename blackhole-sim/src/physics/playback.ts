/**
 * Playback speed control (spec §1.9).
 *
 * wiki-globe fork. The slider scales how fast the simulation clock advances
 * against wall clock — proper time τ in 1st person, the distant observer's
 * clock in 3rd — and **never touches the physics**. The worldline is
 * integrated once at drop time; changing speed only changes which sample is
 * looked up, so the same drop replayed at any speed traces the identical
 * trajectory. That is the property §4 asks to be verified.
 *
 * The range is ten decades because it has to be: "comfortable" is ~1.5e-4x
 * for a stellar-mass hole and ~1e5x for M87* (see mass-presets), so no fixed
 * band works across the presets.
 */

/** Slider covers 1e-5x to 1e6x, log-spaced. */
export const MIN_LOG_SPEED = -5;
export const MAX_LOG_SPEED = 6;

/** Relative tolerance within which the slider snaps to a labelled detent. */
const DETENT_TOLERANCE = 0.04;

/** Map a normalised slider position [0,1] to a speed multiplier. */
export function sliderToSpeed(t: number): number {
  const clamped = Math.min(1, Math.max(0, t));
  return Math.pow(
    10,
    MIN_LOG_SPEED + clamped * (MAX_LOG_SPEED - MIN_LOG_SPEED),
  );
}

/** Inverse of {@link sliderToSpeed}. */
export function speedToSlider(speed: number): number {
  if (!(speed > 0)) return 0;
  const log = Math.log10(speed);
  const t = (log - MIN_LOG_SPEED) / (MAX_LOG_SPEED - MIN_LOG_SPEED);
  return Math.min(1, Math.max(0, t));
}

export interface Detent {
  /** Speed multiplier this detent sits at. */
  speed: number;
  label: string;
}

/**
 * The two labelled detents §1.9 requires: true real time, and the per-preset
 * comfort speed. Comfort is recomputed whenever the mass preset changes.
 */
export function detents(comfort: number): Detent[] {
  return [
    { speed: 1, label: "1× real time" },
    { speed: comfort, label: "comfort" },
  ];
}

/**
 * Snap to a detent when the slider lands near one.
 *
 * Compared in log space, because on a ten-decade slider a fixed *absolute*
 * tolerance would be unreachable at the low end and would swallow whole
 * decades at the high end.
 */
export function snapToDetent(speed: number, comfort: number): number {
  for (const d of detents(comfort)) {
    if (d.speed <= 0) continue;
    const relative = Math.abs(Math.log10(speed / d.speed));
    if (relative < DETENT_TOLERANCE * (MAX_LOG_SPEED - MIN_LOG_SPEED) * 0.1) {
      return d.speed;
    }
  }
  return speed;
}

/** Human-readable multiplier for the HUD, e.g. "1×", "60×", "1.5e-4×". */
export function formatSpeed(speed: number, paused: boolean): string {
  if (paused) return "paused";
  if (speed === 0) return "0×";
  if (speed >= 0.01 && speed < 10000) {
    // Trim to something readable without exponent noise.
    const rounded = speed >= 100 ? Math.round(speed) : Number(speed.toPrecision(3));
    return `${rounded}×`;
  }
  return `${speed.toExponential(1)}×`;
}

/**
 * Geometric time units the simulation clock should advance for one wall-clock
 * second, at a given speed multiplier.
 *
 * `speed` is in *seconds of simulated time per wall-clock second*, so 1× is
 * truthfully real time. Converting to geometric units needs the mass, which
 * is what ties §1.9's slider to §1.8's presets: the same 1× means a wildly
 * different geometric rate for a stellar-mass hole than for M87*.
 */
export function geometricRatePerSecond(
  speed: number,
  timeUnitSeconds: number,
): number {
  if (!(timeUnitSeconds > 0)) return 0;
  return speed / timeUnitSeconds;
}
