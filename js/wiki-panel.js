// Location panel: click a point, see Wikipedia articles ranked by proximity.
// Wikipedia's geosearch caps at a 10 km radius, so wider settings blend in
// "context" articles (city / region / country) resolved via Nominatim
// reverse geocoding + the Wikipedia summary API.

const GEOSEARCH_MAX_M = 10000;
const MIN_KM = 0.5;
const MAX_KM = 800;

export class WikiPanel {
  constructor(viewer) {
    this.viewer = viewer;
    this.el = document.getElementById("wiki-panel");
    this.resultsEl = document.getElementById("wp-results");
    this.coordsEl = document.getElementById("wp-coords");
    this.radiusInput = document.getElementById("wp-radius");
    this.radiusLabel = document.getElementById("wp-radius-label");
    this.lat = null;
    this.lon = null;
    this.pin = null;
    this.searchSeq = 0;
    this.debounce = null;

    document.getElementById("wp-close").addEventListener("click", () => this.close());
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.close();
    });
    this.radiusInput.addEventListener("input", () => {
      this.radiusLabel.textContent = formatKm(this.radiusKm());
      clearTimeout(this.debounce);
      this.debounce = setTimeout(() => {
        if (this.isOpen()) this.search();
      }, 450);
    });
    this.radiusLabel.textContent = formatKm(this.radiusKm());
  }

  isOpen() {
    return this.el.classList.contains("open");
  }

  radiusKm() {
    const t = this.radiusInput.value / 100;
    return MIN_KM * Math.pow(MAX_KM / MIN_KM, t);
  }

  open(lat, lon) {
    this.lat = lat;
    this.lon = lon;
    this.coordsEl.textContent =
      `${Math.abs(lat).toFixed(4)}° ${lat >= 0 ? "N" : "S"},  ` +
      `${Math.abs(lon).toFixed(4)}° ${lon >= 0 ? "E" : "W"}`;
    this._placePin(lat, lon);
    this.el.classList.add("open");
    this.search();
  }

  close() {
    this.el.classList.remove("open");
    this.searchSeq++;
    if (this.pin) {
      this.viewer.entities.remove(this.pin);
      this.pin = null;
    }
  }

  _placePin(lat, lon) {
    if (this.pin) this.viewer.entities.remove(this.pin);
    this.pin = this.viewer.entities.add({
      position: Cesium.Cartesian3.fromDegrees(lon, lat, 50),
      point: {
        pixelSize: 11,
        color: Cesium.Color.fromCssColorString("#ff5470"),
        outlineColor: Cesium.Color.WHITE,
        outlineWidth: 2,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
  }

  async search() {
    const seq = ++this.searchSeq;
    const { lat, lon } = this;
    const radiusKm = this.radiusKm();
    this.resultsEl.innerHTML =
      `<div class="wp-status"><div class="spinner"></div>Searching within ${formatKm(radiusKm)}…</div>`;

    try {
      const tasks = [geosearch(lat, lon, Math.min(radiusKm * 1000, GEOSEARCH_MAX_M))];
      if (radiusKm > 10) tasks.push(contextArticles(lat, lon, radiusKm));
      const [nearby, context] = await Promise.all(tasks);
      if (seq !== this.searchSeq) return; // superseded by a newer search

      const seen = new Set();
      const items = [];
      for (const c of context ?? []) {
        if (seen.has(c.title)) continue;
        seen.add(c.title);
        items.push(c);
      }
      for (const a of nearby) {
        if (seen.has(a.title)) continue;
        seen.add(a.title);
        items.push(a);
      }

      this._render(items.slice(0, 25), radiusKm);
    } catch (e) {
      if (seq !== this.searchSeq) return;
      this.resultsEl.innerHTML =
        `<div class="wp-status">Wikipedia search failed (${escapeHtml(e.message)}).<br/>Check your connection and try moving the radius slider.</div>`;
    }
  }

  _render(items, radiusKm) {
    if (items.length === 0) {
      this.resultsEl.innerHTML =
        `<div class="wp-status">No articles found within ${formatKm(radiusKm)}.<br/>Try widening the radius.</div>`;
      return;
    }
    this.resultsEl.innerHTML = items.map((it) => `
      <a class="wp-item" href="${escapeHtml(it.url)}" target="_blank" rel="noopener">
        <div class="wp-item-title">${escapeHtml(it.title)}${it.badge ? `<span class="wp-badge">${escapeHtml(it.badge)}</span>` : ""}</div>
        ${it.distKm != null ? `<div class="wp-item-dist">${formatKm(it.distKm)} away</div>` : ""}
        <div class="wp-item-extract">${escapeHtml(it.extract || "")}</div>
      </a>`).join("");
  }
}

// --- Wikipedia geosearch + batched intro extracts ---------------------------

async function geosearch(lat, lon, radiusM) {
  const gs = new URL("https://en.wikipedia.org/w/api.php");
  gs.search = new URLSearchParams({
    action: "query", list: "geosearch",
    gscoord: `${lat}|${lon}`,
    gsradius: String(Math.max(10, Math.round(radiusM))),
    gslimit: "20", format: "json", origin: "*",
  });
  const res = await fetch(gs);
  if (!res.ok) throw new Error(`geosearch HTTP ${res.status}`);
  const data = await res.json();
  const hits = data?.query?.geosearch ?? [];
  if (hits.length === 0) return [];

  const ex = new URL("https://en.wikipedia.org/w/api.php");
  ex.search = new URLSearchParams({
    action: "query",
    pageids: hits.map((h) => h.pageid).join("|"),
    prop: "extracts|info",
    exintro: "1", explaintext: "1", exchars: "260", exlimit: "20",
    inprop: "url", format: "json", origin: "*",
  });
  const exRes = await fetch(ex);
  const exData = exRes.ok ? await exRes.json() : null;
  const pages = exData?.query?.pages ?? {};

  return hits.map((h) => ({
    title: h.title,
    distKm: h.dist / 1000,
    extract: pages[h.pageid]?.extract ?? "",
    url: pages[h.pageid]?.fullurl ?? `https://en.wikipedia.org/?curid=${h.pageid}`,
  }));
}

// --- Regional / national context via Nominatim + Wikipedia summaries --------

async function contextArticles(lat, lon, radiusKm) {
  let address = null;
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&zoom=10&format=jsonv2&accept-language=en`;
    const res = await fetch(url);
    if (res.ok) address = (await res.json())?.address ?? null;
  } catch { /* ocean clicks and outages just skip context */ }
  if (!address) return [];

  const candidates = [];
  const city = address.city || address.town || address.village || address.municipality;
  if (city) candidates.push({ title: city, badge: "City" });
  if (radiusKm > 50 && address.state) candidates.push({ title: address.state, badge: "Region" });
  if (radiusKm > 200 && address.country) candidates.push({ title: address.country, badge: "Country" });

  // widest radii lead with the broadest context
  if (radiusKm > 200) candidates.reverse();

  const out = [];
  for (const c of candidates) {
    try {
      const res = await fetch(
        `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(c.title)}`);
      if (!res.ok) continue;
      const s = await res.json();
      if (s.type === "disambiguation") continue;
      out.push({
        title: s.title,
        badge: c.badge,
        extract: s.extract ?? "",
        url: s.content_urls?.desktop?.page ?? `https://en.wikipedia.org/wiki/${encodeURIComponent(c.title)}`,
        distKm: null,
      });
    } catch { /* skip unresolvable titles */ }
  }
  return out;
}

function formatKm(km) {
  if (km < 1) return `${Math.round(km * 1000)} m`;
  if (km < 20) return `${km.toFixed(1)} km`;
  return `${Math.round(km)} km`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
