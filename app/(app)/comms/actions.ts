"use server";

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { adminDb, schema as s } from "@/lib/db";
import { requireStaff } from "@/lib/auth/session";
import { formObject, optionalUuid, safeAction, type ActionState } from "@/lib/actions";
import { approve, createDraft, sendApproved } from "@/lib/comms/outbound";
import { revealActivity, type SensitiveContent } from "@/lib/comms/sensitive";
import { hasUnfilledPlaceholder, renderTemplate } from "@/lib/comms/templates";
import { templateVars } from "@/lib/comms/template-vars";
import { quoFromEnv } from "@/lib/integrations/quo";
import { mailSenderFromEnv } from "@/lib/integrations/titan-mail";
import { toE164 } from "@/lib/phone";

const deps = () => ({ quo: quoFromEnv(), mail: mailSenderFromEnv() });

export async function renderTemplateFor(key: string, ids: { contactId?: string; jobId?: string }) {
  const user = await requireStaff();
  return user.db(async (tx) => {
    const [tpl] = await tx.select().from(s.messageTemplates).where(eq(s.messageTemplates.key, key));
    if (!tpl) return { text: "", subject: null, missing: [] as string[] };
    const vars = await templateVars(tx, ids);
    return {
      ...renderTemplate(tpl.body, vars, { missing: "placeholder" }),
      subject: tpl.subject ? renderTemplate(tpl.subject, vars, { missing: "placeholder" }).text : null,
    };
  });
}

const composeSchema = z
  .object({
    channel: z.enum(["SMS", "EMAIL"]),
    to: z.string().min(3, "Recipient is required"),
    fromLineId: optionalUuid,
    fromEmail: z.email().optional(),
    subject: z.string().max(300).optional(),
    body: z.string().min(1, "Write a message").max(20_000),
    templateKey: z.string().optional(),
    contactId: optionalUuid,
    jobId: optionalUuid,
    airnycCaseId: optionalUuid,
    inReplyTo: z.string().optional(),
    intent: z.enum(["draft", "send"]),
  })
  .superRefine((v, ctx) => {
    if (v.channel === "SMS" && !toE164(v.to)) ctx.addIssue({ code: "custom", path: ["to"], message: "Not a valid phone number" });
    if (v.channel === "SMS" && !v.fromLineId) ctx.addIssue({ code: "custom", path: ["fromLineId"], message: "Pick a Quo line" });
    if (v.channel === "EMAIL" && !z.email().safeParse(v.to).success) ctx.addIssue({ code: "custom", path: ["to"], message: "Not a valid email" });
  });

/** Staff compose → DRAFT, or DRAFT → approved-by-them → sent ("Send now" is a human approval). */
export async function composeMessage(_prev: ActionState, form: FormData): Promise<ActionState> {
  const user = await requireStaff();
  const res = await safeAction(async () => {
    const v = composeSchema.parse(formObject(form));
    const unfilled = v.intent === "send" && hasUnfilledPlaceholder(`${v.subject ?? ""} ${v.body}`);
    if (unfilled) throw new Error(`Fill in ${unfilled} before sending (or save as a draft).`);
    const containsPricing = form.get("containsPricing") === "on";
    if (containsPricing && user.role !== "OWNER") throw new Error("Only the owner can send messages that include pricing.");
    const draft = await user.db(async (tx) => {
      const [job] = v.jobId ? await tx.select({ brand: s.jobs.brand }).from(s.jobs).where(eq(s.jobs.id, v.jobId)) : [];
      return createDraft(tx, {
        channel: v.channel,
        source: v.templateKey ? "TEMPLATE" : "MANUAL",
        templateKey: v.templateKey,
        toAddress: v.channel === "SMS" ? toE164(v.to)! : v.to,
        fromLineId: v.channel === "SMS" ? v.fromLineId : null,
        fromEmail: v.channel === "EMAIL" ? v.fromEmail : null,
        subject: v.channel === "EMAIL" ? (v.subject ?? "") : null,
        body: v.body,
        inReplyTo: v.inReplyTo,
        brand: job?.brand ?? "ESS",
        contactId: v.contactId,
        jobId: v.jobId,
        airnycCaseId: v.airnycCaseId,
        containsPricing,
      });
    });
    if (v.intent === "draft") return { ok: true, message: "Saved to the Outbox for approval." };
    // Approve under the user's RLS (proves they may send it), then send OUTSIDE any transaction —
    // SMTP/Quo can take seconds and must not hold a database transaction open.
    await user.db((tx) => approve(tx, draft.id, user.id));
    const sent = await sendApproved(adminDb(), draft.id, deps());
    return sent.status === "SENT" ? { ok: true, message: "Sent." } : { error: `Not sent: ${sent.error}. It's in the Outbox to retry.` };
  });
  revalidatePath("/outbox");
  const back = formObject(form).revalidate;
  if (back?.startsWith("/")) revalidatePath(back);
  return res;
}

export async function approveAndSend(id: string, _prev: ActionState, form: FormData): Promise<ActionState> {
  const user = await requireStaff();
  const res = await safeAction(async () => {
    const { body, subject } = formObject(form);
    const unfilled = hasUnfilledPlaceholder(`${subject ?? ""} ${body ?? ""}`);
    if (unfilled) throw new Error(`Fill in ${unfilled} before sending.`);
    await user.db((tx) => approve(tx, id, user.id, { ...(body ? { body } : {}), ...(subject !== undefined ? { subject } : {}) }));
    const sent = await sendApproved(adminDb(), id, deps());
    return sent.status === "SENT" ? { ok: true, message: "Sent." } : { error: `Failed: ${sent.error}` };
  });
  revalidatePath("/outbox");
  return res;
}

export async function discardMessage(id: string) {
  const user = await requireStaff();
  await user.db((tx) =>
    tx.update(s.outboundMessages).set({ status: "DISCARDED" }).where(and(eq(s.outboundMessages.id, id), eq(s.outboundMessages.status, "DRAFT"))),
  );
  revalidatePath("/outbox");
}

/** Decrypts a sealed (AIRnyc) activity for display; every call writes an audit_log row. */
export async function revealSensitive(activityId: string): Promise<SensitiveContent> {
  const user = await requireStaff();
  return user.db(async (tx) => {
    const [a] = await tx.select({ id: s.activities.id, sensitiveEnc: s.activities.sensitiveEnc }).from(s.activities).where(eq(s.activities.id, activityId));
    if (!a) return {};
    return revealActivity(tx, user.id, a, "timeline");
  });
}

const reviewSchema = z.object({
  category: z.string().optional(),
  jobId: optionalUuid,
  contactId: optionalUuid,
});

/** Review queue decision: confirm/override the category and filing. */
export async function reviewActivity(id: string, _prev: ActionState, form: FormData): Promise<ActionState> {
  const user = await requireStaff();
  const res = await safeAction(async () => {
    const v = reviewSchema.parse(formObject(form));
    await user.db((tx) =>
      tx
        .update(s.activities)
        .set({
          triageStatus: "REVIEWED",
          ...(v.category ? { triageCategory: v.category } : {}),
          ...(v.jobId ? { jobId: v.jobId } : {}),
          ...(v.contactId ? { contactId: v.contactId } : {}),
        })
        .where(eq(s.activities.id, id)),
    );
    return { ok: true, message: "Filed." };
  });
  revalidatePath("/inbox");
  return res;
}
