// Generic planet layers: true live position, sky-dot affordance, Mars-style
// scaled proxy focus, and live Wikidata/Wikipedia surface markers.

import { BODIES } from "../bodies.js";
import { BodyLayer, normalizeLon } from "./body.js";

export const PLANET_BODY_KEYS = [
  "mercury",
  "venus",
  "jupiter",
  "saturn",
  "uranus",
  "neptune",
  "pluto",
];

const CATEGORY_DEFS = [
  { value: "missions", label: "Missions & landing sites" },
  { value: "craters", label: "Craters" },
  { value: "mountains", label: "Mountains & valleys" },
  { value: "regions", label: "Regions & plains" },
  { value: "other", label: "Other" },
];

export class PlanetLayer extends BodyLayer {
  constructor(viewer, key) {
    const body = BODIES[key];
    if (!body) throw new Error(`Unknown planet body: ${key}`);
    super(viewer, planetConfig(body));
  }

  init() {
    super.init();
    if (this.config.rings) this._initRings();
  }

  tick() {
    super.tick();
    if (this.ringPrimitive) {
      this.ringPrimitive.modelMatrix = this.modelMatrix;
      this.ringPrimitive.show = this.visible && this._trueFocused;
    }
    if (this.proxyRingPrimitive) {
      this.proxyRingPrimitive.modelMatrix = this.proxyModelMatrix;
      this.proxyRingPrimitive.show = this.visible && this._transitioning;
    }
  }

  setVisible(v) {
    super.setVisible(v);
    if (this.ringPrimitive) this.ringPrimitive.show = v && this._trueFocused;
    if (this.proxyRingPrimitive) this.proxyRingPrimitive.show = v && this._transitioning;
  }

  blur(opts = {}) {
    super.blur(opts);
    if (this.ringPrimitive) this.ringPrimitive.show = false;
    if (this.proxyRingPrimitive) this.proxyRingPrimitive.show = false;
  }

  _initRings() {
    const rings = this.config.rings;
    const appearance = ringAppearance(rings.textureUrl);
    this.ringPrimitive = this.scene.primitives.add(new Cesium.Primitive({
      geometryInstances: new Cesium.GeometryInstance({
        geometry: ringGeometry(rings.innerRadius, rings.outerRadius),
      }),
      appearance,
      modelMatrix: this.modelMatrix,
      asynchronous: false,
      allowPicking: false,
      show: false,
    }));

    if (this.proxyPrimitive) {
      this.proxyRingPrimitive = this.scene.primitives.add(new Cesium.Primitive({
        geometryInstances: new Cesium.GeometryInstance({
          geometry: ringGeometry(rings.innerRadius, rings.outerRadius),
        }),
        appearance: ringAppearance(rings.textureUrl),
        modelMatrix: this.proxyModelMatrix,
        asynchronous: false,
        allowPicking: false,
        show: false,
      }));
    }
  }
}

function planetConfig(body) {
  return {
    key: body.key,
    name: body.name,
    textureUrl: body.textureUrl,
    rings: body.rings,
    radius: body.radius,
    markerAlt: Math.max(15000, body.radius * 0.004),
    markerColor: body.dotColor,
    maxArticles: 420,
    liveMinItems: 0,
    allowEmptyLive: true,
    wikidataGlobe: body.wikidataGlobe,
    fallbackSites: [],
    defaultCategory: "all",
    categoryDefs: CATEGORY_DEFS,
    articleKind: "bodywiki",
    articlePickId: (layer, article) => ({
      kind: "bodywiki",
      body: body.key,
      layer,
      article,
    }),
    articleProps: { bodyName: body.name },
    bodyPickId: (layer) => ({ kind: "body", body: body.key, layer }),
    ephemeris: body.ephemeris,
    orientation: body.orientation,
    skyDot: { color: body.dotColor, pixelSize: 7 },
    transition: {
      proxy: true,
      proxyDistance: Math.max(45e7, body.radius * 8),
      proxyRadius: body.rings?.outerRadius ?? body.radius,
      duration: 2.4,
    },
    showBodyWhenUnfocused: false,
    blurDuration: 2.4,
    minZoomMargin: Math.max(50000, body.radius * 0.015),
    focusOffset: (radius) => new Cesium.Cartesian3(0, -radius * 4.4, radius * 0.55),
    cpuProjectMarkers: true,
    normalizeLon,
    categoryFor: planetArticleCategory,
  };
}

function ringAppearance(textureUrl) {
  return new Cesium.MaterialAppearance({
    material: Cesium.Material.fromType("Image", {
      image: textureUrl,
      transparent: true,
    }),
    translucent: true,
    closed: false,
    faceForward: true,
  });
}

function ringGeometry(innerRadius, outerRadius, segments = 256) {
  const vertexCount = (segments + 1) * 2;
  const positions = new Float64Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const st = new Float32Array(vertexCount * 2);
  const indices = new Uint16Array(segments * 6);

  for (let i = 0; i <= segments; i++) {
    const angle = (i / segments) * Math.PI * 2;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const base = i * 2;
    writeRingVertex(positions, normals, st, base, innerRadius, cos, sin, 0);
    writeRingVertex(positions, normals, st, base + 1, outerRadius, cos, sin, 1);
  }

  for (let i = 0; i < segments; i++) {
    const ii = i * 6;
    const v = i * 2;
    indices[ii] = v;
    indices[ii + 1] = v + 1;
    indices[ii + 2] = v + 2;
    indices[ii + 3] = v + 1;
    indices[ii + 4] = v + 3;
    indices[ii + 5] = v + 2;
  }

  return new Cesium.Geometry({
    attributes: {
      position: new Cesium.GeometryAttribute({
        componentDatatype: Cesium.ComponentDatatype.DOUBLE,
        componentsPerAttribute: 3,
        values: positions,
      }),
      normal: new Cesium.GeometryAttribute({
        componentDatatype: Cesium.ComponentDatatype.FLOAT,
        componentsPerAttribute: 3,
        values: normals,
      }),
      st: new Cesium.GeometryAttribute({
        componentDatatype: Cesium.ComponentDatatype.FLOAT,
        componentsPerAttribute: 2,
        values: st,
      }),
    },
    indices,
    primitiveType: Cesium.PrimitiveType.TRIANGLES,
    boundingSphere: new Cesium.BoundingSphere(Cesium.Cartesian3.ZERO, outerRadius),
  });
}

function writeRingVertex(positions, normals, st, vertex, radius, cos, sin, u) {
  const p = vertex * 3;
  positions[p] = radius * cos;
  positions[p + 1] = radius * sin;
  positions[p + 2] = 0;
  normals[p] = 0;
  normals[p + 1] = 0;
  normals[p + 2] = 1;

  const t = vertex * 2;
  st[t] = u;
  st[t + 1] = 0.5;
}

function planetArticleCategory(article) {
  const title = article.title.toLowerCase();
  if (
    article.country ||
    /\b(probe|orbiter|lander|rover|spacecraft|mission|landing|impact|flyby|venera|vega|mariner|messenger|bepi|galileo|cassini|huygens|voyager|pioneer|new horizons)\b/.test(title)
  ) {
    return "missions";
  }
  if (/\bcrater\b/.test(title)) return "craters";
  if (/^(mons|montes|vallis|valles|chasma|chasmata|rupes|scopulus|scopuli|dorsum|dorsa)\b/.test(title) || /\b(mountain|valley|canyon|scarp)\b/.test(title)) {
    return "mountains";
  }
  if (/^(planitia|planum|terra|regio|region|macula|facula|linea|chaos|palus)\b/.test(title) || /\b(region|plain|plains|basin|quadrangle|polar cap|terrain)\b/.test(title)) {
    return "regions";
  }
  return "other";
}
