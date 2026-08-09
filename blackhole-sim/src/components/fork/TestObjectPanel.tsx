"use client";

import { useState } from "react";

import type { DropPresetName } from "@/physics/worldline";
import type { UseTestObject } from "@/hooks/useTestObject";
import { ViewToggle } from "./ViewToggle";
import { SpeedControl } from "./SpeedControl";
import { PowerControl } from "./PowerControl";
import type { SimulationParams } from "@/types/simulation";
import {
  MASS_PRESETS,
  type MassPreset,
  formatDuration,
  formatLength,
  iscoPeriodSeconds,
  peakDiskTemperatureK,
  schwarzschildRadiusKm,
} from "@/configs/mass-presets";
import {
  REAL_BLACK_HOLES,
  type RealBlackHole,
} from "@/configs/real-black-holes";
import { RealObjectCard } from "./RealObjectCard";

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
  // §6.3: an addition, not a replacement — the presets stay.
  {
    key: "apsides",
    label: "Apsides (drag)",
    hint: "drag the two handles on the disk plane",
  },
];

export function TestObjectPanel({
  object,
  isVisible,
  massPresetId,
  massPreset,
  onMassPresetChange,
  realObject,
  realObjectLocked,
  onSelectRealObject,
  onRestoreRealObject,
  params,
  onParamsChange,
  preset,
  onPresetChange,
}: {
  object: UseTestObject;
  isVisible: boolean;
  massPresetId: string;
  /**
   * Resolved preset, which is *not* always `findPreset(massPresetId)`: with a
   * real object selected it is synthesized from that object's mass, so the
   * r_s / ISCO / temperature rows below describe M87* rather than falling back
   * to the stellar default.
   */
  massPreset: MassPreset;
  onMassPresetChange: (id: string) => void;
  /** §6.4: the real object this session is locked to, if any. */
  realObject: RealBlackHole | null;
  realObjectLocked: boolean;
  onSelectRealObject: (id: string) => void;
  onRestoreRealObject: () => void;
  params?: SimulationParams;
  onParamsChange?: (patch: Partial<SimulationParams>) => void;
  /** Lifted so the overlay knows whether to draw the drag handles (§6.3). */
  preset: DropPresetName;
  onPresetChange: (preset: DropPresetName) => void;
}) {
  const [r0, setR0] = useState(20);

  if (!isVisible) return null;

  const { readout, status, error, worldline } = object;

  // §6.4: one control, two kinds of entry. The synthetic presets are shapes of
  // black hole ("a stellar one"); the real objects are named things with
  // citations. Prefixing the option values keeps them from colliding — a
  // future preset called "sgra" would otherwise silently shadow Sgr A*.
  const selection = realObject
    ? `real:${realObject.id}`
    : `preset:${massPresetId}`;

  const handleSelection = (value: string) => {
    if (value.startsWith("real:")) onSelectRealObject(value.slice(5));
    else onMassPresetChange(value.slice(7));
  };

  // Within 1% of the physical peak counts as true colour; the slider's 1000 K
  // step cannot land exactly on 1.11e7.
  const physicalPeakK = peakDiskTemperatureK(massPreset.solarMasses);
  const trueColour =
    !!params && Math.abs(params.diskTemp - physicalPeakK) / physicalPeakK < 0.01;

  return (
    // top-48 clears the identity HUD stack above it: back pill, logo, title,
    // and the "SIMULATION KERNEL / METRIC" status lines. At top-28 this panel
    // overprinted them — caught by the first golden capture, not by any test.
    // The panel grew past the viewport once the mass-preset and speed
    // sections landed, colliding with the bottom bar. Cap it and let it
    // scroll rather than letting sections disappear — and cap against the
    // viewport so short screens and phones behave too (§6 mobile pass).
    <div className="pointer-events-auto absolute left-4 top-48 z-40 flex max-h-[calc(100vh-19rem)] w-64 max-w-[calc(100vw-2rem)] flex-col overflow-y-auto overscroll-contain rounded-sm border border-white/10 bg-black/40 p-3 backdrop-blur-md">
      <h3 className="mb-2 font-mono text-[9px] uppercase tracking-[0.25em] text-white/70">
        Black hole
      </h3>
      <select
        value={selection}
        onChange={(e) => handleSelection(e.target.value)}
        className="mb-1 w-full rounded-sm border border-white/10 bg-black/60 px-2 py-1 font-mono text-[10px] text-white/80"
        aria-label="Black hole"
      >
        <optgroup label="Generic">
          {MASS_PRESETS.map((p) => (
            <option key={p.id} value={`preset:${p.id}`}>
              {p.label}
            </option>
          ))}
        </optgroup>
        <optgroup label="Real objects">
          {REAL_BLACK_HOLES.map((o) => (
            <option key={o.id} value={`real:${o.id}`}>
              {o.name}
            </option>
          ))}
        </optgroup>
      </select>

      {realObject ? (
        <RealObjectCard
          object={realObject}
          locked={realObjectLocked}
          onRestore={onRestoreRealObject}
        />
      ) : (
        <p className="mb-1 font-mono text-[8px] text-white/35">
          {massPreset.hint}
        </p>
      )}

      <dl className="mb-3 space-y-0.5 font-mono text-[8px]">
        <Row
          label="r_s"
          value={formatLength(schwarzschildRadiusKm(massPreset.solarMasses))}
        />
        <Row
          label="ISCO period"
          value={formatDuration(iscoPeriodSeconds(massPreset.solarMasses))}
        />
        <Row
          label="disk peak T"
          value={`${peakDiskTemperatureK(massPreset.solarMasses).toExponential(1)} K`}
        />
      </dl>

      {/*
        Honesty rule (§6, "honesty over prettiness"). The row above states the
        physical peak temperature; the shader now renders that same number by
        default, so the colour on screen is the real visible-band colour of a
        disk that hot — which is a nearly flat pale blue, because everything
        above ~20,000 K sits in the same Rayleigh-Jeans tail. If the user drags
        the temperature away from the physical value to get the familiar
        orange gradient back, that is false colour and the UI has to say so
        rather than letting the readout above imply otherwise.
      */}
      {params && (
        <p
          className={`mb-3 font-mono text-[8px] leading-relaxed ${
            trueColour ? "text-white/35" : "text-amber-300/70"
          }`}
        >
          {trueColour
            ? "Physical colour: this is how a blackbody at the temperature above actually looks — almost featureless blue-white, with the visible structure coming from beaming rather than temperature."
            : `False colour: rendering at ${params.diskTemp.toExponential(1)} K, not the ${peakDiskTemperatureK(
                massPreset.solarMasses,
              ).toExponential(1)} K above. Hue is exaggerated to show the Doppler shift.`}
        </p>
      )}

      <h3 className="mb-2 font-mono text-[9px] uppercase tracking-[0.25em] text-white/70">
        Test object
      </h3>

      <label className="mb-1 block font-mono text-[8px] uppercase tracking-[0.15em] text-white/40">
        Trajectory
      </label>
      <select
        value={preset}
        onChange={(e) => onPresetChange(e.target.value as DropPresetName)}
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

      {preset !== "isco" && preset !== "apsides" && (
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

      {preset === "apsides" && <ApsidesSection object={object} />}

      <div className="mb-3 flex gap-2">
        <button
          type="button"
          onClick={() =>
            object.drop(
              preset,
              preset === "apsides"
                ? {
                    // §6.3: the outer handle is the launch radius and the
                    // inner one is the requested periapsis.
                    r0: object.apsides.apoapsis,
                    rPeri: object.apsides.periapsis,
                  }
                : { r0, tangentialFraction: preset === "eccentric" ? 0.9 : 1 },
            )
          }
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
          <Row
            label="r"
            value={`${readout.rOverRs.toFixed(3)} r_s · ${formatLength(readout.rKm)}`}
          />
          {/* Two clocks, always both: their disagreement is the physics (§1.6). */}
          <Row
            label="τ object"
            value={formatDuration(readout.tauSeconds)}
          />
          <Row
            label="t observer"
            value={
              Number.isFinite(readout.tFarSeconds)
                ? formatDuration(readout.tFarSeconds)
                : "∞ (never seen)"
            }
          />
          <Row label="v local" value={`${(readout.localVelocity * 100).toFixed(2)}% c`} />
          <Row
            label="tidal / m"
            value={`${readout.tidalG.toExponential(2)} g`}
          />
          <Row label="redshift" value={readout.redshift.toFixed(4)} />
          {worldline && (
            <Row
              label="E/L drift"
              value={`${worldline.audit.energyDrift.toExponential(1)} / ${worldline.audit.angularMomentumDrift.toExponential(1)}`}
            />
          )}
        </dl>
      )}

      <SpeedControl object={object} />

      <ViewToggle object={object} />
      {params && onParamsChange && (
        <PowerControl params={params} onChange={onParamsChange} />
      )}

      <p className="mt-2 font-mono text-[7px] leading-relaxed text-white/30">
        Geometric units (G = c = M = 1). Physical scales — km, seconds, kelvin —
        arrive with the mass presets.
      </p>
    </div>
  );
}

/**
 * The apsides controls (spec §6.3).
 *
 * Sliders as well as drag handles, for two reasons: a handle that is edge-on to
 * the camera cannot be grabbed at all, and a drag is not keyboard-reachable.
 * Both write the same state the overlay does.
 *
 * The verdict line is the honest part. It comes from the Rust solver rather
 * than from a rule of thumb, and it says *why* — a periapsis inside the
 * separatrix is a capture, and the separatrix is not the ISCO.
 */
function ApsidesSection({ object }: { object: UseTestObject }) {
  const { apsides, setApsides, apsidesSolution, measuredApsides } = object;
  const captures = apsidesSolution?.plunges ?? false;

  return (
    <>
      <label className="mb-1 flex justify-between font-mono text-[8px] uppercase tracking-[0.15em] text-white/40">
        <span>Periapsis</span>
        <span className="text-white/70">{apsides.periapsis.toFixed(1)} M</span>
      </label>
      <input
        type="range"
        min={0.2}
        max={400}
        step={0.1}
        value={apsides.periapsis}
        onChange={(e) =>
          setApsides({ ...apsides, periapsis: Number(e.target.value) })
        }
        className={`mb-2 w-full ${captures ? "accent-red-400" : "accent-cyan-300"}`}
        aria-label="Periapsis in units of M"
      />
      <label className="mb-1 flex justify-between font-mono text-[8px] uppercase tracking-[0.15em] text-white/40">
        <span>Apoapsis</span>
        <span className="text-white/70">{apsides.apoapsis.toFixed(1)} M</span>
      </label>
      <input
        type="range"
        min={0.2}
        max={400}
        step={0.1}
        value={apsides.apoapsis}
        onChange={(e) =>
          setApsides({ ...apsides, apoapsis: Number(e.target.value) })
        }
        className={`mb-2 w-full ${captures ? "accent-red-400" : "accent-cyan-300"}`}
        aria-label="Apoapsis in units of M"
      />

      <p
        className={`mb-3 font-mono text-[8px] leading-relaxed ${
          captures ? "text-red-300/80" : "text-white/35"
        }`}
      >
        {apsidesSolution === null ? (
          "…"
        ) : captures ? (
          <>
            Capture. No bound orbit reaches{" "}
            {apsides.periapsis.toFixed(1)} M from{" "}
            {apsides.apoapsis.toFixed(1)} M — the separatrix is at{" "}
            {apsidesSolution.separatrix.toFixed(2)} M. Dropping here plunges,
            which is the physics, not a limit of the control.
          </>
        ) : (
          <>
            Bound orbit. Separatrix for this apoapsis:{" "}
            {apsidesSolution.separatrix.toFixed(2)} M — a periapsis inside the
            ISCO can still be stable, so that is the real floor, not the ISCO.
          </>
        )}
      </p>

      {measuredApsides && (
        <dl className="mb-3 space-y-0.5 font-mono text-[8px]">
          {/* Measured, not requested: what the integration actually did. */}
          <Row
            label="reached"
            value={`${measuredApsides.min.toFixed(2)} – ${measuredApsides.max.toFixed(2)} M`}
          />
        </dl>
      )}
    </>
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
