import { describe, it, expect } from "vitest";

import { DISK_CHUNK } from "@/shaders/blackhole/chunks/disk";
import { BLACKBODY_CHUNK } from "@/shaders/blackhole/chunks/blackbody";
import { SIMULATION_CONFIG } from "@/configs/simulation.config";
import { DEFAULT_PARAMS } from "@/types/simulation";
import { peakDiskTemperatureK, MASS_PRESETS } from "@/configs/mass-presets";
import { REAL_BLACK_HOLES } from "@/configs/real-black-holes";

/**
 * wiki-globe fork: the disk is now rendered at the temperature the UI claims
 * it has, in physically correct colour.
 *
 * The shader itself cannot be unit-tested here (it is a GLSL string compiled
 * on a GPU), so these tests cover the two things that can silently break the
 * claim from the JavaScript side: the normalisation constant that makes
 * `u_disk_temp` mean "peak temperature", and the parameter plumbing that feeds
 * the physical value into it. The rendered colour itself is verified against a
 * real frame — see the milestone-10 notes in FORK.md.
 */

/** The shader's radial profile, in JS, for checking its normalisation. */
function novikovThorneProfile(iscoOverR: number): number {
  const x = Math.min(Math.max(iscoOverR, 0), 1);
  return Math.pow(x, 0.75) * Math.pow(Math.max(0, 1 - Math.sqrt(x)), 0.25);
}

describe("Novikov-Thorne profile normalisation", () => {
  // f(u) = u^1.5 (1-u)^0.25 with u = sqrt(isco/r) is maximised at u = 6/7,
  // i.e. r = (7/6)^2 = 1.361 isco. Everything below depends on this value.
  const analyticPeak = Math.pow(6 / 7, 1.5) * Math.pow(1 / 7, 0.25);

  it("agrees with the analytic maximum", () => {
    let numericPeak = 0;
    for (let r = 1; r < 20; r += 0.0002) {
      numericPeak = Math.max(numericPeak, novikovThorneProfile(1 / r));
    }
    expect(numericPeak).toBeCloseTo(analyticPeak, 6);
    expect(analyticPeak).toBeCloseTo(0.4878713392, 9);
  });

  it("peaks outside the ISCO, not at it", () => {
    // The zero-torque inner boundary forces the temperature to zero *at* the
    // ISCO; the hottest ring sits a little further out. Getting this backwards
    // would put the brightest part of the disk in the wrong place.
    expect(novikovThorneProfile(1)).toBe(0);
    const peakR = Math.pow(7 / 6, 2);
    expect(peakR).toBeCloseTo(1.3611, 4);
    expect(novikovThorneProfile(1 / peakR)).toBeCloseTo(analyticPeak, 9);
  });

  it("uses the same constant in the shader", () => {
    // If someone edits the profile without re-deriving this, u_disk_temp
    // quietly stops meaning "peak temperature" and every readout is wrong.
    const m = DISK_CHUNK.match(/NT_PEAK\s*=\s*([0-9.]+)/);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeCloseTo(analyticPeak, 9);
    expect(DISK_CHUNK).toContain("/ NT_PEAK");
  });
});

describe("disk temperature plumbing", () => {
  it("defaults to the physical peak of the default preset", () => {
    expect(DEFAULT_PARAMS.diskTemp).toBeCloseTo(peakDiskTemperatureK(10), -4);
  });

  it("has a range that can hold every preset and real object", () => {
    const { min, max } = SIMULATION_CONFIG.diskTemp;
    const masses = [
      ...MASS_PRESETS.map((p) => p.solarMasses),
      ...REAL_BLACK_HOLES.map((o) => o.solarMasses.value),
    ];
    for (const m of masses) {
      const t = peakDiskTemperatureK(m);
      expect(t).toBeGreaterThanOrEqual(min);
      expect(t).toBeLessThanOrEqual(max);
    }
  });

  it("still reaches the false-colour range", () => {
    // Dialling down to a few thousand K is how the familiar orange gradient is
    // recovered; it must stay reachable, and clearly below any real disk.
    expect(SIMULATION_CONFIG.diskTemp.min).toBeLessThanOrEqual(1000);
    expect(SIMULATION_CONFIG.diskTemp.min).toBeLessThan(
      peakDiskTemperatureK(6.5e9),
    );
  });
});

describe("blackbody colour", () => {
  it("uses the Planckian locus, not the fit that breaks above 40,000 K", () => {
    // The upstream Tanner-Helland fit returned a saturated blue at 1e7 K that
    // no blackbody has. The replacement must carry the Kim et al. constants
    // and the CIE -> linear sRGB matrix.
    expect(BLACKBODY_CHUNK).toContain("0.240390");
    expect(BLACKBODY_CHUNK).toContain("3.2404542");
    expect(BLACKBODY_CHUNK).not.toContain("99.4708025861");
  });

  it("is fed a temperature that can reach the Rayleigh-Jeans tail", () => {
    // The whole point: at the physical peak the disk is deep in the tail,
    // where hue stops changing and only beaming varies.
    expect(peakDiskTemperatureK(10)).toBeGreaterThan(1e6);
  });
});
