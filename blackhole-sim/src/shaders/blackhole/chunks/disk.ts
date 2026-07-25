import { PHYSICS_CONSTANTS } from "@/configs/physics.config";
import { JET_SHADER_CONSTANTS as JET } from "@/configs/jet.config";

export const DISK_CHUNK = `
  // Accretion Disk Physics & Rendering
  // Inputs:
  //   p: current ray position (vec3)
  //   ro: ray origin (vec3)
  //   r: current radius from BH center
  //   isco: innermost stable circular orbit
  //   M: black hole mass
  //   a: black hole spin parameter
  //   dt: integration step size (for density integration)
  //   accumulatedColor: (inout)
  //   accumulatedAlpha: (inout)

  void sample_accretion_disk(
      vec3 p, vec3 p_prev, vec3 ro, vec3 v, float r, float isco, float M, float a, float dt, float rs,
      inout vec3 accumulatedColor, inout float accumulatedAlpha
  ) {
      if (u_show_redshift < 0.5) {
          // SCIENTIFIC FIX: Plane-Crossing Detection (Eliminates "holes" from step-skipping)
          // If the ray crossed the equator (p_prev.y * p.y < 0), we force a sample at the intersection
          bool crossedEquator = (p_prev.y * p.y < 0.0);
          
          vec3 sampleP = p;
          if (crossedEquator) {
              float t = abs(p_prev.y) / max(0.0001, abs(p_prev.y) + abs(p.y));
              sampleP = mix(p_prev, p, t);
          }
          
          float sampleR = length(sampleP);
          
          float effectiveScaleHeight = min(u_disk_scale_height, ${PHYSICS_CONSTANTS.accretion.diskHeightMultiplier.toFixed(3)});
          float diskHeight = sampleR * effectiveScaleHeight;

          // SCIENTIFIC FIX: Ensure ISCO creates a hard edge even for retrograde orbits
          float diskInner = isco;
          float diskOuter = max(M * u_disk_size, diskInner * 1.1);

          if((abs(sampleP.y) < diskHeight || crossedEquator) && sampleR > diskInner && sampleR < diskOuter) {

              // Exact Kerr orbital rotation for turbulence map
              float sqrt_M_phase = sqrt(M);
              float signSpinPhase = sign(u_spin + 1e-8);
              float OmegaPhase = (signSpinPhase * sqrt_M_phase) / (sampleR * sqrt(sampleR) + a * sqrt_M_phase);
              
              // Frame-dragged phase rotation
              float rotAngle = OmegaPhase * u_time * ${PHYSICS_CONSTANTS.accretion.timeScale.toFixed(2)} * 10.0;
              mat2 rotPhase = mat2(cos(rotAngle), -sin(rotAngle), sin(rotAngle), cos(rotAngle));
              
              vec3 noiseP = sampleP;
              noiseP.xz *= rotPhase;
              noiseP *= ${PHYSICS_CONSTANTS.accretion.turbulenceScale.toFixed(2)};

              float turbulence = noise(noiseP) * 0.5 + noise(noiseP * ${PHYSICS_CONSTANTS.accretion.turbulenceDetail.toFixed(1)}) * 0.25;

              float samplesDiskHeight = sampleR * effectiveScaleHeight;
              float heightFalloff = exp(-abs(sampleP.y) / max(0.001, samplesDiskHeight * ${PHYSICS_CONSTANTS.accretion.densityFalloff.toFixed(2)}));
              float radialFalloff = smoothstep(diskOuter, diskInner, sampleR);

              float baseDensity = turbulence * heightFalloff * radialFalloff;

              if (baseDensity > 0.001) {
                  // ==========================================================
                  // PhD-GRADE EXACT KERR KINEMATICS (Page & Thorne 1974)
                  // ==========================================================
                  float r2 = sampleR * sampleR;
                  
                  // 1. Exact Keplerian Angular Velocity (Omega = dphi/dt)
                  float sqrt_M = sqrt(M);
                  float signSpin = sign(u_spin + 1e-8);
                  float Omega = (signSpin * sqrt_M) / (sampleR * sqrt(sampleR) + a * sqrt_M);

                  // 2. Exact Metric Components in Equatorial Plane (theta = pi/2)
                  float g_tt = -(1.0 - 2.0 * M / sampleR);
                  float g_tphi = -2.0 * M * a / sampleR;
                  float g_phiphi = r2 + a*a + 2.0 * M * a*a / sampleR;

                  // 3. Exact 4-Velocity Time Component (u^t)
                  // Solves g_mu_nu u^mu u^nu = -1 for circular equatorial orbits
                  float u_t_sq = -(g_tt + 2.0 * Omega * g_tphi + Omega * Omega * g_phiphi);
                  float u_t = 1.0 / sqrt(max(1e-6, u_t_sq));

                  // 4. Conserved Photon Angular Momentum (L_y)
                  // Impact parameter mapping from local frame (cross product of position and ray dir)
                  float L_photon = p.z * v.x - p.x * v.z;

                  // 5. General Relativistic Doppler Factor (delta = E_obs / E_em)
                  // Exact derivation: E_em = -k.u = u_t(1 - Omega * L_photon), E_obs = 1 at infinity
                  float delta = 1.0 / max(0.01, u_t * (1.0 - Omega * L_photon));

#ifdef ENABLE_DOPPLER
                  // Relativistic Beaming (Liouville's Theorem for Specific Intensity)
                  // Bolometric intensity scales as delta^4 exactly (I_nu/nu^3 is
                  // the invariant). wiki-globe fork: upstream used delta^3.5 for
                  // "visual dynamic range stability" — spec §1.3 makes the g^4
                  // exponent non-negotiable, since the approaching/receding
                  // brightness asymmetry is the signature of a real render.
                  // Dynamic range is the tone mapper's job, not the physics'.
                  float beaming = max(0.01, pow(delta, 4.0));
#else
                  float beaming = 1.0;
#endif
                  // 6. Novikov-Thorne Temperature Profile (Zero-Torque inner boundary)
                  float isco_r = clamp(isco / sampleR, 0.0, 1.0);
                  float nt_factor = max(0.0, 1.0 - sqrt(isco_r));
                  float radialTempGradient = pow(isco_r, 0.75) * pow(nt_factor, 0.25);

                  // Temperature natively shifted by full relativistic Doppler delta
                  // (Replacing the previous Euclidean gravRedshift multiplier)
                  float temperature = u_disk_temp * radialTempGradient * delta;
                  vec3 diskColor = blackbody(temperature) * beaming;
                  float density = baseDensity * u_disk_density * 0.12 * dt;

                  accumulatedColor += diskColor * density * (1.0 - accumulatedAlpha);
                  accumulatedAlpha += density;
              }
          }
      }
  }

  // Bipolar kinematic jet along the spin axis (spec §1.4).
  //
  // The LAUNCH mechanism is not simulated -- that needs magnetised GRMHD
  // (Blandford-Znajek). This is a parameterised conical outflow whose emission
  // is traced through the same geodesic march and the same shift factors as
  // the disk, which is what makes the observables emerge instead of being
  // painted on:
  //   * one-sidedness      -- both sides get delta^(3-alpha); the receding
  //                           cone is suppressed by orders of magnitude, and
  //                           which side is bright flips as the camera crosses
  //                           the equatorial plane, with no explicit test for
  //                           camera position anywhere in this function.
  //   * counter-jet base   -- visible around the shadow purely because strongly
  //                           bent rays reach it; nothing here knows about it.
  //   * superluminal knots -- knots advect at the bulk speed beta; the apparent
  //                           transverse speed beta sin(theta)/(1 - beta cos(theta))
  //                           is a consequence of light travel time, not a
  //                           value written into the shader.
  //
  // Constants come from src/configs/jet.config.ts so the beaming maths is unit
  // tested and cannot drift from the shader.
  void sample_relativistic_jets(
      vec3 p, vec3 v, float r, float rh, float rs, float dt,
      inout vec3 accumulatedColor, inout float accumulatedAlpha
  ) {
      float axial = abs(p.y);
      if (axial <= rh * ${JET.baseHeight.toFixed(3)} || axial >= MAX_DIST * 0.8) return;

      float cylR = length(p.xz);
      float coneR = ${JET.baseRadius.toFixed(3)} + axial * ${JET.tanTheta.toFixed(5)};
      if (cylR >= coneR) return;

      // Smooth transverse profile, brightest on the axis.
      float edge = 1.0 - clamp(cylR / max(1e-4, coneR), 0.0, 1.0);
      float transverse = edge * edge;

      // Emissivity ~ r^-2.
      float rEm = max(length(p), rh);
      float emissivity = pow(rEm, -${JET.emissivityExponent.toFixed(1)});

      // Emission knots advecting outward at the bulk speed. Sampling the
      // pattern at (axial - beta * t) is what makes a knot a feature that
      // physically moves along the flow, so its apparent speed on the sky is
      // produced by light-travel time rather than prescribed.
      float knotPhase = (axial - ${JET.beta.toFixed(6)} * u_time * ${JET.knotTimeScale.toFixed(2)}) / ${JET.knotSpacing.toFixed(2)};
      float knots = 1.0 + ${JET.knotContrast.toFixed(2)} * sin(6.28318530718 * knotPhase);

      float turb = 0.65 + 0.35 * noise(vec3(p.x, axial * 0.4 - u_time * 0.25, p.z) * 0.7);

      float density = transverse * emissivity * max(0.0, knots) * turb;
      if (density <= 1e-5) return;

      // Flow direction: outward along the spin axis on whichever side we are.
      vec3 flowDir = vec3(0.0, sign(p.y), 0.0);

      // The traced ray travels along +v away from the camera, so the photon
      // that reaches the observer left this point along -v.
      float cosTheta = dot(flowDir, -v);

      float beta = ${JET.beta.toFixed(6)};
      float gamma = ${JET.gamma.toFixed(4)};
      float deltaDop = 1.0 / max(1e-4, gamma * (1.0 - beta * cosTheta));

      // Same gravitational shift the rest of the scene sees.
      float gravShift = sqrt(max(0.0, 1.0 - rs / rEm));
      float g = deltaDop * gravShift;

      float beaming = pow(max(g, 1e-4), ${JET.beamExponent.toFixed(1)});

      // Synchrotron continuum reads blue-white; the shift tints it rather than
      // recolouring it, since this is not a thermal source.
      vec3 baseJetColor = vec3(0.45, 0.7, 1.0);
      vec3 tint = mix(vec3(1.0, 0.55, 0.4), vec3(0.6, 0.8, 1.0), clamp(g, 0.0, 1.0));

      float emission = density * ${JET.brightness.toFixed(4)} * dt;
      vec3 jetEmission = baseJetColor * tint * emission * beaming;

      accumulatedColor += jetEmission * (1.0 - accumulatedAlpha);
      accumulatedAlpha += emission;
  }
`;
