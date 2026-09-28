import Link from "next/link";
import { col } from "@/lib/db/sql";
import { stageNamer } from "@/lib/pipeline/config";
import { Timeline } from "@/components/timeline";
import { ConfirmSubmit } from "@/components/confirm-submit";
import { notFound } from "next/navigation";
import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ActionForm, Field, SubmitButton } from "@/components/forms";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { daysUntil } from "@/lib/compliance/expiry";
import { PageHeader } from "@/components/page-header";
import { requireStaff } from "@/lib/auth/session";
import { schema as s } from "@/lib/db";
import { fmtDate, label, ORG_TYPE_LABELS, personName, SERVICE_LABELS, usd } from "@/lib/labels";
import { archiveOrganization, saveSubProfile, updateOrganization } from "../actions";
import { OrgFields } from "../org-fields";

export default async function OrganizationPage({ params }: PageProps<"/organizations/[id]">) {
  const { id } = await params;
  const user = await requireStaff();
  const data = await user.db(async (tx) => {
    const [org] = await tx.select().from(s.organizations).where(eq(s.organizations.id, id));
    if (!org) return null;
    const contacts = await tx.select().from(s.contacts).where(and(eq(s.contacts.orgId, id), isNull(s.contacts.archivedAt)));
    const jobs = await tx
      .select({ job: s.jobs, address: s.properties.addressLine })
      .from(s.jobs)
      .leftJoin(s.properties, eq(s.properties.id, s.jobs.propertyId))
      .where(and(eq(s.jobs.clientOrgId, id), isNull(s.jobs.archivedAt)))
      .orderBy(desc(s.jobs.createdAt));
    // Buildings this company manages or owns (management field, or an active owner/manager link).
    const managed = await tx
      .select()
      .from(s.properties)
      .where(
        and(
          isNull(s.properties.archivedAt),
          or(eq(s.properties.managementOrgId, id), sql`exists (select 1 from ${s.propertyRoles} r where r.property_id = ${col(s.properties.id)} and r.org_id = ${id} and r.active)`),
        ),
      )
      .orderBy(asc(s.properties.addressLine));
    const people = contacts.map((c) => c.id);
    const jobIds = jobs.map((j) => j.job.id);
    const activities = await tx
      .select()
      .from(s.activities)
      .where(or(people.length ? inArray(s.activities.contactId, people) : undefined, jobIds.length ? inArray(s.activities.jobId, jobIds) : undefined, sql`false`))
      .orderBy(desc(s.activities.occurredAt))
      .limit(100);
    // Owner only by RLS (a VA gets no rows): what this company has been billed and still owes.
    const [billing] = await tx
      .select({ billed: sql<string | null>`sum(${s.invoicesCache.amount})`, owed: sql<string | null>`sum(${s.invoicesCache.outstanding})`, n: sql<number>`count(*)::int` })
      .from(s.invoicesCache)
      .where(and(eq(s.invoicesCache.orgId, id), sql`coalesce(${s.invoicesCache.status}, '') not in ('draft', 'deleted', 'void')`));
    const stageName = await stageNamer(tx);
    const [sub] = org.type === "SUBCONTRACTOR" ? await tx.select().from(s.subProfiles).where(eq(s.subProfiles.orgId, id)) : [];
    return { org, contacts, jobs, managed, sub, activities, billing, stageName };
  });
  if (!data) notFound();
  const { org, contacts, jobs, managed, sub, activities, billing, stageName } = data;
  const isOwner = user.role === "OWNER";
  const coiDays = sub?.insuranceExpires ? daysUntil(sub.insuranceExpires, new Date()) : null;

  return (
    <>
      <PageHeader
        title={org.name}
        description={
          <>
            {label(ORG_TYPE_LABELS, org.type)}
            {isOwner && billing?.n ? (
              <span> · {billing.n} invoices, {usd(billing.billed)} billed{Number(billing.owed) > 0 ? <>, <span className="font-medium text-amber-700 dark:text-amber-400">{usd(billing.owed)} owed</span></> : ""}</span>
            ) : null}
          </>
        }
        actions={
          <>
            <Link href={`/contacts/new?orgId=${id}`} className={buttonVariants({ variant: "outline" })}>Add contact</Link>
            <Link href={`/jobs/new?clientOrgId=${id}`} className={buttonVariants()}>New job</Link>
          </>
        }
      />
      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader><CardTitle>Contacts</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            {contacts.length === 0 && <p className="text-muted-foreground">None yet.</p>}
            {contacts.map((c) => (
              <Link key={c.id} href={`/contacts/${c.id}`} className="block hover:underline">
                {personName(c)} {c.title && <span className="text-muted-foreground">· {c.title}</span>}
              </Link>
            ))}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Jobs <span className="text-sm font-normal text-muted-foreground">({jobs.length})</span></CardTitle></CardHeader>
          <CardContent className="max-h-96 space-y-2 overflow-y-auto text-sm">
            {jobs.length === 0 && <p className="text-muted-foreground">None yet.</p>}
            {jobs.map(({ job, address }) => (
              <Link key={job.id} href={`/jobs/${job.id}`} className="flex justify-between gap-2 hover:underline">
                <span>
                  <span className="font-mono text-xs">{job.jobNumber}</span> {label(SERVICE_LABELS, job.serviceCode)}{address ? ` · ${address}` : ""}
                  <span className="block text-xs text-muted-foreground">{fmtDate(job.deliveredAt ?? job.createdAt)}</span>
                </span>
                <Badge variant="secondary">{stageName(job)}</Badge>
              </Link>
            ))}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Buildings <span className="text-sm font-normal text-muted-foreground">({managed.length})</span></CardTitle></CardHeader>
          <CardContent className="max-h-96 space-y-2 overflow-y-auto text-sm">
            {managed.length === 0 && <p className="text-muted-foreground">None linked.</p>}
            {managed.map((p) => (
              <Link key={p.id} href={`/properties/${p.id}`} className="block hover:underline">{p.addressLine}, {p.borough}</Link>
            ))}
          </CardContent>
        </Card>
      </div>
      <Card className="mt-4">
        <CardHeader><CardTitle>History</CardTitle></CardHeader>
        <CardContent>
          <p className="mb-3 text-xs text-muted-foreground">Calls, texts, emails and job updates for this company&apos;s people and jobs. Latest 100.</p>
          <Timeline items={activities} viewerIsOwner={isOwner} />
        </CardContent>
      </Card>
      {org.type === "SUBCONTRACTOR" && (
        <Card className="mt-4 max-w-2xl">
          <CardHeader>
            <CardTitle>Subcontractor details</CardTitle>
          </CardHeader>
          <CardContent>
            {coiDays !== null && coiDays <= 60 && (
              <p className={`mb-3 text-sm ${coiDays < 0 ? "text-destructive" : "text-amber-700 dark:text-amber-400"}`}>
                {coiDays < 0 ? `Insurance expired ${fmtDate(sub!.insuranceExpires)} — get a current COI before assigning work.` : `Insurance expires in ${coiDays} days (${fmtDate(sub!.insuranceExpires)}).`}
              </p>
            )}
            <ActionForm action={saveSubProfile.bind(null, id)} className="grid gap-3 sm:grid-cols-2">
              <Field label="Trades" hint="Comma-separated, e.g. mold remediation, lead abatement">
                <Input name="trades" defaultValue={sub?.trades.join(", ") ?? ""} />
              </Field>
              <Field label="Insurance (COI) expires" hint="Alerts at 60 / 30 / 7 days and on expiry.">
                <Input name="insuranceExpires" type="date" defaultValue={sub?.insuranceExpires ?? ""} />
              </Field>
              <Field label="License numbers" hint="One per line — Name: number" className="sm:col-span-2">
                <Textarea name="licenseNumbers" rows={3} defaultValue={Object.entries(sub?.licenseNumbers ?? {}).map(([k, v]) => `${k}: ${v}`).join("\n")} />
              </Field>
              <Field label="Notes" className="sm:col-span-2">
                <Textarea name="notes" rows={2} defaultValue={sub?.notes ?? ""} />
              </Field>
              <div><SubmitButton size="sm">Save sub details</SubmitButton></div>
            </ActionForm>
          </CardContent>
        </Card>
      )}
      <Card className="mt-4 max-w-2xl">
        <CardHeader><CardTitle>Edit</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <ActionForm action={updateOrganization.bind(null, id)} className="space-y-4">
            <OrgFields org={org} />
            <SubmitButton size="sm">Save</SubmitButton>
          </ActionForm>
          <form action={archiveOrganization.bind(null, id)}>
            <ConfirmSubmit variant="destructive" size="sm" title="Archive this organization?" description="It disappears from lists and search. Its jobs, people and history stay." confirmLabel="Archive organization">Archive organization</ConfirmSubmit>
          </form>
        </CardContent>
      </Card>
    </>
  );
}
