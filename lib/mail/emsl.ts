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
type StoredAttachment = { filename: string; contentType: string; storageBucket: string; storagePath: string; documentId?: string; ownerOnly?: boolean };

/**
 * EMSL emails carry three attachments; the one whose name ends in "002" is the lab report with
 * the chain of custody (per Jordan, 2026-09-24). The others include EMSL's invoice — lab cost,
 * so owner-only.
 */
export function isEmslReportFile(filename: string): boolean {
  return /002$/i.test(filename.replace(/\.[a-z0-9]{2,4}$/i, "").trim());
}

const SUFFIXES: Record<string, string> = {
  street: "st", avenue: "ave", av: "ave", road: "rd", place: "pl", boulevard: "blvd", drive: "dr",
  parkway: "pkwy", lane: "ln", court: "ct", terrace: "ter", west: "w", east: "e", north: "n", south: "s",
  apartment: "apt", unit: "apt",
};

/** "420_Central_Park_West_…" and "420 CENTRAL PARK WEST" normalize to the same words. */
export function normalizeAddress(v: string): string {
  return v
    .toLowerCase()
    .replace(/[_,.#/-]+/g, " ")
    .replace(/(\d+)(st|nd|rd|th)\b/g, "$1")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => SUFFIXES[w] ?? w)
    .join(" ");
}

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
  const isPdf = (a: StoredAttachment) => a.contentType === "application/pdf" || /\.pdf$/i.test(a.filename);
  // The report + COC attachment ends in "002"; fall back to the first non-owner-only PDF.
  const pdf = input.attachments.find((a) => isPdf(a) && isEmslReportFile(a.filename)) ?? input.attachments.find((a) => isPdf(a) && !a.ownerOnly);

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
    // EMSL puts the property address in the attachment file names
    // (e.g. "…_420_Central_Park_West_New_York_NY_10025_Apt_2E.pdf"): match jobs with samples
    // still out at the lab whose property address (and unit, if any) appears there.
    const haystack = ` ${normalizeAddress(text)} `;
    const candidates = await conn
      .select({ sampleId: s.samples.id, jobId: s.samples.jobId, coc: s.samples.cocNumber, address: s.properties.addressLine, unit: s.properties.unit })
      .from(s.samples)
      .innerJoin(s.jobs, eq(s.jobs.id, s.samples.jobId))
      .innerJoin(s.properties, eq(s.properties.id, s.jobs.propertyId))
      .where(and(eq(s.samples.status, "SUBMITTED"), isNull(s.samples.archivedAt), isNull(s.jobs.archivedAt)));
    const hits = candidates.filter((c) => {
      const addr = normalizeAddress(c.address);
      if (addr.length < 8 || !haystack.includes(` ${addr} `)) return false;
      return !c.unit || haystack.includes(` apt ${normalizeAddress(c.unit)} `) || haystack.includes(` ${normalizeAddress(c.unit)} `);
    });
    // Only trust an address match that points at a single job.
    if (new Set(hits.map((h) => h.jobId)).size === 1) matched = hits.map((h) => ({ id: h.sampleId, jobId: h.jobId, coc: h.coc }));
  }
  if (matched.length === 0) {
    await notifyOwners(conn, {
      title: "EMSL email didn't match any submitted sample — file it manually",
      description: "No pending chain-of-custody number, job number, or property address was found in the email. Open the Inbox review queue.",
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
