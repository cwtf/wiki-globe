"use client";

import { useEffect, useState } from "react";

import type { UseTestObject } from "@/hooks/useTestObject";
import { horizonRadius } from "@/hooks/useCamera";

/**
 * End of the 1st-person ride (spec §1.6).
 *
 * "End the run at r ≈ 0.02 r_s with a fade + 'reached the singularity' card
 * and the final τ (Schwarzschild interior gives finite remaining proper time
 * ≤ πGM/c³ from horizon crossing — display it)."
 *
 * Only shown in 1st person: from far away the object is never seen to arrive
 * at all, so announcing its arrival there would contradict the physics the
 * 3rd-person view exists to show.
 *
 * Two things this used to get wrong.
 *
 * **The wrong τ.** It printed `totalProperTime` — measured from release —
 * directly above "Interior bound πM". A drop from r = 20 M therefore read
 * "98.020" against "3.142", which looks like a thirty-fold violation of a
 * bound the card states in the next line. The bound applies to the stretch
 * *from horizon crossing*, which for that drop is 1.372. Both numbers are now
 * shown, labelled, and only the interior one is compared.
 *
 * **It was a dead end.** A full-screen dim with no way out is a wall: you
 * could not look at where you had arrived, could not get back to the outside
 * view, could not do anything but reload. It dismisses now, and says what the
 * remaining options are — including the honest fact that there is no "further
 * in" to offer, because the worldline ends here.
 */
export function SingularityCard({
  object,
  mass,
  spin,
}: {
  object: UseTestObject;
  mass: number;
  spin: number;
}) {
  const [dismissed, setDismissed] = useState(false);
  const arrived = object.view === "first" && object.reachedSingularity;

  // A fresh drop is a fresh arrival; the card has to come back for it.
  useEffect(() => {
    if (!arrived) setDismissed(false);
  }, [arrived]);

  if (!arrived || dismissed) return null;

  const totalTau = object.worldline?.totalProperTime ?? 0;
  const rHorizon = horizonRadius(mass, spin);
  const interiorTau =
    object.worldline?.properTimeInsideHorizon(rHorizon) ?? null;

  // πM is the Schwarzschild maximum, attained by release from rest at the
  // horizon itself. A spinning hole has an inner (Cauchy) horizon and a ring
  // singularity, so the same number is not the bound — say so instead of
  // quoting it as though it were.
  const schwarzschild = Math.abs(spin) < 1e-3;
  const interiorBound = Math.PI * mass;

  return (
    <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-[2px]" />
      <div className="pointer-events-auto relative max-w-md rounded-sm border border-white/15 bg-black/70 px-8 py-6 text-center">
        <h2 className="mb-3 font-mono text-[11px] uppercase tracking-[0.35em] text-white/90">
          Reached the singularity
        </h2>

        <dl className="space-y-1 font-mono text-[10px]">
          <div className="flex justify-between gap-6">
            <dt className="text-white/45">Proper time from release τ</dt>
            <dd className="text-white/90">{totalTau.toFixed(3)}</dd>
          </div>
          <div className="flex justify-between gap-6">
            <dt className="text-white/45">…of which inside the horizon</dt>
            <dd className="text-white/90">
              {interiorTau === null ? "—" : interiorTau.toFixed(3)}
            </dd>
          </div>
          <div className="flex justify-between gap-6">
            <dt className="text-white/45">
              {schwarzschild ? "Interior bound πM" : "πM (Schwarzschild only)"}
            </dt>
            <dd
              className={
                schwarzschild &&
                interiorTau !== null &&
                interiorTau <= interiorBound
                  ? "text-emerald-300/80"
                  : "text-white/90"
              }
            >
              {interiorBound.toFixed(3)}
            </dd>
          </div>
        </dl>

        {!schwarzschild && (
          <p className="mt-3 font-mono text-[7px] leading-relaxed text-amber-300/60">
            This hole is spinning (a* = {spin.toFixed(3)}), so πM is not its
            bound — a Kerr interior has an inner horizon and a ring
            singularity. The figure is shown for reference only.
          </p>
        )}

        <p className="mt-4 font-mono text-[8px] leading-relaxed text-white/40">
          Nothing locally unusual happened at the horizon; it was crossed in
          finite proper time. No distant observer ever saw the crossing —
          switch to 3rd person and the object is still frozen there, reddening.
        </p>

        <p className="mt-3 font-mono text-[8px] leading-relaxed text-white/35">
          There is no further in. The worldline does not stop because the
          simulation gave up — it ends because the geodesic is incomplete, and
          general relativity has nothing to say past this point.
        </p>

        <div className="mt-5 flex gap-2">
          <button
            type="button"
            onClick={() => setDismissed(true)}
            className="flex-1 rounded-sm border border-white/15 px-2 py-1.5 font-mono text-[9px] uppercase tracking-[0.15em] text-white/70 transition-colors hover:border-white/35 hover:text-white/90"
          >
            Stay here
          </button>
          <button
            type="button"
            onClick={() => {
              setDismissed(true);
              object.setView("third");
            }}
            className="flex-1 rounded-sm border border-white/15 px-2 py-1.5 font-mono text-[9px] uppercase tracking-[0.15em] text-white/70 transition-colors hover:border-white/35 hover:text-white/90"
          >
            Watch from outside
          </button>
        </div>

        <p className="mt-3 font-mono text-[7px] text-white/30">
          Geometric units (G = c = M = 1). Integration ends at r = 0.02 r_s,
          not at r = 0 — the last two percent is unrenderable, not skipped.
        </p>
      </div>
    </div>
  );
}
