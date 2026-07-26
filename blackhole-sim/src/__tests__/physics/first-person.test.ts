import { describe, it, expect } from "vitest";

import {
  FIRST_PERSON_FOCAL_LENGTH,
  buildRay,
  coordinateBasis,
  frequencyShift,
  lookDirection,
  rotateByQuaternion,
  tetradToCartesian,
  toCartesian,
  type CartesianTetrad,
  type Vec3,
} from "@/physics/first-person";

/**
 * wiki-globe fork, spec §1.6 / §5.
 *
 * The point of these tests is that **nothing in the render path computes
 * aberration**, yet aberration must come out exactly right. So the checks
 * compare `buildRay` — which only adds up tetrad legs — against the closed-form
 * relativistic aberration and Doppler formulas it has never been told about.
 */

/** Closed-form aberration, used only as the expected answer. */
function aberrate(cosTheta: number, beta: number): number {
  return (cosTheta + beta) / (1 + beta * cosTheta);
}

/**
 * A flat-space frame for an observer moving at `beta` along +z.
 *
 * Written by hand so the test does not depend on the Rust Gram-Schmidt: if
 * both used the same construction, agreeing would prove nothing.
 */
function boostedFrame(beta: number): CartesianTetrad {
  const gamma = 1 / Math.sqrt(1 - beta * beta);
  return {
    e0: { spatial: [0, 0, gamma * beta], time: gamma },
    e1: { spatial: [1, 0, 0], time: 0 },
    e2: { spatial: [0, 1, 0], time: 0 },
    e3: { spatial: [0, 0, gamma], time: gamma * beta },
  };
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

describe("first-person ray construction", () => {
  it("leaves directions untouched for an observer at rest", () => {
    const frame = boostedFrame(0);
    for (const n of [
      [0, 0, 1],
      [1, 0, 0],
      [0.6, 0, 0.8],
      [0.3, -0.4, Math.sqrt(1 - 0.09 - 0.16)],
    ] as Vec3[]) {
      const { direction } = buildRay(frame, n);
      expect(direction[0]).toBeCloseTo(n[0], 10);
      expect(direction[1]).toBeCloseTo(n[1], 10);
      expect(direction[2]).toBeCloseTo(n[2], 10);
    }
  });

  it("reproduces relativistic aberration without computing it", () => {
    // buildRay only sums e_0 + n_i e_i. That it lands on the aberration
    // formula is the whole design claim of §5.
    for (const beta of [0.1, 0.5, 0.9, 0.99]) {
      const frame = boostedFrame(beta);
      for (const cosLocal of [-0.9, -0.5, 0, 0.5, 0.9]) {
        const sinLocal = Math.sqrt(1 - cosLocal * cosLocal);
        const n: Vec3 = [sinLocal, 0, cosLocal];

        const { direction } = buildRay(frame, n);
        const cosWorld = dot(direction, [0, 0, 1]);

        expect(cosWorld).toBeCloseTo(aberrate(cosLocal, beta), 10);
      }
    }
  });

  it("compresses the sky toward the direction of travel", () => {
    // The observable statement of the same thing: at high speed, directions
    // the observer sees spread over the forward hemisphere came from a much
    // wider slice of the sky.
    const beta = 0.95;
    const frame = boostedFrame(beta);

    // A ray the observer sees at 90 degrees to its motion.
    const { direction } = buildRay(frame, [1, 0, 0]);
    const cosWorld = dot(direction, [0, 0, 1]);

    expect(cosWorld).toBeCloseTo(beta, 10);
    expect(cosWorld).toBeGreaterThan(0);
  });

  it("keeps directions unit length at every speed", () => {
    for (const beta of [0, 0.3, 0.7, 0.999]) {
      const frame = boostedFrame(beta);
      const { direction } = buildRay(frame, lookDirection(0.4, -0.2));
      expect(Math.hypot(...direction)).toBeCloseTo(1, 12);
    }
  });

  it("produces the relativistic Doppler shift from the same construction", () => {
    // frequencyShift reads p^t, which buildRay assembled from the same legs.
    // No Doppler formula appears in the source.
    const beta = 0.6;
    const gamma = 1 / Math.sqrt(1 - beta * beta);
    const frame = boostedFrame(beta);

    for (const cosLocal of [-1, -0.5, 0, 0.5, 1]) {
      const sinLocal = Math.sqrt(Math.max(0, 1 - cosLocal * cosLocal));
      const ray = buildRay(frame, [sinLocal, 0, cosLocal]);
      // Flat space: r_s = 0, so the lapse is 1 and only motion contributes.
      const shift = frequencyShift(ray, 1, 0);
      expect(shift).toBeCloseTo(1 / (gamma * (1 + beta * cosLocal)), 9);
    }
  });

  it("blueshifts ahead and redshifts behind", () => {
    const frame = boostedFrame(0.6);
    const ahead = frequencyShift(buildRay(frame, [0, 0, -1]), 1, 0);
    const behind = frequencyShift(buildRay(frame, [0, 0, 1]), 1, 0);
    expect(ahead).toBeGreaterThan(1);
    expect(behind).toBeLessThan(1);
  });

  it("folds gravitational redshift into the same number", () => {
    // A static observer deep in the well sees light from infinity blueshifted
    // by 1/sqrt(1 - r_s/r); no separate gravitational term exists in the code.
    const frame = boostedFrame(0);
    const ray = buildRay(frame, [0, 0, 1]);
    const rs = 2;
    for (const r of [4, 10, 100]) {
      expect(frequencyShift(ray, r, rs)).toBeCloseTo(1 / (1 - rs / r), 10);
    }
  });

  it("reports zero shift where the lapse vanishes", () => {
    const frame = boostedFrame(0);
    const ray = buildRay(frame, [0, 0, 1]);
    expect(frequencyShift(ray, 2, 2)).toBe(0);
  });
});

describe("coordinate basis", () => {
  it("puts the equator in the shader's x-z plane with y as the spin axis", () => {
    const p = toCartesian(5, Math.PI / 2, 0);
    expect(p[0]).toBeCloseTo(5, 10);
    expect(p[1]).toBeCloseTo(0, 10);
    expect(p[2]).toBeCloseTo(0, 10);

    // The pole is along +y.
    const pole = toCartesian(5, 0, 0);
    expect(pole[1]).toBeCloseTo(5, 10);
  });

  it("gives d/dr as the outward unit vector", () => {
    const { dr } = coordinateBasis(7, 1.1, 0.4);
    expect(Math.hypot(...dr)).toBeCloseTo(1, 10);
    const pos = toCartesian(7, 1.1, 0.4);
    const radial: Vec3 = [pos[0] / 7, pos[1] / 7, pos[2] / 7];
    expect(dot(dr, radial)).toBeCloseTo(1, 10);
  });

  it("makes the basis vectors mutually orthogonal", () => {
    const { dr, dtheta, dphi } = coordinateBasis(3, 0.9, 2.2);
    expect(dot(dr, dtheta)).toBeCloseTo(0, 9);
    expect(dot(dr, dphi)).toBeCloseTo(0, 9);
    expect(dot(dtheta, dphi)).toBeCloseTo(0, 9);
  });

  it("scales d/dtheta by r and d/dphi by r sin(theta)", () => {
    const r = 4;
    const theta = 0.7;
    const { dtheta, dphi } = coordinateBasis(r, theta, 1.3);
    expect(Math.hypot(...dtheta)).toBeCloseTo(r, 9);
    expect(Math.hypot(...dphi)).toBeCloseTo(r * Math.sin(theta), 9);
  });

  it("resolves a coordinate tetrad into Cartesian legs", () => {
    // A static equatorial observer's frame: e_0 along d/dt, e_1 along d/dr.
    const r = 10;
    const theta = Math.PI / 2;
    const phi = 0;
    const flat = [
      1, 0, 0, 0, // e_0 = d/dt
      0, 1, 0, 0, // e_1 = d/dr
      0, 0, 1 / r, 0, // e_2 = unit d/dtheta
      0, 0, 0, 1 / r, // e_3 = unit d/dphi (equator)
    ];
    const frame = tetradToCartesian(flat, r, theta, phi);

    // Purely temporal leg has no spatial part.
    expect(Math.hypot(...frame.e0.spatial)).toBeCloseTo(0, 10);
    expect(frame.e0.time).toBeCloseTo(1, 10);

    // Radial leg points along +x at phi = 0.
    expect(frame.e1.spatial[0]).toBeCloseTo(1, 10);

    // The normalised angular legs come out unit length.
    expect(Math.hypot(...frame.e2.spatial)).toBeCloseTo(1, 10);
    expect(Math.hypot(...frame.e3.spatial)).toBeCloseTo(1, 10);
  });
});

describe("free-look", () => {
  it("leaves directions alone for the identity quaternion", () => {
    const v: Vec3 = [0.3, -0.5, 0.8];
    const r = rotateByQuaternion(v, [0, 0, 0, 1]);
    expect(r[0]).toBeCloseTo(v[0], 12);
    expect(r[1]).toBeCloseTo(v[1], 12);
    expect(r[2]).toBeCloseTo(v[2], 12);
  });

  it("preserves length", () => {
    const q: [number, number, number, number] = [0.2, 0.3, 0.1, 0.927];
    const n = Math.hypot(...q);
    const unit: [number, number, number, number] = [
      q[0] / n,
      q[1] / n,
      q[2] / n,
      q[3] / n,
    ];
    const v: Vec3 = [1, 2, 3];
    const r = rotateByQuaternion(v, unit);
    expect(Math.hypot(...r)).toBeCloseTo(Math.hypot(...v), 9);
  });

  it("rotates 90 degrees about y as expected", () => {
    const s = Math.SQRT1_2;
    const r = rotateByQuaternion([0, 0, 1], [0, s, 0, s]);
    expect(r[0]).toBeCloseTo(1, 9);
    expect(r[1]).toBeCloseTo(0, 9);
    expect(r[2]).toBeCloseTo(0, 9);
  });

  it("applies inside the frame, so aberration is not carried around with the view", () => {
    // Free-look must change WHICH ray you look along, not where the forward
    // compression sits. Looking sideways while moving forward must still show
    // the sky bunched toward the direction of travel.
    const beta = 0.9;
    const frame = boostedFrame(beta);

    const sideways = rotateByQuaternion([0, 0, 1], [0, Math.SQRT1_2, 0, Math.SQRT1_2]);
    const { direction } = buildRay(frame, sideways);

    // The resulting world direction still leans toward +z (the motion).
    expect(direction[2]).toBeCloseTo(beta, 9);
    expect(direction[2]).toBeGreaterThan(0);
  });
});

describe("field of view", () => {
  it("is fixed, because a variable FOV would masquerade as aberration", () => {
    expect(FIRST_PERSON_FOCAL_LENGTH).toBe(1.2);
  });

  it("builds unit look directions", () => {
    for (const [u, v] of [
      [0, 0],
      [0.5, 0.3],
      [-0.8, 0.9],
    ]) {
      expect(Math.hypot(...lookDirection(u!, v!))).toBeCloseTo(1, 12);
    }
  });

  it("points straight ahead at the centre of the screen", () => {
    const d = lookDirection(0, 0);
    expect(d[0]).toBeCloseTo(0, 12);
    expect(d[1]).toBeCloseTo(0, 12);
    expect(d[2]).toBeCloseTo(1, 12);
  });
});
