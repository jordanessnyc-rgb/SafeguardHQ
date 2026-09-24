/**
 * AI report drafting (SPEC §9.5): field data + photo captions + sample results → a section-by-
 * section draft rendered into the ESS report template, saved as a DRAFT report document, with a
 * review task for Jordan. Nothing is finalized by AI; the draft carries a visible notice, and
 * legal/limitations language comes only from Jordan's template.
 */
import { randomUUID } from "node:crypto";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { schema as s, type Db } from "@/lib/db";
import { getCase } from "@/lib/airnyc/cases";
import { BRAND_INFO } from "@/lib/comms/templates";
import { DOCX_TYPE } from "@/lib/docs/proposal";
import { loadTemplate, renderDocx, type Photo } from "@/lib/docs/render";
import { label, personName, SERVICE_LABELS } from "@/lib/labels";
import type { Uploader } from "@/lib/mail/ingest";
import type { Downloader } from "@/lib/supabase/service";
import { ownerTask } from "@/lib/tasks";
import { AI_MODELS } from "./config";
import { guardedParse, type AnthropicLike } from "./anthropic";
import { REPORT_SYSTEM } from "./prompts/report";

/** Sections the AI drafts. Limitations, certifications and signatures are template text (Jordan's). */
export const REPORT_SECTIONS = [
  { key: "summary", title: "Summary of findings" },
  { key: "scope", title: "Scope of assessment" },
  { key: "observations", title: "Observations by area" },
  { key: "results", title: "Laboratory results" },
  { key: "recommendations", title: "Recommendations" },
] as const;
const KEYS = REPORT_SECTIONS.map((x) => x.key) as [string, ...string[]];

export const ReportSchema = z.object({
  sections: z.array(z.object({ key: z.enum(KEYS), title: z.string(), body: z.string() })),
  open_questions: z.array(z.string()),
});

const MAX_PHOTOS = 40;

export type ReportDraftResult =
  | { status: "drafted"; documentId: string; openQuestions: string[]; placeholder: boolean }
  | { status: "blocked" | "error" | "skipped"; reason: string };

export async function draftReport(
  db: Db,
  jobId: string,
  deps: { storage: Uploader & Downloader; api?: AnthropicLike; actorId?: string | null },
  now = new Date(),
): Promise<ReportDraftResult> {
  const [row] = await db
    .select({ job: s.jobs, prop: s.properties, org: s.organizations, contact: s.contacts, fd: s.fieldData })
    .from(s.jobs)
    .leftJoin(s.properties, eq(s.properties.id, s.jobs.propertyId))
    .leftJoin(s.organizations, eq(s.organizations.id, s.jobs.clientOrgId))
    .leftJoin(s.contacts, eq(s.contacts.id, s.jobs.clientContactId))
    .leftJoin(s.fieldData, eq(s.fieldData.jobId, s.jobs.id))
    .where(eq(s.jobs.id, jobId));
  if (!row) return { status: "skipped", reason: "Job not found." };
  const { job, prop, fd } = row;
  const samples = await db.select().from(s.samples).where(and(eq(s.samples.jobId, jobId), isNull(s.samples.archivedAt))).orderBy(asc(s.samples.sampleId));
  if (!fd?.observations?.trim() && !(fd?.readings ?? []).length && !(fd?.photos ?? []).length && !samples.length) {
    return { status: "skipped", reason: "Add field data (observations, readings, photos) or samples first — the draft is written only from those." };
  }

  const airnycLinked = job.airnycCaseId != null;
  const [cfg] = await db.select().from(s.settings);
  const kase = airnycLinked && cfg?.airnycAiAllowed ? await getCase(db, deps.actorId ?? null, job.airnycCaseId!) : null;
  const knownNames = [kase?.memberName, kase?.guardianName, row.contact?.firstName, row.contact?.lastName].filter((n): n is string => Boolean(n?.trim()));
  if (airnycLinked && cfg?.airnycAiAllowed && knownNames.length === 0) {
    return { status: "blocked", reason: "AIRnyc job without a known member name to redact — not sent to AI." };
  }

  const service = label(SERVICE_LABELS, job.serviceCode);
  const photos = (fd?.photos ?? []).slice(0, MAX_PHOTOS);
  const userText = [
    `SERVICE: ${service}`,
    prop && `PROPERTY: ${[prop.addressLine, prop.unit && `Apt ${prop.unit}`, prop.borough].filter(Boolean).join(", ")}${prop.buildingClass ? ` (building class ${prop.buildingClass})` : ""}${prop.yearBuilt ? `, built ${prop.yearBuilt}` : ""}`,
    job.fieldCompletedAt && `FIELD WORK: ${job.fieldCompletedAt.toISOString().slice(0, 10)}`,
    fd?.areas?.length ? `AREAS INSPECTED: ${fd.areas.join(", ")}` : null,
    fd?.observations?.trim() ? `FIELD OBSERVATIONS:\n${fd.observations.trim().slice(0, 20_000)}` : "FIELD OBSERVATIONS: none recorded",
    (fd?.readings ?? []).length
      ? `READINGS (area | moisture % | RH % | temp °F | note):\n${fd!.readings.map((r) => `- ${r.area} | ${r.moisture ?? "—"} | ${r.rh ?? "—"} | ${r.temp ?? "—"} | ${r.note ?? ""}`).join("\n")}`
      : null,
    photos.length ? `PHOTOS (numbered as in the photo log):\n${photos.map((p, i) => `${i + 1}. ${p.area ? `[${p.area}] ` : ""}${p.caption}`).join("\n")}` : null,
    samples.length
      ? `SAMPLES:\n${samples.map((x) => `- ${x.sampleId} | ${x.type} | ${x.location ?? "—"} | status ${x.status}${x.results ? ` | results ${JSON.stringify(x.results).slice(0, 800)}` : " | results: see laboratory report"}`).join("\n")}`
      : "SAMPLES: none",
    "",
    `SECTIONS TO WRITE (in order): ${REPORT_SECTIONS.map((x) => `${x.key} = "${x.title}"`).join("; ")}`,
  ]
    .filter((x): x is string => typeof x === "string")
    .join("\n");

  const res = await guardedParse(
    db,
    { feature: "REPORT_DRAFT", model: AI_MODELS.report, system: REPORT_SYSTEM, userText, schema: ReportSchema, airnycLinked, knownNames, jobId, maxTokens: 12_000 },
    deps.api,
  );
  if (res.status !== "ok") return { status: res.status, reason: res.status === "blocked" ? res.reason : res.error };

  // Keep the fixed section order; anything the model skipped shows up as a visible gap.
  const byKey = new Map(res.output.sections.map((x) => [x.key, x]));
  const sections = REPORT_SECTIONS.map((x) => ({ title: x.title, body: byKey.get(x.key)?.body ?? `[Jordan: section not drafted]` }));

  const images: Photo[] = [];
  for (const p of photos) {
    const data = await deps.storage.download("job-files", p.path);
    images.push({ data, ext: p.contentType === "image/png" ? "png" : "jpeg", caption: [p.area, p.caption].filter(Boolean).join(" — "), widthPx: p.width, heightPx: p.height });
  }
  const tpl = loadTemplate("ESS_Report");
  const buffer = renderDocx(
    tpl.buffer,
    {
      brand_name: BRAND_INFO[job.brand].name,
      report_title: `${service} Report`,
      draft_notice: "AI DRAFT — for Jordan Adhami's review and editing. Not for release.",
      report_status: "DRAFT",
      job_number: job.jobNumber,
      report_date: now.toLocaleDateString("en-US", { timeZone: "America/New_York", dateStyle: "long" }),
      client_name: row.org?.name ?? (row.contact ? personName(row.contact) : null),
      property_address: prop ? [prop.addressLine, prop.unit && `Apt ${prop.unit}`, prop.borough, prop.zip].filter(Boolean).join(", ") : null,
      assessor: "Jordan Adhami",
      sections,
      samples: samples.map((x) => ({ sample_id: x.sampleId, type: x.type, location: x.location ?? "", result: x.results ? JSON.stringify(x.results).slice(0, 200) : x.status === "COLLECTED" ? "pending" : "see laboratory report" })),
    },
    images,
  );

  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(s.documents).where(and(eq(s.documents.jobId, jobId), eq(s.documents.kind, "REPORT")));
  const title = `Report draft ${job.jobNumber} v${n + 1}.docx`;
  const storagePath = `jobs/${jobId}/${randomUUID()}-${title.replace(/[^\w.\- ]+/g, "_")}`;
  await deps.storage.upload("job-files", storagePath, buffer, DOCX_TYPE);
  const [doc] = await db
    .insert(s.documents)
    .values({ jobId, kind: "REPORT", status: "DRAFT", version: n + 1, title, containsPricing: false, storageBucket: "job-files", storagePath })
    .returning({ id: s.documents.id });
  await ownerTask(db, {
    title: `Review the AI report draft for ${job.jobNumber}`,
    description: res.output.open_questions.length ? `Open questions:\n${res.output.open_questions.map((q) => `- ${q}`).join("\n")}` : "No open questions flagged.",
    jobId,
  });
  return { status: "drafted", documentId: doc.id, openQuestions: res.output.open_questions, placeholder: tpl.placeholder };
}
