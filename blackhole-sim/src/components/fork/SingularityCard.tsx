"use client";

import type { UseTestObject } from "@/hooks/useTestObject";

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
 */
export function SingularityCard({
  object,
  mass,
}: {
  object: UseTestObject;
  mass: number;
}) {
  if (object.view !== "first" || !object.reachedSingularity) return null;

  const tau = object.worldline?.totalProperTime ?? 0;
  // Schwarzschild bound on proper time from the horizon to the singularity.
  const interiorBound = Math.PI * mass;

  return (
    <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-[2px]" />
      <div className="relative max-w-md rounded-sm border border-white/15 bg-black/70 px-8 py-6 text-center">
        <h2 className="mb-3 font-mono text-[11px] uppercase tracking-[0.35em] text-white/90">
          Reached the singularity
        </h2>
        <dl className="space-y-1 font-mono text-[10px]">
          <div className="flex justify-between gap-6">
            <dt className="text-white/45">Total proper time τ</dt>
            <dd className="text-white/90">{tau.toFixed(3)}</dd>
          </div>
          <div className="flex justify-between gap-6">
            <dt className="text-white/45">Interior bound πM</dt>
            <dd className="text-white/90">{interiorBound.toFixed(3)}</dd>
          </div>
        </dl>
        <p className="mt-4 font-mono text-[8px] leading-relaxed text-white/40">
          Nothing locally unusual happened at the horizon; it was crossed in
          finite proper time. No distant observer ever saw the crossing —
          switch to 3rd person and the object is still frozen there, reddening.
        </p>
        <p className="mt-3 font-mono text-[7px] text-white/30">
          Geometric units (G = c = M = 1).
        </p>
      </div>
    </div>
  );
}
