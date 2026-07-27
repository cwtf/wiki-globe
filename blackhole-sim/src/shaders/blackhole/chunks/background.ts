import { SKYBOX_SHADER_CONSTANTS } from "@/configs/skybox.config";

/**
 * Sky background.
 *
 * wiki-globe fork (spec §6.2, milestone 8): upstream's procedural starfield is
 * still here, but it is now the *fallback* — used before the ESO panorama has
 * finished loading, if it fails to load, or if the WebGPU path (which has its
 * own simplified port) is in use. The real sky is an equirectangular lookup
 * from the escaped ray's direction, so it is lensed by the same integration
 * that produces the shadow rather than being a backdrop pasted behind it.
 *
 * The numbers below come from configs/skybox.config.ts, where they are
 * unit-tested; nothing here is a second copy of them.
 */
export const BACKGROUND_CHUNK = `
  #define SKY_TEX_WIDTH ${SKYBOX_SHADER_CONSTANTS.textureWidth.toFixed(1)}
  #define SKY_LAMBDA_R ${SKYBOX_SHADER_CONSTANTS.lambdaRed.toFixed(1)}
  #define SKY_LAMBDA_G ${SKYBOX_SHADER_CONSTANTS.lambdaGreen.toFixed(1)}
  #define SKY_LAMBDA_B ${SKYBOX_SHADER_CONSTANTS.lambdaBlue.toFixed(1)}

  // Procedural starfield with spectral-class color variation.
  // Fallback only -- see the module comment.
  vec3 starfield(vec3 dir) {
    vec3 stars = vec3(0.0);

    // Large stars (bright, rare)
    vec3 cell = floor(dir * 200.0);
    float starNoise = hash(cell);
    if(starNoise > 0.998) {
      float brightness = pow(starNoise, 10.0) * 2.0;
      float bv = hash(cell + 127.1) * 2.4 - 0.4;
      float twinkle = 0.85 + 0.15 * sin(u_time * (3.0 + hash(cell + 73.7) * 2.0));
      stars = starColor(bv) * brightness * twinkle;
    }

    // Small stars (dimmer, more numerous)
    cell = floor(dir * 500.0);
    starNoise = hash(cell);
    if(starNoise > 0.996) {
      float brightness = pow(starNoise, 20.0) * 1.5;
      float bv = hash(cell + 217.3) * 2.4 - 0.4;
      stars += starColor(bv) * brightness;
    }

    // Nebula-like background glow
    float nebula = fbm(dir * 2.0 + u_time * 0.01) * 0.03;
    stars += vec3(nebula * 0.2, nebula * 0.3, nebula * 0.5) + vec3(0.05, 0.02, 0.05) * length(nebula);

    return stars;
  }

  /**
   * Mip level for the panorama lookup.
   *
   * Deliberately NOT left to the hardware. Automatic LOD differentiates the
   * UV, and the longitude wrap makes du jump by ~1 along the seam, which would
   * select the 1x1 mip there and draw a blurred vertical line down the sky.
   * Differentiating the ray DIRECTION instead has no seam, and it is also the
   * physically right quantity: near the critical curve neighbouring pixels see
   * wildly different parts of the sky, so the footprint really is enormous
   * there and the blur is the demagnification, not an artefact.
   *
   * The 1/cos(latitude) term is the usual equirect pole correction: texels
   * crowd together in longitude toward the poles, so the same angular
   * footprint covers more of them.
   */
  float sky_lod(vec3 ddx, vec3 ddy, float sinLat) {
    float angularStep = max(length(ddx), length(ddy));
    float cosLat = sqrt(max(1e-3, 1.0 - sinLat * sinLat));
    float texelsPerPixel = angularStep * (SKY_TEX_WIDTH / (2.0 * PI)) / cosLat;
    return log2(max(texelsPerPixel, 1e-4));
  }

  /**
   * Piecewise-linear spectral density through the three stored channels, held
   * flat outside the sampled range. See shiftSpectrumRgb() in
   * configs/skybox.config.ts for what this does and does not claim.
   */
  float sky_spectrum(vec3 rgb, float lambda) {
    if (lambda <= SKY_LAMBDA_B) return rgb.b;
    if (lambda >= SKY_LAMBDA_R) return rgb.r;
    if (lambda <= SKY_LAMBDA_G) {
      return mix(rgb.b, rgb.g, (lambda - SKY_LAMBDA_B) / (SKY_LAMBDA_G - SKY_LAMBDA_B));
    }
    return mix(rgb.g, rgb.r, (lambda - SKY_LAMBDA_G) / (SKY_LAMBDA_R - SKY_LAMBDA_G));
  }

  /**
   * Colour shift of the sky by g = nu_obs / nu_emit, in LINEAR LIGHT.
   *
   * The linear part is load-bearing and is why the panorama is uploaded as
   * SRGB8_ALPHA8: the sampler decodes, this shifts, and the single gamma
   * encode at the end of main() (or in the post chain) re-encodes. Shifting
   * gamma-encoded numbers would be wrong by a power of 2.2 while still looking
   * plausible, which is exactly the failure §5 warns about.
   *
   * An observer's channel at lambda_c sees light that was emitted at
   * lambda_c * g, so each output channel resamples the emitted curve there.
   * Intensity is NOT applied here -- the caller multiplies by g^4, the same
   * Liouville factor the disk and jet use.
   */
  vec3 sky_shift(vec3 rgb, float g) {
    float s = max(1e-4, g);
    return vec3(
      sky_spectrum(rgb, SKY_LAMBDA_R * s),
      sky_spectrum(rgb, SKY_LAMBDA_G * s),
      sky_spectrum(rgb, SKY_LAMBDA_B * s)
    );
  }

  /**
   * The sky in the direction a ray was travelling when it escaped.
   *
   * Equirectangular lookup matching scripts/data/generate-skybox.ps1 exactly,
   * so the globe's cube map and this panorama read the same pixel for the same
   * direction. u_sky_basis_* are the galactic frame's axes expressed in scene
   * coordinates; the tilt between the galactic plane and the accretion disk is
   * a stated styling choice, documented in configs/skybox.config.ts.
   *
   * Must be called from uniform control flow (dFdx).
   */
  vec3 sky(vec3 dir) {
    vec3 ddx = dFdx(dir);
    vec3 ddy = dFdy(dir);

    if (u_sky_enabled < 0.5) return starfield(dir);

    vec3 g = vec3(
      dot(dir, u_sky_basis_x),
      dot(dir, u_sky_basis_y),
      dot(dir, u_sky_basis_z)
    );
    float sinLat = clamp(g.y, -1.0, 1.0);
    vec2 uv = vec2(
      atan(g.z, g.x) / (2.0 * PI) + 0.5,
      0.5 - asin(sinLat) / PI
    );

    return textureLod(u_skyTex, uv, sky_lod(ddx, ddy, sinLat)).rgb * u_sky_intensity;
  }
`;
