/**
 * Milky Way sky texture — wiki-globe fork (spec §6.2, milestone 8).
 *
 * Loads the ESO/S. Brunier panorama and hands the renderer a texture the
 * fragment shader can sample from an escaped ray direction. See
 * `@/configs/skybox.config` for the orientation and colour-shift decisions;
 * this file is only the GL plumbing.
 *
 * Three details that are not incidental:
 *
 * - **`SRGB8_ALPHA8`, not `RGBA8`.** The whole shader works in linear light —
 *   `blackbody()` explicitly converts its sRGB approximation up, and the final
 *   gamma encode happens once at the end (or in the post chain, under
 *   `ENABLE_LINEAR_OUTPUT`). Letting the sampler do the sRGB decode puts the
 *   photograph in the same space as the disk emission for free, which is what
 *   §5 means by shifting the sky "in linear light". Sampling it as RGBA8 and
 *   multiplying by g⁴ would be shifting gamma-encoded numbers, i.e. wrong by a
 *   power of 2.2 in a way that looks plausible.
 * - **Mipmapped.** A 4096-wide equirect sampled by a ray direction that varies
 *   wildly between neighbouring pixels near the shadow aliases badly; the
 *   shader picks a level explicitly from the angular footprint rather than from
 *   screen-space derivatives of the UV, which would blow up at the longitude
 *   seam.
 * - **Load state is observable.** A deterministic capture that starts before
 *   the JPEG arrives would silently record the procedural fallback, which is
 *   exactly the class of frame-count dependence `?deterministic=1` exists to
 *   kill. `getSkyboxStatus()` is surfaced on `window.__bh` so the capture
 *   harness can wait for it.
 */

import { asset } from "@/configs/deployment.config";
import {
  SKYBOX_TEXTURE_HEIGHT,
  SKYBOX_TEXTURE_PATH,
  SKYBOX_TEXTURE_WIDTH,
} from "@/configs/skybox.config";

export type SkyboxStatus = "idle" | "loading" | "ready" | "failed";

let status: SkyboxStatus = "idle";

/** Current load state of the sky panorama, for `window.__bh` and captures. */
export function getSkyboxStatus(): SkyboxStatus {
  return status;
}

export class SkyboxTexture {
  private gl: WebGL2RenderingContext;
  private texture: WebGLTexture | null = null;
  private image: HTMLImageElement | null = null;
  private disposed = false;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
  }

  /** The uploaded texture, or null while loading or after a failure. */
  public get(): WebGLTexture | null {
    return this.texture;
  }

  public get status(): SkyboxStatus {
    return status;
  }

  /**
   * Start loading. Safe to call more than once; only the first does work.
   *
   * Deliberately not awaited by the renderer: until the panorama arrives the
   * shader falls back to the procedural starfield, so the first frames draw a
   * sky rather than a black void.
   */
  public load(): void {
    if (this.image || this.disposed) return;
    status = "loading";

    const image = new Image();
    this.image = image;
    // Same origin under both `next dev` and the exported build, so no CORS
    // dance — but the path is a plain string literal, which `basePath` does
    // not rewrite. It has to go through `asset()`.
    image.src = asset(SKYBOX_TEXTURE_PATH);

    image.onload = () => {
      if (this.disposed) return;
      try {
        this.upload(image);
        status = "ready";
      } catch (e) {
        status = "failed";
        // eslint-disable-next-line no-console
        console.warn("[skybox] upload failed; keeping procedural sky", e);
      }
    };

    image.onerror = () => {
      if (this.disposed) return;
      status = "failed";
      // eslint-disable-next-line no-console
      console.warn(
        `[skybox] ${image.src} failed to load; keeping procedural sky`,
      );
    };
  }

  private upload(image: HTMLImageElement) {
    const gl = this.gl;

    if (
      image.naturalWidth !== SKYBOX_TEXTURE_WIDTH ||
      image.naturalHeight !== SKYBOX_TEXTURE_HEIGHT
    ) {
      // Not fatal — the shader's mip selection uses the declared width, so a
      // different asset just biases sharpness — but it means the committed
      // texture and the config have drifted, which is worth saying out loud.
      // eslint-disable-next-line no-console
      console.warn(
        `[skybox] expected ${SKYBOX_TEXTURE_WIDTH}x${SKYBOX_TEXTURE_HEIGHT}, ` +
          `got ${image.naturalWidth}x${image.naturalHeight}`,
      );
    }

    const texture = gl.createTexture();
    if (!texture) throw new Error("createTexture returned null");

    gl.bindTexture(gl.TEXTURE_2D, texture);
    // The equirect V mapping in skybox.config.ts counts down from the north
    // pole precisely because the image's first row lands at t = 0. Flipping
    // here would put the Galaxy upside down.
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.SRGB8_ALPHA8,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      image,
    );
    gl.generateMipmap(gl.TEXTURE_2D);

    // Longitude wraps; latitude does not — clamping T stops the north pole
    // bleeding into the south one.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(
      gl.TEXTURE_2D,
      gl.TEXTURE_MIN_FILTER,
      gl.LINEAR_MIPMAP_LINEAR,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    const aniso =
      gl.getExtension("EXT_texture_filter_anisotropic") ??
      gl.getExtension("WEBKIT_EXT_texture_filter_anisotropic");
    if (aniso) {
      const max = gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT);
      gl.texParameterf(
        gl.TEXTURE_2D,
        aniso.TEXTURE_MAX_ANISOTROPY_EXT,
        Math.min(8, max),
      );
    }

    this.texture = texture;
  }

  public cleanup() {
    this.disposed = true;
    if (this.texture) {
      this.gl.deleteTexture(this.texture);
      this.texture = null;
    }
    this.image = null;
    status = "idle";
  }
}
