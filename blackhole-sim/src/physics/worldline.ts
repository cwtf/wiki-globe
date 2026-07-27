/**
 * Dropped test object: worldline storage and sampling (spec §1.5 / §1.6).
 *
 * wiki-globe fork. The Rust side integrates once and hands back a flat buffer;
 * everything here is read-only interpretation of that one buffer.
 *
 * The central rule from §1.6 and §5: **there is one worldline and two ways to
 * index it.** The 3rd-person view advances the distant observer's clock and
 * looks up `t_far`; the 1st-person view advances the object's own clock and
 * looks up `tau`. Re-integrating per view would let them disagree about where
 * the object is.
 */

/**
 * Floats per sample in the buffer from `integrate_test_object`:
 * `[tau, t, tFar, r, theta, phi, u_t, u_r, u_theta, u_phi, e[0..16]]`.
 *
 * The 4-velocity is carried so the 1st-person view can reason about the
 * observer's motion, and the orthonormal frame itself is precomputed on the
 * Rust side — the camera needs it every frame, and the physics engine lives in
 * a worker, so computing it on demand would make the render path asynchronous.
 */
export const WORLDLINE_STRIDE = 26;

/** Offset of the tetrad block within a sample. */
export const TETRAD_OFFSET = 10;

export interface WorldlinePoint {
  /** The object's own clock. Finite through the horizon. */
  tau: number;
  /** Kerr-Schild time. Also finite through the horizon. */
  t: number;
  /**
   * Distant static observer's clock. Diverges at the horizon and is
   * `Infinity` at or inside it — which is exactly why the 3rd-person view
   * never sees a crossing.
   */
  tFar: number;
  r: number;
  theta: number;
  phi: number;
  /**
   * Contravariant 4-velocity (u^t, u^r, u^theta, u^phi) at this point.
   */
  u: [number, number, number, number];
  /**
   * The observer's orthonormal frame, row-major `e[a][mu]` (16 numbers),
   * in coordinate basis (t, r, theta, phi). Row 0 is the 4-velocity.
   *
   * Taken from the nearest recorded sample rather than interpolated:
   * blending two frames component-wise does not generally produce an
   * orthonormal one, and a subtly non-orthonormal frame is exactly the
   * "ad-hoc" failure spec §5 warns about. Sample density is high enough that
   * the nearest frame is accurate to well under a pixel.
   */
  tetrad: number[];
}

export interface WorldlineAudit {
  energy: number;
  angularMomentum: number;
  energyDrift: number;
  angularMomentumDrift: number;
  properTime: number;
  coordinateTime: number;
  endReason: number;
  sampleCount: number;
}

/** Spec §1.5: log if conservation drifts past this. */
export const DRIFT_TOLERANCE = 1e-6;

export class Worldline {
  readonly samples: Float32Array;
  readonly count: number;
  readonly audit: WorldlineAudit;

  /** Index of the last sample with finite `t_far`, i.e. the last one a distant
   * observer can ever see. Everything after it is inside the horizon. */
  readonly lastVisibleIndex: number;

  constructor(samples: Float32Array, audit: WorldlineAudit) {
    this.samples = samples;
    this.count = Math.floor(samples.length / WORLDLINE_STRIDE);
    this.audit = audit;

    let last = -1;
    for (let i = 0; i < this.count; i++) {
      if (Number.isFinite(samples[i * WORLDLINE_STRIDE + 2])) last = i;
      else break;
    }
    this.lastVisibleIndex = last;
  }

  /**
   * Read one float. `noUncheckedIndexedAccess` types typed-array reads as
   * possibly undefined; every call here is bounds-clamped by construction, so
   * the fallback is unreachable rather than a silent default.
   */
  private f(index: number): number {
    return this.samples[index] ?? 0;
  }

  at(index: number): WorldlinePoint {
    const i = Math.min(Math.max(index, 0), this.count - 1) * WORLDLINE_STRIDE;
    return {
      tau: this.f(i),
      t: this.f(i + 1),
      tFar: this.f(i + 2),
      r: this.f(i + 3),
      theta: this.f(i + 4),
      phi: this.f(i + 5),
      u: [this.f(i + 6), this.f(i + 7), this.f(i + 8), this.f(i + 9)],
      tetrad: this.tetradAtOffset(i),
    };
  }

  private tetradAtOffset(sampleOffset: number): number[] {
    const out = new Array<number>(16);
    for (let k = 0; k < 16; k++) {
      out[k] = this.f(sampleOffset + TETRAD_OFFSET + k);
    }
    return out;
  }

  /** Whether conservation stayed inside the spec's tolerance. */
  get conserved(): boolean {
    return (
      this.audit.energyDrift < DRIFT_TOLERANCE &&
      this.audit.angularMomentumDrift < DRIFT_TOLERANCE
    );
  }

  /** Proper time at the last sample. */
  get totalProperTime(): number {
    return this.count > 0 ? this.at(this.count - 1).tau : 0;
  }

  /**
   * Smallest and largest radius actually reached, in M.
   *
   * The *measured* apsides — spec §6.3 wants the drag to be checkable against
   * what the integration did, not against what the solver intended. When the
   * two disagree the panel says so rather than repeating the request back.
   */
  radialExtent(): { min: number; max: number } {
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < this.count; i++) {
      const r = this.f(i * WORLDLINE_STRIDE + 3);
      if (r < min) min = r;
      if (r > max) max = r;
    }
    return this.count > 0 ? { min, max } : { min: 0, max: 0 };
  }

  /**
   * Sample by the object's own clock — the 1st-person view (§1.6).
   * Clamps past the end, which is the singularity.
   */
  sampleByProperTime(tau: number): WorldlinePoint {
    return this.interpolate(tau, 0);
  }

  /**
   * Sample by the distant observer's clock — the 3rd-person view (§1.6).
   *
   * Because `t_far` diverges at the horizon, no finite argument ever reaches a
   * sample inside it: the object asymptotically slows and freezes, and is
   * never seen to cross. That behaviour is a property of the data, not a
   * special case in this function.
   */
  sampleByFarTime(tFar: number): WorldlinePoint {
    if (this.lastVisibleIndex < 0) return this.at(0);
    return this.interpolate(tFar, 2, this.lastVisibleIndex);
  }

  /**
   * Emitted-to-observed frequency ratio for light leaving the object, in the
   * static (Schwarzschild) approximation `sqrt(1 - r_s/r)`.
   *
   * Drives the 3rd-person redshift fade: as the object approaches the horizon
   * its image dims and reddens to black. Returns 0 at and inside the horizon.
   */
  redshiftFactor(r: number, rs: number): number {
    if (r <= rs) return 0;
    return Math.sqrt(1 - rs / r);
  }

  /** Equatorial-plane Cartesian position, matching the shader's Y-up axis. */
  toCartesian(p: WorldlinePoint): [number, number, number] {
    const sinTheta = Math.sin(p.theta);
    return [
      p.r * sinTheta * Math.cos(p.phi),
      p.r * Math.cos(p.theta),
      p.r * sinTheta * Math.sin(p.phi),
    ];
  }

  /**
   * Trail positions up to `index`, thinned to at most `maxPoints`.
   */
  trail(index: number, maxPoints = 256): [number, number, number][] {
    const end = Math.min(index, this.count - 1);
    if (end <= 0) return [];
    const stride = Math.max(1, Math.ceil(end / maxPoints));
    const out: [number, number, number][] = [];
    for (let i = 0; i <= end; i += stride) {
      out.push(this.toCartesian(this.at(i)));
    }
    return out;
  }

  /**
   * Binary search on a monotonically increasing column, then linear
   * interpolation between the bracketing samples.
   *
   * `offset` selects the clock: 0 = tau, 2 = t_far.
   */
  private interpolate(
    value: number,
    offset: number,
    maxIndex = this.count - 1,
  ): WorldlinePoint {
    if (this.count === 0) {
      return {
        tau: 0,
        t: 0,
        tFar: 0,
        r: 0,
        theta: 0,
        phi: 0,
        u: [1, 0, 0, 0],
        // Identity frame: a static observer in flat space.
        tetrad: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      };
    }
    const first = this.f(offset);
    if (!(value > first)) return this.at(0);

    const lastVal = this.f(maxIndex * WORLDLINE_STRIDE + offset);
    if (value >= lastVal) return this.at(maxIndex);

    let lo = 0;
    let hi = maxIndex;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.f(mid * WORLDLINE_STRIDE + offset) <= value) lo = mid;
      else hi = mid;
    }

    const a = this.at(lo);
    const b = this.at(hi);
    const va = offset === 0 ? a.tau : a.tFar;
    const vb = offset === 0 ? b.tau : b.tFar;
    const span = vb - va;
    const f = span > 0 ? (value - va) / span : 0;

    // phi is interpolated on the short arc so the marker cannot jump a full
    // turn backwards when the recorded angle wraps.
    let dphi = b.phi - a.phi;
    while (dphi > Math.PI) dphi -= 2 * Math.PI;
    while (dphi < -Math.PI) dphi += 2 * Math.PI;

    // t_far diverges at the horizon and is Infinity beyond it, so linear
    // interpolation across that boundary is meaningless — take the nearer
    // sample instead of producing Infinity or NaN.
    const tFar =
      Number.isFinite(a.tFar) && Number.isFinite(b.tFar)
        ? a.tFar + (b.tFar - a.tFar) * f
        : f < 0.5
          ? a.tFar
          : b.tFar;

    return {
      tau: a.tau + (b.tau - a.tau) * f,
      t: a.t + (b.t - a.t) * f,
      // Each clock interpolates from its own column. Deriving this from the
      // column being *searched* made proper-time lookups report tau as t_far,
      // so the two clocks in the 1st-person HUD read identically — which is
      // precisely the disagreement §1.6 exists to show.
      tFar,
      r: a.r + (b.r - a.r) * f,
      theta: a.theta + (b.theta - a.theta) * f,
      phi: a.phi + dphi * f,
      // Linear blend is adequate between adjacent samples of a smooth
      // worldline; the frame is rebuilt from it by Gram-Schmidt, which
      // re-normalises anyway, so small interpolation error does not
      // accumulate into a non-orthonormal basis.
      u: [
        a.u[0] + (b.u[0] - a.u[0]) * f,
        a.u[1] + (b.u[1] - a.u[1]) * f,
        a.u[2] + (b.u[2] - a.u[2]) * f,
        a.u[3] + (b.u[3] - a.u[3]) * f,
      ],
      // Nearest, never blended — see the note on WorldlinePoint.tetrad.
      tetrad: f < 0.5 ? a.tetrad : b.tetrad,
    };
  }
}

/** Drop presets, matching the `preset` codes in `integrate_test_object`. */
export const DROP_PRESETS = {
  circular: 0,
  isco: 1,
  radialFall: 2,
  eccentric: 3,
  custom: 4,
  /** Named by its two turning points (spec §6.3, milestone 9). */
  apsides: 5,
} as const;

export type DropPresetName = keyof typeof DROP_PRESETS;

export interface DropRequest {
  preset: number;
  r0: number;
  tangentialFraction: number;
  radialVelocity: number;
  innerRadius: number;
  maxSteps: number;
  maxSamples: number;
  /** Periapsis in M. Read only by the `apsides` preset. */
  rPeri: number;
}

/**
 * Build a drop request from UI state.
 *
 * `innerRadius` defaults to 0, which the Rust side reads as "just outside the
 * horizon" — the right stopping point for the 3rd-person view, which cannot
 * see further in anyway. Milestone 5 pushes it to ~0.02 r_s to ride the object
 * to the singularity.
 */
export function buildDropRequest(
  preset: DropPresetName,
  options: {
    r0?: number;
    tangentialFraction?: number;
    radialVelocity?: number;
    innerRadius?: number;
    maxSteps?: number;
    maxSamples?: number;
    rPeri?: number;
  } = {},
): DropRequest {
  return {
    preset: DROP_PRESETS[preset],
    r0: options.r0 ?? 20,
    tangentialFraction: options.tangentialFraction ?? 1,
    radialVelocity: options.radialVelocity ?? 0,
    innerRadius: options.innerRadius ?? 0,
    maxSteps: options.maxSteps ?? 200_000,
    maxSamples: options.maxSamples ?? 8_000,
    // The apsides preset reads r0 as the apoapsis and this as the periapsis;
    // 0 is inert for every other preset.
    rPeri: options.rPeri ?? 0,
  };
}
