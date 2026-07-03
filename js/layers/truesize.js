// True-size comparison overlays (thetruesize.com-style): pick a country and
// drag a copy of its outline anywhere on the globe. Moving the copy is a
// rigid rotation of the outline on the sphere, so its shape and area are
// preserved exactly — the 3D globe has no map-projection distortion, which
// makes the parked outline a genuine size comparison.

import { loadCountryGeo, countryAt, countryAreaKm2, formatArea } from "../country-geo.js";

const COLORS = ["#ff5470", "#6ef3ff", "#ffd166", "#8bffb0", "#c792ea", "#ff9e64"];
const FILL_ALPHA = 0.3;
const OUTLINE_ALPHA = 0.95;
const HEIGHT = 2000; // metres above the ellipsoid: avoids z-fighting the imagery

const scratchVec = new Cesium.Cartesian3();
const scratchMat = new Cesium.Matrix3();
const dragScratch = new Cesium.Cartesian3();
const dragMat = new Cesium.Matrix3();

export class TrueSizeLayer {
  constructor(viewer) {
    this.viewer = viewer;
    this.enabled = false;  // click-to-copy mode (checkbox in the panel)
    this.items = [];       // active overlays
    this.geo = null;       // shared country polygons (lazy)
    this.onChanged = null; // app hook: overlay count / mode changed
    this._colorIdx = 0;
    this._drag = null;
    this._installHandlers();
  }

  setEnabled(v) {
    this.enabled = v;
    if (v) this._ensureGeo(); // preload so the first click can resolve a country
    this.onChanged?.();
  }

  async _ensureGeo() {
    if (!this.geo) {
      try {
        this.geo = await loadCountryGeo();
      } catch (e) {
        console.warn("[truesize] country boundaries failed to load:", e.message);
      }
    }
    return this.geo;
  }

  // Click-to-copy: returns true when the click is consumed (a country was
  // found, or the boundaries are still loading and the copy appears right
  // after they arrive).
  tryAdd(lat, lon) {
    if (!this.geo) {
      this._ensureGeo().then(() => {
        const f = countryAt(this.geo, lat, lon);
        if (f) this.add(f);
      });
      return true;
    }
    const f = countryAt(this.geo, lat, lon);
    if (f) {
      this.add(f);
      return true;
    }
    return false;
  }

  // Drop a draggable copy of a country, initially on top of the original.
  add(feature) {
    const color = Cesium.Color.fromCssColorString(COLORS[this._colorIdx++ % COLORS.length]);

    // unit direction vectors per vertex; all movement is rotation of these
    const baseVecs = feature.rings
      .filter((ring) => ring.length >= 3)
      .map((ring) => {
        const closed = ring[0][0] === ring[ring.length - 1][0] &&
          ring[0][1] === ring[ring.length - 1][1] ? ring : [...ring, ring[0]];
        return closed.map(([lon, lat]) => unitFromDegrees(lon, lat));
      });

    // vector-sum centre is robust for countries crossing the antimeridian
    const baseCenter = new Cesium.Cartesian3();
    for (const ring of baseVecs) {
      for (const v of ring) Cesium.Cartesian3.add(baseCenter, v, baseCenter);
    }
    Cesium.Cartesian3.normalize(baseCenter, baseCenter);

    const item = {
      name: feature.name,
      areaLabel: formatArea(countryAreaKm2(feature)),
      color,
      baseVecs,
      baseCenter,
      curCenter: Cesium.Cartesian3.clone(baseCenter),
      positions: baseVecs.map((ring) => ring.map(() => new Cesium.Cartesian3())),
      labelPos: new Cesium.Cartesian3(),
      labelPosProp: null, // set once the label entity exists
      entities: [],
    };
    this._applyCenter(item, item.curCenter);

    for (const ringPos of item.positions) {
      const ent = this.viewer.entities.add({
        polygon: {
          hierarchy: new Cesium.CallbackProperty(
            () => new Cesium.PolygonHierarchy(ringPos), false),
          material: color.withAlpha(FILL_ALPHA),
          height: HEIGHT,
          arcType: Cesium.ArcType.GEODESIC,
        },
        polyline: {
          positions: new Cesium.CallbackProperty(() => ringPos, false),
          width: 2,
          material: color.withAlpha(OUTLINE_ALPHA),
          arcType: Cesium.ArcType.GEODESIC,
        },
      });
      ent.kind = "truesize";
      ent.ts = item;
      item.entities.push(ent);
    }

    item.labelPosProp = new Cesium.ConstantPositionProperty(
      Cesium.Cartesian3.clone(item.labelPos));
    const label = this.viewer.entities.add({
      position: item.labelPosProp,
      label: {
        text: `${item.name}\n${item.areaLabel}`,
        font: "600 12px 'Segoe UI', system-ui, sans-serif",
        fillColor: Cesium.Color.WHITE,
        showBackground: true,
        backgroundColor: new Cesium.Color(0.04, 0.07, 0.12, 0.82),
        backgroundPadding: new Cesium.Cartesian2(7, 5),
        horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
        verticalOrigin: Cesium.VerticalOrigin.CENTER,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        scaleByDistance: new Cesium.NearFarScalar(2.0e6, 1.0, 4.0e7, 0.62),
      },
    });
    label.kind = "truesize";
    label.ts = item;
    item.entities.push(label);

    this.items.push(item);
    this.onChanged?.();
    return item;
  }

  remove(item) {
    const i = this.items.indexOf(item);
    if (i === -1) return;
    this.items.splice(i, 1);
    for (const ent of item.entities) this.viewer.entities.remove(ent);
    this.onChanged?.();
  }

  clear() {
    for (const item of this.items.slice()) this.remove(item);
  }

  // Rotate the outline so its centre sits at `center` (unit vector).
  _applyCenter(item, center) {
    Cesium.Cartesian3.clone(center, item.curCenter);
    const m = Cesium.Matrix3.fromQuaternion(
      rotationBetween(item.baseCenter, item.curCenter), scratchMat);
    for (let r = 0; r < item.baseVecs.length; r++) {
      const base = item.baseVecs[r];
      const out = item.positions[r];
      for (let i = 0; i < base.length; i++) {
        const v = Cesium.Matrix3.multiplyByVector(m, base[i], scratchVec);
        out[i] = fromUnit(v, HEIGHT, out[i]);
      }
    }
    fromUnit(item.curCenter, HEIGHT, item.labelPos);
    // clone: setValue ignores the assignment when handed the mutated original
    item.labelPosProp?.setValue(Cesium.Cartesian3.clone(item.labelPos));
  }

  // --- dragging ---------------------------------------------------------------

  _installHandlers() {
    const h = new Cesium.ScreenSpaceEventHandler(this.viewer.canvas);
    h.setInputAction((e) => this._down(e.position), Cesium.ScreenSpaceEventType.LEFT_DOWN);
    h.setInputAction((e) => this._move(e.endPosition), Cesium.ScreenSpaceEventType.MOUSE_MOVE);
    h.setInputAction(() => this._up(), Cesium.ScreenSpaceEventType.LEFT_UP);
    h.setInputAction((e) => {
      const item = this._pick(e.position);
      if (item) this.remove(item);
    }, Cesium.ScreenSpaceEventType.RIGHT_CLICK);
    // the mouse can be released outside the canvas mid-drag
    window.addEventListener("pointerup", () => this._up());
  }

  _pick(pos) {
    const picked = this.viewer.scene.pick(pos);
    return picked?.id?.kind === "truesize" ? picked.id.ts : null;
  }

  _groundUnit(pos, result = new Cesium.Cartesian3()) {
    const cart = this.viewer.camera.pickEllipsoid(pos, this.viewer.scene.globe.ellipsoid);
    return cart ? Cesium.Cartesian3.normalize(cart, result) : null;
  }

  _down(pos) {
    const item = this._pick(pos);
    if (!item) return;
    const g = this._groundUnit(pos);
    if (!g) return;
    // grabQ re-applies the cursor→centre offset so the outline doesn't jump
    this._drag = { item, grabQ: rotationBetween(g, item.curCenter) };
    const ctl = this.viewer.scene.screenSpaceCameraController;
    this._saved = {
      rotate: ctl.enableRotate,
      translate: ctl.enableTranslate,
      tilt: ctl.enableTilt,
    };
    ctl.enableRotate = ctl.enableTranslate = ctl.enableTilt = false;
    this.viewer.canvas.style.cursor = "grabbing";
  }

  _move(pos) {
    if (!this._drag) return;
    const g = this._groundUnit(pos, dragScratch);
    if (!g) return;
    const m = Cesium.Matrix3.fromQuaternion(this._drag.grabQ, dragMat);
    const center = Cesium.Cartesian3.normalize(
      Cesium.Matrix3.multiplyByVector(m, g, g), g);
    this._applyCenter(this._drag.item, center);
  }

  _up() {
    if (!this._drag) return;
    this._drag = null;
    const ctl = this.viewer.scene.screenSpaceCameraController;
    ctl.enableRotate = this._saved.rotate;
    ctl.enableTranslate = this._saved.translate;
    ctl.enableTilt = this._saved.tilt;
    this.viewer.canvas.style.cursor = "default";
  }
}

// unit sphere direction from lon/lat degrees
function unitFromDegrees(lon, lat) {
  const phi = Cesium.Math.toRadians(lat);
  const lam = Cesium.Math.toRadians(lon);
  const c = Math.cos(phi);
  return new Cesium.Cartesian3(c * Math.cos(lam), c * Math.sin(lam), Math.sin(phi));
}

// unit sphere direction back to an ellipsoid surface point (+height)
function fromUnit(v, height, result) {
  const lat = Math.asin(Cesium.Math.clamp(v.z, -1, 1));
  const lon = Math.atan2(v.y, v.x);
  return Cesium.Cartesian3.fromRadians(lon, lat, height, undefined, result);
}

// shortest-arc quaternion taking unit vector a to unit vector b
function rotationBetween(a, b) {
  const d = Cesium.Math.clamp(Cesium.Cartesian3.dot(a, b), -1, 1);
  if (d > 1 - 1e-12) return Cesium.Quaternion.clone(Cesium.Quaternion.IDENTITY);
  let axis = Cesium.Cartesian3.cross(a, b, new Cesium.Cartesian3());
  if (Cesium.Cartesian3.magnitude(axis) < 1e-9) {
    // antipodal: any axis perpendicular to a works
    axis = Math.abs(a.x) < 0.9
      ? Cesium.Cartesian3.cross(a, Cesium.Cartesian3.UNIT_X, axis)
      : Cesium.Cartesian3.cross(a, Cesium.Cartesian3.UNIT_Y, axis);
  }
  Cesium.Cartesian3.normalize(axis, axis);
  return Cesium.Quaternion.fromAxisAngle(axis, Math.acos(d));
}
