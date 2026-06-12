// Representative demo data used when live feeds are unreachable.

export const AIRPORTS = [
  { c: "LAX", name: "Los Angeles",   lat: 33.94,  lon: -118.41 },
  { c: "SFO", name: "San Francisco", lat: 37.62,  lon: -122.38 },
  { c: "SEA", name: "Seattle",       lat: 47.45,  lon: -122.31 },
  { c: "ORD", name: "Chicago",       lat: 41.97,  lon: -87.91 },
  { c: "ATL", name: "Atlanta",       lat: 33.64,  lon: -84.43 },
  { c: "DFW", name: "Dallas",        lat: 32.90,  lon: -97.04 },
  { c: "MIA", name: "Miami",         lat: 25.79,  lon: -80.29 },
  { c: "JFK", name: "New York",      lat: 40.64,  lon: -73.78 },
  { c: "YYZ", name: "Toronto",       lat: 43.68,  lon: -79.63 },
  { c: "YVR", name: "Vancouver",     lat: 49.19,  lon: -123.18 },
  { c: "MEX", name: "Mexico City",   lat: 19.44,  lon: -99.07 },
  { c: "BOG", name: "Bogotá",        lat: 4.70,   lon: -74.15 },
  { c: "GRU", name: "São Paulo",     lat: -23.43, lon: -46.47 },
  { c: "EZE", name: "Buenos Aires",  lat: -34.82, lon: -58.54 },
  { c: "SCL", name: "Santiago",      lat: -33.39, lon: -70.79 },
  { c: "LHR", name: "London",        lat: 51.47,  lon: -0.45 },
  { c: "CDG", name: "Paris",         lat: 49.01,  lon: 2.55 },
  { c: "FRA", name: "Frankfurt",     lat: 50.04,  lon: 8.57 },
  { c: "AMS", name: "Amsterdam",     lat: 52.31,  lon: 4.76 },
  { c: "MAD", name: "Madrid",        lat: 40.49,  lon: -3.57 },
  { c: "FCO", name: "Rome",          lat: 41.80,  lon: 12.25 },
  { c: "IST", name: "Istanbul",      lat: 41.26,  lon: 28.74 },
  { c: "SVO", name: "Moscow",        lat: 55.97,  lon: 37.41 },
  { c: "DXB", name: "Dubai",         lat: 25.25,  lon: 55.36 },
  { c: "DOH", name: "Doha",          lat: 25.27,  lon: 51.61 },
  { c: "DEL", name: "Delhi",         lat: 28.56,  lon: 77.10 },
  { c: "BOM", name: "Mumbai",        lat: 19.09,  lon: 72.87 },
  { c: "SIN", name: "Singapore",     lat: 1.36,   lon: 103.99 },
  { c: "KUL", name: "Kuala Lumpur",  lat: 2.75,   lon: 101.71 },
  { c: "BKK", name: "Bangkok",       lat: 13.69,  lon: 100.75 },
  { c: "CGK", name: "Jakarta",       lat: -6.13,  lon: 106.66 },
  { c: "MNL", name: "Manila",        lat: 14.51,  lon: 121.02 },
  { c: "HKG", name: "Hong Kong",     lat: 22.31,  lon: 113.91 },
  { c: "PVG", name: "Shanghai",      lat: 31.14,  lon: 121.81 },
  { c: "PEK", name: "Beijing",       lat: 40.08,  lon: 116.58 },
  { c: "ICN", name: "Seoul",         lat: 37.46,  lon: 126.44 },
  { c: "NRT", name: "Tokyo",         lat: 35.77,  lon: 140.39 },
  { c: "SYD", name: "Sydney",        lat: -33.95, lon: 151.18 },
  { c: "MEL", name: "Melbourne",     lat: -37.67, lon: 144.84 },
  { c: "AKL", name: "Auckland",      lat: -37.01, lon: 174.79 },
  { c: "JNB", name: "Johannesburg",  lat: -26.14, lon: 28.25 },
  { c: "CPT", name: "Cape Town",     lat: -33.97, lon: 18.60 },
  { c: "CAI", name: "Cairo",         lat: 30.12,  lon: 31.41 },
  { c: "LOS", name: "Lagos",         lat: 6.58,   lon: 3.32 },
  { c: "NBO", name: "Nairobi",       lat: -1.32,  lon: 36.93 },
  { c: "ANC", name: "Anchorage",     lat: 61.17,  lon: -149.99 },
  { c: "HNL", name: "Honolulu",      lat: 21.32,  lon: -157.92 },
];

const AIRLINE_CODES = [
  "UAL", "DAL", "AAL", "BAW", "DLH", "AFR", "KLM", "UAE", "QTR", "ETD",
  "SIA", "CPA", "ANA", "JAL", "QFA", "ACA", "THY", "ETH", "LAN", "FDX",
];

// Mulberry32 — deterministic PRNG so demo data is stable between reloads.
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Returns route specs; the flight layer computes geometry/duration from them.
export function makeDemoFlights(count = 200) {
  const rnd = mulberry32(20260613);
  const flights = [];
  let guard = 0;
  while (flights.length < count && guard++ < count * 20) {
    const a = AIRPORTS[Math.floor(rnd() * AIRPORTS.length)];
    const b = AIRPORTS[Math.floor(rnd() * AIRPORTS.length)];
    if (a === b) continue;
    // crude separation filter; the layer re-checks true geodesic distance
    const dLat = a.lat - b.lat;
    const dLon = Math.min(Math.abs(a.lon - b.lon), 360 - Math.abs(a.lon - b.lon));
    if (Math.sqrt(dLat * dLat + dLon * dLon) < 7) continue;
    flights.push({
      callsign: AIRLINE_CODES[Math.floor(rnd() * AIRLINE_CODES.length)] +
        String(100 + Math.floor(rnd() * 9000)),
      from: a,
      to: b,
      altM: 9800 + Math.floor(rnd() * 2600),
      speedKmh: 820 + Math.floor(rnd() * 130),
      phase: rnd(), // fraction of route duration used as time offset
    });
  }
  return flights;
}

// Synthetic orbital elements covering the familiar regimes
// (LEO constellation, sun-sync, station, MEO nav, GEO).
export function makeDemoSatellites() {
  const rnd = mulberry32(42);
  const sats = [];
  const d2r = Math.PI / 180;

  sats.push({ name: "DEMO STATION (ISS-class)", altKm: 420, incDeg: 51.6, raanDeg: 80, m0Deg: 10 });
  sats.push({ name: "DEMO TELESCOPE (HST-class)", altKm: 540, incDeg: 28.5, raanDeg: 200, m0Deg: 150 });

  for (let p = 0; p < 8; p++) {
    for (let i = 0; i < 6; i++) {
      sats.push({
        name: `CONSTELLATION-DMO ${p * 6 + i + 1}`,
        altKm: 550, incDeg: 53,
        raanDeg: p * 45, m0Deg: i * 60 + p * 7.5,
      });
    }
  }
  for (let i = 0; i < 16; i++) {
    sats.push({
      name: `EARTHOBS-DMO ${i + 1}`,
      altKm: 690 + Math.floor(rnd() * 210), incDeg: 97.6,
      raanDeg: rnd() * 360, m0Deg: rnd() * 360,
    });
  }
  for (let p = 0; p < 3; p++) {
    for (let i = 0; i < 4; i++) {
      sats.push({
        name: `NAVSAT-DMO ${p * 4 + i + 1}`,
        altKm: 20180, incDeg: 55,
        raanDeg: p * 120, m0Deg: i * 90 + p * 30,
      });
    }
  }
  for (const lon of [-160, -100, -30, 10, 75, 140]) {
    sats.push({ name: `GEOSAT-DMO ${lon}E`, altKm: 35786, incDeg: 0, raanDeg: lon, m0Deg: 0, geo: true });
  }
  const miscInc = [63.4, 74, 87.4, 28.5];
  for (let i = 0; i < 12; i++) {
    sats.push({
      name: `RESEARCH-DMO ${i + 1}`,
      altKm: 500 + Math.floor(rnd() * 900),
      incDeg: miscInc[i % miscInc.length],
      raanDeg: rnd() * 360, m0Deg: rnd() * 360,
    });
  }

  // pre-convert angles to radians for the layer
  for (const s of sats) {
    s.inc = s.incDeg * d2r;
    s.raan0 = s.raanDeg * d2r;
    s.m0 = s.m0Deg * d2r;
  }
  return sats;
}

const VESSEL_ADJ = ["Pacific", "Atlantic", "Northern", "Golden", "Coral", "Iron",
  "Silver", "Eastern", "Polar", "Royal", "Blue", "Crimson", "Emerald", "Arctic"];
const VESSEL_NOUN = ["Dawn", "Spirit", "Star", "Wave", "Trader", "Gull", "Horizon",
  "Albatross", "Runner", "Breeze", "Queen", "Passage", "Meridian", "Voyager"];

export function vesselName(i) {
  return `MV ${VESSEL_ADJ[i % VESSEL_ADJ.length]} ${VESSEL_NOUN[Math.floor(i / VESSEL_ADJ.length + i) % VESSEL_NOUN.length]}`;
}
