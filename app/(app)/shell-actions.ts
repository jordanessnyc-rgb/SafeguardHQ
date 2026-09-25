"use server";

import { and, desc, eq, ilike, isNull, or, sql } from "drizzle-orm";
import { requireStaff } from "@/lib/auth/session";
import { schema as s } from "@/lib/db";
import { label, personName, SERVICE_LABELS } from "@/lib/labels";

export type QuickHit = { kind: "Job" | "Property" | "Contact" | "Organization" | "AIRnyc case"; title: string; detail: string | null; href: string };

/**
 * ⌘K "jump to" search across records. Runs as the signed-in user, so RLS decides what comes back.
 * AIRnyc cases match on case ID only — member fields are encrypted and never searched.
 */
export async function quickSearch(query: string): Promise<QuickHit[]> {
  const user = await requireStaff();
  const q = query.trim().slice(0, 100);
  if (q.length < 2) return [];
  const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  return user.db(async (tx) => {
    const jobs = await tx
      .select({ id: s.jobs.id, num: s.jobs.jobNumber, service: s.jobs.serviceCode, address: s.properties.addressLine })
      .from(s.jobs)
      .leftJoin(s.properties, eq(s.properties.id, s.jobs.propertyId))
      .where(and(isNull(s.jobs.archivedAt), or(ilike(s.jobs.jobNumber, like), ilike(s.jobs.title, like), ilike(s.properties.addressLine, like))))
      .orderBy(desc(s.jobs.createdAt))
      .limit(6);
    const properties = await tx
      .select({ id: s.properties.id, address: s.properties.addressLine, unit: s.properties.unit, borough: s.properties.borough })
      .from(s.properties)
      .where(and(isNull(s.properties.archivedAt), or(ilike(s.properties.addressLine, like), ilike(s.properties.ownerName, like))))
      .limit(4);
    const contacts = await tx
      .select({ id: s.contacts.id, firstName: s.contacts.firstName, lastName: s.contacts.lastName, org: s.organizations.name })
      .from(s.contacts)
      .leftJoin(s.organizations, eq(s.organizations.id, s.contacts.orgId))
      .where(
        and(
          isNull(s.contacts.archivedAt),
          or(
            ilike(sql`coalesce(${s.contacts.firstName}, '') || ' ' || coalesce(${s.contacts.lastName}, '')`, like),
            sql`exists (select 1 from unnest(${s.contacts.emails}) e where e ilike ${like})`,
          ),
        ),
      )
      .limit(4);
    const orgs = await tx
      .select({ id: s.organizations.id, name: s.organizations.name, type: s.organizations.type })
      .from(s.organizations)
      .where(and(isNull(s.organizations.archivedAt), ilike(s.organizations.name, like)))
      .limit(4);
    const cases = await tx
      .select({ id: s.airnycCases.id, caseId: s.airnycCases.caseId, stage: s.airnycCases.stage })
      .from(s.airnycCases)
      .where(and(isNull(s.airnycCases.archivedAt), ilike(s.airnycCases.caseId, like)))
      .limit(3);
    return [
      ...jobs.map((j): QuickHit => ({ kind: "Job", title: `${j.num} · ${label(SERVICE_LABELS, j.service)}`, detail: j.address, href: `/jobs/${j.id}` })),
      ...properties.map((p): QuickHit => ({ kind: "Property", title: `${p.address}${p.unit ? ` #${p.unit}` : ""}`, detail: p.borough, href: `/properties/${p.id}` })),
      ...contacts.map((c): QuickHit => ({ kind: "Contact", title: personName(c), detail: c.org, href: `/contacts/${c.id}` })),
      ...orgs.map((o): QuickHit => ({ kind: "Organization", title: o.name, detail: null, href: `/organizations/${o.id}` })),
      ...cases.map((c): QuickHit => ({ kind: "AIRnyc case", title: c.caseId, detail: null, href: `/airnyc/${c.id}` })),
    ];
  });
}
