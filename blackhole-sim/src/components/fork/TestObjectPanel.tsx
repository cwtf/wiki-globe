"use client";

import { useState } from "react";

import type { DropPresetName } from "@/physics/worldline";
import type { UseTestObject } from "@/hooks/useTestObject";

/**
 * Drop panel + test-object HUD (spec §1.5, §2.4).
 *
 * wiki-globe fork. Styled in the base's control-panel idiom (liquid glass,
 * mono micro-type) rather than as a wiki-globe sidebar row, since the two apps
 * never share a page.
 */

const PRESETS: { key: DropPresetName; label: string; hint: string }[] = [
  { key: "circular", label: "Circular orbit", hint: "stable, outside the ISCO" },
  { key: "isco", label: "ISCO knife-edge", hint: "marginally stable; plunges" },
  { key: "eccentric", label: "Eccentric", hint: "periapsis precesses" },
  { key: "radialFall", label: "Radial free fall", hint: "dropped from rest" },
];

export function TestObjectPanel({
  object,
  isVisible,
}: {
  object: UseTestObject;
  isVisible: boolean;
}) {
  const [preset, setPreset] = useState<DropPresetName>("circular");
  const [r0, setR0] = useState(20);

  if (!isVisible) return null;

  const { readout, status, error, worldline } = object;

  return (
    // top-48 clears the identity HUD stack above it: back pill, logo, title,
    // and the "SIMULATION KERNEL / METRIC" status lines. At top-28 this panel
    // overprinted them — caught by the first golden capture, not by any test.
    <div className="pointer-events-auto absolute left-4 top-48 z-40 w-64 rounded-sm border border-white/10 bg-black/40 p-3 backdrop-blur-md">
      <h3 className="mb-2 font-mono text-[9px] uppercase tracking-[0.25em] text-white/70">
        Test object
      </h3>

      <label className="mb-1 block font-mono text-[8px] uppercase tracking-[0.15em] text-white/40">
        Trajectory
      </label>
      <select
        value={preset}
        onChange={(e) => setPreset(e.target.value as DropPresetName)}
        className="mb-1 w-full rounded-sm border border-white/10 bg-black/60 px-2 py-1 font-mono text-[10px] text-white/80"
        aria-label="Drop trajectory preset"
      >
        {PRESETS.map((p) => (
          <option key={p.key} value={p.key}>
            {p.label}
          </option>
        ))}
      </select>
      <p className="mb-3 font-mono text-[8px] text-white/35">
        {PRESETS.find((p) => p.key === preset)?.hint}
      </p>

      {preset !== "isco" && (
        <>
          <label className="mb-1 flex justify-between font-mono text-[8px] uppercase tracking-[0.15em] text-white/40">
            <span>Start radius</span>
            <span className="text-white/70">{r0.toFixed(1)} M</span>
          </label>
          <input
            type="range"
            min={7}
            max={300}
            step={0.5}
            value={r0}
            onChange={(e) => setR0(Number(e.target.value))}
            className="mb-3 w-full accent-cyan-300"
            aria-label="Start radius in units of M"
          />
        </>
      )}

      <div className="mb-3 flex gap-2">
        <button
          type="button"
          onClick={() => object.drop(preset, { r0, tangentialFraction: preset === "eccentric" ? 0.9 : 1 })}
          disabled={status === "integrating"}
          className="flex-1 rounded-sm border border-white/15 bg-white/5 px-2 py-1.5 font-mono text-[9px] uppercase tracking-[0.2em] text-white/80 transition-colors hover:border-white/40 hover:text-white disabled:opacity-40"
        >
          {status === "integrating" ? "…" : "Drop"}
        </button>
        <button
          type="button"
          onClick={object.reset}
          disabled={!worldline}
          className="rounded-sm border border-white/10 px-2 py-1.5 font-mono text-[9px] uppercase tracking-[0.2em] text-white/50 transition-colors hover:text-white/90 disabled:opacity-30"
        >
          Reset
        </button>
      </div>

      {error && (
        <p className="mb-2 font-mono text-[8px] text-red-400/80">{error}</p>
      )}

      {readout && (
        <dl className="space-y-1 border-t border-white/10 pt-2 font-mono text-[9px]">
          <Row label="r" value={`${readout.rOverRs.toFixed(3)} r_s`} />
          {/* Two clocks, always both: their disagreement is the physics (§1.6). */}
          <Row label="τ object" value={readout.tau.toFixed(2)} />
          <Row
            label="t observer"
            value={
              Number.isFinite(readout.tFar) ? readout.tFar.toFixed(2) : "∞"
            }
          />
          <Row label="v local" value={`${(readout.localVelocity * 100).toFixed(2)}% c`} />
          <Row label="tidal" value={readout.tidal.toExponential(2)} />
          <Row label="redshift" value={readout.redshift.toFixed(4)} />
          {worldline && (
            <Row
              label="E/L drift"
              value={`${worldline.audit.energyDrift.toExponential(1)} / ${worldline.audit.angularMomentumDrift.toExponential(1)}`}
            />
          )}
        </dl>
      )}

      <p className="mt-2 font-mono text-[7px] leading-relaxed text-white/30">
        Geometric units (G = c = M = 1). Physical scales — km, seconds, kelvin —
        arrive with the mass presets.
      </p>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-2">
      <dt className="text-white/40">{label}</dt>
      <dd className="text-white/85">{value}</dd>
    </div>
  );
}
