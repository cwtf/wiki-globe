# Wiki Globe live-data proxy

A single free-tier [Cloudflare Worker](https://developers.cloudflare.com/workers/)
that unlocks the two live feeds the browser cannot reach on its own:

| Route | Feed | Why a proxy is needed |
| --- | --- | --- |
| `GET /opensky/states/all` | Global live aircraft (OpenSky) | OpenSky only sends `Access-Control-Allow-Origin: https://opensky-network.org`, so browsers on any other origin are CORS-blocked. The worker authenticates with OAuth2, caches each snapshot at the edge for 120 s (all visitors share one upstream call), and serves it with open CORS. |
| `GET /ais` (WebSocket) | Global live ships (aisstream.io) | aisstream needs an API key per connection. The worker holds **one** upstream connection with a server-side key and fans the frames out to every visitor — no visitor keys needed. |

Without the proxy the app still works: demo arcs at global zoom with keyless
live aircraft near the view (airplanes.live) when zoomed in, and Baltic AIS
via Digitraffic.

## Deploy

1. **Accounts** (all free):
   - [Cloudflare](https://dash.cloudflare.com/sign-up) + `npm i -g wrangler`, then `wrangler login`.
   - [OpenSky Network](https://opensky-network.org) — register, then create an
     **API client** on your account page to get a client id/secret
     (4,000 credits/day; a global snapshot costs 4 credits, so the 120 s cache
     uses at most ~2,880/day).
   - [aisstream.io](https://aisstream.io) — register and create an API key
     (optional; skip it and `/ais` returns 503 while `/opensky` still works).

2. **Secrets** (run in this directory):

   ```powershell
   wrangler secret put OPENSKY_CLIENT_ID
   wrangler secret put OPENSKY_CLIENT_SECRET
   wrangler secret put AISSTREAM_KEY
   ```

3. **Deploy**:

   ```powershell
   wrangler deploy
   ```

   Note the printed hostname, e.g. `wiki-globe-proxy.<you>.workers.dev`.

## Wire the app to it

Uncomment the config block near the bottom of `index.html` and fill in the
hostname:

```html
<script>
  window.WIKI_GLOBE_OPENSKY_URL = "https://wiki-globe-proxy.<you>.workers.dev/opensky/states/all";
  window.WIKI_GLOBE_AISSTREAM_WS = "wss://wiki-globe-proxy.<you>.workers.dev/ais";
</script>
```

Both can also be set per-session without editing anything:
`?openskyUrl=…&aisstreamWs=…` (persisted to localStorage).

## Verify

```powershell
curl "https://wiki-globe-proxy.<you>.workers.dev/opensky/states/all?lamin=45&lamax=47&lomin=5&lomax=7"
```

should return live `states`, and the app's Flights/Ships badges should read
`LIVE` with details "OpenSky live aircraft states" / "AIS proxy global feed".

## Notes

- The AIS relay is a Durable Object (free plan supports SQLite-backed DOs); it
  stays connected upstream only while at least one visitor is connected.
- Rough free-tier headroom: 100k worker requests/day dwarfs the ~720 cached
  OpenSky fetches; DO duration is the main variable if many visitors keep the
  ships layer open around the clock.
