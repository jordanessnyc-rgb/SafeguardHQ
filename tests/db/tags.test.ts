/**
 * Tags (automation part 1): RLS (staff tag; FIELD sees nothing; only the OWNER deletes a tag) and the
 * helpers behind the tag editor and list filters. Needs TEST_DATABASE_URL.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { count, eq } from "drizzle-orm";
import * as s from "@/db/schema";
import { addTag, cleanTagName, findOrCreateTag, hasTag, listTags, removeTag, tagParam, tagsFor, tagsForMany } from "@/lib/tags";
import { createUser, hasTestDb, pgError, setupTestDb, type TestDb, type TestUser } from "../helpers/db";

describe("tag helpers (no database)", () => {
  it("cleans names and rejects empty or long ones", () => {
    expect(cleanTagName("  Hot   lead ")).toBe("Hot lead");
    expect(cleanTagName("   ")).toBeNull();
    expect(cleanTagName("x".repeat(41))).toBeNull();
  });

  it("only accepts a uuid as the ?tag= filter", () => {
    expect(tagParam("8f14e45f-ceea-467a-9575-6b1a8c3f9a01")).toBe("8f14e45f-ceea-467a-9575-6b1a8c3f9a01");
    expect(tagParam("'; drop table tags; --")).toBeUndefined();
    expect(tagParam(["a", "b"])).toBeUndefined();
    expect(tagParam(undefined)).toBeUndefined();
  });
});

describe.skipIf(!hasTestDb)("tags", () => {
  let t: TestDb;
  let owner: TestUser;
  let va: TestUser;
  let field: TestUser;
  let contactId: string;
  let otherContactId: string;
  let orgId: string;
  let jobId: string;

  beforeAll(async () => {
    t = await setupTestDb();
    owner = await createUser(t, "OWNER");
    va = await createUser(t, "VA");
    field = await createUser(t, "FIELD");
    await owner.as(async (tx) => {
      const [org] = await tx.insert(s.organizations).values({ name: "Acme Mgmt", type: "MANAGEMENT_CO" }).returning();
      orgId = org.id;
      const [c] = await tx.insert(s.contacts).values({ firstName: "Dana", lastName: "Reyes", orgId }).returning();
      contactId = c.id;
      const [c2] = await tx.insert(s.contacts).values({ firstName: "Lee", lastName: "Park" }).returning();
      otherContactId = c2.id;
      const [job] = await tx.insert(s.jobs).values({ serviceCode: "LL152", pipelineKey: "INSPECTION", stage: "LEAD", clientOrgId: orgId }).returning();
      jobId = job.id;
    });
  });

  afterAll(async () => {
    await t?.close();
  });

  it("a VA can create a tag and put it on a contact, company and job", async () => {
    await va.as(async (tx) => {
      const tag = await findOrCreateTag(tx, "Hot lead", "red");
      expect(await addTag(tx, "contact", contactId, tag.id)).toBe(true);
      expect(await addTag(tx, "organization", orgId, tag.id)).toBe(true);
      expect(await addTag(tx, "job", jobId, tag.id)).toBe(true);
    });
    const onContact = await va.as((tx) => tagsFor(tx, "contact", contactId));
    expect(onContact.map((x) => [x.name, x.color])).toEqual([["Hot lead", "red"]]);
  });

  it("reuses an existing tag regardless of case and doesn't add it twice", async () => {
    await va.as(async (tx) => {
      const again = await findOrCreateTag(tx, "  HOT   LEAD ");
      expect(again.name).toBe("Hot lead");
      expect(await addTag(tx, "contact", contactId, again.id)).toBe(false);
    });
    const [{ n }] = await owner.as((tx) => tx.select({ n: count() }).from(s.tags));
    expect(n).toBe(1);
  });

  it("lists tags per record and filters lists by tag", async () => {
    await owner.as(async (tx) => {
      const vip = await findOrCreateTag(tx, "VIP", "purple");
      await addTag(tx, "contact", contactId, vip.id);
      const many = await tagsForMany(tx, "contact", [contactId, otherContactId]);
      expect(many.get(contactId)?.map((x) => x.name)).toEqual(["Hot lead", "VIP"]);
      expect(many.get(otherContactId)).toBeUndefined();

      const tagged = await tx.select({ id: s.contacts.id }).from(s.contacts).where(hasTag("contact", s.contacts.id, vip.id));
      expect(tagged.map((r) => r.id)).toEqual([contactId]);
      expect((await listTags(tx)).map((x) => x.name)).toEqual(["Hot lead", "VIP"]);
    });
  });

  it("a VA can remove a tag from a record", async () => {
    await va.as(async (tx) => {
      const [vip] = (await listTags(tx)).filter((x) => x.name === "VIP");
      await removeTag(tx, "contact", contactId, vip.id);
    });
    expect((await va.as((tx) => tagsFor(tx, "contact", contactId))).map((x) => x.name)).toEqual(["Hot lead"]);
  });

  it("field staff can't see or add tags", async () => {
    expect(await field.as((tx) => listTags(tx))).toEqual([]);
    const [{ n }] = await field.as((tx) => tx.select({ n: count() }).from(s.contactTags));
    expect(n).toBe(0);
    const msg = await pgError(field.as((tx) => tx.insert(s.tags).values({ name: "Sneaky" })));
    expect(msg).toMatch(/row-level security/);
  });

  it("only the owner can delete a tag, and deleting it removes it everywhere", async () => {
    const [tag] = await owner.as((tx) => listTags(tx));
    const del = await va.as((tx) => tx.delete(s.tags).where(eq(s.tags.id, tag.id)).returning());
    expect(del).toHaveLength(0);

    await owner.as((tx) => tx.delete(s.tags).where(eq(s.tags.id, tag.id)));
    const left = await owner.as(async (tx) => ({
      contacts: (await tx.select({ n: count() }).from(s.contactTags))[0].n,
      orgs: (await tx.select({ n: count() }).from(s.organizationTags))[0].n,
      jobs: (await tx.select({ n: count() }).from(s.jobTags))[0].n,
    }));
    expect(left).toEqual({ contacts: 0, orgs: 0, jobs: 0 });
  });
});
