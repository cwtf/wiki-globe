// Cloudflare Worker: live-data proxy for Wiki Globe (see README.md).
//
// Routes:
//   GET /opensky/states/all[?lamin=…]  OpenSky state vectors, authenticated
//       with OAuth2 client credentials, cached at the edge for SNAPSHOT_TTL_S
//       so all visitors share one upstream call, served with open CORS.
//   GET /ais (WebSocket upgrade)       Fanout relay: one upstream aisstream.io
//       connection (server-side key) broadcast to every connected visitor.

const OPENSKY_API = "https://opensky-network.org/api/states/all";
const OPENSKY_TOKEN_URL =
  "https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token";
const AISSTREAM_URL = "https://stream.aisstream.io/v0/stream";
const SNAPSHOT_TTL_S = 120; // matches the app's flight refresh cadence

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

let cachedToken = null; // { token, expiresAt } — per-isolate, refreshed on expiry

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    const url = new URL(request.url);
    if (url.pathname === "/opensky/states/all") return openskyStates(url, env, ctx);
    if (url.pathname === "/ais") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("expected websocket upgrade", { status: 426, headers: CORS });
      }
      if (!env.AISSTREAM_KEY) {
        return new Response("AISSTREAM_KEY not configured", { status: 503, headers: CORS });
      }
      return env.AIS_RELAY.get(env.AIS_RELAY.idFromName("global")).fetch(request);
    }
    return new Response("not found", { status: 404, headers: CORS });
  },
};

async function openskyStates(url, env, ctx) {
  url.searchParams.sort();
  const cacheKey = new Request(`https://opensky-snapshot.internal/${url.search}`);
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) return withCors(hit);

  const headers = {};
  const token = await getOpenSkyToken(env);
  if (token) headers.Authorization = `Bearer ${token}`;
  const upstream = await fetch(`${OPENSKY_API}${url.search}`, { headers });
  if (!upstream.ok) {
    return new Response(`opensky upstream HTTP ${upstream.status}`, {
      status: 502,
      headers: CORS,
    });
  }
  const body = await upstream.text();
  const res = new Response(body, {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": `public, max-age=${SNAPSHOT_TTL_S}`,
    },
  });
  ctx.waitUntil(cache.put(cacheKey, res.clone()));
  return withCors(res);
}

// Without client credentials the proxy still works anonymously, but OpenSky's
// anonymous quota (400 credits/day, 4 per global snapshot) empties fast.
async function getOpenSkyToken(env) {
  if (!env.OPENSKY_CLIENT_ID || !env.OPENSKY_CLIENT_SECRET) return null;
  if (cachedToken && Date.now() < cachedToken.expiresAt) return cachedToken.token;
  const res = await fetch(OPENSKY_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: env.OPENSKY_CLIENT_ID,
      client_secret: env.OPENSKY_CLIENT_SECRET,
    }),
  });
  if (!res.ok) return null;
  const data = await res.json();
  cachedToken = {
    token: data.access_token,
    expiresAt: Date.now() + Math.max((data.expires_in ?? 1800) - 60, 60) * 1000,
  };
  return cachedToken.token;
}

function withCors(res) {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(CORS)) out.headers.set(k, v);
  return out;
}

// One upstream aisstream.io connection shared by every visitor. Clients send
// their own subscribe payload on connect (the app does this keylessly); it is
// ignored — the relay subscribes upstream with the server-side key and a
// global bounding box, and forwards frames verbatim.
export class AisRelay {
  constructor(state, env) {
    this.env = env;
    this.sessions = new Set();
    this.upstream = null;
    this.reconnectDelay = 1000;
  }

  async fetch() {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    this.sessions.add(server);
    server.addEventListener("close", () => this._drop(server));
    server.addEventListener("error", () => this._drop(server));
    this._ensureUpstream();
    return new Response(null, { status: 101, webSocket: client });
  }

  _drop(ws) {
    this.sessions.delete(ws);
    if (this.sessions.size === 0 && this.upstream) {
      try { this.upstream.close(); } catch { /* already closed */ }
      this.upstream = null;
    }
  }

  async _ensureUpstream() {
    if (this.upstream || this.sessions.size === 0) return;
    let ws;
    try {
      const res = await fetch(AISSTREAM_URL, { headers: { Upgrade: "websocket" } });
      ws = res.webSocket;
      if (!ws) throw new Error("upstream refused websocket");
    } catch {
      this._scheduleReconnect();
      return;
    }
    ws.accept();
    this.upstream = ws;
    ws.send(JSON.stringify({
      APIKey: this.env.AISSTREAM_KEY,
      BoundingBoxes: [[[-90, -180], [90, 180]]],
      FilterMessageTypes: ["PositionReport", "ShipStaticData"],
    }));
    ws.addEventListener("message", (ev) => {
      this.reconnectDelay = 1000;
      for (const s of this.sessions) {
        try { s.send(ev.data); } catch { this._drop(s); }
      }
    });
    const onGone = () => {
      if (this.upstream === ws) {
        this.upstream = null;
        this._scheduleReconnect();
      }
    };
    ws.addEventListener("close", onGone);
    ws.addEventListener("error", onGone);
  }

  _scheduleReconnect() {
    if (this.sessions.size === 0) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(delay * 2, 60000);
    setTimeout(() => this._ensureUpstream(), delay);
  }
}
