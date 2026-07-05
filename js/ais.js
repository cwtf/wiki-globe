// Live AIS providers, tried in order:
//  1. aisstream.io WebSocket — global coverage, needs a (free) API key the
//     user supplies via ?aiskey= or the "AIS key" link (localStorage).
//  2. Digitraffic Finland REST — open data, no key, Baltic coverage, polled.
// Returns null when neither works; the shipping layer then falls back to
// simulated vessels.

const DEFAULT_AISSTREAM_WS = "wss://stream.aisstream.io/v0/stream";
const DIGITRAFFIC_LOCATIONS = "https://meri.digitraffic.fi/api/ais/v1/locations";
const DIGITRAFFIC_VESSELS = "https://meri.digitraffic.fi/api/ais/v1/vessels";
const LOCATION_POLL_MS = 60 * 1000;
const META_POLL_MS = 10 * 60 * 1000;
const FRESH_MS = 15 * 60 * 1000;
const KEY_STORAGE = "wikiglobe.aiskey";

export function getAisKey() {
  const fromUrl = new URLSearchParams(location.search).get("aiskey");
  if (fromUrl) {
    try { localStorage.setItem(KEY_STORAGE, fromUrl); } catch { /* private mode */ }
    return fromUrl;
  }
  try { return localStorage.getItem(KEY_STORAGE); } catch { return null; }
}

export function setAisKey(key) {
  try {
    if (key) localStorage.setItem(KEY_STORAGE, key);
    else localStorage.removeItem(KEY_STORAGE);
  } catch { /* private mode */ }
}

// callbacks: onPosition({mmsi, lat, lon, sogKn, cogDeg, headingDeg, ts, name?})
//            onStatic({mmsi, name?, typeCode?, destination?})
export async function createLiveAis(callbacks) {
  const key = getAisKey();
  const aisstreamUrl = getAisstreamWsUrl();
  if (key || aisstreamUrl !== DEFAULT_AISSTREAM_WS) {
    const ws = await tryAisstream(aisstreamUrl, key, callbacks);
    if (ws) return ws;
    console.warn("[ais] aisstream connection failed, trying Digitraffic");
  }
  return tryDigitraffic(callbacks);
}

// --- aisstream.io (global, WebSocket) ---------------------------------------

function getAisstreamWsUrl() {
  const params = new URLSearchParams(location.search);
  const fromUrl = cleanUrl(params.get("aisstreamWs"));
  if (fromUrl) {
    try { localStorage.setItem("wikiglobe.aisstreamWs", fromUrl); } catch { /* private mode */ }
    return fromUrl;
  }
  let stored = null;
  try {
    stored = localStorage.getItem("wikiglobe.aisstreamWs");
  } catch { /* private mode */ }
  return (
    cleanUrl(window.WIKI_GLOBE_AISSTREAM_WS) ||
    cleanUrl(stored) ||
    DEFAULT_AISSTREAM_WS
  );
}

function cleanUrl(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function tryAisstream(url, key, cb) {
  return new Promise((resolve) => {
    let settled = false;
    let stopped = false;
    let ws = null;
    let usableMessages = 0;

    const settle = (value) => {
      if (!settled) { settled = true; resolve(value); }
    };

    const connect = () => {
      if (stopped) return;
      try {
        ws = new WebSocket(url);
      } catch {
        settle(null);
        return;
      }
      ws.onopen = () => {
        const payload = {
          BoundingBoxes: [[[-90, -180], [90, 180]]],
          FilterMessageTypes: ["PositionReport", "ShipStaticData"],
        };
        if (key) payload.APIKey = key;
        ws.send(JSON.stringify(payload));
      };
      ws.onmessage = (ev) => {
        try {
          if (handleAisstream(JSON.parse(ev.data), cb)) {
            usableMessages++;
            settle({
              kind: "aisstream",
              detail: url === DEFAULT_AISSTREAM_WS
                ? "aisstream.io global AIS"
                : "AIS proxy global feed",
              stop,
            });
          }
        } catch { /* skip bad frame */ }
      };
      ws.onerror = () => settle(null);
      ws.onclose = () => {
        if (!settled) settle(null);
        else if (!stopped) setTimeout(connect, 10000); // reconnect after drop
      };
    };

    const stop = () => {
      stopped = true;
      try { ws?.close(); } catch { /* already closed */ }
    };

    // bad keys often produce a silent connection that never sends data
    setTimeout(() => {
      if (!settled || usableMessages === 0) {
        stop();
        settle(null);
      }
    }, 15000);
    connect();
  });
}

function handleAisstream(msg, cb) {
  const meta = msg.MetaData;
  if (!meta?.MMSI) return false;
  if (msg.MessageType === "PositionReport") {
    const pr = msg.Message?.PositionReport;
    if (!pr || pr.Latitude == null) return false;
    const heading = pr.TrueHeading != null && pr.TrueHeading !== 511 ? pr.TrueHeading : pr.Cog;
    cb.onPosition({
      mmsi: meta.MMSI,
      lat: pr.Latitude,
      lon: pr.Longitude,
      sogKn: pr.Sog ?? 0,
      cogDeg: pr.Cog ?? 0,
      headingDeg: heading ?? 0,
      ts: Date.now(),
      name: (meta.ShipName ?? "").trim() || undefined,
    });
    return true;
  } else if (msg.MessageType === "ShipStaticData") {
    const sd = msg.Message?.ShipStaticData;
    if (!sd) return false;
    cb.onStatic({
      mmsi: meta.MMSI,
      name: (sd.Name ?? meta.ShipName ?? "").trim() || undefined,
      typeCode: sd.Type,
      destination: (sd.Destination ?? "").trim() || undefined,
    });
    return true;
  }
  return false;
}

// --- Digitraffic Finland (Baltic, REST polling) ------------------------------

async function tryDigitraffic(cb) {
  const initial = await fetchJson(DIGITRAFFIC_LOCATIONS, 20000);
  if (!initial?.features?.length) return null;

  const applyMeta = (list) => {
    for (const v of list ?? []) {
      cb.onStatic({
        mmsi: v.mmsi,
        name: (v.name ?? "").trim() || undefined,
        typeCode: v.shipType,
        destination: (v.destination ?? "").trim() || undefined,
      });
    }
  };

  const applyLocations = (data) => {
    const cutoff = Date.now() - FRESH_MS;
    for (const f of data.features) {
      const p = f.properties;
      if (!p || p.timestampExternal < cutoff) continue;
      const [lon, lat] = f.geometry.coordinates;
      cb.onPosition({
        mmsi: p.mmsi,
        lat, lon,
        sogKn: p.sog != null && p.sog < 102.3 ? p.sog : 0, // 102.3 = unavailable
        cogDeg: p.cog ?? 0,
        headingDeg: p.heading != null && p.heading !== 511 ? p.heading : (p.cog ?? 0),
        ts: p.timestampExternal,
      });
    }
  };

  // metadata first so names/destinations are ready when positions land
  applyMeta(await fetchJson(DIGITRAFFIC_VESSELS, 20000));
  applyLocations(initial);

  const locTimer = setInterval(async () => {
    const d = await fetchJson(DIGITRAFFIC_LOCATIONS, 30000);
    if (d?.features) applyLocations(d);
  }, LOCATION_POLL_MS);
  const metaTimer = setInterval(async () => {
    applyMeta(await fetchJson(DIGITRAFFIC_VESSELS, 30000));
  }, META_POLL_MS);

  return {
    kind: "digitraffic",
    detail: "Digitraffic Finland AIS (Baltic/regional)",
    stop() { clearInterval(locTimer); clearInterval(metaTimer); },
  };
}

async function fetchJson(url, timeoutMs) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    const res = await fetch(url, { signal: ctl.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}
