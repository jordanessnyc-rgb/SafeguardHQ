/**
 * Integration health for the owner's admin page (SPEC §13 "integration health page"): worker
 * heartbeat and per-task results, last Quo/FreshBooks/DocuSign webhook, IMAP, FreshBooks token age,
 * recent AI errors. Read under the owner's RLS.
 */
import { and, count, desc, gt, isNotNull, sql } from "drizzle-orm";
import { schema as s, type Db, type Tx } from "@/lib/db";

export type Level = "ok" | "warn" | "error" | "off";
export type HealthItem = {
  name: string;
  level: Level;
  detail: string;
  at?: Date | null;
};

const MIN = 60_000;
const ago = (now: Date, at: Date) => {
  const m = Math.round((now.getTime() - at.getTime()) / MIN);
  return m < 1 ? "just now" : m < 90 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
};

// ---------------------------------------------------------------------------------------------
// Worker side: record each task's outcome (privileged connection)
// ---------------------------------------------------------------------------------------------

export async function recordRun(db: Db, name: string, intervalSeconds: number, error: unknown | null, now = new Date()) {
  const ok = error == null;
  const msg = ok ? null : (error instanceof Error ? error.message : String(error)).slice(0, 500);
  await db
    .insert(s.workerStatus)
    .values({
      name,
      intervalSeconds,
      lastRunAt: now,
      ...(ok ? { lastOkAt: now } : { lastErrorAt: now, lastError: msg }),
    })
    .onConflictDoUpdate({
      target: s.workerStatus.name,
      set: {
        intervalSeconds,
        lastRunAt: now,
        ...(ok ? { lastOkAt: now } : { lastErrorAt: now, lastError: msg }),
      },
    });
}

// ---------------------------------------------------------------------------------------------
// Assessment (pure)
// ---------------------------------------------------------------------------------------------

type TaskRow = typeof s.workerStatus.$inferSelect;

/** A task is failing if its latest run errored, stalled if it hasn't succeeded in 3 intervals. */
export function assessTask(r: TaskRow, now: Date): HealthItem {
  const every = Math.max(r.intervalSeconds ?? 300, 60) * 1000;
  const failing = r.lastErrorAt && (!r.lastOkAt || r.lastErrorAt > r.lastOkAt);
  if (failing)
    return {
      name: r.name,
      level: "error",
      detail: `Failing since ${ago(now, r.lastErrorAt!)}: ${r.lastError ?? "unknown error"}`,
      at: r.lastErrorAt,
    };
  if (!r.lastOkAt || now.getTime() - r.lastOkAt.getTime() > 3 * every)
    return {
      name: r.name,
      level: "warn",
      detail: r.lastOkAt ? `No successful run since ${ago(now, r.lastOkAt)}` : "Never succeeded",
      at: r.lastOkAt,
    };
  return {
    name: r.name,
    level: "ok",
    detail: `OK ${ago(now, r.lastOkAt)}`,
    at: r.lastOkAt,
  };
}

export function assessHeartbeat(r: TaskRow | undefined, now: Date): HealthItem {
  if (!r?.lastOkAt)
    return {
      name: "Worker",
      level: "error",
      detail: "The worker has never reported in. Is it deployed and running?",
    };
  const stale = now.getTime() - r.lastOkAt.getTime() > 5 * MIN;
  return {
    name: "Worker",
    level: stale ? "error" : "ok",
    detail: stale ? `Last heartbeat ${ago(now, r.lastOkAt)}. The worker looks down.` : `Running (heartbeat ${ago(now, r.lastOkAt)})`,
    at: r.lastOkAt,
  };
}

// ---------------------------------------------------------------------------------------------
// Loading (owner's transaction)
// ---------------------------------------------------------------------------------------------

export async function loadHealth(tx: Tx, now = new Date()): Promise<{ integrations: HealthItem[]; tasks: HealthItem[] }> {
  const day = new Date(now.getTime() - 24 * 60 * MIN);
  // One transaction = one connection: run the queries one after another.
  const tasks = await tx.select().from(s.workerStatus).orderBy(s.workerStatus.name);
  const mail = await tx.select().from(s.mailSyncState);
  const [fb] = await tx.select().from(s.freshbooksConnection);
  const hooks = await tx
    .selectDistinctOn([s.webhookDeliveries.provider], {
      provider: s.webhookDeliveries.provider,
      at: s.webhookDeliveries.receivedAt,
      type: s.webhookDeliveries.eventType,
    })
    .from(s.webhookDeliveries)
    .orderBy(s.webhookDeliveries.provider, desc(s.webhookDeliveries.receivedAt));
  const hookErrors = await tx
    .select({
      provider: s.webhookDeliveries.provider,
      n: count(),
      last: sql<string>`max(${s.webhookDeliveries.error})`,
    })
    .from(s.webhookDeliveries)
    .where(and(isNotNull(s.webhookDeliveries.error), gt(s.webhookDeliveries.receivedAt, day)))
    .groupBy(s.webhookDeliveries.provider);
  const [ai] = await tx
    .select({ n: count(), last: sql<string | null>`max(${s.aiCalls.error})` })
    .from(s.aiCalls)
    .where(and(isNotNull(s.aiCalls.error), gt(s.aiCalls.at, day)));

  const out: HealthItem[] = [
    assessHeartbeat(
      tasks.find((t) => t.name === "heartbeat"),
      now,
    ),
  ];

  for (const provider of ["QUO", "FRESHBOOKS", "DOCUSIGN"]) {
    const last = hooks.find((h) => h.provider === provider);
    const errs = hookErrors.find((h) => h.provider === provider);
    const name = {
      QUO: "Quo webhooks",
      FRESHBOOKS: "FreshBooks webhooks",
      DOCUSIGN: "DocuSign webhooks",
    }[provider]!;
    if (errs)
      out.push({
        name,
        level: "error",
        detail: `${errs.n} failed in the last 24 h: ${errs.last}`,
        at: last?.at,
      });
    else if (last)
      out.push({
        name,
        level: "ok",
        detail: `Last event ${last.type ?? ""} ${ago(now, last.at)}`.replace("  ", " "),
        at: last.at,
      });
    else out.push({ name, level: "off", detail: "No events received yet" });
  }

  if (mail.length === 0)
    out.push({
      name: "Email (IMAP)",
      level: "off",
      detail: "No mailbox has connected yet",
    });
  for (const m of mail) {
    const stale = !m.lastOkAt || now.getTime() - m.lastOkAt.getTime() > 15 * MIN;
    out.push({
      name: `Email · ${m.mailbox} ${m.folder}`,
      level: m.lastError && stale ? "error" : stale ? "warn" : "ok",
      detail: stale ? `${m.lastOkAt ? `Last sync ${ago(now, m.lastOkAt)}` : "Never synced"}${m.lastError ? `: ${m.lastError}` : ""}` : `Synced ${ago(now, m.lastOkAt!)}`,
      at: m.lastOkAt,
    });
  }

  if (!fb) out.push({ name: "FreshBooks", level: "off", detail: "Not connected" });
  else {
    const refreshed = fb.lastRefreshAt ?? fb.createdAt;
    // FreshBooks refresh tokens stay valid while used; a token untouched for weeks means the worker isn't using it.
    const old = now.getTime() - refreshed.getTime() > 7 * 24 * 60 * MIN;
    out.push({
      name: "FreshBooks",
      level: fb.lastError ? "error" : old ? "warn" : "ok",
      detail: fb.lastError ?? `Token refreshed ${ago(now, refreshed)}${old ? ", unusually long ago" : ""}`,
      at: refreshed,
    });
  }

  out.push(
    ai.n
      ? {
          name: "Anthropic API",
          level: "warn",
          detail: `${ai.n} failed AI calls in the last 24 h: ${ai.last}`,
        }
      : {
          name: "Anthropic API",
          level: "ok",
          detail: "No failed calls in the last 24 h",
        },
  );

  return {
    integrations: out,
    tasks: tasks.filter((t) => t.name !== "heartbeat").map((t) => assessTask(t, now)),
  };
}
