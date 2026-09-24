/**
 * EMSL lab results (SPEC §6.3 "Special parsers"). EMSL's email layout isn't something we control,
 * so instead of parsing a fixed format we look for the chain-of-custody numbers ESS is *waiting
 * on* (samples in SUBMITTED status) anywhere in the subject, body, or attachment file names.
 * Fallback: an ESS job number in the email with samples still SUBMITTED.
 *
 * Match → samples RESULTS_IN + result PDF attached, LAB_RESULT document on the job, job moves
 * Lab Pending → Drafting once nothing is still out at the lab, and a task notifies the owner.
 */
import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { schema as s, type Db, type Tx } from "@/lib/db";
import { JOB_NUMBER_RE } from "./patterns";

type Conn = Db | Tx;
type StoredAttachment = { filename: string; contentType: string; storageBucket: string; storagePath: string; documentId?: string };

export function isLikelyEmsl(from: string | null, subject: string): boolean {
  return /(^|[@.])emsl\.com$/i.test(from?.split("@")[1] ?? "") || /\bEMSL\b/i.test(subject);
}

const escapeRe = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Does `text` contain `token` as a whole token (not part of a longer number)? */
export function containsToken(text: string, token: string): boolean {
  return new RegExp(`(^|[^A-Za-z0-9])${escapeRe(token)}($|[^A-Za-z0-9])`, "i").test(text);
}

export async function applyEmslResults(
  conn: Conn,
  input: { text: string; attachments: StoredAttachment[]; activityId: string; now?: Date },
): Promise<{ matchedSamples: number; jobIds: string[] }> {
  const now = input.now ?? new Date();
  const text = `${input.text}\n${input.attachments.map((a) => a.filename).join("\n")}`;
  const pdf = input.attachments.find((a) => a.contentType === "application/pdf" || /\.pdf$/i.test(a.filename));

  const pending = await conn
    .select({ id: s.samples.id, jobId: s.samples.jobId, coc: s.samples.cocNumber })
    .from(s.samples)
    .where(and(eq(s.samples.status, "SUBMITTED"), isNull(s.samples.archivedAt), isNotNull(s.samples.cocNumber)));
  let matched = pending.filter((p) => p.coc && p.coc.trim().length >= 3 && containsToken(text, p.coc.trim()));

  if (matched.length === 0) {
    const numbers = [...new Set((text.match(JOB_NUMBER_RE) ?? []).map((n) => n.toUpperCase()))];
    if (numbers.length) {
      const jobs = await conn.select({ id: s.jobs.id }).from(s.jobs).where(inArray(s.jobs.jobNumber, numbers));
      const ids = new Set(jobs.map((j) => j.id));
      matched = (
        await conn
          .select({ id: s.samples.id, jobId: s.samples.jobId, coc: s.samples.cocNumber })
          .from(s.samples)
          .where(and(eq(s.samples.status, "SUBMITTED"), isNull(s.samples.archivedAt)))
      ).filter((x) => ids.has(x.jobId));
    }
  }
  if (matched.length === 0) {
    await notifyOwners(conn, {
      title: "EMSL email didn't match any submitted sample — file it manually",
      description: "No pending chain-of-custody number or job number was found in the email. Open the Inbox review queue.",
    });
    return { matchedSamples: 0, jobIds: [] };
  }

  await conn
    .update(s.samples)
    .set({
      status: "RESULTS_IN",
      resultsReceivedAt: now,
      ...(pdf ? { resultPdfPath: `${pdf.storageBucket}/${pdf.storagePath}` } : {}),
    })
    .where(inArray(s.samples.id, matched.map((m) => m.id)));

  const jobIds = [...new Set(matched.map((m) => m.jobId))];
  for (const jobId of jobIds) {
    const [job] = await conn.select().from(s.jobs).where(eq(s.jobs.id, jobId));
    if (!job) continue;
    // Result PDF as a job document (ingest already did this if the email itself matched the job).
    if (pdf && !pdf.documentId) {
      const [existing] = await conn
        .select({ id: s.documents.id })
        .from(s.documents)
        .where(and(eq(s.documents.jobId, jobId), eq(s.documents.storagePath, pdf.storagePath)));
      if (!existing) {
        await conn.insert(s.documents).values({ jobId, kind: "LAB_RESULT", title: pdf.filename, status: "FINAL", storageBucket: pdf.storageBucket, storagePath: pdf.storagePath });
      }
    }
    const [stillOut] = await conn
      .select({ id: s.samples.id })
      .from(s.samples)
      .where(and(eq(s.samples.jobId, jobId), eq(s.samples.status, "SUBMITTED"), isNull(s.samples.archivedAt)))
      .limit(1);
    const moved = job.stage === "LAB_PENDING" && !stillOut;
    if (moved) await conn.update(s.jobs).set({ stage: "DRAFTING" }).where(eq(s.jobs.id, jobId));
    const count = matched.filter((m) => m.jobId === jobId).length;
    await notifyOwners(conn, {
      title: `Lab results in — ${job.jobNumber} (${count} sample${count === 1 ? "" : "s"})`,
      description: moved ? "Job moved to Drafting." : stillOut ? "Some samples are still out at the lab." : `Job is in ${job.stage}; stage unchanged.`,
      jobId,
    });
  }
  // File the email under the (first) job if ingest couldn't place it.
  await conn
    .update(s.activities)
    .set({ jobId: jobIds[0] })
    .where(and(eq(s.activities.id, input.activityId), isNull(s.activities.jobId)));
  return { matchedSamples: matched.length, jobIds };
}

async function notifyOwners(conn: Conn, t: { title: string; description: string; jobId?: string }) {
  const owners = await conn.select({ id: s.profiles.userId }).from(s.profiles).where(eq(s.profiles.role, "OWNER"));
  const assignees = owners.length ? owners.map((o) => o.id) : [null];
  await conn.insert(s.tasks).values(
    assignees.map((assignee) => ({ ...t, assignee, source: "SYSTEM_RULE" as const, dueAt: new Date(Date.now() + 24 * 3600_000) })),
  );
}
