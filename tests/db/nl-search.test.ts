/** Natural-language search (SPEC §9.6): validator, read-only execution under RLS, end-to-end. */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as s from "@/db/schema";
import type { AnthropicLike } from "@/lib/ai/anthropic";
import { CATALOG, catalogFor } from "@/lib/search/catalog";
import { naturalLanguageSearch, runReadOnly } from "@/lib/search/run";
import { validateSql } from "@/lib/search/validate";
import { createUser, hasTestDb, setupTestDb, type TestDb, type TestUser } from "../helpers/db";

describe("SQL validator", () => {
  const ok = (q: string) => validateSql(q).ok;
  it("accepts plain SELECTs and CTEs over catalog tables", () => {
    expect(ok(`select job_number as "Job", stage from jobs where archived_at is null order by created_at desc limit 20`)).toBe(true);
    expect(ok(`with open as (select id from jobs where stage <> 'LOST') select count(*) as "n" from open`)).toBe(true);
    expect(ok(`select o.name, count(j.id) from organizations o join jobs j on j.client_org_id = o.id group by o.name`)).toBe(true);
    expect(ok(`select title from tasks where title = 'Delete the old file'`)).toBe(true); // keywords inside strings are fine
    expect(validateSql("select id from jobs").ok && (validateSql("select id from jobs") as { sql: string }).sql).toBe("select * from (select id from jobs) as nl_result limit 200");
  });
  it("rejects writes, multiple statements, comments, system catalogs, secrets, * and unlisted tables", () => {
    for (const q of [
      "update jobs set stage = 'LOST'",
      "select 1; drop table jobs",
      "select id from jobs -- hi",
      "select id /* x */ from jobs",
      "with x as (delete from tasks returning id) select id from x",
      "select id into temp t from jobs",
      "select * from jobs",
      "select j.* from jobs j",
      "select usename from pg_user",
      "select table_name from information_schema.tables",
      "select email from auth.users",
      "select access_token_enc from freshbooks_connection",
      "select member_name_enc from airnyc_cases",
      "select body from activities",
      "select set_config('role', 'postgres', true)",
      "select id from profiles",
      "select id from audit_log",
      "select x from dblink('host=evil', 'select 1') as t(x int)",
    ]) expect(validateSql(q).ok, q).toBe(false);
  });
  it("hides owner-only tables from a VA's catalog", () => {
    expect(catalogFor(false).map((t) => t.name)).not.toContain("job_financials");
    expect(validateSql("select quoted_amount from job_financials", catalogFor(false)).ok).toBe(false);
    expect(validateSql("select quoted_amount from job_financials", CATALOG).ok).toBe(true);
  });
});

describe.skipIf(!hasTestDb)("NL search execution (database)", () => {
  let t: TestDb;
  let owner: TestUser;
  let va: TestUser;
  beforeAll(async () => {
    t = await setupTestDb();
    owner = await createUser(t, "OWNER");
    va = await createUser(t, "VA");
    const [org] = await t.db.insert(s.organizations).values({ name: "Parkview Realty", type: "MANAGEMENT_CO" }).returning();
    const [job] = await t.db.insert(s.jobs).values({ serviceCode: "LL152", pipelineKey: "INSPECTION", stage: "LEAD", clientOrgId: org.id }).returning();
    await t.db.insert(s.jobFinancials).values({ jobId: job.id, quotedAmount: "1500.00" });
  });
  afterAll(async () => t?.close());

  it("runs read-only: writes fail even if a query slipped past the validator", async () => {
    await expect(runReadOnly(t.db, owner.claims, "update tasks set title = 'x'")).rejects.toThrow();
    await expect(runReadOnly(t.db, owner.claims, "select pg_sleep(10)")).rejects.toThrow(); // statement timeout (5 s)
  }, 20_000);

  it("RLS scopes results to the asker (a VA gets no money rows)", async () => {
    const q = (validateSql("select quoted_amount from job_financials", CATALOG) as { sql: string }).sql;
    expect((await runReadOnly(t.db, owner.claims, q)).rows).toEqual([{ quoted_amount: "1500.00" }]);
    expect((await runReadOnly(t.db, va.claims, q)).rows).toEqual([]);
  });

  it("end to end: question → validated SQL → rows; the model gets the catalog, never data", async () => {
    const parse = vi.fn(async (_req: unknown) => ({
      parsed_output: { sql: `select o.name as "Client", count(j.id) as "Open jobs" from organizations o join jobs j on j.client_org_id = o.id where j.archived_at is null group by o.name order by 2 desc limit 20`, explanation: "Open jobs per client.", cannot_answer: null },
      stop_reason: "end_turn",
      usage: { input_tokens: 2500, output_tokens: 120 },
    }));
    const api = { messages: { parse } } as unknown as AnthropicLike;
    const r = await naturalLanguageSearch(t.db, { claims: va.claims, role: "VA" }, "Which clients have the most open jobs?", api);
    expect(r).toMatchObject({ status: "ok", columns: ["Client", "Open jobs"], rows: [{ Client: "Parkview Realty", "Open jobs": "1" }] });
    const sent = JSON.stringify(parse.mock.calls[0][0]);
    expect(sent).not.toContain("Parkview"); // no data to the model
    expect(sent).not.toContain("job_financials"); // VA's catalog excludes money

    parse.mockResolvedValueOnce({ parsed_output: { sql: "select * from contacts", explanation: "", cannot_answer: null }, stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } });
    expect(await naturalLanguageSearch(t.db, { claims: va.claims, role: "VA" }, "everything", api)).toMatchObject({ status: "refused" });
  });
});
