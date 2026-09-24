import Link from "next/link";
import { asc, count, desc, eq, isNull, ne } from "drizzle-orm";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { NativeSelect } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ActionForm, SubmitButton } from "@/components/forms";
import { PageHeader } from "@/components/page-header";
import { requireOwner } from "@/lib/auth/session";
import { schema as s } from "@/lib/db";
import { fbConfigFromEnv } from "@/lib/integrations/freshbooks";
import { fmtDate, personName } from "@/lib/labels";
import { disconnectFreshbooks, importClients, reopenClient, reregisterWebhooks, resolveClient } from "./actions";

export const metadata = { title: "FreshBooks" };

export default async function FreshbooksSettingsPage({ searchParams }: PageProps<"/settings/freshbooks">) {
  const user = await requireOwner();
  const sp = await searchParams;
  const d = await user.db(async (tx) => ({
    conn: (await tx.select().from(s.freshbooksConnection))[0],
    pending: await tx.select().from(s.freshbooksClients).where(eq(s.freshbooksClients.matchStatus, "PENDING")).orderBy(asc(s.freshbooksClients.organization), asc(s.freshbooksClients.lastName)),
    resolved: await tx.select().from(s.freshbooksClients).where(ne(s.freshbooksClients.matchStatus, "PENDING")).orderBy(desc(s.freshbooksClients.updatedAt)).limit(200),
    resolvedCount: (await tx.select({ n: count() }).from(s.freshbooksClients).where(ne(s.freshbooksClients.matchStatus, "PENDING")))[0].n,
    orgs: await tx.select({ id: s.organizations.id, name: s.organizations.name }).from(s.organizations).where(isNull(s.organizations.archivedAt)).orderBy(asc(s.organizations.name)),
    contacts: await tx
      .select({ id: s.contacts.id, firstName: s.contacts.firstName, lastName: s.contacts.lastName, emails: s.contacts.emails })
      .from(s.contacts)
      .where(isNull(s.contacts.archivedAt))
      .orderBy(asc(s.contacts.lastName), asc(s.contacts.firstName)),
  }));
  const configured = Boolean(fbConfigFromEnv());
  const orgName = new Map(d.orgs.map((o) => [o.id, o.name]));
  const contactName = new Map(d.contacts.map((c) => [c.id, personName(c)]));
  const callbacks = Object.entries(d.conn?.webhookCallbacks ?? {});
  const error = typeof sp.error === "string" ? sp.error : null;

  return (
    <>
      <PageHeader title="FreshBooks" description={<Link href="/settings" className="hover:underline">← Settings</Link>} />
      {sp.connected && <p className="mb-3 rounded-md border border-primary/40 bg-primary/5 p-2 text-sm text-primary">FreshBooks connected. Next: import your clients below.</p>}
      {error && <p role="alert" className="mb-3 rounded-md border border-destructive/40 bg-destructive/5 p-2 text-sm text-destructive">{error === "not-configured" ? "FreshBooks app credentials aren't set on the server." : error}</p>}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Connection</CardTitle>
            <CardDescription>Drafts are created in FreshBooks when a job is marked Delivered. Nothing is emailed to a client unless “Auto-send FreshBooks invoices” is on.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {!configured && <p className="text-destructive">Server is missing FRESHBOOKS_CLIENT_ID / _CLIENT_SECRET / _REDIRECT_URI (see RUNBOOK).</p>}
            {d.conn ? (
              <>
                <div>
                  <div className="font-medium">{d.conn.businessName ?? "FreshBooks business"}</div>
                  <div className="text-xs text-muted-foreground">
                    Account {d.conn.accountId} · connected {fmtDate(d.conn.createdAt, true)} · token refreshed {fmtDate(d.conn.lastRefreshAt, true)}
                  </div>
                  <div className="text-xs text-muted-foreground">Automatic drafts apply to jobs delivered after {fmtDate(d.conn.createdAt)}; older jobs have a button on the job page.</div>
                  {d.conn.lastError && <div className="text-xs text-destructive">{d.conn.lastError}</div>}
                </div>
                <div className="flex flex-wrap gap-2">
                  {/* Plain <a>: this is a route handler that redirects to FreshBooks. */}
                  <a href="/api/freshbooks/connect" className={buttonVariants({ variant: "outline", size: "sm" })}>Reconnect</a>
                  <form action={disconnectFreshbooks}>
                    <Button size="sm" variant="ghost" type="submit">Disconnect</Button>
                  </form>
                </div>
              </>
            ) : (
              configured && <a href="/api/freshbooks/connect" className={buttonVariants({ size: "sm" })}>Connect FreshBooks</a>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Payment webhooks</CardTitle>
            <CardDescription>FreshBooks tells the CRM when invoices are sent or paid. Paid jobs move to Paid and held reports are released.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {callbacks.length === 0 ? (
              <p className="text-muted-foreground">None registered yet.</p>
            ) : (
              <ul className="grid grid-cols-2 gap-1 text-xs">
                {callbacks.map(([id, cb]) => (
                  <li key={id} className="flex items-center gap-1.5">
                    <Badge variant={cb.verified ? "secondary" : "outline"}>{cb.verified ? "✓" : "waiting"}</Badge>
                    {cb.event}
                  </li>
                ))}
              </ul>
            )}
            {d.conn && (
              <ActionForm action={reregisterWebhooks}>
                <SubmitButton size="sm" variant="outline">Register webhooks again</SubmitButton>
              </ActionForm>
            )}
          </CardContent>
        </Card>
      </div>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle>Client import &amp; duplicate review</CardTitle>
          <CardDescription>
            Each FreshBooks client is matched to a CRM organization or contact by email, company name or person name. Nothing is merged until you choose: link to the existing record, create a new one, or ignore.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {d.conn && (
            <ActionForm action={importClients} className="flex flex-col items-start gap-1">
              <SubmitButton size="sm">Import / refresh clients from FreshBooks</SubmitButton>
            </ActionForm>
          )}
          {d.pending.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>FreshBooks client</TableHead>
                  <TableHead>Suggested match</TableHead>
                  <TableHead className="w-[28rem]">Decision</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {d.pending.map((c) => (
                  <TableRow key={c.freshbooksClientId} className="align-top">
                    <TableCell>
                      <div className="font-medium">{c.organization || personName(c) || "(no name)"}</div>
                      <div className="text-xs text-muted-foreground">{[c.organization && personName(c), c.email, c.phone].filter(Boolean).join(" · ")}</div>
                    </TableCell>
                    <TableCell className="text-sm">
                      {c.suggestedOrgId || c.suggestedContactId ? (
                        <>
                          <div>{[c.suggestedOrgId && orgName.get(c.suggestedOrgId), c.suggestedContactId && contactName.get(c.suggestedContactId)].filter(Boolean).join(" / ")}</div>
                          <div className="text-xs text-muted-foreground">{c.matchReason}</div>
                        </>
                      ) : (
                        <span className="text-xs text-muted-foreground">No likely duplicate</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <ActionForm action={resolveClient.bind(null, c.freshbooksClientId)} className="flex flex-wrap items-center gap-1.5">
                        <NativeSelect name="orgId" defaultValue={c.suggestedOrgId ?? ""} className="h-7 w-44 text-xs" aria-label="Organization">
                          <option value="">— organization —</option>
                          {d.orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                        </NativeSelect>
                        <NativeSelect name="contactId" defaultValue={c.suggestedContactId ?? ""} className="h-7 w-40 text-xs" aria-label="Contact">
                          <option value="">— contact —</option>
                          {d.contacts.map((ct) => <option key={ct.id} value={ct.id}>{personName(ct)}{ct.emails[0] ? ` (${ct.emails[0]})` : ""}</option>)}
                        </NativeSelect>
                        <SubmitButton size="xs" name="action" value="link">Link</SubmitButton>
                        <SubmitButton size="xs" variant="secondary" name="action" value="create">Create new</SubmitButton>
                        <SubmitButton size="xs" variant="ghost" name="action" value="ignore">Ignore</SubmitButton>
                      </ActionForm>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <p className="text-sm text-muted-foreground">{d.resolvedCount ? "Nothing left to review." : "No clients imported yet."}</p>
          )}

          {d.resolved.length > 0 && (
            <details className="text-sm">
              <summary className="cursor-pointer text-muted-foreground">Resolved ({d.resolvedCount})</summary>
              <ul className="mt-2 divide-y">
                {d.resolved.map((c) => (
                  <li key={c.freshbooksClientId} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                    <span>
                      {c.organization || personName(c)} <Badge variant="outline" className="ml-1">{c.matchStatus.toLowerCase()}</Badge>
                      {(c.linkedOrgId || c.linkedContactId) && (
                        <span className="ml-2 text-xs text-muted-foreground">
                          →{" "}
                          {c.linkedOrgId ? (
                            <Link className="underline" href={`/organizations/${c.linkedOrgId}`}>{orgName.get(c.linkedOrgId) ?? "organization"}</Link>
                          ) : (
                            <Link className="underline" href={`/contacts/${c.linkedContactId}`}>{contactName.get(c.linkedContactId!) ?? "contact"}</Link>
                          )}
                        </span>
                      )}
                    </span>
                    {c.matchStatus === "IGNORED" && (
                      <form action={reopenClient.bind(null, c.freshbooksClientId)}>
                        <Button size="xs" variant="ghost" type="submit">Review again</Button>
                      </form>
                    )}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </CardContent>
      </Card>
    </>
  );
}
