import { beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { decryptField, encryptField } from "@/lib/crypto";
import { formatPhone, toE164 } from "@/lib/phone";
import { DriveClient, airnycFolderName, jobFolderName } from "@/lib/integrations/google-drive";

describe("AIRnyc field encryption", () => {
  beforeAll(() => {
    process.env.AIRNYC_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  });
  it("round-trips and never stores plaintext", () => {
    const enc = encryptField("Maria Rodriguez")!;
    expect(enc).not.toContain("Maria");
    expect(enc.startsWith("v1.")).toBe(true);
    expect(decryptField(enc)).toBe("Maria Rodriguez");
  });
  it("uses a fresh IV each time", () => {
    expect(encryptField("x")).not.toBe(encryptField("x"));
  });
  it("detects tampering", () => {
    const enc = encryptField("Maria")!;
    const parts = enc.split(".");
    parts[3] = Buffer.from("Mbria").toString("base64url");
    expect(() => decryptField(parts.join("."))).toThrow();
  });
  it("passes through empty values", () => {
    expect(encryptField("")).toBeNull();
    expect(decryptField(null)).toBeNull();
  });
});

describe("phone normalization", () => {
  it.each([
    ["929-305-1232", "+19293051232"],
    ["(929) 305 1232", "+19293051232"],
    ["1 929 305 1232", "+19293051232"],
    ["+44 20 7946 0958", "+442079460958"],
    ["305-1232", null],
    ["", null],
  ])("%s → %s", (input, out) => expect(toE164(input)).toBe(out));
  it("formats US numbers", () => expect(formatPhone("+19293051232")).toBe("(929) 305-1232"));
});

describe("Drive folder naming", () => {
  it("follows {JOB_NUMBER}_{ClientLastName}_{Address}", () => {
    expect(jobFolderName("ESS-2026-0042", "O'Brien", "47-58 43rd St, Apt 3/F")).toBe("ESS-2026-0042_O'Brien_47-58 43rd St, Apt 3 F");
    expect(jobFolderName("ESS-2026-0042", null, null)).toBe("ESS-2026-0042_Client_No address");
  });
  it("follows {AIRNYC_ID}_{LastName}_{Address}", () => {
    expect(airnycFolderName("PHS_0148", "Lopez", "100 Main St")).toBe("PHS_0148_Lopez_100 Main St");
  });
});

describe("DriveClient", () => {
  const auth = { getAccessToken: async () => "tok" };
  const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });

  it("clones a template tree: folders are created, files are copied", async () => {
    const calls: { method: string; url: string; body?: unknown }[] = [];
    const tree: Record<string, { id: string; name: string; mimeType: string }[]> = {
      TEMPLATE: [
        { id: "f1", name: "Field Photos", mimeType: "application/vnd.google-apps.folder" },
        { id: "d1", name: "Checklist.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
      ],
      f1: [{ id: "d2", name: "README.txt", mimeType: "text/plain" }],
    };
    let n = 0;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const u = new URL(url);
      calls.push({ method: init?.method ?? "GET", url: u.pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      expect(u.searchParams.get("supportsAllDrives")).toBe("true");
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer tok");
      if ((init?.method ?? "GET") === "GET") {
        const q = u.searchParams.get("q")!;
        if (q.includes("name =")) return json({ files: [] });
        const parent = q.match(/'([^']+)' in parents/)![1];
        return json({ files: tree[parent] ?? [] });
      }
      return json({ id: `new${++n}`, name: "x", mimeType: "x" });
    });
    const drive = new DriveClient(auth, fetchMock as never);
    const res = await drive.ensureFolderFromTemplate({ name: "ESS-2026-0001_Lee_1 Main St", parentId: "PARENT", templateId: "TEMPLATE" });
    expect(res).toEqual({ id: "new1", url: "https://drive.google.com/drive/folders/new1", created: true });
    const writes = calls.filter((c) => c.method === "POST");
    expect(writes.map((w) => [w.url, w.body])).toEqual([
      ["/drive/v3/files", { name: "ESS-2026-0001_Lee_1 Main St", mimeType: "application/vnd.google-apps.folder", parents: ["PARENT"] }],
      ["/drive/v3/files", { name: "Field Photos", mimeType: "application/vnd.google-apps.folder", parents: ["new1"] }],
      ["/drive/v3/files/d2/copy", { name: "README.txt", parents: ["new2"] }],
      ["/drive/v3/files/d1/copy", { name: "Checklist.docx", parents: ["new1"] }],
    ]);
  });

  it("reuses an existing folder on retry instead of duplicating", async () => {
    const fetchMock = vi.fn(async () => json({ files: [{ id: "existing", name: "n", mimeType: "application/vnd.google-apps.folder" }] }));
    const drive = new DriveClient(auth, fetchMock as never);
    const res = await drive.ensureFolderFromTemplate({ name: "n", parentId: "P", templateId: "T" });
    expect(res).toMatchObject({ id: "existing", created: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

import { fromNyInput, toNyInput } from "@/lib/time";

describe("New York time inputs", () => {
  it("interprets form values as New York wall-clock time (EDT and EST)", () => {
    expect(fromNyInput("2026-10-01T10:00").toISOString()).toBe("2026-10-01T14:00:00.000Z");
    expect(fromNyInput("2026-12-01T10:00").toISOString()).toBe("2026-12-01T15:00:00.000Z");
    expect(fromNyInput("2026-12-01").toISOString()).toBe("2026-12-01T22:00:00.000Z"); // default 5pm
  });
  it("round-trips", () => {
    expect(toNyInput(fromNyInput("2026-03-08T09:30"))).toBe("2026-03-08T09:30");
    expect(toNyInput(null)).toBe("");
  });
});
