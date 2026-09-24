/**
 * Bootstrap: give an existing Supabase auth user the OWNER role.
 *   1. Supabase dashboard → Authentication → Users → "Invite user" (or "Add user") for Jordan.
 *   2. pnpm db:make-owner jordan@ess-nyc.com
 * After that, Jordan invites everyone else from Settings → Team.
 */
import "dotenv/config";
import { createDb } from "@/lib/db";

async function main() {
  const email = process.argv[2];
  if (!email) throw new Error("usage: pnpm db:make-owner <email>");
  const { pool } = createDb(process.env.DATABASE_URL!);
  const { rowCount } = await pool.query(
    `insert into public.profiles (user_id, email, role)
       select id, email, 'OWNER' from auth.users where lower(email) = lower($1)
     on conflict (user_id) do update set role = 'OWNER'`,
    [email],
  );
  await pool.end();
  if (!rowCount) throw new Error(`No auth user with email ${email}. Invite them in Supabase first.`);
  console.log(`${email} is now OWNER.`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
