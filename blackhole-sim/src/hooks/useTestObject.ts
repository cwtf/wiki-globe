"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { physicsBridge, type ApsidesSolution } from "@/engine/physics-bridge";
import { orderApsides, type ApsisPair } from "@/physics/apsides";
import {
  orientFrame,
  rotateByQuaternion,
  tetradToCartesian,
  type CartesianLeg,
} from "@/physics/first-person";
import { geometricRatePerSecond } from "@/physics/playback";
import {
  comfortSpeed,
  durationToSeconds,
  radiusToKm,
  tidalAccelerationG,
  timeUnitSeconds,
} from "@/configs/mass-presets";
import {
  Worldline,
  buildDropRequest,
  type DropPresetName,
} from "@/physics/worldline";

/**
 * Dropped test object: integration, playback clock, and readouts (spec §1.5).
 *
 * wiki-globe fork. The worldline is integrated **once** per drop; playback
 * only advances a clock and looks the position up. That is what keeps the
 * two camera views consistent (§1.6) and what will make the §1.9 speed slider
 * a pure playback control that cannot alter the trajectory.
 */

/**
 * Ratio of distant-observer clock rate to proper-time clock rate.
 *
 * Both views advance from the same wall-clock tick and the same speed
 * multiplier; this only reflects that a distant observer's clock runs ahead of
 * the rider's. Kept at 1 so the multiplier means exactly what §1.9 says it
 * means — the actual dilation is already baked into the worldline, and
 * applying it again here would double-count it.
 */
const OBSERVER_CLOCK_RATIO = 1.0;

export interface TestObjectReadout {
  /** Radius in Schwarzschild radii. */
  rOverRs: number;
  /** The object's own clock. */
  tau: number;
  /** Distant observer's clock; diverges as the object nears the horizon. */
  tFar: number;
  /** Kerr-Schild coordinate time. */
  t: number;
  /**
   * Speed measured by a local static observer, as a fraction of c. Derived
   * from the conserved energy: gamma_local = E / sqrt(1 - r_s/r).
   */
  localVelocity: number;
  /** Tidal stretching per unit separation, 2M/r^3 in geometric units. */
  tidal: number;
  /** Emitted/observed frequency ratio, 0 at the horizon. Drives the fade. */
  redshift: number;

  // Physical units (§1.5, §1.8). The render is mass-invariant; only these
  // change with the preset.
  /** Radius in kilometres. */
  rKm: number;
  /** Proper time in seconds. */
  tauSeconds: number;
  /** Distant-observer time in seconds; Infinity at and inside the horizon. */
  tFarSeconds: number;
  /** Tidal stretch across 1 m, in Earth gravities. */
  tidalG: number;
}

/** Which camera the simulation is being watched from (spec §1.6). */
export type ViewMode = "third" | "first";

/**
 * The rider's frame, resolved for the renderer.
 *
 * Legs are `[x, y, z, e^t]`: spatial part in the shader's Cartesian axes with
 * free-look already folded in, plus the contravariant time component that
 * carries the frequency shift.
 */
export interface FirstPersonFrame {
  pos: [number, number, number];
  e0: [number, number, number, number];
  e1: [number, number, number, number];
  e2: [number, number, number, number];
  e3: [number, number, number, number];
}

export interface UseTestObject {
  worldline: Worldline | null;
  status: "idle" | "integrating" | "ready" | "error";
  error: string | null;
  /** Current distant-observer time being displayed. */
  farTime: number;
  /** Current proper time along the object's own clock (1st person). */
  properTime: number;
  paused: boolean;
  setPaused: (p: boolean) => void;
  /** Playback multiplier: simulated seconds per wall-clock second (§1.9). */
  speed: number;
  setSpeed: (s: number) => void;
  /** Per-preset comfort speed, the labelled default detent. */
  comfort: number;
  view: ViewMode;
  /** 1st person is only meaningful while an object is on a worldline. */
  setView: (v: ViewMode) => void;
  canRideAlong: boolean;
  /** Free-look, applied inside the frame. Radians. */
  look: { yaw: number; pitch: number };
  addLook: (dYaw: number, dPitch: number) => void;
  /** Null in 3rd person; the rider's frame otherwise. */
  firstPersonFrame: FirstPersonFrame | null;
  /** True once the rider has reached the singularity. */
  reachedSingularity: boolean;
  drop: (
    preset: DropPresetName,
    options?: { r0?: number; tangentialFraction?: number; rPeri?: number },
  ) => void;
  reset: () => void;
  readout: TestObjectReadout | null;

  // --- Draggable apsides (spec §6.3, milestone 9) ---
  /** The pair the handles currently describe, in M. */
  apsides: ApsisPair;
  /** Move a handle. Live during the drag; nothing is integrated yet. */
  setApsides: (pair: ApsisPair) => void;
  /**
   * The Rust solver's verdict on the current pair — bound orbit or capture,
   * and where the separatrix is. Null until the first answer arrives; it lags
   * the drag by a worker round trip, which is milliseconds.
   */
  apsidesSolution: ApsidesSolution | null;
  /** True while a handle is held, which is what puts the preview on screen. */
  draggingApsis: "periapsis" | "apoapsis" | null;
  setDraggingApsis: (which: "periapsis" | "apoapsis" | null) => void;
  /**
   * Apsides the last integration actually reached, in M. Compared against the
   * request in the panel, because agreeing with the trajectory is the only
   * claim worth making.
   */
  measuredApsides: { min: number; max: number } | null;
}

export function useTestObject(
  mass: number,
  solarMasses: number,
  /**
   * Dimensionless spin. Not used by the playback maths — it is here so §6.3's
   * apsides classification is re-asked when the geometry changes. A separatrix
   * computed for a* = 0.9 and displayed next to a a* = 0.5 hole is exactly the
   * kind of quietly-wrong number this project keeps having to dig out.
   */
  spin: number,
): UseTestObject {
  const [worldline, setWorldline] = useState<Worldline | null>(null);
  const [status, setStatus] = useState<UseTestObject["status"]>("idle");
  const [error, setError] = useState<string | null>(null);
  const [farTime, setFarTime] = useState(0);
  const [properTime, setProperTime] = useState(0);
  const [paused, setPaused] = useState(false);
  const [view, setViewInternal] = useState<ViewMode>("third");
  const [look, setLook] = useState({ yaw: 0, pitch: 0 });

  // §1.9: default to the per-preset comfort speed, recomputed whenever the
  // mass preset changes — one ISCO orbit in ~30 s of wall clock, whatever the
  // hole. Explicitly set speeds survive a preset change only until the user
  // has not touched the slider.
  const [speed, setSpeed] = useState(() => comfortSpeed(solarMasses));
  const speedTouched = useRef(false);

  useEffect(() => {
    if (!speedTouched.current) setSpeed(comfortSpeed(solarMasses));
  }, [solarMasses]);

  const rafRef = useRef<number | null>(null);
  const lastRef = useRef<number>(0);

  // §6.3: the dragged pair. Kept here rather than in the panel so the overlay
  // (which draws the handles) and the panel (which reads them out) see one
  // source of truth, and so a drop can use them without prop-drilling.
  const [apsides, setApsidesInternal] = useState<ApsisPair>({
    periapsis: 10,
    apoapsis: 20,
  });
  const [apsidesSolution, setApsidesSolution] =
    useState<ApsidesSolution | null>(null);
  const [draggingApsis, setDraggingApsis] = useState<
    "periapsis" | "apoapsis" | null
  >(null);

  const setApsides = useCallback((pair: ApsisPair) => {
    setApsidesInternal(orderApsides(pair.periapsis, pair.apoapsis));
  }, []);

  // Ask Rust what the current pair is. Latest-wins rather than debounced: the
  // solve is microseconds and the round trip is the only cost, so dropping
  // stale answers is simpler than throttling and never leaves the panel
  // showing a verdict for a pair the user has already moved past.
  const apsidesRequest = useRef(0);
  useEffect(() => {
    const token = ++apsidesRequest.current;
    let cancelled = false;
    physicsBridge
      .solveApsides(apsides.periapsis, apsides.apoapsis)
      .then((solution) => {
        if (cancelled || token !== apsidesRequest.current) return;
        setApsidesSolution(solution);
      })
      .catch(() => {
        // The engine may not be up yet on the first render; the next drag
        // asks again. A failed classification must not block the drag.
      });
    return () => {
      cancelled = true;
    };
    // mass and spin are dependencies even though they are not arguments: the
    // solver reads the engine's current metric, so the answer changes when
    // they do. `usePhysicsState` pushes them to the engine from a child
    // component, whose effects React runs before this parent one, so by the
    // time this fires the engine already has the new geometry.
  }, [apsides.periapsis, apsides.apoapsis, mass, spin]);

  const drop = useCallback(
    (
      preset: DropPresetName,
      options?: { r0?: number; tangentialFraction?: number; rPeri?: number },
    ) => {
      setStatus("integrating");
      setError(null);
      setFarTime(0);
      setProperTime(0);
      setLook({ yaw: 0, pitch: 0 });

      const request = buildDropRequest(preset, options);
      physicsBridge
        .dropTestObject(request)
        .then(({ samples, audit }) => {
          const line = new Worldline(samples, audit);
          setWorldline(line);
          setStatus("ready");

          // Spec §1.5: conservation is monitored, and a breach is reported
          // rather than silently rendered.
          if (!line.conserved) {
            // eslint-disable-next-line no-console
            console.warn(
              `Worldline conservation drift exceeded 1e-6: dE = ${audit.energyDrift.toExponential(3)}, ` +
                `dL = ${audit.angularMomentumDrift.toExponential(3)}`,
            );
          }
        })
        .catch((err: unknown) => {
          setStatus("error");
          setError(err instanceof Error ? err.message : String(err));
        });
    },
    [],
  );

  const reset = useCallback(() => {
    setWorldline(null);
    setStatus("idle");
    setError(null);
    setFarTime(0);
    setProperTime(0);
    setLook({ yaw: 0, pitch: 0 });
    // Riding an object that no longer exists is not a state the UI should be
    // able to reach.
    setViewInternal("third");
  }, []);

  const addLook = useCallback((dYaw: number, dPitch: number) => {
    setLook((prev) => ({
      yaw: prev.yaw + dYaw,
      // Clamp pitch just shy of the poles so the view cannot flip over.
      pitch: Math.max(
        -Math.PI / 2 + 0.01,
        Math.min(Math.PI / 2 - 0.01, prev.pitch + dPitch),
      ),
    }));
  }, []);

  // Playback clock. Advances the DISTANT OBSERVER's time, which is what the
  // 3rd-person view is parameterised by (§1.6).
  useEffect(() => {
    if (!worldline || paused) return undefined;

    lastRef.current = performance.now();
    const tick = () => {
      const now = performance.now();
      const dt = (now - lastRef.current) / 1000;
      lastRef.current = now;

      // §1.9: the multiplier scales the simulation clock against wall clock
      // and never touches the physics. The worldline was integrated once at
      // drop time; this only changes which sample gets looked up, so the same
      // drop replayed at any speed traces an identical trajectory.
      const rate = geometricRatePerSecond(speed, timeUnitSeconds(solarMasses));

      // Both clocks advance from the same wall-clock tick, but they index the
      // one stored worldline by different parameters (§1.6). Advancing both
      // keeps a view switch continuous rather than jumping.
      setFarTime((prev) => prev + dt * rate * OBSERVER_CLOCK_RATIO);
      setProperTime((prev) => prev + dt * rate);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);

    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [worldline, paused, speed, solarMasses]);

  // §1.9: Space toggles pause. Ignored while typing so it cannot hijack a
  // form field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "Space") return;
      const el = document.activeElement;
      const tag = el?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      e.preventDefault();
      setPaused((p) => !p);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const canRideAlong = !!worldline && worldline.count > 0;
  const setView = useCallback(
    (v: ViewMode) => {
      if (v === "first" && !canRideAlong) return;
      setViewInternal(v);
    },
    [canRideAlong],
  );

  // The 1st-person view rides the object, so it samples by proper time; the
  // 3rd-person view watches from far away and samples by the distant
  // observer's clock. Same buffer, two parameters.
  const ridePoint =
    worldline && worldline.count > 0
      ? worldline.sampleByProperTime(properTime)
      : null;

  // "Ran out of worldline" is not the same as "reached the singularity". A
  // stable circular orbit exhausts its step budget with the object still
  // happily orbiting; announcing an arrival there would be a lie. Require the
  // integration to have actually terminated at the inner radius
  // (endReason 0 = ReachedInnerRadius) and the object to be inside the
  // horizon.
  const reachedSingularity =
    !!ridePoint &&
    !!worldline &&
    properTime >= worldline.totalProperTime &&
    worldline.audit.endReason === 0 &&
    ridePoint.r < 2 * mass;

  let firstPersonFrame: FirstPersonFrame | null = null;
  if (view === "first" && ridePoint && worldline) {
    const cart = tetradToCartesian(
      ridePoint.tetrad,
      ridePoint.r,
      ridePoint.theta,
      ridePoint.phi,
    );
    // Free-look rotates the spatial legs of the frame, i.e. it is applied
    // INSIDE the frame before the boost is combined in. Rotating the finished
    // world-space ray instead would carry the aberration pattern around with
    // the view (spec §5).
    const q = quaternionFromYawPitch(look.yaw, look.pitch);
    const rot = (
      leg: CartesianLeg,
      sign: number,
    ): [number, number, number, number] => {
      const s = rotateByQuaternion(
        [leg.spatial[0] * sign, leg.spatial[1] * sign, leg.spatial[2] * sign],
        q,
      );
      return [s[0], s[1], s[2], leg.time * sign];
    };

    // The camera's right/up/forward are identified by what the legs physically
    // are, not by the order Gram-Schmidt produced them in. Forward is inward
    // radial so the hole is in shot when the ride starts.
    const axes = orientFrame(ridePoint.tetrad);
    const legs: CartesianLeg[] = [cart.e0, cart.e1, cart.e2, cart.e3];

    const pos = worldline.toCartesian(ridePoint);
    firstPersonFrame = {
      pos,
      // e0 is the observer's own 4-velocity: it must NOT be rotated by
      // free-look, or looking around would change where you are going.
      e0: [cart.e0.spatial[0], cart.e0.spatial[1], cart.e0.spatial[2], cart.e0.time],
      e1: rot(legs[axes.right.index]!, axes.right.sign),
      e2: rot(legs[axes.up.index]!, axes.up.sign),
      e3: rot(legs[axes.forward.index]!, axes.forward.sign),
    };
  }

  let readout: TestObjectReadout | null = null;
  if (worldline && worldline.count > 0) {
    const p =
      view === "first"
        ? worldline.sampleByProperTime(properTime)
        : worldline.sampleByFarTime(farTime);
    const rs = 2 * mass;
    const lapse = Math.max(1e-9, 1 - rs / p.r);
    const e = worldline.audit.energy;
    // gamma_local = E / sqrt(1 - r_s/r)  =>  v = sqrt(1 - 1/gamma^2)
    const gamma = e / Math.sqrt(lapse);
    const localVelocity = gamma > 1 ? Math.sqrt(1 - 1 / (gamma * gamma)) : 0;

    readout = {
      rOverRs: p.r / rs,
      tau: p.tau,
      tFar: p.tFar,
      t: p.t,
      localVelocity,
      tidal: (2 * mass) / (p.r * p.r * p.r),
      redshift: worldline.redshiftFactor(p.r, rs),
      rKm: radiusToKm(p.r, solarMasses),
      tauSeconds: durationToSeconds(p.tau, solarMasses),
      tFarSeconds: Number.isFinite(p.tFar)
        ? durationToSeconds(p.tFar, solarMasses)
        : Infinity,
      tidalG: tidalAccelerationG(p.r, solarMasses, 1),
    };
  }

  return {
    worldline,
    status,
    error,
    farTime,
    properTime,
    paused,
    setPaused,
    speed,
    setSpeed: (s: number) => {
      speedTouched.current = true;
      setSpeed(s);
    },
    comfort: comfortSpeed(solarMasses),
    view,
    setView,
    canRideAlong,
    look,
    addLook,
    firstPersonFrame,
    reachedSingularity,
    drop,
    reset,
    readout,
    apsides,
    setApsides,
    apsidesSolution,
    draggingApsis,
    setDraggingApsis,
    measuredApsides: worldline ? worldline.radialExtent() : null,
  };
}

/**
 * Yaw about the frame's up axis, then pitch about its right axis.
 *
 * Composed in that order so pitch stays relative to the horizon the observer
 * sees rather than accumulating roll — the same convention as an ordinary
 * free-look camera.
 */
function quaternionFromYawPitch(
  yaw: number,
  pitch: number,
): [number, number, number, number] {
  const cy = Math.cos(yaw / 2);
  const sy = Math.sin(yaw / 2);
  const cp = Math.cos(pitch / 2);
  const sp = Math.sin(pitch / 2);
  // q = qYaw (about y) * qPitch (about x)
  return [cy * sp, sy * cp, -sy * sp, cy * cp];
}
