import Link from "next/link";
import { desc, eq, inArray } from "drizzle-orm";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ActionForm, SubmitButton } from "@/components/forms";
import { EmptyState, PageHeader } from "@/components/page-header";
import { requireStaff } from "@/lib/auth/session";
import { schema as s } from "@/lib/db";
import { fmtDate, personName, titleCase } from "@/lib/labels";
import { formatPhone } from "@/lib/phone";
import { approveAndSend, discardMessage } from "../comms/actions";

export const metadata = { title: "Outbox" };

/** CLAUDE.md rule 6: nothing goes to a client until someone approves it here (unless auto-send is on). */
export default async function OutboxPage() {
  const user = await requireStaff();
  const { pending, recent } = await user.db(async (tx) => {
    const cols = { m: s.outboundMessages, contact: { firstName: s.contacts.firstName, lastName: s.contacts.lastName, id: s.contacts.id }, jobNumber: s.jobs.jobNumber, jobId: s.jobs.id, line: s.phoneLines.label };
    const q = () =>
      tx
        .select(cols)
        .from(s.outboundMessages)
        .leftJoin(s.contacts, eq(s.contacts.id, s.outboundMessages.contactId))
        .leftJoin(s.jobs, eq(s.jobs.id, s.outboundMessages.jobId))
        .leftJoin(s.phoneLines, eq(s.phoneLines.id, s.outboundMessages.fromLineId));
    return {
      pending: await q().where(inArray(s.outboundMessages.status, ["DRAFT", "FAILED", "APPROVED", "SENDING"])).orderBy(desc(s.outboundMessages.createdAt)),
      recent: await q().where(inArray(s.outboundMessages.status, ["SENT", "DISCARDED"])).orderBy(desc(s.outboundMessages.updatedAt)).limit(30),
    };
  });

  return (
    <>
      <PageHeader title="Outbox" description="Drafted texts and emails waiting for approval. Edit, then approve & send — or discard." />
      {pending.length === 0 ? (
        <EmptyState>Nothing waiting for approval.</EmptyState>
      ) : (
        <div className="space-y-3">
          {pending.map(({ m, contact, jobNumber, jobId, line }) => (
            <Card key={m.id}>
              <CardContent className="space-y-2">
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <Badge variant={m.status === "FAILED" ? "destructive" : "secondary"}>{titleCase(m.status)}</Badge>
                  <Badge variant="outline">{m.channel === "SMS" ? "Text" : "Email"}</Badge>
                  <span>{titleCase(m.source)}</span>
                  <span>· to {m.channel === "SMS" ? formatPhone(m.toAddress) : m.toAddress}</span>
                  {contact?.id && <Link className="hover:underline" href={`/contacts/${contact.id}`}>({personName(contact)})</Link>}
                  {jobNumber && <Link className="font-mono hover:underline" href={`/jobs/${jobId}`}>{jobNumber}</Link>}
                  {line && <span>· from {line}</span>}
                  {m.fromEmail && <span>· from {m.fromEmail}</span>}
                  <span>· {fmtDate(m.createdAt, true)}</span>
                  {m.containsPricing && <Badge variant="outline">$ owner only</Badge>}
                </div>
                {m.error && <p className="text-sm text-destructive">Last attempt failed: {m.error}</p>}
                {m.status === "DRAFT" || m.status === "FAILED" ? (
                  <>
                    <ActionForm action={approveAndSend.bind(null, m.id)} className="space-y-2">
                      {m.channel === "EMAIL" && <Input name="subject" defaultValue={m.subject ?? ""} aria-label="Subject" />}
                      <Textarea name="body" defaultValue={m.body} rows={m.channel === "SMS" ? 3 : 8} aria-label="Message" />
                      <SubmitButton size="sm">Approve &amp; send</SubmitButton>
                    </ActionForm>
                    <form action={discardMessage.bind(null, m.id)}>
                      <Button size="xs" variant="ghost" type="submit">Discard</Button>
                    </form>
                  </>
                ) : (
                  <p className="text-sm whitespace-pre-line">{m.body}</p>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
      <h2 className="mt-8 mb-2 font-semibold">Recently sent</h2>
      {recent.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing yet.</p>
      ) : (
        <ul className="divide-y rounded-lg border text-sm">
          {recent.map(({ m, contact }) => (
            <li key={m.id} className="flex flex-wrap justify-between gap-2 p-2">
              <span className="min-w-0 truncate">
                <Badge variant="outline">{m.channel === "SMS" ? "Text" : "Email"}</Badge> {contact ? personName(contact) : m.toAddress} — {m.subject || m.body.slice(0, 80)}
              </span>
              <span className="text-xs text-muted-foreground">
                {titleCase(m.status)} {fmtDate(m.sentAt ?? m.updatedAt, true)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
