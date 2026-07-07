// Parent-relative moon layers. The Galilean moons use Astronomy Engine's
// JupiterMoons ephemeris and otherwise share the generic off-Earth body UX.

import { BODIES } from "../bodies.js";
import { BodyLayer, normalizeLon } from "./body.js";

export const JOVIAN_MOON_BODY_KEYS = [
  "io",
  "europa",
  "ganymede",
  "callisto",
];

const CATEGORY_DEFS = [
  { value: "missions", label: "Missions & landing sites" },
  { value: "craters", label: "Craters" },
  { value: "mountains", label: "Mountains & valleys" },
  { value: "regions", label: "Regions & plains" },
  { value: "other", label: "Other" },
];

export class JovianMoonLayer extends BodyLayer {
  constructor(viewer, key) {
    const body = BODIES[key];
    if (!body) throw new Error(`Unknown Jovian moon body: ${key}`);
    super(viewer, moonConfig(body));
  }
}

function moonConfig(body) {
  return {
    key: body.key,
    name: body.name,
    textureUrl: body.textureUrl,
    radius: body.radius,
    parentBody: body.parentBody,
    markerAlt: Math.max(12000, body.radius * 0.006),
    markerColor: body.markerColor ?? body.dotColor,
    maxArticles: 300,
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
    skyDot: { color: body.dotColor, pixelSize: 6 },
    transition: {
      proxy: true,
      proxyDistance: Math.max(45e7, body.radius * 10),
      proxyRadius: body.radius,
      duration: 2.2,
    },
    showBodyWhenUnfocused: false,
    blurDuration: 2.2,
    minZoomMargin: Math.max(25000, body.radius * 0.02),
    focusOffset: (radius) => new Cesium.Cartesian3(0, -radius * 4.6, radius * 0.65),
    cpuProjectMarkers: true,
    normalizeLon,
    categoryFor: moonArticleCategory,
  };
}

function moonArticleCategory(article) {
  const title = article.title.toLowerCase();
  if (article.missionSupplement) return "missions";
  if (
    article.country ||
    /\b(probe|orbiter|lander|spacecraft|mission|flyby|galileo|juno|voyager|pioneer|juice|clipper)\b/.test(title)
  ) {
    return "missions";
  }
  if (/\bcrater\b/.test(title)) return "craters";
  if (/^(mons|montes|vallis|valles|chasma|chasmata|rupes|dorsum|dorsa|catena|catenae|scopulus|scopuli)\b/.test(title) || /\b(mountain|valley|ridge|chain|scarp)\b/.test(title)) {
    return "mountains";
  }
  if (/^(regio|region|planum|planitia|terra|macula|facula|linea|palus|fluctus|patera)\b/.test(title) || /\b(region|plain|plains|terrain|basin|chaos|patera)\b/.test(title)) {
    return "regions";
  }
  return "other";
}
