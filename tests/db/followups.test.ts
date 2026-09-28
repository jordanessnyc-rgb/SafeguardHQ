/** Phase 7d: proposal follow-up drafts (never sent — they wait in the Outbox). */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import * as s from "@/db/schema";
import { draftProposalFollowUps } from "@/lib/pipeline/followups";
import { createUser, hasTestDb, setupTestDb, type TestDb } from "../helpers/db";

const DAY = 86_400_000;
// Tuesday 10:00 AM New York — inside default business hours.
const now = new Date("2026-09-29T14:00:00Z");

describe.skipIf(!hasTestDb)("proposal follow-ups", () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await setupTestDb();
    await createUser(t, "OWNER");
    await t.db.insert(s.phoneLines).values({ label: "ESS main", lineKey: "ESS_MAIN", number: "+19293051232", quoPhoneNumberId: "PN1", brand: "ESS" });
  });
  afterAll(async () => t?.close());

  const proposal = async (contact: Partial<typeof s.contacts.$inferInsert>, daysAgo: number) => {
    const [c] = await t.db.insert(s.contacts).values({ firstName: "Dana", lastName: "Reyes", ...contact }).returning();
    const [p] = await t.db.insert(s.properties).values({ addressLine: "47-58 43 STREET", unit: "3B" }).returning();
    const [j] = await t.db.insert(s.jobs).values({ serviceCode: "LEAD_RA", pipelineKey: "INSPECTION", stage: "PROPOSAL_SENT", clientContactId: c.id, propertyId: p.id }).returning();
    await t.db.update(s.jobs).set({ stageEnteredAt: new Date(now.getTime() - daysAgo * DAY) }).where(eq(s.jobs.id, j.id));
    return { job: j, contact: c };
  };
  const drafts = (jobId: string) => t.db.select().from(s.outboundMessages).where(eq(s.outboundMessages.jobId, jobId));

  it("drafts a text at day 3 and again at day 7, once each, and makes a task", async () => {
    const { job } = await proposal({ phones: ["+19295550100"], emails: ["dana@example.com"] }, 4);
    expect((await draftProposalFollowUps(t.db, now)).find((o) => o.jobNumber === job.jobNumber)).toEqual({ jobNumber: job.jobNumber, step: 1, channel: "SMS" });
    expect(await draftProposalFollowUps(t.db, now)).toEqual([]); // nothing new until day 7
    const [d] = await drafts(job.id);
    expect(d).toMatchObject({ status: "DRAFT", channel: "SMS", toAddress: "+19295550100", templateKey: "PROPOSAL_FOLLOWUP" });
    expect(d.body).toContain("47-58 43 STREET, Apt 3B");
    const tasks = await t.db.select().from(s.tasks).where(eq(s.tasks.jobId, job.id));
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toContain(job.jobNumber);

    const later = new Date(now.getTime() + 6 * DAY); // the next Monday, 10 days after the proposal
    expect((await draftProposalFollowUps(t.db, later)).map((o) => o.step)).toContain(2);
    expect(await drafts(job.id)).toHaveLength(2);
    expect(await draftProposalFollowUps(t.db, new Date(later.getTime() + 30 * DAY))).toEqual([]); // only 2 steps
  });

  it("emails when there's no phone, and stops once the client has replied or can't be contacted", async () => {
    const byEmail = await proposal({ emails: ["pm@example.com"] }, 5);
    const replied = await proposal({ phones: ["+19295550101"] }, 5);
    await t.db.insert(s.activities).values({ type: "SMS", direction: "INBOUND", contactId: replied.contact.id, body: "Looks good, when can you come?", occurredAt: new Date(now.getTime() - DAY) });
    const dnc = await proposal({ phones: ["+19295550102"], doNotContact: true }, 5);

    const out = await draftProposalFollowUps(t.db, now);
    expect(out.map((o) => o.jobNumber)).toEqual([byEmail.job.jobNumber]);
    const [email] = await drafts(byEmail.job.id);
    expect(email).toMatchObject({ channel: "EMAIL", status: "DRAFT", toAddress: "pm@example.com", fromEmail: "sales@ess-nyc.com" });
    expect(email.subject).toBe("Following up: your proposal for 47-58 43 STREET, Apt 3B");
    expect(await drafts(replied.job.id)).toHaveLength(0);
    expect(await drafts(dnc.job.id)).toHaveLength(0);
  });

  it("does nothing outside business hours or when switched off", async () => {
    const { job } = await proposal({ phones: ["+19295550103"] }, 10);
    const sunday = new Date("2026-09-27T15:00:00Z");
    expect(await draftProposalFollowUps(t.db, sunday)).toEqual([]);
    await t.db.update(s.settings).set({ followUpEnabled: false });
    expect(await draftProposalFollowUps(t.db, now)).toEqual([]);
    expect(await t.db.select().from(s.outboundMessages).where(and(eq(s.outboundMessages.jobId, job.id)))).toHaveLength(0);
    await t.db.update(s.settings).set({ followUpEnabled: true });
  });
});
