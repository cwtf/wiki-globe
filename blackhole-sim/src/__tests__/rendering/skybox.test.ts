import { describe, it, expect } from "vitest";

import {
  CHANNEL_WAVELENGTHS_NM,
  GALACTIC_ORIENTATION,
  SKYBOX_SHADER_CONSTANTS,
  SKYBOX_TEXTURE_WIDTH,
  galacticBasis,
  galacticToEquirectUv,
  sampleSpectrum,
  sceneToGalactic,
  shiftSpectrumRgb,
  type Vec3,
} from "@/configs/skybox.config";

/**
 * wiki-globe fork, spec §6.2 (milestone 8): the Milky Way sky.
 *
 * The shader consumes this same module, so asserting against it keeps the
 * rendered sky and these expectations from drifting — the pattern
 * `jet-beaming.test.ts` established. What no unit test can check is that the
 * GLSL applies it correctly; that is the rendered check (the band must appear
 * tilted relative to the disk, and must be lensed into arcs near the shadow).
 */

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);

describe("galactic orientation", () => {
  const basis = galacticBasis();

  it("is an orthonormal right-handed triple", () => {
    for (const axis of [basis.centre, basis.pole, basis.third]) {
      expect(norm(axis)).toBeCloseTo(1, 12);
    }
    expect(dot(basis.centre, basis.pole)).toBeCloseTo(0, 12);
    expect(dot(basis.centre, basis.third)).toBeCloseTo(0, 12);
    expect(dot(basis.pole, basis.third)).toBeCloseTo(0, 12);

    // third = centre x pole, so (centre, pole, third) matches the
    // longitude = atan2(z, x) convention in generate-skybox.ps1.
    const cross: Vec3 = [
      basis.centre[1] * basis.pole[2] - basis.centre[2] * basis.pole[1],
      basis.centre[2] * basis.pole[0] - basis.centre[0] * basis.pole[2],
      basis.centre[0] * basis.pole[1] - basis.centre[1] * basis.pole[0],
    ];
    expect(basis.third[0]).toBeCloseTo(cross[0], 12);
    expect(basis.third[1]).toBeCloseTo(cross[1], 12);
    expect(basis.third[2]).toBeCloseTo(cross[2], 12);
  });

  it("tilts the galactic pole away from the spin axis by the configured angle", () => {
    // The whole point of the constant: a black hole's spin axis and the
    // galactic plane are unrelated, so the band must not lie in the disk.
    const spinAxis: Vec3 = [0, 1, 0];
    const angleDeg = (Math.acos(dot(basis.pole, spinAxis)) * 180) / Math.PI;
    expect(angleDeg).toBeCloseTo(GALACTIC_ORIENTATION.tiltDeg, 10);
  });

  it("does not put the galactic band in the disk plane", () => {
    // A direction in the disk plane (y = 0) should not generally sit on the
    // galactic equator; at a 60° tilt the two great circles cross at only two
    // points, so a sample around the disk must show real latitude spread.
    const latitudes: number[] = [];
    for (let i = 0; i < 36; i++) {
      const phi = (i / 36) * 2 * Math.PI;
      const dir: Vec3 = [Math.sin(phi), 0, Math.cos(phi)];
      latitudes.push(Math.asin(sceneToGalactic(dir, basis)[1]));
    }
    const spreadDeg =
      ((Math.max(...latitudes) - Math.min(...latitudes)) * 180) / Math.PI;
    // sin(lat) sweeps ±sin(tilt); at 60° that is ±60° of latitude.
    expect(spreadDeg).toBeGreaterThan(100);
  });
});

describe("equirectangular mapping", () => {
  it("puts the galactic centre at the middle of the panorama", () => {
    // The ESO panorama is galactic-centred: the bulge sits at the image's
    // horizontal midpoint, on the horizontal midline.
    const [u, v] = galacticToEquirectUv([1, 0, 0]);
    expect(u).toBeCloseTo(0.5, 12);
    expect(v).toBeCloseTo(0.5, 12);
  });

  it("puts the north galactic pole at the top row", () => {
    // v counts down from the north pole because the image's first row is its
    // top row and the texture is uploaded without UNPACK_FLIP_Y_WEBGL.
    expect(galacticToEquirectUv([0, 1, 0])[1]).toBeCloseTo(0, 12);
    expect(galacticToEquirectUv([0, -1, 0])[1]).toBeCloseTo(1, 12);
  });

  it("matches generate-skybox.ps1's longitude convention", () => {
    // The globe builds its Cesium cube map from the same panorama with
    // longitude = atan2(z, x), u = longitude / 2π + 0.5. Both apps must read
    // the same pixel for the same direction or milestone 11's sky dots will
    // land in the wrong place.
    for (const [dir, expected] of [
      [[0, 0, 1] as Vec3, 0.75],
      [[-1, 0, 0] as Vec3, 1.0],
      [[0, 0, -1] as Vec3, 0.25],
    ] as const) {
      expect(galacticToEquirectUv(dir)[0]).toBeCloseTo(expected, 12);
    }
  });

  it("keeps u inside [0, 1] for every direction", () => {
    for (let i = 0; i < 200; i++) {
      const theta = (i / 200) * Math.PI;
      const phi = (i / 200) * 2 * Math.PI;
      const dir: Vec3 = [
        Math.sin(theta) * Math.cos(phi),
        Math.cos(theta),
        Math.sin(theta) * Math.sin(phi),
      ];
      const [u, v] = galacticToEquirectUv(dir);
      expect(u).toBeGreaterThanOrEqual(0);
      expect(u).toBeLessThanOrEqual(1);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it("round-trips a scene direction through the galactic frame", () => {
    // The basis is a rotation, so it must preserve angles: two scene
    // directions 90° apart stay 90° apart in the panorama's frame.
    const basis = galacticBasis();
    const a = sceneToGalactic([1, 0, 0], basis);
    const b = sceneToGalactic([0, 0, 1], basis);
    expect(norm(a)).toBeCloseTo(1, 12);
    expect(dot(a, b)).toBeCloseTo(0, 12);
  });
});

describe("spectral shift", () => {
  const grey: [number, number, number] = [0.5, 0.5, 0.5];

  it("is the identity at g = 1", () => {
    // Nothing may move when there is no shift — the 3rd-person camera relies
    // on this, since it never applies a shift at all.
    const rgb: [number, number, number] = [0.8, 0.4, 0.1];
    const out = shiftSpectrumRgb(rgb, 1);
    expect(out[0]).toBeCloseTo(rgb[0], 12);
    expect(out[1]).toBeCloseTo(rgb[1], 12);
    expect(out[2]).toBeCloseTo(rgb[2], 12);
  });

  it("leaves a flat spectrum flat at any shift", () => {
    // A grey pixel has no spectral structure to move, so a shift must not
    // invent colour. This is what a tint-based fake gets wrong.
    for (const g of [0.5, 0.8, 1.2, 2.0]) {
      const out = shiftSpectrumRgb(grey, g);
      for (let i = 0; i < 3; i++) expect(out[i]).toBeCloseTo(0.5, 12);
    }
  });

  it("moves red content toward the blue channel under blueshift", () => {
    // g > 1: the observer's blue channel at 464 nm samples the emitted curve
    // at 464g nm, which is further toward the red end.
    const redSource: [number, number, number] = [1.0, 0.2, 0.0];
    const shifted = shiftSpectrumRgb(redSource, 1.25);
    expect(shifted[2]).toBeGreaterThan(redSource[2]);
    expect(shifted[1]).toBeGreaterThan(redSource[1]);
  });

  it("moves blue content toward the red channel under redshift", () => {
    const blueSource: [number, number, number] = [0.0, 0.2, 1.0];
    const shifted = shiftSpectrumRgb(blueSource, 0.8);
    expect(shifted[0]).toBeGreaterThan(blueSource[0]);
  });

  it("holds the curve flat outside the photographed range", () => {
    // The panorama has three broadband samples and nothing beyond them, so a
    // strong shift saturates rather than extrapolating a spectrum nobody
    // measured. Stated in the config docstring; asserted here so it stays true.
    const rgb: [number, number, number] = [0.9, 0.5, 0.1];
    expect(sampleSpectrum(rgb, 100)).toBe(rgb[2]);
    expect(sampleSpectrum(rgb, 5000)).toBe(rgb[0]);

    const hugelyBlueshifted = shiftSpectrumRgb(rgb, 8);
    for (const channel of hugelyBlueshifted) expect(channel).toBe(rgb[0]);
  });

  it("interpolates linearly between the primaries", () => {
    const rgb: [number, number, number] = [1.0, 0.0, 0.0];
    const { green, red } = CHANNEL_WAVELENGTHS_NM;
    const midpoint = (green + red) / 2;
    expect(sampleSpectrum(rgb, midpoint)).toBeCloseTo(0.5, 12);
  });

  it("never produces a negative or NaN channel", () => {
    // g reaches 1e4 near the horizon in the 1st-person view; the shader clamps
    // the intensity, but the colour path must stay finite on its own.
    for (const g of [1e-6, 1e-3, 1, 1e3, 1e6]) {
      for (const channel of shiftSpectrumRgb([0.3, 0.6, 0.9], g)) {
        expect(Number.isFinite(channel)).toBe(true);
        expect(channel).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

describe("shader constants", () => {
  it("hands the GLSL the same numbers the tests above constrain", () => {
    expect(SKYBOX_SHADER_CONSTANTS.lambdaRed).toBe(CHANNEL_WAVELENGTHS_NM.red);
    expect(SKYBOX_SHADER_CONSTANTS.lambdaGreen).toBe(
      CHANNEL_WAVELENGTHS_NM.green,
    );
    expect(SKYBOX_SHADER_CONSTANTS.lambdaBlue).toBe(
      CHANNEL_WAVELENGTHS_NM.blue,
    );
    expect(SKYBOX_SHADER_CONSTANTS.textureWidth).toBe(SKYBOX_TEXTURE_WIDTH);
  });

  it("orders the primaries blue < green < red", () => {
    // sampleSpectrum's branch order depends on it, in TS and in GLSL alike.
    expect(CHANNEL_WAVELENGTHS_NM.blue).toBeLessThan(
      CHANNEL_WAVELENGTHS_NM.green,
    );
    expect(CHANNEL_WAVELENGTHS_NM.green).toBeLessThan(
      CHANNEL_WAVELENGTHS_NM.red,
    );
  });
});
