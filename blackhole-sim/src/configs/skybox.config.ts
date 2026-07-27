/**
 * Milky Way sky — wiki-globe fork (spec §6.2, milestone 8).
 *
 * Upstream drew the background with a procedural starfield: hashed cells for
 * stars plus an fbm nebula. This replaces it with the real ESO/S. Brunier
 * panorama, sampled equirectangularly from whatever direction each ray was
 * travelling when it escaped — so the sky is genuinely lensed rather than
 * decorated.
 *
 * The maths here lives in TS rather than inline in the GLSL string for the
 * same reason `jet.config.ts` does: the orientation and the spectral shift can
 * then be unit-tested (`src/__tests__/rendering/skybox.test.ts`) and the shader
 * cannot drift away from what the tests assert.
 *
 * Three decisions this file is the record of:
 *
 *  1. **Which asset.** `public/textures/` also ships `milkyway.jpg`,
 *     `milkyway_2020_4k.jpg` and `starmap.jpg` from upstream. No provenance was
 *     ever recorded for any of them and nothing referenced them, so they are
 *     deleted rather than shipped — §6.2 is explicit about not publishing sky
 *     imagery whose licence is unknown.
 *  2. **Orientation** — see `GALACTIC_ORIENTATION` below.
 *  3. **The colour shift** — see `shiftSpectrumRgb` below.
 */

/** Where the panorama lives inside `public/`. Prefix with `asset()` to use. */
export const SKYBOX_TEXTURE_PATH = "/textures/milky-way-eso-4k.jpg";

/** Dimensions of the shipped texture, needed for the mip-level calculation. */
export const SKYBOX_TEXTURE_WIDTH = 4096;
export const SKYBOX_TEXTURE_HEIGHT = 2048;

/**
 * Credit line. Project licensing rule #4: a new texture needs an attribution
 * line in the app's own UI as well as in wiki-globe's.
 */
export const SKYBOX_ATTRIBUTION = {
  title: "Milky Way panorama",
  credit: "ESO / S. Brunier",
  licence: "CC BY 4.0",
  url: "https://www.eso.org/public/images/eso0932a/",
  /** How the shipped file was derived from that source. */
  derivation:
    "6000x2 source area-averaged to 4096x2048 in linear light by scripts/data/generate-blackhole-skybox.ps1",
} as const;

/**
 * Orientation of the galactic frame within the simulation's frame.
 *
 * **This is a styling choice and it is stated rather than hidden.** The scene's
 * +Y axis is the hole's spin axis, which fixes the accretion disk in the Y = 0
 * plane. A black hole's spin axis and the galactic plane are physically
 * unrelated — Sgr A*'s spin, insofar as it is constrained at all, is not
 * aligned with the Galaxy — so aligning the panorama's band with the disk would
 * be inventing a correlation that does not exist, and it would also read as
 * though the band were part of the disk.
 *
 * So the galactic pole is tilted away from the spin axis by a fixed angle. The
 * numbers below are arbitrary but constant: nothing in the render depends on
 * them, and pinning them keeps the sky reproducible between runs (the
 * `?deterministic=1` requirement in §6 applies to anything that could vary).
 *
 * Milestone 10/11 will want real RA/Dec placement of named objects; when that
 * lands it keys off this same basis rather than introducing a second one.
 */
export const GALACTIC_ORIENTATION = {
  /**
   * Angle between the galactic pole and the hole's spin axis, degrees. 60°
   * puts the band across the frame at an unmistakably different angle from the
   * disk, at any camera inclination the UI allows.
   */
  tiltDeg: 60,
  /** Azimuth of the tilted pole about +Y, measured from +Z, degrees. */
  poleAzimuthDeg: 25,
  /**
   * Azimuth of the galactic centre, measured from +Z about +Y, before being
   * projected into the galactic plane. The default camera sits at −Z looking
   * toward +Z, so 55° keeps the bulge off to one side of the shadow instead of
   * directly behind it — where the shadow would eat the most interesting part
   * of the photograph.
   */
  centreAzimuthDeg: 55,
} as const;

/**
 * Overall gain applied to the panorama before it enters the linear-light
 * pipeline.
 *
 * The photograph is a long exposure with no absolute calibration, so there is
 * no physically correct number here; this is the one place in the sky path that
 * is openly a look. It is a plain multiplier in linear light, so it cannot
 * change the *relative* brightness of anything in the sky, only how the sky
 * sits against the disk.
 */
export const SKYBOX_INTENSITY = 1.6;

export type Vec3 = readonly [number, number, number];

function normalise(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

/**
 * The galactic frame's axes, expressed in scene coordinates.
 *
 * - `centre` — toward the galactic centre; the panorama's horizontal midpoint.
 * - `pole` — the north galactic pole; the panorama's top edge.
 * - `third` — completes a right-handed triple, so the longitude convention
 *   matches `scripts/data/generate-skybox.ps1` exactly and the globe and the
 *   simulator read the same pixel for the same direction.
 */
export function galacticBasis(
  orientation: {
    tiltDeg: number;
    poleAzimuthDeg: number;
    centreAzimuthDeg: number;
  } = GALACTIC_ORIENTATION,
): { centre: Vec3; pole: Vec3; third: Vec3 } {
  const toRad = Math.PI / 180;
  const tilt = orientation.tiltDeg * toRad;
  const poleAz = orientation.poleAzimuthDeg * toRad;
  const centreAz = orientation.centreAzimuthDeg * toRad;

  const pole = normalise([
    Math.sin(tilt) * Math.sin(poleAz),
    Math.cos(tilt),
    Math.sin(tilt) * Math.cos(poleAz),
  ]);

  // Gram-Schmidt the requested centre azimuth against the pole, so the centre
  // is guaranteed to lie in the galactic plane however the angles are set.
  const reference: Vec3 = [Math.sin(centreAz), 0, Math.cos(centreAz)];
  const projected: Vec3 = [
    reference[0] - dot(reference, pole) * pole[0],
    reference[1] - dot(reference, pole) * pole[1],
    reference[2] - dot(reference, pole) * pole[2],
  ];
  const centre = normalise(projected);

  return { centre, pole, third: cross(centre, pole) };
}

/**
 * Rotate a scene-frame direction into the galactic frame the panorama is
 * stored in.
 */
export function sceneToGalactic(direction: Vec3, basis = galacticBasis()): Vec3 {
  return [
    dot(direction, basis.centre),
    dot(direction, basis.pole),
    dot(direction, basis.third),
  ];
}

/**
 * Equirectangular lookup, matching `scripts/data/generate-skybox.ps1`:
 *
 *   longitude = atan2(z, x)   →  u = longitude / 2π + 0.5
 *   latitude  = asin(y)       →  v = 0.5 − latitude / π
 *
 * `v` counts down from the north pole because the image's first row is its top
 * row and the texture is uploaded without `UNPACK_FLIP_Y_WEBGL`.
 *
 * Takes a galactic-frame direction; compose with `sceneToGalactic` for a ray.
 */
export function galacticToEquirectUv(direction: Vec3): [number, number] {
  const d = normalise(direction);
  const longitude = Math.atan2(d[2], d[0]);
  const latitude = Math.asin(Math.max(-1, Math.min(1, d[1])));
  return [longitude / (2 * Math.PI) + 0.5, 0.5 - latitude / Math.PI];
}

/**
 * Dominant wavelengths of the sRGB primaries, nanometres. These are what the
 * three stored channels are treated as samples of.
 */
export const CHANNEL_WAVELENGTHS_NM = {
  red: 611.4,
  green: 549.1,
  blue: 464.2,
} as const;

/**
 * Doppler/gravitational colour shift of a sampled sky pixel.
 *
 * §6.2 and §5 both single this out: the shift must happen in **linear light**,
 * and the 1st-person path's existing `mix()` between a warm and a cool tint was
 * a hack that only survived because it was operating on procedural output. On a
 * photograph it would be obvious.
 *
 * What replaces it, and what it does *not* claim:
 *
 * - A JPEG gives three broadband samples of the sky's spectrum, not the
 *   spectrum. This treats them as a piecewise-linear spectral density across
 *   the three primary wavelengths — an approximation, and the only one here.
 * - The shift itself is exact given that approximation. With
 *   `g = ν_obs/ν_emit`, an observer's channel at λ_c sees light emitted at
 *   `λ_c · g`, so each output channel resamples the emitted curve there.
 * - Intensity carries the exact `g⁴` from Liouville's theorem — the same law
 *   the disk and the jet already use — applied by the caller, not here.
 * - Outside `[464, 611] nm` the photograph has nothing, so the curve is held
 *   flat at its endpoints. A strong blueshift therefore stops getting *redder*
 *   source material once `λ_red · g` passes the top of the range: the colour
 *   saturates instead of continuing to shift. That is a limit of the data, and
 *   it is better than extrapolating a spectrum that was never measured.
 */
export function shiftSpectrumRgb(
  rgb: readonly [number, number, number],
  g: number,
): [number, number, number] {
  const shift = Math.max(1e-4, g);
  return [
    sampleSpectrum(rgb, CHANNEL_WAVELENGTHS_NM.red * shift),
    sampleSpectrum(rgb, CHANNEL_WAVELENGTHS_NM.green * shift),
    sampleSpectrum(rgb, CHANNEL_WAVELENGTHS_NM.blue * shift),
  ];
}

/**
 * Piecewise-linear spectral density through (blue, green, red), held flat
 * outside the sampled range.
 */
export function sampleSpectrum(
  rgb: readonly [number, number, number],
  wavelengthNm: number,
): number {
  const { red, green, blue } = CHANNEL_WAVELENGTHS_NM;
  const [r, g, b] = rgb;
  if (wavelengthNm <= blue) return b;
  if (wavelengthNm >= red) return r;
  if (wavelengthNm <= green) {
    const t = (wavelengthNm - blue) / (green - blue);
    return b + (g - b) * t;
  }
  const t = (wavelengthNm - green) / (red - green);
  return g + (r - g) * t;
}

/**
 * Values injected into the GLSL sky chunk. Keeping the shader's numbers on this
 * side means the tests above constrain the render rather than a copy of it.
 */
export const SKYBOX_SHADER_CONSTANTS = {
  lambdaRed: CHANNEL_WAVELENGTHS_NM.red,
  lambdaGreen: CHANNEL_WAVELENGTHS_NM.green,
  lambdaBlue: CHANNEL_WAVELENGTHS_NM.blue,
  textureWidth: SKYBOX_TEXTURE_WIDTH,
} as const;
