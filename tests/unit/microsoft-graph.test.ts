import { describe, expect, it, vi } from "vitest";
import ExcelJS from "exceljs";
import { GraphClient, parseSharePointUrl } from "@/lib/integrations/microsoft-graph";
import { guessColumns, readTracker, rowsToCases } from "@/lib/airnyc/tracker";

describe("parseSharePointUrl", () => {
  it("takes a browser-bar file address apart", () => {
    expect(parseSharePointUrl("https://airnyc.sharepoint.com/sites/Vendors/Shared%20Documents/ESS/ESS%20Tracker.xlsx")).toEqual({
      hostname: "airnyc.sharepoint.com",
      sitePath: "/sites/Vendors",
      library: "Shared Documents",
      itemPath: "ESS/ESS Tracker.xlsx",
    });
  });
  it("reads a library view's ?id= path and treats the library's own view as its root", () => {
    expect(parseSharePointUrl("https://airnyc.sharepoint.com/sites/Vendors/Shared%20Documents/Forms/AllItems.aspx?id=%2Fsites%2FVendors%2FShared%20Documents%2FESS%2FCases").itemPath).toBe("ESS/Cases");
    expect(parseSharePointUrl("https://airnyc.sharepoint.com/teams/ESS/Documents/Forms/AllItems.aspx").itemPath).toBe("");
  });
  it("rejects sharing links and non-SharePoint addresses with plain messages", () => {
    expect(() => parseSharePointUrl("https://airnyc.sharepoint.com/:x:/s/Vendors/EabcdEF?e=12")).toThrow(/sharing link/);
    expect(() => parseSharePointUrl("https://1drv.ms/x/abc")).toThrow(/sharepoint\.com/);
    expect(() => parseSharePointUrl("not a url")).toThrow(/web address/);
  });
});

/** A fake Microsoft: token endpoint, one site with one library, a tracker file and a folder. */
function fakeGraph() {
  const calls: { method: string; url: string; auth: string | null; body?: unknown }[] = [];
  let tokens = 0;
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ method: init?.method ?? "GET", url, auth: headers.Authorization ?? null, body: init?.body });
    const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
    if (url.includes("/oauth2/v2.0/token")) return json({ access_token: `tok${++tokens}`, expires_in: 3600 });
    if (url.endsWith("/sites/airnyc.sharepoint.com:/sites/Vendors")) return json({ id: "site1", webUrl: "https://airnyc.sharepoint.com/sites/Vendors", displayName: "Vendors" });
    if (url.includes("/sites/site1/drives")) return json({ value: [{ id: "drv1", name: "Documents", webUrl: "https://airnyc.sharepoint.com/sites/Vendors/Shared%20Documents" }] });
    if (url.includes("/drives/drv1/root:/ESS/Tracker.xlsx")) return json({ id: "f1", name: "Tracker.xlsx", webUrl: "https://airnyc.sharepoint.com/sites/Vendors/Shared%20Documents/ESS/Tracker.xlsx", file: {} });
    if (url.endsWith("/drives/drv1/items/f1/content")) return new Response(null, { status: 302, headers: { location: "https://cdn.example/dl" } });
    if (url === "https://cdn.example/dl") return new Response("xlsx-bytes");
    if (url.includes("/drives/drv1/items/root1/children") && (init?.method ?? "GET") === "GET") return json({ value: [{ id: "c1", name: "PHS_0148_Lopez", webUrl: "https://x/c1", folder: {} }] });
    if (url.includes(":/report.pdf:/content")) return json({ id: "up1", name: "report.pdf", webUrl: "https://x/up1", file: {} }, 201);
    if (url.includes("/throttled")) return new Response("", { status: 429, headers: { "retry-after": "0" } });
    return json({ error: { code: "itemNotFound", message: "no such thing" } }, 404);
  });
  return { client: new GraphClient({ tenantId: "t", clientId: "c", clientSecret: "s" }, fetchImpl as unknown as typeof fetch), calls, fetchImpl };
}

describe("GraphClient", () => {
  it("signs in once, resolves an address by path, and downloads via the redirect without the bearer token", async () => {
    const { client, calls } = fakeGraph();
    const item = await client.itemByUrl("https://airnyc.sharepoint.com/sites/Vendors/Shared%20Documents/ESS/Tracker.xlsx");
    expect(item).toMatchObject({ id: "f1", driveId: "drv1" });
    const bytes = await client.download("drv1", "f1");
    expect(bytes.toString()).toBe("xlsx-bytes");
    expect(calls.filter((c) => c.url.includes("/oauth2/"))).toHaveLength(1);
    const token = calls.find((c) => c.url.includes("/oauth2/"))!;
    expect(String(token.body)).toContain("grant_type=client_credentials");
    expect(String(token.body)).toContain("scope=https%3A%2F%2Fgraph.microsoft.com%2F.default");
    expect(calls.find((c) => c.url === "https://cdn.example/dl")!.auth).toBeNull();
    expect(calls.filter((c) => c.url.startsWith("https://graph.microsoft.com")).every((c) => c.auth === "Bearer tok1")).toBe(true);
  });

  it("uploads into a folder by name and surfaces Graph errors readably", async () => {
    const { client, calls } = fakeGraph();
    const up = await client.upload("drv1", "c1", "report.pdf", Buffer.from("%PDF"), "application/pdf");
    expect(up.webUrl).toBe("https://x/up1");
    expect(calls.at(-1)!.url).toContain("/drives/drv1/items/c1:/report.pdf:/content?@microsoft.graph.conflictBehavior=replace");
    await expect(client.children("drv1", "nope")).rejects.toThrow(/Microsoft 404 itemNotFound: no such thing/);
  });

  it("explains a missing library", async () => {
    const { client } = fakeGraph();
    await expect(client.itemByUrl("https://airnyc.sharepoint.com/sites/Vendors/Other%20Library/x.xlsx")).rejects.toThrow(/No document library called "Other Library"/);
  });
});

async function workbook(rows: (string | number | null)[][], sheetName = "Tracker"): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName);
  rows.forEach((r) => ws.addRow(r));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe("tracker reading", () => {
  it("finds the header row, guesses columns and turns rows into cases", async () => {
    const buf = await workbook([
      ["ESS referrals — October", null, null],
      ["Case ID", "Member Name", "Home Address", "Phone", "Case Manager", "CM Email", "Approved Services", "Status", "NYCHA?"],
      ["PHS_0148", "Ana Lopez", "120 West 44 Street 4B", "212-555-0101", "Dee Park", "DPark@phs.org", "2.2a Mold; 2.3b Asthma", "Referral received", "Y"],
      [null, "", "", "", "", "", "", "", ""],
      ["Emblem_0022", "Luis Ortiz", "77 Pine St", "", "", "", "", "Scheduled", "no"],
      ["", "no id here", "", "", "", "", "", "", ""],
    ]);
    const sheet = await readTracker(buf);
    expect(sheet.sheet).toBe("Tracker");
    expect(sheet.headers).toEqual(["Case ID", "Member Name", "Home Address", "Phone", "Case Manager", "CM Email", "Approved Services", "Status", "NYCHA?"]);
    expect(sheet.rows.map((r) => r.row)).toEqual([3, 5, 6]);
    const map = guessColumns(sheet.headers);
    expect(map).toMatchObject({ caseId: "Case ID", memberName: "Member Name", address: "Home Address", memberPhone: "Phone", caseManagerName: "Case Manager", caseManagerEmail: "CM Email", approvedServices: "Approved Services", status: "Status", isNycha: "NYCHA?" });
    const { cases, skipped } = rowsToCases(sheet.rows, map);
    expect(skipped).toBe(1);
    expect(cases[0]).toMatchObject({ row: 3, caseId: "PHS_0148", memberName: "Ana Lopez", caseManagerEmail: "dpark@phs.org", approvedServices: ["2.2a Mold", "2.3b Asthma"], status: "Referral received", isNycha: true });
    expect(cases[1]).toMatchObject({ row: 5, caseId: "Emblem_0022", memberPhone: null, isNycha: false, approvedServices: [] });
  });

  it("reads a named sheet and lists the others", async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet("Notes").addRow(["just text"]);
    const ws = wb.addWorksheet("Cases");
    ws.addRow(["Case ID", "Status"]);
    ws.addRow(["SIPPS_7", "Done"]);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const sheet = await readTracker(buf, "Cases");
    expect(sheet.sheets).toEqual(["Notes", "Cases"]);
    expect(sheet.rows).toEqual([{ row: 2, cells: { "Case ID": "SIPPS_7", Status: "Done" } }]);
  });
});
