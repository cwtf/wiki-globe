import { SimulatorApp } from "@/components/fork/SimulatorApp";

/**
 * The simulator's own root, at `/blackhole/`.
 *
 * wiki-globe fork (spec §6.4). This used to be the whole 1000-line app; it was
 * moved to `components/fork/SimulatorApp.tsx` so that the per-object routes at
 * `/blackhole/{name}/` can render the same component with a real black hole
 * preselected. Nothing else changed in the move.
 *
 * No `initialObjectId` here on purpose: the bare route is the generic
 * simulator, which opens on the synthetic stellar-mass preset rather than
 * claiming to be any particular object.
 */
export default function Page() {
  return <SimulatorApp />;
}
