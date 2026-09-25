/**
 * Route planning (SPEC §10, Phase 5) — the free, approximate version Jordan chose: order a day's
 * inspections by straight-line distance from the office (nearest neighbour, then 2-opt), with a
 * rough drive-time estimate and a Google Maps directions link (no API key, no cost). Not traffic-aware.
 */

/** 47-58 43rd Street, Queens, NY 11377 (GeoSearch, 2026-09-24). */
export const OFFICE = { label: "ESS office (Sunnyside)", lat: 40.73988, lng: -73.92239 };

export type Stop = { id: string; label: string; lat: number; lng: number };

export function haversineMiles(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 3958.8;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const pathLength = (start: { lat: number; lng: number }, stops: Stop[], returnTo?: { lat: number; lng: number }) =>
  stops.reduce((sum, s, i) => sum + haversineMiles(i === 0 ? start : stops[i - 1], s), 0) + (returnTo && stops.length ? haversineMiles(stops[stops.length - 1], returnTo) : 0);

/** Nearest-neighbour tour from `start`, improved with 2-opt. Deterministic. */
export function orderStops(stops: Stop[], start: { lat: number; lng: number } = OFFICE, opts: { returnToStart?: boolean } = {}): Stop[] {
  const rest = [...stops];
  const tour: Stop[] = [];
  let here = start;
  while (rest.length) {
    let best = 0;
    for (let i = 1; i < rest.length; i++) if (haversineMiles(here, rest[i]) < haversineMiles(here, rest[best])) best = i;
    here = rest[best];
    tour.push(...rest.splice(best, 1));
  }
  const back = opts.returnToStart ? start : undefined;
  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 0; i < tour.length - 1; i++) {
      for (let k = i + 1; k < tour.length; k++) {
        const candidate = [...tour.slice(0, i), ...tour.slice(i, k + 1).reverse(), ...tour.slice(k + 1)];
        if (pathLength(start, candidate, back) + 1e-9 < pathLength(start, tour, back)) {
          tour.splice(0, tour.length, ...candidate);
          improved = true;
        }
      }
    }
  }
  return tour;
}

/** Rough NYC drive time: straight-line × 1.4 road factor at ~12 mph, plus 5 minutes to park. */
export const estimateMinutes = (miles: number) => Math.round(((miles * 1.4) / 12) * 60 + 5);

export function legs(stops: Stop[], start: { lat: number; lng: number } = OFFICE) {
  return stops.map((s, i) => {
    const miles = haversineMiles(i === 0 ? start : stops[i - 1], s);
    return { stop: s, miles: Math.round(miles * 10) / 10, minutes: estimateMinutes(miles) };
  });
}

/** Google Maps directions URL (public URL scheme — no key). Office → stops in order → office. */
export function mapsUrl(stops: Stop[], start: { lat: number; lng: number } = OFFICE): string {
  const pt = (p: { lat: number; lng: number }) => `${p.lat},${p.lng}`;
  const q = new URLSearchParams({ api: "1", origin: pt(start), destination: pt(start), travelmode: "driving" });
  if (stops.length) q.set("waypoints", stops.map(pt).join("|"));
  return `https://www.google.com/maps/dir/?${q}`;
}
