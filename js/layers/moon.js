// Moon layer config: live Cesium lunar ephemeris, NASA LRO imagery, and
// Wikidata/Wikipedia lunar surface markers.

import { BODIES } from "../bodies.js";
import { BodyLayer, normalizeLon } from "./body.js";

const MOON_BODY = BODIES.moon;

const CATEGORY_DEFS = [
  { value: "missions", label: "Missions & landing sites" },
  { value: "craters", label: "Craters" },
  { value: "maria", label: "Maria & plains" },
  { value: "mountains", label: "Mountains & valleys" },
  { value: "basins", label: "Basins & regions" },
  { value: "other", label: "Other" },
];
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
  ["South Pole-Aitken basin", -53.0, 169.0],
  ["Chang'e 4", -45.5, 177.6, "China", "Flag of the People's Republic of China.svg"],
  ["Luna 2", 29.1, 0.0, "Soviet Union", "Flag of the Soviet Union.svg"],
];

const MOON_CONFIG = {
  key: MOON_BODY.key,
  name: MOON_BODY.name,
  textureUrl: MOON_BODY.textureUrl,
  radius: MOON_BODY.radius,
  markerAlt: 15000,
  markerColor: MOON_BODY.markerColor,
  markerScale: new Cesium.NearFarScalar(3.0e6, 1.3, 4.4e8, 0.45),
  maxArticles: 400,
  liveMinItems: 10,
  wikidataGlobe: MOON_BODY.wikidataGlobe,
  fallbackSites: FALLBACK_SITES,
  missionSupplementUrl: "data/lunar-missions.json",
  defaultCategory: "missions",
  categoryDefs: CATEGORY_DEFS,
  articleKind: "moonwiki",
  articleProps: { moon: true },
  bodyPickId: (layer) => ({ kind: "moon", moon: layer }),
  ephemeris: MOON_BODY.ephemeris,
  orientation: MOON_BODY.orientation,
  hideCesiumMoon: true,
  showBodyWhenUnfocused: true,
  focusDuration: 3.0,
  blurDuration: 3.0,
  minZoomMargin: 30000,
  normalizeLon,
  categoryFor: moonArticleCategory,
};

export class MoonLayer extends BodyLayer {
  constructor(viewer) {
    super(viewer, MOON_CONFIG);
  }

  pickMoon(windowPosition) {
    return this.pickSurface(windowPosition);
  }
}

function moonArticleCategory(article) {
  const title = article.title.toLowerCase();
  if (article.missionSupplement) return "missions";
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
