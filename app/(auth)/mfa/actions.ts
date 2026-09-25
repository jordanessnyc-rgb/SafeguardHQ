"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export type EnrollState = { error?: string; factorId?: string; qr?: string; secret?: string };
export type VerifyState = { error?: string; ok?: boolean };

const safeNext = (v: FormDataEntryValue | null) => (typeof v === "string" && v.startsWith("/") && !v.startsWith("//") ? v : "/");

/** Starts a new TOTP enrollment: returns the QR code (SVG data URL) and the secret for manual entry. */
export async function startEnroll(): Promise<EnrollState> {
  const supabase = await createSupabaseServerClient();
  const { data: list, error: listErr } = await supabase.auth.mfa.listFactors();
  if (listErr) return { error: listErr.message };
  // Abandoned attempts leave unverified factors behind; clear them so names stay unique.
  for (const f of list.all.filter((f) => f.factor_type === "totp" && f.status === "unverified")) await supabase.auth.mfa.unenroll({ factorId: f.id });
  const n = list.totp.length + 1;
  const { data, error } = await supabase.auth.mfa.enroll({ factorType: "totp", issuer: "ESS CRM", friendlyName: n === 1 ? "Authenticator app" : `Authenticator app ${n}` });
  if (error) return { error: error.message };
  return { factorId: data.id, qr: data.totp.qr_code, secret: data.totp.secret };
}

/** Checks a 6-digit code. On success the session is upgraded to aal2 (Supabase rewrites the cookie). */
export async function verifyCode(_prev: VerifyState, form: FormData): Promise<VerifyState> {
  const factorId = String(form.get("factorId") ?? "");
  const code = String(form.get("code") ?? "").replace(/\s/g, "");
  if (!/^\d{6}$/.test(code)) return { error: "Enter the 6-digit code from your authenticator app." };
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId, code });
  if (error) return { error: error.code === "mfa_verification_failed" ? "That code didn't match. Codes change every 30 seconds — try the current one." : error.message };
  const next = form.get("next");
  if (next !== null) redirect(safeNext(next));
  revalidatePath("/settings/security");
  return { ok: true };
}

/** Removes an authenticator. Supabase only allows this from an aal2 session; owners must keep one. */
export async function removeFactor(factorId: string): Promise<void> {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase.auth.mfa.listFactors();
  const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (aal?.currentLevel !== "aal2") return;
  const user = await getCurrentUser();
  if (user?.role === "OWNER" && (data?.totp.length ?? 0) <= 1) return; // the last one would lock the owner out of pricing
  await supabase.auth.mfa.unenroll({ factorId });
  revalidatePath("/settings/security");
}
