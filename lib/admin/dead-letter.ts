/**
 * Failed background jobs (SPEC §13 "dead-letter queue visible in an admin page"). The worker's
 * pg-boss queues send a job here after its last retry; the owner can retry or dismiss it.
 * Verified against pg-boss 12.34 (installed types): findJobs(), redrive({ids}) moves a dead-lettered
 * job back to its source queue, deleteJob() removes it. job.sourceName/sourceId/sourceRetryCount
 * describe the original failure.
 */
import { PgBoss } from "pg-boss";

export const DEAD_LETTER_QUEUE = "dead-letter";

export type DeadJob = { id: string; queue: string | null; data: unknown; failedAt: Date; retries: number | null; error: string | null };

let boss: Promise<PgBoss> | null = null;
/** A pg-boss client for the web app: no maintenance, scheduling or migrations (the worker owns those). */
export function webBoss(url = process.env.DATABASE_URL): Promise<PgBoss> {
  if (!url) throw new Error("DATABASE_URL is not set");
  boss ??= new PgBoss({ connectionString: url, supervise: false, schedule: false, migrate: false, max: 2 }).start();
  return boss;
}

function errorText(output: unknown): string | null {
  if (!output || typeof output !== "object") return null;
  const o = output as { message?: unknown; value?: unknown };
  return typeof o.message === "string" ? o.message : typeof o.value === "string" ? o.value : JSON.stringify(output).slice(0, 300);
}

export async function listDeadJobs(b: PgBoss): Promise<DeadJob[]> {
  const queues = await b.getQueues();
  if (!queues.some((q) => q.name === DEAD_LETTER_QUEUE)) return [];
  const jobs = await b.findJobs(DEAD_LETTER_QUEUE, { queued: true });
  const out: DeadJob[] = [];
  for (const j of jobs) {
    // The error lives on the original failed job (if pg-boss hasn't archived it yet).
    const src = j.sourceName && j.sourceId ? (await b.findJobs(j.sourceName, { id: j.sourceId }))[0] : undefined;
    out.push({ id: j.id, queue: j.sourceName, data: j.data, failedAt: j.createdOn, retries: j.sourceRetryCount, error: errorText(src?.output ?? j.output) });
  }
  return out.sort((a, b) => b.failedAt.getTime() - a.failedAt.getTime());
}

export const retryDeadJobs = (b: PgBoss, ids: string[]) => b.redrive(DEAD_LETTER_QUEUE, { ids });
export const dismissDeadJobs = (b: PgBoss, ids: string[]) => b.deleteJob(DEAD_LETTER_QUEUE, ids);
