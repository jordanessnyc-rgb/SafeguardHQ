import { asc, eq, isNull, isNotNull, sql } from "drizzle-orm";
import { schema as s, type Tx } from "@/lib/db";
import { formatPhone } from "@/lib/phone";
import { personName } from "@/lib/labels";
import type { JobOptions } from "@/app/(app)/jobs/job-fields";

/**
 * Picker data for job forms (type-to-search, so the full lists are fine at ESS's scale). Each building
 * carries its owner/manager companies so picking one can fill in the client. Queries run one after
 * another: they share the request's transaction.
 */
export async function loadJobOptions(tx: Tx): Promise<JobOptions> {
  const buildingOrgs = sql<string[]>`coalesce((select array_agg(r.org_id order by (r.role = 'MANAGER') desc, r.created_at) from ${s.propertyRoles} r where r.property_id = ${s.properties.id} and r.active and r.org_id is not null and r.role in ('OWNER','MANAGER')), '{}')`;
  const properties = await tx
    .select({ id: s.properties.id, a: s.properties.addressLine, u: s.properties.unit, b: s.properties.borough, zip: s.properties.zip, orgIds: buildingOrgs })
    .from(s.properties)
    .where(isNull(s.properties.archivedAt))
    .orderBy(asc(s.properties.addressLine))
    .limit(5000);
  const orgs = await tx.select({ id: s.organizations.id, name: s.organizations.name, type: s.organizations.type }).from(s.organizations).where(isNull(s.organizations.archivedAt)).orderBy(asc(s.organizations.name)).limit(5000);
  const contacts = await tx
    .select({ id: s.contacts.id, firstName: s.contacts.firstName, lastName: s.contacts.lastName, orgId: s.contacts.orgId, orgName: s.organizations.name, emails: s.contacts.emails, phones: s.contacts.phones })
    .from(s.contacts)
    .leftJoin(s.organizations, eq(s.organizations.id, s.contacts.orgId))
    .where(isNull(s.contacts.archivedAt))
    .orderBy(asc(s.contacts.lastName), asc(s.contacts.firstName))
    .limit(5000);
  const staff = await tx.select({ id: s.profiles.userId, fullName: s.profiles.fullName, email: s.profiles.email }).from(s.profiles).where(isNotNull(s.profiles.role));
  return {
    properties: properties.map((p) => ({ id: p.id, label: `${p.a}${p.u ? ` #${p.u}` : ""}${p.b ? `, ${p.b}` : ""}`, detail: p.zip, orgIds: p.orgIds ?? [] })),
    orgs,
    contacts: contacts.map((c) => ({
      id: c.id,
      label: personName(c),
      orgId: c.orgId,
      detail: [c.orgName, c.emails[0] ?? (c.phones[0] ? formatPhone(c.phones[0]) : null)].filter(Boolean).join(" · ") || null,
    })),
    staff: staff.map((u) => ({ id: u.id, label: u.fullName ?? u.email })),
  };
}
