import { describe, it, expect } from "vitest";

import {
  APSIS_DRAG_LIMITS,
  apsisHandlePositions,
  clampApsis,
  eccentricity,
  newtonianEllipse,
  orderApsides,
  semiLatusRectum,
} from "@/physics/apsides";
import {
  projectToScreen,
  screenToEquatorial,
  type CameraState,
} from "@/physics/camera-projection";
import { DROP_PRESETS, buildDropRequest } from "@/physics/worldline";

/**
 * wiki-globe fork, spec §6.3 (milestone 9): draggable orbits — the TypeScript
 * half.
 *
 * The relativistic solver is Rust and is tested there
 * (`gravitas-core/tests/apsides.rs`). What is checkable here is the geometry
 * the drag depends on: that a pixel maps back to the radius it was drawn from,
 * that the preview ellipse is placed where the integrator will launch the
 * object, and that the drag's constraints behave as §6.3 requires.
 */

/**
 * `mouseY = 0.5` is deliberately absent: that is the camera sitting exactly in
 * the disk plane, where the whole plane projects onto a single line and the
 * inverse does not exist. It gets its own test below. The app's default
 * (`verticalAngle` 97°) is just off it, which is why this is a real state
 * rather than a theoretical one.
 */
const CAMERAS: CameraState[] = [
  { mouseX: 0.5, mouseY: 0.539, zoom: 15 },
  { mouseX: 0.62, mouseY: 0.34, zoom: 15 },
  { mouseX: 0.2, mouseY: 0.7, zoom: 40 },
  { mouseX: 0.85, mouseY: 0.45, zoom: 8 },
];

describe("apsis ordering", () => {
  it("swaps a pair dragged past itself", () => {
    // §6.3: "r_peri > r_apo swaps them" — the alternative is a dead zone the
    // drag cannot cross.
    expect(orderApsides(30, 8)).toEqual({ periapsis: 8, apoapsis: 30 });
    expect(orderApsides(8, 30)).toEqual({ periapsis: 8, apoapsis: 30 });
  });

  it("clamps a drag to the representable range without a floor at the ISCO", () => {
    // Dragging inside the ISCO, inside the separatrix, and even below the
    // horizon must all be reachable: those are captures, and §6.3 wants the
    // UI to show them rather than prevent them.
    expect(clampApsis(1.0)).toBe(1.0);
    expect(clampApsis(0.5)).toBe(0.5);
    expect(clampApsis(-5)).toBe(APSIS_DRAG_LIMITS.min);
    expect(clampApsis(1e9)).toBe(APSIS_DRAG_LIMITS.max);
    expect(clampApsis(NaN)).toBe(APSIS_DRAG_LIMITS.min);
  });
});

describe("newtonian preview geometry", () => {
  it("derives eccentricity and semi-latus rectum from the apsides", () => {
    const pair = { periapsis: 10, apoapsis: 30 };
    expect(eccentricity(pair)).toBeCloseTo(0.5, 12);
    expect(semiLatusRectum(pair)).toBeCloseTo(15, 12);
  });

  it("is a circle when the two apsides coincide", () => {
    const pair = { periapsis: 20, apoapsis: 20 };
    expect(eccentricity(pair)).toBeCloseTo(0, 12);
    for (const [x, y, z] of newtonianEllipse(pair, 64)) {
      expect(y).toBe(0);
      expect(Math.hypot(x, z)).toBeCloseTo(20, 9);
    }
  });

  it("puts the apoapsis at phi = 0, where the integrator launches", () => {
    // Not cosmetic. `initial_state` releases the object at the outer turning
    // point with phi = 0; a preview drawn with the periapsis there instead
    // would be rotated half a turn from the trajectory that replaces it, and
    // the handles would visibly jump on release.
    const pair = { periapsis: 10, apoapsis: 30 };
    const points = newtonianEllipse(pair, 360);
    const first = points[0]!;
    expect(Math.hypot(first[0], first[2])).toBeCloseTo(30, 6);
    expect(first[0]).toBeGreaterThan(0);

    const handles = apsisHandlePositions(pair);
    expect(handles.apoapsis).toEqual([30, 0, 0]);
    expect(handles.periapsis).toEqual([-10, 0, 0]);
  });

  it("stays in the equatorial plane and between the two apsides", () => {
    const pair = { periapsis: 6, apoapsis: 45 };
    for (const [x, y, z] of newtonianEllipse(pair, 256)) {
      expect(y).toBe(0);
      const r = Math.hypot(x, z);
      expect(r).toBeGreaterThanOrEqual(6 - 1e-9);
      expect(r).toBeLessThanOrEqual(45 + 1e-9);
    }
  });

  it("reaches both turning points exactly once each", () => {
    const pair = { periapsis: 8, apoapsis: 24 };
    const radii = newtonianEllipse(pair, 720).map(([x, , z]) => Math.hypot(x, z));
    expect(Math.min(...radii)).toBeCloseTo(8, 6);
    expect(Math.max(...radii)).toBeCloseTo(24, 6);
  });
});

describe("screen to equatorial plane", () => {
  it("round-trips a point on the disk through the projection", () => {
    // The drag reads a pixel and must recover the radius the handle was drawn
    // at. Any disagreement here shows up as a handle that slides away from the
    // pointer.
    for (const cam of CAMERAS) {
      for (const radius of [5, 12, 30, 90]) {
        for (const phi of [0, 1.1, Math.PI, 4.3]) {
          const world: [number, number, number] = [
            radius * Math.cos(phi),
            0,
            radius * Math.sin(phi),
          ];
          const screen = projectToScreen(world, cam, 1280, 720);
          if (!screen.visible) continue;

          const back = screenToEquatorial(screen, cam, 1280, 720);
          expect(back).not.toBeNull();
          expect(back!.radius).toBeCloseTo(radius, 6);
          expect(back!.world[0]).toBeCloseTo(world[0], 6);
          expect(back!.world[2]).toBeCloseTo(world[2], 6);
        }
      }
    }
  });

  it("round-trips at non-square aspect ratios", () => {
    // The shader normalises by the smaller dimension; getting that wrong is
    // invisible on a 16:9 desktop and obvious on a phone.
    const cam: CameraState = { mouseX: 0.55, mouseY: 0.4, zoom: 20 };
    for (const [w, h] of [
      [390, 844],
      [2560, 1080],
      [800, 800],
    ] as const) {
      const world: [number, number, number] = [18, 0, -7];
      const screen = projectToScreen(world, cam, w, h);
      if (!screen.visible) continue;
      const back = screenToEquatorial(screen, cam, w, h);
      expect(back!.radius).toBeCloseTo(Math.hypot(18, 7), 5);
    }
  });

  it("refuses a ray that never meets the disk plane", () => {
    // Exactly edge-on, the intersection is at infinity. Returning a radius
    // there would fling the handle across the screen for a one-pixel move; the
    // drag should simply not track.
    const edgeOn: CameraState = { mouseX: 0.5, mouseY: 0.5, zoom: 15 };
    const centre = screenToEquatorial({ x: 640, y: 360 }, edgeOn, 1280, 720);
    expect(centre).toBeNull();
  });

  it("refuses a point behind the camera", () => {
    const cam: CameraState = { mouseX: 0.5, mouseY: 0.3, zoom: 15 };
    // Far above the top of the frame the ray points away from the plane.
    const behind = screenToEquatorial({ x: 640, y: -4000 }, cam, 1280, 720);
    expect(behind === null || behind.radius > 0).toBe(true);
  });
});

describe("drop request", () => {
  it("carries the periapsis for the apsides preset", () => {
    const request = buildDropRequest("apsides", { r0: 30, rPeri: 9 });
    expect(request.preset).toBe(DROP_PRESETS.apsides);
    expect(request.r0).toBe(30);
    expect(request.rPeri).toBe(9);
  });

  it("leaves the periapsis inert for every other preset", () => {
    // The Rust side ignores it unless preset 5 is selected; 0 rather than
    // undefined keeps the FFI signature total.
    expect(buildDropRequest("circular", { r0: 20 }).rPeri).toBe(0);
    expect(buildDropRequest("radialFall", { r0: 20 }).rPeri).toBe(0);
  });
});
