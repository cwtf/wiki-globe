import { describe, it, expect } from "vitest";

import {
  COMFORT_ORBIT_SECONDS,
  DEFAULT_MASS_PRESET,
  ISCO_PERIOD_GEOMETRIC,
  MASS_PRESETS,
  comfortSpeed,
  findPreset,
  formatDuration,
  formatLength,
  gravitationalRadiusKm,
  iscoPeriodSeconds,
  peakDiskTemperatureK,
  radiusToKm,
  schwarzschildRadiusKm,
  tidalAccelerationG,
  timeUnitSeconds,
} from "@/configs/mass-presets";

/**
 * wiki-globe fork, spec §1.8 / §1.9.
 *
 * The spec states several of these figures outright, so the tests assert
 * against *those* rather than against whatever the implementation produces —
 * that is the difference between a unit test and a snapshot.
 */

const preset = (id: string) => findPreset(id).solarMasses;

describe("geometric unit scales", () => {
  it("puts the Sun's gravitational radius at ~1.4766 km", () => {
    expect(gravitationalRadiusKm(1)).toBeCloseTo(1.4766, 3);
  });

  it("puts the Sun's Schwarzschild radius at ~2.95 km", () => {
    expect(schwarzschildRadiusKm(1)).toBeCloseTo(2.953, 2);
  });

  it("puts one solar time unit at ~4.93 microseconds", () => {
    expect(timeUnitSeconds(1)).toBeCloseTo(4.9255e-6, 9);
  });

  it("scales linearly with mass", () => {
    expect(gravitationalRadiusKm(20)).toBeCloseTo(
      20 * gravitationalRadiusKm(1),
      6,
    );
    expect(timeUnitSeconds(1e6)).toBeCloseTo(1e6 * timeUnitSeconds(1), 6);
  });

  it("converts a radius in M to kilometres", () => {
    // A 10 M_sun hole's horizon sits at r = 2M.
    expect(radiusToKm(2, 10)).toBeCloseTo(schwarzschildRadiusKm(10), 6);
    expect(schwarzschildRadiusKm(10)).toBeCloseTo(29.53, 1);
  });
});

describe("ISCO period", () => {
  it("is 2*pi*6^1.5 in geometric units, ~92.3", () => {
    expect(ISCO_PERIOD_GEOMETRIC).toBeCloseTo(92.34, 1);
  });

  // Spec §1.9 quotes these three explicitly.
  it("is ~4.5 ms for a 10 solar-mass hole", () => {
    const s = iscoPeriodSeconds(preset("stellar"));
    expect(s).toBeGreaterThan(4.0e-3);
    expect(s).toBeLessThan(5.0e-3);
  });

  it("is ~31 minutes for Sgr A*", () => {
    const minutes = iscoPeriodSeconds(preset("sgra")) / 60;
    expect(minutes).toBeGreaterThan(29);
    expect(minutes).toBeLessThan(34);
  });

  it("is ~34 days for M87*", () => {
    const days = iscoPeriodSeconds(preset("m87")) / 86400;
    expect(days).toBeGreaterThan(31);
    expect(days).toBeLessThan(37);
  });
});

describe("comfort speed", () => {
  it("plays one ISCO orbit in the target wall-clock time", () => {
    for (const p of MASS_PRESETS) {
      const rate = comfortSpeed(p.solarMasses);
      const wallClock = iscoPeriodSeconds(p.solarMasses) / rate;
      expect(wallClock).toBeCloseTo(COMFORT_ORBIT_SECONDS, 6);
    }
  });

  // The three values §1.9 quotes, and the reason the slider needs ten decades.
  it("is ~1.5e-4x for the stellar preset (slow motion)", () => {
    const r = comfortSpeed(preset("stellar"));
    expect(r).toBeGreaterThan(1.0e-4);
    expect(r).toBeLessThan(2.0e-4);
  });

  it("is ~60x for Sgr A*", () => {
    const r = comfortSpeed(preset("sgra"));
    expect(r).toBeGreaterThan(45);
    expect(r).toBeLessThan(80);
  });

  it("is ~1e5x for M87*", () => {
    const r = comfortSpeed(preset("m87"));
    expect(r).toBeGreaterThan(3e4);
    expect(r).toBeLessThan(3e5);
  });

  it("spans a range no fixed 0.1x-10x band could cover", () => {
    const lo = comfortSpeed(preset("stellar"));
    const hi = comfortSpeed(preset("m87"));
    expect(hi / lo).toBeGreaterThan(1e8);
  });
});

describe("tidal acceleration", () => {
  it("is lethal well outside a stellar-mass horizon", () => {
    // At 10 r_g from a 10 M_sun hole, the stretch across a human is
    // overwhelming — this is §1.5's "lethal outside the horizon".
    const g = tidalAccelerationG(10, preset("stellar"), 1);
    expect(g).toBeGreaterThan(1e4);
  });

  it("is gentle at the same geometric radius around Sgr A*", () => {
    const g = tidalAccelerationG(10, preset("sgra"), 1);
    expect(g).toBeLessThan(1e-3);
  });

  it("falls as the inverse square of mass", () => {
    // Same x, mass x10 => tides /100.
    const a = tidalAccelerationG(10, 10);
    const b = tidalAccelerationG(10, 100);
    expect(a / b).toBeCloseTo(100, 4);
  });

  it("falls as the inverse cube of radius", () => {
    const near = tidalAccelerationG(10, 10);
    const far = tidalAccelerationG(20, 10);
    expect(near / far).toBeCloseTo(8, 6);
  });

  it("scales linearly with the separation measured across", () => {
    expect(tidalAccelerationG(10, 10, 2)).toBeCloseTo(
      2 * tidalAccelerationG(10, 10, 1),
      6,
    );
  });

  it("diverges toward r = 0", () => {
    expect(tidalAccelerationG(0, 10)).toBe(Infinity);
  });
});

describe("disk temperature", () => {
  it("is ~1e7 K for a stellar-mass hole", () => {
    expect(peakDiskTemperatureK(10)).toBeCloseTo(1e7, -6);
  });

  it("makes smaller holes hotter, as M^(-1/4)", () => {
    const stellar = peakDiskTemperatureK(preset("stellar"));
    const sgra = peakDiskTemperatureK(preset("sgra"));
    const m87 = peakDiskTemperatureK(preset("m87"));
    expect(stellar).toBeGreaterThan(sgra);
    expect(sgra).toBeGreaterThan(m87);

    // Exact power law: mass x 10000 => temperature / 10.
    expect(peakDiskTemperatureK(10) / peakDiskTemperatureK(1e5)).toBeCloseTo(
      10,
      6,
    );
  });

  it("keeps the supermassive disks in a plausible range", () => {
    expect(peakDiskTemperatureK(preset("sgra"))).toBeGreaterThan(1e5);
    expect(peakDiskTemperatureK(preset("m87"))).toBeGreaterThan(1e4);
    expect(peakDiskTemperatureK(preset("m87"))).toBeLessThan(1e6);
  });
});

describe("presets", () => {
  it("has a default that exists", () => {
    expect(findPreset(DEFAULT_MASS_PRESET).id).toBe(DEFAULT_MASS_PRESET);
  });

  it("falls back rather than throwing on an unknown id", () => {
    expect(findPreset("no-such-preset")).toBe(MASS_PRESETS[0]);
  });

  it("defaults the jet on only for M87*", () => {
    // Spec §1.4: on for M87*, off for Sgr A* and the stellar case.
    expect(findPreset("m87").jetByDefault).toBe(true);
    expect(findPreset("sgra").jetByDefault).toBe(false);
    expect(findPreset("stellar").jetByDefault).toBe(false);
  });
});

describe("formatting", () => {
  it("picks a readable time unit", () => {
    expect(formatDuration(4.5e-3)).toMatch(/ms$/);
    expect(formatDuration(1890)).toMatch(/min$/);
    expect(formatDuration(2.95e6)).toMatch(/d$/);
    expect(formatDuration(1e9)).toMatch(/yr$/);
  });

  it("picks a readable length unit", () => {
    expect(formatLength(29.5)).toMatch(/km$/);
    expect(formatLength(0.4)).toMatch(/m$/);
    expect(formatLength(3e9)).toMatch(/AU$/);
    expect(formatLength(2e13)).toMatch(/ly$/);
  });
});
