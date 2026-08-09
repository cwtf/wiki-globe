import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { SimulatorApp } from "@/components/fork/SimulatorApp";
import {
  REAL_BLACK_HOLES,
  findRealBlackHole,
  formatDistanceLightYears,
  formatSolarMasses,
} from "@/configs/real-black-holes";

/**
 * Per-object simulator routes (spec §6.4): `/blackhole/sgr-a-star/` and so on.
 *
 * wiki-globe fork. Under `output: "export"` this dynamic segment is not
 * dynamic at all — `generateStaticParams` enumerates the presets and Next
 * emits one directory of static HTML each, which is the only thing GitHub
 * Pages can serve. `dynamicParams = false` makes that explicit: a slug that
 * is not in the list is a 404 at build time rather than a route that silently
 * never gets generated.
 *
 * Verify additions against `bun run build` output (`out/<slug>/index.html`),
 * not against `bun run dev` — §2.1's warning about export-only behaviour.
 * Adding an object here also means adding its URL to the repo-root
 * `sitemap.xml`.
 */

export const dynamicParams = false;

export function generateStaticParams(): { object: string }[] {
  return REAL_BLACK_HOLES.map((o) => ({ object: o.id }));
}

export function generateMetadata({
  params,
}: {
  params: { object: string };
}): Metadata {
  const o = findRealBlackHole(params.object);
  if (!o) return {};

  const title = `${o.name} — interactive black hole simulation`;
  const description = `A general-relativistic simulation of ${o.name}, locked to its measured parameters: ${formatSolarMasses(
    o.solarMasses.value,
  )}, spin a* ${o.spin.value.toFixed(2)}, viewed at ${
    o.inclinationDeg.value
  }° inclination from ${formatDistanceLightYears(o)} away. Every parameter is cited in the panel.`;

  return {
    title,
    description,
    alternates: { canonical: `https://wikiglo.be/blackhole/${o.id}/` },
    openGraph: { title, description, type: "website" },
  };
}

export default function ObjectPage({ params }: { params: { object: string } }) {
  if (!findRealBlackHole(params.object)) notFound();
  return <SimulatorApp initialObjectId={params.object} />;
}
