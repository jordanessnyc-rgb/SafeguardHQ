import Link from "next/link";
import type { ReactNode } from "react";
import {
  ArrowLeft,
  Briefcase,
  CalendarDays,
  Check,
  CheckSquare,
  ChevronDown,
  FileText,
  Mail,
  MessageSquare,
  NotebookPen,
  Phone,
  PhoneCall,
  Search,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ActionForm, SubmitButton } from "@/components/forms";
import { ConfirmSubmit } from "@/components/confirm-submit";
import { ComposeMessage } from "@/components/compose-message";
import { fmtDate, label, personName, SERVICE_LABELS, titleCase } from "@/lib/labels";
import { formatPhone } from "@/lib/phone";
import { TZ } from "@/lib/time";
import { LEFT_TABS, PANELS, type ContactWorkspace, type LeftTab, type Panel } from "@/lib/contacts/workspace";
import type { loadComposeData } from "@/lib/comms/compose-data";

type ComposeData = Awaited<ReturnType<typeof loadComposeData>>;
import { cn } from "@/lib/utils";
import { setTaskStatus, createTask } from "@/app/(app)/tasks/actions";
import { addContactNote, archiveContact, setDoNotContact, updateContact } from "../actions";
import { ContactFields } from "../contact-fields";
import { ComposerBar, ScrollToNewest } from "./conversation-bits";

const PANEL_META: Record<Panel, { label: string; icon: typeof NotebookPen }> = {
  notes: { label: "Notes", icon: NotebookPen },
  tasks: { label: "Tasks", icon: CheckSquare },
  appointments: { label: "Appointments", icon: CalendarDays },
  documents: { label: "Documents", icon: FileText },
  jobs: { label: "Jobs & properties", icon: Briefcase },
};
const TAB_LABEL: Record<LeftTab, string> = { fields: "All fields", dnd: "DND", actions: "Actions" };
const dayKey = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: TZ });
const dayLabel = (d: Date) => d.toLocaleDateString("en-US", { timeZone: TZ, weekday: "short", month: "short", day: "numeric", year: "numeric" });
const timeLabel = (d: Date) => d.toLocaleTimeString("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" });
const initials = (name: string) => name.replace(/[^\p{L} ]/gu, "").split(/\s+/).filter(Boolean).map((w) => w[0]).slice(0, 2).join("").toUpperCase() || "#";

function Avatar({ name, className }: { name: string; className?: string }) {
  return (
    <span aria-hidden className={cn("flex shrink-0 items-center justify-center rounded-full bg-primary/10 font-semibold text-primary ring-1 ring-primary/15", className)}>
      {initials(name)}
    </span>
  );
}

function Column({ children, className, label: aria }: { children: ReactNode; className?: string; label: string }) {
  return (
    <section aria-label={aria} className={cn("panel flex min-w-0 flex-col overflow-hidden lg:max-h-[calc(100dvh-7.5rem)]", className)}>
      {children}
    </section>
  );
}

/**
 * Contact page, laid out as a workspace: details on the left, the conversation in the middle (newest
 * at the bottom, with the message box under it), and notes / tasks / appointments / documents / jobs
 * on the right. Tab and panel choices live in the URL (?tab=, ?panel=), so they survive a refresh.
 */
export function ContactWorkspaceView({
  id,
  data,
  compose,
  stageName,
  viewer,
  tab,
  panel,
  noteSearch,
  now,
}: {
  id: string;
  data: ContactWorkspace;
  compose: ComposeData;
  stageName: (j: { pipelineKey: string; stage: string }) => string;
  viewer: { role: string | null };
  tab: LeftTab;
  panel: Panel;
  noteSearch: string;
  now: Date;
}) {
  const { contact: c, org, orgs, jobs, conversation, notes, tasks, appointments, documents, properties, jobNumber, counts } = data;
  const name = personName(c);
  const path = `/contacts/${id}`;
  const href = (o: { tab?: LeftTab; panel?: Panel; q?: string }) => {
    const q = new URLSearchParams();
    const t = o.tab ?? tab;
    const p = o.panel ?? panel;
    if (t !== "fields") q.set("tab", t);
    if (p !== "notes") q.set("panel", p);
    if (o.q) q.set("q", o.q);
    return q.size ? `${path}?${q}` : path;
  };

  // Conversation grouped by day (New York), oldest day first.
  const days: { key: string; label: string; items: typeof conversation }[] = [];
  for (const a of conversation) {
    const k = dayKey(a.occurredAt);
    if (days.at(-1)?.key !== k) days.push({ key: k, label: dayLabel(a.occurredAt), items: [] });
    days.at(-1)!.items.push(a);
  }

  return (
    <>
      <nav aria-label="Breadcrumb" className="mb-3 flex items-center gap-1.5 text-sm">
        <Link href="/contacts" className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-4" /> Contacts
        </Link>
        <span aria-hidden className="text-muted-foreground">/</span>
        <span className="font-medium">{name}</span>
      </nav>

      <div className="grid gap-4 lg:grid-cols-[19rem_minmax(0,1fr)] xl:grid-cols-[19rem_minmax(0,1fr)_22rem]">
        {/* ---------------- Left: contact details ---------------- */}
        <Column label="Contact details">
          <div className="space-y-3 border-b p-4">
            <div className="flex items-center gap-3">
              <Avatar name={name} className="size-11 text-sm" />
              <div className="min-w-0">
                <h1 className="truncate text-lg leading-tight font-semibold">{name}</h1>
                {(c.title || org) && (
                  <p className="truncate text-xs text-muted-foreground">
                    {c.title}
                    {c.title && org ? " · " : ""}
                    {org && <Link href={`/organizations/${org.id}`} className="hover:underline">{org.name}</Link>}
                  </p>
                )}
              </div>
            </div>
            {c.doNotContact && <Badge variant="destructive">Do not contact</Badge>}
            <div className="space-y-1 text-sm">
              {c.emails.map((e) => (
                <a key={e} href={`mailto:${e}`} className="flex min-w-0 items-center gap-2 hover:underline"><Mail className="size-3.5 shrink-0 text-muted-foreground" /><span className="min-w-0 break-all">{e}</span></a>
              ))}
              {c.phones.map((p) => (
                <a key={p} href={`tel:${p}`} className="flex items-center gap-2 hover:underline"><Phone className="size-3.5 shrink-0 text-muted-foreground" />{formatPhone(p)}</a>
              ))}
              {c.emails.length + c.phones.length === 0 && <p className="text-xs text-muted-foreground">No email or phone yet.</p>}
            </div>
          </div>

          <nav aria-label="Contact sections" className="grid grid-cols-3 border-b text-sm">
            {LEFT_TABS.map((t) => (
              <Link key={t} href={href({ tab: t })} aria-current={tab === t ? "page" : undefined} className={cn("border-b-2 px-2 py-2.5 text-center", tab === t ? "border-primary font-semibold text-primary" : "border-transparent text-muted-foreground hover:text-foreground")}>
                {TAB_LABEL[t]}
              </Link>
            ))}
          </nav>

          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            {tab === "fields" && (
              <ActionForm action={updateContact.bind(null, id)} className="space-y-4 [&_.grid]:grid-cols-1 [&_.sm\:col-span-2]:col-span-1">
                <ContactFields contact={c} orgs={orgs} />
                <SubmitButton size="sm" className="w-full">Save changes</SubmitButton>
              </ActionForm>
            )}
            {tab === "dnd" && (
              <div className="space-y-3 text-sm">
                <div className={cn("rounded-lg border p-3", c.doNotContact ? "border-destructive/40 bg-destructive/5" : "bg-muted/40")}>
                  <p className="font-semibold">{c.doNotContact ? "Do not contact is ON" : "Do not contact is off"}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {c.doNotContact
                      ? "Nobody can text or email them from the CRM, and follow-ups skip them."
                      : "Turn this on if they asked not to be contacted. It blocks texts and emails from the CRM and stops follow-ups."}
                  </p>
                </div>
                <form action={setDoNotContact.bind(null, id, !c.doNotContact)}>
                  <Button type="submit" variant={c.doNotContact ? "outline" : "destructive"} className="w-full">
                    {c.doNotContact ? "Allow contact again" : "Mark do not contact"}
                  </Button>
                </form>
                {c.preferredChannel && <p className="text-xs text-muted-foreground">Prefers {c.preferredChannel.toLowerCase()}.</p>}
              </div>
            )}
            {tab === "actions" && (
              <div className="space-y-2">
                <Link href={`/jobs/new?clientContactId=${id}${c.orgId ? `&clientOrgId=${c.orgId}` : ""}`} className={cn(buttonVariants(), "w-full")}>New job</Link>
                <Link href={href({ panel: "tasks" })} className={cn(buttonVariants({ variant: "outline" }), "w-full")}>Add a task</Link>
                <Link href={href({ panel: "notes" })} className={cn(buttonVariants({ variant: "outline" }), "w-full")}>Add a note</Link>
                <form action={archiveContact.bind(null, id)} className="pt-3">
                  <ConfirmSubmit variant="destructive" size="sm" className="w-full" title="Archive this contact?" description="They disappear from lists and search. Their jobs and history stay." confirmLabel="Archive contact">
                    Archive contact
                  </ConfirmSubmit>
                </form>
              </div>
            )}
          </div>
        </Column>

        {/* ---------------- Middle: conversations ---------------- */}
        <Column label="Conversations">
          <div className="flex items-center gap-3 border-b px-4 py-3">
            <Avatar name={name} className="size-8 text-xs" />
            <h2 className="min-w-0 flex-1 truncate font-semibold">Conversations with {c.firstName || name}</h2>
            <span className="text-xs text-muted-foreground tabular-nums">{conversation.length} message{conversation.length === 1 ? "" : "s"}</span>
          </div>
          <ScrollToNewest className="min-h-0 flex-1 space-y-3 overflow-y-auto bg-muted/20 p-4">
            {days.length === 0 && <p className="py-10 text-center text-sm text-muted-foreground">No emails, texts or calls with {c.firstName || "them"} yet.</p>}
            {days.map((d) => (
              <div key={d.key} className="space-y-2">
                <div className="flex justify-center">
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-card px-3 py-0.5 text-xs text-muted-foreground shadow-xs ring-1 ring-black/[0.05] dark:ring-white/10">
                    <CalendarDays className="size-3" /> {d.label}
                  </span>
                </div>
                {d.items.map((a) => {
                  const out = a.direction === "OUTBOUND";
                  const Icon = a.type === "SMS" ? MessageSquare : a.type === "CALL" ? PhoneCall : Mail;
                  const title = a.sensitive ? "AIRnyc — protected" : a.type === "SMS" ? (out ? "Text sent" : "Text received") : a.type === "CALL" ? `Call${a.callStatus ? ` · ${a.callStatus}` : ""}` : a.subject || "(no subject)";
                  const who = out ? "You (ESS)" : name;
                  const body = a.sensitive ? "Open it in Messages to reveal (logged)." : a.type === "CALL" ? (a.summary ?? a.body ?? "") : (a.body ?? "");
                  return (
                    <details key={a.id} className="group rounded-xl bg-card shadow-xs ring-1 ring-black/[0.06] dark:ring-white/10">
                      <summary className="flex cursor-pointer list-none flex-col gap-1 px-3 py-2.5">
                        <span className="flex items-center gap-2 text-sm font-semibold">
                          <span className="min-w-0 flex-1 truncate">{title}</span>
                          <ChevronDown className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" aria-hidden />
                        </span>
                        <span className="flex items-center gap-2.5">
                          <span className={cn("relative flex size-7 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold", out ? "bg-primary text-primary-foreground" : "bg-muted")}>
                            {out ? "ESS" : initials(name)}
                            <Icon className="absolute -right-1 -bottom-1 size-3.5 rounded-full bg-card p-0.5 text-primary" aria-hidden />
                          </span>
                          <span className="min-w-0 flex-1 text-sm">
                            <span className="font-medium">{who}</span>
                            <span className="block truncate text-muted-foreground group-open:hidden">{body.replace(/\s+/g, " ").trim() || "(no text)"}</span>
                          </span>
                          <time dateTime={a.occurredAt.toISOString()} className="shrink-0 text-xs text-muted-foreground tabular-nums">{timeLabel(a.occurredAt)}</time>
                        </span>
                      </summary>
                      <div className="border-t px-3 py-3 text-sm whitespace-pre-line">
                        {body || <span className="text-muted-foreground">(no text)</span>}
                        <div className="mt-2 flex flex-wrap gap-3 text-xs">
                          {a.jobId && jobNumber.get(a.jobId) && <Link href={`/jobs/${a.jobId}`} className="font-mono text-primary hover:underline">{jobNumber.get(a.jobId)}</Link>}
                          {a.type !== "CALL" && <Link href={`/inbox?box=${a.archivedAt ? "archived" : out ? "sent" : "inbox"}&id=${a.id}`} className="text-primary hover:underline">Open in Messages</Link>}
                          {a.externalUrl && <a href={a.externalUrl} target="_blank" rel="noreferrer" className="text-primary hover:underline">Open in Quo</a>}
                        </div>
                      </div>
                    </details>
                  );
                })}
              </div>
            ))}
          </ScrollToNewest>
          <ComposerBar disabled={c.doNotContact ? <p className="text-sm text-destructive">Marked do-not-contact. Turn it off in the DND tab to message them.</p> : undefined}>
            {!c.doNotContact && (
              <ComposeMessage
                phones={c.phones}
                emails={c.emails}
                {...compose}
                context={{ contactId: id, jobId: jobs.length === 1 ? jobs[0].id : undefined }}
                revalidate={path}
                isOwner={viewer.role === "OWNER"}
              />
            )}
          </ComposerBar>
        </Column>

        {/* ---------------- Right: notes / tasks / appointments / documents / jobs ---------------- */}
        <Column label="Notes, tasks, appointments and documents" className="lg:col-span-2 xl:col-span-1">
          <div className="flex min-h-0 flex-1">
            <div className="flex min-w-0 flex-1 flex-col">
              <div className="flex items-center justify-between border-b px-4 py-3">
                <h2 className="font-semibold">{PANEL_META[panel].label}</h2>
              </div>
              <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
                {panel === "notes" && (
                  <>
                    <form role="search" className="relative">
                      {tab !== "fields" && <input type="hidden" name="tab" value={tab} />}
                      <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
                      <Input type="search" name="q" defaultValue={noteSearch} placeholder="Search notes" aria-label="Search notes" className="pl-8" />
                    </form>
                    <ActionForm action={addContactNote.bind(null, id)} className="space-y-2">
                      <Textarea name="body" rows={3} maxLength={10000} required placeholder="Add a note about this contact…" aria-label="New note" />
                      <SubmitButton size="sm" className="w-full">Add note</SubmitButton>
                    </ActionForm>
                    {notes.length === 0 ? (
                      <div className="py-6 text-center text-sm text-muted-foreground">
                        <NotebookPen className="mx-auto mb-2 size-6" aria-hidden />
                        {noteSearch ? `No notes match "${noteSearch}".` : "No notes yet. Keep track of important details by adding your first note."}
                      </div>
                    ) : (
                      <ul className="space-y-2">
                        {notes.map((n) => (
                          <li key={n.id} className="rounded-lg bg-muted/50 px-3 py-2 text-sm">
                            <p className="whitespace-pre-line">{n.sensitive ? <span className="text-muted-foreground">(sealed AIRnyc note)</span> : n.body}</p>
                            <p className="mt-1 text-[11px] text-muted-foreground">
                              {n.authorName ? `${n.authorName} · ` : ""}
                              {fmtDate(n.occurredAt, true)}
                              {n.jobId && jobNumber.get(n.jobId) ? ` · ${jobNumber.get(n.jobId)}` : ""}
                            </p>
                          </li>
                        ))}
                      </ul>
                    )}
                  </>
                )}

                {panel === "tasks" && (
                  <>
                    <ActionForm action={createTask} className="space-y-2 rounded-lg border p-3">
                      <input type="hidden" name="contactId" value={id} />
                      <input type="hidden" name="revalidate" value={path} />
                      <Input name="title" required maxLength={300} placeholder={`e.g. Call ${c.firstName || "them"} back`} aria-label="Task" />
                      <div className="flex gap-2">
                        <Input type="datetime-local" name="dueAt" aria-label="Due" className="min-w-0 flex-1" />
                        <SubmitButton size="sm">Add task</SubmitButton>
                      </div>
                    </ActionForm>
                    {tasks.length === 0 ? (
                      <p className="py-6 text-center text-sm text-muted-foreground">No tasks for {c.firstName || "them"}.</p>
                    ) : (
                      <ul className="space-y-1.5">
                        {tasks.map((t) => {
                          const done = t.status === "DONE";
                          const late = !done && t.dueAt && t.dueAt < now;
                          return (
                            <li key={t.id} className="flex items-start gap-2 rounded-lg px-1 py-1.5">
                              <form action={setTaskStatus.bind(null, t.id, done ? "OPEN" : "DONE", path)}>
                                <button type="submit" aria-label={done ? `Reopen “${t.title}”` : `Mark “${t.title}” done`} className={cn("mt-0.5 flex size-4 items-center justify-center rounded border", done ? "border-primary bg-primary text-primary-foreground" : "border-input hover:border-primary")}>
                                  {done && <Check className="size-3" />}
                                </button>
                              </form>
                              <span className="min-w-0 flex-1 text-sm">
                                <span className={cn("block", done && "text-muted-foreground line-through")}>{t.title}</span>
                                <span className={cn("text-xs", late ? "font-medium text-amber-700 dark:text-amber-400" : "text-muted-foreground")}>
                                  {t.dueAt ? `${late ? "Overdue · " : "Due "}${fmtDate(t.dueAt, true)}` : "No due date"}
                                  {t.jobId && jobNumber.get(t.jobId) ? ` · ${jobNumber.get(t.jobId)}` : ""}
                                </span>
                              </span>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </>
                )}

                {panel === "appointments" && (
                  <>
                    {appointments.upcoming.length + appointments.past.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">No inspections scheduled for {c.firstName || "them"}.</p>}
                    {[["Upcoming", appointments.upcoming], ["Past", appointments.past]].map(([title, list]) =>
                      (list as typeof appointments.upcoming).length ? (
                        <div key={title as string} className="space-y-1.5">
                          <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{title as string}</h3>
                          <ul className="space-y-1.5">
                            {(list as typeof appointments.upcoming).map((j) => (
                              <li key={j.id}>
                                <Link href={`/jobs/${j.id}`} className="block rounded-lg border px-3 py-2 text-sm hover:bg-muted/50">
                                  <span className="font-medium">{fmtDate(j.scheduledAt, true)}</span>
                                  <span className="block text-xs text-muted-foreground">
                                    {label(SERVICE_LABELS, j.serviceCode)}
                                    {j.address ? ` · ${j.address}${j.unit ? ` #${j.unit}` : ""}` : ""} · {j.jobNumber}
                                  </span>
                                </Link>
                              </li>
                            ))}
                          </ul>
                        </div>
                      ) : null,
                    )}
                    <Link href="/schedule" className={cn(buttonVariants({ variant: "outline", size: "sm" }), "w-full")}>Open the calendar</Link>
                  </>
                )}

                {panel === "documents" &&
                  (documents.length === 0 ? (
                    <p className="py-6 text-center text-sm text-muted-foreground">No documents on {c.firstName ? `${c.firstName}'s` : "their"} jobs yet.</p>
                  ) : (
                    <ul className="space-y-1.5">
                      {documents.map((d) => (
                        <li key={d.id}>
                          <a href={`/api/documents/${d.id}`} target="_blank" rel="noreferrer" className="flex items-start gap-2 rounded-lg border px-3 py-2 text-sm hover:bg-muted/50">
                            <FileText className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                            <span className="min-w-0">
                              <span className="block truncate font-medium">{d.title || titleCase(d.kind)}</span>
                              <span className="text-xs text-muted-foreground">
                                {titleCase(d.kind)}
                                {d.jobId && jobNumber.get(d.jobId) ? ` · ${jobNumber.get(d.jobId)}` : ""} · {fmtDate(d.createdAt)}
                              </span>
                            </span>
                          </a>
                        </li>
                      ))}
                    </ul>
                  ))}

                {panel === "jobs" && (
                  <>
                    <Link href={`/jobs/new?clientContactId=${id}${c.orgId ? `&clientOrgId=${c.orgId}` : ""}`} className={cn(buttonVariants({ size: "sm" }), "w-full")}>New job</Link>
                    <div className="space-y-1.5">
                      <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Jobs</h3>
                      {jobs.length === 0 ? (
                        <p className="text-sm text-muted-foreground">None yet.</p>
                      ) : (
                        <ul className="space-y-1.5">
                          {jobs.map((j) => (
                            <li key={j.id}>
                              <Link href={`/jobs/${j.id}`} className="flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm hover:bg-muted/50">
                                <span className="min-w-0">
                                  <span className="block truncate font-medium">{label(SERVICE_LABELS, j.serviceCode)}</span>
                                  <span className="block truncate text-xs text-muted-foreground"><span className="font-mono">{j.jobNumber}</span>{j.address ? ` · ${j.address}` : ""}</span>
                                </span>
                                <Badge variant="secondary" className="shrink-0">{stageName(j)}</Badge>
                              </Link>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                    <div className="space-y-1.5">
                      <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Properties</h3>
                      {properties.length === 0 ? (
                        <p className="text-sm text-muted-foreground">Not linked to a property. Link from the property page.</p>
                      ) : (
                        <ul className="space-y-1">
                          {properties.map((p) => (
                            <li key={p.id}>
                              <Link href={`/properties/${p.id}`} className="block text-sm hover:underline">
                                <Badge variant="secondary" className="mr-1.5">{titleCase(p.role)}</Badge>
                                {p.address}
                                {p.unit ? ` #${p.unit}` : ""}
                              </Link>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </>
                )}
              </div>
            </div>

            {/* Icon rail */}
            <nav aria-label="Side panel" className="flex w-12 shrink-0 flex-col items-center gap-1 border-l bg-muted/30 py-2">
              {PANELS.map((p) => {
                const { icon: Icon, label: l } = PANEL_META[p];
                const n = counts[p];
                return (
                  <Link key={p} href={href({ panel: p })} aria-current={panel === p ? "page" : undefined} title={l} aria-label={`${l}${n ? ` (${n})` : ""}`} className={cn("relative flex size-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-card hover:text-foreground", panel === p && "bg-card text-primary shadow-xs ring-1 ring-black/[0.05] dark:ring-white/10")}>
                    <Icon className="size-[18px]" />
                    {n > 0 && p !== "notes" && <span className="absolute -top-0.5 -right-0.5 min-w-4 rounded-full bg-primary px-1 text-center text-[10px] leading-4 font-semibold text-primary-foreground tabular-nums">{n}</span>}
                  </Link>
                );
              })}
            </nav>
          </div>
        </Column>
      </div>
    </>
  );
}
