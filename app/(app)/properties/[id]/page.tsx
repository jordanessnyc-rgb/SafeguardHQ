import Link from "next/link";
import { notFound } from "next/navigation";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { NativeSelect } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ActionForm, Field, SubmitButton } from "@/components/forms";
import { EmptyState, PageHeader } from "@/components/page-header";
import { requireStaff } from "@/lib/auth/session";
import { schema as s } from "@/lib/db";
import { fmtDate, label, personName, SERVICE_LABELS, titleCase } from "@/lib/labels";
import type { HpdRegistration } from "@/lib/integrations/nyc-open-data";
import { addPropertyRole, deactivatePropertyRole, refreshProperty, updateProperty } from "../actions";

export default async function PropertyPage({ params, searchParams }: PageProps<"/properties/[id]">) {
  const { id } = await params;
  const sp = await searchParams;
  const showAll = sp.violations === "all";
  const source = typeof sp.source === "string" ? sp.source : undefined;
  const user = await requireStaff();

  const data = await user.db(async (tx) => {
    const [property] = await tx.select().from(s.properties).where(eq(s.properties.id, id));
    if (!property) return null;
    const violations = await tx
      .select()
      .from(s.propertyViolations)
      .where(
        and(
          eq(s.propertyViolations.propertyId, id),
          showAll ? undefined : eq(s.propertyViolations.isOpen, true),
          source ? eq(s.propertyViolations.source, source as "HPD") : undefined,
        ),
      )
      .orderBy(sql`${s.propertyViolations.issuedDate} desc nulls last`)
      .limit(500);
    const counts = await tx
      .select({ source: s.propertyViolations.source, open: sql<number>`count(*) filter (where is_open)::int`, total: sql<number>`count(*)::int` })
      .from(s.propertyViolations)
      .where(eq(s.propertyViolations.propertyId, id))
      .groupBy(s.propertyViolations.source);
    const jobs = await tx
      .select()
      .from(s.jobs)
      .where(and(eq(s.jobs.propertyId, id), isNull(s.jobs.archivedAt)))
      .orderBy(desc(s.jobs.createdAt));
    const roles = await tx
      .select({ role: s.propertyRoles, contact: s.contacts, org: s.organizations })
      .from(s.propertyRoles)
      .leftJoin(s.contacts, eq(s.contacts.id, s.propertyRoles.contactId))
      .leftJoin(s.organizations, eq(s.organizations.id, s.propertyRoles.orgId))
      .where(and(eq(s.propertyRoles.propertyId, id), eq(s.propertyRoles.active, true)));
    const orgs = await tx.select({ id: s.organizations.id, name: s.organizations.name }).from(s.organizations).where(isNull(s.organizations.archivedAt)).orderBy(asc(s.organizations.name));
    const contacts = await tx.select({ id: s.contacts.id, firstName: s.contacts.firstName, lastName: s.contacts.lastName }).from(s.contacts).where(isNull(s.contacts.archivedAt)).orderBy(asc(s.contacts.lastName)).limit(500);
    return { property, violations, counts, jobs, roles, orgs, contacts };
  });
  if (!data) notFound();
  const { property: p, violations, counts, jobs, roles, orgs, contacts } = data;
  const reg = p.hpdRegistrationContacts as HpdRegistration | null;
  const totalOpen = counts.reduce((n, c) => n + c.open, 0);

  const vHref = (o: { all?: boolean; source?: string }) => {
    const q = new URLSearchParams();
    if (o.all ?? showAll) q.set("violations", "all");
    if (o.source) q.set("source", o.source);
    return `/properties/${id}?${q}#violations`;
  };

  return (
    <>
      <PageHeader
        title={
          <>
            {p.addressLine}
            {p.unit ? `, #${p.unit}` : ""}
          </>
        }
        description={
          <span className="flex flex-wrap items-center gap-2">
            {p.borough} {p.zip}
            <span className="font-mono text-xs">BBL {p.bbl ?? "unresolved"} · BIN {p.bin ?? "—"}</span>
            {p.isNycha && <Badge variant="destructive">NYCHA — landlord consent risk</Badge>}
          </span>
        }
        actions={
          <>
            <ActionForm action={refreshProperty.bind(null, id)} className="flex flex-col items-end gap-1">
              <SubmitButton variant="outline">Refresh NYC data</SubmitButton>
            </ActionForm>
            <Link href={`/jobs/new?propertyId=${id}`} className={buttonVariants()}>
              New job here
            </Link>
          </>
        }
      />

      {p.enrichmentStatus !== "OK" && (
        <p className="mb-4 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          NYC data {p.enrichmentStatus === "PENDING" ? "hasn't been pulled yet" : `is ${p.enrichmentStatus.toLowerCase()}`}.
          {p.enrichmentError && <span className="block whitespace-pre-line text-xs">{p.enrichmentError}</span>}
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>Building</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            <Fact k="Owner (PLUTO)" v={p.ownerName} />
            <Fact k="Building class" v={p.buildingClass} />
            <Fact k="Residential units" v={p.unitsRes} />
            <Fact k="Year built" v={p.yearBuilt} />
            <Fact k="HPD registration" v={p.hpdRegistrationId} />
            <Fact k="Data pulled" v={fmtDate(p.enrichedAt, true)} />
            {p.bbl && (
              <div className="flex flex-wrap gap-3 pt-2 text-xs">
                <a className="inline-flex items-center gap-1 text-primary hover:underline" target="_blank" rel="noreferrer" href={`https://hpdonline.nyc.gov/hpdonline/building/search-results?boroId=${p.bbl[0]}&block=${Number(p.bbl.slice(1, 6))}&lot=${Number(p.bbl.slice(6))}`}>
                  HPD Online <ExternalLink className="size-3" />
                </a>
                {p.bin && (
                  <a className="inline-flex items-center gap-1 text-primary hover:underline" target="_blank" rel="noreferrer" href={`https://a810-bisweb.nyc.gov/bisweb/PropertyProfileOverviewServlet?bin=${p.bin}`}>
                    DOB BIS <ExternalLink className="size-3" />
                  </a>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>HPD registration contacts</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {!reg?.contacts?.length && <p className="text-muted-foreground">None on file.</p>}
            {reg?.contacts?.map((c, i) => (
              <div key={i}>
                <div className="text-xs text-muted-foreground">{titleCase(c.type.replace(/([a-z])([A-Z])/g, "$1_$2"))}</div>
                <div>{[c.corporationName, c.name].filter(Boolean).join(" — ")}</div>
                {c.businessAddress && <div className="text-xs text-muted-foreground">{c.businessAddress}</div>}
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>People &amp; companies</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {roles.length === 0 && <p className="text-muted-foreground">No contacts linked.</p>}
            {roles.map(({ role, contact, org }) => (
              <div key={role.id} className="flex items-start justify-between gap-2">
                <div>
                  <Badge variant="secondary">{titleCase(role.role)}</Badge>{" "}
                  {contact && <Link className="hover:underline" href={`/contacts/${contact.id}`}>{personName(contact)}</Link>}
                  {org && <Link className="hover:underline" href={`/organizations/${org.id}`}>{contact ? ` (${org.name})` : org.name}</Link>}
                </div>
                <form action={deactivatePropertyRole.bind(null, id, role.id)}>
                  <Button size="xs" variant="ghost" type="submit">Remove</Button>
                </form>
              </div>
            ))}
            <ActionForm action={addPropertyRole.bind(null, id)} className="grid gap-2 border-t pt-3">
              <NativeSelect name="role" defaultValue="MANAGER" aria-label="Role">
                {["OWNER", "MANAGER", "TENANT", "SUPER", "BROKER"].map((r) => <option key={r} value={r}>{titleCase(r)}</option>)}
              </NativeSelect>
              <NativeSelect name="contactId" defaultValue="" aria-label="Contact">
                <option value="">— contact —</option>
                {contacts.map((c) => <option key={c.id} value={c.id}>{personName(c)}</option>)}
              </NativeSelect>
              <NativeSelect name="orgId" defaultValue="" aria-label="Organization">
                <option value="">— organization —</option>
                {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
              </NativeSelect>
              <SubmitButton size="sm" variant="secondary">Link</SubmitButton>
            </ActionForm>
          </CardContent>
        </Card>
      </div>

      <section id="violations" className="mt-6">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-semibold">
            Violations <span className="text-sm font-normal text-muted-foreground">({totalOpen} open)</span>
          </h2>
          <div className="flex flex-wrap gap-1 text-xs">
            <Link href={vHref({ all: false, source })} className={buttonVariants({ size: "xs", variant: showAll ? "ghost" : "secondary" })}>Open</Link>
            <Link href={vHref({ all: true, source })} className={buttonVariants({ size: "xs", variant: showAll ? "secondary" : "ghost" })}>All</Link>
            <span className="mx-1 border-l" />
            <Link href={vHref({})} className={buttonVariants({ size: "xs", variant: source ? "ghost" : "secondary" })}>Every source</Link>
            {(["HPD", "DOB", "ECB"] as const).map((src) => {
              const c = counts.find((x) => x.source === src);
              return (
                <Link key={src} href={vHref({ source: src })} className={buttonVariants({ size: "xs", variant: source === src ? "secondary" : "ghost" })}>
                  {src} {c ? `${c.open}/${c.total}` : "0"}
                </Link>
              );
            })}
          </div>
        </div>
        {violations.length === 0 ? (
          <EmptyState>{showAll ? "No violations on record." : "No open violations."}</EmptyState>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Source</TableHead>
                <TableHead>Issued</TableHead>
                <TableHead>Class</TableHead>
                <TableHead className="w-1/2">Description</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {violations.map((v) => (
                <TableRow key={v.id}>
                  <TableCell>
                    <Badge variant={v.isOpen ? "default" : "outline"}>{v.source}</Badge>
                    <div className="font-mono text-[10px] text-muted-foreground">{v.violationId}</div>
                  </TableCell>
                  <TableCell className="whitespace-nowrap">{fmtDate(v.issuedDate)}</TableCell>
                  <TableCell>{v.class ?? "—"}{v.orderNumber ? <div className="text-[10px] text-muted-foreground">Order {v.orderNumber}</div> : null}</TableCell>
                  <TableCell className="min-w-64 text-xs whitespace-normal">{v.description}</TableCell>
                  <TableCell className="text-xs whitespace-normal">{v.status}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Jobs</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {jobs.length === 0 && <p className="text-muted-foreground">No jobs at this property yet.</p>}
            {jobs.map((j) => (
              <Link key={j.id} href={`/jobs/${j.id}`} className="flex justify-between gap-2 rounded-md border p-2 hover:bg-muted">
                <span>
                  <span className="font-mono text-xs">{j.jobNumber}</span> · {label(SERVICE_LABELS, j.serviceCode)}
                </span>
                <Badge variant="secondary">{titleCase(j.stage)}</Badge>
              </Link>
            ))}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Details</CardTitle>
          </CardHeader>
          <CardContent>
            <ActionForm action={updateProperty.bind(null, id)} className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Unit">
                  <Input name="unit" defaultValue={p.unit ?? ""} />
                </Field>
                <Field label="Management company">
                  <NativeSelect name="managementOrgId" defaultValue={p.managementOrgId ?? ""}>
                    <option value="">—</option>
                    {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                  </NativeSelect>
                </Field>
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="isNycha" defaultChecked={p.isNycha} className="size-4 accent-primary" /> NYCHA building (landlord-consent risk)
              </label>
              <Field label="Notes">
                <Textarea name="notes" defaultValue={p.notes ?? ""} rows={3} />
              </Field>
              <SubmitButton size="sm">Save</SubmitButton>
            </ActionForm>
          </CardContent>
        </Card>
      </div>
    </>
  );
}

function Fact({ k, v }: { k: string; v: string | number | null | undefined }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-muted-foreground">{k}</span>
      <span className="text-right">{v ?? "—"}</span>
    </div>
  );
}
