/**
 * Mailbox changes asked for in the CRM (archive, delete, put back), carried out in Titan over IMAP.
 * The web app only marks the activity (`raw.mailboxPending`); this runs in the worker, which has a
 * known-good IMAP connection, and records the outcome on the same row. Titan ignores SEARCH HEADER
 * Message-ID, so the message is found by listing envelopes around its date (same as the backfill).
 */
import { and, inArray, isNotNull, sql } from "drizzle-orm";
import { eq } from "drizzle-orm";
import type { ImapFlow } from "imapflow";
import { schema as s, type Db } from "@/lib/db";

export type MailboxAction = "archive" | "trash" | "inbox";
export type PendingOp = { action: MailboxAction; at: string };

/** Which folder each action moves the message to (by IMAP special-use, else by name). */
const TARGETS: Record<MailboxAction, { specialUse: string; names: string[] }> = {
  archive: { specialUse: "\\Archive", names: ["Archive", "Archived"] },
  trash: { specialUse: "\\Trash", names: ["Trash", "Deleted Items", "Deleted"] },
  inbox: { specialUse: "\\Inbox", names: ["INBOX"] },
};

async function targetFolder(client: ImapFlow, action: MailboxAction): Promise<string> {
  const t = TARGETS[action];
  const folders = await client.list();
  const found = folders.find((f) => f.specialUse === t.specialUse) ?? folders.find((f) => t.names.some((n) => n.toLowerCase() === f.path.toLowerCase()));
  if (found) return found.path;
  if (action === "archive") {
    await client.mailboxCreate("Archive");
    return "Archive";
  }
  throw new Error(`No ${action} folder in the mailbox.`);
}

/** The folder and UID holding a Message-ID, looking at messages dated within a day of `around`. */
export async function locateMessage(client: ImapFlow, messageId: string, around: Date): Promise<{ folder: string; uid: number } | null> {
  const since = new Date(around.getTime() - 36 * 3600_000);
  const before = new Date(around.getTime() + 36 * 3600_000);
  const folders = (await client.list()).filter((f) => !f.flags.has("\\Noselect") && f.specialUse !== "\\Drafts");
  // INBOX first: it's where most of them are.
  folders.sort((a, b) => Number(b.path === "INBOX") - Number(a.path === "INBOX"));
  for (const folder of folders) {
    const lock = await client.getMailboxLock(folder.path);
    try {
      const uids = (await client.search({ since, before }, { uid: true })) || [];
      if (!uids.length) continue;
      for (const m of await client.fetchAll(uids, { envelope: true, uid: true }, { uid: true })) {
        if (m.envelope?.messageId?.trim() === messageId) return { folder: folder.path, uid: m.uid };
      }
    } finally {
      lock.release();
    }
  }
  return null;
}

/** Runs every pending mailbox op once. Returns how many were attempted. */
export async function runMailboxOps(client: ImapFlow, db: Db, log: (...a: unknown[]) => void = console.log): Promise<number> {
  const rows = await db
    .select({ id: s.activities.id, messageId: s.activities.externalId, occurredAt: s.activities.occurredAt, raw: s.activities.raw })
    .from(s.activities)
    .where(and(inArray(s.activities.type, ["EMAIL_IN", "EMAIL_OUT"]), isNotNull(s.activities.externalId), sql`${s.activities.raw} ? 'mailboxPending'`))
    .limit(20);
  for (const r of rows) {
    const base = (r.raw ?? {}) as Record<string, unknown>;
    const op = base.mailboxPending as PendingOp;
    const { mailboxPending: _drop, ...rest } = base;
    void _drop;
    let outcome: Record<string, unknown>;
    try {
      const where = await locateMessage(client, r.messageId!, r.occurredAt);
      if (!where) throw new Error("Not found in the mailbox (already moved or deleted there).");
      const target = await targetFolder(client, op.action);
      if (where.folder !== target) {
        const lock = await client.getMailboxLock(where.folder);
        try {
          await client.messageMove(String(where.uid), target, { uid: true });
        } finally {
          lock.release();
        }
      }
      outcome = { mailbox: { action: op.action, folder: target, at: new Date().toISOString() } };
    } catch (e) {
      outcome = { mailbox: { action: op.action, error: (e as Error).message.slice(0, 300), at: new Date().toISOString() } };
      log(`[mail] ${op.action} failed for ${r.messageId}: ${(e as Error).message}`);
    }
    await db.update(s.activities).set({ raw: { ...rest, ...outcome } }).where(eq(s.activities.id, r.id));
  }
  // The listener IDLEs on INBOX; put it back.
  if (rows.length) await client.mailboxOpen("INBOX");
  return rows.length;
}
