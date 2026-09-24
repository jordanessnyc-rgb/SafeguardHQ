/** AI report drafting (SPEC §9.5) with a mocked Anthropic client and in-memory storage. */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import PizZip from "pizzip";
import * as s from "@/db/schema";
import type { AnthropicLike } from "@/lib/ai/anthropic";
import { draftReport } from "@/lib/ai/report";
import { docxText } from "@/lib/docs/render";
import { imageSize } from "@/lib/docs/image-size";
import { createUser, hasTestDb, setupTestDb, type TestDb } from "../helpers/db";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

describe("imageSize", () => {
  it("reads PNG dimensions", () => expect(imageSize(PNG)).toEqual({ width: 1, height: 1, ext: "png" }));
});

describe.skipIf(!hasTestDb)("AI report drafting (database)", () => {
  let t: TestDb;
  const files = new Map<string, Buffer>([["job-files/jobs/p1.png", PNG]]);
  const storage = { upload: async (b: string, p: string, d: Buffer) => void files.set(`${b}/${p}`, d), download: async (b: string, p: string) => files.get(`${b}/${p}`)! };
  const fake = (output: unknown) => {
    const parse = vi.fn(async (_req: unknown) => ({ parsed_output: output, stop_reason: "end_turn", usage: { input_tokens: 5000, output_tokens: 2000 } }));
    return { api: { messages: { parse } } as unknown as AnthropicLike, parse };
  };

  beforeAll(async () => {
    process.env.AIRNYC_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");
    t = await setupTestDb();
    await createUser(t, "OWNER");
  });
  afterAll(async () => t?.close());

  it("skips when there's nothing to write from", async () => {
    const [job] = await t.db.insert(s.jobs).values({ serviceCode: "MOLD_ASSESS", pipelineKey: "INSPECTION", stage: "DRAFTING" }).returning();
    const f = fake({});
    expect((await draftReport(t.db, job.id, { storage, api: f.api })).status).toBe("skipped");
    expect(f.parse).not.toHaveBeenCalled();
  });

  it("drafts sections from field data + samples into the template, embeds photos, opens a review task", async () => {
    const [org] = await t.db.insert(s.organizations).values({ name: "Parkview Realty" }).returning();
    const [prop] = await t.db.insert(s.properties).values({ addressLine: "420 CENTRAL PARK WEST", unit: "2E", borough: "Manhattan" }).returning();
    const [job] = await t.db.insert(s.jobs).values({ serviceCode: "MOLD_ASSESS", pipelineKey: "INSPECTION", stage: "DRAFTING", propertyId: prop.id, clientOrgId: org.id }).returning();
    await t.db.insert(s.jobFinancials).values({ jobId: job.id, quotedAmount: "1850.00" });
    await t.db.insert(s.fieldData).values({
      jobId: job.id,
      areas: ["Bathroom", "Bedroom 2"],
      observations: "Bathroom: visible growth on ceiling above shower, ~6 sq ft.",
      readings: [{ area: "Bathroom", moisture: "28", rh: "71", temp: "72", note: "north wall" }],
      photos: [{ path: "jobs/p1.png", caption: "Ceiling above shower", area: "Bathroom", contentType: "image/png", width: 1, height: 1 }],
    });
    await t.db.insert(s.samples).values({ jobId: job.id, sampleId: "S1", type: "AIR", location: "Bathroom", status: "RESULTS_IN" });

    const f = fake({
      sections: [
        { key: "summary", title: "Summary of findings", body: "Visible mold growth was observed on the bathroom ceiling." },
        { key: "observations", title: "Observations by area", body: "- Bathroom: growth above shower (Photo 1). Moisture 28%." },
        { key: "recommendations", title: "Recommendations", body: "- Remove affected drywall [Jordan: review]" },
      ],
      open_questions: ["[Jordan: confirm the square footage]"],
    });
    const r = await draftReport(t.db, job.id, { storage, api: f.api }, new Date("2026-09-24T15:00:00Z"));
    expect(r).toMatchObject({ status: "drafted", openQuestions: ["[Jordan: confirm the square footage]"], placeholder: true });

    const req = JSON.stringify(f.parse.mock.calls[0][0]);
    expect(req).toContain("claude-opus-5");
    expect(req).toContain("visible growth on ceiling above shower");
    expect(req).toContain("Bathroom | 28 | 71 | 72 | north wall");
    expect(req).toContain("1. [Bathroom] Ceiling above shower");
    expect(req).toContain("S1 | AIR | Bathroom | status RESULTS_IN");
    expect(req).not.toContain("1850"); // no pricing in the AI input
    expect(req).not.toContain("Parkview"); // client name isn't needed by the model

    const [doc] = await t.db.select().from(s.documents).where(eq(s.documents.id, (r as { documentId: string }).documentId));
    expect(doc).toMatchObject({ kind: "REPORT", status: "DRAFT", containsPricing: false, storageBucket: "job-files", title: `Report draft ${job.jobNumber} v1.docx` });
    const out = files.get(`job-files/${doc.storagePath}`)!;
    const text = docxText(out);
    expect(text).toContain("AI DRAFT — for Jordan Adhami's review");
    expect(text).toContain("Mold assessment Report");
    expect(text).toContain("Summary of findings\nVisible mold growth was observed");
    expect(text).toContain("Scope of assessment\n[Jordan: section not drafted]"); // a skipped section stays visible
    expect(text).toContain("Photo 1: Bathroom — Ceiling above shower");
    expect(text).toContain("Parkview Realty");
    expect(text).toContain("[ESS standard limitations language — Jordan to provide]");
    expect(new PizZip(out).file("word/media/ess_photo_1.png")).toBeTruthy();

    const [task] = await t.db.select().from(s.tasks).where(eq(s.tasks.jobId, job.id));
    expect(task.title).toBe(`Review the AI report draft for ${job.jobNumber}`);
    expect(task.description).toContain("confirm the square footage");
  });

  it("AIRnyc jobs are blocked while AIRnyc AI is off", async () => {
    const [kase] = await t.db.insert(s.airnycCases).values({ caseId: "PHS_0999", network: "PHS" }).returning();
    const [job] = await t.db.insert(s.jobs).values({ serviceCode: "AIRNYC", pipelineKey: "INSPECTION", stage: "DRAFTING", airnycCaseId: kase.id }).returning();
    await t.db.insert(s.fieldData).values({ jobId: job.id, observations: "Mold in bedroom." });
    const f = fake({ sections: [], open_questions: [] });
    expect((await draftReport(t.db, job.id, { storage, api: f.api })).status).toBe("blocked");
    expect(f.parse).not.toHaveBeenCalled();
  });
});
