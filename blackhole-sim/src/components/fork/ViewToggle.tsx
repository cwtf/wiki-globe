"use client";

import type { UseTestObject } from "@/hooks/useTestObject";

/**
 * 3rd person ⇄ 1st person switch (spec §1.6, §2.4).
 *
 * 1st person is disabled until something has been dropped, because the view is
 * defined as riding the object's worldline — there is nothing to ride
 * otherwise. 3rd person is available from load and needs no object.
 */
export function ViewToggle({ object }: { object: UseTestObject }) {
  const { view, setView, canRideAlong } = object;

  return (
    // Rendered inside the test-object panel rather than positioned absolutely.
    // Stacking two absolute panels by hand meant the readout list grew into
    // this one as soon as an object was dropped — which the first 1st-person
    // capture showed happening.
    <div className="mt-3 border-t border-white/10 pt-3">
      <h3 className="mb-2 font-mono text-[9px] uppercase tracking-[0.25em] text-white/70">
        View
      </h3>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => setView("third")}
          className={`flex-1 rounded-sm border px-2 py-1.5 font-mono text-[9px] uppercase tracking-[0.15em] transition-colors ${
            view === "third"
              ? "border-cyan-300/60 bg-cyan-300/10 text-cyan-100"
              : "border-white/10 text-white/60 hover:border-white/30 hover:text-white/90"
          }`}
        >
          3rd person
        </button>
        <button
          type="button"
          onClick={() => setView("first")}
          disabled={!canRideAlong}
          title={
            canRideAlong
              ? "Ride the dropped object"
              : "Drop an object first — this view rides its worldline"
          }
          className={`flex-1 rounded-sm border px-2 py-1.5 font-mono text-[9px] uppercase tracking-[0.15em] transition-colors disabled:cursor-not-allowed disabled:opacity-30 ${
            view === "first"
              ? "border-cyan-300/60 bg-cyan-300/10 text-cyan-100"
              : "border-white/10 text-white/60 hover:border-white/30 hover:text-white/90"
          }`}
        >
          1st person
        </button>
      </div>

      {view === "first" && (
        <p className="mt-2 font-mono text-[7px] leading-relaxed text-white/35">
          Drag to look around. Field of view is fixed: changing it would
          compress the sky and masquerade as aberration.
        </p>
      )}
    </div>
  );
}
