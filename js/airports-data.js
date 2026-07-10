// OurAirports data loader: reads committed JSON from the data pipeline
// (scripts/data/update-airports.mjs → data/airports.latest.json).
// Used by the flights layer to resolve ICAO codes to named coordinates.

const AIRPORTS_URL = "data/airports.latest.json";

let airportsData = null;
let loaded = false;

export async function loadAirportsData() {
  if (loaded) return airportsData;
  loaded = true;
  try {
    const resp = await fetch(AIRPORTS_URL);
    if (!resp.ok) throw new Error(`${AIRPORTS_URL} HTTP ${resp.status}`);
    airportsData = await resp.json();
  } catch (e) {
    console.warn("[airports] data load failed:", e.message);
    airportsData = null;
  }
  return airportsData;
}

// Resolve an ICAO ident to { lon, lat, name, country, municipality } or null.
export function lookupAirport(ident) {
  if (!airportsData?.airports || !ident) return null;
  const arr = airportsData.airports[ident];
  if (!arr) return null;
  return { lon: arr[0], lat: arr[1], name: arr[2], country: arr[3], municipality: arr[4] };
}
