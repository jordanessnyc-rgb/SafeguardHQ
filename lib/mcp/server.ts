/**
 * Read-only MCP server for Claude (SPEC §12 Phase 5). One McpServer per request, bound to the
 * token's user: every tool runs under that user's RLS, so a VA's token never returns money.
 */
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { adminDb, runAsUser, type Db, type Tx } from "@/lib/db";
import { getJob, listTasks, pipelineSummary, propertyViolations, searchContacts, searchJobs } from "./tools";

export type McpUser = { userId: string; role: "OWNER" | "VA" };

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const STAGES = ["LEAD", "QUALIFIED", "PROPOSAL_SENT", "SIGNED", "SCHEDULED", "FIELD_COMPLETE", "LAB_PENDING", "DRAFTING", "QA", "DELIVERED", "INVOICED", "PAID", "CLOSED", "NEXT_CYCLE_SCHEDULED", "LOST"] as const;
const SERVICES = ["MOLD_ASSESS", "MOLD_PLAN", "MOLD_CLEAR", "LEAD_RA", "LEAD_CLEAR", "LEAD_WATER", "ASB_SURVEY", "LL152", "LL126", "LL31", "VIOLATION", "BID"] as const;

const json = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 1) }] });

export function buildMcpServer(user: McpUser, db: Db = adminDb(), now: () => Date = () => new Date()): McpServer {
  const run = <T>(fn: (tx: Tx) => Promise<T>) => runAsUser(db, { sub: user.userId, role: "authenticated" }, fn);
  const server = new McpServer(
    { name: "ess-crm", title: "ESS CRM (read-only)", version: "1.0.0" },
    { instructions: "Read-only access to the Environmental Safeguard Solutions CRM: jobs, contacts, property violations, tasks and the pipeline. AIRnyc member data is never available here. Nothing can be changed or sent through these tools." },
  );

  server.registerTool(
    "search_jobs",
    {
      title: "Search jobs",
      description: "Find jobs by job number, title, address, client organization or contact name. Optionally filter by stage or service code. Most recent first.",
      inputSchema: z.object({
        query: z.string().max(200).optional(),
        stage: z.enum(STAGES).optional(),
        service_code: z.enum(SERVICES).optional(),
        limit: z.number().int().min(1).max(50).optional(),
      }),
      annotations: readOnly,
    },
    async (a) => json(await run((tx) => searchJobs(tx, a))),
  );

  server.registerTool(
    "get_job",
    {
      title: "Get job",
      description: "Full details for one job by job number (e.g. ESS-2026-0142): client, contact, address, dates, samples, open tasks, documents, and financials if you are allowed to see them.",
      inputSchema: z.object({ job_number: z.string().min(3).max(40) }),
      annotations: readOnly,
    },
    async ({ job_number }) => {
      const job = await run((tx) => getJob(tx, job_number));
      return job ? json(job) : { ...json({ error: `No job ${job_number}` }), isError: true };
    },
  );

  server.registerTool(
    "search_contacts",
    {
      title: "Search contacts",
      description: "Find contacts by name, organization, email or phone.",
      inputSchema: z.object({ query: z.string().min(2).max(200), limit: z.number().int().min(1).max(50).optional() }),
      annotations: readOnly,
    },
    async ({ query, limit }) => json(await run((tx) => searchContacts(tx, query, limit))),
  );

  server.registerTool(
    "property_violations",
    {
      title: "Open violations at a property",
      description: "Open HPD/DOB/ECB violations the CRM has synced for a property, looked up by street address (partial match) or 10-digit BBL.",
      inputSchema: z.object({ address: z.string().min(3).max(200).optional(), bbl: z.string().regex(/^\d{10}$/).optional() }),
      annotations: readOnly,
    },
    async (a) => json(await run((tx) => propertyViolations(tx, a))),
  );

  server.registerTool(
    "list_tasks",
    {
      title: "List open tasks",
      description: "Open tasks ordered by due date, optionally only overdue ones.",
      inputSchema: z.object({ overdue_only: z.boolean().optional(), limit: z.number().int().min(1).max(100).optional() }),
      annotations: readOnly,
    },
    async (a) => json(await run((tx) => listTasks(tx, a, now()))),
  );

  server.registerTool(
    "pipeline_summary",
    {
      title: "Pipeline summary",
      description: "Job counts by stage, overdue task count, bids due in the next 7 days, and (owner only) unpaid invoice totals by age.",
      annotations: readOnly,
    },
    async () => json(await run((tx) => pipelineSummary(tx, user.role === "OWNER", now()))),
  );

  return server;
}
