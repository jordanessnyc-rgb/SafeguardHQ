/**
 * Titan IMAP listener (SPEC §6.3). IDLE via imapflow (NOOP polling every 60s if the server lacks
 * IDLE), reconnect with exponential backoff (imapflow v2 doesn't reconnect by itself), and
 * UIDVALIDITY + last-UID tracking so nothing is processed twice. Every message goes through
 * lib/mail/ingest (idempotent on Message-ID as a second line of defence).
 */
import { and, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import type { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { schema as s, type Db } from "@/lib/db";
import { imapClient, type TitanConfig } from "@/lib/integrations/titan-mail";
import { ingestEmail, type DriveUploader, type Uploader } from "@/lib/mail/ingest";
import { emailHeaders, emailHtml, emailMeta } from "@/lib/mail/meta";

const FOLDER = "INBOX";

type Deps = { db: Db; cfg: TitanConfig; storage: Uploader; drive: DriveUploader | null; log?: (...a: unknown[]) => void };

async function saveState(db: Db, mailbox: string, patch: Partial<typeof s.mailSyncState.$inferInsert>) {
  await db
    .insert(s.mailSyncState)
    .values({ mailbox, folder: FOLDER, ...patch })
    .onConflictDoUpdate({ target: [s.mailSyncState.mailbox, s.mailSyncState.folder], set: { ...patch, updatedAt: new Date() } });
}

export async function loadState(db: Db, mailbox: string) {
  const [row] = await db.select().from(s.mailSyncState).where(and(eq(s.mailSyncState.mailbox, mailbox), eq(s.mailSyncState.folder, FOLDER)));
  return row;
}

/** Fetch and ingest everything after the last processed UID. Serialized by the caller. */
export async function processNew(client: ImapFlow, deps: Deps): Promise<number> {
  const { db, cfg } = deps;
  const state = await loadState(db, cfg.user);
  // Another folder may be selected (the backfill visits them all); only INBOX's cursor is tracked here.
  if (client.mailbox && client.mailbox.path && client.mailbox.path !== FOLDER) await client.mailboxOpen(FOLDER);
  const mailbox = client.mailbox;
  if (!mailbox) return 0;
  const uidValidity = String(mailbox.uidValidity);
  let lastUid = state?.lastUid ?? 0;
  if (!state || state.uidValidity !== uidValidity) {
    // First run or the server renumbered the folder: start from "now" rather than re-importing
    // the whole inbox (Message-ID dedupe would catch repeats, but it would re-upload attachments).
    lastUid = Math.max(0, (mailbox.uidNext ?? 1) - 1);
    await saveState(db, cfg.user, { uidValidity, lastUid });
    return 0;
  }
  // Collect first: running IMAP commands inside a fetch loop deadlocks (imapflow docs).
  const lock = await client.getMailboxLock(FOLDER);
  let messages: Awaited<ReturnType<ImapFlow["fetchAll"]>>;
  try {
    messages = (await client.fetchAll(`${lastUid + 1}:*`, { uid: true, source: true }, { uid: true })).filter((m) => m.uid > lastUid);
  } finally {
    lock.release();
  }
  let n = 0;
  if (messages.length === 0) {
    // A successful empty poll still proves the mailbox is reachable (health check reads lastOkAt).
    await saveState(db, cfg.user, { lastOkAt: new Date(), lastError: null });
    return 0;
  }
  for (const msg of messages.sort((a, b) => a.uid - b.uid)) {
    try {
      await db.transaction((tx) => ingestEmail(tx, msg.source as Buffer, { mailbox: cfg.user, storage: deps.storage, drive: deps.drive }));
      n++;
    } catch (e) {
      // Don't let one bad message wedge the mailbox: record it, tell a human, move on.
      deps.log?.("[mail] ingest failed for UID", msg.uid, (e as Error).message);
      await db.insert(s.tasks).values({
        title: `An email couldn't be imported (UID ${msg.uid})`,
        description: `Error: ${(e as Error).message.slice(0, 500)}. Check the crm@ mailbox in Titan.`,
        source: "SYSTEM_RULE",
      });
    }
    lastUid = msg.uid;
    await saveState(db, cfg.user, { lastUid, lastOkAt: new Date(), lastError: null });
  }
  return n;
}

const BACKFILL_DAYS = 120;
const BACKFILL_BATCH = 100;

/**
 * Emails imported before the CRM kept HTML and sender names get them from the mailbox once. Titan
 * returned nothing for SEARCH HEADER Message-ID (checked 2026-10-01), and most mail is moved out of
 * INBOX soon after it arrives, so: list every folder's envelopes since the cutoff (not Trash, Junk
 * or Drafts), match Message-IDs here, fetch those sources. Ones found nowhere are marked so they
 * aren't looked for again. AIRnyc (sensitive) mail is skipped: its HTML is never stored.
 * Returns how many rows it looked at (0 = nothing left to do).
 */
export async function backfillEmailHtml(client: ImapFlow, deps: Deps): Promise<number> {
  const { db, cfg } = deps;
  const log = deps.log ?? console.log;
  const rows = await db
    .select({ id: s.activities.id, messageId: s.activities.externalId, raw: s.activities.raw })
    .from(s.activities)
    .where(
      and(
        inArray(s.activities.type, ["EMAIL_IN", "EMAIL_OUT"]),
        eq(s.activities.channelLine, cfg.user),
        eq(s.activities.sensitive, false),
        isNull(s.activities.bodyHtml),
        // "not-in-inbox" was the first version's mark (INBOX only): those are looked for again.
        sql`${s.activities.raw}->'email' is null and coalesce(${s.activities.raw}->>'backfill', '') <> 'not-found'`,
        gte(s.activities.occurredAt, sql`now() - make_interval(days => ${BACKFILL_DAYS})`),
      ),
    )
    .limit(BACKFILL_BATCH);
  if (!rows.length) return 0;
  const wanted = new Map(rows.flatMap((r) => (r.messageId ? [[r.messageId, r.id] as const] : [])));
  const found = new Map<string, Buffer>();
  const since = new Date(Date.now() - (BACKFILL_DAYS + 2) * 86_400_000);
  const folders = (await client.list()).filter((f) => !f.flags.has("\\Noselect") && !["\\Trash", "\\Junk", "\\Drafts"].includes(f.specialUse ?? ""));
  let scanned = 0;
  for (const folder of folders) {
    if (found.size === wanted.size) break;
    const lock = await client.getMailboxLock(folder.path);
    try {
      const uids = (await client.search({ since }, { uid: true })) || [];
      scanned += uids.length;
      if (!uids.length) continue;
      const hits = new Map<number, string>(); // uid → activity id
      for (const m of await client.fetchAll(uids, { envelope: true, uid: true }, { uid: true })) {
        const id = m.envelope?.messageId ? wanted.get(m.envelope.messageId.trim()) : undefined;
        if (id && !found.has(id)) hits.set(m.uid, id);
      }
      if (hits.size) {
        for (const m of await client.fetchAll([...hits.keys()], { source: true, uid: true }, { uid: true })) {
          const id = hits.get(m.uid);
          if (id && m.source) found.set(id, m.source as Buffer);
        }
      }
    } catch (e) {
      log(`[mail] backfill: skipped folder ${folder.path}: ${(e as Error).message}`);
    } finally {
      lock.release();
    }
  }
  // The listener IDLEs on INBOX and processNew reads its UIDVALIDITY: put it back.
  await client.mailboxOpen(FOLDER);
  log(`[mail] backfill: ${scanned} messages in ${folders.length} folders since ${since.toISOString().slice(0, 10)}; ${found.size} of ${rows.length} matched`);
  for (const r of rows) {
    const src = found.get(r.id);
    const base = (r.raw ?? {}) as Record<string, unknown>;
    if (!src) {
      await db.update(s.activities).set({ raw: { ...base, backfill: "not-found" } }).where(eq(s.activities.id, r.id));
      continue;
    }
    const m = await simpleParser(src);
    await db.update(s.activities).set({ bodyHtml: emailHtml(m), raw: { ...base, headers: emailHeaders(m), email: emailMeta(m) } }).where(eq(s.activities.id, r.id));
  }
  return rows.length;
}

/** Runs forever: connect → catch up → IDLE → on close/error reconnect with backoff. */
export async function runMailListener(deps: Deps, signal?: AbortSignal): Promise<void> {
  const log = deps.log ?? console.log;
  let failures = 0;
  while (!signal?.aborted) {
    const client = imapClient(deps.cfg);
    let heartbeat: NodeJS.Timeout | undefined;
    try {
      const closed = new Promise<void>((resolve) => {
        client.on("close", () => resolve());
        client.on("error", (e: Error) => log("[mail] connection error", e.message));
      });
      await client.connect();
      await saveState(deps.db, deps.cfg.user, { lastConnectedAt: new Date(), lastOkAt: new Date(), lastError: null });
      failures = 0;
      log("[mail] connected to", deps.cfg.imapHost, "as", deps.cfg.user);

      // Keep INBOX selected but don't hold a lock while waiting: imapflow only auto-IDLEs when the
      // connection is free, and a long-held lock kept it from ever idling (new mail then waited for
      // the next poll). Each fetch takes the lock briefly instead (see processNew).
      await client.mailboxOpen(FOLDER);
      let chain: Promise<unknown> = processNew(client, deps)
        .then(async () => {
          // Older imports: HTML + sender names, a batch at a time until none are left.
          for (let i = 0; i < 20; i++) {
            if (!(await backfillEmailHtml(client, deps))) break;
          }
        })
        .catch((e) => log("[mail] backfill error", (e as Error).message));
      const kick = () => {
        chain = chain.then(() => processNew(client, deps)).catch((e) => log("[mail] process error", (e as Error).message));
      };
      client.on("exists", kick);
      // Safety net every 60s (SPEC: "fall back to polling every 60s"): catches anything IDLE
      // didn't announce and keeps lastOkAt fresh for the 15-minute health check.
      heartbeat = setInterval(kick, 60_000);
      await chain;
      await Promise.race([closed, new Promise((r) => signal?.addEventListener("abort", r))]);
    } catch (e) {
      failures++;
      const msg = (e as Error & { authenticationFailed?: boolean }).authenticationFailed ? "IMAP authentication failed" : (e as Error).message;
      log("[mail]", msg);
      await saveState(deps.db, deps.cfg.user, { lastError: msg.slice(0, 500) }).catch(() => undefined);
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      await client.logout().catch(() => undefined);
    }
    if (signal?.aborted) break;
    const delay = Math.min(10 * 60_000, 5_000 * 2 ** Math.min(failures, 7));
    log(`[mail] reconnecting in ${Math.round(delay / 1000)}s`);
    await new Promise((r) => setTimeout(r, delay));
  }
}
