// Generate data/black-holes.json from the simulator fork's canonical file.
//
// Unlike the other update-*.mjs scripts this one fetches nothing: real black
// hole parameters are hand-curated from published papers (spec §6.4), the same
// way the mission-supplement files are. What it does instead is keep *one*
// copy authoritative.
//
// The canonical list lives inside the fork, at
// `blackhole-sim/src/data/real-black-holes.json`, because that is where it is
// consumed with a type and a test suite around it. The globe cannot import it
// from there — the globe is plain ES modules served statically, and the fork is
// a separate Next build with its own module resolution — so this script copies
// it out to `data/`, and `validate-black-holes.mjs` fails the build if the two
// ever drift apart. Edit the fork's copy; never edit `data/black-holes.json`.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SOURCE = path.join(ROOT, "blackhole-sim/src/data/real-black-holes.json");
const OUT = path.join(ROOT, "data/black-holes.json");

async function main() {
  const src = JSON.parse(await readFile(SOURCE, "utf8"));

  if (!Array.isArray(src.objects) || src.objects.length === 0) {
    throw new Error("canonical file has no objects");
  }

  const out = {
    schemaVersion: src.schemaVersion,
    meta: {
      ...src.meta,
      generatedAt: new Date().toISOString(),
      generatedFrom: "blackhole-sim/src/data/real-black-holes.json",
      generatedBy: "scripts/data/generate-black-holes.mjs",
    },
    objects: src.objects,
  };

  await writeFile(OUT, `${JSON.stringify(out, null, 2)}\n`, "utf8");
  console.log(
    `OK: wrote ${out.objects.length} black holes to data/black-holes.json`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
