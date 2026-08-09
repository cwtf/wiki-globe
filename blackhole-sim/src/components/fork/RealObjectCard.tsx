"use client";

import { useState } from "react";

import {
  type Measured,
  type RealBlackHole,
  formatDistanceLightYears,
  formatSolarMasses,
  uncertaintyLabel,
} from "@/configs/real-black-holes";

/**
 * Parameter card for a selected real black hole (spec §6.4).
 *
 * wiki-globe fork. This is the honesty surface for milestone 10, and it is
 * deliberately louder than a normal readout:
 *
 * - The **badge** follows the globe's `LIVE`/`DATA` discipline (CLAUDE.md
 *   principle #2). `DATA` means every locked parameter still matches the
 *   published values. `CUSTOM` means the user has moved one, so the picture is
 *   no longer this object and the card says so instead of quietly keeping the
 *   name at the top.
 * - Every row carries its own uncertainty flag, because the flag varies field
 *   by field within one object. `not measured` values are struck through the
 *   normal styling and stated as placeholders — an unconstrained spin of 0.5
 *   is a rendering decision, not a fact about V404 Cygni.
 * - Citations are one click away rather than hidden behind a tooltip, since a
 *   claim you cannot check is not much better than no claim.
 */
export function RealObjectCard({
  object,
  locked,
  onRestore,
}: {
  object: RealBlackHole;
  /** Whether the live simulation still matches the published parameters. */
  locked: boolean;
  /** Put the locked parameters back after the user has drifted off them. */
  onRestore: () => void;
}) {
  const [showSources, setShowSources] = useState(false);

  return (
    <div className="mb-3 rounded-sm border border-white/10 bg-white/[0.03] p-2">
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <span className="font-mono text-[10px] text-white/85">
          {object.name}
        </span>
        <span
          className={`shrink-0 rounded-sm px-1 py-px font-mono text-[7px] uppercase tracking-[0.15em] ${
            locked
              ? "bg-emerald-400/15 text-emerald-300/80"
              : "bg-amber-400/15 text-amber-300/80"
          }`}
          title={
            locked
              ? "Every locked parameter matches the published values"
              : "A locked parameter has been changed — this is no longer that object"
          }
        >
          {locked ? "Data" : "Custom"}
        </span>
      </div>

      {!locked && (
        <p className="mb-1.5 font-mono text-[8px] leading-relaxed text-amber-300/70">
          Modified — no longer {object.shortName}.{" "}
          <button
            type="button"
            onClick={onRestore}
            className="underline underline-offset-2 hover:text-amber-200"
          >
            Restore
          </button>
        </p>
      )}

      <p className="mb-2 font-mono text-[8px] leading-relaxed text-white/40">
        {object.blurb}
      </p>

      <dl className="space-y-0.5 font-mono text-[8px]">
        <ParamRow
          label="mass"
          field={object.solarMasses}
          render={(v) => formatSolarMasses(v)}
        />
        <ParamRow
          label="spin a*"
          field={object.spin}
          render={(v) => v.toFixed(3)}
        />
        <ParamRow
          label="inclination"
          field={object.inclinationDeg}
          render={(v) => `${v}°`}
        />
        <ParamRow
          label="distance"
          field={object.distanceKpc}
          render={() => formatDistanceLightYears(object)}
        />
        <ParamRow
          label="jets"
          field={object.jets}
          render={(v) => (v ? "yes" : "none prominent")}
        />
      </dl>

      <button
        type="button"
        onClick={() => setShowSources((s) => !s)}
        className="mt-2 font-mono text-[8px] uppercase tracking-[0.15em] text-white/35 underline underline-offset-2 hover:text-white/60"
        aria-expanded={showSources}
      >
        {showSources ? "Hide sources" : "Sources"}
      </button>

      {showSources && (
        <div className="mt-1.5 space-y-1.5 border-t border-white/10 pt-1.5">
          <Source label="mass" field={object.solarMasses} />
          <Source label="spin" field={object.spin} />
          <Source label="inclination" field={object.inclinationDeg} />
          <Source label="distance" field={object.distanceKpc} />
          <Source label="jets" field={object.jets} />
          <p className="font-mono text-[7px] leading-relaxed text-white/30">
            <span className="text-white/45">position</span>{" "}
            {object.positionSource}
          </p>
          <a
            href={object.wikipedia}
            target="_blank"
            rel="noopener noreferrer"
            className="block font-mono text-[8px] text-white/45 underline underline-offset-2 hover:text-white/70"
          >
            Wikipedia →
          </a>
        </div>
      )}
    </div>
  );
}

function ParamRow<T>({
  label,
  field,
  render,
}: {
  label: string;
  field: Measured<T>;
  render: (value: T) => string;
}) {
  const flag = uncertaintyLabel(field.uncertainty);
  const unconstrained = field.uncertainty === "unconstrained";

  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="text-white/40">{label}</dt>
      <dd className="text-right">
        <span className={unconstrained ? "text-white/35" : "text-white/75"}>
          {render(field.value)}
        </span>
        {flag && (
          <span
            className={`ml-1 text-[7px] uppercase tracking-[0.1em] ${
              unconstrained ? "text-rose-300/60" : "text-amber-300/60"
            }`}
          >
            {flag}
          </span>
        )}
      </dd>
    </div>
  );
}

function Source<T>({ label, field }: { label: string; field: Measured<T> }) {
  return (
    <p className="font-mono text-[7px] leading-relaxed text-white/30">
      <span className="text-white/45">{label}</span> {field.source}
    </p>
  );
}
