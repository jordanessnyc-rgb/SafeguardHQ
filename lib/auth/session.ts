import "server-only";
import { connection } from "next/server";
import { loginRequired } from "./access-mode";
import { openAccessOwner, OpenAccessSetupError } from "./open-access";
import { cache } from "react";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { adminDb, runAsUser, schema as s, type JwtClaims, type Tx } from "@/lib/db";

export type Role = "OWNER" | "VA" | "FIELD" | "SUB";

export type CurrentUser = {
  id: string;
  email: string;
  role: Role | null;
  fullName: string | null;
  claims: JwtClaims;
  openAccess?: boolean;
  /** Run queries as this user — Postgres RLS applies. The only way request code touches the DB. */
  db: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;
};

export const getCurrentUser = cache(async (): Promise<CurrentUser | null> => {
  if (!loginRequired()) {
    await connection(); // Open-access pages must be rendered per request, never at build time.
    if (!process.env.DATABASE_URL) throw new OpenAccessSetupError("The database connection is not configured for this deployment. Add DATABASE_URL to its Vercel environment and redeploy.");
    const profile = await openAccessOwner(adminDb()).catch((error: unknown) => {
      if (error instanceof OpenAccessSetupError) throw error;
      throw new OpenAccessSetupError("The CRM database could not be reached. Check this deployment’s DATABASE_URL and database migrations.");
    });
    const claims: JwtClaims = { sub: profile.userId, role: "authenticated", email: profile.email, open_access: true };
    return {
      id: profile.userId, email: profile.email, role: profile.role, fullName: profile.fullName,
      claims, openAccess: true,
      db: <T>(fn: (tx: Tx) => Promise<T>) => runAsUser(adminDb(), claims, fn),
    };
  }
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims as JwtClaims | undefined;
  if (!claims?.sub) return null;

  const db = <T>(fn: (tx: Tx) => Promise<T>) => runAsUser(adminDb(), claims, fn);
  const [profile] = await db((tx) => tx.select().from(s.profiles).where(eq(s.profiles.userId, claims.sub)));
  return {
    id: claims.sub,
    email: profile?.email ?? claims.email ?? "",
    role: profile?.role ?? null,
    fullName: profile?.fullName ?? null,
    claims,
    db,
  };
});

/** OWNER or VA. Subcontractors go to their portal; everyone else is sent away. */
export async function requireStaff(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role === "SUB") redirect("/portal");
  if (user.role !== "OWNER" && user.role !== "VA") redirect("/no-access");
  return user;
}

/** SUB users only (subcontractor portal). Their data comes solely from the sub_portal_* views. */
export async function requireSub(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role !== "SUB") redirect("/");
  return user;
}

export async function requireOwner(): Promise<CurrentUser> {
  const user = await requireStaff();
  if (user.role !== "OWNER") redirect("/");
  return user;
}
