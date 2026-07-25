import { describe, it, expect } from "vitest";

import {
  DRIFT_TOLERANCE,
  DROP_PRESETS,
  WORLDLINE_STRIDE,
  Worldline,
  buildDropRequest,
  type WorldlineAudit,
} from "@/physics/worldline";

/**
 * wiki-globe fork: §1.6's sampling contract, in isolation from the renderer.
 *
 * The buffers here are synthetic so the expected answers are exact — the
 * physics itself is verified on the Rust side
 * (`cargo test -p gravitas-core --test worldline`).
 */

const AUDIT: WorldlineAudit = {
  energy: 0.95,
  angularMomentum: 3.5,
  energyDrift: 1e-9,
  angularMomentumDrift: 2e-9,
  properTime: 10,
  coordinateTime: 14,
  endReason: 0,
  sampleCount: 0,
};

/** Build a buffer from [tau, t, tFar, r, theta, phi] rows. */
function build(rows: number[][]): Worldline {
  const flat = new Float32Array(rows.length * WORLDLINE_STRIDE);
  rows.forEach((row, i) => flat.set(row, i * WORLDLINE_STRIDE));
  return new Worldline(flat, { ...AUDIT, sampleCount: rows.length });
}

const HALF_PI = Math.PI / 2;

/** An infall: t_far runs away and goes infinite once inside the horizon. */
function infall(): Worldline {
  return build([
    [0, 0, 0, 10, HALF_PI, 0],
    [1, 1.2, 1.5, 8, HALF_PI, 0.1],
    [2, 2.6, 4.0, 5, HALF_PI, 0.2],
    [3, 4.2, 12.0, 3, HALF_PI, 0.3],
    [4, 5.0, 40.0, 2.1, HALF_PI, 0.35],
    [5, 5.6, Infinity, 1.8, HALF_PI, 0.4],
    [6, 6.1, Infinity, 0.5, HALF_PI, 0.45],
  ]);
}

describe("worldline sampling", () => {
  it("counts samples and finds the last observable one", () => {
    const w = infall();
    expect(w.count).toBe(7);
    // Index 4 is the last with finite t_far; 5 and 6 are inside the horizon.
    expect(w.lastVisibleIndex).toBe(4);
  });

  it("interpolates linearly by proper time", () => {
    const w = infall();
    const p = w.sampleByProperTime(1.5);
    expect(p.r).toBeCloseTo(6.5, 5); // midway between 8 and 5
    expect(p.tau).toBeCloseTo(1.5, 5);
  });

  it("reaches the singularity end of the buffer by proper time", () => {
    // 1st person: finite proper time carries the object all the way in.
    const w = infall();
    const p = w.sampleByProperTime(99);
    expect(p.r).toBeCloseTo(0.5, 5);
    expect(w.totalProperTime).toBeCloseTo(6, 5);
  });

  it("never returns a sample inside the horizon when sampling by far time", () => {
    // §1.6: the 3rd-person view must never see the crossing. No finite
    // distant-observer time may reach past lastVisibleIndex.
    const w = infall();
    // The buffer is f32, so compare against the representable value rather
    // than the decimal literal.
    const frozenR = Math.fround(2.1);
    for (const t of [0, 1, 10, 100, 1e6, 1e12, Number.MAX_VALUE]) {
      const p = w.sampleByFarTime(t);
      expect(p.r).toBeGreaterThanOrEqual(frozenR);
      expect(Number.isFinite(p.tFar)).toBe(true);
    }
  });

  it("freezes asymptotically as far time grows", () => {
    // The object slows to a halt rather than stopping abruptly: successive
    // decades of observer time move it less and less.
    const w = infall();
    const a = w.sampleByFarTime(12);
    const b = w.sampleByFarTime(40);
    const c = w.sampleByFarTime(4000);
    expect(a.r).toBeGreaterThan(b.r);
    expect(b.r).toBeGreaterThanOrEqual(c.r);
    expect(c.r).toBeCloseTo(2.1, 4);
  });

  it("gives the two views different positions at the same wall-clock moment", () => {
    // The disagreement between the clocks IS the physics (§1.6).
    const w = infall();
    const third = w.sampleByFarTime(40);
    const first = w.sampleByProperTime(40);
    expect(first.r).toBeLessThan(third.r);
  });

  it("interpolates phi across the wrap without spinning backwards", () => {
    const w = build([
      [0, 0, 0, 10, HALF_PI, 3.1],
      [1, 1, 1, 10, HALF_PI, -3.1],
    ]);
    const p = w.sampleByProperTime(0.5);
    // Short arc through pi, not a near-full turn back through zero.
    expect(Math.abs(p.phi)).toBeGreaterThan(3.1);
  });

  it("fades to black at the horizon", () => {
    const w = infall();
    const rs = 2;
    expect(w.redshiftFactor(10, rs)).toBeCloseTo(Math.sqrt(0.8), 6);
    expect(w.redshiftFactor(2.0001, rs)).toBeLessThan(0.01);
    expect(w.redshiftFactor(rs, rs)).toBe(0);
    expect(w.redshiftFactor(1, rs)).toBe(0);
  });

  it("converts to cartesian on the shader's Y-up axis", () => {
    const w = infall();
    const [x, y, z] = w.toCartesian({
      tau: 0,
      t: 0,
      tFar: 0,
      r: 5,
      theta: HALF_PI,
      phi: 0,
      u: [1, 0, 0, 0],
    });
    expect(x).toBeCloseTo(5, 6);
    expect(y).toBeCloseTo(0, 6); // equatorial orbits stay out of the pole axis
    expect(z).toBeCloseTo(0, 6);
  });

  it("thins the trail without exceeding the cap", () => {
    const rows = Array.from({ length: 1000 }, (_, i) => [
      i,
      i,
      i,
      10,
      HALF_PI,
      i * 0.01,
    ]);
    const w = build(rows);
    const trail = w.trail(999, 64);
    expect(trail.length).toBeLessThanOrEqual(65);
    expect(trail.length).toBeGreaterThan(1);
  });

  it("reports conservation against the spec tolerance", () => {
    const w = infall();
    expect(w.conserved).toBe(true);

    const drifted = new Worldline(w.samples, {
      ...AUDIT,
      energyDrift: DRIFT_TOLERANCE * 10,
    });
    expect(drifted.conserved).toBe(false);
  });

  it("handles an empty worldline without throwing", () => {
    const w = new Worldline(new Float32Array(0), AUDIT);
    expect(w.count).toBe(0);
    expect(w.lastVisibleIndex).toBe(-1);
    expect(() => w.sampleByFarTime(5)).not.toThrow();
    expect(w.trail(10)).toEqual([]);
  });
});

describe("drop requests", () => {
  it("maps preset names to the FFI codes", () => {
    expect(buildDropRequest("circular").preset).toBe(DROP_PRESETS.circular);
    expect(buildDropRequest("isco").preset).toBe(DROP_PRESETS.isco);
    expect(buildDropRequest("radialFall").preset).toBe(DROP_PRESETS.radialFall);
    expect(buildDropRequest("eccentric").preset).toBe(DROP_PRESETS.eccentric);
  });

  it("defaults the inner radius to the horizon sentinel", () => {
    // 0 means "just outside the horizon" on the Rust side, which is as far as
    // the 3rd-person view can see anyway.
    expect(buildDropRequest("circular").innerRadius).toBe(0);
  });

  it("passes overrides through", () => {
    const req = buildDropRequest("eccentric", {
      r0: 300,
      tangentialFraction: 0.98,
      innerRadius: 0.04,
    });
    expect(req.r0).toBe(300);
    expect(req.tangentialFraction).toBe(0.98);
    expect(req.innerRadius).toBe(0.04);
  });
});
