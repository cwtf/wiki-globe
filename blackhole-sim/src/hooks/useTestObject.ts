"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { physicsBridge } from "@/engine/physics-bridge";
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
 * Distant-observer seconds per wall-clock second.
 *
 * A placeholder until §1.8's mass presets exist, since "comfort speed" is
 * defined per preset (§1.9). Deliberately a single named constant so the
 * speed slider replaces exactly this.
 */
const PLAYBACK_RATE = 4.0;

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
}

export interface UseTestObject {
  worldline: Worldline | null;
  status: "idle" | "integrating" | "ready" | "error";
  error: string | null;
  /** Current distant-observer time being displayed. */
  farTime: number;
  paused: boolean;
  setPaused: (p: boolean) => void;
  drop: (preset: DropPresetName, options?: { r0?: number; tangentialFraction?: number }) => void;
  reset: () => void;
  readout: TestObjectReadout | null;
}

export function useTestObject(mass: number): UseTestObject {
  const [worldline, setWorldline] = useState<Worldline | null>(null);
  const [status, setStatus] = useState<UseTestObject["status"]>("idle");
  const [error, setError] = useState<string | null>(null);
  const [farTime, setFarTime] = useState(0);
  const [paused, setPaused] = useState(false);

  const rafRef = useRef<number | null>(null);
  const lastRef = useRef<number>(0);

  const drop = useCallback(
    (preset: DropPresetName, options?: { r0?: number; tangentialFraction?: number }) => {
      setStatus("integrating");
      setError(null);
      setFarTime(0);

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
      setFarTime((prev) => prev + dt * PLAYBACK_RATE);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);

    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [worldline, paused]);

  let readout: TestObjectReadout | null = null;
  if (worldline && worldline.count > 0) {
    const p = worldline.sampleByFarTime(farTime);
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
    };
  }

  return {
    worldline,
    status,
    error,
    farTime,
    paused,
    setPaused,
    drop,
    reset,
    readout,
  };
}
