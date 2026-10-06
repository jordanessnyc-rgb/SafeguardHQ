"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { siteOrigin } from "@/lib/site";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/** `email` is echoed back on an error so the form can keep it (React resets form fields after an action). */
export type LoginState = { ok?: boolean; error?: string; email?: string };

const safeNext = (v: FormDataEntryValue | null) => {
  const n = String(v ?? "/");
  return n.startsWith("/") && !n.startsWith("//") ? n : "/";
};

/** Email + password (2026-10-06, replacing emailed sign-in links). Accounts are only made by the owner. */
export async function signIn(_prev: LoginState, form: FormData): Promise<LoginState> {
  const typed = String(form.get("email") ?? "").trim().toLowerCase();
  const email = z.email().safeParse(typed);
  const password = String(form.get("password") ?? "");
  if (!email.success || !password) return { error: "Enter your email and password.", email: typed };
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.signInWithPassword({ email: email.data, password });
  if (error) {
    // One message for wrong email and wrong password, so it doesn't reveal who has an account.
    if (/rate limit|too many/i.test(error.message)) return { error: "Too many tries. Wait a few minutes and try again.", email: typed };
    if (!/invalid login credentials|email not confirmed/i.test(error.message)) console.error("password sign-in failed", error.code, error.message);
    return { error: "That email and password don't match.", email: typed };
  }
  redirect(safeNext(form.get("next")));
}

/** "Forgot password": emails a one-time link that opens the set-a-new-password page. */
export async function requestPasswordReset(_prev: LoginState, form: FormData): Promise<LoginState> {
  const typed = String(form.get("email") ?? "").trim().toLowerCase();
  const email = z.email().safeParse(typed);
  if (!email.success) return { error: "Enter a valid email address.", email: typed };
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.resetPasswordForEmail(email.data, {
    redirectTo: `${siteOrigin(await headers())}/auth/confirm?next=/account/password`,
  });
  // Don't reveal whether an address has an account.
  if (error && !/user not found/i.test(error.message)) {
    console.error("password reset failed", error.code, error.message);
    return { error: "Couldn't send the email. Try again in a minute.", email: typed };
  }
  return { ok: true };
}
