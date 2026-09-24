import Link from "next/link";
import { notFound } from "next/navigation";
import { and, asc, desc, eq, isNull, or } from "drizzle-orm";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ActionForm, SubmitButton } from "@/components/forms";
import { PageHeader } from "@/components/page-header";
import { Timeline } from "@/components/timeline";
import { requireStaff } from "@/lib/auth/session";
import { schema as s } from "@/lib/db";
import { label, personName, SERVICE_LABELS, titleCase } from "@/lib/labels";
import { formatPhone } from "@/lib/phone";
import { archiveContact, updateContact } from "../actions";
import { ContactFields } from "../contact-fields";

export default async function ContactPage({ params }: PageProps<"/contacts/[id]">) {
  const { id } = await params;
  const user = await requireStaff();
  const data = await user.db(async (tx) => {
    const [contact] = await tx.select().from(s.contacts).where(eq(s.contacts.id, id));
    if (!contact) return null;
    const [org] = contact.orgId ? await tx.select().from(s.organizations).where(eq(s.organizations.id, contact.orgId)) : [];
    const orgs = await tx.select({ id: s.organizations.id, name: s.organizations.name }).from(s.organizations).where(isNull(s.organizations.archivedAt)).orderBy(asc(s.organizations.name));
    const properties = await tx
      .select({ role: s.propertyRoles.role, p: s.properties })
      .from(s.propertyRoles)
      .innerJoin(s.properties, eq(s.properties.id, s.propertyRoles.propertyId))
      .where(and(eq(s.propertyRoles.contactId, id), eq(s.propertyRoles.active, true)));
    const jobs = await tx.select().from(s.jobs).where(and(eq(s.jobs.clientContactId, id), isNull(s.jobs.archivedAt))).orderBy(desc(s.jobs.createdAt));
    const activities = await tx
      .select()
      .from(s.activities)
      .where(or(eq(s.activities.contactId, id)))
      .orderBy(desc(s.activities.occurredAt))
      .limit(100);
    return { contact, org, orgs, properties, jobs, activities };
  });
  if (!data) notFound();
  const { contact: c, org, orgs, properties, jobs, activities } = data;

  return (
    <>
      <PageHeader
        title={<>{personName(c)} {c.doNotContact && <Badge variant="destructive">Do not contact</Badge>}</>}
        description={[c.title, org?.name].filter(Boolean).join(" · ") || undefined}
        actions={<Link href={`/jobs/new?clientContactId=${id}${c.orgId ? `&clientOrgId=${c.orgId}` : ""}`} className={buttonVariants()}>New job</Link>}
      />
      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader><CardTitle>Reach</CardTitle></CardHeader>
          <CardContent className="space-y-1 text-sm">
            {c.phones.map((p) => <div key={p}><a className="hover:underline" href={`tel:${p}`}>{formatPhone(p)}</a></div>)}
            {c.emails.map((e) => <div key={e}><a className="hover:underline" href={`mailto:${e}`}>{e}</a></div>)}
            {c.phones.length + c.emails.length === 0 && <p className="text-muted-foreground">No phone or email.</p>}
            {c.preferredChannel && <p className="pt-2 text-xs text-muted-foreground">Prefers {c.preferredChannel.toLowerCase()}</p>}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Properties</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            {properties.length === 0 && <p className="text-muted-foreground">Not linked to a property. Link from the property page.</p>}
            {properties.map(({ role, p }) => (
              <Link key={p.id} href={`/properties/${p.id}`} className="block hover:underline">
                <Badge variant="secondary">{titleCase(role)}</Badge> {p.addressLine}
              </Link>
            ))}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Jobs</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            {jobs.length === 0 && <p className="text-muted-foreground">None yet.</p>}
            {jobs.map((j) => (
              <Link key={j.id} href={`/jobs/${j.id}`} className="flex justify-between gap-2 hover:underline">
                <span><span className="font-mono text-xs">{j.jobNumber}</span> {label(SERVICE_LABELS, j.serviceCode)}</span>
                <Badge variant="secondary">{titleCase(j.stage)}</Badge>
              </Link>
            ))}
          </CardContent>
        </Card>
      </div>
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Timeline</CardTitle></CardHeader>
          <CardContent><Timeline items={activities} /></CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Edit</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <ActionForm action={updateContact.bind(null, id)} className="space-y-4">
              <ContactFields contact={c} orgs={orgs} />
              <SubmitButton size="sm">Save</SubmitButton>
            </ActionForm>
            <form action={archiveContact.bind(null, id)}>
              <Button type="submit" variant="destructive" size="sm">Archive contact</Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
