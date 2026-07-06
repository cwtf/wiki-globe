// Mars layer: true live geocentric position via astronomy-engine, a textured
// Mars globe while focused, and Wikidata/Wikipedia surface markers.

const TEXTURE_URL = "assets/mars.jpg"; // Solar System Scope, CC BY 4.0
const MARS_RADIUS = 3389500;           // mean radius, metres
const MARKER_ALT = 120000;
const MAX_ARTICLES = 420;
const AU = 1.495978707e11;
const HOME_VIEW = { lon: 10, lat: 22, height: 2.3e7 };
const TRANSITION_PROXY_DISTANCE = 7.5e7;
const TRANSITION_PROXY_RADIUS = MARS_RADIUS;
const TRANSITION_DURATION = 2.4;

const SPARQL_URL = "https://query.wikidata.org/sparql";
const SPARQL_QUERY = `
SELECT ?lat ?lon ?links ?article ?countryName ?flag WHERE {
  ?item p:P625 ?st .
  ?st psv:P625 ?v .
  ?v wikibase:geoGlobe wd:Q111 ;
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

const FALLBACK_SITES = [
  ["Olympus Mons", 18.65, -133.8],
  ["Valles Marineris", -14.0, -59.2],
  ["Gale (crater)", -5.4, 137.8],
  ["Jezero (crater)", 18.38, 77.58],
  ["Viking 1", 22.48, -47.97, "United States", "Flag of the United States.svg"],
  ["Viking 2", 47.97, 134.29, "United States", "Flag of the United States.svg"],
  ["Curiosity (rover)", -4.59, 137.44, "United States", "Flag of the United States.svg"],
  ["Perseverance (rover)", 18.44, 77.45, "United States", "Flag of the United States.svg"],
];

const DOT_COLOR = Cesium.Color.fromCssColorString("#c1583c");
const SKY_DOT_COLOR = Cesium.Color.fromCssColorString("#c1583c");
const CATEGORY_ALL = "all";
const CATEGORY_DEFS = [
  { value: "missions", label: "Missions & landing sites" },
  { value: "craters", label: "Craters" },
  { value: "mountains", label: "Mountains & valleys" },
  { value: "regions", label: "Regions & plains" },
  { value: "other", label: "Other" },
];
const CATEGORY_LABELS = new Map(CATEGORY_DEFS.map((c) => [c.value, c.label]));

function flagFileName(url) {
  const file = url?.split("Special:FilePath/")[1];
  return file ? decodeURIComponent(file) : null;
}

// EllipsoidGeometry starts its texture seam on the body-fixed +X axis, which
// lands the map's central meridian (the near side) at longitude 180°. Spin
// the textured geometry half a turn so map longitude 0 sits on +X, where the
// IAU frame, the article markers, and pickMoon() all put selenographic 0°.
// Measured: without this, the lon-0 face renders far-side highlands.
const TEXTURE_SEAM_ROT = Cesium.Matrix4.fromRotationTranslation(
  Cesium.Matrix3.fromRotationZ(Math.PI), Cesium.Cartesian3.ZERO);

export class MarsLayer {
  constructor(viewer) {
    this.viewer = viewer;
    this.scene = viewer.scene;
    this.visible = true;
    this.focused = false;
    this.tracking = false;
    this.articles = [];
    this.source = "idle";
    this.articlesVisible = false;
    this.wikiEnabled = true;
    this.category = "missions";
    this._articlesRequested = false;
    this.onFocusChanged = null;
    this.savedMinZoom = null;
    this._transitioning = false;
    this._trueFocused = false;
    this.proxyModelMatrix = Cesium.Matrix4.clone(Cesium.Matrix4.IDENTITY);
    this.modelMatrix = Cesium.Matrix4.clone(Cesium.Matrix4.IDENTITY);

    this.points = this.scene.primitives.add(new Cesium.PointPrimitiveCollection());
    this.points.show = false;
    this.flags = this.scene.primitives.add(new Cesium.BillboardCollection());
    this.flags.show = false;
    this.skyPoints = this.scene.primitives.add(new Cesium.PointPrimitiveCollection());
    this.skyLabels = this.scene.primitives.add(new Cesium.LabelCollection());
    // { article, point, flag } for every currently-built marker: article
    // markers are kept in Mars-fixed local coordinates and re-projected to
    // absolute world position every tick (see _updateMarkerPositions), rather
    // than relying on the collections' modelMatrix for the huge Earth→Mars
    // translation — at real interplanetary distance (~1e11 m) that matrix
    // multiply loses enough float32 precision on the GPU to scatter 120km-alt
    // markers off-target, while the CPU-side double-precision math here does not.
    this._markerRefs = [];

    this._scratch = {
      icrf: new Cesium.Matrix3(),
      rot: new Cesium.Matrix3(),
      rx: new Cesium.Matrix3(),
      rz: new Cesium.Matrix3(),
      tmp: new Cesium.Matrix3(),
      pos: new Cesium.Cartesian3(),
      inv: new Cesium.Matrix4(),
      offset: new Cesium.Cartesian3(),
      center: new Cesium.Cartesian3(),
      prim: new Cesium.Matrix4(),
      proxyPos: new Cesium.Cartesian3(),
      proxyRot: new Cesium.Matrix3(),
      markerWorld: new Cesium.Cartesian3(),
    };
  }

  init() {
    const material = Cesium.Material.fromType("Image", { image: TEXTURE_URL });
    this.appearance = new Cesium.MaterialAppearance({
      material, translucent: false, closed: true,
    });
    this._updateTransform(this.viewer.clock.currentTime);
    this._createAppearances();

    this.primitive = this.scene.primitives.add(new Cesium.Primitive({
      geometryInstances: new Cesium.GeometryInstance({
        geometry: new Cesium.EllipsoidGeometry({
          radii: new Cesium.Cartesian3(MARS_RADIUS, MARS_RADIUS, MARS_RADIUS),
          stackPartitions: 64,
          slicePartitions: 128,
          vertexFormat: Cesium.MaterialAppearance.MaterialSupport.TEXTURED.vertexFormat,
        }),
        id: { kind: "body", body: "mars", layer: this },
      }),
      appearance: this.appearance,
      modelMatrix: Cesium.Matrix4.multiply(
        this.modelMatrix, TEXTURE_SEAM_ROT, new Cesium.Matrix4()),
      asynchronous: false,
      allowPicking: true,
      show: false,
    }));

    this.proxyPrimitive = this.scene.primitives.add(new Cesium.Primitive({
      geometryInstances: new Cesium.GeometryInstance({
        geometry: new Cesium.EllipsoidGeometry({
          radii: new Cesium.Cartesian3(
            TRANSITION_PROXY_RADIUS, TRANSITION_PROXY_RADIUS, TRANSITION_PROXY_RADIUS),
          stackPartitions: 64,
          slicePartitions: 128,
          vertexFormat: Cesium.MaterialAppearance.MaterialSupport.TEXTURED.vertexFormat,
        }),
      }),
      appearance: this.proxyAppearance,
      modelMatrix: this.proxyModelMatrix,
      asynchronous: false,
      allowPicking: false,
      show: false,
    }));

    this.skyPoint = this.skyPoints.add({
      position: this.position().clone(),
      pixelSize: 7,
      color: SKY_DOT_COLOR,
      outlineColor: Cesium.Color.WHITE.withAlpha(0.45),
      outlineWidth: 1,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
      id: { kind: "body", body: "mars", layer: this },
    });
    this.skyLabel = this.skyLabels.add({
      position: this.position().clone(),
      text: "Mars",
      font: "11px Segoe UI, sans-serif",
      fillColor: Cesium.Color.fromCssColorString("#dfe7f3").withAlpha(0.82),
      outlineColor: Cesium.Color.BLACK.withAlpha(0.65),
      outlineWidth: 2,
      style: Cesium.LabelStyle.FILL_AND_OUTLINE,
      horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
      verticalOrigin: Cesium.VerticalOrigin.CENTER,
      pixelOffset: new Cesium.Cartesian2(8, 0),
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
      id: { kind: "body", body: "mars", layer: this },
    });
  }

  _createAppearances() {
    const material = Cesium.Material.fromType("Image", { image: TEXTURE_URL });
    this.appearance = new Cesium.MaterialAppearance({
      material, translucent: false, closed: true,
    });
    this.proxyAppearance = new Cesium.MaterialAppearance({
      material: Cesium.Material.fromType("Image", { image: TEXTURE_URL }),
      translucent: false, closed: true,
    });
    this.flatAppearance = new Cesium.MaterialAppearance({
      material, translucent: false, closed: true, flat: true,
    });
  }

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

  tick() {
    if (!this.primitive) return;
    const time = this.viewer.clock.currentTime;
    const s = this._scratch;
    if (this.tracking) {
      // Capture the camera's offset in the old body frame before Mars' huge
      // Earth-fixed motion updates the transform, then reapply it below.
      Cesium.Cartesian3.clone(this.viewer.camera.position, s.offset);
    }

    this._updateTransform(time);
    this.primitive.modelMatrix = Cesium.Matrix4.multiply(
      this.modelMatrix, TEXTURE_SEAM_ROT, this._scratch.prim);
    this._updateMarkerPositions();
    this._updateProxyTransform();
    if (this.proxyPrimitive) this.proxyPrimitive.modelMatrix = this.proxyModelMatrix;

    const p = this.position();
    this.skyPoint.position = Cesium.Cartesian3.clone(p, this.skyPoint.position);
    this.skyLabel.position = Cesium.Cartesian3.clone(p, this.skyLabel.position);
    this.skyPoints.show = this.visible && !this.focused;
    this.skyLabels.show = this.visible && !this.focused;

    if (this.tracking) {
      this.viewer.camera.lookAtTransform(this.modelMatrix, s.offset);
    }
  }

  // Re-project every marker's Mars-fixed local position to absolute world
  // coordinates via this.modelMatrix, in JS double precision, instead of
  // handing the GPU the local position plus a huge modelMatrix to multiply.
  _updateMarkerPositions() {
    if (this._markerRefs.length === 0) return;
    const world = this._scratch.markerWorld;
    for (const ref of this._markerRefs) {
      Cesium.Matrix4.multiplyByPoint(this.modelMatrix, ref.article._bodyPos, world);
      ref.point.position = world;
      if (ref.flag) ref.flag.position = world;
    }
  }
  _updateTransform(time) {
    const s = this._scratch;
    const icrfToFixed =
      Cesium.Transforms.computeIcrfToFixedMatrix(time, s.icrf) ??
      Cesium.Transforms.computeTemeToPseudoFixedMatrix(time, s.icrf);
    const v = Astronomy.GeoVector(Astronomy.Body.Mars, Cesium.JulianDate.toDate(time), true);
    const pos = Cesium.Cartesian3.fromElements(v.x * AU, v.y * AU, v.z * AU, s.pos);

    const d = (Cesium.JulianDate.toDate(time).getTime() - Date.UTC(2000, 0, 1, 12)) / 86400000;
    const T = d / 36525;
    const ra = 317.68143 - 0.1061 * T;
    const dec = 52.88650 - 0.0609 * T;
    const w = 176.630 + 350.89198226 * d;

    const rz1 = Cesium.Matrix3.fromRotationZ(Cesium.Math.toRadians(ra + 90), s.rot);
    const rx = Cesium.Matrix3.fromRotationX(Cesium.Math.toRadians(90 - dec), s.rx);
    const rz2 = Cesium.Matrix3.fromRotationZ(Cesium.Math.toRadians(w), s.rz);
    Cesium.Matrix3.multiply(rz1, rx, s.tmp);
    Cesium.Matrix3.multiply(s.tmp, rz2, s.rot);

    Cesium.Matrix3.multiply(icrfToFixed, s.rot, s.rot);
    Cesium.Matrix3.multiplyByVector(icrfToFixed, pos, pos);
    Cesium.Matrix4.fromRotationTranslation(s.rot, pos, this.modelMatrix);
  }

  position() {
    return Cesium.Matrix4.getTranslation(this.modelMatrix, this._scratch.center);
  }

  distanceKm() {
    return Cesium.Cartesian3.magnitude(this.position()) / 1000;
  }

  _updateProxyTransform() {
    const s = this._scratch;
    const truePos = this.position();
    Cesium.Cartesian3.normalize(truePos, s.proxyPos);
    Cesium.Cartesian3.multiplyByScalar(s.proxyPos, TRANSITION_PROXY_DISTANCE, s.proxyPos);
    Cesium.Matrix4.getMatrix3(this.modelMatrix, s.proxyRot);
    Cesium.Matrix4.fromRotationTranslation(s.proxyRot, s.proxyPos, this.proxyModelMatrix);
  }

  _enterTrueFocus() {
    if (!this.focused) return;
    this._transitioning = false;
    if (this.proxyPrimitive) this.proxyPrimitive.show = false;
    if (this.primitive) this.primitive.show = this.visible;
    this._updateTransform(this.viewer.clock.currentTime);
    this.primitive.modelMatrix = this.modelMatrix;
    this._updateMarkerPositions();
    const offset = new Cesium.Cartesian3(0, -MARS_RADIUS * 4.4, MARS_RADIUS * 0.55);
    this.viewer.camera.lookAtTransform(this.modelMatrix, offset);
    this._trueFocused = true;
    this.tracking = true;
    this._syncArticles();
  }
  focus() {
    if (this.focused || !this.primitive) return;
    this.focused = true;
    this.tracking = false;
    this._transitioning = true;
    this._trueFocused = false;
    this.primitive.show = false;
    this.points.show = false;
    this.flags.show = false;
    this.skyPoints.show = false;
    this.skyLabels.show = false;
    this.onFocusChanged?.(true);

    const sscc = this.scene.screenSpaceCameraController;
    this.savedMinZoom = sscc.minimumZoomDistance;
    sscc.minimumZoomDistance = MARS_RADIUS + 50000;

    this._updateTransform(this.viewer.clock.currentTime);
    this._updateProxyTransform();
    this.proxyPrimitive.modelMatrix = this.proxyModelMatrix;
    this.proxyPrimitive.show = this.visible;

    const proxyCenter = Cesium.Matrix4.getTranslation(
      this.proxyModelMatrix, new Cesium.Cartesian3());
    this.viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
    this.viewer.camera.flyToBoundingSphere(
      new Cesium.BoundingSphere(proxyCenter, TRANSITION_PROXY_RADIUS * 1.15),
      {
        duration: TRANSITION_DURATION,
        complete: () => this._enterTrueFocus(),
        cancel: () => {
          if (this.focused && this._transitioning) this._enterTrueFocus();
        },
      }
    );
  }
  blur(opts = {}) {
    if (!this.focused) return;
    const flyHome = opts.flyHome !== false;
    this.focused = false;
    this.tracking = false;
    this._transitioning = false;
    this._trueFocused = false;
    this.viewer.camera.cancelFlight?.();
    if (this.proxyPrimitive) this.proxyPrimitive.show = false;
    if (this.primitive) this.primitive.show = false;
    this.points.show = false;
    this.flags.show = false;
    this.skyPoints.show = this.visible;
    this.skyLabels.show = this.visible;
    this.onFocusChanged?.(false);
    const sscc = this.scene.screenSpaceCameraController;
    if (this.savedMinZoom != null) sscc.minimumZoomDistance = this.savedMinZoom;
    this.viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
    if (flyHome) {
      this.viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(HOME_VIEW.lon, HOME_VIEW.lat, HOME_VIEW.height),
        duration: 2.4,
      });
    }
  }
  setVisible(v) {
    this.visible = v;
    this.skyPoints.show = v && !this.focused;
    this.skyLabels.show = v && !this.focused;
    if (this.primitive) this.primitive.show = v && this._trueFocused;
    if (this.proxyPrimitive) this.proxyPrimitive.show = v && this._transitioning;
    this._syncArticles();
    if (!v) this.blur();
  }

  pickMars(windowPosition) {
    if (!this.primitive) return null;
    const ray = this.viewer.camera.getPickRay(windowPosition);
    if (!ray) return null;
    const sphere = new Cesium.BoundingSphere(this.position(), MARS_RADIUS);
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
          if (lon > 180) lon -= 360;
          const country = b.countryName?.value ?? null;
          return {
            title: decodeURIComponent(slug).replace(/_/g, " "),
            lat: Number(b.lat.value),
            lon,
            url: articleUrl,
            bodyName: "Mars",
            extract: undefined,
            country,
            badge: country ?? undefined,
            flagUrl: null,
            _flagFile: flagFileName(b.flag?.value),
          };
        }).filter((a) => a.title && Number.isFinite(a.lat) && Number.isFinite(a.lon));
      }
    } catch (e) {
      console.warn("[mars] Wikidata article query failed:", e.message);
    }

    if (items && items.length > 0) {
      this.source = "live";
    } else {
      console.warn("[mars] using bundled fallback Mars sites");
      this.source = "data";
      items = FALLBACK_SITES.map(([title, lat, lon, country, flagFile]) => ({
        title, lat, lon,
        url: `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`,
        bodyName: "Mars",
        extract: undefined,
        country: country ?? null,
        badge: country ?? undefined,
        flagUrl: null,
        _flagFile: flagFile ?? null,
      }));
    }

    const seen = new Set();
    this.articles = items.filter((a) =>
      seen.has(a.title) ? false : (seen.add(a.title), true));
    for (const item of this.articles) {
      item.category = marsArticleCategory(item);
      item.categoryLabel = CATEGORY_LABELS.get(item.category) ?? "Other";
    }
    await this._resolveFlags(this.articles);
    this._buildMarkers();
  }

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
      console.warn("[mars] flag thumbnail resolution failed:", e.message);
    }
  }

  _buildMarkers() {
    this.points.removeAll();
    this.flags.removeAll();
    this._markerRefs = [];
    const rad = Cesium.Math.RADIANS_PER_DEGREE;
    const r = MARS_RADIUS + MARKER_ALT;
    const scale = new Cesium.NearFarScalar(5.0e6, 1.3, 7.5e8, 0.45);
    const world = new Cesium.Cartesian3();
    for (const a of this.filteredArticles()) {
      const clat = Math.cos(a.lat * rad);
      a._bodyPos = new Cesium.Cartesian3(
        r * clat * Math.cos(a.lon * rad),
        r * clat * Math.sin(a.lon * rad),
        r * Math.sin(a.lat * rad)
      );
      Cesium.Matrix4.multiplyByPoint(this.modelMatrix, a._bodyPos, world);
      const point = this.points.add({
        position: world,
        pixelSize: 5,
        color: DOT_COLOR,
        outlineColor: Cesium.Color.WHITE.withAlpha(0.6),
        outlineWidth: 1,
        scaleByDistance: scale,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        id: { kind: "marswiki", article: a },
      });
      let flag = null;
      if (a.flagUrl) {
        flag = this.flags.add({
          position: world,
          image: a.flagUrl,
          width: 21,
          height: 14,
          horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
          verticalOrigin: Cesium.VerticalOrigin.CENTER,
          pixelOffset: new Cesium.Cartesian2(8, 0),
          scaleByDistance: scale,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          id: { kind: "marswiki", article: a },
        });
      }
      this._markerRefs.push({ article: a, point, flag });
    }
    this.points.show = this.visible && this.articlesVisible && this.wikiEnabled;
    this.flags.show = this.points.show;
  }

  nearest(lat, lon, n) {
    const rad = Cesium.Math.RADIANS_PER_DEGREE;
    const la1 = lat * rad, lo1 = lon * rad;
    return this.filteredArticles()
      .map((a) => {
        const la2 = a.lat * rad, lo2 = a.lon * rad;
        const h = Math.sin((la2 - la1) / 2) ** 2 +
          Math.cos(la1) * Math.cos(la2) * Math.sin((lo2 - lo1) / 2) ** 2;
        const distKm = (2 * Math.asin(Math.sqrt(h)) * MARS_RADIUS) / 1000;
        return { a, distKm };
      })
      .sort((x, y) => x.distKm - y.distKm)
      .slice(0, n)
      .map(({ a, distKm }) => Object.assign(a, { distKm }));
  }

  async openArticlesAt(lat, lon, wikiPanel) {
    const items = this.nearest(lat, lon, 20);
    await this._ensureExtracts(items);
    wikiPanel.openBody("Mars", lat, lon, items);
  }

  async openArticle(article, wikiPanel) {
    const items = this.nearest(article.lat, article.lon, 20);
    const rest = items.filter((a) => a !== article);
    await this._ensureExtracts([article, ...rest]);
    wikiPanel.openBody("Mars", article.lat, article.lon, [article, ...rest]);
  }

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
      console.warn("[mars] extract fetch failed:", e.message);
      for (const a of missing) a.extract = "";
    }
  }

  counts() {
    return { source: this.source, count: this.filteredArticles().length };
  }
}

function marsArticleCategory(article) {
  const title = article.title.toLowerCase();
  if (
    article.country ||
    /\b(viking|pathfinder|sojourner|spirit|opportunity|curiosity|perseverance|insight|phoenix|beagle|schiaparelli|zhurong|tianwen|mars \d|lander|landing|rover|probe|spacecraft|mission)\b/.test(title)
  ) {
    return "missions";
  }
  if (/\bcrater\b/.test(title)) return "craters";
  if (/^(mons|montes|vallis|valles|chasma|chasmata|rupes|scopulus|scopuli|dorsum|dorsa|labes)\b/.test(title) || /\b(mountain|valley|canyon|scarp)\b/.test(title)) {
    return "mountains";
  }
  if (/^(planitia|planum|terra|regio|vastitas|mare|palus)\b/.test(title) || /\b(region|plain|plains|basin|quadrangle|polar cap)\b/.test(title)) {
    return "regions";
  }
  return "other";
}
