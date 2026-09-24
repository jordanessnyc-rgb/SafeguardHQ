/**
 * Applies db/migrations to DATABASE_URL (Supabase: use the direct/session connection, not the
 * transaction pooler). Usage: pnpm db:migrate
 */
import "dotenv/config";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import path from "node:path";
import { createDb } from "@/lib/db";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const { db, pool } = createDb(url);
  await migrate(db, { migrationsFolder: path.join(__dirname, "migrations") });
  await pool.end();
  console.log("Migrations applied.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
