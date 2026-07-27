"use client";

import {
  GALACTIC_ORIENTATION,
  SKYBOX_ATTRIBUTION,
} from "@/configs/skybox.config";

/**
 * wiki-globe fork only (spec §6.2). Credit line for the Milky Way panorama,
 * plus the one sentence of honesty the orientation needs.
 *
 * Two project rules meet here. Licensing rule #4 says a new texture gets an
 * attribution line in the app's own UI, not only in the README. And §6.2 asks
 * for the galaxy/disk alignment question to be *decided and stated* rather than
 * quietly assumed — the two planes are physically unrelated, so the tilt is a
 * choice, and a simulator that claims scientific accuracy should say which of
 * its geometry is measured and which is arranged.
 */
export function SkyCredit() {
  return (
    <p className="mt-3 text-[8px] leading-relaxed text-white/35 font-mono">
      Sky:{" "}
      <a
        href={SKYBOX_ATTRIBUTION.url}
        target="_blank"
        rel="noopener noreferrer"
        className="underline decoration-white/20 underline-offset-2 hover:text-white/70"
      >
        {SKYBOX_ATTRIBUTION.title}
      </a>{" "}
      — {SKYBOX_ATTRIBUTION.credit} ({SKYBOX_ATTRIBUTION.licence}), lensed per
      ray. Galactic plane is tilted {GALACTIC_ORIENTATION.tiltDeg}° from the
      disk: the two are physically unrelated, so the angle is chosen, not
      measured.
    </p>
  );
}
