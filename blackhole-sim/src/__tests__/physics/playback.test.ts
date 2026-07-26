import { describe, it, expect } from "vitest";

import {
  MAX_LOG_SPEED,
  MIN_LOG_SPEED,
  detents,
  formatSpeed,
  geometricRatePerSecond,
  sliderToSpeed,
  snapToDetent,
  speedToSlider,
} from "@/physics/playback";
import { comfortSpeed, findPreset, timeUnitSeconds } from "@/configs/mass-presets";

/** wiki-globe fork, spec §1.9. */

describe("speed slider mapping", () => {
  it("spans 1e-5x to 1e6x", () => {
    expect(sliderToSpeed(0)).toBeCloseTo(1e-5, 10);
    expect(sliderToSpeed(1)).toBeCloseTo(1e6, 0);
  });

  it("is logarithmic, so each decade takes equal travel", () => {
    const decadeSpan = 1 / (MAX_LOG_SPEED - MIN_LOG_SPEED);
    const a = sliderToSpeed(0.5);
    const b = sliderToSpeed(0.5 + decadeSpan);
    expect(b / a).toBeCloseTo(10, 6);
  });

  it("round-trips through the inverse", () => {
    for (const speed of [1e-5, 1e-3, 0.5, 1, 60, 1e4, 1e6]) {
      expect(sliderToSpeed(speedToSlider(speed))).toBeCloseTo(speed, 6);
    }
  });

  it("clamps out-of-range input rather than extrapolating", () => {
    expect(sliderToSpeed(-1)).toBeCloseTo(1e-5, 10);
    expect(sliderToSpeed(2)).toBeCloseTo(1e6, 0);
    expect(speedToSlider(0)).toBe(0);
    expect(speedToSlider(-5)).toBe(0);
  });

  it("puts 1x real time inside the range", () => {
    const t = speedToSlider(1);
    expect(t).toBeGreaterThan(0);
    expect(t).toBeLessThan(1);
  });
});

describe("detents", () => {
  it("offers real time and comfort", () => {
    const d = detents(60);
    expect(d.map((x) => x.speed)).toContain(1);
    expect(d.map((x) => x.speed)).toContain(60);
    expect(d.find((x) => x.speed === 1)?.label).toMatch(/real time/i);
  });

  it("snaps to 1x when close", () => {
    expect(snapToDetent(1.01, 60)).toBe(1);
    expect(snapToDetent(0.99, 60)).toBe(1);
  });

  it("snaps to comfort when close", () => {
    expect(snapToDetent(60.5, 60)).toBe(60);
  });

  it("leaves values between detents alone", () => {
    expect(snapToDetent(10, 60)).toBe(10);
    expect(snapToDetent(1e-3, 60)).toBe(1e-3);
  });

  it("snaps proportionally, not absolutely", () => {
    // A tiny comfort speed (stellar preset) must still have a reachable
    // detent; an absolute tolerance would make it impossible to hit.
    const comfort = comfortSpeed(findPreset("stellar").solarMasses);
    expect(snapToDetent(comfort * 1.01, comfort)).toBeCloseTo(comfort, 12);
    // ...and must not swallow neighbouring decades at the top end.
    expect(snapToDetent(comfort * 10, comfort)).not.toBeCloseTo(comfort, 12);
  });
});

describe("clock rate", () => {
  it("makes 1x advance one second of simulated time per wall second", () => {
    // In geometric units that is 1 / (GM/c^3).
    const m = findPreset("stellar").solarMasses;
    const unit = timeUnitSeconds(m);
    expect(geometricRatePerSecond(1, unit)).toBeCloseTo(1 / unit, 6);
  });

  it("means 1x is a different geometric rate for different masses", () => {
    // This is why the slider had to be tied to the mass preset.
    const stellar = geometricRatePerSecond(1, timeUnitSeconds(10));
    const m87 = geometricRatePerSecond(1, timeUnitSeconds(6.5e9));
    expect(stellar / m87).toBeGreaterThan(1e8);
  });

  it("scales linearly with the multiplier", () => {
    const unit = timeUnitSeconds(10);
    expect(geometricRatePerSecond(100, unit)).toBeCloseTo(
      100 * geometricRatePerSecond(1, unit),
      6,
    );
  });

  it("plays one ISCO orbit in 30 s at comfort speed, on every preset", () => {
    // The end-to-end statement of §1.9's default, through the real code path.
    for (const id of ["stellar", "sgra", "m87"]) {
      const m = findPreset(id).solarMasses;
      const rate = geometricRatePerSecond(comfortSpeed(m), timeUnitSeconds(m));
      const iscoGeometric = 2 * Math.PI * Math.pow(6, 1.5);
      expect(iscoGeometric / rate).toBeCloseTo(30, 4);
    }
  });

  it("is inert on a nonsense time unit rather than dividing by zero", () => {
    expect(geometricRatePerSecond(1, 0)).toBe(0);
  });
});

describe("HUD formatting", () => {
  it("says paused when paused, whatever the speed", () => {
    expect(formatSpeed(1000, true)).toBe("paused");
  });

  it("keeps ordinary multipliers readable", () => {
    expect(formatSpeed(1, false)).toBe("1×");
    expect(formatSpeed(60, false)).toBe("60×");
  });

  it("falls back to exponent notation at the extremes", () => {
    expect(formatSpeed(1.5e-4, false)).toMatch(/e/);
    expect(formatSpeed(1e5, false)).toMatch(/e/);
  });
});
