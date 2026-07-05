// Place search bar: type-ahead over country boundaries plus country-assembled
// continents and regions. Choosing a result flies the camera to it; the
// "+ compare" button drops a draggable true-size overlay instead.

import { loadCountryGeo, countryAreaKm2, formatArea } from "./country-geo.js";
import { buildContinentGeo } from "./continent-geo.js";

const MAX_RESULTS = 8;
const HIGHLIGHT_MS = 5000;
const MIN_HEIGHT = 3.0e5;  // metres — camera floor for tiny countries
const MAX_HEIGHT = 2.2e7;
const HIGHLIGHT_COLOR = Cesium.Color.fromCssColorString("#6ef3ff").withAlpha(0.9);

export class CountrySearch {
  constructor(viewer, truesize, onInteract) {
    this.viewer = viewer;
    this.truesize = truesize;
    this.onInteract = onInteract ?? (() => {});
    this.geo = null;
    this.entries = [];
    this.results = [];
    this.active = -1;
    this._highlight = [];
    this._highlightTimer = null;

    this.input = document.getElementById("search-input");
    this.box = document.getElementById("search-results");

    this.input.addEventListener("focus", () => {
      if (this.geo) this._update();
      else this._ensureGeo();
    });
    this.input.addEventListener("input", () => this._update());
    this.input.addEventListener("keydown", (e) => this._key(e));
    document.addEventListener("pointerdown", (e) => {
      if (!e.target.closest("#search")) this._close();
    });
  }

  async _ensureGeo() {
    if (this.geo) return;
    try {
      this.geo = await loadCountryGeo();
      this.entries = [
        ...buildContinentGeo(this.geo),
        ...this.geo.map((f) => ({ ...f, type: "Country", searchKind: "country" })),
      ];
      this._update(); // the user may have typed while the list loaded
    } catch (e) {
      console.warn("[search] place data failed to load:", e.message);
    }
  }

  _update() {
    const q = this.input.value.trim().toLowerCase();
    if (!this.geo) {
      this._ensureGeo();
      this.box.innerHTML = `<div class="sr-empty">Loading places...</div>`;
      this.box.hidden = false;
      return;
    }
    if (!q) {
      this.results = this.entries.filter((f) => f.searchKind === "region");
      this.active = this.results.length ? 0 : -1;
      this._render();
      return;
    }
    const starts = [];
    const contains = [];
    for (const f of this.entries) {
      const n = f.name.toLowerCase();
      if (n.startsWith(q)) starts.push(f);
      else if (n.includes(q)) contains.push(f);
    }
    this.results = [...starts, ...contains].slice(0, MAX_RESULTS);
    this.active = this.results.length ? 0 : -1;
    this._render();
  }

  _render() {
    this.box.innerHTML = "";
    if (this.results.length === 0) {
      this.box.innerHTML = `<div class="sr-empty">No matching place</div>`;
      this.box.hidden = false;
      return;
    }
    this.results.forEach((f, i) => {
      const row = document.createElement("div");
      row.className = "sr-item" + (i === this.active ? " active" : "");

      const name = document.createElement("span");
      name.className = "sr-name";
      name.textContent = f.name;

      const area = document.createElement("span");
      area.className = "sr-area";
      area.textContent = formatArea(areaKm2(f));

      const type = document.createElement("span");
      type.className = `sr-type ${f.searchKind ?? "country"}`;
      type.textContent = f.type ?? "Country";

      const add = document.createElement("button");
      add.className = "sr-add";
      add.type = "button";
      add.textContent = "+ compare";
      add.title = `Add a draggable true-size outline of ${f.name}`;
      add.addEventListener("click", (e) => {
        e.stopPropagation();
        this.truesize.add(f);
        add.textContent = "✓ added";
        add.disabled = true;
      });

      row.append(name, type, area, add);
      // pointerdown would blur the input before click fires — keep focus
      row.addEventListener("pointerdown", (e) => e.preventDefault());
      row.addEventListener("click", () => this._choose(f));
      this.box.appendChild(row);
    });
    this.box.hidden = false;
  }

  _key(e) {
    if (e.key === "Escape") {
      this._close();
      this.input.blur();
      return;
    }
    if (this.results.length === 0) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const n = this.results.length;
      this.active = (this.active + (e.key === "ArrowDown" ? 1 : n - 1) + n) % n;
      this._render();
    } else if (e.key === "Enter" && this.active >= 0) {
      e.preventDefault();
      this._choose(this.results[this.active]);
    }
  }

  _choose(f) {
    this.input.value = f.name;
    this._close();
    this.input.blur();
    this._flyTo(f);
    this._highlightCountry(f);
  }

  _flyTo(f) {
    const carto = [];
    for (const ring of f.rings) {
      for (const [lon, lat] of ring) carto.push(Cesium.Cartographic.fromDegrees(lon, lat));
    }
    // fromCartographicArray picks the smallest rectangle, handling countries
    // that cross the antimeridian (Fiji, Russia, New Zealand)
    const rect = Cesium.Rectangle.fromCartographicArray(carto);
    const center = Cesium.Rectangle.center(rect);
    const span = Math.max(rect.width, rect.height); // radians
    const height = Cesium.Math.clamp(span * 6.371e6 * 1.35, MIN_HEIGHT, MAX_HEIGHT);
    this.onInteract();
    this.viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromRadians(center.longitude, center.latitude, height),
      duration: 1.8,
      complete: () => this.onInteract(), // hold off the auto-rotate idle timer
    });
  }

  _highlightCountry(f) {
    this._clearHighlight();
    for (const ring of f.rings) {
      if (ring.length < 2) continue;
      this._highlight.push(this.viewer.entities.add({
        polyline: {
          positions: ring.map(([lon, lat]) => Cesium.Cartesian3.fromDegrees(lon, lat, 2000)),
          width: 2.5,
          material: HIGHLIGHT_COLOR,
          arcType: Cesium.ArcType.GEODESIC,
        },
      }));
    }
    this._highlightTimer = setTimeout(() => this._clearHighlight(), HIGHLIGHT_MS);
  }

  _clearHighlight() {
    clearTimeout(this._highlightTimer);
    for (const ent of this._highlight) this.viewer.entities.remove(ent);
    this._highlight = [];
  }

  _close() {
    this.box.hidden = true;
    this.box.innerHTML = "";
    this.results = [];
    this.active = -1;
  }
}

function areaKm2(f) {
  return f.areaKm2 ?? countryAreaKm2(f);
}
