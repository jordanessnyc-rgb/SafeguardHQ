/**
 * Team inbox & internal chat: My inbox (received + sent + my texts + assigned) / Unassigned views, conversation assignment (thread-wide),
 * internal notes (never outbound, blocked on AIRnyc), @mention notifications, team chat unread counts,
 * and RLS. The mention parser is tested without a database.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import * as s from "@/db/schema";
import { mentionedIds, splitMentions } from "@/lib/team/mentions";
import { loadContactPanel } from "@/lib/team/contact-panel";
import { addInternalNote, assignConversation, notesFor, postTeamMessage, teamMembers, unreadForNav, viewWhere } from "@/lib/team/inbox";
import { createUser, hasTestDb, pgError, setupTestDb, type TestDb, type TestUser } from "../helpers/db";

describe("@mentions (no database)", () => {
  const members = [
    { id: "a", name: "Maria Lopez" },
    { id: "b", name: "Jordan Adhami" },
    { id: "c", name: "Maria Chen" },
    { id: "d", name: "Sam" },
  ];
  it("matches full names, and first names only when they're unique", () => {
    expect(mentionedIds("@Jordan can you call them? cc @maria lopez", members)).toEqual(["b", "a"]);
    expect(mentionedIds("@Maria please check", members)).toEqual([]); // two Marias: needs the full name
    expect(mentionedIds("thanks @sam!", members)).toEqual(["d"]);
  });
  it("ignores emails and partial words, and never notifies the author", () => {
    expect(mentionedIds("write to sam@example.com or @Samantha", members)).toEqual([]);
    expect(mentionedIds("@Jordan Adhami and @Jordan", members, "b")).toEqual([]);
  });
  it("splits text for highlighting", () => {
    expect(splitMentions("Hi @Sam, see this", members)).toEqual([{ text: "Hi " }, { text: "@Sam", memberId: "d" }, { text: ", see this" }]);
  });
});

describe.skipIf(!hasTestDb)("team inbox & internal chat", () => {
  let t: TestDb;
  let owner: TestUser;
  let va: TestUser;
  let va2: TestUser;
  let field: TestUser;
  let jobId: string;

  beforeAll(async () => {
    t = await setupTestDb();
    owner = await createUser(t, "OWNER");
    va = await createUser(t, "VA");
    va2 = await createUser(t, "VA");
    field = await createUser(t, "FIELD");
    await t.pool.query(`update public.profiles set full_name = 'Jordan Adhami' where user_id = $1`, [owner.id]);
    await t.pool.query(`update public.profiles set full_name = 'Maria Lopez' where user_id = $1`, [va.id]);
    await t.pool.query(`update public.profiles set full_name = 'Sam Park' where user_id = $1`, [va2.id]);
    const [j] = await t.db.insert(s.jobs).values({ serviceCode: "LL152", pipelineKey: "INSPECTION", stage: "LEAD", assignedTo: va.id }).returning();
    jobId = j.id;
  });
  afterAll(async () => t?.close());

  const email = async (v: Partial<typeof s.activities.$inferInsert>) =>
    (await t.db.insert(s.activities).values({ type: "EMAIL_IN", direction: "INBOUND", subject: "Access", body: "Hello", ...v }).returning())[0];
  const ids = async (who: TestUser, view: "mine" | "unassigned") =>
    (await who.as((tx) => tx.select({ id: s.activities.id }).from(s.activities).where(and(inArray(s.activities.type, ["EMAIL_IN", "EMAIL_OUT", "SMS"]), viewWhere(view, { id: who.id, email: who.claims.email! }))))).map((r) => r.id).sort();
  const to = (...addresses: string[]) => ({ raw: { email: { from: { name: "PM", address: "pm@acme.test" }, to: addresses.map((address) => ({ name: "", address })), cc: [] } } });

  it("My inbox = what I received, what I sent, my text conversations and what's assigned to me", async () => {
    const toMaria = await email({ threadKey: "<t1>", ...to(va.claims.email!.toUpperCase()) }); // case doesn't matter
    // Sent from the CRM by Maria (approved_by), and sent from her own mailbox (from_address).
    const [crmSent] = await t.db.insert(s.activities).values({ type: "EMAIL_OUT", direction: "OUTBOUND", subject: "Quote", externalId: "<out-1@ess>", toAddress: "client@acme.test" }).returning();
    await t.db.insert(s.outboundMessages).values({ channel: "EMAIL", status: "SENT", toAddress: "client@acme.test", body: "Quote attached", externalId: "<out-1@ess>", approvedBy: va.id });
    const [mailboxSent] = await t.db.insert(s.activities).values({ type: "EMAIL_OUT", direction: "OUTBOUND", subject: "Re: access", fromAddress: va.claims.email!, toAddress: "super@acme.test" }).returning();
    // Sam texted a tenant from the CRM; the tenant's reply is Sam's.
    await t.db.insert(s.outboundMessages).values({ channel: "SMS", status: "SENT", toAddress: "+19295550199", body: "Hi, confirming Friday", approvedBy: va2.id, sentAt: new Date() });
    const [reply] = await t.db.insert(s.activities).values({ type: "SMS", direction: "INBOUND", fromAddress: "+19295550199", body: "Yes Friday works" }).returning();
    // Assigned to Sam, with a later reply in the same thread.
    const first = await email({ threadKey: "<t2>", ...to("sales@ess-nyc.com") });
    const later = await email({ threadKey: "<t2>", ...to("sales@ess-nyc.com") });
    const loose = await email({ threadKey: "<t3>", ...to("sales@ess-nyc.com") });
    await va2.as(async (tx) => assignConversation(tx, { activity: first, assignee: va2.id, actor: { id: va2.id, name: "Sam Park" } }));

    expect(await ids(va, "mine")).toEqual([toMaria.id, crmSent.id, mailboxSent.id].sort());
    expect(await ids(va2, "mine")).toEqual([reply.id, first.id, later.id].sort());
    expect(await ids(va, "unassigned")).toEqual([loose.id]); // mail to sales@ nobody has taken
  });

  it("an assignment wins over who the email was sent to", async () => {
    const msg = await email({ threadKey: "<t9>", ...to(va.claims.email!) });
    await owner.as(async (tx) => assignConversation(tx, { activity: msg, assignee: va2.id, actor: { id: owner.id, name: "Jordan Adhami" } }));
    expect(await ids(va2, "mine")).toContain(msg.id);
    expect(await ids(va, "mine")).not.toContain(msg.id);
    await t.db.delete(s.conversationAssignments).where(eq(s.conversationAssignments.conversationKey, "<t9>"));
  });

  it("assigning someone else notifies them; unassigning removes it", async () => {
    const msg = await email({ threadKey: "<t4>", subject: "Mold question", ...to("sales@ess-nyc.com") });
    await owner.as((tx) => assignConversation(tx, { activity: msg, assignee: va.id, actor: { id: owner.id, name: "Jordan Adhami" } }));
    const mine = await va.as((tx) => tx.select().from(s.notifications).where(eq(s.notifications.kind, "ASSIGNED")));
    expect(mine.map((n) => n.title)).toEqual(["Jordan Adhami assigned you “Mold question”"]);
    expect(mine[0].href).toBe(`/inbox?box=inbox&id=${msg.id}`);
    await owner.as((tx) => assignConversation(tx, { activity: msg, assignee: null, actor: { id: owner.id, name: "Jordan Adhami" } }));
    expect((await ids(va, "unassigned"))).toContain(msg.id);
  });

  it("internal notes stay internal, show on the conversation and notify @mentions", async () => {
    const msg = await email({ threadKey: "<t5>", jobId });
    const reply = await email({ threadKey: "<t5>", jobId });
    const before = await t.db.select().from(s.outboundMessages);
    const r = await va.as(async (tx) => addInternalNote(tx, { activity: msg, body: "@Jordan Adhami they want Friday. @Sam can you confirm?", author: { id: va.id, name: "Maria Lopez" }, members: await teamMembers(tx) }));
    expect(r.mentions.sort()).toEqual([owner.id, va2.id].sort());

    // Same conversation from the reply's side; and nothing was queued to send.
    const notes = await owner.as((tx) => notesFor(tx, reply.threadKey!));
    expect(notes.map((n) => n.authorId)).toEqual([va.id]);
    expect(await t.db.select().from(s.outboundMessages)).toHaveLength(before.length);
    const [row] = await t.db.select().from(s.activities).where(eq(s.activities.id, r.id));
    expect(row).toMatchObject({ type: "NOTE", direction: "INTERNAL", jobId });

    const sams = await va2.as((tx) => tx.select().from(s.notifications).where(eq(s.notifications.kind, "MENTION_NOTE")));
    expect(sams[0].title).toBe("Maria Lopez mentioned you on “Access”");
  });

  it("notes are refused on AIRnyc / sealed messages", async () => {
    const sealed = await email({ threadKey: "<t6>", sensitive: true });
    const msg = await pgError(va.as(async (tx) => addInternalNote(tx, { activity: sealed, body: "member called back", author: { id: va.id, name: "Maria Lopez" }, members: [] })));
    expect(msg).toMatch(/AIRnyc/);
  });

  it("team chat: mentions notify, unread counts for others, posting reads the room", async () => {
    const before = { maria: await va.as((tx) => unreadForNav(tx, va.id)), sam: await va2.as((tx) => unreadForNav(tx, va2.id)) };
    await va.as(async (tx) => postTeamMessage(tx, { body: "Lunch order? @Sam Park", author: { id: va.id, name: "Maria Lopez" }, members: await teamMembers(tx) }));
    expect(await va.as((tx) => unreadForNav(tx, va.id))).toBe(before.maria); // your own message isn't unread
    // Sam: +1 for the new message; the chat mention isn't counted a second time.
    expect(await va2.as((tx) => unreadForNav(tx, va2.id))).toBe(before.sam + 1);
    const [mention] = await va2.as((tx) => tx.select().from(s.notifications).where(eq(s.notifications.kind, "MENTION_CHAT")));
    expect(mention.title).toBe("Maria Lopez mentioned you in Team chat");
  });

  it("client panel: details, open tasks, notes, appointments and documents (priced ones hidden from VAs)", async () => {
    const [c] = await t.db.insert(s.contacts).values({ firstName: "Dana", lastName: "Reyes", emails: ["dana@acme.test"], phones: ["+19295550100"] }).returning();
    const soon = new Date(Date.now() + 2 * 86_400_000);
    const [j] = await t.db.insert(s.jobs).values({ serviceCode: "LL152", pipelineKey: "INSPECTION", stage: "SCHEDULED", clientContactId: c.id, scheduledAt: soon }).returning();
    await t.db.insert(s.tasks).values([{ title: "Confirm access", contactId: c.id, dueAt: soon }, { title: "Old task", jobId: j.id, status: "DONE" }]);
    await t.db.insert(s.activities).values({ type: "NOTE", direction: "INTERNAL", contactId: c.id, body: "Prefers texts after 5pm" });
    await t.db.insert(s.documents).values([
      { jobId: j.id, kind: "REPORT", title: "LL152 report", storagePath: "jobs/r.pdf", storageBucket: "job-files" },
      { jobId: j.id, kind: "PROPOSAL", title: "Proposal with price", storagePath: "jobs/p.pdf", storageBucket: "job-files-pricing", containsPricing: true },
    ]);

    const asVa = await va.as((tx) => loadContactPanel(tx, c.id));
    expect(asVa?.contact).toMatchObject({ firstName: "Dana", lastName: "Reyes", emails: ["dana@acme.test"], phones: ["+19295550100"] });
    expect(asVa?.tasks.map((x) => x.title)).toEqual(["Confirm access"]); // done tasks don't show
    expect(asVa?.notes.map((x) => x.body)).toEqual(["Prefers texts after 5pm"]);
    expect(asVa?.appointments.map((x) => [x.jobNumber, x.upcoming])).toEqual([[j.jobNumber, true]]);
    expect(asVa?.documents.map((x) => x.title)).toEqual(["LL152 report"]);
    const asOwner = await owner.as((tx) => loadContactPanel(tx, c.id));
    expect(asOwner?.documents.map((x) => x.title).sort()).toEqual(["LL152 report", "Proposal with price"]);
  });

  it("RLS: field staff see nothing; you can't post as someone else or read others' notifications", async () => {
    expect(await field.as((tx) => tx.select().from(s.teamMessages))).toHaveLength(0);
    expect(await field.as((tx) => tx.select().from(s.conversationAssignments))).toHaveLength(0);
    const spoof = await pgError(va.as((tx) => tx.insert(s.teamMessages).values({ authorId: owner.id, body: "pretending" })));
    expect(spoof).toMatch(/row-level security/);
    const theirs = await va.as((tx) => tx.select().from(s.notifications).where(eq(s.notifications.userId, owner.id)));
    expect(theirs).toHaveLength(0);
  });

  it("only the author or the owner can delete a chat message", async () => {
    const [m] = await va.as((tx) => tx.insert(s.teamMessages).values({ authorId: va.id, body: "typo" }).returning());
    const byOther = await va2.as((tx) => tx.update(s.teamMessages).set({ deletedAt: new Date() }).where(eq(s.teamMessages.id, m.id)).returning());
    expect(byOther).toHaveLength(0);
    const byOwner = await owner.as((tx) => tx.update(s.teamMessages).set({ deletedAt: new Date() }).where(eq(s.teamMessages.id, m.id)).returning());
    expect(byOwner).toHaveLength(1);
  });
});
