import { describe, it, expect } from "vitest";

import {
  SHADER_FOCAL_LENGTH,
  ZOOM_TO_DISTANCE,
  cameraToWorld,
  projectToScreen,
  worldToCamera,
  type CameraState,
  type Vec3,
} from "@/physics/camera-projection";

/**
 * wiki-globe fork: the overlay marker is drawn outside the ray-marcher, so if
 * this projection disagrees with the shader's camera the object appears in the
 * wrong place — and with the preview pane throttled there is no visual signal
 * that it has. These pin the projection to the shader's construction.
 */

/** Default view: mouse centred, so both rotation angles are zero. */
const CENTRED: CameraState = { mouseX: 0.5, mouseY: 0.5, zoom: 15 };

describe("camera rotation", () => {
  it("is the identity when the mouse is centred", () => {
    const v: Vec3 = [1, 2, 3];
    const w = cameraToWorld(v, CENTRED);
    expect(w[0]).toBeCloseTo(1, 12);
    expect(w[1]).toBeCloseTo(2, 12);
    expect(w[2]).toBeCloseTo(3, 12);
  });

  it("round-trips world -> camera -> world for arbitrary angles", () => {
    const cam: CameraState = { mouseX: 0.23, mouseY: 0.81, zoom: 30 };
    for (const v of [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
      [3, -4, 5],
      [-2.5, 0.75, 9],
    ] as Vec3[]) {
      const back = cameraToWorld(worldToCamera(v, cam), cam);
      expect(back[0]).toBeCloseTo(v[0], 10);
      expect(back[1]).toBeCloseTo(v[1], 10);
      expect(back[2]).toBeCloseTo(v[2], 10);
    }
  });

  it("preserves length, as a rotation must", () => {
    const cam: CameraState = { mouseX: 0.9, mouseY: 0.15, zoom: 5 };
    const v: Vec3 = [3, -4, 12];
    const len = Math.hypot(...v);
    const r = worldToCamera(v, cam);
    expect(Math.hypot(...r)).toBeCloseTo(len, 10);
  });
});

describe("projection", () => {
  it("puts the origin at the centre of the screen", () => {
    // The black hole sits at the world origin and the camera looks straight at
    // it, so it must land dead centre whatever the view angle.
    for (const cam of [
      CENTRED,
      { mouseX: 0.1, mouseY: 0.9, zoom: 8 },
      { mouseX: 0.77, mouseY: 0.32, zoom: 42 },
    ]) {
      const p = projectToScreen([0, 0, 0], cam, 1600, 900);
      expect(p.visible).toBe(true);
      expect(p.x).toBeCloseTo(800, 6);
      expect(p.y).toBeCloseTo(450, 6);
    }
  });

  it("places the camera the expected distance from the origin", () => {
    // The camera sits at zoom * 2 in geometric units; the origin's depth is
    // exactly that.
    const p = projectToScreen([0, 0, 0], CENTRED, 1600, 900);
    expect(p.depth).toBeCloseTo(CENTRED.zoom * ZOOM_TO_DISTANCE, 9);
  });

  it("maps a known offset through the shader's focal length", () => {
    // A point one unit +x of the origin, viewed head-on from distance D,
    // lands at u = f/D in normalised units, i.e. f/D * minRes pixels right.
    const width = 1600;
    const height = 900;
    const d = CENTRED.zoom * ZOOM_TO_DISTANCE;
    const p = projectToScreen([1, 0, 0], CENTRED, width, height);
    const expected = (SHADER_FOCAL_LENGTH / d) * Math.min(width, height) + width / 2;
    expect(p.x).toBeCloseTo(expected, 6);
    expect(p.y).toBeCloseTo(height / 2, 6);
  });

  it("puts +y above the centre in CSS coordinates", () => {
    // gl_FragCoord counts up from the bottom, CSS counts down from the top:
    // a point above the equator must have a SMALLER y in screen space.
    const p = projectToScreen([0, 1, 0], CENTRED, 1600, 900);
    expect(p.y).toBeLessThan(450);
  });

  it("normalises by the smaller dimension, like the shader", () => {
    // A portrait and a landscape canvas of the same minimum dimension put the
    // point the same number of pixels off centre.
    const land = projectToScreen([1, 0, 0], CENTRED, 1600, 900);
    const port = projectToScreen([1, 0, 0], CENTRED, 900, 1600);
    expect(land.x - 800).toBeCloseTo(port.x - 450, 6);
  });

  it("reports points behind the camera as not visible", () => {
    // Directly behind: the camera is at -30 looking toward +z, so a point at
    // z = -60 is behind it.
    const p = projectToScreen([0, 0, -60], CENTRED, 1600, 900);
    expect(p.visible).toBe(false);
  });

  it("moves the projected point when the camera orbits", () => {
    // Orbiting must actually change where an off-centre object appears --
    // otherwise the overlay would be pinned to the screen instead of the world.
    const a = projectToScreen([5, 0, 0], CENTRED, 1600, 900);
    const b = projectToScreen(
      [5, 0, 0],
      { ...CENTRED, mouseX: 0.75 },
      1600,
      900,
    );
    expect(Math.abs(a.x - b.x)).toBeGreaterThan(1);
  });

  it("shrinks apparent offsets as the camera pulls back", () => {
    const near = projectToScreen([5, 0, 0], { ...CENTRED, zoom: 10 }, 1600, 900);
    const far = projectToScreen([5, 0, 0], { ...CENTRED, zoom: 100 }, 1600, 900);
    expect(Math.abs(near.x - 800)).toBeGreaterThan(Math.abs(far.x - 800));
  });
});
