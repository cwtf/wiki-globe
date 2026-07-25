/**
 * World → screen projection matching the fragment shader's camera exactly.
 *
 * wiki-globe fork (spec §1.6). The test object is drawn as a 2D overlay rather
 * than inside the ray-marcher, so its marker only lands on the right pixel if
 * this reproduces the shader's camera construction term for term. From the
 * fallback branch of `fragment.glsl.ts`:
 *
 * ```glsl
 * ro = vec3(0.0, 0.0, -u_zoom);
 * rd = normalize(vec3(uv, 1.5));
 * mat2 rx = rot((u_mouse.y - 0.5) * PI);
 * mat2 ry = rot((u_mouse.x - 0.5) * PI * 2.0);
 * ro.yz *= rx; rd.yz *= rx;
 * ro.xz *= ry; rd.xz *= ry;
 * ```
 *
 * with `uv = (gl_FragCoord.xy - 0.5 * resolution) / min(resolution.x, resolution.y)`
 * and `u_zoom = params.zoom * 2`.
 *
 * So the camera sits at (0, 0, −zoom) in its own frame looking toward +z, and
 * that frame is rotated into the world first about X then about Y. Projecting
 * therefore means undoing Y then X, and dividing by the focal length.
 */

/** The `1.5` in `normalize(vec3(uv, 1.5))`. */
export const SHADER_FOCAL_LENGTH = 1.5;

/** `renderer.ts` sets `u_zoom = params.zoom * 2`. */
export const ZOOM_TO_DISTANCE = 2.0;

export type Vec3 = [number, number, number];

export interface ScreenPoint {
  /** CSS pixels from the left edge. */
  x: number;
  /** CSS pixels from the top edge. */
  y: number;
  /** Distance along the view axis. Negative means behind the camera. */
  depth: number;
  /** False when behind the camera, where the projection is meaningless. */
  visible: boolean;
}

/**
 * GLSL `v * mat2(c, -s, s, c)`, which is a counter-clockwise rotation by
 * `angle` of the row vector `v`. Written out because the row-vector
 * convention is the easy thing to get backwards when porting to JS.
 */
function rotate2(x: number, y: number, angle: number): [number, number] {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [c * x - s * y, s * x + c * y];
}

/**
 * Camera angles as the shader reads them. `useCamera` encodes
 * `mouse.x = theta / 2pi` and `mouse.y = phi / pi`.
 */
export interface CameraState {
  mouseX: number;
  mouseY: number;
  /** `params.zoom`, before the ×2 the renderer applies. */
  zoom: number;
}

/** Rotate a camera-frame vector into world space (shader order: X then Y). */
export function cameraToWorld(v: Vec3, cam: CameraState): Vec3 {
  const ax = (cam.mouseY - 0.5) * Math.PI;
  const ay = (cam.mouseX - 0.5) * Math.PI * 2;

  const [y1, z1] = rotate2(v[1], v[2], ax);
  const [x2, z2] = rotate2(v[0], z1, ay);
  return [x2, y1, z2];
}

/** Inverse of {@link cameraToWorld}: undo Y first, then X. */
export function worldToCamera(v: Vec3, cam: CameraState): Vec3 {
  const ax = (cam.mouseY - 0.5) * Math.PI;
  const ay = (cam.mouseX - 0.5) * Math.PI * 2;

  const [x0, z0] = rotate2(v[0], v[2], -ay);
  const [y1, z1] = rotate2(v[1], z0, -ax);
  return [x0, y1, z1];
}

/**
 * Project a world-space point to CSS pixel coordinates.
 *
 * `width`/`height` are the canvas's CSS size; the shader normalises by the
 * smaller dimension, which is reproduced here.
 */
export function projectToScreen(
  world: Vec3,
  cam: CameraState,
  width: number,
  height: number,
): ScreenPoint {
  const local = worldToCamera(world, cam);

  // Offset from the camera origin, which sits at (0, 0, -zoom) in this frame.
  const dx = local[0];
  const dy = local[1];
  const dz = local[2] + cam.zoom * ZOOM_TO_DISTANCE;

  if (dz <= 1e-6) {
    return { x: 0, y: 0, depth: dz, visible: false };
  }

  const u = (SHADER_FOCAL_LENGTH * dx) / dz;
  const v = (SHADER_FOCAL_LENGTH * dy) / dz;

  const minRes = Math.min(width, height);
  return {
    x: u * minRes + 0.5 * width,
    // gl_FragCoord.y counts up from the bottom; CSS counts down from the top.
    y: height - (v * minRes + 0.5 * height),
    depth: dz,
    visible: true,
  };
}
