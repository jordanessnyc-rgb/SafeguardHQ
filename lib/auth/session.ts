import "server-only";
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
  /** Run queries as this user — Postgres RLS applies. The only way request code touches the DB. */
  db: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;
};

export const getCurrentUser = cache(async (): Promise<CurrentUser | null> => {
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
