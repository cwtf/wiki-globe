export const BLACKBODY_CHUNK = `
  /**
   * Blackbody colour from the Planckian locus (spec §1.3).
   *
   * wiki-globe fork. This replaces the Tanner-Helland / Mitchell Charity fit
   * upstream used, which is only calibrated to roughly 40,000 K. A real thin
   * disk around a stellar-mass black hole peaks near 10^7 K, three orders of
   * magnitude outside that fit's range, where it kept driving red and green
   * down and returned a saturated blue (about sRGB 71,121,255) that no
   * blackbody of any temperature actually has.
   *
   * The physical answer: above ~20,000 K the visible band is deep in the
   * Rayleigh-Jeans tail, so chromaticity stops changing and converges to a
   * fixed point. Kim et al. (2002)'s cubic approximation of the Planckian
   * locus gives that for free — its 1/T terms simply vanish, leaving the
   * limit CIE xy = (0.2404, 0.2351), a pale blue-white. No clamp needed; the
   * approximation asymptotes correctly on its own.
   *
   * Consequence worth understanding before "fixing" a flat-looking disk: a
   * truthful hot disk has almost no colour variation across it, because every
   * part of it is in the same tail. The visible structure is *brightness*
   * from the delta^4 beaming, not hue. The orange-to-white gradient in most
   * black hole renders is a false-colour choice, reachable here by dialling
   * the disk temperature down.
   *
   * @param temp Observed temperature (K), already Doppler-shifted by delta
   * @return Linear RGB colour, normalised so the largest channel is 1
   */
  vec3 blackbody(float temp) {
    // Clamp low to stay inside the fit (and to survive the infinite redshift
    // at the horizon, where temp goes to zero).
    float T = clamp(temp, 1000.0, 1.0e9);

    // Kilo-kelvin reciprocal: the published coefficients are in 1e9/T^3,
    // 1e6/T^2, 1e3/T, which is exactly u^3, u^2, u for u = 1000/T.
    float u = 1000.0 / T;
    float u2 = u * u;
    float u3 = u2 * u;

    float x;
    if (T < 4000.0) {
      x = -0.2661239 * u3 - 0.2343589 * u2 + 0.8776956 * u + 0.179910;
    } else {
      x = -3.0258469 * u3 + 2.1070379 * u2 + 0.2226347 * u + 0.240390;
    }

    float x2 = x * x;
    float x3 = x2 * x;

    float y;
    if (T < 2222.0) {
      y = -1.1063814 * x3 - 1.34811020 * x2 + 2.18555832 * x - 0.20219683;
    } else if (T < 4000.0) {
      y = -0.9549476 * x3 - 1.37418593 * x2 + 2.09137015 * x - 0.16748867;
    } else {
      y =  3.0817580 * x3 - 5.87338670 * x2 + 3.75112997 * x - 0.37001483;
    }

    // CIE xyY (Y = 1) -> XYZ -> linear sRGB.
    float Y = 1.0;
    float X = x / max(y, 1e-4);
    float Z = (1.0 - x - y) / max(y, 1e-4);

    vec3 rgb = vec3(
       3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z,
      -0.9692660 * X + 1.8760108 * Y + 0.0415560 * Z,
       0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z
    );

    // Clip out-of-gamut negatives, then normalise on the largest channel so
    // hue is preserved and brightness stays the job of beaming and density.
    rgb = max(rgb, vec3(0.0));
    return rgb / max(max(rgb.r, max(rgb.g, rgb.b)), 1e-4);
  }

  // Approximate star color from B-V color index
  vec3 starColor(float bv) {
    float t = clamp(bv, -0.4, 2.0);
    vec3 col;
    if(t < 0.0) col = vec3(0.6, 0.7, 1.0); // O/B
    else if(t < 0.3) col = vec3(0.85, 0.88, 1.0); // A
    else if(t < 0.6) col = vec3(1.0, 0.96, 0.9); // F
    else if(t < 1.0) col = vec3(1.0, 0.85, 0.6); // G/K
    else col = vec3(1.0, 0.6, 0.4); // M
    return col;
  }
`;
