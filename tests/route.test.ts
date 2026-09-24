import { describe, expect, it } from "vitest";
import { estimateMinutes, haversineMiles, mapsUrl, OFFICE, orderStops } from "@/lib/route/plan";

const stop = (id: string, lat: number, lng: number) => ({ id, label: id, lat, lng });

describe("route planning (approximate)", () => {
  it("measures distance", () => {
    expect(haversineMiles(OFFICE, { lat: 40.758, lng: -73.9855 })).toBeCloseTo(3.5, 0); // Times Square ≈ 3.5 mi
  });
  it("finds the shortest round trip from the office (checked against brute force)", () => {
    const stops = [stop("astoria", 40.7644, -73.9235), stop("lic", 40.7447, -73.9485), stop("williamsburg", 40.7081, -73.9571), stop("bronx", 40.8448, -73.8648), stop("jamaica", 40.7027, -73.7889)];
    const loop = (order: typeof stops) => order.reduce((d, s, i) => d + haversineMiles(i ? order[i - 1] : OFFICE, s), 0) + haversineMiles(order[order.length - 1], OFFICE);
    const perms = (a: typeof stops): (typeof stops)[] => (a.length <= 1 ? [a] : a.flatMap((x, i) => perms([...a.slice(0, i), ...a.slice(i + 1)]).map((p) => [x, ...p])));
    const best = Math.min(...perms(stops).map(loop));
    expect(loop(orderStops(stops, OFFICE, { returnToStart: true }))).toBeCloseTo(best, 6);
    expect(orderStops([])).toEqual([]);
  });
  it("estimates minutes and builds a keyless Maps link", () => {
    expect(estimateMinutes(0)).toBe(5);
    expect(estimateMinutes(3)).toBe(26);
    const url = new URL(mapsUrl([stop("a", 40.7, -73.9), stop("b", 40.8, -73.95)]));
    expect(url.searchParams.get("waypoints")).toBe("40.7,-73.9|40.8,-73.95");
    expect(url.searchParams.get("origin")).toBe(`${OFFICE.lat},${OFFICE.lng}`);
  });
});
