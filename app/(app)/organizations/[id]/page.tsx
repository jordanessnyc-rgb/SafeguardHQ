import Link from "next/link";
import { notFound } from "next/navigation";
import { and, desc, eq, isNull } from "drizzle-orm";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ActionForm, Field, SubmitButton } from "@/components/forms";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { daysUntil } from "@/lib/compliance/expiry";
import { PageHeader } from "@/components/page-header";
import { requireStaff } from "@/lib/auth/session";
import { schema as s } from "@/lib/db";
import { fmtDate, label, ORG_TYPE_LABELS, personName, SERVICE_LABELS, titleCase } from "@/lib/labels";
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
    const managed = await tx.select().from(s.properties).where(and(eq(s.properties.managementOrgId, id), isNull(s.properties.archivedAt)));
    const [sub] = org.type === "SUBCONTRACTOR" ? await tx.select().from(s.subProfiles).where(eq(s.subProfiles.orgId, id)) : [];
    return { org, contacts, jobs, managed, sub };
  });
  if (!data) notFound();
  const { org, contacts, jobs, managed, sub } = data;
  const coiDays = sub?.insuranceExpires ? daysUntil(sub.insuranceExpires, new Date()) : null;

  return (
    <>
      <PageHeader
        title={org.name}
        description={label(ORG_TYPE_LABELS, org.type)}
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
          <CardHeader><CardTitle>Jobs</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            {jobs.length === 0 && <p className="text-muted-foreground">None yet.</p>}
            {jobs.map(({ job, address }) => (
              <Link key={job.id} href={`/jobs/${job.id}`} className="flex justify-between gap-2 hover:underline">
                <span><span className="font-mono text-xs">{job.jobNumber}</span> {label(SERVICE_LABELS, job.serviceCode)}{address ? ` · ${address}` : ""}</span>
                <Badge variant="secondary">{titleCase(job.stage)}</Badge>
              </Link>
            ))}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Buildings managed</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            {managed.length === 0 && <p className="text-muted-foreground">None linked.</p>}
            {managed.map((p) => (
              <Link key={p.id} href={`/properties/${p.id}`} className="block hover:underline">{p.addressLine}, {p.borough}</Link>
            ))}
          </CardContent>
        </Card>
      </div>
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
            <Button type="submit" variant="destructive" size="sm">Archive organization</Button>
          </form>
        </CardContent>
      </Card>
    </>
  );
}
