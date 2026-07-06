// Shared metadata for solar-system bodies. UI choices intentionally expose
// only bodies with implemented layers; the rest are ready for future layers.

export const BODIES = {
  mercury: {
    key: "mercury",
    name: "Mercury",
    label: "Mercury",
    radius: 2439700,
    textureUrl: "assets/mercury.jpg",
    dotColor: "#9c9389",
    wikidataGlobe: "Q308",
    ephemeris: { type: "astronomy-engine", body: "Mercury" },
    orientation: {
      type: "iau",
      ra: [281.0103, -0.0328, "T"],
      dec: [61.4155, -0.0049, "T"],
      w: [329.5988, 6.1385108, "d"],
    },
  },
  venus: {
    key: "venus",
    name: "Venus",
    label: "Venus",
    radius: 6051800,
    textureUrl: "assets/venus.jpg",
    atmosphereTextureUrl: "assets/venus-atmosphere.jpg",
    dotColor: "#e6c89c",
    wikidataGlobe: "Q313",
    ephemeris: { type: "astronomy-engine", body: "Venus" },
    orientation: {
      type: "iau",
      ra: 272.76,
      dec: 67.16,
      w: [160.20, -1.4813688, "d"],
    },
  },
  earth: {
    key: "earth",
    name: "Earth",
    label: "\u{1f30d} Earth",
    radius: 6371000,
    textureUrl: "assets/earth-day.jpg",
    nightTextureUrl: "assets/earth-night.jpg",
  },
  moon: {
    key: "moon",
    name: "Moon",
    label: "\u{1f315} Moon",
    radius: 1737400,
    textureUrl: "assets/moon.jpg",
    dotColor: "#cfd6e4",
    markerColor: "#ff5470",
    wikidataGlobe: "Q405",
    ephemeris: { type: "moon" },
    orientation: { type: "moon" },
  },
  mars: {
    key: "mars",
    name: "Mars",
    label: "Mars",
    radius: 3389500,
    textureUrl: "assets/mars.jpg",
    dotColor: "#c1583c",
    wikidataGlobe: "Q111",
    ephemeris: { type: "astronomy-engine", body: "Mars" },
    orientation: {
      type: "iau",
      ra: [317.68143, -0.1061, "T"],
      dec: [52.88650, -0.0609, "T"],
      w: [176.630, 350.89198226, "d"],
    },
  },
  jupiter: {
    key: "jupiter",
    name: "Jupiter",
    label: "Jupiter",
    radius: 69911000,
    textureUrl: "assets/jupiter.jpg",
    dotColor: "#c8a06e",
    wikidataGlobe: "Q319",
    ephemeris: { type: "astronomy-engine", body: "Jupiter" },
    orientation: {
      type: "iau",
      ra: [268.056595, -0.006499, "T"],
      dec: [64.495303, 0.002413, "T"],
      w: [284.95, 870.5360000, "d"],
    },
  },
  saturn: {
    key: "saturn",
    name: "Saturn",
    label: "Saturn",
    radius: 58232000,
    textureUrl: "assets/saturn.jpg",
    ringTextureUrl: "assets/saturn-rings.png",
    dotColor: "#e0c188",
    wikidataGlobe: "Q193",
    ephemeris: { type: "astronomy-engine", body: "Saturn" },
    orientation: {
      type: "iau",
      ra: [40.589, -0.036, "T"],
      dec: [83.537, -0.004, "T"],
      w: [38.90, 810.7939024, "d"],
    },
  },
  uranus: {
    key: "uranus",
    name: "Uranus",
    label: "Uranus",
    radius: 25362000,
    textureUrl: "assets/uranus.jpg",
    dotColor: "#9bd4d6",
    wikidataGlobe: "Q324",
    ephemeris: { type: "astronomy-engine", body: "Uranus" },
    orientation: {
      type: "iau",
      ra: 257.311,
      dec: -15.175,
      w: [203.81, -501.1600928, "d"],
    },
  },
  neptune: {
    key: "neptune",
    name: "Neptune",
    label: "Neptune",
    radius: 24622000,
    textureUrl: "assets/neptune.jpg",
    dotColor: "#4f7bd0",
    wikidataGlobe: "Q332",
    ephemeris: { type: "astronomy-engine", body: "Neptune" },
    orientation: {
      type: "iau-neptune",
      n: [357.85, 52.316, "T"],
      ra: 299.36,
      raSin: 0.70,
      dec: 43.46,
      decCos: -0.51,
      w: [249.978, 541.1397757, "d"],
      wSin: -0.48,
    },
  },
  pluto: {
    key: "pluto",
    name: "Pluto",
    label: "Pluto",
    radius: 1188300,
    textureUrl: "assets/pluto.jpg",
    dotColor: "#c9b29a",
    wikidataGlobe: "Q339",
    ephemeris: { type: "astronomy-engine", body: "Pluto" },
    orientation: {
      type: "iau",
      ra: 132.993,
      dec: -6.163,
      w: [302.695, 56.3625225, "d"],
    },
  },
};

export const BODY_ORDER = [
  "mercury",
  "venus",
  "earth",
  "moon",
  "mars",
  "jupiter",
  "saturn",
  "uranus",
  "neptune",
  "pluto",
];

export const ACTIVE_BODY_KEYS = BODY_ORDER;

export function bodyChoices(keys = ACTIVE_BODY_KEYS) {
  return keys.map((key) => {
    const body = BODIES[key];
    return { key, label: body.label ?? body.name };
  });
}

export const BODY_CHOICES = bodyChoices();
