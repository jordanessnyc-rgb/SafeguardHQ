/** Read-only MCP server (Phase 5): tokens, RLS scoping, AIRnyc exclusion, and the HTTP endpoint. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as s from "@/db/schema";
import { runAsUser } from "@/lib/db";
import { mcpFetchHandler } from "@/lib/mcp/http";
import { createMcpToken, verifyMcpToken } from "@/lib/mcp/tokens";
import { getJob, pipelineSummary, searchContacts, searchJobs } from "@/lib/mcp/tools";
import { createUser, hasTestDb, setupTestDb, type TestDb, type TestUser } from "../helpers/db";

describe.skipIf(!hasTestDb)("MCP server (database)", () => {
  let t: TestDb;
  let owner: TestUser;
  let va: TestUser;
  let sub: TestUser;
  let jobNumber: string;
  const asUser = <T>(u: TestUser, fn: Parameters<typeof runAsUser<T>>[2]) => runAsUser(t.db, u.claims, fn);

  beforeAll(async () => {
    t = await setupTestDb();
    owner = await createUser(t, "OWNER");
    va = await createUser(t, "VA");
    sub = await createUser(t, "SUB");
    const [org] = await t.db.insert(s.organizations).values({ name: "Parkview Realty", type: "MANAGEMENT_CO" }).returning();
    const [job] = await t.db.insert(s.jobs).values({ serviceCode: "LL152", pipelineKey: "INSPECTION", stage: "LEAD", clientOrgId: org.id, title: "Gas piping Parkview" }).returning();
    jobNumber = job.jobNumber;
    await t.db.insert(s.jobFinancials).values({ jobId: job.id, quotedAmount: "1500.00" });
    const [member] = await t.db.insert(s.contacts).values({ firstName: "Maria", lastName: "Member", phones: ["+17185550100"] }).returning();
    await t.db.insert(s.contacts).values({ firstName: "Mark", lastName: "Manager", orgId: org.id });
    await t.db.insert(s.jobs).values({ serviceCode: "AIRNYC", pipelineKey: "AIRNYC", stage: "REFERRAL_RECEIVED", clientContactId: member.id, title: "Parkview AIRnyc home visit" });
  });
  afterAll(async () => t?.close());

  it("tokens: shown once, stored hashed, revocable, staff only", async () => {
    const token = await createMcpToken(t.db, owner.id, "laptop");
    expect(token).toMatch(/^ess_mcp_/);
    const rows = await t.db.select().from(s.mcpTokens).where(eq(s.mcpTokens.userId, owner.id));
    expect(rows[0].tokenHash).not.toContain(token.slice(8, 20));
    expect(await verifyMcpToken(t.db, token)).toEqual({ userId: owner.id, role: "OWNER" });
    expect(await verifyMcpToken(t.db, token + "x")).toBeNull();
    expect(await verifyMcpToken(t.db, "not-a-token")).toBeNull();
    await t.db.update(s.mcpTokens).set({ revokedAt: new Date() }).where(eq(s.mcpTokens.id, rows[0].id));
    expect(await verifyMcpToken(t.db, token)).toBeNull();
    expect(await verifyMcpToken(t.db, await createMcpToken(t.db, sub.id, "sub"))).toBeNull();
  });

  it("RLS: users only see and create their own tokens; subs can't create any", async () => {
    await asUser(va, (tx) => createMcpToken(tx, va.id, "va phone"));
    expect(await asUser(va, (tx) => tx.select().from(s.mcpTokens))).toHaveLength(1);
    await expect(asUser(va, (tx) => createMcpToken(tx, owner.id, "sneaky"))).rejects.toThrow();
    await expect(asUser(sub, (tx) => createMcpToken(tx, sub.id, "sub"))).rejects.toThrow();
  });

  it("tools never return AIRnyc jobs or member contacts", async () => {
    const jobs = await asUser(owner, (tx) => searchJobs(tx, { query: "Parkview" }));
    expect(jobs.map((j) => j.job_number)).toEqual([jobNumber]);
    expect(await asUser(owner, (tx) => searchContacts(tx, "M"))).toEqual([expect.objectContaining({ name: "Mark Manager" })]);
    const summary = await asUser(owner, (tx) => pipelineSummary(tx, true));
    expect(summary.jobs_by_stage).toEqual({ LEAD: 1 });
  });

  it("financials follow RLS: owner sees them, a VA doesn't", async () => {
    expect((await asUser(owner, (tx) => getJob(tx, jobNumber)))?.financials?.quoted).toBe("1500.00");
    const vaJob = await asUser(va, (tx) => getJob(tx, jobNumber));
    expect(vaJob?.job_number).toBe(jobNumber);
    expect(vaJob).not.toHaveProperty("financials");
    const vaSummary = await asUser(va, (tx) => pipelineSummary(tx, true)); // even if asked, RLS returns no invoices
    expect(vaSummary.unpaid_invoices_total ?? 0).toBe(0);
  });

  describe("HTTP endpoint", () => {
    const handle = () => mcpFetchHandler(() => t.db);
    const rpc = (body: unknown, headers: Record<string, string> = {}) =>
      new Request("http://localhost:3000/api/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
        body: JSON.stringify(body),
      });
    const callTool = (name: string, args: unknown = {}) => ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
    const payload = async (res: Response) => {
      const text = await res.text();
      const data = text.startsWith("{") ? text : text.split("\n").find((l) => l.startsWith("data: "))!.slice(6);
      return JSON.parse(data);
    };

    it("rejects missing/invalid tokens and foreign browser origins", async () => {
      expect((await handle()(rpc(callTool("pipeline_summary")))).status).toBe(401);
      expect((await handle()(rpc(callTool("pipeline_summary"), { authorization: "Bearer ess_mcp_nope" }))).status).toBe(401);
      const token = await createMcpToken(t.db, owner.id, "http");
      expect((await handle()(rpc(callTool("pipeline_summary"), { authorization: `Bearer ${token}`, origin: "https://evil.example" }))).status).toBe(403);
    });

    it("lists only read-only tools and runs them as the token's user", async () => {
      const vaToken = await createMcpToken(t.db, va.id, "http");
      const list = await payload(await handle()(rpc({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, { authorization: `Bearer ${vaToken}` })));
      const tools = list.result.tools as { name: string; annotations: { readOnlyHint: boolean } }[];
      expect(tools.map((x) => x.name).sort()).toEqual(["get_job", "list_tasks", "pipeline_summary", "property_violations", "search_contacts", "search_jobs"]);
      expect(tools.every((x) => x.annotations.readOnlyHint)).toBe(true);

      const res = await payload(await handle()(rpc(callTool("get_job", { job_number: jobNumber }), { authorization: `Bearer ${vaToken}` })));
      const job = JSON.parse(res.result.content[0].text);
      expect(job.job_number).toBe(jobNumber);
      expect(job).not.toHaveProperty("financials");
    });
  });
});
