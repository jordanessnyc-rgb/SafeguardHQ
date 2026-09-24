/** Quote builder, proposal output and sub copy documents (SPEC §10). */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { Document, HeadingLevel, Packer, Paragraph, TextRun } from "docx";
import * as s from "@/db/schema";
import { computeQuote } from "@/lib/money/quote";
import { generateProposal } from "@/lib/docs/proposal";
import { createSubCopy } from "@/lib/docs/sub-copy-job";
import { docxText } from "@/lib/docs/render";
import { createUser, hasTestDb, setupTestDb, type TestDb, type TestUser } from "../helpers/db";

const rule = { baseAmount: "450.00", includedSqft: 1000, perSqft: "0.25", includedSamples: 2, perSample: "95.00", minimumAmount: "500.00" };

describe("computeQuote", () => {
  it("base + area over the included sq ft + samples over the included count", () => {
    const q = computeQuote("Mold assessment", rule, { sqft: 1800, samples: 5, extras: [{ description: "Rush report", quantity: 1, unitPrice: 150 }] });
    expect(q.lines).toEqual([
      { description: "Mold assessment", quantity: 1, unitPrice: 450 },
      { description: "Additional area (800 sq ft over 1,000)", quantity: 800, unitPrice: 0.25 },
      { description: "Additional samples (over 2 included)", quantity: 3, unitPrice: 95 },
      { description: "Rush report", quantity: 1, unitPrice: 150 },
    ]);
    expect(q.total).toBe(1085);
  });
  it("applies the minimum; without a rule only hand-entered lines are priced", () => {
    const small = computeQuote("Mold assessment", { ...rule, baseAmount: "300.00" }, { sqft: 500, samples: 1 });
    expect(small.total).toBe(500);
    expect(small.lines.at(-1)).toEqual({ description: "Minimum service charge adjustment", quantity: 1, unitPrice: 200 });
    const none = computeQuote("LL152 gas piping", null, { extras: [{ description: "Inspection", quantity: 1, unitPrice: 700 }] });
    expect(none.total).toBe(700);
    expect(none.notes[0]).toMatch(/No pricing rule/);
  });
});

describe.skipIf(!hasTestDb)("proposals + sub copies (database)", () => {
  let t: TestDb;
  let owner: TestUser;
  let va: TestUser;
  const files = new Map<string, Buffer>();
  const storage = {
    upload: async (bucket: string, path: string, data: Buffer) => void files.set(`${bucket}/${path}`, data),
    download: async (bucket: string, path: string) => files.get(`${bucket}/${path}`)!,
  };

  beforeAll(async () => {
    t = await setupTestDb();
    owner = await createUser(t, "OWNER");
    va = await createUser(t, "VA");
  });
  afterAll(async () => t?.close());

  it("pricing rules are owner-only (RLS)", async () => {
    await owner.as((tx) => tx.insert(s.pricingRules).values({ serviceCode: "MOLD_ASSESS", ...rule, defaultScope: "Visual inspection and moisture mapping of affected areas." }));
    expect(await va.as((tx) => tx.select().from(s.pricingRules))).toHaveLength(0);
    await expect(va.as((tx) => tx.insert(s.pricingRules).values({ serviceCode: "LL152", baseAmount: "1" }))).rejects.toThrow();
  });

  it("renders a priced proposal into the owner-only bucket with a client-only signature block", async () => {
    const [contact] = await t.db.insert(s.contacts).values({ firstName: "Pat", lastName: "Lee" }).returning();
    const [prop] = await t.db.insert(s.properties).values({ addressLine: "420 CENTRAL PARK WEST", unit: "2E", borough: "Manhattan", zip: "10025" }).returning();
    const [job] = await t.db.insert(s.jobs).values({ serviceCode: "MOLD_ASSESS", pipelineKey: "INSPECTION", stage: "QUALIFIED", clientContactId: contact.id, propertyId: prop.id }).returning();
    await expect(generateProposal(t.db, job.id, storage)).rejects.toThrow(/Build the quote first/);
    const q = computeQuote("Mold assessment", rule, { sqft: 1200, samples: 3 });
    await t.db.insert(s.jobFinancials).values({ jobId: job.id, lineItems: q.lines, quotedAmount: q.total.toFixed(2), quoteInputs: { sqft: 1200, samples: 3, validDays: 45 } });

    const r = await generateProposal(t.db, job.id, storage, new Date("2026-09-24T15:00:00Z"));
    expect(r.placeholder).toBe(true);
    const [doc] = await t.db.select().from(s.documents).where(eq(s.documents.id, r.documentId));
    expect(doc).toMatchObject({ kind: "PROPOSAL", status: "DRAFT", containsPricing: true, storageBucket: "job-files-pricing", version: 1 });
    const text = docxText(files.get(`job-files-pricing/${r.storagePath}`)!);
    expect(text).toContain(`Proposal ${job.jobNumber}-P1`);
    expect(text).toContain("September 24, 2026");
    expect(text).toContain("Pat Lee");
    expect(text).toContain("420 CENTRAL PARK WEST, Apt 2E, Manhattan, 10025");
    expect(text).toContain("Visual inspection and moisture mapping");
    expect(text).toContain("Additional area (200 sq ft over 1,000)");
    expect(text).toContain("$595.00"); // 450 + 50 + 95
    expect(text).toContain("valid for 45 days");
    expect(await va.as((tx) => tx.select().from(s.documents).where(eq(s.documents.id, r.documentId)))).toHaveLength(0);
  });

  it("sub copy: created from a clean result; blocked (nothing saved) when validation finds pricing left", async () => {
    const [job] = await t.db.insert(s.jobs).values({ serviceCode: "MOLD_PLAN", pipelineKey: "INSPECTION", stage: "DRAFTING" }).returning();
    const report = new Document({
      sections: [
        {
          children: [
            new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun("Remediation scope")] }),
            new Paragraph("Remove drywall in bathroom."),
            new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun("Fees")] }),
            new Paragraph("$1,200 for the work plan."),
          ],
        },
      ],
      footnotes: {},
    });
    files.set("job-files/r1.docx", Buffer.from(await Packer.toBuffer(report)));
    const [rep] = await t.db.insert(s.documents).values({ jobId: job.id, kind: "REPORT", status: "FINAL", title: "Work plan.docx", storageBucket: "job-files", storagePath: "r1.docx" }).returning();
    const ok = await createSubCopy(t.db, rep.id, storage);
    expect(ok).toMatchObject({ status: "created", removed: expect.arrayContaining(["[section] Fees"]) });
    const [sub] = await t.db.select().from(s.documents).where(eq(s.documents.id, (ok as { documentId: string }).documentId));
    expect(sub).toMatchObject({ kind: "SUB_COPY", status: "DRAFT", containsPricing: false, storageBucket: "job-files", title: "Sub copy — Work plan.docx" });
    const subText = docxText(files.get(`job-files/${sub.storagePath}`)!);
    expect(subText).toContain("Remediation scope\nRemove drywall in bathroom.");
    expect(subText).not.toMatch(/Fees|\$/);

    const dirty = new Document({ footnotes: { 1: { children: [new Paragraph("Invoice to follow.")] } }, sections: [{ children: [new Paragraph("Scope.")] }] });
    files.set("job-files/r2.docx", Buffer.from(await Packer.toBuffer(dirty)));
    const [rep2] = await t.db.insert(s.documents).values({ jobId: job.id, kind: "REPORT", storageBucket: "job-files", storagePath: "r2.docx" }).returning();
    expect(await createSubCopy(t.db, rep2.id, storage)).toMatchObject({ status: "blocked", violations: ["Invoice to follow."] });
    expect(await t.db.select().from(s.documents).where(eq(s.documents.kind, "SUB_COPY"))).toHaveLength(1);
  });
});
