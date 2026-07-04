import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const AIS_DATA_FILE = path.join(ROOT, "js/ais-data.js");
const MIDS_OUT = path.join(ROOT, "data/maritime-mids.latest.json");
const SHIP_TYPES_OUT = path.join(ROOT, "data/ais-ship-types.latest.json");

const SHIP_TYPE_RULES = [
  { from: 20, to: 29, label: "Wing-in-ground craft" },
  { from: 30, to: 30, label: "Fishing vessel" },
  { from: 31, to: 32, label: "Towing vessel" },
  { from: 33, to: 33, label: "Dredger" },
  { from: 34, to: 34, label: "Diving ops vessel" },
  { from: 35, to: 35, label: "Military vessel" },
  { from: 36, to: 36, label: "Sailing vessel" },
  { from: 37, to: 37, label: "Pleasure craft" },
  { from: 40, to: 49, label: "High-speed craft" },
  { from: 50, to: 50, label: "Pilot vessel" },
  { from: 51, to: 51, label: "Search & rescue vessel" },
  { from: 52, to: 52, label: "Tug" },
  { from: 53, to: 53, label: "Port tender" },
  { from: 54, to: 54, label: "Anti-pollution vessel" },
  { from: 55, to: 55, label: "Law enforcement vessel" },
  { from: 58, to: 58, label: "Medical transport" },
  { from: 60, to: 69, label: "Passenger ship" },
  { from: 70, to: 79, label: "Cargo ship" },
  { from: 80, to: 89, label: "Tanker" }
];

async function main() {
  const legacyMids = await readLegacyMids();
  const mids = Object.entries(legacyMids)
    .map(([mid, flag]) => ({ mid: Number(mid), flag }))
    .sort((a, b) => a.mid - b.mid);

  await mkdir(path.dirname(MIDS_OUT), { recursive: true });
  await writeFile(MIDS_OUT, `${JSON.stringify({
    schemaVersion: 1,
    meta: {
      generatedAt: new Date().toISOString(),
      sourceLabel: "ITU Maritime Identification Digits snapshot",
      sources: [
        {
          name: "ITU Radio Regulations Appendix 43",
          note: "Table 1 assigns Maritime Identification Digits (MIDs). No official CSV endpoint is used by this script."
        },
        {
          name: "Legacy Wiki Globe MID table",
          file: "js/ais-data.js"
        }
      ],
      notes: [
        "MID values are used to derive a vessel flag label from the first three MMSI digits.",
        "This is a generated standards snapshot so the runtime lookup is data-driven rather than embedded in application logic."
      ]
    },
    mids
  }, null, 2)}\n`, "utf8");

  await writeFile(SHIP_TYPES_OUT, `${JSON.stringify({
    schemaVersion: 1,
    meta: {
      generatedAt: new Date().toISOString(),
      sourceLabel: "AIS ship type code labels",
      sources: [
        {
          name: "AIS ship type codes",
          note: "Labels follow the common ITU-R M.1371 / AIS type-code groupings used by AIS static data."
        },
        {
          name: "Legacy Wiki Globe shipTypeName() mapping",
          file: "js/ais-data.js"
        }
      ],
      notes: [
        "Rules are inclusive from/to ranges.",
        "Unknown, missing, and code 0 values resolve to Vessel at runtime."
      ]
    },
    shipTypes: SHIP_TYPE_RULES
  }, null, 2)}\n`, "utf8");

  console.log(`Wrote ${path.relative(ROOT, MIDS_OUT)} (${mids.length} MIDs)`);
  console.log(`Wrote ${path.relative(ROOT, SHIP_TYPES_OUT)} (${SHIP_TYPE_RULES.length} ship type rules)`);
}

async function readLegacyMids() {
  const js = await readFile(AIS_DATA_FILE, "utf8");
  const match = js.match(/const MID_FLAGS = \{([\s\S]*?)\n\};/);
  if (!match) throw new Error("MID_FLAGS object not found");
  return Function(`"use strict"; return ({${match[1]}\n});`)();
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
