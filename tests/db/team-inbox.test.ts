/**
 * Team inbox & internal chat: My inbox (sent to me + assigned) / Unassigned views, conversation assignment (thread-wide),
 * internal notes (never outbound, blocked on AIRnyc), @mention notifications, team chat unread counts,
 * and RLS. The mention parser is tested without a database.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import * as s from "@/db/schema";
import { mentionedIds, splitMentions } from "@/lib/team/mentions";
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
    (await who.as((tx) => tx.select({ id: s.activities.id }).from(s.activities).where(and(eq(s.activities.type, "EMAIL_IN"), viewWhere(view, { id: who.id, email: who.claims.email! }))))).map((r) => r.id).sort();
  const to = (...addresses: string[]) => ({ raw: { email: { from: { name: "PM", address: "pm@acme.test" }, to: addresses.map((address) => ({ name: "", address })), cc: [] } } });

  it("My inbox = emails sent to me + conversations assigned to me; Unassigned = neither", async () => {
    const toMaria = await email({ threadKey: "<t1>", ...to(va.claims.email!.toUpperCase()) }); // case doesn't matter
    const first = await email({ threadKey: "<t2>", ...to("sales@ess-nyc.com") });
    const reply = await email({ threadKey: "<t2>", ...to("sales@ess-nyc.com") }); // same thread, arrives later
    const loose = await email({ threadKey: "<t3>", ...to("sales@ess-nyc.com") });

    await va2.as(async (tx) => assignConversation(tx, { activity: first, assignee: va2.id, actor: { id: va2.id, name: "Sam Park" } }));
    expect(await ids(va, "mine")).toEqual([toMaria.id]);
    expect(await ids(va2, "mine")).toEqual([first.id, reply.id].sort()); // the reply follows the thread
    expect(await ids(va, "unassigned")).toEqual([loose.id]); // mail to sales@ nobody has taken yet
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
