"use server";

import { getCurrentUser } from "@/lib/auth/session";
import { passwordProblem } from "@/lib/auth/password";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export type PasswordState = { ok?: boolean; error?: string };

export async function changePassword(_prev: PasswordState, form: FormData): Promise<PasswordState> {
  const user = await getCurrentUser();
  if (!user) return { error: "Your session ended. Sign in again." };
  const password = String(form.get("password") ?? "");
  const problem = passwordProblem(password, String(form.get("confirm") ?? ""));
  if (problem) return { error: problem };
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.updateUser({ password });
  if (error) {
    if (/different from the old|same_password/i.test(`${error.code} ${error.message}`)) return { error: "Choose a password different from the current one." };
    if (/weak/i.test(`${error.code} ${error.message}`)) return { error: "That password is too easy to guess. Try a longer one." };
    console.error("password change failed", error.code, error.message);
    return { error: "Couldn't save the password. Try again." };
  }
  return { ok: true };
}
