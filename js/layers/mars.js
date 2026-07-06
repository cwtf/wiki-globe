// Mars layer config: live astronomy-engine ephemeris, IAU rotation,
// Solar System Scope imagery, and Wikidata/Wikipedia Martian markers.

import { BODIES } from "../bodies.js";
import { BodyLayer, normalizeLon, titleKey } from "./body.js";

const MARS_BODY = BODIES.mars;
const MARS_RADIUS = MARS_BODY.radius;
const CATEGORY_DEFS = [
  { value: "missions", label: "Missions & landing sites" },
  { value: "craters", label: "Craters" },
  { value: "mountains", label: "Mountains & valleys" },
  { value: "regions", label: "Regions & plains" },
  { value: "other", label: "Other" },
];
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

const MARS_CONFIG = {
  key: MARS_BODY.key,
  name: MARS_BODY.name,
  textureUrl: MARS_BODY.textureUrl,
  radius: MARS_RADIUS,
  markerAlt: 15000,
  markerColor: MARS_BODY.dotColor,
  markerScale: new Cesium.NearFarScalar(5.0e6, 1.3, 7.5e8, 0.45),
  maxArticles: 420,
  liveMinItems: 0,
  wikidataGlobe: MARS_BODY.wikidataGlobe,
  fallbackSites: FALLBACK_SITES,
  missionSupplementUrl: "data/mars-missions.json",
  overwriteSupplementCoords: true,
  defaultCategory: "missions",
  categoryDefs: CATEGORY_DEFS,
  articleKind: "marswiki",
  articleProps: { bodyName: "Mars" },
  bodyPickId: (layer) => ({ kind: "body", body: "mars", layer }),
  ephemeris: MARS_BODY.ephemeris,
  orientation: MARS_BODY.orientation,
  skyDot: { color: MARS_BODY.dotColor, pixelSize: 7 },
  transition: {
    proxy: true,
    proxyDistance: 45e7,
    proxyRadius: MARS_RADIUS,
    duration: 2.4,
  },
  showBodyWhenUnfocused: false,
  blurDuration: 2.4,
  minZoomMargin: 50000,
  focusOffset: (radius) => new Cesium.Cartesian3(0, -radius * 4.4, radius * 0.55),
  cpuProjectMarkers: true,
  normalizeLon,
  categoryFor: marsArticleCategory,
};

export class MarsLayer extends BodyLayer {
  constructor(viewer) {
    super(viewer, MARS_CONFIG);
  }

  pickMars(windowPosition) {
    return this.pickSurface(windowPosition);
  }
}

function marsArticleCategory(article) {
  const title = article.title.toLowerCase();
  if (article.missionSupplement) return "missions";
  if (titleKey(title) === "mars exploration rover") return "other";
  if (/\bcrater\b/.test(title)) return "craters";
  if (
    article.country ||
    /\b(viking|pathfinder|sojourner|spirit|opportunity|curiosity|perseverance|insight|phoenix|beagle|schiaparelli|zhurong|tianwen|mars \d|lander|landing|rover|probe|spacecraft|mission)\b/.test(title)
  ) {
    return "missions";
  }
  if (/^(mons|montes|vallis|valles|chasma|chasmata|rupes|scopulus|scopuli|dorsum|dorsa|labes)\b/.test(title) || /\b(mountain|valley|canyon|scarp)\b/.test(title)) {
    return "mountains";
  }
  if (/^(planitia|planum|terra|regio|vastitas|mare|palus)\b/.test(title) || /\b(region|plain|plains|basin|quadrangle|polar cap)\b/.test(title)) {
    return "regions";
  }
  return "other";
}
