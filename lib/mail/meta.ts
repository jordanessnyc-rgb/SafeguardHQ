/**
 * The parts of a parsed email the inbox shows "like a real email": who it's from and to (with
 * display names) and the original HTML. Shared by ingest and the HTML backfill.
 */
import type { AddressObject, ParsedMail } from "mailparser";

export type MailAddress = { name: string | null; address: string | null };
export type EmailMeta = { from: MailAddress | null; to: MailAddress[]; cc: MailAddress[] };

/** HTML bigger than this isn't kept (plain text is still stored). */
export const MAX_HTML = 1_000_000;

const list = (a: AddressObject | AddressObject[] | undefined): MailAddress[] =>
  (Array.isArray(a) ? a : a ? [a] : [])
    .flatMap((o) => o.value)
    .flatMap((v) => (v.group?.length ? v.group : [v]))
    .map((v) => ({ name: v.name?.trim() || null, address: v.address?.toLowerCase() || null }));

export function emailMeta(m: ParsedMail): EmailMeta {
  return { from: list(m.from)[0] ?? null, to: list(m.to), cc: list(m.cc) };
}

/** Header strings for the activity's `raw` column (readable text, not "[object Object]"). */
export function emailHeaders(m: ParsedMail): Record<string, string> {
  const text = (a: AddressObject | AddressObject[] | undefined) => (Array.isArray(a) ? a.map((x) => x.text).join(", ") : a?.text);
  const out: Record<string, string | undefined> = { from: text(m.from), to: text(m.to), cc: text(m.cc), date: m.date?.toISOString(), subject: m.subject };
  return Object.fromEntries(Object.entries(out).filter((e): e is [string, string] => Boolean(e[1])));
}

export function emailHtml(m: ParsedMail): string | null {
  return typeof m.html === "string" && m.html.trim() && m.html.length <= MAX_HTML ? m.html : null;
}
