// Validate data/black-holes.json
//
// Two jobs. The ordinary one is shape and range checking, like every other
// validator here. The important one is **drift detection**: this file is a
// generated copy of `blackhole-sim/src/data/real-black-holes.json`, and a copy
// that silently disagrees with its source is worse than no copy, because the
// globe would label a sky dot with one set of numbers while the simulator it
// links to shows another.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const FILE = path.join(ROOT, "data/black-holes.json");
const SOURCE = path.join(ROOT, "blackhole-sim/src/data/real-black-holes.json");

const UNCERTAINTY = ["measured", "contested", "unconstrained"];
const MEASURED_FIELDS = [
  "solarMasses",
  "spin",
  "inclinationDeg",
  "distanceKpc",
  "jets",
];

async function main() {
  const data = JSON.parse(await readFile(FILE, "utf8"));
  const src = JSON.parse(await readFile(SOURCE, "utf8"));

  if (data.schemaVersion !== 1) {
    throw new Error(`unexpected schemaVersion ${data.schemaVersion}`);
  }
  const objs = data.objects;
  if (!Array.isArray(objs) || objs.length < 5) {
    throw new Error(`expected at least 5 objects, got ${objs?.length}`);
  }

  const ids = new Set();
  for (const o of objs) {
    if (!/^[a-z0-9-]+$/.test(o.id ?? "")) {
      throw new Error(`bad slug: ${o.id}`);
    }
    if (ids.has(o.id)) throw new Error(`duplicate slug: ${o.id}`);
    ids.add(o.id);

    if (!o.name || !o.shortName) throw new Error(`${o.id}: missing name`);

    // Spec §6.4: a parameter without a citation and an uncertainty flag is not
    // shippable, no matter how well known the value is.
    for (const key of MEASURED_FIELDS) {
      const f = o[key];
      if (!f || typeof f !== "object") {
        throw new Error(`${o.id}: missing field ${key}`);
      }
      if (typeof f.source !== "string" || f.source.length < 20) {
        throw new Error(`${o.id}.${key}: missing or trivial source citation`);
      }
      if (!UNCERTAINTY.includes(f.uncertainty)) {
        throw new Error(`${o.id}.${key}: bad uncertainty "${f.uncertainty}"`);
      }
    }

    if (!(o.spin.value >= 0 && o.spin.value < 1)) {
      throw new Error(`${o.id}: spin ${o.spin.value} outside [0, 1)`);
    }
    if (!(o.inclinationDeg.value >= 0 && o.inclinationDeg.value <= 90)) {
      throw new Error(`${o.id}: inclination ${o.inclinationDeg.value} outside 0-90`);
    }
    if (!(o.solarMasses.value > 0)) throw new Error(`${o.id}: non-positive mass`);
    if (!(o.distanceKpc.value > 0)) throw new Error(`${o.id}: non-positive distance`);

    // Sky positions drive milestone 11's dots; a swapped RA/Dec would put an
    // object in the wrong constellation and nothing else would complain.
    if (!(o.raDeg >= 0 && o.raDeg < 360)) {
      throw new Error(`${o.id}: RA ${o.raDeg} outside 0-360`);
    }
    if (!(o.decDeg >= -90 && o.decDeg <= 90)) {
      throw new Error(`${o.id}: Dec ${o.decDeg} outside -90-90`);
    }
    if (typeof o.positionSource !== "string" || !o.positionSource) {
      throw new Error(`${o.id}: missing positionSource`);
    }
  }

  if (JSON.stringify(objs) !== JSON.stringify(src.objects)) {
    throw new Error(
      "data/black-holes.json has drifted from " +
        "blackhole-sim/src/data/real-black-holes.json — " +
        "run `npm run data:update:black-holes` (and edit the fork's copy, not this one)",
    );
  }

  console.log(`OK: ${objs.length} black holes, in sync with the fork's copy`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
