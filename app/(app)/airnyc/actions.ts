"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { schema as s } from "@/lib/db";
import { requireStaff } from "@/lib/auth/session";
import { checkbox, formObject, optionalUuid, safeAction, type ActionState } from "@/lib/actions";
import { encryptMember, getCase, networkFromCaseId } from "@/lib/airnyc/cases";
import { adminDb } from "@/lib/db";
import { graphFromEnv } from "@/lib/integrations/microsoft-graph";
import { uploadToCase } from "@/lib/airnyc/graph-sync";
import { storageDownloader } from "@/lib/supabase/service";

import { ensureCaseDriveFolder } from "@/lib/airnyc/drive";
import { pipelineForService } from "@/lib/pipeline/config";
import { toE164 } from "@/lib/phone";

const consent = z.enum(s.consentStatusEnum.enumValues);

const caseSchema = z.object({
  caseId: z
    .string()
    .min(3, "Case ID is required")
    .max(40)
    .regex(/^[A-Za-z]+[_-]?\w+$/, "Case IDs look like PHS_0148"),
  memberName: z.string().max(200).optional(),
  guardianName: z.string().max(200).optional(),
  memberPhone: z.string().optional().transform((v) => (v ? (toE164(v) ?? v) : undefined)),
  address: z.string().max(300).optional(),
  propertyId: optionalUuid,
  caseManagerName: z.string().max(200).optional(),
  caseManagerEmail: z.email().optional(),
  approvedServices: z.string().optional().transform((v) => (v ?? "").split(/[,\n]/).map((x) => x.trim()).filter(Boolean)),
  trackerRow: z.coerce.number().int().positive().optional(),
  landlordConsentStatus: consent,
  tenantConsentStatus: consent,
  isNycha: checkbox,
  qcReviewer: z.string().max(200).optional(),
  qcStatus: z.enum(s.qcStatusEnum.enumValues),
  sharepointFolderUrl: z.url().optional(),
  scopeNotCovered: checkbox,
  outOfScopeObservations: z.string().max(5000).optional(),
});

const parse = (form: FormData) =>
  caseSchema.parse({
    ...formObject(form),
    isNycha: form.get("isNycha"),
    scopeNotCovered: form.get("scopeNotCovered"),
  });

function toColumns(input: z.infer<typeof caseSchema>) {
  const { memberName, guardianName, memberPhone, address, ...rest } = input;
  return {
    ...rest,
    caseId: rest.caseId.trim(),
    network: networkFromCaseId(rest.caseId),
    ...encryptMember({ memberName: memberName ?? null, guardianName: guardianName ?? null, memberPhone: memberPhone ?? null, address: address ?? null }),
  };
}

export async function createCase(_prev: ActionState, form: FormData): Promise<ActionState> {
  const user = await requireStaff();
  let id: string | undefined;
  const res = await safeAction(async () => {
    const values = toColumns(parse(form));
    [{ id }] = await user.db((tx) => tx.insert(s.airnycCases).values(values).returning({ id: s.airnycCases.id }));
    await user.db((tx) => ensureCaseDriveFolder(tx, user.id, id!)).catch((e) => console.error("Drive folder failed", e));
  });
  if (res.error || !id) return res;
  redirect(`/airnyc/${id}`);
}

export async function updateCase(id: string, _prev: ActionState, form: FormData): Promise<ActionState> {
  const user = await requireStaff();
  const res = await safeAction(async () => {
    const v = toColumns(parse(form));
    await user.db((tx) =>
      tx
        .update(s.airnycCases)
        .set({
          ...v,
          propertyId: v.propertyId ?? null,
          caseManagerName: v.caseManagerName ?? null,
          caseManagerEmail: v.caseManagerEmail ?? null,
          trackerRow: v.trackerRow ?? null,
          qcReviewer: v.qcReviewer ?? null,
          sharepointFolderUrl: v.sharepointFolderUrl ?? null,
          outOfScopeObservations: v.outOfScopeObservations ?? null,
        })
        .where(eq(s.airnycCases.id, id)),
    );
    return { ok: true, message: "Saved." };
  });
  revalidatePath(`/airnyc/${id}`);
  return res;
}

export async function moveCaseStage(id: string, _prev: ActionState, form: FormData): Promise<ActionState> {
  const user = await requireStaff();
  const res = await safeAction(async () => {
    const stage = z.string().min(1).parse(formObject(form).stage);
    await user.db((tx) => tx.update(s.airnycCases).set({ stage }).where(eq(s.airnycCases.id, id)));
    return { ok: true, message: "Stage updated." };
  });
  revalidatePath(`/airnyc/${id}`);
  revalidatePath("/airnyc");
  return res;
}

export async function toggleChecklistItem(caseId: string, itemId: string, done: boolean) {
  const user = await requireStaff();
  await user.db((tx) =>
    done
      ? tx.insert(s.airnycCaseChecklist).values({ caseId, itemId, doneBy: user.id }).onConflictDoNothing()
      : tx.delete(s.airnycCaseChecklist).where(and(eq(s.airnycCaseChecklist.caseId, caseId), eq(s.airnycCaseChecklist.itemId, itemId))),
  );
  revalidatePath(`/airnyc/${caseId}`);
}

export async function createCaseDriveFolder(id: string, _prev: ActionState): Promise<ActionState> {
  const user = await requireStaff();
  const res = await safeAction(async () => {
    const out = await user.db((tx) => ensureCaseDriveFolder(tx, user.id, id));
    return out.skipped ? { error: out.skipped } : { ok: true, message: "Drive folder ready." };
  });
  revalidatePath(`/airnyc/${id}`);
  return res;
}

/** Creates the ESS assessment job for this case (service AIRNYC) and links both ways. */
export async function createJobForCase(id: string, _prev: ActionState): Promise<ActionState> {
  const user = await requireStaff();
  let jobId: string | undefined;
  const res = await safeAction(async () => {
    jobId = await user.db(async (tx) => {
      const c = await getCase(tx, user.id, id);
      if (!c) throw new Error("Case not found");
      if (c.jobId) return c.jobId;
      const pipeline = await pipelineForService(tx, "AIRNYC");
      const [job] = await tx
        .insert(s.jobs)
        .values({
          serviceCode: "AIRNYC",
          pipelineKey: pipeline.key,
          stage: pipeline.stages[0].key,
          propertyId: c.propertyId,
          airnycCaseId: c.id,
          source: "REFERRAL",
          title: `AIRnyc ${c.caseId}${c.approvedServices.length ? ` — ${c.approvedServices.join(", ")}` : ""}`,
        })
        .returning({ id: s.jobs.id });
      await tx.update(s.airnycCases).set({ jobId: job.id }).where(eq(s.airnycCases.id, id));
      return job.id;
    });
  });
  if (res.error || !jobId) return res;
  redirect(`/jobs/${jobId}`);
}

const MIME: Record<string, string> = { pdf: "application/pdf", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", zip: "application/zip" };

/**
 * "Send to AIRnyc": copies one of the case's job documents into the case's SharePoint folder over
 * Microsoft Graph (SPEC §7.4 mode 4). A person clicks it each time (CLAUDE.md rule 6). Documents that
 * carry ESS pricing (lab invoices, quotes) are refused outright (rule 4).
 */
export async function sendDocumentToAirnyc(caseId: string, documentId: string, _prev: ActionState): Promise<ActionState> {
  const user = await requireStaff();
  return safeAction(async () => {
    const graph = graphFromEnv();
    if (!graph) throw new Error("The Microsoft connection isn't set up on the server yet (see Settings → AIRnyc).");
    const { kase, doc, cfg } = await user.db(async (tx) => {
      const kase = await getCase(tx, user.id, caseId);
      if (!kase) throw new Error("Case not found.");
      const [doc] = await tx.select().from(s.documents).where(and(eq(s.documents.id, documentId), isNull(s.documents.archivedAt)));
      if (!doc || !kase.jobId || doc.jobId !== kase.jobId) throw new Error("That document isn't on this case's job.");
      if (doc.containsPricing) throw new Error("That document contains ESS pricing and can't be sent to AIRnyc.");
      if (!doc.storageBucket || !doc.storagePath) throw new Error("That document has no file to send.");
      const [cfg] = await tx.select({ airnycRootFolderUrl: s.settings.airnycRootFolderUrl }).from(s.settings);
      return { kase, doc, cfg };
    });
    const data = await storageDownloader().download(doc.storageBucket!, doc.storagePath!);
    const ext = (doc.storagePath!.match(/\.([a-z0-9]+)$/i)?.[1] ?? "").toLowerCase();
    const title = doc.title?.trim() || `${doc.kind.toLowerCase()}-${doc.id.slice(0, 8)}`;
    const name = /\.[a-z0-9]+$/i.test(title) ? title : ext ? `${title}.${ext}` : title;
    const sent = await uploadToCase(adminDb(), graph, cfg ?? { airnycRootFolderUrl: null }, kase, { name: name.replace(/[\\/:*?"<>|]+/g, "_"), data, contentType: MIME[ext] ?? "application/octet-stream" }, user.id);
    await adminDb().insert(s.activities).values({ type: "DOC", airnycCaseId: caseId, jobId: kase.jobId, summary: `Sent "${name}" to AIRnyc's SharePoint folder`, externalUrl: sent.webUrl, triageStatus: "SKIPPED" });
    revalidatePath(`/airnyc/${caseId}`);
    return { ok: true, message: `Sent ${name} to AIRnyc's folder.` };
  });
}
