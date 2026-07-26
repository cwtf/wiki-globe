"use client";

import type { UseTestObject } from "@/hooks/useTestObject";
import {
  formatSpeed,
  detents,
  sliderToSpeed,
  snapToDetent,
  speedToSlider,
} from "@/physics/playback";

/**
 * Playback speed and pause (spec §1.9).
 *
 * Log-scaled across ten decades because "comfortable" is not a constant: it is
 * ~1.5e-4x for a stellar-mass hole (real time is an invisible blur) and ~1e5x
 * for M87* (real time is geological). Both labelled detents — 1x real time and
 * the per-preset comfort speed — are reachable by clicking, since hitting an
 * exact value by dragging a ten-decade slider is hopeless.
 *
 * Pause freezes the simulation clock only. Rendering and both cameras stay
 * live, so the user can stop mid-plunge and look around a single frozen
 * moment. That falls out of this component doing nothing but stop advancing a
 * number — the render loop is entirely separate.
 */
export function SpeedControl({ object }: { object: UseTestObject }) {
  const { speed, setSpeed, comfort, paused, setPaused } = object;

  return (
    <div className="mt-3 border-t border-white/10 pt-3">
      <div className="mb-1 flex items-baseline justify-between">
        <h3 className="font-mono text-[9px] uppercase tracking-[0.25em] text-white/70">
          Speed
        </h3>
        <span
          className={`font-mono text-[10px] ${paused ? "text-amber-300/90" : "text-white/85"}`}
        >
          {formatSpeed(speed, paused)}
        </span>
      </div>

      <input
        type="range"
        min={0}
        max={1}
        step={0.001}
        value={speedToSlider(speed)}
        onChange={(e) =>
          setSpeed(snapToDetent(sliderToSpeed(Number(e.target.value)), comfort))
        }
        className="w-full accent-cyan-300"
        aria-label="Playback speed multiplier"
      />

      <div className="mt-1 flex gap-2">
        {detents(comfort).map((d) => (
          <button
            key={d.label}
            type="button"
            onClick={() => setSpeed(d.speed)}
            className="flex-1 rounded-sm border border-white/10 px-1.5 py-1 font-mono text-[7px] uppercase tracking-[0.12em] text-white/50 transition-colors hover:border-white/30 hover:text-white/90"
          >
            {d.label}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setPaused(!paused)}
          className={`flex-1 rounded-sm border px-1.5 py-1 font-mono text-[7px] uppercase tracking-[0.12em] transition-colors ${
            paused
              ? "border-amber-300/50 bg-amber-300/10 text-amber-200"
              : "border-white/10 text-white/50 hover:border-white/30 hover:text-white/90"
          }`}
          title="Space"
        >
          {paused ? "resume" : "pause"}
        </button>
      </div>

      <p className="mt-1 font-mono text-[7px] leading-relaxed text-white/30">
        Playback only — the trajectory is integrated once and is identical at
        every speed. 1× is truthfully real time.
      </p>
    </div>
  );
}
