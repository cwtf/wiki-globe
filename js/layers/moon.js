// Moon layer: the real Moon — live-ephemeris position, NASA LRO imagery,
// and Wikipedia article markers sourced from Wikidata.
//
// Position: Cesium's Simon 1994 analytic lunar ephemeris evaluated at the
// real-time clock every frame, rotated into Earth-fixed coordinates — the
// same live-time source that drives the Earth terminator. Orientation uses
// the IAU 2000 lunar rotation model when the build exposes it, with a
// tidal-lock approximation (near side facing Earth) as fallback.
//
// Articles come from a Wikidata SPARQL query for items with Moon-globe
// coordinates and an English Wikipedia sitelink, ranked by sitelink count.
// A small bundled list of famous sites is the offline fallback only.

const TEXTURE_URL = "assets/moon.jpg"; // NASA LRO / CGI Moon Kit (public domain)
const MOON_RADIUS = 1737400;           // mean radius, metres
const MARKER_ALT = 15000;              // lift dots off the surface so they don't z-fight
const MAX_ARTICLES = 400;
const HOME_VIEW = { lon: 10, lat: 22, height: 2.3e7 };

const SPARQL_URL = "https://query.wikidata.org/sparql";
// country of origin (P495) + its flag (P41) tag lunar missions with their
// nation; geographic features simply have neither
const SPARQL_QUERY = `
SELECT ?lat ?lon ?links ?article ?countryName ?flag WHERE {
  ?item p:P625 ?st .
  ?st psv:P625 ?v .
  ?v wikibase:geoGlobe wd:Q405 ;
     wikibase:geoLatitude ?lat ;
     wikibase:geoLongitude ?lon .
  ?item wikibase:sitelinks ?links .
  ?article schema:about ?item ;
           schema:isPartOf <https://en.wikipedia.org/> .
  OPTIONAL {
    ?item wdt:P495 ?country .
    OPTIONAL { ?country wdt:P41 ?flag . }
    OPTIONAL { ?country rdfs:label ?countryName FILTER(LANG(?countryName) = "en") }
  }
}
ORDER BY DESC(?links)
LIMIT ${MAX_ARTICLES + 20}`;

// Commons media values arrive as http://commons.wikimedia.org/wiki/Special:FilePath/<file>.
// The FilePath redirect is CORS-hostile for WebGL textures, so we keep just
// the file name and later resolve it to a direct upload.wikimedia.org
// thumbnail through the Commons API (which is CORS-friendly via origin=*).
function flagFileName(url) {
  const file = url?.split("Special:FilePath/")[1];
  return file ? decodeURIComponent(file) : null;
}

const DOT_COLOR = Cesium.Color.fromCssColorString("#ff5470");
const CATEGORY_ALL = "all";
const CATEGORY_DEFS = [
  { value: "missions", label: "Missions & landing sites" },
  { value: "craters", label: "Craters" },
  { value: "maria", label: "Maria & plains" },
  { value: "mountains", label: "Mountains & valleys" },
  { value: "basins", label: "Basins & regions" },
  { value: "other", label: "Other" },
];
const CATEGORY_LABELS = new Map(CATEGORY_DEFS.map((c) => [c.value, c.label]));
// ecliptic north pole in ICRF coordinates, for the tidal-lock fallback frame
const ECLIPTIC_NORTH = new Cesium.Cartesian3(0, -0.3977772, 0.9174821);

// EllipsoidGeometry starts its texture seam on the body-fixed +X axis, which
// lands the map's central meridian (the near side) at longitude 180°. Spin
// the textured geometry half a turn so map longitude 0 sits on +X, where the
// IAU frame, the article markers, and pickMoon() all put selenographic 0°.
// Measured: without this, the lon-0 face renders far-side highlands.
const TEXTURE_SEAM_ROT = Cesium.Matrix4.fromRotationTranslation(
  Cesium.Matrix3.fromRotationZ(Math.PI), Cesium.Cartesian3.ZERO);

// Offline fallback only — famous, stable lunar locations
// ([title, lat, lon, country?, Commons flag file?]).
const FALLBACK_SITES = [
  ["Tranquility Base", 0.6875, 23.4333, "United States", "Flag of the United States.svg"],
  ["Tycho (crater)", -43.31, -11.36],
  ["Copernicus (lunar crater)", 9.62, -20.08],
  ["Kepler (lunar crater)", 8.12, -38.01],
  ["Aristarchus (crater)", 23.73, -47.49],
  ["Plato (crater)", 51.62, -9.38],
  ["Clavius (crater)", -58.4, -14.4],
  ["Mare Tranquillitatis", 8.5, 31.4],
  ["Mare Imbrium", 32.8, -15.6],
  ["Mare Serenitatis", 28.0, 17.5],
  ["Mare Crisium", 17.0, 59.1],
  ["Oceanus Procellarum", 18.4, -57.4],
  ["Montes Apenninus", 18.9, -3.7],
  ["South Pole–Aitken basin", -53.0, 169.0],
  ["Chang'e 4", -45.5, 177.6, "China", "Flag of the People's Republic of China.svg"],
  ["Luna 2", 29.1, 0.0, "Soviet Union", "Flag of the Soviet Union.svg"],
];

export class MoonLayer {
  constructor(viewer) {
    this.viewer = viewer;
    this.scene = viewer.scene;
    this.visible = true;
    this.dayNight = true;
    this.focused = false;
    this.tracking = false;
    this.articles = [];
    this.source = "idle";            // articles load on first lunar visit
    this.articlesVisible = false;    // camera focus grants article context
    this.wikiEnabled = true;         // user toggle: wiki articles on the moon
    this.category = CATEGORY_ALL;
    this._articlesRequested = false;
    this.modelMatrix = Cesium.Matrix4.clone(Cesium.Matrix4.IDENTITY);
    this.onFocusChanged = null;
    this.savedMinZoom = null;

    // hide Cesium's own decorative moon so there aren't two in the sky
    if (this.scene.moon) this.scene.moon.show = false;

    this.points = this.scene.primitives.add(new Cesium.PointPrimitiveCollection());
    this.points.show = false; // no lunar markers while Earth has focus
    // mission origin-country flags, riding alongside their article markers
    this.flags = this.scene.primitives.add(new Cesium.BillboardCollection());
    this.flags.show = false;

    // orientation model: IAU 2000 lunar axes when the build exports it
    this.axes = typeof Cesium.IauOrientationAxes === "function"
      ? new Cesium.IauOrientationAxes()
      : null;

    this._scratch = {
      icrf: new Cesium.Matrix3(),
      rot: new Cesium.Matrix3(),
      pos: new Cesium.Cartesian3(),
      inv: new Cesium.Matrix4(),
      prim: new Cesium.Matrix4(),
      offset: new Cesium.Cartesian3(),
      center: new Cesium.Cartesian3(),
    };
  }

  init() {
    const material = Cesium.Material.fromType("Image", { image: TEXTURE_URL });
    // lit = real solar illumination (the lunar terminator tracks the actual
    // sun via scene lighting); flat = evenly lit, i.e. day/night cycle off
    this.litAppearance = new Cesium.MaterialAppearance({
      material, translucent: false, closed: true,
    });
    this.flatAppearance = new Cesium.MaterialAppearance({
      material, flat: true, translucent: false, closed: true,
    });

    this._updateTransform(this.viewer.clock.currentTime);

    this.primitive = this.scene.primitives.add(new Cesium.Primitive({
      geometryInstances: new Cesium.GeometryInstance({
        geometry: new Cesium.EllipsoidGeometry({
          radii: new Cesium.Cartesian3(MOON_RADIUS, MOON_RADIUS, MOON_RADIUS),
          stackPartitions: 64,
          slicePartitions: 128,
          vertexFormat: Cesium.MaterialAppearance.MaterialSupport.TEXTURED.vertexFormat,
        }),
        id: { kind: "moon", moon: this },
      }),
      appearance: this.dayNight ? this.litAppearance : this.flatAppearance,
      modelMatrix: Cesium.Matrix4.multiply(
        this.modelMatrix, TEXTURE_SEAM_ROT, new Cesium.Matrix4()),
      asynchronous: false,
      allowPicking: true,
    }));
  }

  // Article markers belong to the lunar focus context: nothing is fetched or
  // drawn while Earth has the camera; the first focused, wiki-enabled frame
  // triggers the load.
  setArticlesVisible(v) {
    this.articlesVisible = v;
    this._syncArticles();
  }

  setWikiEnabled(v) {
    this.wikiEnabled = v;
    this._syncArticles();
  }

  setCategory(category) {
    this.category = CATEGORY_LABELS.has(category) ? category : CATEGORY_ALL;
    this._buildMarkers();
  }

  filteredArticles() {
    if (this.category === CATEGORY_ALL) return this.articles;
    return this.articles.filter((a) => a.category === this.category);
  }

  _syncArticles() {
    const want = this.articlesVisible && this.wikiEnabled;
    if (want && !this._articlesRequested) {
      this._articlesRequested = true;
      this.source = "loading";
      this._loadArticles();
    }
    this.points.show = this.visible && want;
    this.flags.show = this.visible && want;
  }

  // --- per-frame ---------------------------------------------------------------

  tick() {
    if (!this.primitive) return;
    const time = this.viewer.clock.currentTime;
    this._updateTransform(time);
    // the textured sphere alone carries the half-turn seam correction; the
    // markers, flags, and picking stay in the true selenographic frame
    this.primitive.modelMatrix = Cesium.Matrix4.multiply(
      this.modelMatrix, TEXTURE_SEAM_ROT, this._scratch.prim);
    this.points.modelMatrix = this.modelMatrix;
    this.flags.modelMatrix = this.modelMatrix;

    // camera follows the moon while focused: re-anchor the look-at frame to
    // the fresh model matrix, preserving the camera's offset within it
    if (this.tracking) {
      const s = this._scratch;
      Cesium.Matrix4.inverseTransformation(this.modelMatrix, s.inv);
      Cesium.Matrix4.multiplyByPoint(s.inv, this.viewer.camera.positionWC, s.offset);
      this.viewer.camera.lookAtTransform(this.modelMatrix, s.offset);
    }
  }

  // Earth-fixed model matrix: Simon 1994 position + IAU orientation, exactly
  // as Cesium's built-in Moon primitive derives it.
  _updateTransform(time) {
    const s = this._scratch;
    const icrfToFixed =
      Cesium.Transforms.computeIcrfToFixedMatrix(time, s.icrf) ??
      Cesium.Transforms.computeTemeToPseudoFixedMatrix(time, s.icrf);
    const pos = Cesium.Simon1994PlanetaryPositions
      .computeMoonPositionInEarthInertialFrame(time, s.pos);

    let rot;
    if (this.axes) {
      // evaluate() yields ICRF → moon-fixed; we need the moon-fixed → ICRF
      // rotation to compose the model matrix, hence the transpose
      rot = this.axes.evaluate(time, s.rot);
      Cesium.Matrix3.transpose(rot, rot);
    } else {
      rot = this._tidalLockRotation(pos, s.rot);
    }
    Cesium.Matrix3.multiply(icrfToFixed, rot, rot);
    Cesium.Matrix3.multiplyByVector(icrfToFixed, pos, pos);
    Cesium.Matrix4.fromRotationTranslation(rot, pos, this.modelMatrix);
  }

  // Approximate lunar orientation when IauOrientationAxes is unavailable:
  // +X (texture prime meridian) toward Earth, +Z near the ecliptic north.
  _tidalLockRotation(moonPosIcrf, result) {
    const x = Cesium.Cartesian3.negate(moonPosIcrf, new Cesium.Cartesian3());
    Cesium.Cartesian3.normalize(x, x);
    const y = Cesium.Cartesian3.cross(ECLIPTIC_NORTH, x, new Cesium.Cartesian3());
    Cesium.Cartesian3.normalize(y, y);
    const z = Cesium.Cartesian3.cross(x, y, new Cesium.Cartesian3());
    return Cesium.Matrix3.setColumn(
      Cesium.Matrix3.setColumn(
        Cesium.Matrix3.setColumn(result, 0, x, result), 1, y, result), 2, z, result);
  }

  position() {
    return Cesium.Matrix4.getTranslation(this.modelMatrix, this._scratch.center);
  }

  distanceKm() {
    return Cesium.Cartesian3.magnitude(this.position()) / 1000;
  }

  // --- focus / camera ------------------------------------------------------------

  focus() {
    if (this.focused || !this.primitive) return;
    this.focused = true;
    this.onFocusChanged?.(true);
    const camera = this.viewer.camera;
    camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
    // keep scroll-zoom outside the lunar surface while orbiting it
    this.savedMinZoom = this.scene.screenSpaceCameraController.minimumZoomDistance;
    camera.flyToBoundingSphere(
      new Cesium.BoundingSphere(this.position().clone(), MOON_RADIUS * 2.0),
      {
        duration: 3.0,
        complete: () => {
          if (!this.focused) return;
          this.scene.screenSpaceCameraController.minimumZoomDistance =
            MOON_RADIUS + 30000;
          this.tracking = true;
        },
      }
    );
  }

  blur() {
    if (!this.focused) return;
    this.focused = false;
    this.tracking = false;
    this.onFocusChanged?.(false);
    const sscc = this.scene.screenSpaceCameraController;
    if (this.savedMinZoom != null) sscc.minimumZoomDistance = this.savedMinZoom;
    this.viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
    this.viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(
        HOME_VIEW.lon, HOME_VIEW.lat, HOME_VIEW.height),
      duration: 3.0,
    });
  }

  setVisible(v) {
    this.visible = v;
    if (this.primitive) this.primitive.show = v;
    this._syncArticles();
    if (!v) this.blur();
  }

  setDayNight(v) {
    this.dayNight = v;
    if (this.primitive) {
      this.primitive.appearance = v ? this.litAppearance : this.flatAppearance;
    }
  }

  // Ray-cast a screen position against the lunar sphere → { lat, lon } in
  // moon-fixed selenographic degrees, or null if the ray misses.
  pickMoon(windowPosition) {
    if (!this.primitive) return null;
    const ray = this.viewer.camera.getPickRay(windowPosition);
    if (!ray) return null;
    const sphere = new Cesium.BoundingSphere(this.position(), MOON_RADIUS);
    const hit = Cesium.IntersectionTests.raySphere(ray, sphere);
    if (!hit) return null;
    const world = Cesium.Ray.getPoint(ray, hit.start);
    const s = this._scratch;
    Cesium.Matrix4.inverseTransformation(this.modelMatrix, s.inv);
    const local = Cesium.Matrix4.multiplyByPoint(s.inv, world, new Cesium.Cartesian3());
    const r = Cesium.Cartesian3.magnitude(local);
    return {
      lat: Cesium.Math.toDegrees(Math.asin(local.z / r)),
      lon: Cesium.Math.toDegrees(Math.atan2(local.y, local.x)),
    };
  }

  // --- Wikipedia articles ----------------------------------------------------------

  async _loadArticles() {
    let items = null;
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 25000);
      const url = `${SPARQL_URL}?format=json&query=${encodeURIComponent(SPARQL_QUERY)}`;
      const res = await fetch(url, {
        signal: ctl.signal,
        headers: { Accept: "application/sparql-results+json" },
      });
      clearTimeout(t);
      if (res.ok) {
        const rows = (await res.json())?.results?.bindings ?? [];
        items = rows.map((b) => {
          const articleUrl = b.article.value;
          const slug = articleUrl.split("/wiki/")[1] ?? "";
          let lon = Number(b.lon.value);
          if (lon > 180) lon -= 360; // some lunar coords use 0–360°E
          const country = b.countryName?.value ?? null;
          return {
            title: decodeURIComponent(slug).replace(/_/g, " "),
            lat: Number(b.lat.value),
            lon,
            url: articleUrl,
            moon: true,
            extract: undefined,
            country,
            badge: country ?? undefined, // origin chip in the panel list
            flagUrl: null,
            _flagFile: flagFileName(b.flag?.value),
          };
        }).filter((a) => a.title && Number.isFinite(a.lat) && Number.isFinite(a.lon));
      }
    } catch (e) {
      console.warn("[moon] Wikidata article query failed:", e.message);
    }

    if (items && items.length > 10) {
      this.source = "live";
    } else {
      console.warn("[moon] using bundled fallback lunar sites");
      this.source = "data";
      items = FALLBACK_SITES.map(([title, lat, lon, country, flagFile]) => ({
        title, lat, lon,
        url: `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`,
        moon: true,
        extract: undefined,
        country: country ?? null,
        badge: country ?? undefined,
        flagUrl: null,
        _flagFile: flagFile ?? null,
      }));
    }

    for (const item of items) {
      item.category = moonArticleCategory(item);
      item.categoryLabel = CATEGORY_LABELS.get(item.category) ?? "Other";
    }

    // de-dup by title (Wikidata can hold several coordinate statements)
    const seen = new Set();
    this.articles = items.filter((a) =>
      seen.has(a.title) ? false : (seen.add(a.title), true));
    await this._resolveFlags(this.articles);
    this._buildMarkers();
  }

  // Batch-resolve Commons flag file names to direct thumbnail URLs that WebGL
  // can actually consume (upload.wikimedia.org serves CORS headers).
  async _resolveFlags(items) {
    const files = [...new Set(items.map((a) => a._flagFile).filter(Boolean))].slice(0, 50);
    if (files.length === 0) return;
    try {
      const url = new URL("https://commons.wikimedia.org/w/api.php");
      url.search = new URLSearchParams({
        action: "query",
        titles: files.map((f) => `File:${f}`).join("|"),
        prop: "imageinfo", iiprop: "url", iiurlwidth: "48",
        format: "json", origin: "*",
      });
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const thumbs = new Map();
      for (const p of Object.values(data?.query?.pages ?? {})) {
        const thumb = p.imageinfo?.[0]?.thumburl;
        if (thumb) thumbs.set(p.title.replace(/^File:/, ""), thumb);
      }
      // the API normalizes titles (underscores → spaces etc.)
      const norm = new Map();
      for (const n of data?.query?.normalized ?? []) {
        norm.set(n.from.replace(/^File:/, ""), n.to.replace(/^File:/, ""));
      }
      for (const a of items) {
        if (!a._flagFile) continue;
        const title = norm.get(a._flagFile) ?? a._flagFile;
        a.flagUrl = thumbs.get(title) ?? null;
      }
    } catch (e) {
      console.warn("[moon] flag thumbnail resolution failed:", e.message);
    }
  }

  _buildMarkers() {
    this.points.removeAll();
    this.flags.removeAll();
    const rad = Cesium.Math.RADIANS_PER_DEGREE;
    const r = MOON_RADIUS + MARKER_ALT;
    const scale = new Cesium.NearFarScalar(3.0e6, 1.3, 4.4e8, 0.45);
    for (const a of this.filteredArticles()) {
      const clat = Math.cos(a.lat * rad);
      // moon-fixed position; the collection's modelMatrix carries it to the sky
      a._moonPos = new Cesium.Cartesian3(
        r * clat * Math.cos(a.lon * rad),
        r * clat * Math.sin(a.lon * rad),
        r * Math.sin(a.lat * rad)
      );
      this.points.add({
        position: a._moonPos,
        pixelSize: 5,
        color: DOT_COLOR,
        outlineColor: Cesium.Color.WHITE.withAlpha(0.6),
        outlineWidth: 1,
        scaleByDistance: scale,
        id: { kind: "moonwiki", article: a },
      });
      // missions carry their origin-country flag beside the dot
      if (a.flagUrl) {
        this.flags.add({
          position: a._moonPos,
          image: a.flagUrl,
          width: 21,
          height: 14,
          horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
          verticalOrigin: Cesium.VerticalOrigin.CENTER,
          pixelOffset: new Cesium.Cartesian2(8, 0),
          scaleByDistance: scale,
          id: { kind: "moonwiki", article: a },
        });
      }
    }
    const show = this.visible && this.articlesVisible && this.wikiEnabled;
    this.points.show = show;
    this.flags.show = show;
    this.points.modelMatrix = this.modelMatrix;
    this.flags.modelMatrix = this.modelMatrix;
  }

  // Great-circle nearest articles on the lunar sphere.
  nearest(lat, lon, n) {
    const rad = Cesium.Math.RADIANS_PER_DEGREE;
    const la1 = lat * rad, lo1 = lon * rad;
    return this.filteredArticles()
      .map((a) => {
        const la2 = a.lat * rad, lo2 = a.lon * rad;
        const h = Math.sin((la2 - la1) / 2) ** 2 +
          Math.cos(la1) * Math.cos(la2) * Math.sin((lo2 - lo1) / 2) ** 2;
        const distKm = (2 * Math.asin(Math.sqrt(h)) * MOON_RADIUS) / 1000;
        return { a, distKm };
      })
      .sort((x, y) => x.distKm - y.distKm)
      .slice(0, n)
      .map(({ a, distKm }) => Object.assign(a, { distKm }));
  }

  // Open the wiki panel with the articles nearest a clicked lunar point.
  async openArticlesAt(lat, lon, wikiPanel) {
    const items = this.nearest(lat, lon, 20);
    await this._ensureExtracts(items);
    wikiPanel.openMoon(lat, lon, items);
  }

  // Open the panel led by a specific clicked article marker.
  async openArticle(article, wikiPanel) {
    const items = this.nearest(article.lat, article.lon, 20);
    const rest = items.filter((a) => a !== article);
    await this._ensureExtracts([article, ...rest]);
    wikiPanel.openMoon(article.lat, article.lon, [article, ...rest]);
  }

  // Batch-fill intro extracts from Wikipedia for items that lack one.
  async _ensureExtracts(items) {
    const missing = items.filter((a) => a.extract === undefined).slice(0, 20);
    if (missing.length === 0) return;
    try {
      const url = new URL("https://en.wikipedia.org/w/api.php");
      url.search = new URLSearchParams({
        action: "query",
        titles: missing.map((a) => a.title).join("|"),
        prop: "extracts|info",
        exintro: "1", explaintext: "1", exchars: "240",
        exlimit: String(missing.length),
        inprop: "url", redirects: "1", format: "json", origin: "*",
      });
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const pages = Object.values(data?.query?.pages ?? {});
      // map redirect chains back to the requested titles
      const redirect = new Map();
      for (const r of data?.query?.redirects ?? []) redirect.set(r.from, r.to);
      for (const a of missing) {
        let t = a.title;
        while (redirect.has(t)) t = redirect.get(t);
        const norm = (data?.query?.normalized ?? []).find((x) => x.from === t);
        if (norm) t = norm.to;
        const page = pages.find((p) => p.title === t || p.title === a.title);
        a.extract = page?.extract ?? "";
        if (page?.fullurl) a.url = page.fullurl;
      }
    } catch (e) {
      console.warn("[moon] extract fetch failed:", e.message);
      for (const a of missing) a.extract = "";
    }
  }

  counts() {
    return { source: this.source, count: this.filteredArticles().length };
  }
}

function moonArticleCategory(article) {
  const title = article.title.toLowerCase();
  if (
    article.country ||
    /\b(apollo|luna|chang'?e|surveyor|ranger|lunokhod|chandrayaan|smart-1|clementine|beresheet|hakuto|mission|landing|lander|probe|spacecraft)\b/.test(title)
  ) {
    return "missions";
  }
  if (/\bcrater\b/.test(title)) return "craters";
  if (/^(mare|oceanus|lacus|palus|sinus)\b/.test(title) || /\b(lunar mare|lunar maria|plain|plains)\b/.test(title)) {
    return "maria";
  }
  if (/^(montes|mons|vallis|rima|rimae|rupes|dorsum|dorsa|catena)\b/.test(title) || /\b(mountain|valley|rille|scarp|wrinkle ridge)\b/.test(title)) {
    return "mountains";
  }
  if (/\b(basin|regio|region|highland|terra|pole)\b/.test(title)) return "basins";
  return "other";
}
