// Location panel: click a point, see Wikipedia articles ranked by proximity.
// Wikipedia's geosearch caps at a 10 km radius, so wider settings blend in
// "context" articles (city / region / country) resolved via Nominatim
// reverse geocoding + the Wikipedia summary API.
//
// On the globe the panel also draws: a centre pin at the clicked point, a
// translucent search-radius disc + glowing ring that track the slider in real
// time, and a Wikipedia "W" pin for every geolocated result. Markers and list
// rows cross-highlight, and markers on the far side of the globe are hidden via
// horizon occlusion.

const GEOSEARCH_MAX_M = 10000;
const MIN_KM = 0.5;
const MAX_KM = 800;
const RING_SEGMENTS = 128;
const MARKER_SCALE = 0.5;
const MARKER_SCALE_SELECTED = 0.82;

const PIN_COLOR = Cesium.Color.fromCssColorString("#ff5470");
const RING_COLOR = Cesium.Color.fromCssColorString("#ff7aa2");
const FILL_COLOR = Cesium.Color.fromCssColorString("#ff5470").withAlpha(0.08);

export class WikiPanel {
  constructor(viewer) {
    this.viewer = viewer;
    this.el = document.getElementById("wiki-panel");
    this.resultsEl = document.getElementById("wp-results");
    this.coordsEl = document.getElementById("wp-coords");
    this.radiusInput = document.getElementById("wp-radius");
    this.radiusLabel = document.getElementById("wp-radius-label");

    this.center = null;          // { lat, lon } of the clicked point
    this.radiusM = this.radiusKm() * 1000;
    this.items = [];             // current result rows (with _index / _marker)
    this.selected = null;
    this.searchSeq = 0;
    this.debounce = null;
    this.moonMode = false;       // off-Earth list: no Earth overlays, no geosearch

    this.pin = null;             // centre "you clicked here" entity
    this.circle = null;          // translucent radius disc entity
    this.ring = null;            // glowing radius boundary entity
    this.ringPositions = [];     // recomputed boundary, fed via CallbackProperty

    this.markers = viewer.scene.primitives.add(new Cesium.BillboardCollection());
    this.pinImage = makeWikiPinImage();
    this.occluder = new Cesium.EllipsoidalOccluder(
      viewer.scene.globe.ellipsoid, Cesium.Cartesian3.ZERO);

    document.getElementById("wp-close").addEventListener("click", () => this.close());
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.isOpen()) this.close();
    });

    // Radius slider: the circle tracks the slider instantly; the (networked)
    // Wikipedia search is debounced so we don't hammer the API while dragging.
    this.radiusInput.addEventListener("input", () => {
      this.radiusLabel.textContent = formatKm(this.radiusKm());
      this.radiusM = this.radiusKm() * 1000;
      this._recomputeRing();
      clearTimeout(this.debounce);
      this.debounce = setTimeout(() => {
        if (this.isOpen() && !this.moonMode) this.search();
      }, 450);
    });
    this.radiusLabel.textContent = formatKm(this.radiusKm());

    // Clicking a result locates its marker; the explicit "Read on Wikipedia"
    // link is left to open the article in a new tab.
    this.resultsEl.addEventListener("click", (e) => {
      if (e.target.closest(".wp-item-link")) return;
      const row = e.target.closest(".wp-item");
      if (!row) return;
      const item = this.items[Number(row.dataset.idx)];
      if (item) this._select(item, false);
    });

    // Hide markers that have rotated to the far side of the globe.
    viewer.scene.preRender.addEventListener(() => this._updateOcclusion());
  }

  isOpen() {
    return this.el.classList.contains("open") &&
      this.el.classList.contains("right-panel-pane-active") &&
      !this.el.classList.contains("collapsed");
  }

  radiusKm() {
    const t = this.radiusInput.value / 100;
    return MIN_KM * Math.pow(MAX_KM / MIN_KM, t);
  }

  // Off-Earth body mode: a body layer hands us a ready-made, distance-sorted
  // article list (markers already live on the body itself), so there's no
  // geosearch, radius slider, or Earth overlay to manage.
  openBody(bodyName, lat, lon, items) {
    this.searchSeq++;            // cancel any in-flight Earth search
    this.moonMode = true;
    this.conflict = null;
    this.center = null;
    this._clearPin();
    this._clearCircle();
    this._clearMarkers();
    this.el.classList.add("open", "moon");
    this._setCollapsed(false);
    this.coordsEl.textContent =
      `${bodyName} · ${Math.abs(lat).toFixed(2)}° ${lat >= 0 ? "N" : "S"},  ` +
      `${Math.abs(lon).toFixed(2)}° ${lon >= 0 ? "E" : "W"}`;
    this.items = items.slice(0, 25);
    this.items.forEach((it, i) => { it._index = i; });
    this.selected = null;
    this._renderList(null);
  }

  openMoon(lat, lon, items) {
    this.openBody("Moon", lat, lon, items);
  }

  // opts.conflict: aggregated UCDP cell from HeatmapLayer.conflictAt() — when
  // set, the result list opens with articles about that zone's conflicts.
  open(lat, lon, opts = {}) {
    this.moonMode = false;
    this.el.classList.remove("moon");
    this.conflict = opts.conflict ?? null;
    this.center = { lat, lon };
    this.coordsEl.textContent =
      `${Math.abs(lat).toFixed(4)}° ${lat >= 0 ? "N" : "S"},  ` +
      `${Math.abs(lon).toFixed(4)}° ${lon >= 0 ? "E" : "W"}`;
    this.radiusM = this.radiusKm() * 1000;
    this._placePin(lat, lon);
    this._placeCircle(lat, lon);
    this.el.classList.add("open");
    this._setCollapsed(false);
    this.search();
  }

  close() {
    const wasActive = this.el.classList.contains("right-panel-pane-active") ||
      (!this.el.classList.contains("right-panel-pane-inactive") && !this.el.classList.contains("collapsed"));
    this.el.classList.remove("open", "moon");
    if (wasActive) {
      this._setCollapsed(true);
      this.el.dispatchEvent(new CustomEvent("right-panel:closed", {
        bubbles: true,
        detail: { panel: "wiki" },
      }));
    }
    this.moonMode = false;
    this.searchSeq++;
    this._clearPin();
    this._clearCircle();
    this._clearMarkers();
    this.items = [];
    this.selected = null;
    this.conflict = null;
    this.coordsEl.textContent = "";
    this.resultsEl.innerHTML = `<div class="wp-status">Click the globe or map to discover nearby Wikipedia articles.</div>`;
  }

  // --- globe overlays --------------------------------------------------------

  _placePin(lat, lon) {
    this._clearPin();
    this.pin = this.viewer.entities.add({
      position: Cesium.Cartesian3.fromDegrees(lon, lat, 50),
      point: {
        pixelSize: 11,
        color: PIN_COLOR,
        outlineColor: Cesium.Color.WHITE,
        outlineWidth: 2,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
  }

  _clearPin() {
    if (this.pin) {
      this.viewer.entities.remove(this.pin);
      this.pin = null;
    }
  }

  _placeCircle(lat, lon) {
    this._clearCircle();
    this._recomputeRing();
    const pos = Cesium.Cartesian3.fromDegrees(lon, lat);

    // Translucent disc — shows the area being searched without hiding the map.
    this.circle = this.viewer.entities.add({
      position: pos,
      ellipse: {
        semiMajorAxis: new Cesium.CallbackProperty(() => this.radiusM, false),
        semiMinorAxis: new Cesium.CallbackProperty(() => this.radiusM, false),
        material: FILL_COLOR,
        height: 0,
        outline: false,
      },
    });

    // Bright glowing boundary — reads clearly on both day terrain and the
    // night texture. A wide polyline avoids the 1px ellipse-outline limit.
    this.ring = this.viewer.entities.add({
      polyline: {
        positions: new Cesium.CallbackProperty(() => this.ringPositions, false),
        width: 3,
        material: new Cesium.PolylineGlowMaterialProperty({
          color: RING_COLOR,
          glowPower: 0.28,
          taperPower: 1.0,
        }),
      },
    });
  }

  _clearCircle() {
    if (this.circle) { this.viewer.entities.remove(this.circle); this.circle = null; }
    if (this.ring) { this.viewer.entities.remove(this.ring); this.ring = null; }
    this.ringPositions = [];
  }

  _recomputeRing() {
    if (!this.center) { this.ringPositions = []; return; }
    this.ringPositions = circleRing(
      this.center.lat, this.center.lon, this.radiusM, RING_SEGMENTS);
  }

  // --- markers ---------------------------------------------------------------

  _buildMarkers() {
    this._clearMarkers();
    for (const it of this.items) {
      if (it.lat == null || it.lon == null) continue;
      it._worldPos = Cesium.Cartesian3.fromDegrees(it.lon, it.lat);
      it._marker = this.markers.add({
        position: Cesium.Cartesian3.fromDegrees(it.lon, it.lat, 0),
        image: this.pinImage,
        scale: this.selected === it ? MARKER_SCALE_SELECTED : MARKER_SCALE,
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        id: { kind: "wiki", article: it },
      });
    }
  }

  _clearMarkers() {
    this.markers.removeAll();
    for (const it of this.items) { it._marker = undefined; it._worldPos = undefined; }
  }

  _updateOcclusion() {
    if (!this.isOpen() || this.items.length === 0) return;
    this.occluder.cameraPosition = this.viewer.camera.positionWC;
    for (const it of this.items) {
      if (it._marker) it._marker.show = this.occluder.isPointVisible(it._worldPos);
    }
  }

  // Highlight a result + its marker together. `scroll` brings the matching row
  // into view (used when the marker is the thing that was clicked).
  _select(item, scroll) {
    this.selected = item;
    for (const it of this.items) {
      if (it._marker) {
        it._marker.scale = it === item ? MARKER_SCALE_SELECTED : MARKER_SCALE;
      }
    }
    for (const row of this.resultsEl.querySelectorAll(".wp-item")) {
      row.classList.toggle("selected", Number(row.dataset.idx) === item._index);
    }
    if (scroll) {
      const row = this.resultsEl.querySelector(`.wp-item[data-idx="${item._index}"]`);
      row?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }

  // Called from the globe when an article marker is clicked.
  focusArticle(article, opts = {}) {
    this._setCollapsed(false);
    this._select(article, true);
    if (opts.openPopup) openArticlePopup(article);
  }

  openArticlePopup(article) {
    openArticlePopup(article);
  }

  _setCollapsed(collapsed) {
    this.el.classList.toggle("collapsed", collapsed);
    const toggle = document.getElementById("wp-toggle");
    if (!toggle) return;
    const label = collapsed ? "Expand Wikipedia panel" : "Collapse Wikipedia panel";
    toggle.setAttribute("aria-expanded", String(!collapsed));
    toggle.setAttribute("aria-label", label);
    toggle.title = label;
    if (!collapsed) {
      this.el.dispatchEvent(new CustomEvent("right-panel:activate", {
        bubbles: true,
        detail: { panel: "wiki" },
      }));
    }
  }

  // --- search ----------------------------------------------------------------

  async search() {
    const seq = ++this.searchSeq;
    const { lat, lon } = this.center;
    const radiusKm = this.radiusKm();
    this.resultsEl.innerHTML =
      `<div class="wp-status"><div class="spinner"></div>Searching within ${formatKm(radiusKm)}…</div>`;

    try {
      const [nearby, context, conflictRelated] = await Promise.all([
        geosearch(lat, lon, Math.min(radiusKm * 1000, GEOSEARCH_MAX_M)),
        radiusKm > 10 ? contextArticles(lat, lon, radiusKm) : Promise.resolve([]),
        this.conflict ? conflictArticles(this.conflict) : Promise.resolve([]),
      ]);
      if (seq !== this.searchSeq) return; // superseded by a newer search

      const seen = new Set();
      const items = [];
      for (const c of [...conflictRelated, ...context, ...nearby]) {
        if (seen.has(c.title)) continue;
        seen.add(c.title);
        items.push(c);
      }

      this.items = items.slice(0, 25);
      this.items.forEach((it, i) => { it._index = i; });
      this.selected = null;
      this._renderList(radiusKm);
      this._buildMarkers();
    } catch (e) {
      if (seq !== this.searchSeq) return;
      this.resultsEl.innerHTML =
        `<div class="wp-status">Wikipedia search failed (${escapeHtml(e.message)}).<br/>Check your connection and try moving the radius slider.</div>`;
      this.items = [];
      this._clearMarkers();
    }
  }

  _renderList(radiusKm) {
    const zoneNote = this.conflict
      ? `<div class="wp-status">Active conflict zone — ` +
        `${escapeHtml(this.conflict.deaths.toLocaleString("en-US"))} deaths · ` +
        `${escapeHtml(String(this.conflict.events))} events` +
        `${this.conflict.period ? ` (${escapeHtml(this.conflict.period.start)} → ${escapeHtml(this.conflict.period.end)})` : ""}</div>`
      : "";
    if (this.items.length === 0) {
      this.resultsEl.innerHTML = zoneNote + (radiusKm == null
        ? `<div class="wp-status">No articles found near this point.</div>`
        : `<div class="wp-status">No articles found within ${formatKm(radiusKm)}.<br/>Try widening the radius.</div>`);
      return;
    }
    this.resultsEl.innerHTML = zoneNote + this.items.map((it) => `
      <div class="wp-item" data-idx="${it._index}">
        <div class="wp-item-title">
          <span class="wp-item-name">${escapeHtml(it.title)}</span>
          ${it.badge ? `<span class="wp-badge">${escapeHtml(it.badge)}</span>` : ""}
          ${it.lat != null ? `<span class="wp-item-loc" title="Pinned on the map">◉ map</span>` : ""}
        </div>
        ${it.distKm != null ? `<div class="wp-item-dist">${formatKm(it.distKm)} away</div>` : ""}
        <div class="wp-item-extract">${escapeHtml(it.extract || "")}</div>
        <a class="wp-item-link" href="${escapeHtml(it.url)}" target="_blank" rel="noopener">Read on Wikipedia ↗</a>
      </div>`).join("");
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
    lat: h.lat,
    lon: h.lon,
    distKm: h.dist / 1000,
    extract: pages[h.pageid]?.extract ?? "",
    url: pages[h.pageid]?.fullurl ?? `https://en.wikipedia.org/?curid=${h.pageid}`,
  }));
}

// --- Conflict-zone related articles ------------------------------------------

// Wikipedia full-text search seeded from the zone's dominant dyads (the
// conflict parties recorded by UCDP for the clicked cell), e.g.
// "Government of Russia (Soviet Union) - Government of Ukraine" →
// "Russia Ukraine conflict". Results carry no coordinates, so they list
// without map markers, badged "Conflict".
async function conflictArticles(zone) {
  const queries = (zone.topDyads ?? []).map(dyadQuery).filter(Boolean);
  if (queries.length === 0 && zone.country) queries.push(zone.country);

  const seen = new Set();
  const pageids = [];
  for (const q of queries.slice(0, 3)) {
    try {
      const url = new URL("https://en.wikipedia.org/w/api.php");
      url.search = new URLSearchParams({
        action: "query", list: "search",
        srsearch: `${q} conflict`, srlimit: "3",
        format: "json", origin: "*",
      });
      const res = await fetch(url);
      if (!res.ok) continue;
      for (const hit of (await res.json())?.query?.search ?? []) {
        if (!seen.has(hit.pageid)) {
          seen.add(hit.pageid);
          pageids.push(hit.pageid);
        }
      }
    } catch { /* a failed query just drops its suggestions */ }
  }
  if (pageids.length === 0) return [];

  const ex = new URL("https://en.wikipedia.org/w/api.php");
  ex.search = new URLSearchParams({
    action: "query",
    pageids: pageids.slice(0, 6).join("|"),
    prop: "extracts|info",
    exintro: "1", explaintext: "1", exchars: "260", exlimit: "6",
    inprop: "url", format: "json", origin: "*",
  });
  const exRes = await fetch(ex);
  if (!exRes.ok) return [];
  const pages = (await exRes.json())?.query?.pages ?? {};

  return pageids.slice(0, 6)
    .map((id) => pages[id])
    .filter(Boolean)
    .map((p) => ({
      title: p.title,
      badge: "Conflict",
      extract: p.extract ?? "",
      url: p.fullurl ?? `https://en.wikipedia.org/?curid=${p.pageid}`,
      distKm: null,
      lat: null,
      lon: null,
    }));
}

// "Government of Sudan (X) - SFA" → "Sudan SFA" for use as a search seed.
function dyadQuery(dyad) {
  return String(dyad ?? "")
    .replace(/Government of /gi, "")
    .replace(/\([^)]*\)/g, "")
    .replace(/\s*-\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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
        lat: s.coordinates?.lat ?? null,
        lon: s.coordinates?.lon ?? null,
      });
    } catch { /* skip unresolvable titles */ }
  }
  return out;
}

// --- geometry & assets ------------------------------------------------------

// Geodesic circle of `radiusM` around (lat, lon) as a ring of Cartesians.
function circleRing(lat, lon, radiusM, segments) {
  const positions = [];
  for (let i = 0; i <= segments; i++) {
    const [la, lo] = destPoint(lat, lon, radiusM, (i / segments) * 360);
    positions.push(Cesium.Cartesian3.fromDegrees(lo, la, 0));
  }
  return positions;
}

// Great-circle destination point from (lat, lon) at a bearing/distance.
function destPoint(latDeg, lonDeg, distM, brngDeg) {
  const R = 6371000;
  const d = distM / R;
  const brng = (brngDeg * Math.PI) / 180;
  const la1 = (latDeg * Math.PI) / 180;
  const lo1 = (lonDeg * Math.PI) / 180;
  const la2 = Math.asin(
    Math.sin(la1) * Math.cos(d) + Math.cos(la1) * Math.sin(d) * Math.cos(brng)
  );
  const lo2 = lo1 + Math.atan2(
    Math.sin(brng) * Math.sin(d) * Math.cos(la1),
    Math.cos(d) - Math.sin(la1) * Math.sin(la2)
  );
  return [(la2 * 180) / Math.PI, ((((lo2 * 180) / Math.PI) + 540) % 360) - 180];
}

// A pink Wikipedia "W" map pin — deliberately a labelled teardrop so it never
// reads as one of the round satellite / flight / vessel dots.
function makeWikiPinImage() {
  const s = 2;                 // draw at 2x for crispness, displayed via scale
  const W = 36, H = 46, cx = 18, cy = 16, r = 13;
  const c = document.createElement("canvas");
  c.width = W * s;
  c.height = H * s;
  const ctx = c.getContext("2d");
  ctx.scale(s, s);

  ctx.fillStyle = "#ff5470";
  // teardrop tail down to the anchor point
  ctx.beginPath();
  ctx.moveTo(cx, H - 2);
  ctx.lineTo(cx - 8, cy + 8);
  ctx.lineTo(cx + 8, cy + 8);
  ctx.closePath();
  ctx.fill();
  // head
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  // white rim
  ctx.lineWidth = 2;
  ctx.strokeStyle = "rgba(255,255,255,0.95)";
  ctx.beginPath();
  ctx.arc(cx, cy, r - 1.1, 0, Math.PI * 2);
  ctx.stroke();
  // the "W"
  ctx.fillStyle = "#fff";
  ctx.font = "bold 17px 'Segoe UI', system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("W", cx, cy + 1);
  return c;
}

function formatKm(km) {
  if (km < 1) return `${Math.round(km * 1000)} m`;
  if (km < 20) return `${km.toFixed(1)} km`;
  return `${Math.round(km)} km`;
}

function openArticlePopup(article) {
  const url = article?.url || wikiArticleUrl(article?.title);
  if (!url) return;

  const width = Math.min(980, Math.max(420, Math.round(window.screen.availWidth * 0.72)));
  const height = Math.min(820, Math.max(520, Math.round(window.screen.availHeight * 0.82)));
  const left = Math.max(0, Math.round((window.screen.availWidth - width) / 2));
  const top = Math.max(0, Math.round((window.screen.availHeight - height) / 2));
  const popup = window.open(
    url,
    "wikiGlobeArticle",
    `popup=yes,width=${width},height=${height},left=${left},top=${top},resizable=yes,scrollbars=yes`
  );
  popup?.focus();
}

function wikiArticleUrl(title) {
  if (!title) return "";
  return `https://en.wikipedia.org/wiki/${encodeURIComponent(title).replace(/%20/g, "_")}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
