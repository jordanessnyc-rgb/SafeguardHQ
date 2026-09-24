import { describe, expect, it, vi } from "vitest";
import {
  fetchPropertyData,
  normalizeBbl,
  normalizeDobViolation,
  normalizeEcbViolation,
  normalizeHpdViolation,
  parseGeoSearch,
  parsePluto,
  pickCurrentRegistration,
  socrata,
  splitBbl,
  toIsoDate,
} from "@/lib/integrations/nyc-open-data";

// Trimmed from a live GeoSearch v2 response (2026-09-24).
const geo = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      geometry: { type: "Point", coordinates: [-73.92239, 40.73988] },
      properties: {
        name: "47-58 43 STREET",
        housenumber: "47-58",
        street: "43 STREET",
        postalcode: "11377",
        confidence: 0.8,
        borough: "Queens",
        label: "47-58 43 STREET, Sunnyside, NY, USA",
        addendum: { pad: { bbl: "4001750027", bin: "4623677", version: "26c" } },
      },
    },
    {
      type: "Feature",
      geometry: { type: "Point", coordinates: [-73.9, 40.7] },
      properties: { name: "1 NOWHERE PL", borough: "Queens", addendum: { pad: { bbl: "4000000000", bin: "4000000" } } },
    },
  ],
};

describe("GeoSearch parsing", () => {
  it("extracts BBL, BIN, coordinates, and address parts", () => {
    const [c] = parseGeoSearch(geo);
    expect(c).toMatchObject({
      addressLine: "47-58 43 STREET",
      borough: "Queens",
      zip: "11377",
      bbl: "4001750027",
      bin: "4623677",
      lat: 40.73988,
      lng: -73.92239,
    });
  });

  it("drops PAD placeholder 'million BINs'", () => {
    expect(parseGeoSearch(geo)[1].bin).toBeNull();
  });
});

describe("BBL helpers", () => {
  it("normalizes PLUTO's decimal BBLs and rejects junk", () => {
    expect(normalizeBbl("4001750027.00000000")).toBe("4001750027");
    expect(normalizeBbl(3030310015)).toBe("3030310015");
    expect(normalizeBbl("123")).toBeNull();
    expect(normalizeBbl("9001750027")).toBeNull();
  });
  it("splits into unpadded boro/block/lot (how HPD stores them)", () => {
    expect(splitBbl("4001750027")).toEqual({ boro: "4", block: "175", lot: "27" });
  });
  it("parses both Socrata date styles", () => {
    expect(toIsoDate("2014-01-06T00:00:00.000")).toBe("2014-01-06");
    expect(toIsoDate("19881031")).toBe("1988-10-31");
    expect(toIsoDate("")).toBeNull();
  });
});

describe("violation normalizers", () => {
  it("HPD open/closed comes from violationstatus", () => {
    const v = normalizeHpdViolation({
      violationid: "10081311",
      class: "C",
      ordernumber: "510",
      currentstatus: "VIOLATION CLOSED",
      violationstatus: "Close",
      novissueddate: "2014-01-06T00:00:00.000",
      novdescription: "§ 27-2005 ADM CODE  ABATE THE NUISANCE",
    });
    expect(v).toMatchObject({ source: "HPD", class: "C", isOpen: false, issuedDate: "2014-01-06" });
    expect(v.description).toBe("§ 27-2005 ADM CODE ABATE THE NUISANCE");
    expect(normalizeHpdViolation({ violationid: "1", violationstatus: "Open" }).isOpen).toBe(true);
  });

  it("DOB is open only when the category ends in ACTIVE", () => {
    const base = { isn_dob_bis_viol: "1", issue_date: "19881031", violation_type: "E-ELEVATOR   ELEVATORREQUIRED" };
    expect(normalizeDobViolation({ ...base, violation_category: "V-DOB VIOLATION - ACTIVE" }).isOpen).toBe(true);
    expect(normalizeDobViolation({ ...base, violation_category: "V*-DOB VIOLATION - DISMISSED" }).isOpen).toBe(false);
    expect(normalizeDobViolation({ ...base, violation_category: "V*-DOB VIOLATION - Resolved" }).isOpen).toBe(false);
    expect(normalizeDobViolation(base).description).toBe("E-ELEVATOR ELEVATORREQUIRED");
  });

  it("ECB is open when status is ACTIVE", () => {
    expect(normalizeEcbViolation({ ecb_violation_number: "X", ecb_violation_status: "ACTIVE" }).isOpen).toBe(true);
    expect(normalizeEcbViolation({ ecb_violation_number: "X", ecb_violation_status: "RESOLVE" }).isOpen).toBe(false);
  });
});

describe("building facts", () => {
  it("parses PLUTO and flags NYCHA ownership", () => {
    expect(parsePluto([{ bldgclass: "C1", unitsres: "10", yearbuilt: "2020", ownername: "LEOPOLD 48 LLC" }])).toEqual({
      buildingClass: "C1",
      unitsRes: 10,
      yearBuilt: 2020,
      ownerName: "LEOPOLD 48 LLC",
      isNycha: false,
    });
    expect(parsePluto([{ ownername: "NYC HOUSING AUTHORITY", yearbuilt: "0" }])).toMatchObject({ isNycha: true, yearBuilt: null });
    expect(parsePluto([])).toBeNull();
  });

  it("picks the registration with the latest end date", () => {
    const r = pickCurrentRegistration([
      { registrationid: "old", registrationenddate: "2019-09-01T00:00:00.000" },
      { registrationid: "new", registrationenddate: "2026-09-01T00:00:00.000" },
    ]);
    expect(r?.registrationid).toBe("new");
  });
});

describe("fetchPropertyData", () => {
  it("queries the right datasets by BBL/BIN and sends the app token", async () => {
    const urls: string[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      urls.push(decodeURIComponent(url).replace(/\+/g, " "));
      expect((init?.headers as Record<string, string>)["X-App-Token"]).toBe("tok");
      const body = url.includes("tesw-yqqr") ? [{ registrationid: "306068", registrationenddate: "2026-09-01" }] : [];
      return new Response(JSON.stringify(body), { status: 200 });
    });
    const res = await fetchPropertyData({ bbl: "3030310015", bin: "3327904" }, { fetch: fetchMock as never, appToken: "tok" });
    expect(res.errors).toEqual([]);
    expect(res.registration?.registrationId).toBe("306068");
    const joined = urls.join("\n");
    expect(joined).toContain("64uk-42ks.json?$where=bbl=3030310015&$order=:id&$limit=1&$offset=0");
    expect(joined).toContain("wvxf-dwi5.json?$where=bbl='3030310015'&$order=novissueddate DESC, :id&$limit=1000&$offset=0");
    expect(joined).toContain("3h2n-5cm9.json?$where=bin='3327904'");
    expect(joined).toContain("6bgk-3dad.json?$where=bin='3327904'");
    expect(joined).toContain("boroid='3' AND block='3031' AND lot='15'");
    expect(joined).toContain("feu5-w2e2.json?$where=registrationid='306068'");
  });

  it("pages with $offset until a short page, capped at MAX_ROWS", async () => {
    const offsets: number[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      const offset = Number(new URL(url).searchParams.get("$offset"));
      offsets.push(offset);
      const n = offset < 2000 ? 1000 : 10;
      return new Response(JSON.stringify(Array.from({ length: n }, (_, i) => ({ i: offset + i }))), { status: 200 });
    });
    const rows = await socrata("wvxf-dwi5", {}, { fetch: fetchMock as never });
    expect(offsets).toEqual([0, 1000, 2000]);
    expect(rows).toHaveLength(2010);
  });

  it("keeps going when one dataset fails", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.includes("wvxf-dwi5") ? new Response("boom", { status: 500 }) : new Response("[]", { status: 200 }),
    );
    const res = await fetchPropertyData({ bbl: "3030310015", bin: "3327904" }, { fetch: fetchMock as never });
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]).toMatch(/HPD violations/);
  });
});
