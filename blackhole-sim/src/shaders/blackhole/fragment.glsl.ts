import { PHYSICS_CONSTANTS } from "@/configs/physics.config";
import { COMMON_CHUNK } from "./chunks/common";
import { METRIC_CHUNK } from "./chunks/metric";
import { NOISE_CHUNK } from "./chunks/noise";
import { BLACKBODY_CHUNK } from "./chunks/blackbody";
import { BACKGROUND_CHUNK } from "./chunks/background";
import { DISK_CHUNK } from "./chunks/disk";

/**
 * Realistic Black Hole Fragment Shader
 *
 * Kerr Geodesic Integration (Corrected Effective Potential):
 *   Uses the Darwin potential with Kerr spin-orbit coupling and
 *   gravito-magnetic frame-dragging force. Produces the correct
 *   D-shaped shadow asymmetry (Bardeen 1973).
 *
 * Key physics:
 *   - Oblate-spheroidal Kerr r (not Euclidean distance)
 *   - L_eff^2 = (Lz - a)^2 + Q with spin-orbit coupling
 *   - Frame-dragging: velocity rotation via ZAMO omega
 *   - Gravito-magnetic force: cross(spin_axis, v) * 2Ma/r^3
 *
 * References:
 *   Bardeen (1973), Dexter & Agol (2009), James et al. (2015)
 */
export const fragmentShaderSource = `#version 300 es
${COMMON_CHUNK}

${METRIC_CHUNK}

${NOISE_CHUNK}

${BLACKBODY_CHUNK}

${BACKGROUND_CHUNK}

${DISK_CHUNK}

// === MAIN SHADER ===
void main() {
    float minRes = min(u_resolution.x, u_resolution.y);
    vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution.xy) / minRes;

    if (u_debug > 0.5) {
        fragColor = vec4(uv.x + 0.5, uv.y + 0.5, 0.0, 1.0);
        return;
    }

    // Camera
    vec3 ro, rd;
    // wiki-globe fork: photon energy at infinity for this ray, used to shift
    // the sky in 1st person. 1.0 leaves the 3rd-person path untouched.
    float fpEnergy = 1.0;
    bool firstPerson = u_fp_enabled > 0.5;

    if (firstPerson) {
        // Ray built in the rider's own frame (spec §1.6). Fixed focal length:
        // a variable FOV would masquerade as aberration (§2.4).
        vec3 n = normalize(vec3(uv, 1.2));
        ro = u_fp_pos;
        rd = normalize(u_fp_e0.xyz + n.x * u_fp_e1.xyz + n.y * u_fp_e2.xyz + n.z * u_fp_e3.xyz);
        // Contravariant p^t from the same legs; the conserved energy follows.
        fpEnergy = u_fp_e0.w + n.x * u_fp_e1.w + n.y * u_fp_e2.w + n.z * u_fp_e3.w;
    } else if (length(u_camPos) > 0.001) {
        ro = u_camPos;
        rd = qrot(u_camQuat, normalize(vec3(uv, 1.2)));
    } else {
        ro = vec3(0.0, 0.0, -u_zoom);
        rd = normalize(vec3(uv, 1.5));
        mat2 rx = rot((u_mouse.y - 0.5) * PI);
        mat2 ry = rot((u_mouse.x - 0.5) * PI * 2.0);
        ro.yz *= rx; rd.yz *= rx;
        ro.xz *= ry; rd.xz *= ry;
    }

    // Black hole parameters
    float M = u_mass;
    float rs = M * 2.0;
    float a = u_spin * M;
    float a2 = a * a;

    // Derived quantities
    float rh = kerr_horizon(M, a);
    float rph = kerr_photon_sphere(M, a);
    float isco = kerr_isco(M, a);
    float absA = abs(u_spin);

    // === LOW QUALITY MODE ===
#if defined(RAY_QUALITY_LOW) || defined(RAY_QUALITY_OFF)
    vec3 bg = starfield(rd);
    float d = length(cross(ro, rd));
    float shadow = smoothstep(rh * 1.2, rh * 0.9, d);
    float photonGlowIndicator = exp(-abs(d - rph) * 12.0) * 0.8;
    vec3 glowCol = vec3(0.3, 0.6, 1.0) * photonGlowIndicator;
    float diskMask = smoothstep(isco * 2.0, isco * 1.0, d) * (1.0 - smoothstep(isco * 1.0, isco * 0.8, d));
    vec3 diskColIndicator = vec3(1.0, 0.7, 0.3) * diskMask * 0.6;
    vec3 col = bg * (1.0 - shadow) + glowCol + diskColIndicator;
    fragColor = vec4(pow(col, vec3(0.4545)), 1.0);
    return;
#endif

    // === KERR GEODESIC RAYMARCHING ===
    vec3 p = ro;
    vec3 v = rd;

    // Kamikaze protection. Skipped in 1st person: the whole point of that view
    // is to get close to and then through the horizon, so shoving the camera
    // back out to 1.5 r_h would silently prevent the crossing (§1.6).
    if(!firstPerson && length(ro) < rh * 1.5) {
       ro = normalize(ro) * rh * 1.5;
       p = ro;
    }

    // Whether the camera itself is inside the horizon. Rays traced backwards
    // from in here can still have come from outside, so the usual "r < r_h
    // means captured" test must not fire on the very first step.
    bool cameraInside = firstPerson && length(ro) < rh;

    vec3 accumulatedColor = vec3(0.0);
    float accumulatedAlpha = 0.0;
    bool hitHorizon = false;
    float maxRedshift = 0.0;

    // Blue noise dithering
    vec2 noiseUV = gl_FragCoord.xy / 256.0;
    float bNoise = texture(u_blueNoiseTex, noiseUV).r;
    float dt_init = MIN_STEP;
    p += v * bNoise * dt_init;

    int photonCrossings = 0;
    float prevY = p.y;
    float impactParam = length(cross(ro, rd));
    bool redshiftInitialized = false;

    int maxSteps = int(min(float(u_maxRaySteps), 500.0));
    vec3 p_prev = p;

    // Inner Shadow Culling (Horizon-Safe, Bardeen 1973):
    // A ray with b = |cross(ro,rd)| < rh is captured in ANY Kerr geometry.
    // (rh is the outer event horizon radius, always <= b_crit for all spin values.)
    // This culls only the innermost shadow core -- zero overlap with photon ring
    // or accretion disk since disk inner edge = isco >> rh.
    // Safe margin: 0.9 * rh. Even at maximum spin (a=0.999M), rh = 1.045M while
    // the prograde critical impact param b_pro > 2.0M -- safe margin of 2x.
    // Not valid in 1st person: this cull assumes the ray starts far outside,
    // where the impact parameter of a straight line is meaningful.
    if (!firstPerson && impactParam < rh * 0.9) {
        hitHorizon = true;
    }

    for(int i = 0; i < maxSteps; i++) {
        p_prev = p;
        float r = length(p);

        // Horizon check (Euclidean distance for fast rejection,
        // Kerr r is only slightly different near horizon)
        if(cameraInside) {
            // Inside, only the singularity terminates a ray; anything that
            // climbs back out is light that fell in with us and is still
            // visible as the shrinking window on the outside universe.
            if(r < rs * 0.02) {
                hitHorizon = true;
                break;
            }
        } else if(r < rh * ${PHYSICS_CONSTANTS.rayMarching.horizonThreshold.toFixed(2)}) {
            hitHorizon = true;
            break;
        }
        if(r > MAX_DIST) break;

        // Adaptive step size (curvature-aware)
        // Original formula preserved for r <= 30 (disk + strong field region).
        // For r > 30 (proven empty space beyond any disk/gravitational structure),
        // boost step size to accelerate background/star ray traversal.
        // This does NOT affect disk density accumulation (disk sampling gated on
        // r > isco && r < diskOuter, both << 30 for standard parameters) or
        // photon sphere precision (sphereProx clamp still dominates for r ~ rph).
        float distFactor = 1.0 + r * 0.05;
        float dt = clamp((r - rh) * 0.1 * distFactor, MIN_STEP, MAX_STEP * distFactor);
        if (r > 30.0) {
            // Empty-space boost: scale linearly with distance above r=30.
            // At r=60: extra boost = (60-30)*0.08 = 2.4, clamped to MAX_STEP*2.
            float farBoost = (r - 30.0) * 0.08;
            dt = max(dt, MIN_STEP + farBoost);
            dt = min(dt, MAX_STEP * 2.5);

            // wiki-globe fork (spec §6.1). The cap above is 3.0, so reaching
            // MAX_DIST = 10000 would take ~3300 steps against a budget of 256:
            // every escaping ray -- most of the screen -- used to exhaust its
            // whole budget marching through empty space and never actually
            // reach the escape test. Once a ray is outward-bound and well
            // outside the strong-field region its path is essentially
            // straight, so grow the step with radius and let it leave.
            if (dot(p, v) > 0.0) {
                dt = max(dt, r * 0.1);
                if (r > ESCAPE_RADIUS) break;
            }
        }

        float sphereProx = abs(r - rph);
        dt = min(dt, MIN_STEP + sphereProx * 0.15);

        float hRefinement = smoothstep(0.2, 0.0, abs(p.y));
        float currentDt = dt * (1.0 - hRefinement * 0.7);

        vec3 accel = vec3(0.0);
        float omega = 0.0;

#ifdef ENABLE_LENSING
        // Compute Kerr geodesic acceleration:
        // - Correct Darwin potential with spin-orbit coupled L_eff
        // - Gravito-magnetic frame-dragging force for D-shape asymmetry
        KerrAccelResult kerr = kerr_geodesic_accel(p, v, M, a);
        accel = kerr.accel * u_lensing_strength;
        omega = kerr.omega;

        // ZAMO velocity rotation: frame-dragging twists the velocity
        // (NOT the position -- rotating position creates artifacts).
        // The ZAMO angular velocity omega = 2Ma/(r^3 + a^2*r).
        mat2 zamo = rot(omega * currentDt);
        v.xz *= zamo;
#endif

        // Velocity-Verlet position step
        p += v * currentDt + 0.5 * accel * currentDt * currentDt;

        float r_new = length(p);

#ifdef ENABLE_LENSING
        // Velocity-Verlet velocity correction
        if (accumulatedAlpha < 0.95) {
            KerrAccelResult kerr_new = kerr_geodesic_accel(p, v, M, a);
            vec3 accel_new = kerr_new.accel * u_lensing_strength;
            v += 0.5 * (accel + accel_new) * currentDt;
        }
#endif
        v = normalize(v);

        // Photon crossing counter (for higher-order ring rendering)
        if(prevY * p.y < 0.0 && r_new < rph * 2.0 && r_new > rh) {
            photonCrossings = min(photonCrossings + 1, 3);
        }

        // Gravitational redshift tracking
        if (u_show_redshift > 0.5) {
            float potential = sqrt(max(0.0, 1.0 - rs / r_new));
            if (!redshiftInitialized) { maxRedshift = potential; redshiftInitialized = true; }
            else maxRedshift = min(maxRedshift, potential);
        }

        prevY = p.y;

        // Accretion disk sampling (uses Euclidean r for disk geometry)
#ifdef ENABLE_DISK
        sample_accretion_disk(p, p_prev, ro, v, r_new, isco, M, a, currentDt, rs, accumulatedColor, accumulatedAlpha);
        if(accumulatedAlpha > 0.99) break;
#endif

        // Relativistic jets
#ifdef ENABLE_JETS
        sample_relativistic_jets(p, v, r, rh, rs, dt, accumulatedColor, accumulatedAlpha);
#endif
    }

    // Gravitational Redshift Overlay
#ifdef ENABLE_REDSHIFT
    if (u_show_redshift > 0.5) {
        float val = maxRedshift;
        if (hitHorizon) val = 0.0;

        vec3 heatmap = mix(vec3(0.0), vec3(1.0, 0.0, 0.0), smoothstep(0.0, 0.3, val));
        heatmap = mix(heatmap, vec3(1.0, 1.0, 0.0), smoothstep(0.3, 0.7, val));
        heatmap = mix(heatmap, vec3(0.0, 0.0, 1.0), smoothstep(0.7, 1.0, val));

        fragColor = vec4(heatmap, 1.0);
        return;
    }
#endif

    // Background
    vec3 background = vec3(0.0);
#ifdef ENABLE_STARS
    background = starfield(v);

    if (firstPerson) {
        // Shift the sky by the SAME factor the ray construction produced.
        // g = nu_obs / nu_emit = 1 / E for a static source at infinity, with
        // E = -p_t already carrying both the observer's motion (through e0)
        // and the gravitational potential. There is deliberately no separate
        // Doppler or redshift term anywhere in this shader (§5).
        float g = 1.0 / max(1e-4, abs(fpEnergy));
        // Liouville: specific intensity scales as g^4, the same law the disk
        // and jet use.
        float boost = clamp(pow(g, 4.0), 0.0, 64.0);
        // Blue toward the direction of travel, red away from it.
        vec3 tint = mix(vec3(1.0, 0.45, 0.25), vec3(0.6, 0.8, 1.0), clamp(g, 0.0, 1.0));
        background *= boost * tint;
    }
#endif

    // Photon ring.
    //
    // wiki-globe fork: the additive glow that used to live here has been
    // REMOVED. It painted a white rim wherever a ray happened to end near
    // r_ph, as exp(-|length(p) - rph| * 40) plus a higher-order term keyed on
    // the winding count.
    //
    // Spec §1.2 lists the photon ring among the things that "must emerge from
    // the integration, never painted on", and the rendered goldens showed why
    // that matters: at a = 0 and a = 0.5 the painted ring looked convincing,
    // but at a = 0.99 edge-on it vanished entirely, leaving a shadow with no
    // rim. rph is the *prograde* photon sphere (~1.2M at that spin) while
    // the retrograde side sits near 4M, so a single-radius test matches
    // neither. A real ring deforms into the Bardeen D-shape; a painted one
    // can only switch off.
    //
    // The genuine ring is light that wound close to the critical impact
    // parameter and reached the disk or the sky, which the marcher already
    // accumulates. photonCrossings is still counted and remains available
    // if a physically-derived emphasis is ever wanted.
    vec3 photonColor = vec3(0.0);

    // Ergosphere
    vec3 ergoColor = vec3(0.0);
    if(absA > 0.1 && !hitHorizon) {
      float rFinal = length(p);
      float cosTheta = p.y / max(rFinal, 0.001);
      float r_ergo = kerr_ergosphere(M, a, rFinal, cosTheta);
      float ergoGlow = exp(-abs(rFinal - r_ergo) * 20.0) * 0.35 * absA;
      ergoColor = vec3(0.3, 0.35, 0.9) * ergoGlow;
    }

    if (hitHorizon) {
        // If we hit the horizon, the background is pitch black.
        // But we STILL see any accumulated disk emission that was in front of it!
        background = vec3(0.0);
    }

    vec3 finalColor = background * (1.0 - accumulatedAlpha) + accumulatedColor + photonColor * (1.0 - accumulatedAlpha) + ergoColor * (1.0 - accumulatedAlpha);

    // Kerr Shadow Guide (diagnostic overlay)
    if (u_show_kerr_shadow > 0.5) {
        vec3 spin_axis = vec3(0.0, 1.0, 0.0);
        vec3 cam_dir = normalize(ro);
        vec3 sky_right = normalize(cross(spin_axis, cam_dir));
        vec3 sky_up = cross(cam_dir, sky_right);
        
        // Ray impact projection in celestial coords (alpha, beta)
        // alpha: horizontal displacement (perpendicular to projected spin axis)
        // beta: vertical displacement (along projected spin axis)
        vec3 impact_vec = cross(cam_dir, rd) * length(ro);
        
        float alpha = -dot(impact_vec, sky_up); 
        float beta = dot(impact_vec, sky_right);
        vec2 p_sky = vec2(alpha, beta);

        float minDist = 1e10;
        int count = int(u_shadowCount);
        
        // Check distance to the analytical boundary polyline
        for (int j = 0; j < 63; j++) {
            if (j >= count - 1) break;
            
            vec2 p1 = u_shadowCurve[j];
            vec2 p2 = u_shadowCurve[j+1];
            
            // Distance to line segment
            vec2 pa = p_sky - p1, ba = p2 - p1;
            float h = clamp(dot(pa, ba)/dot(ba, ba), 0.0, 1.0);
            minDist = min(minDist, length(pa - ba*h));
        }
        
        // Match the first and last point to close the curve
        if (count > 2) {
            vec2 p_first = u_shadowCurve[0];
            vec2 p_last = u_shadowCurve[count - 1];
            vec2 pa_c = p_sky - p_last, ba_c = p_first - p_last;
            float h_c = clamp(dot(pa_c, ba_c)/dot(ba_c, ba_c), 0.0, 1.0);
            minDist = min(minDist, length(pa_c - ba_c*h_c));
        }

        // Visibility: smooth line with thickness proportional to Mass
        float thickness = M * 0.045; // Slightly thinner for precision
        if (minDist < thickness) {
            float edge = smoothstep(thickness, thickness * 0.5, minDist);
            finalColor = mix(finalColor, vec3(0.0, 1.0, 0.0), 1.0 * edge);
        }
    }

    // Tone Mapping & Gamma
#ifndef ENABLE_LINEAR_OUTPUT
    finalColor = aces_tone_mapping(finalColor);
    finalColor = pow(max(finalColor, 0.0), vec3(0.4545));
#endif

    fragColor = vec4(finalColor, 1.0);
}
`;
