import { readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Pool } from "pg";
import { createDb, runAsUser, type Db, type JwtClaims, type Tx } from "@/lib/db";

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
export const hasTestDb = Boolean(TEST_DATABASE_URL);

const root = path.resolve(__dirname, "../..");

export type TestDb = { db: Db; pool: Pool; close: () => Promise<void> };

/** Fresh schema: Supabase stub + every migration, applied with the real drizzle migrator. */
export async function setupTestDb(): Promise<TestDb> {
  if (!TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL not set");
  const { db, pool } = createDb(TEST_DATABASE_URL);
  await pool.query(`set client_min_messages = warning;
    drop schema if exists public cascade; create schema public;
    drop schema if exists auth cascade; drop schema if exists drizzle cascade;`);
  await pool.query(readFileSync(path.join(root, "db/test/supabase-stub.sql"), "utf8"));
  await migrate(db, { migrationsFolder: path.join(root, "db/migrations") });
  return { db, pool, close: () => pool.end() };
}

export type TestUser = { id: string; claims: JwtClaims; as: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T> };

/** Creates an auth.users row (the trigger creates the profile) and returns a runner bound to it. */
export async function createUser(t: TestDb, role: "OWNER" | "VA" | "FIELD" | "SUB" | null): Promise<TestUser> {
  const id = randomUUID();
  const email = `${role ?? "norole"}-${id.slice(0, 8)}@example.test`;
  await t.pool.query(
    `insert into auth.users (id, email, raw_app_meta_data) values ($1, $2, $3)`,
    [id, email, JSON.stringify(role ? { role } : {})],
  );
  const claims: JwtClaims = { sub: id, role: "authenticated", email };
  return { id, claims, as: (fn) => runAsUser(t.db, claims, fn) };
}

/** Postgres error message from a rejected promise (drizzle wraps driver errors in `cause`). */
export async function pgError(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    const err = e as { message?: string; cause?: { message?: string } };
    return err.cause?.message ?? err.message ?? String(e);
  }
  throw new Error("expected promise to reject");
}
