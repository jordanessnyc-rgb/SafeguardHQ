import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { Pool } from "pg";
import * as schema from "@/db/schema";

export type Db = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Minimal JWT claims we forward to Postgres so auth.uid() and RLS policies work. */
export type JwtClaims = { sub: string; role?: string; email?: string; [k: string]: unknown };

export function createDb(connectionString: string): { db: Db; pool: Pool } {
  const pool = new Pool({ connectionString, max: 5 });
  return { db: drizzle(pool, { schema }), pool };
}

let cached: Db | undefined;
let cachedPool: Pool | undefined;

/**
 * Privileged connection (table owner → bypasses RLS). Only for system work that has no user:
 * migrations, the worker, and webhook handlers. Request handlers must use `asUser`.
 */
export function adminDb(): Db {
  if (!cached) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    ({ db: cached, pool: cachedPool } = createDb(url));
  }
  return cached;
}

/** The pool behind adminDb(), for raw SQL that Drizzle doesn't model (e.g. the weekly export). */
export function adminPool(): Pool {
  adminDb();
  return cachedPool!;
}

/**
 * Runs `fn` in a transaction as the Postgres `authenticated` role with the user's JWT claims set,
 * exactly like PostgREST does on Supabase — so every row-level security policy applies.
 */
export async function runAsUser<T>(db: Db, claims: JwtClaims, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('request.jwt.claims', ${JSON.stringify(claims)}, true),
                 set_config('request.jwt.claim.sub', ${claims.sub}, true)`,
    );
    await tx.execute(sql`set local role authenticated`);
    return fn(tx);
  });
}

export { schema };
