import { mkdir, readFile, writeFile } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const LEGACY_FILE = path.join(ROOT, "js/ais-data.js");
const OUT_FILE = path.join(ROOT, "data/ports.latest.json");
const UNLOCODE_DOWNLOAD_PAGE = "https://unece.org/trade/cefact/UNLOCODE-Download";
const FALLBACK_URLS = [
  "https://service.unece.org/trade/locode/loc242csv.zip",
  "https://service.unece.org/trade/locode/loc241csv.zip",
  "https://service.unece.org/trade/locode/loc232csv.zip",
  "https://unece.org/sites/default/files/2025-07/loc251csv.zip",
  "https://unece.org/sites/default/files/2025-01/loc242csv.zip",
  "https://unece.org/sites/default/files/2024-07/loc241csv.zip",
  "https://unece.org/sites/default/files/2024-01/loc232csv.zip",
];

async function main() {
  const sourceUrl = process.env.UNLOCODE_CSV_URL || await discoverCsvZipUrl();
  const zip = await fetchBytes(sourceUrl);
  const csvFiles = extractZip(zip).filter((f) => /\.csv$/i.test(f.name));
  if (csvFiles.length === 0) throw new Error("UN/LOCODE ZIP did not contain CSV files");

  const ports = new Map();
  const warnings = [];
  let sourcePortCount = 0;
  for (const file of csvFiles) {
    if (!/UNLOCODE CodeList/i.test(file.name)) continue;
    const text = decodeText(file.bytes);
    const rows = parseCsv(text, UNLOCODE_COLUMNS);
    for (const row of rows) {
      const port = portFromLocodeRow(row);
      if (!port) continue;
      ports.set(port.locode, port);
      sourcePortCount++;
    }
  }
  if (sourcePortCount === 0) {
    throw new Error("no coordinate-bearing UN/LOCODE port rows were parsed");
  }

  const legacy = await readLegacyPorts();
  let legacyCoordinateFills = 0;
  for (const p of legacy) {
    const existing = ports.get(p.locode);
    if (existing) {
      existing.aliases = unique([...(existing.aliases ?? []), p.name, ...(p.aliases ?? [])]);
      continue;
    }
    ports.set(p.locode, {
      ...p,
      source: "Bundled legacy fallback",
      aliases: unique([p.locode, p.name, ...(p.aliases ?? [])]),
    });
    legacyCoordinateFills++;
  }
  if (legacyCoordinateFills) {
    warnings.push(`${legacyCoordinateFills} legacy ports were kept because UN/LOCODE had no coordinate-bearing port entry for them.`);
  }

  const outPorts = [...ports.values()].sort((a, b) => a.locode.localeCompare(b.locode));
  const out = {
    schemaVersion: 1,
    meta: {
      generatedAt: new Date().toISOString(),
      sourceLabel: "UNECE UN/LOCODE",
      sources: [
        {
          name: "UNECE UN/LOCODE",
          url: sourceUrl,
          downloadPage: UNLOCODE_DOWNLOAD_PAGE,
        },
      ],
      warnings,
      notes: [
        "Includes entries whose UN/LOCODE Function classifier contains 1 (port/water transport).",
        "Entries without parseable coordinates are skipped, because route rendering needs lat/lon.",
        "The previous handpicked port list is merged only to preserve aliases and fill missing coordinates.",
      ],
    },
    fields: {
      locode: "UN/LOCODE compact code",
      name: "UN/LOCODE location name",
      nameWoDiacritics: "UN/LOCODE name without diacritics",
      lat: "decimal degrees",
      lon: "decimal degrees",
      functions: "UN/LOCODE function classifier",
      status: "UN/LOCODE status code",
      date: "UN/LOCODE date field",
    },
    ports: outPorts,
  };

  await mkdir(path.dirname(OUT_FILE), { recursive: true });
  await writeFile(OUT_FILE, `${JSON.stringify(out, null, 2)}\n`, "utf8");
  console.log(`Wrote ${path.relative(ROOT, OUT_FILE)} (${outPorts.length} ports)`);
  for (const warning of warnings) console.warn(`[warn] ${warning}`);
}

const UNLOCODE_COLUMNS = [
  "change",
  "country",
  "location",
  "name",
  "nameWoDiacritics",
  "subdivision",
  "function",
  "status",
  "date",
  "iata",
  "coordinates",
  "remarks",
];

async function discoverCsvZipUrl() {
  try {
    const html = await fetchText(UNLOCODE_DOWNLOAD_PAGE);
    const links = [...html.matchAll(/href=["']([^"']+)["']/gi)]
      .map((m) => new URL(m[1], UNLOCODE_DOWNLOAD_PAGE).href)
      .filter((href) => /loc\d{3}csv\.zip$/i.test(href) || /csv\.zip$/i.test(href));
    if (links.length > 0) return links[0];
  } catch {
    // UNECE sometimes blocks scripted access to the listing page; direct files
    // remain public, so try known release paths below.
  }

  for (const url of FALLBACK_URLS) {
    try {
      const resp = await fetch(url, { method: "HEAD" });
      if (resp.ok) return url;
    } catch {
      // Try the next likely release URL.
    }
  }
  throw new Error("could not discover UN/LOCODE CSV ZIP URL");
}

function portFromLocodeRow(row) {
  const country = field(row, ["country", "country/territory", "ctry"]);
  const location = field(row, ["location", "locode", "code"]);
  const locode = normalizeCompact(field(row, ["locode"]) ?? `${country}${location}`);
  const name = field(row, ["name"]);
  const nameWoDiacritics = field(row, ["namewodiacritics", "namewithoutdiacritics", "name wo diacritics"]);
  const functions = field(row, ["function", "functions"]);
  const status = field(row, ["status"]);
  const date = field(row, ["date"]);
  const iata = field(row, ["iata"]);
  const coordinates = field(row, ["coordinates", "coordinate"]);
  const coord = parseCoordinates(coordinates);

  if (!/^[A-Z]{2}[A-Z0-9]{3}$/.test(locode)) return null;
  if (!name || !functions?.includes("1") || status === "XX" || !coord) return null;

  return {
    locode,
    name,
    nameWoDiacritics: nameWoDiacritics || null,
    lat: roundCoord(coord.lat),
    lon: roundCoord(coord.lon),
    functions,
    status: status || null,
    date: date || null,
    iata: iata || null,
    aliases: unique([locode, name, nameWoDiacritics, iata].filter(Boolean)),
  };
}

function parseCoordinates(value) {
  const s = String(value ?? "").trim().toUpperCase();
  const compact = s.replace(/\s+/g, "");
  let m = compact.match(/^(\d{2})(\d{2})([NS])(\d{3})(\d{2})([EW])$/);
  if (m) {
    const lat = Number(m[1]) + Number(m[2]) / 60;
    const lon = Number(m[4]) + Number(m[5]) / 60;
    return {
      lat: m[3] === "S" ? -lat : lat,
      lon: m[6] === "W" ? -lon : lon,
    };
  }
  m = s.match(/^(-?\d+(?:\.\d+)?)[,\s]+(-?\d+(?:\.\d+)?)$/);
  if (m) return { lat: Number(m[1]), lon: Number(m[2]) };
  return null;
}

async function readLegacyPorts() {
  const js = await readFile(LEGACY_FILE, "utf8");
  const match = js.match(/const PORTS = \[([\s\S]*?)\n\];/);
  if (!match) return [];
  const rows = Function(`"use strict"; return ([${match[1]}\n]);`)();
  return rows.map((p) => ({
    locode: normalizeCompact(p[0]),
    name: p[1],
    lat: p[2],
    lon: p[3],
    aliases: [p[0], p[1]],
  }));
}

function extractZip(bytes) {
  const buf = Buffer.from(bytes);
  const eocd = findSignature(buf, 0x06054b50, Math.max(0, buf.length - 65558));
  if (eocd < 0) throw new Error("ZIP end-of-central-directory not found");
  const entries = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  const files = [];
  for (let i = 0; i < entries; i++) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) throw new Error("invalid ZIP central directory");
    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.slice(offset + 46, offset + 46 + nameLen).toString("utf8");
    offset += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/")) continue;
    if (buf.readUInt32LE(localOffset) !== 0x04034b50) throw new Error("invalid ZIP local header");
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const compressed = buf.slice(dataStart, dataStart + compressedSize);
    const fileBytes = method === 0 ? compressed : method === 8 ? inflateRawSync(compressed) : null;
    if (!fileBytes) throw new Error(`unsupported ZIP compression method ${method}`);
    files.push({ name, bytes: fileBytes });
  }
  return files;
}

function findSignature(buf, sig, start) {
  for (let i = buf.length - 4; i >= start; i--) {
    if (buf.readUInt32LE(i) === sig) return i;
  }
  return -1;
}

function parseCsv(text, providedHeader = null) {
  const delimiter = detectDelimiter(text);
  const rows = [];
  let row = [];
  let fieldValue = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { fieldValue += '"'; i++; }
      else if (ch === '"') quoted = false;
      else fieldValue += ch;
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === delimiter) {
      row.push(fieldValue);
      fieldValue = "";
    } else if (ch === "\n") {
      row.push(fieldValue);
      rows.push(row);
      row = [];
      fieldValue = "";
    } else if (ch !== "\r") {
      fieldValue += ch;
    }
  }
  if (fieldValue || row.length) {
    row.push(fieldValue);
    rows.push(row);
  }
  const header = providedHeader?.map((h) => normalizeHeader(h)) ??
    rows.shift()?.map((h) => normalizeHeader(h)) ?? [];
  return rows
    .filter((r) => r.some((v) => v !== ""))
    .map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]?.trim() ?? ""])));
}

function detectDelimiter(text) {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  return (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ";" : ",";
}

function field(row, names) {
  for (const name of names) {
    const key = normalizeHeader(name);
    if (row[key] !== undefined && row[key] !== "") return String(row[key]).trim();
  }
  return null;
}

async function fetchBytes(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`${url} HTTP ${resp.status}`);
  return new Uint8Array(await resp.arrayBuffer());
}

async function fetchText(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`${url} HTTP ${resp.status}`);
  return resp.text();
}

function decodeText(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(bytes).replace(/^\uFEFF/, "");
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder("utf-16be").decode(bytes).replace(/^\uFEFF/, "");
  }
  const sample = bytes.subarray(0, Math.min(bytes.length, 200));
  const nulls = sample.filter((b) => b === 0).length;
  if (nulls > sample.length / 4) {
    return new TextDecoder("utf-16le").decode(bytes).replace(/^\uFEFF/, "");
  }
  return new TextDecoder("utf-8").decode(bytes).replace(/^\uFEFF/, "");
}

function normalizeHeader(s) {
  return stripDiacritics(s).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function normalizeCompact(s) {
  return stripDiacritics(s).toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function stripDiacritics(s) {
  return String(s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function unique(values) {
  return [...new Set(values.filter(Boolean).map((v) => String(v).trim()).filter(Boolean))];
}

function roundCoord(value) {
  return Math.round(value * 1000000) / 1000000;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
