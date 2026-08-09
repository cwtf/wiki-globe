/**
 * Real black hole presets (spec §6.4).
 *
 * wiki-globe fork. Selecting one of these locks the simulator to a named
 * object's measured parameters instead of the synthetic mass presets in
 * `mass-presets.ts`.
 *
 * **Data discipline is the whole feature.** Every quantity below carries its
 * own citation string and its own uncertainty flag, because the honest answer
 * differs field by field within a single object: Cygnus X-1's mass is known to
 * 10% and its spin to three significant figures, while V404 Cygni's spin is
 * not known at all. A UI that renders both as "0.998" and "0.5" without saying
 * which is which is lying by omission, so `uncertainty` is not decoration —
 * `unconstrained` means *the number is a placeholder chosen so the renderer
 * has something to draw*, and the UI must say so.
 *
 * The values live in `src/data/real-black-holes.json` rather than in this file
 * so that milestone 11 (the same objects as sky dots on the globe, which is
 * plain ES modules with no TypeScript build) can consume exactly the same
 * bytes. `scripts/data/generate-black-holes.mjs` copies that file out to
 * `data/black-holes.json` at the repo root, and the validator fails if the two
 * drift apart.
 */

import raw from "@/data/real-black-holes.json";
import type { MassPreset } from "@/configs/mass-presets";

/**
 * How much to trust a single field.
 *
 * - `measured` — a published value with a real error bar.
 * - `contested` — published values disagree by more than their stated errors,
 *   usually because two methods (continuum fitting vs reflection, orbit vs
 *   inner disk) do not agree. The value shown is one defensible choice.
 * - `unconstrained` — there is no measurement worth quoting. The value is a
 *   plausible placeholder so the simulation has something to render, and the
 *   UI must never present it as a property of the object.
 */
export type Uncertainty = "measured" | "contested" | "unconstrained";

export interface Measured<T> {
  value: T;
  uncertainty: Uncertainty;
  /** Free-text citation. Shown verbatim in the UI; never summarise it away. */
  source: string;
}

export interface RealBlackHole {
  /** URL slug: the object is reachable at `/blackhole/{id}/`. */
  id: string;
  name: string;
  shortName: string;
  constellation: string;
  kind: "stellar" | "supermassive";
  blurb: string;
  wikipedia: string;
  solarMasses: Measured<number>;
  /** Dimensionless Kerr spin a* = Jc/GM². */
  spin: Measured<number>;
  /** Viewing angle of the accretion flow: 0 face-on, 90 edge-on. */
  inclinationDeg: Measured<number>;
  distanceKpc: Measured<number>;
  /** J2000 right ascension, degrees. Milestone 11 only. */
  raDeg: number;
  /** J2000 declination, degrees. Milestone 11 only. */
  decDeg: number;
  positionSource: string;
  jets: Measured<boolean>;
}

interface RealBlackHoleFile {
  schemaVersion: number;
  meta: { sourceLabel: string; notes: string[] };
  objects: RealBlackHole[];
}

const file = raw as RealBlackHoleFile;

export const REAL_BLACK_HOLES: RealBlackHole[] = file.objects;

export const REAL_BLACK_HOLE_IDS: string[] = REAL_BLACK_HOLES.map((o) => o.id);

export function findRealBlackHole(id: string): RealBlackHole | undefined {
  return REAL_BLACK_HOLES.find((o) => o.id === id);
}

/** Parsecs to light-years. */
const LY_PER_KPC = 3261.564;

export function distanceLightYears(o: RealBlackHole): number {
  return o.distanceKpc.value * LY_PER_KPC;
}

/**
 * The three parameters a real preset pins down.
 *
 * Note what is *not* here: the geometric mass the shader uses is always 1.
 * The renderer is mass-invariant (see `mass-presets.ts`), so `solarMasses`
 * changes the readouts and the clock rate, not the picture. Spin and
 * inclination do change the picture.
 */
export interface LockedParameters {
  solarMasses: number;
  spin: number;
  inclinationDeg: number;
}

export function lockedParameters(o: RealBlackHole): LockedParameters {
  return {
    solarMasses: o.solarMasses.value,
    spin: o.spin.value,
    inclinationDeg: o.inclinationDeg.value,
  };
}

/**
 * Adapt a real object to the synthetic mass-preset shape.
 *
 * Everything downstream of the preset — the r_s / ISCO period / disk
 * temperature readouts, the speed slider's comfort rate, the test object's
 * unit conversions — only ever wanted a mass in solar masses and a jet
 * default. Feeding a real object through the same shape means none of that
 * code has to learn that real objects exist.
 */
export function massPresetForRealBlackHole(o: RealBlackHole): MassPreset {
  return {
    id: `real:${o.id}`,
    label: o.name,
    solarMasses: o.solarMasses.value,
    hint: o.blurb,
    jetByDefault: o.jets.value,
  };
}

/**
 * Whether the live simulation still matches the object it claims to show.
 *
 * Only mass and spin are checked, and that is a deliberate deviation from the
 * spec's "mass/spin/inclination are fixed" — see the milestone 10 note in
 * FORK.md. Inclination is applied when the object is selected but orbiting the
 * camera afterwards does not break the lock, because the free-orbit camera is
 * a property of the *viewer*, not of the black hole: dropping to "custom"
 * every time the user dragged the view would make the badge meaningless.
 *
 * The spin tolerance is loose enough to survive the slider's own step
 * quantisation and float round-trips through the URL state.
 */
export function matchesLockedParameters(
  o: RealBlackHole,
  liveSpin: number,
): boolean {
  return Math.abs(liveSpin - o.spin.value) < 5e-3;
}

/**
 * Short label for the uncertainty flag, for use next to a number.
 *
 * Deliberately blunt. "±" would imply an error bar we do not carry, and an
 * empty string for `measured` keeps the common case quiet so the exceptions
 * stand out.
 */
export function uncertaintyLabel(u: Uncertainty): string {
  switch (u) {
    case "measured":
      return "";
    case "contested":
      return "disputed";
    case "unconstrained":
      return "not measured";
  }
}

/** Mass in a form a person can read: "21.2 M☉" or "6.5 billion M☉". */
export function formatSolarMasses(m: number): string {
  if (m >= 1e9) return `${(m / 1e9).toPrecision(2)} billion M☉`;
  if (m >= 1e6) return `${(m / 1e6).toPrecision(3)} million M☉`;
  return `${m.toPrecision(3)} M☉`;
}

/**
 * Distance in light-years, escalating to millions.
 *
 * Rounded to two significant figures below a million because the underlying
 * distances are not better than that — quoting "26,984 ly" for Sgr A* would
 * imply a precision the parallax does not have.
 */
export function formatDistanceLightYears(o: RealBlackHole): string {
  const ly = distanceLightYears(o);
  if (ly >= 1e6) return `${(ly / 1e6).toPrecision(3)} million ly`;
  const rounded = Number(ly.toPrecision(2));
  return `${rounded.toLocaleString("en-US")} ly`;
}
