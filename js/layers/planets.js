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
      proxyRadius: body.radius,
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
