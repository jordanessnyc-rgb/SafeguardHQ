/**
 * SPEC §6.3 health check: if IMAP auth fails or there's been no successful connection for 15 min,
 * text Jordan via Quo. Internal alerts go straight out (they're not client messages); at most one
 * per hour.
 */
import { eq } from "drizzle-orm";
import { schema as s, type Db } from "@/lib/db";
import type { QuoClient } from "@/lib/integrations/quo";
import { loadState } from "./mail";

export const STALE_MS = 15 * 60_000;
const REALERT_MS = 60 * 60_000;

export async function mailHealthCheck(
  db: Db,
  mailbox: string,
  quo: QuoClient | null,
  now = new Date(),
  startedAt = new Date(0),
): Promise<"ok" | "alerted" | "suppressed" | "no-channel"> {
  const state = await loadState(db, mailbox);
  // Grace period: a worker that just started (fresh deploy, first run) gets 15 minutes to connect.
  const lastOk = Math.max(state?.lastOkAt?.getTime() ?? 0, startedAt.getTime());
  const authFailed = /authentication/i.test(state?.lastError ?? "");
  if (!authFailed && now.getTime() - lastOk < STALE_MS) return "ok";
  if (state?.lastAlertAt && now.getTime() - state.lastAlertAt.getTime() < REALERT_MS) return "suppressed";

  const [cfg] = await db.select().from(s.settings);
  const [line] = cfg?.healthAlertLineId ? await db.select().from(s.phoneLines).where(eq(s.phoneLines.id, cfg.healthAlertLineId)) : [];
  if (!quo || !cfg?.healthAlertPhone || !line) return "no-channel";
  const why = authFailed ? "IMAP login is failing" : `no successful mail sync since ${state?.lastOkAt?.toISOString() ?? "startup"}`;
  await quo.sendSms({ from: line.quoPhoneNumberId, to: cfg.healthAlertPhone, content: `ESS CRM alert: ${mailbox} — ${why}. Check Titan / the worker.` });
  await db.update(s.mailSyncState).set({ lastAlertAt: now }).where(eq(s.mailSyncState.mailbox, mailbox));
  return "alerted";
}
