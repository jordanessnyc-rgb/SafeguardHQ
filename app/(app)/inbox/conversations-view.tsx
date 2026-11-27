import Link from "next/link";
import { CalendarDays, ChevronDown, Clock3, EyeOff, Inbox, Mail, MailOpen, MessageSquare, Phone, PhoneCall, Star } from "lucide-react";
import type { ReactNode } from "react";
import { buttonVariants } from "@/components/ui/button";
import { ContactPanel, UnknownSenderPanel } from "@/components/team/contact-panel";
import { MentionText } from "@/components/team/mention-text";
import { ScrollToNewest } from "@/app/(app)/contacts/[id]/conversation-bits";
import { fmtDate } from "@/lib/labels";
import { formatPhone } from "@/lib/phone";
import { TZ } from "@/lib/time";
import type { ContactPanelData } from "@/lib/team/contact-panel";
import type { ConversationRow, ConvTab, ThreadItem } from "@/lib/team/conversations";
import type { InboxView } from "@/lib/team/inbox";
import type { Member } from "@/lib/team/mentions";
import { cn } from "@/lib/utils";
import { AssignForm } from "./assign-form";
import { ConversationComposer, SelectAll, type Channel } from "./conversations-client";
import { assignConversationAction, markReadAction, sendInConversationAction, toggleStarAction } from "./team-actions";

const dayKey = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: TZ });
const dayLabel = (d: Date, now: Date) => (dayKey(d) === dayKey(now) ? "Today" : d.toLocaleDateString("en-US", { timeZone: TZ, month: "short", day: "numeric", year: d.getFullYear() === now.getFullYear() ? undefined : "numeric" }));
const clock = (d: Date) => d.toLocaleTimeString("en-US", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
const listTime = (d: Date, now: Date) => (dayKey(d) === dayKey(now) ? clock(d) : d.toLocaleDateString("en-US", { timeZone: TZ, month: "short", day: "numeric" }));
const initials = (name: string) => name.replace(/[^\p{L}\p{N} ]/gu, "").split(/\s+/).filter(Boolean).map((w) => w[0]).slice(0, 2).join("").toUpperCase() || "#";
const AVATAR = ["bg-sky-100 text-sky-800", "bg-rose-100 text-rose-800", "bg-violet-100 text-violet-800", "bg-amber-100 text-amber-800", "bg-emerald-100 text-emerald-800", "bg-indigo-100 text-indigo-800"];
const tint = (name: string) => AVATAR[[...name].reduce((n, c) => (n * 31 + c.charCodeAt(0)) >>> 0, 7) % AVATAR.length];

export function rowName(r: Pick<ConversationRow, "firstName" | "lastName" | "address">) {
  const n = [r.firstName, r.lastName].filter(Boolean).join(" ");
  if (n) return n;
  return r.address?.startsWith("+") ? formatPhone(r.address) : (r.address ?? "Unknown");
}

function Avatar({ name, channel, className }: { name: string; channel?: string; className?: string }) {
  const Icon = channel === "SMS" ? MessageSquare : channel === "CALL" ? PhoneCall : channel ? Mail : null;
  return (
    <span aria-hidden className={cn("relative flex size-8 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold", tint(name), className)}>
      {initials(name)}
      {Icon && <Icon className="absolute -right-1 -bottom-1 size-3.5 rounded-full bg-card p-0.5 text-primary ring-1 ring-black/[0.06]" />}
    </span>
  );
}

const TABS: { key: ConvTab; label: string; icon: typeof Inbox }[] = [
  { key: "unread", label: "Unread", icon: MailOpen },
  { key: "all", label: "All", icon: Inbox },
  { key: "recent", label: "Recent", icon: Clock3 },
  { key: "starred", label: "Starred", icon: Star },
];
const VIEWS: { key: InboxView; label: string }[] = [
  { key: "team", label: "Team inbox" },
  { key: "mine", label: "My inbox" },
  { key: "unassigned", label: "Unassigned" },
];

export type ConversationsViewProps = {
  header: ReactNode;
  rows: ConversationRow[];
  tabCounts: Record<ConvTab, number>;
  view: InboxView;
  tab: ConvTab;
  q: string;
  selected: ConversationRow | null;
  thread: ThreadItem[];
  panel: ContactPanelData | null;
  assignee: string;
  members: Member[];
  me: string;
  lines: { id: string; label: string; lineKey: string }[];
  defaultFromEmail: string;
  now: Date;
};

/** Messages as conversations: list (left), chat thread (middle), client panel (right). */
export function ConversationsView(p: ConversationsViewProps) {
  const { rows, view, tab, q, selected, thread, members, me, now } = p;
  const href = (o: { view?: InboxView; tab?: ConvTab; c?: string | null }) => {
    const sp = new URLSearchParams();
    const v = o.view ?? view;
    const t = o.tab ?? tab;
    if (v !== "team") sp.set("view", v);
    if (t !== "all") sp.set("tab", t);
    if (q) sp.set("q", q);
    const c = o.c === undefined ? selected?.key : o.c;
    if (c) sp.set("c", c);
    return sp.size ? `/inbox?${sp}` : "/inbox";
  };
  const memberName = (id: string | null) => members.find((m) => m.id === id)?.name ?? "Someone";
  const name = selected ? rowName(selected) : "";
  const messages = thread.flatMap((i) => (i.kind === "message" ? [i.a] : []));
  const last = messages.at(-1);
  const lastInboundEmail = [...messages].reverse().find((m) => m.type === "EMAIL_IN");
  const protectedConv = messages.some((m) => m.sensitive || m.airnycCaseId);
  const phone = selected?.address?.startsWith("+") ? selected.address : (p.panel?.contact.phones[0] ?? null);
  const emailTo = selected?.address?.includes("@") ? selected.address : (p.panel?.contact.emails[0] ?? null);
  const smsLine = last?.channelLine ? p.lines.find((l) => l.lineKey === last.channelLine) : undefined;
  const initialChannel: Channel = last?.type === "SMS" || last?.type === "CALL" ? "SMS" : "EMAIL";

  // Thread grouped by day.
  const days: { key: string; label: string; items: ThreadItem[] }[] = [];
  for (const it of thread) {
    const at = it.kind === "message" ? it.a.occurredAt : it.createdAt;
    const k = dayKey(at);
    if (days.at(-1)?.key !== k) days.push({ key: k, label: dayLabel(at, now), items: [] });
    days.at(-1)!.items.push(it);
  }

  return (
    <>
      {p.header}
      <div className="panel grid overflow-hidden lg:h-[calc(100dvh-11rem)] lg:grid-cols-[21rem_minmax(0,1fr)] xl:grid-cols-[21rem_minmax(0,1fr)_19rem]">
        {/* ---------- conversation list ---------- */}
        <nav aria-label="Conversations" className={cn("flex min-h-0 min-w-0 flex-col border-r border-border/70 bg-muted/20", selected && "hidden lg:flex")}>
          <div className="flex items-center justify-between gap-2 px-3 pt-3">
            <details className="group relative">
              <summary className="flex cursor-pointer list-none items-center gap-1 text-base font-semibold">
                {VIEWS.find((v) => v.key === view)!.label}
                <ChevronDown className="size-4 text-muted-foreground transition-transform group-open:rotate-180" />
              </summary>
              <div className="absolute top-8 left-0 z-20 w-44 rounded-xl bg-popover p-1 shadow-pop ring-1 ring-black/[0.08] dark:ring-white/10">
                {VIEWS.map((v) => (
                  <Link key={v.key} href={href({ view: v.key, c: null })} className={cn("block rounded-lg px-2.5 py-1.5 text-sm hover:bg-muted", v.key === view && "font-semibold text-primary")}>
                    {v.label}
                  </Link>
                ))}
              </div>
            </details>
            <form role="search" className="w-36">
              {view !== "team" && <input type="hidden" name="view" value={view} />}
              {tab !== "all" && <input type="hidden" name="tab" value={tab} />}
              <input name="q" type="search" defaultValue={q} placeholder="Search" aria-label="Search conversations" className="h-8 w-full rounded-lg border bg-card px-2.5 text-sm outline-none focus:border-primary/50" />
            </form>
          </div>
          <div className="grid grid-cols-4 border-b px-1 pt-2">
            {TABS.map(({ key, label, icon: Icon }) => (
              <Link key={key} href={href({ tab: key, c: null })} aria-current={tab === key ? "page" : undefined} className={cn("relative flex flex-col items-center gap-0.5 border-b-2 pt-1 pb-2 text-xs", tab === key ? "border-primary font-semibold text-primary" : "border-transparent text-muted-foreground hover:text-foreground")}>
                <span className="relative">
                  <Icon className="size-[18px]" />
                  {key === "unread" && p.tabCounts.unread > 0 && (
                    <span className="absolute -top-2 left-3 rounded-full bg-primary px-1.5 text-[10px] leading-4 font-semibold text-primary-foreground tabular-nums">{p.tabCounts.unread > 999 ? "999+" : p.tabCounts.unread}</span>
                  )}
                </span>
                {label}
              </Link>
            ))}
          </div>
          <form action={markReadAction} className="flex min-h-0 flex-1 flex-col">
            <div className="flex items-center justify-between border-b px-3 py-2">
              <SelectAll />
              <button type="submit" className="text-xs font-medium text-primary hover:underline">Mark as read</button>
            </div>
            {rows.length === 0 ? (
              <p className="p-6 text-center text-sm text-muted-foreground">
                {q ? `No conversations match "${q}".` : tab === "unread" ? "No unread conversations." : tab === "starred" ? "Star a conversation to keep it here." : tab === "recent" ? "Conversations you open show up here." : "No conversations yet."}
              </p>
            ) : (
              <ul className="min-h-0 flex-1 divide-y divide-border/60 overflow-y-auto">
                {rows.map((r) => {
                  const n = rowName(r);
                  const active = r.key === selected?.key;
                  const unread = active ? 0 : r.unread;
                  return (
                    <li key={r.key} className={cn("relative flex gap-2 px-3 py-3", active ? "bg-card shadow-[inset_3px_0_0_var(--color-primary)]" : "hover:bg-card/70")}>
                      <input type="checkbox" name="key" value={r.key} aria-label={`Select ${n}`} className="mt-2.5 size-3.5 shrink-0 accent-primary" />
                      <Link href={href({ c: r.key })} scroll={false} className="flex min-w-0 flex-1 gap-2.5">
                        <Avatar name={n} channel={r.lastType === "SMS" ? "SMS" : r.lastType === "CALL" ? "CALL" : "EMAIL"} />
                        <span className="min-w-0 flex-1">
                          <span className="flex items-baseline gap-2">
                            <span className={cn("truncate text-sm", unread ? "font-bold" : "font-semibold")}>{n}</span>
                            <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">{listTime(r.lastAt, now)}</span>
                          </span>
                          <span className={cn("line-clamp-1 text-xs", unread ? "text-foreground" : "text-muted-foreground")}>
                            {r.sensitive ? "AIRnyc — protected" : r.lastDirection === "OUTBOUND" ? `You: ${r.snippet ?? ""}` : (r.lastType === "CALL" ? "Call" : r.snippet) || r.lastSubject || "(no text)"}
                          </span>
                          {r.owner && <span className="block truncate text-[11px] text-muted-foreground">{r.owner === me ? "Yours" : `→ ${memberName(r.owner)}`}</span>}
                        </span>
                      </Link>
                      <span className="flex shrink-0 flex-col items-end gap-1.5">
                        {unread > 0 ? <span className="rounded bg-primary px-1.5 text-[11px] leading-5 font-semibold text-primary-foreground tabular-nums">{unread}</span> : <span className="h-5" />}
                        <button formAction={toggleStarAction.bind(null, r.key)} aria-label={r.starred ? `Unstar ${n}` : `Star ${n}`} className="text-muted-foreground hover:text-amber-500">
                          <Star className={cn("size-4", r.starred && "fill-amber-400 text-amber-500")} />
                        </button>
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </form>
        </nav>

        {/* ---------- thread ---------- */}
        <section aria-label="Conversation" className={cn("flex min-h-0 min-w-0 flex-col", !selected && "hidden lg:flex")}>
          {!selected ? (
            <p className="m-auto p-6 text-sm text-muted-foreground">Pick a conversation.</p>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 py-2.5">
                <Link href={href({ c: null })} className={cn(buttonVariants({ size: "sm", variant: "ghost" }), "lg:hidden")}>← All</Link>
                <Avatar name={name} className="size-9" />
                <div className="min-w-0 flex-1">
                  {selected.contactId ? (
                    <Link href={`/contacts/${selected.contactId}`} className="block truncate font-semibold hover:underline">{name}</Link>
                  ) : (
                    <span className="block truncate font-semibold">{name}</span>
                  )}
                  <span className="block truncate text-xs text-muted-foreground">{selected.address?.startsWith("+") ? formatPhone(selected.address) : selected.address}</span>
                </div>
                {last && <AssignForm action={assignConversationAction.bind(null, last.id)} members={members} current={p.assignee} />}
                <form action={toggleStarAction.bind(null, selected.key)}>
                  <button type="submit" aria-label={selected.starred ? "Unstar" : "Star"} className={cn(buttonVariants({ size: "icon-sm", variant: "ghost" }))}>
                    <Star className={cn(selected.starred && "fill-amber-400 text-amber-500")} />
                  </button>
                </form>
                {phone && (
                  <a href={`tel:${phone}`} aria-label={`Call ${name}`} className={buttonVariants({ size: "icon-sm", variant: "ghost" })}><Phone /></a>
                )}
              </div>

              <ScrollToNewest className="min-h-0 flex-1 space-y-3 overflow-y-auto bg-muted/25 px-4 py-4">
                {days.map((d) => (
                  <div key={d.key} className="space-y-3">
                    <div className="flex justify-center">
                      <span className="inline-flex items-center gap-1.5 rounded-full bg-card px-3 py-0.5 text-xs text-muted-foreground shadow-xs ring-1 ring-black/[0.05] dark:ring-white/10">
                        <CalendarDays className="size-3" /> {d.label}
                      </span>
                    </div>
                    {d.items.map((it) => {
                      if (it.kind === "note")
                        return (
                          <div key={it.id} className="mx-auto max-w-[85%] rounded-xl border border-amber-300/60 bg-amber-50 px-3 py-2 text-sm dark:border-amber-800 dark:bg-amber-950/30">
                            <div className="mb-0.5 flex items-center gap-1.5 text-[11px] font-medium text-amber-800 dark:text-amber-300">
                              <EyeOff className="size-3" /> Internal comment · {memberName(it.authorId)} · {clock(it.createdAt)}
                            </div>
                            <MentionText text={it.body ?? ""} members={members} me={me} />
                          </div>
                        );
                      const a = it.a;
                      const out = a.direction === "OUTBOUND";
                      const who = out ? "ESS" : name;
                      const body = a.sensitive ? null : a.type === "CALL" ? (a.summary ?? null) : a.body;
                      return (
                        <div key={a.id} className={cn("flex items-end gap-2", out && "flex-row-reverse")}>
                          <Avatar name={who} channel={a.type === "SMS" ? "SMS" : a.type === "CALL" ? "CALL" : "EMAIL"} className={cn(out && "bg-primary/15 text-primary")} />
                          <div className={cn("max-w-[78%] min-w-0 space-y-1", out && "items-end text-right")}>
                            <div className={cn("rounded-2xl px-3.5 py-2.5 text-left text-sm shadow-xs ring-1", out ? "rounded-br-sm bg-primary/10 ring-primary/15" : "rounded-bl-sm bg-card ring-black/[0.06] dark:ring-white/10")}>
                              {a.sensitive ? (
                                <span className="text-muted-foreground">
                                  AIRnyc — protected.{" "}
                                  <Link href={`/inbox?box=${out ? "sent" : "inbox"}&id=${a.id}`} className="text-primary underline">Open to reveal (logged)</Link>
                                </span>
                              ) : a.type === "CALL" ? (
                                <div className="space-y-1">
                                  <div className="flex items-center gap-1.5 font-medium">
                                    <PhoneCall className="size-4 text-primary" /> Call {a.callStatus ?? "completed"}
                                    {a.durationSeconds ? <span className="font-normal text-muted-foreground">· {Math.floor(a.durationSeconds / 60)}:{String(a.durationSeconds % 60).padStart(2, "0")}</span> : null}
                                  </div>
                                  {body && <p className="text-muted-foreground">{body}</p>}
                                  {a.transcript && (
                                    <details>
                                      <summary className="cursor-pointer text-xs font-medium text-primary">View transcript</summary>
                                      <p className="mt-1 max-h-60 overflow-y-auto text-xs whitespace-pre-line">{a.transcript}</p>
                                    </details>
                                  )}
                                  {a.externalUrl && <a href={a.externalUrl} target="_blank" rel="noreferrer" className="text-xs text-primary underline">Recording in Quo</a>}
                                </div>
                              ) : (
                                <>
                                  {a.type !== "SMS" && a.subject && <div className="mb-1 font-semibold">{a.subject}</div>}
                                  <div className="line-clamp-[12] whitespace-pre-line break-words">{(body ?? "").split(/\n(?:>|On .{3,80} wrote:)/)[0].trim() || "(no text)"}</div>
                                  {a.type !== "SMS" && (
                                    <Link href={`/inbox?box=${a.archivedAt ? "archived" : out ? "sent" : "inbox"}&id=${a.id}`} className="mt-1 inline-block text-xs text-primary hover:underline">Open full email</Link>
                                  )}
                                </>
                              )}
                            </div>
                            <div className="px-1 text-[11px] text-muted-foreground">
                              {clock(a.occurredAt)}
                              {out && a.channelLine ? ` · ${p.lines.find((l) => l.lineKey === a.channelLine)?.label ?? a.channelLine}` : ""}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ))}
              </ScrollToNewest>

              {protectedConv ? (
                <p className="border-t p-3 text-sm text-muted-foreground">AIRnyc conversation: reply from the message itself so it stays sealed.</p>
              ) : last?.contactId && p.panel?.contact.doNotContact ? (
                <p className="border-t p-3 text-sm text-destructive">{name} is marked do-not-contact.</p>
              ) : (
                <ConversationComposer
                  action={sendInConversationAction.bind(null, last!.id)}
                  initial={initialChannel}
                  sms={phone && p.lines.length ? { to: phone, lines: p.lines, defaultLineId: smsLine?.id } : null}
                  email={emailTo ? { to: emailTo, fromEmail: p.defaultFromEmail, subject: lastInboundEmail?.subject ? (/^re:/i.test(lastInboundEmail.subject) ? lastInboundEmail.subject : `Re: ${lastInboundEmail.subject}`) : "", inReplyTo: lastInboundEmail?.externalId ?? null } : null}
                  internal
                  members={members}
                  me={me}
                  context={{ contactId: selected.contactId, jobId: last?.jobId }}
                />
              )}
            </>
          )}
        </section>

        {/* ---------- client panel ---------- */}
        {selected && (
          <aside aria-label="Client" className="hidden min-h-0 overflow-y-auto border-l border-border/70 bg-muted/10 p-4 xl:block">
            {protectedConv ? (
              <p className="text-xs text-muted-foreground">AIRnyc member details stay in the AIRnyc case.</p>
            ) : p.panel ? (
              <ContactPanel data={p.panel} members={members} me={me} now={now} />
            ) : (
              <UnknownSenderPanel name={null} email={emailTo} phone={phone} />
            )}
            <p className="mt-4 text-[11px] text-muted-foreground">Last message {fmtDate(selected.lastAt, true)}.</p>
          </aside>
        )}
      </div>
    </>
  );
}
