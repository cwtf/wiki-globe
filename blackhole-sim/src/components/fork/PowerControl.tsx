"use client";

import type { SimulationParams } from "@/types/simulation";
import type { RayTracingQuality } from "@/types/features";
import { DEFAULT_FEATURES } from "@/types/features";

/**
 * Power / quality control (spec §6.1).
 *
 * Honest about the trade, because §6 requires it: each level says what it
 * stops computing. Nothing here changes the *physics* — the metric, the
 * geodesics and the shift factors are identical at every level. What changes
 * is how many pixels are traced and how many integration steps each one gets.
 *
 * Resolution leads because that is what measurement showed actually matters:
 * cost is quadratic in render scale, while raising the ray-march budget 8x
 * (32 → 256 steps) cost only ~30% more frame time. Reaching for step count
 * first is the intuitive move and the wrong one.
 */

interface Level {
  id: string;
  label: string;
  renderScale: number;
  quality: RayTracingQuality;
  /** What this level gives up, in plain terms. */
  cost: string;
}

const LEVELS: Level[] = [
  {
    id: "power-saver",
    label: "Power saver",
    renderScale: 0.5,
    quality: "medium",
    cost: "Quarter the pixels; softer edges and a coarser photon ring",
  },
  {
    id: "balanced",
    label: "Balanced",
    renderScale: 0.75,
    quality: "high",
    cost: "Half the pixels; slightly softer lensing detail",
  },
  {
    id: "quality",
    label: "Quality",
    renderScale: 1,
    quality: "ultra",
    cost: "Full resolution and the deepest ray budget",
  },
];

function matchLevel(params: SimulationParams): string {
  const scale = params.renderScale ?? 1;
  const q = params.features?.rayTracingQuality;
  return (
    LEVELS.find((l) => l.renderScale === scale && l.quality === q)?.id ??
    "custom"
  );
}

export function PowerControl({
  params,
  onChange,
}: {
  params: SimulationParams;
  onChange: (patch: Partial<SimulationParams>) => void;
}) {
  const current = matchLevel(params);
  const level = LEVELS.find((l) => l.id === current);

  return (
    <div className="mt-3 border-t border-white/10 pt-3">
      <h3 className="mb-2 font-mono text-[9px] uppercase tracking-[0.25em] text-white/70">
        Performance
      </h3>
      <div className="flex gap-1">
        {LEVELS.map((l) => (
          <button
            key={l.id}
            type="button"
            onClick={() =>
              onChange({
                renderScale: l.renderScale,
                features: {
                  ...(params.features ?? DEFAULT_FEATURES),
                  rayTracingQuality: l.quality,
                },
              })
            }
            className={`flex-1 rounded-sm border px-1 py-1 font-mono text-[7px] uppercase tracking-[0.1em] transition-colors ${
              current === l.id
                ? "border-cyan-300/60 bg-cyan-300/10 text-cyan-100"
                : "border-white/10 text-white/50 hover:border-white/30 hover:text-white/90"
            }`}
          >
            {l.label}
          </button>
        ))}
      </div>
      <p className="mt-1 font-mono text-[7px] leading-relaxed text-white/30">
        {level ? level.cost : "Custom settings"} — the physics is identical at
        every level.
      </p>
    </div>
  );
}
