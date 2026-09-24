/**
 * Row-level security (SPEC §2, §12 Phase 1 acceptance: "a VA account cannot read any financial
 * table"). Runs against a real Postgres with the Supabase stub; set TEST_DATABASE_URL.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import * as s from "@/db/schema";
import { createUser, hasTestDb, pgError, setupTestDb, type TestDb, type TestUser } from "../helpers/db";

const FINANCIAL_TABLES = ["job_financials", "invoices_cache", "sub_costs", "campaign_costs"] as const;

describe.skipIf(!hasTestDb)("row-level security", () => {
  let t: TestDb;
  let owner: TestUser;
  let va: TestUser;
  let field: TestUser;
  let noRole: TestUser;
  let jobId: string;
  let pricedDocId: string;

  beforeAll(async () => {
    t = await setupTestDb();
    owner = await createUser(t, "OWNER");
    va = await createUser(t, "VA");
    field = await createUser(t, "FIELD");
    noRole = await createUser(t, null);

    // Owner creates a job with financial data and a priced + unpriced document.
    await owner.as(async (tx) => {
      const [org] = await tx.insert(s.organizations).values({ name: "Acme Mgmt", type: "MANAGEMENT_CO" }).returning();
      const [job] = await tx
        .insert(s.jobs)
        .values({ serviceCode: "MOLD_ASSESS", pipelineKey: "INSPECTION", stage: "LEAD", clientOrgId: org.id })
        .returning();
      jobId = job.id;
      await tx.insert(s.jobFinancials).values({ jobId, quotedAmount: "1850.00", labCost: "240.00" });
      await tx.insert(s.invoicesCache).values({ freshbooksInvoiceId: "FB-1", jobId, amount: "1850.00" });
      await tx.insert(s.subCosts).values({ jobId, subOrgId: org.id, amount: "600.00", description: "Remediation" });
      const [c] = await tx.insert(s.campaigns).values({ name: "Fall mailer", channel: "DIRECT_MAIL" }).returning();
      await tx.insert(s.campaignCosts).values({ campaignId: c.id, cost: "900.00" });
      const [priced] = await tx
        .insert(s.documents)
        .values({ jobId, kind: "PROPOSAL", containsPricing: true, title: "Proposal w/ price" })
        .returning();
      pricedDocId = priced.id;
      await tx.insert(s.documents).values({ jobId, kind: "REPORT", containsPricing: false, title: "Report" });
    });
  });

  afterAll(async () => {
    await t?.close();
  });

  describe("VA cannot read or write any financial table", () => {
    for (const table of FINANCIAL_TABLES) {
      it(`hides every row of ${table}`, async () => {
        const ownerCount = await owner.as((tx) =>
          tx.execute<{ n: number }>(sql.raw(`select count(*)::int as n from public.${table}`)),
        );
        expect(ownerCount.rows[0].n).toBeGreaterThan(0);

        const vaCount = await va.as((tx) =>
          tx.execute<{ n: number }>(sql.raw(`select count(*)::int as n from public.${table}`)),
        );
        expect(vaCount.rows[0].n).toBe(0);
      });

      it(`cannot update or delete ${table}`, async () => {
        const upd = await va.as((tx) => tx.execute(sql.raw(`update public.${table} set updated_at = now()`)));
        expect(upd.rowCount).toBe(0);
        const del = await va.as((tx) => tx.execute(sql.raw(`delete from public.${table}`)));
        expect(del.rowCount).toBe(0);
      });
    }

    it("cannot insert into job_financials", async () => {
      const msg = await pgError(
        va.as((tx) => tx.insert(s.jobFinancials).values({ jobId, quotedAmount: "1.00" }).onConflictDoNothing()),
      );
      expect(msg).toMatch(/row-level security/);
    });

    it("cannot read the audit log (which contains financial diffs)", async () => {
      const rows = await va.as((tx) => tx.select().from(s.auditLog));
      expect(rows).toHaveLength(0);
      const ownerRows = await owner.as((tx) => tx.select().from(s.auditLog).where(eq(s.auditLog.entity, "job_financials")));
      expect(ownerRows.length).toBeGreaterThan(0);
    });
  });

  describe("documents with pricing", () => {
    it("are invisible to VA", async () => {
      const docs = await va.as((tx) => tx.select().from(s.documents));
      expect(docs.map((d) => d.title)).toEqual(["Report"]);
    });

    it("cannot be created by VA", async () => {
      const msg = await pgError(
        va.as((tx) => tx.insert(s.documents).values({ jobId, kind: "OTHER", containsPricing: true })),
      );
      expect(msg).toMatch(/row-level security/);
    });

    it("VA cannot flip an unpriced document to priced, or touch a priced one", async () => {
      const msg = await pgError(
        va.as((tx) => tx.update(s.documents).set({ containsPricing: true }).where(eq(s.documents.title, "Report"))),
      );
      expect(msg).toMatch(/row-level security/);
      const res = await va.as((tx) =>
        tx.update(s.documents).set({ containsPricing: false }).where(eq(s.documents.id, pricedDocId)).returning(),
      );
      expect(res).toHaveLength(0);
    });

    it("are visible to OWNER", async () => {
      const docs = await owner.as((tx) => tx.select().from(s.documents));
      expect(docs).toHaveLength(2);
    });
  });

  describe("core tables", () => {
    it("VA can create and edit contacts, properties, jobs, tasks", async () => {
      await va.as(async (tx) => {
        const [c] = await tx.insert(s.contacts).values({ firstName: "Pat", lastName: "Lee" }).returning();
        expect(c.createdBy).toBe(va.id);
        await tx.update(s.contacts).set({ title: "Super" }).where(eq(s.contacts.id, c.id));
        await tx.insert(s.properties).values({ addressLine: "1 Main St", borough: "Queens" });
        await tx.update(s.jobs).set({ priority: "HIGH" }).where(eq(s.jobs.id, jobId));
        await tx.insert(s.tasks).values({ title: "Call back", jobId });
      });
    });

    it("VA cannot hard-delete (OWNER only; normal flow is archived_at)", async () => {
      const res = await va.as((tx) => tx.delete(s.contacts).returning());
      expect(res).toHaveLength(0);
    });

    it("VA can read settings but not change them", async () => {
      const rows = await va.as((tx) => tx.select().from(s.settings));
      expect(rows).toHaveLength(1);
      const upd = await va.as((tx) => tx.update(s.settings).set({ airnycAiAllowed: true }).returning());
      expect(upd).toHaveLength(0);
      const after = await owner.as((tx) => tx.select().from(s.settings));
      expect(after[0].airnycAiAllowed).toBe(false);
    });

    it("VA cannot change pipeline configuration", async () => {
      const upd = await va.as((tx) => tx.update(s.pipelineStages).set({ staleAfterDays: 99 }).returning());
      expect(upd).toHaveLength(0);
    });
  });

  describe("profiles / role escalation", () => {
    it("VA cannot promote themselves to OWNER", async () => {
      const res = await va.as((tx) =>
        tx.update(s.profiles).set({ role: "OWNER" }).where(eq(s.profiles.userId, va.id)).returning(),
      );
      expect(res).toHaveLength(0);
      const [p] = await owner.as((tx) => tx.select().from(s.profiles).where(eq(s.profiles.userId, va.id)));
      expect(p.role).toBe("VA");
    });

    it("OWNER can change roles", async () => {
      const res = await owner.as((tx) =>
        tx.update(s.profiles).set({ role: "VA" }).where(eq(s.profiles.userId, noRole.id)).returning(),
      );
      expect(res).toHaveLength(1);
      await owner.as((tx) => tx.update(s.profiles).set({ role: null }).where(eq(s.profiles.userId, noRole.id)));
    });

    it("role cannot be self-assigned through user_metadata at signup", async () => {
      await t.pool.query(
        `insert into auth.users (id, email, raw_user_meta_data) values (gen_random_uuid(), 'sneaky@example.test', '{"role":"OWNER"}')`,
      );
      const { rows } = await t.pool.query(`select role from public.profiles where email = 'sneaky@example.test'`);
      expect(rows[0].role).toBeNull();
    });
  });

  describe("users without an office role", () => {
    for (const [label, get] of [
      ["no role", () => noRole],
      ["FIELD (until field policies ship)", () => field],
    ] as const) {
      it(`${label} sees nothing`, async () => {
        const u = get();
        const [jobs, contacts, fin, cases] = await u.as(async (tx) => [
          await tx.select().from(s.jobs),
          await tx.select().from(s.contacts),
          await tx.select().from(s.jobFinancials),
          await tx.select().from(s.airnycCases),
        ]);
        expect(jobs.length + contacts.length + fin.length + cases.length).toBe(0);
      });
    }

    it("anon has no table privileges at all", async () => {
      const msg = await pgError(
        t.db.transaction(async (tx) => {
          await tx.execute(sql`set local role anon`);
          await tx.execute(sql`select * from public.contacts`);
        }),
      );
      expect(msg).toMatch(/permission denied/);
    });
  });

  it("every table in public has RLS enabled", async () => {
    const { rows } = await t.pool.query(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`,
    );
    expect(rows).toEqual([]);
  });
});
