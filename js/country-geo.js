// Shared country-boundary dataset (public-domain world.geo.json, simplified
// outlines keyed by ISO3). Fetched once and reused by the choropleth
// heat-map, the true-size comparison overlays, and the country search.
// Each feature: { id, name, rings, bbox } where rings mixes outer rings and
// holes (even-odd tests sort them out) and bbox is [w, s, e, n] in degrees.

import { GEOJSON_URL } from "./country-data.js";

const R_KM = 6371.0088; // mean Earth radius

let geoPromise = null;

export function loadCountryGeo() {
  geoPromise ??= fetchGeo().catch((e) => {
    geoPromise = null; // allow a later retry
    throw e;
  });
  return geoPromise;
}

async function fetchGeo() {
  const resp = await fetch(GEOJSON_URL);
  if (!resp.ok) throw new Error(`geojson ${resp.status}`);
  const gj = await resp.json();
  return gj.features.map((f) => {
    const g = f.geometry;
    const polys = g.type === "Polygon" ? [g.coordinates]
      : g.type === "MultiPolygon" ? g.coordinates : [];
    const rings = polys.flat(); // outer rings + holes; even-odd fill sorts them out
    let w = 180, e = -180, s = 90, n = -90;
    for (const ring of rings) {
      for (const [lon, lat] of ring) {
        if (lon < w) w = lon;
        if (lon > e) e = lon;
        if (lat < s) s = lat;
        if (lat > n) n = lat;
      }
    }
    return { id: f.id, name: f.properties?.name ?? f.id, rings, bbox: [w, s, e, n] };
  });
}

export function countryAt(geo, lat, lon) {
  if (!geo) return null;
  for (const f of geo) {
    const [w, s, e, n] = f.bbox;
    if (lat < s || lat > n || lon < w || lon > e) continue;
    let inside = false;
    for (const ring of f.rings) {
      if (pointInRing(lon, lat, ring)) inside = !inside; // even-odd (handles holes)
    }
    if (inside) return f;
  }
  return null;
}

// ray-casting point-in-ring test (lon/lat degrees)
export function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

// Spherical polygon area (Chamberlain & Duquette). Signed ring sums, so
// oppositely-wound holes subtract; the simplified outlines under-count a
// little versus official figures.
export function countryAreaKm2(f) {
  let total = 0;
  for (const ring of f.rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      let dLon = ring[i][0] - ring[j][0];
      if (dLon > 180) dLon -= 360;
      else if (dLon < -180) dLon += 360;
      total += toRad(dLon) * (2 + Math.sin(toRad(ring[j][1])) + Math.sin(toRad(ring[i][1])));
    }
  }
  return (Math.abs(total) / 2) * R_KM * R_KM;
}

export function formatArea(km2) {
  const v = km2 >= 1000 ? Number(km2.toPrecision(3)) : Math.round(km2);
  return `${v.toLocaleString("en-US")} km²`;
}

function toRad(d) {
  return (d * Math.PI) / 180;
}
