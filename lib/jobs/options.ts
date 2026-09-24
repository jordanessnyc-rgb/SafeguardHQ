import { asc, isNull, isNotNull } from "drizzle-orm";
import { schema as s, type Tx } from "@/lib/db";
import { personName } from "@/lib/labels";
import type { JobOptions } from "@/app/(app)/jobs/job-fields";

/** Dropdown data for job forms. Fine at ESS's scale; swap for type-ahead search if lists grow past ~1k. */
export async function loadJobOptions(tx: Tx): Promise<JobOptions> {
  const [properties, orgs, contacts, staff] = await Promise.all([
    tx.select({ id: s.properties.id, a: s.properties.addressLine, u: s.properties.unit, b: s.properties.borough }).from(s.properties).where(isNull(s.properties.archivedAt)).orderBy(asc(s.properties.addressLine)).limit(2000),
    tx.select({ id: s.organizations.id, name: s.organizations.name, type: s.organizations.type }).from(s.organizations).where(isNull(s.organizations.archivedAt)).orderBy(asc(s.organizations.name)).limit(2000),
    tx.select({ id: s.contacts.id, firstName: s.contacts.firstName, lastName: s.contacts.lastName }).from(s.contacts).where(isNull(s.contacts.archivedAt)).orderBy(asc(s.contacts.lastName)).limit(2000),
    tx.select({ id: s.profiles.userId, fullName: s.profiles.fullName, email: s.profiles.email }).from(s.profiles).where(isNotNull(s.profiles.role)),
  ]);
  return {
    properties: properties.map((p) => ({ id: p.id, label: `${p.a}${p.u ? ` #${p.u}` : ""}${p.b ? `, ${p.b}` : ""}` })),
    orgs,
    contacts: contacts.map((c) => ({ id: c.id, label: personName(c) })),
    staff: staff.map((u) => ({ id: u.id, label: u.fullName ?? u.email })),
  };
}
