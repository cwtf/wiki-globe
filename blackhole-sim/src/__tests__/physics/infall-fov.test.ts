import { describe, it, expect } from "vitest";

import { fragmentShaderSource } from "@/shaders/blackhole/fragment.glsl";

/**
 * wiki-globe fork, spec §1.6: the 1st-person lens has to be wide enough to
 * contain the thing the 1st-person view exists to show.
 *
 * The physics of the crossing is verified on the Rust side
 * (`cargo test -p gravitas-core --test infall_sky`): the rider's frame is
 * boosted correctly, so aberration contracts the shadow from the static
 * observer's 180° down to **42.1°** at the horizon for a fall from far away.
 * Roughly 87% of the sky is still stars at that moment.
 *
 * None of which is visible if the camera cannot see 42.1° off-axis. The
 * original focal length of 1.2 put the *corner* of a 16:9 frame at 40.4°, so
 * every pixel was inside the shadow and the correct computation rendered as a
 * black screen. This test is here so that cannot come back.
 */

/** Shadow half-angle at horizon crossing, fall from rest far away, degrees. */
const CROSSING_SHADOW_DEG = 42.1;

function focalLength(): number {
  const m = fragmentShaderSource.match(/FP_FOCAL_LENGTH\s*=\s*([0-9.]+)/);
  expect(m, "FP_FOCAL_LENGTH not found in the shader").not.toBeNull();
  return Number(m![1]);
}

/**
 * Half-angle from the optical axis to the edge of the frame, in degrees.
 *
 * `uv = (gl_FragCoord.xy - 0.5 * resolution) / min(resolution.x, resolution.y)`
 * so the short axis runs to 0.5 and the long axis to 0.5 * aspect, and the ray
 * is `normalize(vec3(uv, f))`.
 */
function halfAngleDeg(f: number, uvExtent: number): number {
  return (Math.atan(uvExtent / f) * 180) / Math.PI;
}

describe("first-person field of view", () => {
  it("is a fixed focal length, not a varying one", () => {
    // §2.4: a variable FOV would masquerade as aberration. The value may be
    // tuned; its constancy may not.
    expect(fragmentShaderSource).toMatch(
      /const\s+float\s+FP_FOCAL_LENGTH\s*=\s*[0-9.]+\s*;/,
    );
  });

  it("relies on the uv normalisation this test assumes", () => {
    // If uv stops being divided by min(resolution), every angle below is wrong
    // and the test would silently keep passing.
    expect(fragmentShaderSource).toContain("0.5 * u_resolution.xy) / minRes");
  });

  it("can contain the shadow at horizon crossing on the short axis", () => {
    // The short axis is the binding one: the shadow is a disc centred in
    // frame, so containing it means the *smallest* half-angle must clear it.
    const vertical = halfAngleDeg(focalLength(), 0.5);
    expect(vertical).toBeGreaterThan(CROSSING_SHADOW_DEG);
  });

  it("leaves a visible ring of sky around the shadow, not a hairline", () => {
    // Clearing 42.1° by a fraction of a degree would be technically correct
    // and useless — the point is to see that the universe is still there.
    const vertical = halfAngleDeg(focalLength(), 0.5);
    expect(vertical - CROSSING_SHADOW_DEG).toBeGreaterThan(3);
  });

  it("would have failed at the old focal length", () => {
    // Guard on the guard. If this ever stops failing, the assertions above
    // have lost their teeth.
    const OLD = 1.2;
    expect(halfAngleDeg(OLD, 0.5)).toBeLessThan(CROSSING_SHADOW_DEG);
    // Even the corner of a 16:9 frame was inside the shadow.
    const corner = halfAngleDeg(OLD, Math.hypot(0.5 * (16 / 9), 0.5));
    expect(corner).toBeLessThan(CROSSING_SHADOW_DEG);
  });

  it("does not widen so far that the projection is absurd", () => {
    // Rectilinear stretch at the corner goes as 1/cos(half-angle); past ~75°
    // the corners are magnified more than 4x and the image stops being
    // readable as a view.
    const corner = halfAngleDeg(focalLength(), Math.hypot(0.5 * (16 / 9), 0.5));
    expect(corner).toBeLessThan(75);
  });

  it("leaves the 3rd-person camera alone", () => {
    // The goldens are all 3rd-person. Those branches keep their own focal
    // lengths and must not be swept up in a 1st-person change.
    expect(fragmentShaderSource).toContain("normalize(vec3(uv, 1.5))");
    expect(fragmentShaderSource).toContain("qrot(u_camQuat, normalize(vec3(uv, 1.2)))");
  });
});
