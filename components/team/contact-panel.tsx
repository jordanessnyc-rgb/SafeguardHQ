import Link from "next/link";
import { CalendarDays, CheckSquare, FileText, Mail, NotebookPen, Phone, UserPlus } from "lucide-react";
import type { ReactNode } from "react";
import { buttonVariants } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { MentionText } from "@/components/team/mention-text";
import { fmtDate, label, SERVICE_LABELS, titleCase } from "@/lib/labels";
import { formatPhone } from "@/lib/phone";
import type { ContactPanelData } from "@/lib/team/contact-panel";
import type { Member } from "@/lib/team/mentions";
import { cn } from "@/lib/utils";

function Section({ icon, title, count, children, empty }: { icon: ReactNode; title: string; count?: number; children: ReactNode; empty: string }) {
  return (
    <section className="space-y-1.5">
      <h3 className="flex items-center gap-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase [&_svg]:size-3.5">
        {icon}
        {title}
        {count ? <span className="font-normal tabular-nums">· {count}</span> : null}
      </h3>
      {count === 0 ? <p className="text-xs text-muted-foreground">{empty}</p> : children}
    </section>
  );
}

function Fact({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-2 text-sm">
      <dt className="text-muted-foreground">{k}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

/** Right-hand panel in Messages: the lead/client behind the open message. */
export function ContactPanel({ data, members, me, now }: { data: ContactPanelData; members: Member[]; me: string; now: Date }) {
  if (!data) return null;
  const { contact: c, tasks, notes, appointments, documents, jobNumber } = data;
  const name = (id: string | null) => members.find((m) => m.id === id)?.name ?? "Someone";
  return (
    <div className="space-y-5">
      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <Link href={`/contacts/${c.id}`} className="text-base font-semibold hover:underline">
            {[c.firstName, c.lastName].filter(Boolean).join(" ") || "Unnamed contact"}
          </Link>
          {c.doNotContact && <Badge variant="destructive">Do not contact</Badge>}
        </div>
        {(c.title || c.orgName) && (
          <p className="text-xs text-muted-foreground">
            {c.title}
            {c.title && c.orgName ? " · " : ""}
            {c.orgName && c.orgId ? <Link href={`/organizations/${c.orgId}`} className="hover:underline">{c.orgName}</Link> : null}
          </p>
        )}
      </div>

      <dl className="space-y-1.5">
        <Fact k="First name">{c.firstName || "—"}</Fact>
        <Fact k="Last name">{c.lastName || "—"}</Fact>
        <Fact k="Email">
          {c.emails.length ? c.emails.map((e) => <a key={e} href={`mailto:${e}`} className="flex min-w-0 items-center gap-1 hover:underline"><Mail className="size-3 shrink-0 text-muted-foreground" /><span className="min-w-0 break-all">{e}</span></a>) : "—"}
        </Fact>
        <Fact k="Phone">
          {c.phones.length ? c.phones.map((p) => <a key={p} href={`tel:${p}`} className="flex items-center gap-1 hover:underline"><Phone className="size-3 shrink-0 text-muted-foreground" />{formatPhone(p)}</a>) : "—"}
        </Fact>
      </dl>

      <Section icon={<CheckSquare />} title="Tasks" count={tasks.length} empty="No open tasks.">
        <ul className="space-y-1">
          {tasks.map((t) => {
            const late = t.dueAt && t.dueAt < now;
            return (
              <li key={t.id} className="text-sm">
                <span className="block">{t.title}</span>
                <span className={cn("text-xs", late ? "font-medium text-amber-700 dark:text-amber-400" : "text-muted-foreground")}>
                  {t.dueAt ? `${late ? "Overdue · " : "Due "}${fmtDate(t.dueAt)}` : "No due date"}
                  {t.jobId && jobNumber.get(t.jobId) ? ` · ${jobNumber.get(t.jobId)}` : ""}
                </span>
              </li>
            );
          })}
        </ul>
      </Section>

      <Section icon={<NotebookPen />} title="Notes" count={notes.length} empty="No notes yet.">
        <ul className="space-y-2">
          {notes.map((n) => (
            <li key={n.id} className="rounded-md bg-muted/60 px-2.5 py-1.5 text-sm">
              {n.sensitive ? <span className="text-muted-foreground">(sealed AIRnyc note)</span> : <MentionText text={n.body ?? ""} members={members} me={me} className="line-clamp-4" />}
              <span className="mt-0.5 block text-[11px] text-muted-foreground">
                {n.authorId ? `${name(n.authorId)} · ` : ""}
                {fmtDate(n.occurredAt, true)}
              </span>
            </li>
          ))}
        </ul>
      </Section>

      <Section icon={<CalendarDays />} title="Appointments" count={appointments.length} empty="Nothing scheduled.">
        <ul className="space-y-1.5">
          {appointments.map((j) => (
            <li key={j.id}>
              <Link href={`/jobs/${j.id}`} className="block text-sm hover:underline">
                <span className={cn("font-medium", !j.upcoming && "text-muted-foreground")}>{fmtDate(j.scheduledAt, true)}</span>
                {j.upcoming ? "" : " (past)"}
                <span className="block text-xs text-muted-foreground">
                  {label(SERVICE_LABELS, j.serviceCode)}
                  {j.address ? ` · ${j.address}${j.unit ? ` #${j.unit}` : ""}` : ""} · {j.jobNumber}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </Section>

      <Section icon={<FileText />} title="Documents" count={documents.length} empty="No documents on their jobs.">
        <ul className="space-y-1">
          {documents.map((d) => (
            <li key={d.id}>
              <a href={`/api/documents/${d.id}`} target="_blank" rel="noreferrer" className="block text-sm hover:underline">
                {d.title || titleCase(d.kind)}
                <span className="block text-xs text-muted-foreground">
                  {titleCase(d.kind)}
                  {d.jobId && jobNumber.get(d.jobId) ? ` · ${jobNumber.get(d.jobId)}` : ""} · {fmtDate(d.createdAt)}
                </span>
              </a>
            </li>
          ))}
        </ul>
      </Section>

      <Link href={`/contacts/${c.id}`} className={cn(buttonVariants({ variant: "outline", size: "sm" }), "w-full")}>
        Open full contact
      </Link>
    </div>
  );
}

/** Shown instead when the sender isn't in the CRM yet. */
export function UnknownSenderPanel({ name, email, phone }: { name: string | null; email: string | null; phone: string | null }) {
  const [first, ...rest] = (name ?? "").trim().split(/\s+/);
  const q = new URLSearchParams({ ...(first ? { firstName: first } : {}), ...(rest.length ? { lastName: rest.join(" ") } : {}), ...(email ? { email } : {}), ...(phone ? { phone } : {}) });
  return (
    <div className="space-y-3">
      <p className="text-sm font-semibold">Not in your contacts</p>
      <dl className="space-y-1.5">
        {name && <Fact k="Name">{name}</Fact>}
        {email && <Fact k="Email">{email}</Fact>}
        {phone && <Fact k="Phone">{formatPhone(phone)}</Fact>}
      </dl>
      <p className="text-xs text-muted-foreground">Add them as a contact to see their tasks, notes, appointments and documents here.</p>
      <Link href={`/contacts/new?${q}`} className={cn(buttonVariants({ size: "sm" }), "w-full")}>
        <UserPlus /> Add as contact
      </Link>
    </div>
  );
}
