// Generic planet layers: true live position, sky-dot affordance, and the same
// scaled proxy focus transition Mars uses. Surface wiki/sidebar work comes next.

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

export class PlanetLayer extends BodyLayer {
  constructor(viewer, key) {
    const body = BODIES[key];
    if (!body) throw new Error(`Unknown planet body: ${key}`);
    super(viewer, planetConfig(body));
  }
}

function planetConfig(body) {
  return {
    key: body.key,
    name: body.name,
    textureUrl: body.textureUrl,
    radius: body.radius,
    markerAlt: Math.max(15000, body.radius * 0.004),
    markerColor: body.dotColor,
    maxArticles: 420,
    liveMinItems: 0,
    wikidataGlobe: body.wikidataGlobe,
    fallbackSites: [],
    defaultCategory: "all",
    categoryDefs: [],
    articleKind: `${body.key}wiki`,
    articleProps: { bodyName: body.name },
    bodyPickId: (layer) => ({ kind: "body", body: body.key, layer }),
    ephemeris: body.ephemeris,
    orientation: body.orientation,
    skyDot: { color: body.dotColor, pixelSize: 7 },
    transition: {
      proxy: true,
      proxyDistance: Math.max(45e7, body.radius * 8),
      proxyRadius: body.radius,
      duration: 2.4,
    },
    wikiEnabled: false,
    showBodyWhenUnfocused: false,
    blurDuration: 2.4,
    minZoomMargin: Math.max(50000, body.radius * 0.015),
    focusOffset: (radius) => new Cesium.Cartesian3(0, -radius * 4.4, radius * 0.55),
    cpuProjectMarkers: true,
    normalizeLon,
    categoryFor: () => "all",
  };
}
