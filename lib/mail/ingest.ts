/**
 * Inbound email → CRM (SPEC §6.3). Pure DB + injected storage, so it is unit-testable and the
 * IMAP worker stays thin. Idempotent on Message-ID.
 *
 * Pipeline: parse → dedupe → direction (ESS-sent copies are EMAIL_OUT) → match contact/org →
 * attach to job (thread → job number → property address) and AIRnyc case (case-ID pattern) →
 * seal AIRnyc content → store attachments (+ documents rows, + Drive when configured) →
 * EMSL results parser → mark for AI triage.
 */
import { createHash } from "node:crypto";
import { and, eq, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import { simpleParser, type ParsedMail } from "mailparser";
import { schema as s, type Db, type Tx } from "@/lib/db";
import { findContactByEmail } from "@/lib/comms/contacts";
import { AIRNYC_CASE_ID_RE, sealContent } from "@/lib/comms/sensitive";
import { applyEmslResults, isEmslReportFile, isLikelyEmsl } from "./emsl";
import { JOB_NUMBER_RE } from "./patterns";

type Conn = Db | Tx;

export type Uploader = {
  upload(bucket: string, path: string, data: Buffer, contentType: string): Promise<void>;
};
export type DriveUploader = {
  uploadToFolder(folderId: string, name: string, data: Buffer, contentType: string): Promise<string>;
};

export type IngestResult = {
  duplicate: boolean;
  activityId?: string;
  direction?: "INBOUND" | "OUTBOUND";
  contactId?: string | null;
  jobId?: string | null;
  airnycCaseId?: string | null;
  sensitive?: boolean;
  emsl?: { matchedSamples: number; jobIds: string[] };
};

export const OWN_DOMAINS = ["ess-nyc.com", "gasproinspectors.com"];
const FREE_MAIL = new Set(["gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "aol.com", "icloud.com", "msn.com", "live.com", "me.com", "verizon.net", "optonline.net"]);

const domainOf = (addr?: string | null) => addr?.split("@")[1]?.toLowerCase() ?? null;
const refsOf = (m: ParsedMail): string[] =>
  [m.inReplyTo, ...(Array.isArray(m.references) ? m.references : m.references ? [m.references] : [])].filter((x): x is string => Boolean(x));

export async function ingestEmail(
  conn: Conn,
  raw: Buffer,
  opts: { mailbox: string; storage: Uploader; drive?: DriveUploader | null; now?: Date },
): Promise<IngestResult> {
  const m = await simpleParser(raw);
  const messageId = m.messageId ?? `<sha256-${createHash("sha256").update(raw).digest("hex")}@local>`;

  const [dupe] = await conn
    .select({ id: s.activities.id })
    .from(s.activities)
    .where(and(inArray(s.activities.type, ["EMAIL_IN", "EMAIL_OUT"]), eq(s.activities.externalId, messageId)))
    .limit(1);
  if (dupe) return { duplicate: true, activityId: dupe.id };

  const from = m.from?.value[0]?.address?.toLowerCase() ?? null;
  const toList = (Array.isArray(m.to) ? m.to : m.to ? [m.to] : []).flatMap((a) => a.value.map((v) => v.address?.toLowerCase())).filter(Boolean) as string[];
  const outbound = OWN_DOMAINS.includes(domainOf(from) ?? "");
  const counterpart = outbound ? (toList.find((a) => !OWN_DOMAINS.includes(domainOf(a) ?? "")) ?? toList[0]) : from;
  const subject = m.subject ?? "";
  const text = (m.text ?? "").slice(0, 200_000);
  const haystack = `${subject}\n${text}`;
  const [cfg] = await conn.select().from(s.settings);

  // --- who -------------------------------------------------------------------------------
  const contact = await findContactByEmail(conn, counterpart);
  let orgId = contact?.orgId ?? null;
  const dom = domainOf(counterpart);
  if (!orgId && dom && !FREE_MAIL.has(dom) && !OWN_DOMAINS.includes(dom)) {
    const [org] = await conn
      .select({ id: s.organizations.id })
      .from(s.organizations)
      .where(and(isNull(s.organizations.archivedAt), or(ilike(s.organizations.email, `%@${dom}`), ilike(s.organizations.website, `%${dom}%`))))
      .limit(1);
    orgId = org?.id ?? null;
  }

  // --- which job / case -----------------------------------------------------------------------
  let jobId: string | null = null;
  let propertyId: string | null = null;
  const refs = refsOf(m);
  if (refs.length) {
    const [prior] = await conn
      .select({ jobId: s.activities.jobId, caseId: s.activities.airnycCaseId, threadKey: s.activities.threadKey })
      .from(s.activities)
      .where(or(inArray(s.activities.externalId, refs), inArray(s.activities.threadKey, refs)))
      .limit(1);
    jobId = prior?.jobId ?? null;
  }
  if (!jobId) {
    const numbers = [...new Set((haystack.match(JOB_NUMBER_RE) ?? []).map((n) => n.toUpperCase()))];
    if (numbers.length) {
      const [j] = await conn.select({ id: s.jobs.id }).from(s.jobs).where(inArray(s.jobs.jobNumber, numbers)).limit(1);
      jobId = j?.id ?? null;
    }
  }
  if (!jobId && subject) {
    // Property address mentioned in the subject → that property's single open job.
    const props = await conn
      .select({ id: s.properties.id })
      .from(s.properties)
      .where(and(isNull(s.properties.archivedAt), sql`length(${s.properties.addressLine}) >= 6 and position(lower(${s.properties.addressLine}) in lower(${subject})) > 0`))
      .limit(2);
    if (props.length === 1) {
      propertyId = props[0].id;
      const jobs = await conn
        .select({ id: s.jobs.id })
        .from(s.jobs)
        .where(and(eq(s.jobs.propertyId, propertyId), isNull(s.jobs.archivedAt), sql`${s.jobs.stage} not in ('CLOSED','LOST','NEXT_CYCLE_SCHEDULED')`))
        .limit(2);
      if (jobs.length === 1) jobId = jobs[0].id;
    }
  }
  if (jobId && !propertyId) {
    const [j] = await conn.select({ p: s.jobs.propertyId }).from(s.jobs).where(eq(s.jobs.id, jobId));
    propertyId = j?.p ?? null;
  }

  const caseIds = [...new Set(haystack.match(AIRNYC_CASE_ID_RE) ?? [])];
  let airnycCaseId: string | null = null;
  if (caseIds.length) {
    const [c] = await conn
      .select({ id: s.airnycCases.id, jobId: s.airnycCases.jobId })
      .from(s.airnycCases)
      .where(sql`lower(${s.airnycCases.caseId}) in (${sql.join(caseIds.map((c) => sql`${c.toLowerCase()}`), sql`, `)})`)
      .limit(1);
    airnycCaseId = c?.id ?? null;
    jobId = jobId ?? c?.jobId ?? null;
  }
  const sensitive = Boolean(caseIds.length || airnycCaseId || (dom && cfg?.airnycSenderDomains.includes(dom)));

  // --- attachments ----------------------------------------------------------------------------
  const msgKey = createHash("sha256").update(messageId).digest("hex").slice(0, 16);
  const emsl = !outbound && isLikelyEmsl(from, subject);
  const stored: NonNullable<typeof s.activities.$inferInsert.attachments> = [];
  for (const a of m.attachments.filter((a) => a.contentDisposition !== "inline" || a.contentType === "application/pdf")) {
    const filename = (a.filename ?? `attachment-${stored.length + 1}`).replace(/[^\w.\- ]+/g, "_");
    // EMSL sends report+COC ("…002") plus other files that include its invoice (ESS's lab cost).
    // Everything except the report goes to the OWNER-only bucket (CLAUDE.md rule 4).
    const ownerOnly = emsl && !isEmslReportFile(filename);
    const bucket = ownerOnly ? "job-files-pricing" : "mail-attachments";
    const path = `mail/${(opts.now ?? new Date()).toISOString().slice(0, 7)}/${msgKey}/${filename}`;
    await opts.storage.upload(bucket, path, a.content, a.contentType);
    stored.push({ filename, contentType: a.contentType, size: a.size, storageBucket: bucket, storagePath: path, ...(ownerOnly ? { ownerOnly } : {}) });
  }

  // --- the activity ---------------------------------------------------------------------------
  const [activity] = await conn
    .insert(s.activities)
    .values({
      type: outbound ? "EMAIL_OUT" : "EMAIL_IN",
      direction: outbound ? "OUTBOUND" : "INBOUND",
      contactId: contact?.id,
      propertyId,
      jobId,
      airnycCaseId,
      channelLine: opts.mailbox,
      fromAddress: from,
      toAddress: toList.join(", "),
      externalId: messageId,
      threadKey: refs.at(-1) ?? messageId,
      occurredAt: m.date ?? opts.now ?? new Date(),
      attachments: stored,
      raw: { headers: Object.fromEntries([...m.headers.entries()].filter(([k]) => ["from", "to", "cc", "date", "subject"].includes(k)).map(([k, v]) => [k, String(v)])) },
      // Outbound copies and lab reports don't need AI triage; everything else inbound does (§9.1).
      triageStatus: outbound ? "SKIPPED" : emsl ? "AUTO" : "PENDING",
      triageCategory: emsl ? "LAB_RESULT" : null,
      ...(sensitive ? sealContent({ subject, body: text }) : { subject, body: text }),
    })
    .returning({ id: s.activities.id });

  // Attachments on a matched job become job documents (so they show on the job and hit Drive).
  if (jobId && stored.length) {
    const [job] = await conn.select({ driveFolderId: s.jobs.driveFolderId }).from(s.jobs).where(eq(s.jobs.id, jobId));
    for (const att of stored) {
      let driveFileId: string | undefined;
      // Owner-only files (EMSL invoices) stay out of the shared job Drive folder.
      if (opts.drive && job?.driveFolderId && !att.ownerOnly) {
        const src = m.attachments.find((x) => (x.filename ?? "").replace(/[^\w.\- ]+/g, "_") === att.filename);
        if (src) driveFileId = await opts.drive.uploadToFolder(job.driveFolderId, att.filename, src.content, att.contentType).catch(() => undefined);
      }
      const [doc] = await conn
        .insert(s.documents)
        .values({
          jobId,
          kind: emsl && !att.ownerOnly && att.contentType === "application/pdf" ? "LAB_RESULT" : "OTHER",
          title: att.filename,
          status: "FINAL",
          containsPricing: Boolean(att.ownerOnly),
          storageBucket: att.storageBucket,
          storagePath: att.storagePath,
          driveFileId,
        })
        .returning({ id: s.documents.id });
      att.documentId = doc.id;
    }
    await conn.update(s.activities).set({ attachments: stored }).where(eq(s.activities.id, activity.id));
  }

  const result: IngestResult = {
    duplicate: false,
    activityId: activity.id,
    direction: outbound ? "OUTBOUND" : "INBOUND",
    contactId: contact?.id ?? null,
    jobId,
    airnycCaseId,
    sensitive,
  };
  if (emsl) result.emsl = await applyEmslResults(conn, { text: haystack, attachments: stored, activityId: activity.id });
  return result;
}
