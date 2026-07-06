// Generic off-Earth body layer: textured live-position globe, focus tracking,
// Wikidata/Wikipedia surface markers, and optional sky-dot/proxy transition.

const SPARQL_URL = "https://query.wikidata.org/sparql";
const AU = 1.495978707e11;
const HOME_VIEW = { lon: 10, lat: 22, height: 2.3e7 };
const FLAG_RIGHT_OFFSET = new Cesium.Cartesian2(8, 0);
const FLAG_LEFT_OFFSET = new Cesium.Cartesian2(-8, 0);
const CATEGORY_ALL = "all";

// EllipsoidGeometry starts its texture seam on the body-fixed +X axis. Spin
// only the textured sphere half a turn so map longitude 0 sits on +X; markers
// and picking stay in the true body-fixed frame.
const TEXTURE_SEAM_ROT = Cesium.Matrix4.fromRotationTranslation(
  Cesium.Matrix3.fromRotationZ(Math.PI), Cesium.Cartesian3.ZERO);

export class BodyLayer {
  constructor(viewer, config) {
    this.viewer = viewer;
    this.scene = viewer.scene;
    this.config = config;
    this.key = config.key;
    this.name = config.name;
    this.radius = config.radius;
    this.visible = true;
    this.focused = false;
    this.tracking = false;
    this.articles = [];
    this.source = "idle";
    this.articlesVisible = false;
    this.wikiEnabled = config.wikiEnabled !== false;
    this.category = config.defaultCategory ?? CATEGORY_ALL;
    this._categoryLabels = new Map((config.categoryDefs ?? []).map((c) => [c.value, c.label]));
    this._articlesRequested = false;
    this.onFocusChanged = null;
    this.savedMinZoom = null;
    this.savedMaxZoom = null;
    this._transitioning = false;
    this._trueFocused = false;
    this.proxyModelMatrix = Cesium.Matrix4.clone(Cesium.Matrix4.IDENTITY);
    this.modelMatrix = Cesium.Matrix4.clone(Cesium.Matrix4.IDENTITY);

    if (config.hideCesiumMoon && this.scene.moon) this.scene.moon.show = false;

    this.points = this.scene.primitives.add(new Cesium.PointPrimitiveCollection());
    this.points.show = false;
    this.flags = this.scene.primitives.add(new Cesium.BillboardCollection());
    this.flags.show = false;
    this._markerRefs = [];

    if (config.skyDot) {
      this.skyPoints = this.scene.primitives.add(new Cesium.PointPrimitiveCollection());
      this.skyLabels = this.scene.primitives.add(new Cesium.LabelCollection());
    }

    this.axes = config.orientation?.type === "moon" &&
      typeof Cesium.IauOrientationAxes === "function"
      ? new Cesium.IauOrientationAxes()
      : null;

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
      cameraLocal: new Cesium.Cartesian3(),
      bodyWindow: new Cesium.Cartesian2(),
      markerWindow: new Cesium.Cartesian2(),
    };
  }

  init() {
    this._createAppearances();
    this._updateTransform(this.viewer.clock.currentTime);

    this.primitive = this.scene.primitives.add(new Cesium.Primitive({
      geometryInstances: new Cesium.GeometryInstance({
        geometry: new Cesium.EllipsoidGeometry({
          radii: new Cesium.Cartesian3(this.radius, this.radius, this.radius),
          stackPartitions: 64,
          slicePartitions: 128,
          vertexFormat: Cesium.MaterialAppearance.MaterialSupport.TEXTURED.vertexFormat,
        }),
        id: this.config.bodyPickId(this),
      }),
      appearance: this.appearance,
      modelMatrix: Cesium.Matrix4.multiply(
        this.modelMatrix, TEXTURE_SEAM_ROT, new Cesium.Matrix4()),
      asynchronous: false,
      allowPicking: true,
      show: this.config.showBodyWhenUnfocused !== false,
    }));

    if (this.config.transition?.proxy) {
      const proxyRadius = this.config.transition.proxyRadius ?? this.radius;
      this.proxyPrimitive = this.scene.primitives.add(new Cesium.Primitive({
        geometryInstances: new Cesium.GeometryInstance({
          geometry: new Cesium.EllipsoidGeometry({
            radii: new Cesium.Cartesian3(proxyRadius, proxyRadius, proxyRadius),
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
    }

    if (this.config.skyDot) this._initSkyDot();
  }

  _createAppearances() {
    const material = Cesium.Material.fromType("Image", { image: this.config.textureUrl });
    this.appearance = new Cesium.MaterialAppearance({
      material,
      translucent: false,
      closed: true,
    });
    this.proxyAppearance = new Cesium.MaterialAppearance({
      material: Cesium.Material.fromType("Image", { image: this.config.textureUrl }),
      translucent: false,
      closed: true,
    });
    this.flatAppearance = new Cesium.MaterialAppearance({
      material,
      translucent: false,
      closed: true,
      flat: true,
    });
  }

  _initSkyDot() {
    const p = this.position().clone();
    const cfg = this.config.skyDot;
    this.skyPoint = this.skyPoints.add({
      position: p,
      pixelSize: cfg.pixelSize ?? 7,
      color: Cesium.Color.fromCssColorString(cfg.color),
      outlineColor: Cesium.Color.WHITE.withAlpha(0.45),
      outlineWidth: 1,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
      id: this.config.bodyPickId(this),
    });
    this.skyLabel = this.skyLabels.add({
      position: p.clone(),
      text: this.name,
      font: "11px Segoe UI, sans-serif",
      fillColor: Cesium.Color.fromCssColorString("#dfe7f3").withAlpha(0.82),
      outlineColor: Cesium.Color.BLACK.withAlpha(0.65),
      outlineWidth: 2,
      style: Cesium.LabelStyle.FILL_AND_OUTLINE,
      horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
      verticalOrigin: Cesium.VerticalOrigin.CENTER,
      pixelOffset: new Cesium.Cartesian2(8, 0),
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
      id: this.config.bodyPickId(this),
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
    this.category = this._categoryLabels.has(category) ? category : CATEGORY_ALL;
    this._buildMarkers();
  }

  filteredArticles() {
    if (this.category === CATEGORY_ALL) return this.articles;
    return this.articles.filter((a) => a.category === this.category);
  }

  _syncArticles() {
    const want = this.articlesVisible && this.wikiEnabled;
    if (want) this._requestArticles();
    const inProxyFocus = this.config.transition?.proxy && this.focused && !this._trueFocused;
    const show = this.visible && want && !inProxyFocus;
    this.points.show = show;
    this.flags.show = show;
  }

  _requestArticles() {
    if (this._articlesRequested) return;
    this._articlesRequested = true;
    this.source = "loading";
    this._loadArticles();
  }

  tick() {
    if (!this.primitive) return;
    const time = this.viewer.clock.currentTime;
    const s = this._scratch;
    if (this.tracking) {
      Cesium.Cartesian3.clone(this.viewer.camera.position, s.offset);
    }

    this._updateTransform(time);
    this.primitive.modelMatrix = Cesium.Matrix4.multiply(
      this.modelMatrix, TEXTURE_SEAM_ROT, s.prim);

    if (this.config.cpuProjectMarkers) {
      this._updateMarkerPositions();
    } else {
      this.points.modelMatrix = this.modelMatrix;
      this.flags.modelMatrix = this.modelMatrix;
      this._updateFlagPositions();
    }

    if (this.proxyPrimitive) {
      this._updateProxyTransform();
      this.proxyPrimitive.modelMatrix = this.proxyModelMatrix;
    }

    if (this.skyPoint) {
      const p = this.position();
      this.skyPoint.position = Cesium.Cartesian3.clone(p, this.skyPoint.position);
      this.skyLabel.position = Cesium.Cartesian3.clone(p, this.skyLabel.position);
      this.skyPoints.show = this.visible && !this.focused;
      this.skyLabels.show = this.visible && !this.focused;
    }

    if (this.tracking) {
      this.viewer.camera.lookAtTransform(this.modelMatrix, s.offset);
    }
  }

  _updateTransform(time) {
    const s = this._scratch;
    const icrfToFixed =
      Cesium.Transforms.computeIcrfToFixedMatrix(time, s.icrf) ??
      Cesium.Transforms.computeTemeToPseudoFixedMatrix(time, s.icrf);
    const pos = this._positionIcrf(time, s.pos);
    const rot = this._rotationIcrf(time, pos, s.rot);

    Cesium.Matrix3.multiply(icrfToFixed, rot, rot);
    Cesium.Matrix3.multiplyByVector(icrfToFixed, pos, pos);
    Cesium.Matrix4.fromRotationTranslation(rot, pos, this.modelMatrix);
  }

  _positionIcrf(time, result) {
    const ephem = this.config.ephemeris;
    if (ephem.type === "moon") {
      return Cesium.Simon1994PlanetaryPositions
        .computeMoonPositionInEarthInertialFrame(time, result);
    }
    if (ephem.type === "astronomy-engine") {
      const v = Astronomy.GeoVector(
        Astronomy.Body[ephem.body],
        Cesium.JulianDate.toDate(time),
        true
      );
      return Cesium.Cartesian3.fromElements(v.x * AU, v.y * AU, v.z * AU, result);
    }
    throw new Error(`Unknown ephemeris type: ${ephem.type}`);
  }

  _rotationIcrf(time, posIcrf, result) {
    const orientation = this.config.orientation;
    if (orientation.type === "moon") {
      if (this.axes) {
        const rot = this.axes.evaluate(time, result);
        return Cesium.Matrix3.transpose(rot, rot);
      }
      return this._tidalLockRotation(posIcrf, result);
    }
    if (orientation.type === "iau") {
      return this._iauRotation(time, orientation, result);
    }
    if (orientation.type === "iau-neptune") {
      return this._neptuneRotation(time, orientation, result);
    }
    throw new Error(`Unknown orientation type: ${orientation.type}`);
  }

  _tidalLockRotation(moonPosIcrf, result) {
    const eclipticNorth = new Cesium.Cartesian3(0, -0.3977772, 0.9174821);
    const x = Cesium.Cartesian3.negate(moonPosIcrf, new Cesium.Cartesian3());
    Cesium.Cartesian3.normalize(x, x);
    const y = Cesium.Cartesian3.cross(eclipticNorth, x, new Cesium.Cartesian3());
    Cesium.Cartesian3.normalize(y, y);
    const z = Cesium.Cartesian3.cross(x, y, new Cesium.Cartesian3());
    return Cesium.Matrix3.setColumn(
      Cesium.Matrix3.setColumn(
        Cesium.Matrix3.setColumn(result, 0, x, result), 1, y, result), 2, z, result);
  }

  _iauRotation(time, orientation, result) {
    const { d, T } = j2000DaysAndCenturies(time);
    const ra = linearTerm(orientation.ra, d, T);
    const dec = linearTerm(orientation.dec, d, T);
    const w = linearTerm(orientation.w, d, T);
    return this._rotationFromAngles(ra, dec, w, result);
  }

  _neptuneRotation(time, orientation, result) {
    const { d, T } = j2000DaysAndCenturies(time);
    const n = Cesium.Math.toRadians(linearTerm(orientation.n, d, T));
    const ra = linearTerm(orientation.ra, d, T) + (orientation.raSin ?? 0) * Math.sin(n);
    const dec = linearTerm(orientation.dec, d, T) + (orientation.decCos ?? 0) * Math.cos(n);
    const w = linearTerm(orientation.w, d, T) + (orientation.wSin ?? 0) * Math.sin(n);
    return this._rotationFromAngles(ra, dec, w, result);
  }

  _rotationFromAngles(ra, dec, w, result) {
    const s = this._scratch;
    const rz1 = Cesium.Matrix3.fromRotationZ(Cesium.Math.toRadians(ra + 90), result);
    const rx = Cesium.Matrix3.fromRotationX(Cesium.Math.toRadians(90 - dec), s.rx);
    const rz2 = Cesium.Matrix3.fromRotationZ(Cesium.Math.toRadians(w), s.rz);
    Cesium.Matrix3.multiply(rz1, rx, s.tmp);
    return Cesium.Matrix3.multiply(s.tmp, rz2, result);
  }

  _updateMarkerPositions() {
    const world = this._scratch.markerWorld;
    const cameraLocal = this._scratch.cameraLocal;
    Cesium.Matrix4.inverseTransformation(this.modelMatrix, this._scratch.inv);
    Cesium.Matrix4.multiplyByPoint(this._scratch.inv, this.viewer.camera.positionWC, cameraLocal);
    const centerWindow = Cesium.SceneTransforms.wgs84ToWindowCoordinates(
      this.scene, this.position(), this._scratch.bodyWindow);
    for (const ref of this._markerRefs) {
      Cesium.Matrix4.multiplyByPoint(this.modelMatrix, ref.article._bodyPos, world);
      ref.point.position = world;
      const isNearSide =
        Cesium.Cartesian3.dot(ref.article._bodyPos, cameraLocal) >= this.radius * this.radius;
      ref.point.show = isNearSide;
      if (ref.flag) {
        ref.flag.position = world;
        ref.flag.show = isNearSide;
        const markerWindow = centerWindow
          ? Cesium.SceneTransforms.wgs84ToWindowCoordinates(
              this.scene, world, this._scratch.markerWindow)
          : null;
        this._syncFlagSide(ref, centerWindow, markerWindow);
      }
    }
  }

  _updateFlagPositions() {
    const s = this._scratch;
    const centerWindow = Cesium.SceneTransforms.wgs84ToWindowCoordinates(
      this.scene, this.position(), s.bodyWindow);
    for (const ref of this._markerRefs) {
      if (!ref.flag) continue;
      Cesium.Matrix4.multiplyByPoint(this.modelMatrix, ref.article._bodyPos, s.markerWorld);
      const markerWindow = centerWindow
        ? Cesium.SceneTransforms.wgs84ToWindowCoordinates(
            this.scene, s.markerWorld, s.markerWindow)
        : null;
      this._syncFlagSide(ref, centerWindow, markerWindow);
    }
  }

  _syncFlagSide(ref, centerWindow, markerWindow) {
    const side = markerWindow && centerWindow && markerWindow.x < centerWindow.x
      ? "left"
      : "right";
    if (ref.flagSide === side) return;
    ref.flag.horizontalOrigin = side === "left"
      ? Cesium.HorizontalOrigin.RIGHT
      : Cesium.HorizontalOrigin.LEFT;
    ref.flag.pixelOffset = side === "left" ? FLAG_LEFT_OFFSET : FLAG_RIGHT_OFFSET;
    ref.flagSide = side;
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
    Cesium.Cartesian3.multiplyByScalar(
      s.proxyPos,
      this.config.transition.proxyDistance,
      s.proxyPos
    );
    Cesium.Matrix4.getMatrix3(this.modelMatrix, s.proxyRot);
    Cesium.Matrix4.fromRotationTranslation(s.proxyRot, s.proxyPos, this.proxyModelMatrix);
  }

  focus() {
    if (this.focused || !this.primitive) return;
    if (this.config.transition?.proxy) {
      this._focusViaProxy();
      return;
    }
    this._focusDirect();
  }

  _focusDirect() {
    this.focused = true;
    this.onFocusChanged?.(true);
    this.setArticlesVisible(true);
    const camera = this.viewer.camera;
    camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
    const sscc = this.scene.screenSpaceCameraController;
    this.savedMinZoom = sscc.minimumZoomDistance;
    this.savedMaxZoom = sscc.maximumZoomDistance;
    sscc.maximumZoomDistance = Math.max(sscc.maximumZoomDistance, this.radius * 40);
    camera.flyToBoundingSphere(
      new Cesium.BoundingSphere(this.position().clone(), this.radius * 2.0),
      {
        duration: this.config.focusDuration ?? 3.0,
        complete: () => {
          if (!this.focused) return;
          this.scene.screenSpaceCameraController.minimumZoomDistance =
            this.radius + (this.config.minZoomMargin ?? 30000);
          const s = this._scratch;
          Cesium.Matrix4.inverseTransformation(this.modelMatrix, s.inv);
          Cesium.Matrix4.multiplyByPoint(s.inv, camera.positionWC, s.offset);
          camera.lookAtTransform(this.modelMatrix, s.offset);
          this.tracking = true;
        },
      }
    );
  }

  _focusViaProxy() {
    this.focused = true;
    this.tracking = false;
    this._transitioning = true;
    this._trueFocused = false;
    this.primitive.show = false;
    this.points.show = false;
    this.flags.show = false;
    if (this.skyPoints) this.skyPoints.show = false;
    if (this.skyLabels) this.skyLabels.show = false;
    this.onFocusChanged?.(true);

    const sscc = this.scene.screenSpaceCameraController;
    this.savedMinZoom = sscc.minimumZoomDistance;
    this.savedMaxZoom = sscc.maximumZoomDistance;
    sscc.minimumZoomDistance = this.radius + (this.config.minZoomMargin ?? 50000);
    sscc.maximumZoomDistance = Math.max(sscc.maximumZoomDistance, this.radius * 40);

    this._updateTransform(this.viewer.clock.currentTime);
    this._updateProxyTransform();
    this.proxyPrimitive.modelMatrix = this.proxyModelMatrix;
    this.proxyPrimitive.show = this.visible;

    const proxyCenter = Cesium.Matrix4.getTranslation(
      this.proxyModelMatrix, new Cesium.Cartesian3());
    this.viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
    this.viewer.camera.flyToBoundingSphere(
      new Cesium.BoundingSphere(
        proxyCenter,
        (this.config.transition.proxyRadius ?? this.radius) * 1.15
      ),
      {
        duration: this.config.transition.duration ?? 2.4,
        complete: () => this._enterTrueFocus(),
        cancel: () => {
          if (this.focused && this._transitioning) this._enterTrueFocus();
        },
      }
    );
  }

  _enterTrueFocus() {
    if (!this.focused) return;
    this._transitioning = false;
    if (this.proxyPrimitive) this.proxyPrimitive.show = false;
    if (this.primitive) this.primitive.show = this.visible;
    this._updateTransform(this.viewer.clock.currentTime);
    this.primitive.modelMatrix = Cesium.Matrix4.multiply(
      this.modelMatrix, TEXTURE_SEAM_ROT, this._scratch.prim);
    if (this.config.cpuProjectMarkers) this._updateMarkerPositions();
    const offset = this.config.focusOffset
      ? this.config.focusOffset(this.radius)
      : new Cesium.Cartesian3(0, -this.radius * 4.4, this.radius * 0.55);
    this.viewer.camera.lookAtTransform(this.modelMatrix, offset);
    this._trueFocused = true;
    this.tracking = true;
    this.setArticlesVisible(true);
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
    if (this.primitive) {
      this.primitive.show = this.visible && this.config.showBodyWhenUnfocused !== false;
    }
    this.points.show = false;
    this.flags.show = false;
    if (this.skyPoints) this.skyPoints.show = this.visible;
    if (this.skyLabels) this.skyLabels.show = this.visible;
    this.onFocusChanged?.(false);
    const sscc = this.scene.screenSpaceCameraController;
    if (this.savedMinZoom != null) sscc.minimumZoomDistance = this.savedMinZoom;
    if (this.savedMaxZoom != null) sscc.maximumZoomDistance = this.savedMaxZoom;
    this.savedMinZoom = null;
    this.savedMaxZoom = null;
    this.viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
    if (flyHome) {
      const home = this.config.homeView ?? HOME_VIEW;
      this.viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(home.lon, home.lat, home.height),
        duration: this.config.blurDuration ?? 3.0,
      });
    }
  }

  setVisible(v) {
    this.visible = v;
    if (this.primitive) {
      this.primitive.show = v && (
        this.config.showBodyWhenUnfocused !== false || this._trueFocused || !this.config.transition
      );
    }
    if (this.proxyPrimitive) this.proxyPrimitive.show = v && this._transitioning;
    if (this.skyPoints) this.skyPoints.show = v && !this.focused;
    if (this.skyLabels) this.skyLabels.show = v && !this.focused;
    this._syncArticles();
    if (!v) this.blur();
  }

  pickSurface(windowPosition) {
    if (!this.primitive) return null;
    const ray = this.viewer.camera.getPickRay(windowPosition);
    if (!ray) return null;
    const sphere = new Cesium.BoundingSphere(this.position(), this.radius);
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
      const url = `${SPARQL_URL}?format=json&query=${encodeURIComponent(this._sparqlQuery())}`;
      const res = await fetch(url, {
        signal: ctl.signal,
        headers: { Accept: "application/sparql-results+json" },
      });
      clearTimeout(t);
      if (res.ok) {
        const rows = (await res.json())?.results?.bindings ?? [];
        items = rows.map((b) => this._articleFromBinding(b))
          .filter((a) => a.title && Number.isFinite(a.lat) && Number.isFinite(a.lon));
      }
    } catch (e) {
      console.warn(`[${this.key}] Wikidata article query failed:`, e.message);
    }

    if (items && items.length > (this.config.liveMinItems ?? 0)) {
      this.source = "live";
    } else {
      console.warn(`[${this.key}] using bundled fallback sites`);
      this.source = "data";
      items = this.config.fallbackSites.map(([title, lat, lon, country, flagFile]) => ({
        title,
        lat,
        lon,
        url: wikiArticleUrl(title),
        ...(this.config.articleProps ?? {}),
        extract: undefined,
        country: country ?? null,
        badge: country ?? undefined,
        flagUrl: null,
        _flagFile: flagFile ?? null,
      }));
    }

    await this._applyMissionSupplements(items);

    const seen = new Set();
    this.articles = items.filter((a) =>
      seen.has(a.title) ? false : (seen.add(a.title), true));
    for (const item of this.articles) {
      item.category = this.config.categoryFor(item);
      item.categoryLabel = this._categoryLabels.get(item.category) ?? "Other";
    }
    await this._resolveFlags(this.articles);
    this._buildMarkers();
  }

  _sparqlQuery() {
    return `
SELECT ?lat ?lon ?links ?article ?countryName ?flag WHERE {
  ?item p:P625 ?st .
  ?st psv:P625 ?v .
  ?v wikibase:geoGlobe wd:${this.config.wikidataGlobe} ;
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
LIMIT ${(this.config.maxArticles ?? 400) + 20}`;
  }

  _articleFromBinding(b) {
    const articleUrl = b.article.value;
    const slug = articleUrl.split("/wiki/")[1] ?? "";
    let lon = Number(b.lon.value);
    lon = this.config.normalizeLon ? this.config.normalizeLon(lon) : normalizeLon(lon);
    const country = b.countryName?.value ?? null;
    return {
      title: decodeURIComponent(slug).replace(/_/g, " "),
      lat: Number(b.lat.value),
      lon,
      url: articleUrl,
      ...(this.config.articleProps ?? {}),
      extract: undefined,
      country,
      badge: country ?? undefined,
      flagUrl: null,
      _flagFile: flagFileName(b.flag?.value),
    };
  }

  async _applyMissionSupplements(items) {
    if (!this.config.missionSupplementUrl) return;
    let data = null;
    try {
      const res = await fetch(this.config.missionSupplementUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      data = await res.json();
    } catch (e) {
      console.warn(`[${this.key}] mission supplement failed:`, e.message);
      return;
    }

    if (data?.schemaVersion !== 1 || !Array.isArray(data.missions)) return;
    const byTitle = new Map(items.map((a) => [titleKey(a.title), a]));

    for (const m of data.missions) {
      const title = cleanString(m.title);
      if (!title) continue;

      const existing = byTitle.get(titleKey(title));
      const site = m.siteTitle ? byTitle.get(titleKey(m.siteTitle)) : null;
      const lat = Number.isFinite(Number(m.lat)) ? Number(m.lat) : site?.lat;
      const lonRaw = Number.isFinite(Number(m.lon)) ? Number(m.lon) : site?.lon;
      const lon = this.config.normalizeLon ? this.config.normalizeLon(lonRaw) : normalizeLon(lonRaw);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

      const country = cleanString(m.country) ?? existing?.country ?? site?.country ?? null;
      const flagFile = cleanString(m.flagFile) ?? existing?._flagFile ?? site?._flagFile ?? null;
      const missionKind = cleanString(m.kind);

      if (existing) {
        if (this.config.overwriteSupplementCoords) {
          existing.lat = lat;
          existing.lon = lon;
        } else {
          if (!Number.isFinite(existing.lat)) existing.lat = lat;
          if (!Number.isFinite(existing.lon)) existing.lon = lon;
        }
        existing.country = country;
        existing.badge = country ?? existing.badge;
        existing._flagFile = flagFile;
        existing.missionSupplement = true;
        existing.missionKind = missionKind;
        existing.siteTitle = cleanString(m.siteTitle) ?? existing.siteTitle;
        continue;
      }

      const item = {
        title,
        lat,
        lon,
        url: cleanString(m.url) ?? wikiArticleUrl(title),
        ...(this.config.articleProps ?? {}),
        extract: undefined,
        country,
        badge: country ?? undefined,
        flagUrl: null,
        _flagFile: flagFile,
        missionSupplement: true,
        missionKind,
        siteTitle: cleanString(m.siteTitle),
      };
      items.push(item);
      byTitle.set(titleKey(title), item);
    }
  }

  async _resolveFlags(items) {
    const files = [...new Set(items.map((a) => a._flagFile).filter(Boolean))].slice(0, 50);
    if (files.length === 0) return;
    try {
      const url = new URL("https://commons.wikimedia.org/w/api.php");
      url.search = new URLSearchParams({
        action: "query",
        titles: files.map((f) => `File:${f}`).join("|"),
        prop: "imageinfo",
        iiprop: "url",
        iiurlwidth: "48",
        format: "json",
        origin: "*",
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
      console.warn(`[${this.key}] flag thumbnail resolution failed:`, e.message);
    }
  }

  _buildMarkers() {
    this.points.removeAll();
    this.flags.removeAll();
    this._markerRefs = [];
    const rad = Cesium.Math.RADIANS_PER_DEGREE;
    const r = this.radius + (this.config.markerAlt ?? 15000);
    const scale = this.config.markerScale ??
      new Cesium.NearFarScalar(this.radius * 1.7, 1.3, this.radius * 250, 0.45);
    const world = new Cesium.Cartesian3();
    const dotColor = Cesium.Color.fromCssColorString(this.config.markerColor);
    for (const a of this.filteredArticles()) {
      const clat = Math.cos(a.lat * rad);
      a._bodyPos = new Cesium.Cartesian3(
        r * clat * Math.cos(a.lon * rad),
        r * clat * Math.sin(a.lon * rad),
        r * Math.sin(a.lat * rad)
      );
      const position = this.config.cpuProjectMarkers
        ? Cesium.Matrix4.multiplyByPoint(this.modelMatrix, a._bodyPos, world)
        : a._bodyPos;
      const point = this.points.add({
        position,
        pixelSize: 5,
        color: dotColor,
        outlineColor: Cesium.Color.WHITE.withAlpha(0.6),
        outlineWidth: 1,
        scaleByDistance: scale,
        disableDepthTestDistance: this.config.cpuProjectMarkers
          ? Number.POSITIVE_INFINITY
          : undefined,
        id: { kind: this.config.articleKind, article: a },
      });
      let flag = null;
      if (a.flagUrl) {
        flag = this.flags.add({
          position,
          image: a.flagUrl,
          width: 21,
          height: 14,
          horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
          verticalOrigin: Cesium.VerticalOrigin.CENTER,
          pixelOffset: FLAG_RIGHT_OFFSET,
          scaleByDistance: scale,
          disableDepthTestDistance: this.config.cpuProjectMarkers
            ? Number.POSITIVE_INFINITY
            : undefined,
          id: { kind: this.config.articleKind, article: a },
        });
      }
      this._markerRefs.push({ article: a, point, flag, flagSide: "right" });
    }
    const show = this.visible && this.articlesVisible && this.wikiEnabled;
    this.points.show = show;
    this.flags.show = show;
    if (!this.config.cpuProjectMarkers) {
      this.points.modelMatrix = this.modelMatrix;
      this.flags.modelMatrix = this.modelMatrix;
      this._updateFlagPositions();
    }
  }

  nearest(lat, lon, n) {
    const rad = Cesium.Math.RADIANS_PER_DEGREE;
    const la1 = lat * rad;
    const lo1 = lon * rad;
    return this.filteredArticles()
      .map((a) => {
        const la2 = a.lat * rad;
        const lo2 = a.lon * rad;
        const h = Math.sin((la2 - la1) / 2) ** 2 +
          Math.cos(la1) * Math.cos(la2) * Math.sin((lo2 - lo1) / 2) ** 2;
        const distKm = (2 * Math.asin(Math.sqrt(h)) * this.radius) / 1000;
        return { a, distKm };
      })
      .sort((x, y) => x.distKm - y.distKm)
      .slice(0, n)
      .map(({ a, distKm }) => Object.assign(a, { distKm }));
  }

  async openArticlesAt(lat, lon, wikiPanel) {
    const items = this.nearest(lat, lon, 20);
    await this._ensureExtracts(items);
    wikiPanel.openBody(this.name, lat, lon, items);
  }

  async openArticle(article, wikiPanel) {
    const items = this.nearest(article.lat, article.lon, 20);
    const rest = items.filter((a) => a !== article);
    await this._ensureExtracts([article, ...rest]);
    wikiPanel.openBody(this.name, article.lat, article.lon, [article, ...rest]);
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
        exintro: "1",
        explaintext: "1",
        exchars: "240",
        exlimit: String(missing.length),
        inprop: "url",
        redirects: "1",
        format: "json",
        origin: "*",
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
      console.warn(`[${this.key}] extract fetch failed:`, e.message);
      for (const a of missing) a.extract = "";
    }
  }

  counts() {
    return { source: this.source, count: this.filteredArticles().length };
  }
}

function linearTerm(term, d, T) {
  if (typeof term === "number") return term;
  const [base, rate = 0, variable = "T"] = term;
  return base + rate * (variable === "d" ? d : T);
}

function j2000DaysAndCenturies(time) {
  const date = Cesium.JulianDate.toDate(time);
  const d = (date.getTime() - Date.UTC(2000, 0, 1, 12)) / 86400000;
  return { d, T: d / 36525 };
}

function flagFileName(url) {
  const file = url?.split("Special:FilePath/")[1];
  return file ? decodeURIComponent(file) : null;
}

export function titleKey(title) {
  return String(title ?? "")
    .normalize("NFKC")
    .replace(/[_\s]+/g, " ")
    .trim()
    .toLowerCase();
}

export function cleanString(value) {
  const s = String(value ?? "").trim();
  return s || null;
}

export function normalizeLon(lon) {
  if (!Number.isFinite(lon)) return NaN;
  return lon > 180 ? lon - 360 : lon;
}

function wikiArticleUrl(title) {
  return `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`;
}
