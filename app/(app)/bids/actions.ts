"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { adminDb, schema as s } from "@/lib/db";
import { requireOwner, requireStaff } from "@/lib/auth/session";
import { formObject, safeAction, type ActionState } from "@/lib/actions";
import { analyzeRfp } from "@/lib/bids/analyze";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { fromNyInput } from "@/lib/time";

const when = z
  .string()
  .optional()
  .transform((v) => (v ? fromNyInput(v) : null));

const bidSchema = z.object({
  title: z.string().min(1).max(300),
  agency: z.string().max(200).optional(),
  solicitationNumber: z.string().max(100).optional(),
  type: z.enum(s.bidTypeEnum.enumValues),
  role: z.enum(s.bidRoleEnum.enumValues),
  primeEntity: z.string().max(200).optional(),
  questionsDue: when,
  dueAt: when,
  openingAt: when,
  siteVisitAt: when,
  buyerName: z.string().max(200).optional(),
  buyerEmail: z.union([z.email(), z.literal("")]).optional(),
  buyerPhone: z.string().max(50).optional(),
  insuranceRequirements: z.string().max(5000).optional(),
  scope: z.string().max(10000).optional(),
  sourceUrl: z.union([z.url(), z.literal("")]).optional(),
  notes: z.string().max(10000).optional(),
});

function values(v: z.infer<typeof bidSchema>) {
  return {
    ...v,
    agency: v.agency ?? null,
    solicitationNumber: v.solicitationNumber ?? null,
    primeEntity: v.primeEntity ?? "ESS",
    buyerName: v.buyerName ?? null,
    buyerEmail: v.buyerEmail || null,
    buyerPhone: v.buyerPhone ?? null,
    insuranceRequirements: v.insuranceRequirements ?? null,
    scope: v.scope ?? null,
    sourceUrl: v.sourceUrl || null,
    notes: v.notes ?? null,
  };
}

export async function createBid(_prev: ActionState, form: FormData): Promise<ActionState> {
  const user = await requireStaff();
  let id: string | undefined;
  const res = await safeAction(async () => {
    const v = bidSchema.parse(formObject(form));
    [{ id }] = await user.db((tx) => tx.insert(s.bids).values(values(v)).returning({ id: s.bids.id }));
  });
  if (res.error || !id) return res;
  redirect(`/bids/${id}`);
}

export async function updateBid(id: string, _prev: ActionState, form: FormData): Promise<ActionState> {
  const user = await requireStaff();
  const res = await safeAction(async () => {
    const v = bidSchema.parse(formObject(form));
    await user.db((tx) => tx.update(s.bids).set(values(v)).where(eq(s.bids.id, id)));
    return { ok: true, message: "Saved." };
  });
  revalidatePath(`/bids/${id}`);
  return res;
}

export async function setBidStatus(id: string, form: FormData) {
  const user = await requireStaff();
  const status = z.enum(s.bidStatusEnum.enumValues).parse(form.get("status"));
  await user.db((tx) => tx.update(s.bids).set({ status }).where(eq(s.bids.id, id)));
  revalidatePath(`/bids/${id}`);
  revalidatePath("/bids");
}

/** Jordan's call (the AI only recommends). NO_GO also closes the bid. */
export async function decideBid(id: string, decision: "GO" | "NO_GO") {
  const user = await requireOwner();
  await user.db((tx) =>
    tx
      .update(s.bids)
      .set({ decision, decidedBy: user.id, decidedAt: new Date(), ...(decision === "NO_GO" ? { status: "NO_BID" as const } : { status: "DRAFTING" as const }) })
      .where(eq(s.bids.id, id)),
  );
  revalidatePath(`/bids/${id}`);
  revalidatePath("/bids");
}

/** Upload the solicitation PDF; with AI configured, analyze it into fields + a go/no-go checklist. */
export async function uploadRfp(id: string, _prev: ActionState, form: FormData): Promise<ActionState> {
  const user = await requireStaff();
  const res = await safeAction(async () => {
    const file = form.get("rfp");
    if (!(file instanceof File) || file.size === 0) throw new Error("Choose the solicitation PDF.");
    if (file.type !== "application/pdf") throw new Error("Upload a PDF.");
    if (file.size > 30 * 1024 * 1024) throw new Error("PDF is larger than 30 MB.");
    const buf = Buffer.from(await file.arrayBuffer());
    const path = `bids/${id}/${randomUUID()}-${file.name.replace(/[^\w.\- ]+/g, "_")}`;
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.storage.from("job-files").upload(path, buf, { contentType: "application/pdf" });
    if (error) throw new Error(`Upload failed: ${error.message}`);
    await user.db((tx) => tx.insert(s.documents).values({ bidId: id, kind: "OTHER", status: "FINAL", title: file.name, storageBucket: "job-files", storagePath: path }));
    if (!process.env.ANTHROPIC_API_KEY) return { ok: true, message: "Saved. (AI isn't configured, so fill in the details by hand.)" };
    const r = await analyzeRfp(adminDb(), id, buf);
    if (r.status !== "ok") return { error: `Saved the PDF, but the analysis failed: ${r.reason}` };
    return { ok: true, message: `Analyzed. AI recommendation: ${r.goNoGo.recommendation.replace("_", "-")} — ${r.goNoGo.summary}` };
  });
  revalidatePath(`/bids/${id}`);
  return res;
}
