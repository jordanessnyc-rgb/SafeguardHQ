/**
 * One-off (2026-10-06): AIRnyc data is no longer treated as confidential (CLAUDE.md rule 5). Copies the
 * encrypted AIRnyc member fields and sealed messages into the normal plain columns. Safe to re-run;
 * must run before migration 0035 drops the encrypted columns.
 *
 *   DATABASE_URL=… AIRNYC_ENCRYPTION_KEY=… pnpm tsx scripts/unseal-airnyc.ts
 */
import { Pool } from "pg";
import { decryptField } from "@/lib/crypto";

type Sealed = { subject?: string | null; body?: string | null; transcript?: string | null; summary?: string | null };

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query("begin");
    const cases = await client.query<{ id: string; member_name_enc: string | null; guardian_name_enc: string | null; member_phone_enc: string | null; address_enc: string | null }>(
      `select id, member_name_enc, guardian_name_enc, member_phone_enc, address_enc from airnyc_cases
        where member_name_enc is not null or guardian_name_enc is not null or member_phone_enc is not null or address_enc is not null`,
    );
    for (const c of cases.rows) {
      await client.query(
        `update airnyc_cases set member_name = coalesce(member_name, $2), guardian_name = coalesce(guardian_name, $3),
           member_phone = coalesce(member_phone, $4), address = coalesce(address, $5),
           member_name_enc = null, guardian_name_enc = null, member_phone_enc = null, address_enc = null where id = $1`,
        [c.id, decryptField(c.member_name_enc), decryptField(c.guardian_name_enc), decryptField(c.member_phone_enc), decryptField(c.address_enc)],
      );
    }

    const acts = await client.query<{ id: string; sensitive_enc: string | null }>(`select id, sensitive_enc from activities where sensitive`);
    for (const a of acts.rows) {
      const c: Sealed = a.sensitive_enc ? JSON.parse(decryptField(a.sensitive_enc) ?? "{}") : {};
      await client.query(
        `update activities set
           subject = case when $2::text is not null then $2 when subject = '[AIRnyc — protected]' then null else subject end,
           body = coalesce($3, body), transcript = coalesce($4, transcript), summary = coalesce($5, summary),
           sensitive = false, sensitive_enc = null where id = $1`,
        [a.id, c.subject ?? null, c.body ?? null, c.transcript ?? null, c.summary ?? null],
      );
    }

    // "AI not allowed" no longer exists: put those messages back in the normal triage flow.
    const blocked = await client.query(`update activities set triage_status = 'PENDING', ai_classification = null where triage_status = 'BLOCKED'`);
    await client.query("commit");
    console.log(`cases: ${cases.rowCount}, messages: ${acts.rowCount}, unblocked: ${blocked.rowCount}`);
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
