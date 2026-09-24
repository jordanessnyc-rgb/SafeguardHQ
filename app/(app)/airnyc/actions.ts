"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { schema as s } from "@/lib/db";
import { requireStaff } from "@/lib/auth/session";
import { checkbox, formObject, optionalUuid, safeAction, type ActionState } from "@/lib/actions";
import { encryptMember, getCase, networkFromCaseId } from "@/lib/airnyc/cases";
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
