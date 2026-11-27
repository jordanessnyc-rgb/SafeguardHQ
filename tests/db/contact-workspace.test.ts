/** Contact page workspace: conversation order, notes search, tasks, appointments, documents (RLS), DND. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as s from "@/db/schema";
import { loadContactWorkspace } from "@/lib/contacts/workspace";
import { createUser, hasTestDb, setupTestDb, type TestDb, type TestUser } from "../helpers/db";

describe.skipIf(!hasTestDb)("contact workspace", () => {
  let t: TestDb;
  let owner: TestUser;
  let va: TestUser;
  let contactId: string;
  let jobNumber: string;
  const now = new Date("2026-11-27T16:00:00Z");

  beforeAll(async () => {
    t = await setupTestDb();
    owner = await createUser(t, "OWNER");
    va = await createUser(t, "VA");
    const [c] = await t.db.insert(s.contacts).values({ firstName: "Dana", lastName: "Reyes", emails: ["dana@acme.test"] }).returning();
    contactId = c.id;
    const [j] = await t.db.insert(s.jobs).values({ serviceCode: "LL152", pipelineKey: "INSPECTION", stage: "SCHEDULED", clientContactId: c.id, scheduledAt: new Date("2026-11-28T14:00:00Z") }).returning();
    jobNumber = j.jobNumber;
    const [past] = await t.db.insert(s.jobs).values({ serviceCode: "MOLD_ASSESS", pipelineKey: "INSPECTION", stage: "SCHEDULED", clientContactId: c.id, scheduledAt: new Date("2026-10-02T14:00:00Z") }).returning();
    await t.db.insert(s.activities).values([
      { type: "EMAIL_IN", direction: "INBOUND", contactId: c.id, subject: "Second", occurredAt: new Date("2026-11-20T10:00:00Z") },
      { type: "EMAIL_IN", direction: "INBOUND", contactId: c.id, subject: "First", occurredAt: new Date("2026-11-10T10:00:00Z") },
      { type: "STAGE_CHANGE", direction: "INTERNAL", contactId: c.id, subject: "not a message" },
      { type: "NOTE", direction: "INTERNAL", contactId: c.id, body: "Super is Luis" },
      { type: "NOTE", direction: "INTERNAL", jobId: j.id, body: "Gas shut-off needs 24h notice" },
    ]);
    await t.db.insert(s.tasks).values([{ title: "Confirm access", contactId: c.id }, { title: "Old", jobId: j.id, status: "DONE" }, { title: "Dropped", contactId: c.id, status: "CANCELED" }]);
    await t.db.insert(s.documents).values([
      { jobId: past.id, kind: "REPORT", title: "Mold report", storagePath: "r.pdf", storageBucket: "job-files" },
      { jobId: j.id, kind: "PROPOSAL", title: "Priced proposal", storagePath: "p.pdf", storageBucket: "job-files-pricing", containsPricing: true },
    ]);
  });
  afterAll(async () => t?.close());

  it("conversation: only emails/texts/calls, oldest first (newest at the bottom)", async () => {
    const ws = await va.as((tx) => loadContactWorkspace(tx, contactId, { now }));
    expect(ws!.conversation.map((a) => a.subject)).toEqual(["First", "Second"]);
  });

  it("notes from the contact and their jobs, searchable", async () => {
    const all = await va.as((tx) => loadContactWorkspace(tx, contactId, { now }));
    expect(all!.notes.map((n) => n.body).sort()).toEqual(["Gas shut-off needs 24h notice", "Super is Luis"]);
    const found = await va.as((tx) => loadContactWorkspace(tx, contactId, { now, noteSearch: "luis" }));
    expect(found!.notes.map((n) => n.body)).toEqual(["Super is Luis"]);
  });

  it("tasks (no cancelled ones), appointments split upcoming/past, counts", async () => {
    const ws = await va.as((tx) => loadContactWorkspace(tx, contactId, { now }));
    expect(ws!.tasks.map((x) => x.title).sort()).toEqual(["Confirm access", "Old"]);
    expect(ws!.counts.tasks).toBe(1); // open only
    expect(ws!.appointments.upcoming.map((j) => j.jobNumber)).toEqual([jobNumber]);
    expect(ws!.appointments.past).toHaveLength(1);
  });

  it("documents: VAs don't see priced ones; the owner does", async () => {
    const asVa = await va.as((tx) => loadContactWorkspace(tx, contactId, { now }));
    expect(asVa!.documents.map((d) => d.title)).toEqual(["Mold report"]);
    const asOwner = await owner.as((tx) => loadContactWorkspace(tx, contactId, { now }));
    expect(asOwner!.documents.map((d) => d.title).sort()).toEqual(["Mold report", "Priced proposal"]);
  });
});
