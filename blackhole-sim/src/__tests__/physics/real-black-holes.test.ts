import { describe, it, expect } from "vitest";

import {
  REAL_BLACK_HOLES,
  REAL_BLACK_HOLE_IDS,
  distanceLightYears,
  findRealBlackHole,
  formatDistanceLightYears,
  formatSolarMasses,
  lockedParameters,
  massPresetForRealBlackHole,
  matchesLockedParameters,
  uncertaintyLabel,
} from "@/configs/real-black-holes";

/**
 * wiki-globe fork, spec §6.4.
 *
 * Most of these assert on the *discipline* rather than on the astrophysics:
 * that no field can be added without a citation, that no value can be quoted
 * confidently without an uncertainty flag, and that a slug can never collide
 * with a route. Those are the properties that rot silently when someone adds
 * an eighth object in a hurry.
 *
 * The handful of hard numbers below are pinned deliberately — if a future
 * edit changes Cygnus X-1's mass, that should be a decision accompanied by a
 * new citation, not a diff nobody noticed.
 */

/** Look up a slug that must exist, failing the test loudly if it does not. */
function must(id: string) {
  const o = findRealBlackHole(id);
  if (!o) throw new Error(`no such black hole: ${id}`);
  return o;
}

describe("real black hole data discipline", () => {
  it("ships the seven objects the spec lists", () => {
    expect(REAL_BLACK_HOLES).toHaveLength(7);
    expect(REAL_BLACK_HOLE_IDS).toContain("sgr-a-star");
    expect(REAL_BLACK_HOLE_IDS).toContain("m87-star");
  });

  it("gives every object a URL-safe, unique slug", () => {
    const seen = new Set<string>();
    for (const o of REAL_BLACK_HOLES) {
      expect(o.id).toMatch(/^[a-z0-9-]+$/);
      expect(seen.has(o.id)).toBe(false);
      seen.add(o.id);
    }
  });

  it("carries a citation and an uncertainty flag on every measured field", () => {
    for (const o of REAL_BLACK_HOLES) {
      const fields = [
        o.solarMasses,
        o.spin,
        o.inclinationDeg,
        o.distanceKpc,
        o.jets,
      ];
      for (const f of fields) {
        // A citation short enough to be a placeholder is not a citation.
        expect(f.source.length).toBeGreaterThan(20);
        expect(["measured", "contested", "unconstrained"]).toContain(
          f.uncertainty,
        );
      }
      expect(o.positionSource).toContain("J2000");
    }
  });

  it("says out loud when a spin is a placeholder rather than a measurement", () => {
    // The point of the flag: two objects here have no usable spin measurement,
    // and both must be labelled rather than rendering 0.5 as if it were known.
    const unconstrained = REAL_BLACK_HOLES.filter(
      (o) => o.spin.uncertainty === "unconstrained",
    );
    expect(unconstrained.map((o) => o.id).sort()).toEqual([
      "sgr-a-star",
      "v404-cygni",
    ]);
    for (const o of unconstrained) {
      expect(o.spin.source.toLowerCase()).toContain("placeholder");
      expect(uncertaintyLabel(o.spin.uncertainty)).toBe("not measured");
    }
  });

  it("keeps every spin and inclination physical", () => {
    for (const o of REAL_BLACK_HOLES) {
      expect(o.spin.value).toBeGreaterThanOrEqual(0);
      expect(o.spin.value).toBeLessThan(1);
      expect(o.inclinationDeg.value).toBeGreaterThanOrEqual(0);
      expect(o.inclinationDeg.value).toBeLessThanOrEqual(90);
      expect(o.distanceKpc.value).toBeGreaterThan(0);
    }
  });

  it("keeps sky positions in range for the globe's sky dots", () => {
    for (const o of REAL_BLACK_HOLES) {
      expect(o.raDeg).toBeGreaterThanOrEqual(0);
      expect(o.raDeg).toBeLessThan(360);
      expect(o.decDeg).toBeGreaterThanOrEqual(-90);
      expect(o.decDeg).toBeLessThanOrEqual(90);
    }
  });

  it("pins the headline values against silent drift", () => {
    const cyg = must("cygnus-x-1");
    expect(cyg.solarMasses.value).toBe(21.2);
    expect(cyg.inclinationDeg.value).toBe(27.5);
    expect(cyg.spin.value).toBeGreaterThan(0.99);

    const m87 = must("m87-star");
    expect(m87.solarMasses.value).toBe(6.5e9);
    expect(m87.inclinationDeg.value).toBe(17);

    const a0620 = must("a0620-00");
    // The one genuinely low spin in the set; it is the reason the sample is
    // not just "every black hole spins near extremal".
    expect(a0620.spin.value).toBeLessThan(0.2);
    expect(a0620.spin.uncertainty).toBe("measured");
  });

  it("returns undefined for an unknown slug rather than a default object", () => {
    // The route handler leans on this: a stale bookmark must not silently
    // render a different black hole under the requested name.
    expect(findRealBlackHole("cygnus-x-2")).toBeUndefined();
  });
});

describe("distance formatting", () => {
  it("converts kiloparsecs to light-years", () => {
    const sgr = must("sgr-a-star");
    // 8.277 kpc is the familiar "about 27,000 light-years".
    expect(distanceLightYears(sgr)).toBeCloseTo(26996, 0);
    expect(formatDistanceLightYears(sgr)).toBe("27,000 ly");
  });

  it("escalates to millions for the extragalactic case", () => {
    const m87 = must("m87-star");
    expect(formatDistanceLightYears(m87)).toContain("million ly");
  });

  it("does not imply precision the measurement lacks", () => {
    // Two significant figures below a million: no "26,984 ly".
    for (const o of REAL_BLACK_HOLES) {
      expect(formatDistanceLightYears(o)).not.toMatch(/\d{1,3},\d{2}[1-9]\sly/);
    }
  });
});

describe("mass formatting", () => {
  it("scales the unit to the object", () => {
    expect(formatSolarMasses(21.2)).toBe("21.2 M☉");
    expect(formatSolarMasses(4.297e6)).toBe("4.30 million M☉");
    expect(formatSolarMasses(6.5e9)).toBe("6.5 billion M☉");
  });
});

describe("preset adaptation and locking", () => {
  it("adapts a real object into the synthetic mass-preset shape", () => {
    const grs = must("grs-1915-105");
    const preset = massPresetForRealBlackHole(grs);
    expect(preset.solarMasses).toBe(12.4);
    // §1.4's per-preset jet default finally keys on something real.
    expect(preset.jetByDefault).toBe(true);
    expect(massPresetForRealBlackHole(must("a0620-00")).jetByDefault).toBe(
      false,
    );
  });

  it("namespaces the synthesized preset id so it cannot shadow a real preset", () => {
    const preset = massPresetForRealBlackHole(must("sgr-a-star"));
    expect(preset.id).toBe("real:sgr-a-star");
  });

  it("reports the locked parameters", () => {
    const cyg = must("cygnus-x-1");
    expect(lockedParameters(cyg)).toEqual({
      solarMasses: 21.2,
      spin: 0.998,
      inclinationDeg: 27.5,
    });
  });

  it("holds the lock through slider quantisation but breaks on a real change", () => {
    const cyg = must("cygnus-x-1");
    expect(matchesLockedParameters(cyg, 0.998)).toBe(true);
    // A float round-trip through the URL state must not read as "custom".
    expect(matchesLockedParameters(cyg, 0.99801)).toBe(true);
    // Dragging the spin slider must.
    expect(matchesLockedParameters(cyg, 0.9)).toBe(false);
    expect(matchesLockedParameters(cyg, 0.0)).toBe(false);
  });
});
