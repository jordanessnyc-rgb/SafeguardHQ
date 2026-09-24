/**
 * Inbound email (SPEC §6.3) + EMSL parser. Phase 2 acceptance: "an EMSL test email attaches to the
 * right sample"; emails land on the right contact's timeline; re-delivery creates no duplicates.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { and, eq, like } from "drizzle-orm";
import MailComposer from "nodemailer/lib/mail-composer";
import * as s from "@/db/schema";
import { ingestEmail, type Uploader } from "@/lib/mail/ingest";
import { containsToken, isLikelyEmsl } from "@/lib/mail/emsl";
import { openContent } from "@/lib/comms/sensitive";
import { encryptMember } from "@/lib/airnyc/cases";
import { createUser, hasTestDb, setupTestDb, type TestDb } from "../helpers/db";

type Att = { filename: string; content: Buffer; contentType: string };
const raw = (o: { from: string; to?: string; subject: string; text: string; messageId?: string; inReplyTo?: string; attachments?: Att[] }) =>
  new MailComposer({
    from: o.from,
    to: o.to ?? "crm@ess-nyc.com",
    subject: o.subject,
    text: o.text,
    messageId: o.messageId ?? `<${randomUUID()}@test>`,
    ...(o.inReplyTo ? { inReplyTo: o.inReplyTo, references: o.inReplyTo } : {}),
    attachments: o.attachments,
  })
    .compile()
    .build();

const pdf = (name: string): Att => ({ filename: name, content: Buffer.from("%PDF-1.4 results"), contentType: "application/pdf" });

describe("EMSL helpers", () => {
  it("recognizes EMSL senders/subjects", () => {
    expect(isLikelyEmsl("results@emsl.com", "Your results")).toBe(true);
    expect(isLikelyEmsl("lab@mail.emsl.com", "x")).toBe(true);
    expect(isLikelyEmsl("someone@gmail.com", "EMSL Order 12345")).toBe(true);
    expect(isLikelyEmsl("someone@notemsl.com", "hello")).toBe(false);
  });
  it("matches whole tokens only", () => {
    expect(containsToken("Project: COC-5551, rush", "COC-5551")).toBe(true);
    expect(containsToken("Project: COC-55512", "COC-5551")).toBe(false);
    expect(containsToken("coc-5551.pdf", "COC-5551")).toBe(true);
  });
});

describe.skipIf(!hasTestDb)("ingestEmail", () => {
  let t: TestDb;
  const uploads: string[] = [];
  const storage: Uploader = { upload: async (bucket, path) => void uploads.push(`${bucket}/${path}`) };
  const ingest = (buf: Buffer) => t.db.transaction((tx) => ingestEmail(tx, buf, { mailbox: "crm@ess-nyc.com", storage }));
  let contactId: string;
  let jobId: string;
  let jobNumber: string;

  beforeAll(async () => {
    process.env.AIRNYC_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");
    t = await setupTestDb();
    await createUser(t, "OWNER");
    [{ id: contactId }] = await t.db.insert(s.contacts).values({ firstName: "Maria", lastName: "Chen", emails: ["maria@acmemgmt.com"] }).returning();
    const [prop] = await t.db.insert(s.properties).values({ addressLine: "120 WEST 44 STREET" }).returning();
    const [job] = await t.db
      .insert(s.jobs)
      .values({ serviceCode: "MOLD_ASSESS", pipelineKey: "INSPECTION", stage: "SCHEDULED", propertyId: prop.id, clientContactId: contactId })
      .returning();
    ({ id: jobId, jobNumber } = job);
  });
  afterAll(async () => t?.close());

  it("files an email on the sender's timeline and marks it for triage; re-delivery is a no-op", async () => {
    const buf = await raw({ from: "Maria Chen <Maria@AcmeMgmt.com>", subject: "Question about the inspection", text: "Can you do Tuesday?", messageId: "<m1@acme>" });
    const first = await ingest(buf);
    expect(first).toMatchObject({ duplicate: false, direction: "INBOUND", contactId });
    const again = await ingest(buf);
    expect(again).toMatchObject({ duplicate: true, activityId: first.activityId });
    const rows = await t.db.select().from(s.activities).where(eq(s.activities.externalId, "<m1@acme>"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: "EMAIL_IN", subject: "Question about the inspection", triageStatus: "PENDING" });
  });

  it("attaches to a job by job number, and attachments become job documents", async () => {
    const res = await ingest(await raw({ from: "maria@acmemgmt.com", subject: `Re: ${jobNumber} access`, text: "Super is Joe.", messageId: "<m2@acme>", attachments: [pdf("floorplan.pdf")] }));
    expect(res.jobId).toBe(jobId);
    const docs = await t.db.select().from(s.documents).where(eq(s.documents.jobId, jobId));
    expect(docs.map((d) => [d.kind, d.title])).toEqual([["OTHER", "floorplan.pdf"]]);
    expect(uploads.some((u) => u.startsWith("mail-attachments/") && u.endsWith("/floorplan.pdf"))).toBe(true);
  });

  it("threads replies onto the same job", async () => {
    const res = await ingest(await raw({ from: "maria@acmemgmt.com", subject: "Re: access", text: "Also the key is at the desk.", inReplyTo: "<m2@acme>" }));
    expect(res.jobId).toBe(jobId);
  });

  it("matches a job by the property address in the subject", async () => {
    const res = await ingest(await raw({ from: "someone@gmail.com", subject: "Mold at 120 West 44 Street", text: "Hi" }));
    expect(res.jobId).toBe(jobId);
  });

  it("ESS-sent copies are recorded as outbound, matched by recipient", async () => {
    const res = await ingest(await raw({ from: "sales@ess-nyc.com", to: "maria@acmemgmt.com", subject: "Proposal", text: "Attached." }));
    expect(res).toMatchObject({ direction: "OUTBOUND", contactId });
    const [a] = await t.db.select().from(s.activities).where(eq(s.activities.id, res.activityId!));
    expect(a).toMatchObject({ type: "EMAIL_OUT", triageStatus: "SKIPPED" });
  });

  it("AIRnyc case emails are linked to the case and stored sealed", async () => {
    const [kase] = await t.db.insert(s.airnycCases).values({ caseId: "PHS_0148", ...encryptMember({ memberName: "Ana Lopez" }) }).returning();
    const res = await ingest(await raw({ from: "cm@phsnetwork.org", subject: "PHS_0148 consent form", text: "Ana Lopez signed the tenant consent today." }));
    expect(res).toMatchObject({ airnycCaseId: kase.id, sensitive: true });
    const { rows } = await t.pool.query(`select * from activities where id = $1`, [res.activityId]);
    expect(JSON.stringify(rows[0])).not.toContain("Ana Lopez");
    expect(openContent(rows[0].sensitive_enc).body).toContain("Ana Lopez signed");
  });

  describe("EMSL results", () => {
    let labJobId: string;
    let labJobNumber: string;
    beforeAll(async () => {
      const [j] = await t.db.insert(s.jobs).values({ serviceCode: "MOLD_ASSESS", pipelineKey: "INSPECTION", stage: "FIELD_COMPLETE" }).returning();
      ({ id: labJobId, jobNumber: labJobNumber } = j);
      await t.db.insert(s.samples).values([
        { jobId: labJobId, sampleId: "A-01", type: "AIR", cocNumber: "COC-5551", status: "SUBMITTED" },
        { jobId: labJobId, sampleId: "A-02", type: "AIR", cocNumber: "COC-5552", status: "SUBMITTED" },
        { jobId: labJobId, sampleId: "A-03", type: "AIR", cocNumber: "COC-555", status: "COLLECTED" },
      ]);
      await t.db.update(s.jobs).set({ stage: "LAB_PENDING" }).where(eq(s.jobs.id, labJobId));
    });

    it("partial results: matched sample → RESULTS_IN + PDF; job stays Lab Pending while others are out", async () => {
      const res = await ingest(
        await raw({ from: "results@emsl.com", subject: "EMSL Analytical - Order 012345678 - Project COC-5551", text: "Please find attached.", attachments: [pdf("012345678_COC-5551.pdf")] }),
      );
      expect(res.emsl).toEqual({ matchedSamples: 1, jobIds: [labJobId] });
      const samples = await t.db.select().from(s.samples).where(eq(s.samples.jobId, labJobId));
      const byId = Object.fromEntries(samples.map((x) => [x.sampleId, x]));
      expect(byId["A-01"]).toMatchObject({ status: "RESULTS_IN" });
      expect(byId["A-01"].resultPdfPath).toMatch(/^mail-attachments\/.+012345678_COC-5551\.pdf$/);
      expect(byId["A-02"].status).toBe("SUBMITTED");
      expect(byId["A-03"].status).toBe("COLLECTED"); // "COC-555" is not a whole-token match
      const [job] = await t.db.select().from(s.jobs).where(eq(s.jobs.id, labJobId));
      expect(job.stage).toBe("LAB_PENDING");
      const [a] = await t.db.select().from(s.activities).where(eq(s.activities.id, res.activityId!));
      expect(a).toMatchObject({ jobId: labJobId, triageStatus: "AUTO", triageCategory: "LAB_RESULT" });
      const docs = await t.db.select().from(s.documents).where(and(eq(s.documents.jobId, labJobId), eq(s.documents.kind, "LAB_RESULT")));
      expect(docs).toHaveLength(1);
    });

    it("final results: job moves to Drafting and the owner gets a task", async () => {
      const res = await ingest(await raw({ from: "results@emsl.com", subject: "EMSL Results COC-5552", text: "", attachments: [pdf("results.pdf")] }));
      expect(res.emsl?.matchedSamples).toBe(1);
      const [job] = await t.db.select().from(s.jobs).where(eq(s.jobs.id, labJobId));
      expect(job.stage).toBe("DRAFTING");
      const tasks = await t.db.select().from(s.tasks).where(like(s.tasks.title, `Lab results in — ${labJobNumber}%`));
      expect(tasks.map((x) => x.description)).toContain("Job moved to Drafting.");
      expect(tasks.every((x) => x.assignee)).toBe(true);
    });

    it("an EMSL email matching nothing raises a manual-filing task", async () => {
      const res = await ingest(await raw({ from: "results@emsl.com", subject: "EMSL Order 999", text: "Results attached" }));
      expect(res.emsl?.matchedSamples).toBe(0);
      const [task] = await t.db.select().from(s.tasks).where(like(s.tasks.title, "EMSL email didn't match%"));
      expect(task).toBeTruthy();
    });
  });
});
