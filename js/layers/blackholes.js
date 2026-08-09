// Black holes layer: the §6.4 simulator objects as clickable sky dots
// (black-hole-simulator-spec.md §6.5, milestone 11).
//
// These are deliberately NOT in `js/bodies.js`. Every loop in that module
// assumes a body has an ephemeris, a Wikidata `geoGlobe` QID and an IAU
// orientation model, and a black hole 26,000 light-years away has none of the
// three. What it has is a fixed direction on the celestial sphere, which is
// all a sky dot ever needed.
//
// Two consequences of "direction only" drive the whole file:
//
//   1. **Nothing is placed at a true position.** The nearest object here is
//      about 1,000 parsecs away; Cesium's far plane is 1e13 m, which is under
//      a thousandth of a light-year. Every dot is therefore drawn at a fixed
//      distance *from the camera* along its real direction, which is exactly
//      how an object at infinity behaves: no parallax, ever. The label states
//      the real distance in light-years so the difference from a planet dot is
//      obvious.
//   2. **The layer is universal.** Because the placement is camera-relative
//      and the direction is the same anywhere in the solar system, the dots are
//      correct whether the camera is at Earth or at Neptune — the sky is the
//      sky. The sidebar row has no `data-scope` for the same reason.
//
// Data is the generated copy of the simulator fork's canonical list; see
// `scripts/data/generate-black-holes.mjs`. That makes it bundled data, not a
// live feed, so the badge is `DATA` and never `LIVE`.

const DATA_URL = "data/black-holes.json";

// How far from the camera the dots are drawn, in metres. Well inside the
// scene's 1e13 m far plane (set in app.js for Neptune) and far outside any
// real geometry, so nothing can ever occlude a dot by being "in front" of it.
const SKY_DISTANCE_M = 1e12;

export class BlackHolesLayer {
  constructor(viewer) {
    this.viewer = viewer;
    this.scene = viewer.scene;
    this.points = viewer.scene.primitives.add(
      new Cesium.PointPrimitiveCollection()
    );
    this.labels = viewer.scene.primitives.add(new Cesium.LabelCollection());
    this.points.show = false;
    this.labels.show = false;
    this.objects = [];
    this.visible = false;
    this.source = "idle";
    this.error = null;
    this._entries = [];
    this._scratch = {
      icrf: new Cesium.Matrix3(),
      dir: new Cesium.Cartesian3(),
      pos: new Cesium.Cartesian3(),
    };
  }

  async init() {
    await this._load();
  }

  async _load() {
    this.source = "loading";
    this.error = null;
    try {
      const res = await fetch(DATA_URL);
      if (!res.ok) throw new Error(`black-holes.json ${res.status}`);
      const data = await res.json();
      const objs = data?.objects;
      if (!Array.isArray(objs) || objs.length === 0) {
        throw new Error("no objects in black-holes.json");
      }
      this.objects = objs;
      this._build();
      this.source = "data";
    } catch (e) {
      console.warn("[blackholes] load failed:", e.message);
      this.error = e.message;
      this.source = "idle";
      this.objects = [];
      this._entries = [];
      this.points.removeAll();
      this.labels.removeAll();
    }
  }

  _build() {
    this.points.removeAll();
    this.labels.removeAll();
    this._entries = [];

    for (const o of this.objects) {
      const dirIcrf = raDecToUnitVector(o.raDeg, o.decDeg);
      const id = { kind: "blackhole", bh: o };

      // Supermassive objects get a slightly larger dot. This is a legibility
      // choice, not a physical one — at these distances every one of them is a
      // point source, and scaling by anything real would make the whole set
      // invisible.
      const pixelSize = o.kind === "supermassive" ? 8 : 6;

      const point = this.points.add({
        position: Cesium.Cartesian3.ZERO,
        pixelSize,
        // Warm orange: reads as "not a planet" against the blue-white body
        // dots, and matches the accretion-disk palette of the simulator the
        // dot links to.
        color: Cesium.Color.fromCssColorString("#ffb066"),
        outlineColor: Cesium.Color.BLACK.withAlpha(0.65),
        outlineWidth: 1,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        id,
      });

      const label = this.labels.add({
        position: Cesium.Cartesian3.ZERO,
        text: o.shortName,
        font: "11px Segoe UI, sans-serif",
        fillColor: Cesium.Color.fromCssColorString("#ffd9b3").withAlpha(0.85),
        outlineColor: Cesium.Color.BLACK.withAlpha(0.7),
        outlineWidth: 2,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
        verticalOrigin: Cesium.VerticalOrigin.CENTER,
        pixelOffset: new Cesium.Cartesian2(8, 0),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        id,
      });

      this._entries.push({ object: o, dirIcrf, point, label });
    }
  }

  setVisible(v) {
    this.visible = !!v;
    this.points.show = this.visible;
    this.labels.show = this.visible;
    if (this.visible) this.tick();
  }

  /**
   * Re-place every dot relative to the current camera.
   *
   * Called per frame. The ICRF-to-fixed rotation is what makes the dots wheel
   * across the sky as the Earth turns, exactly like real stars — the same
   * transform `BodyLayer` uses for planet positions, so the two sets of dots
   * move consistently with each other.
   */
  tick() {
    if (!this.visible || this._entries.length === 0) return;

    const s = this._scratch;
    const time = this.viewer.clock.currentTime;
    const icrfToFixed =
      Cesium.Transforms.computeIcrfToFixedMatrix(time, s.icrf) ??
      Cesium.Transforms.computeTemeToPseudoFixedMatrix(time, s.icrf);

    const camera = this.viewer.camera.positionWC;

    for (const e of this._entries) {
      Cesium.Matrix3.multiplyByVector(icrfToFixed, e.dirIcrf, s.dir);
      Cesium.Cartesian3.multiplyByScalar(s.dir, SKY_DISTANCE_M, s.pos);
      Cesium.Cartesian3.add(camera, s.pos, s.pos);
      e.point.position = Cesium.Cartesian3.clone(s.pos, e.point.position);
      e.label.position = Cesium.Cartesian3.clone(s.pos, e.label.position);
    }
  }

  /**
   * Badge + count for the sidebar row.
   *
   * Always `data`, never `live`: this is a curated list of published
   * measurements, not a feed, and CLAUDE.md principle #2 reserves `LIVE` for
   * things actually fetched from an upstream source. There is no live source
   * to have — a black hole's mass does not update on a timer.
   */
  counts() {
    return { source: this.source, count: this._entries.length };
  }

  /** Route to the object's own simulator page (spec §6.5). */
  urlFor(object) {
    return `/blackhole/${object.id}/`;
  }
}

/**
 * J2000 right ascension/declination (degrees) to a unit vector in the
 * Earth-centred inertial frame.
 *
 * Standard spherical-to-Cartesian with the equatorial pole on +Z: RA measured
 * eastward in the equatorial plane, declination up from it. This is the frame
 * `computeIcrfToFixedMatrix` expects as its input.
 */
export function raDecToUnitVector(raDeg, decDeg) {
  const ra = Cesium.Math.toRadians(raDeg);
  const dec = Cesium.Math.toRadians(decDeg);
  const cosDec = Math.cos(dec);
  return new Cesium.Cartesian3(
    cosDec * Math.cos(ra),
    cosDec * Math.sin(ra),
    Math.sin(dec)
  );
}

/** Distance in light-years, formatted the way the tooltip wants it. */
export function formatLightYears(distanceKpc) {
  const ly = distanceKpc * 3261.564;
  if (ly >= 1e6) return `${(ly / 1e6).toPrecision(3)} million ly`;
  return `${Number(ly.toPrecision(2)).toLocaleString("en-US")} ly`;
}

/** Mass in a form a person can read. */
export function formatSolarMasses(m) {
  if (m >= 1e9) return `${(m / 1e9).toPrecision(2)} billion M☉`;
  if (m >= 1e6) return `${(m / 1e6).toPrecision(3)} million M☉`;
  return `${m.toPrecision(3)} M☉`;
}
