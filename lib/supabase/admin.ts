import "server-only";
import { createClient } from "@supabase/supabase-js";

/** Service-role client. Server-only; used for OWNER user management (invites). Never import in client code. */
export function supabaseAdmin() {
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!key) throw new Error("SUPABASE_SECRET_KEY is not set");
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
