import { describe, it, expect } from "vitest";

import {
  calculateInitialZoom,
  horizonRadius,
  minZoomFor,
} from "@/hooks/useCamera";
import { fragmentShaderSource } from "@/shaders/blackhole/fragment.glsl";

/**
 * wiki-globe fork, spec §1.6: the free camera may be flown all the way to the
 * horizon, and pushing further hands over to the infalling view rather than
 * stopping dead.
 *
 * The zoom floor is the load-bearing part. It used to be the constant 2.5,
 * which — since `renderer.ts` sets `u_zoom = zoom * 2` — fenced the camera off
 * at r = 5M, two and a half horizon radii out, for reasons that were not
 * physical. It is now derived from the actual horizon, which moves with spin.
 */
describe("horizon radius", () => {
  it("is 2M for a Schwarzschild hole", () => {
    expect(horizonRadius(1, 0)).toBeCloseTo(2, 12);
  });

  it("shrinks toward M as the spin approaches extremal", () => {
    expect(horizonRadius(1, 0.5)).toBeCloseTo(1 + Math.sqrt(0.75), 12);
    expect(horizonRadius(1, 0.9)).toBeLessThan(horizonRadius(1, 0.5));
    expect(horizonRadius(1, 0.998)).toBeGreaterThan(1);
    expect(horizonRadius(1, 0.998)).toBeLessThan(1.07);
  });

  it("stays real at and beyond extremal spin", () => {
    // a* = 1 makes the square root zero, and anything past it would go
    // imaginary. The clamp has to hold or the floor becomes NaN and the
    // camera clamp silently stops working.
    expect(Number.isFinite(horizonRadius(1, 1))).toBe(true);
    expect(Number.isFinite(horizonRadius(1, 1.5))).toBe(true);
    expect(horizonRadius(1, 1)).toBeGreaterThan(0.9);
  });

  it("scales with mass", () => {
    expect(horizonRadius(2, 0)).toBeCloseTo(4, 12);
  });

  it("treats retrograde spin the same as prograde", () => {
    expect(horizonRadius(1, -0.7)).toBeCloseTo(horizonRadius(1, 0.7), 12);
  });
});

describe("camera zoom floor", () => {
  // r = 2 * zoom, so a floor expressed in zoom is half the radius.
  const radiusOf = (zoom: number) => zoom * 2;

  it("lets the camera reach just outside the horizon", () => {
    const floorRadius = radiusOf(minZoomFor(1, 0));
    expect(floorRadius).toBeGreaterThan(horizonRadius(1, 0));
    // Within 2% — close enough to fill the sky with shadow.
    expect(floorRadius).toBeLessThan(horizonRadius(1, 0) * 1.03);
  });

  it("never allows the camera inside the horizon", () => {
    for (const spin of [0, 0.3, 0.6, 0.9, 0.998]) {
      expect(radiusOf(minZoomFor(1, spin))).toBeGreaterThan(
        horizonRadius(1, spin),
      );
    }
  });

  it("follows the horizon inward as spin rises", () => {
    // A rapidly spinning hole has a smaller horizon, so the camera should be
    // allowed closer. A fixed floor could not express this.
    expect(minZoomFor(1, 0.998)).toBeLessThan(minZoomFor(1, 0));
  });

  it("is far closer than the old fixed floor", () => {
    // The whole point of the change: 2.5 in zoom units was r = 5M.
    expect(minZoomFor(1, 0)).toBeLessThan(2.5);
    expect(radiusOf(minZoomFor(1, 0))).toBeLessThan(5);
  });

  it("scales with mass", () => {
    expect(minZoomFor(2, 0)).toBeCloseTo(minZoomFor(1, 0) * 2, 12);
  });
});

describe("the UI floor and the shader standoff must not fight", () => {
  it("keeps the camera outside the radius the shader would teleport it from", () => {
    // fragment.glsl.ts shoves the free camera back out if it gets inside
    // `rh * K`. If the UI floor were at or below that, the camera would be
    // silently relocated and every readout — including the handover radius —
    // would describe a position the render is not using.
    const m = fragmentShaderSource.match(
      /!firstPerson\s*&&\s*length\(ro\)\s*<\s*rh\s*\*\s*([0-9.]+)/,
    );
    expect(m).not.toBeNull();
    const standoff = Number(m![1]);

    for (const spin of [0, 0.5, 0.9, 0.998]) {
      const floorRadius = minZoomFor(1, spin) * 2;
      expect(floorRadius).toBeGreaterThan(horizonRadius(1, spin) * standoff);
    }
  });
});

describe("opening shot", () => {
  it("still frames the disk rather than starting at the horizon", () => {
    // Flying to the horizon is now allowed; *starting* there is not the same
    // question, and this is what the initial-positioning property test guards.
    for (const mass of [0.1, 1, 3]) {
      expect(calculateInitialZoom(mass, 1280, 720)).toBeGreaterThanOrEqual(2.5);
    }
  });
});
