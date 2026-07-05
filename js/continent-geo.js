// Country-assembled continent and regional outlines for true-size comparison.
// The source data is still the shared country-boundary GeoJSON; these derived
// features behave like countries in search and in the draggable compare layer.

import { countryAreaKm2 } from "./country-geo.js";

const REGION_DEFS = [
  {
    id: "continent-asia",
    name: "Asia",
    type: "Continent",
    countries: [
      "AFG", "ARE", "ARM", "AZE", "BGD", "BHR", "BRN", "BTN", "CHN", "CYP",
      "GEO", "IDN", "IND", "IRN", "IRQ", "ISR", "JOR", "JPN", "KAZ", "KGZ",
      "KHM", "KOR", "KWT", "LAO", "LBN", "LKA", "MDV", "MMR", "MNG", "MYS",
      "NPL", "OMN", "PAK", "PHL", "PRK", "PSE", "QAT", "RUS", "SAU", "SGP",
      "SYR", "THA", "TJK", "TKM", "TLS", "TUR", "TWN", "UZB", "VNM", "YEM",
    ],
  },
  {
    id: "continent-europe",
    name: "Europe",
    type: "Continent",
    countries: [
      "ALB", "AND", "AUT", "BEL", "BIH", "BGR", "BLR", "CHE", "CZE", "DEU",
      "DNK", "ESP", "EST", "FIN", "FRA", "GBR", "GRC", "HRV", "HUN", "IRL",
      "ISL", "ITA", "LIE", "LTU", "LUX", "LVA", "MCO", "MDA", "MKD", "MLT",
      "MNE", "NLD", "NOR", "POL", "PRT", "ROU", "SMR", "SRB", "SVK", "SVN",
      "SWE", "UKR", "VAT",
    ],
  },
  {
    id: "continent-north-america",
    name: "North America",
    type: "Continent",
    countries: [
      "ATG", "BHS", "BLZ", "BRB", "CAN", "CRI", "CUB", "DMA", "DOM", "GRD",
      "GRL", "GTM", "HND", "HTI", "JAM", "KNA", "LCA", "MEX", "NIC", "PAN",
      "SLV", "TTO", "USA", "VCT",
    ],
  },
  {
    id: "continent-south-america",
    name: "South America",
    type: "Continent",
    countries: [
      "ARG", "BOL", "BRA", "CHL", "COL", "ECU", "FLK", "GUY", "PER", "PRY",
      "SUR", "URY", "VEN",
    ],
  },
  {
    id: "continent-oceania",
    name: "Oceania",
    type: "Continent",
    countries: [
      "AUS", "FJI", "FSM", "KIR", "MHL", "NRU", "NZL", "PLW", "PNG", "SLB",
      "TON", "TUV", "VUT", "WSM",
    ],
  },
  {
    id: "region-central-america",
    name: "Central America",
    type: "Region",
    countries: ["BLZ", "CRI", "GTM", "HND", "NIC", "PAN", "SLV"],
  },
  {
    id: "continent-africa",
    name: "Africa",
    type: "Continent",
    countries: [
      "AGO", "BDI", "BEN", "BFA", "BWA", "CAF", "CIV", "CMR", "COD", "COG",
      "COM", "CPV", "DJI", "DZA", "EGY", "ERI", "ESH", "ETH", "GAB", "GHA",
      "GIN", "GMB", "GNB", "GNQ", "KEN", "LBR", "LBY", "LSO", "MAR", "MDG",
      "MLI", "MOZ", "MRT", "MUS", "MWI", "NAM", "NER", "NGA", "RWA", "SDN",
      "SEN", "SLE", "SOM", "SSD", "STP", "SWZ", "SYC", "TCD", "TGO", "TUN",
      "TZA", "UGA", "ZAF", "ZMB", "ZWE",
    ],
  },
  {
    id: "region-southeast-asia",
    name: "Southeast Asia",
    type: "Region",
    countries: ["BRN", "KHM", "IDN", "LAO", "MYS", "MMR", "PHL", "SGP", "THA", "TLS", "VNM"],
  },
  {
    id: "region-east-asia",
    name: "East Asia",
    type: "Region",
    countries: ["CHN", "JPN", "KOR", "MNG", "PRK", "TWN"],
  },
  {
    id: "region-middle-east",
    name: "Middle East",
    type: "Region",
    countries: [
      "ARM", "AZE", "BHR", "CYP", "EGY", "GEO", "IRN", "IRQ", "ISR", "JOR",
      "KWT", "LBN", "OMN", "PSE", "QAT", "SAU", "SYR", "TUR", "ARE", "YEM",
    ],
  },
  {
    id: "region-south-asia",
    name: "South Asia",
    type: "Region",
    countries: ["AFG", "BGD", "BTN", "IND", "LKA", "MDV", "NPL", "PAK"],
  },
];

export function buildContinentGeo(countries) {
  const byId = new Map(countries.map((f) => [f.id, f]));
  return REGION_DEFS.map((def) => {
    const members = def.countries.map((id) => byId.get(id)).filter(Boolean);
    if (members.length === 0) return null;
    return {
      id: def.id,
      name: def.name,
      type: def.type,
      searchKind: "region",
      memberIds: members.map((f) => f.id),
      rings: members.flatMap((f) => f.rings),
      bbox: bboxFor(members),
      areaKm2: members.reduce((sum, f) => sum + countryAreaKm2(f), 0),
    };
  }).filter(Boolean);
}

function bboxFor(features) {
  let w = 180, s = 90, e = -180, n = -90;
  for (const f of features) {
    w = Math.min(w, f.bbox[0]);
    s = Math.min(s, f.bbox[1]);
    e = Math.max(e, f.bbox[2]);
    n = Math.max(n, f.bbox[3]);
  }
  return [w, s, e, n];
}
