"use server";

import { headers } from "next/headers";
import { siteOrigin } from "@/lib/site";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export type LoginState = { ok?: boolean; error?: string };

export async function sendMagicLink(_prev: LoginState, form: FormData): Promise<LoginState> {
  const email = z.email().safeParse(String(form.get("email") ?? "").trim());
  if (!email.success) return { error: "Enter a valid email address." };
  const next = String(form.get("next") ?? "/");

  const h = await headers();
  const origin = siteOrigin(h);
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.signInWithOtp({
    email: email.data,
    options: {
      // Accounts are created by the OWNER's invite; the login form never creates users.
      shouldCreateUser: false,
      emailRedirectTo: `${origin}/auth/confirm?next=${encodeURIComponent(next.startsWith("/") ? next : "/")}`,
    },
  });
  // Don't reveal whether an address has an account.
  if (error && !/signups not allowed|user not found/i.test(error.message)) {
    console.error("magic link failed", error.code, error.message);
    return { error: "Couldn't send the link. Try again in a minute." };
  }
  return { ok: true };
}
