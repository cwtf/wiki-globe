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
      if (e.key === "Escape") this.close();
    });

    // Radius slider: the circle tracks the slider instantly; the (networked)
    // Wikipedia search is debounced so we don't hammer the API while dragging.
    this.radiusInput.addEventListener("input", () => {
      this.radiusLabel.textContent = formatKm(this.radiusKm());
      this.radiusM = this.radiusKm() * 1000;
      this._recomputeRing();
      clearTimeout(this.debounce);
      this.debounce = setTimeout(() => {
        if (this.isOpen()) this.search();
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
    return this.el.classList.contains("open");
  }

  radiusKm() {
    const t = this.radiusInput.value / 100;
    return MIN_KM * Math.pow(MAX_KM / MIN_KM, t);
  }

  open(lat, lon) {
    this.center = { lat, lon };
    this.coordsEl.textContent =
      `${Math.abs(lat).toFixed(4)}° ${lat >= 0 ? "N" : "S"},  ` +
      `${Math.abs(lon).toFixed(4)}° ${lon >= 0 ? "E" : "W"}`;
    this.radiusM = this.radiusKm() * 1000;
    this._placePin(lat, lon);
    this._placeCircle(lat, lon);
    this.el.classList.add("open");
    this.search();
  }

  close() {
    this.el.classList.remove("open");
    this.searchSeq++;
    this._clearPin();
    this._clearCircle();
    this._clearMarkers();
    this.items = [];
    this.selected = null;
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
  focusArticle(article) {
    this._select(article, true);
  }

  // --- search ----------------------------------------------------------------

  async search() {
    const seq = ++this.searchSeq;
    const { lat, lon } = this.center;
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
    if (this.items.length === 0) {
      this.resultsEl.innerHTML =
        `<div class="wp-status">No articles found within ${formatKm(radiusKm)}.<br/>Try widening the radius.</div>`;
      return;
    }
    this.resultsEl.innerHTML = this.items.map((it) => `
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

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
