/**
 * Pull NYC Open Data for a property and cache it (SPEC §6.5). Works with a user-scoped transaction
 * (UI "Refresh") or the admin connection (worker's nightly run).
 */
import { and, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import * as s from "@/db/schema";
import type { Db, Tx } from "@/lib/db";
import { fetchPropertyData, type EnrichmentResult } from "@/lib/integrations/nyc-open-data";

type Conn = Db | Tx;

export type EnrichOutcome = {
  status: "OK" | "PARTIAL" | "FAILED";
  violationCount: number;
  openCount: number;
  newOpenViolations: number;
  tasksCreated: number;
  errors: string[];
};

export async function enrichProperty(
  conn: Conn,
  propertyId: string,
  fetchData: (ids: { bbl: string | null; bin: string | null }) => Promise<EnrichmentResult> = fetchPropertyData,
): Promise<EnrichOutcome> {
  const [property] = await conn.select().from(s.properties).where(eq(s.properties.id, propertyId));
  if (!property) throw new Error(`Property ${propertyId} not found`);

  const firstRun = property.enrichedAt === null;
  const data = await fetchData({ bbl: property.bbl, bin: property.bin });
  const gotAnything = data.facts || data.registration || data.violations.length > 0;
  const status = data.errors.length === 0 ? "OK" : gotAnything ? "PARTIAL" : "FAILED";

  // Violations we already know about (to detect new ones).
  const existing = await conn
    .select({ source: s.propertyViolations.source, violationId: s.propertyViolations.violationId })
    .from(s.propertyViolations)
    .where(eq(s.propertyViolations.propertyId, propertyId));
  const known = new Set(existing.map((v) => `${v.source}:${v.violationId}`));
  const newOpen = data.violations.filter((v) => v.isOpen && !known.has(`${v.source}:${v.violationId}`));

  const now = new Date();
  for (let i = 0; i < data.violations.length; i += 500) {
    const chunk = data.violations.slice(i, i + 500);
    await conn
      .insert(s.propertyViolations)
      .values(chunk.map((v) => ({ propertyId, ...v, lastSeenAt: now })))
      .onConflictDoUpdate({
        target: [s.propertyViolations.propertyId, s.propertyViolations.source, s.propertyViolations.violationId],
        set: {
          class: sql`excluded.class`,
          orderNumber: sql`excluded.order_number`,
          status: sql`excluded.status`,
          isOpen: sql`excluded.is_open`,
          issuedDate: sql`excluded.issued_date`,
          description: sql`excluded.description`,
          raw: sql`excluded.raw`,
          lastSeenAt: now,
          updatedAt: now,
        },
      });
  }

  await conn
    .update(s.properties)
    .set({
      ...(data.facts
        ? {
            buildingClass: data.facts.buildingClass,
            unitsRes: data.facts.unitsRes,
            yearBuilt: data.facts.yearBuilt,
            ownerName: data.facts.ownerName,
            // Only ever raise the NYCHA flag automatically; a human can clear it.
            ...(data.facts.isNycha ? { isNycha: true } : {}),
          }
        : {}),
      ...(data.registration
        ? { hpdRegistrationId: data.registration.registrationId, hpdRegistrationContacts: data.registration }
        : {}),
      enrichmentStatus: status,
      enrichmentError: data.errors.join("\n") || null,
      enrichedAt: status === "FAILED" ? property.enrichedAt : now,
    })
    .where(eq(s.properties.id, propertyId));

  // New open violation on a property we have an active relationship with → outreach task.
  let tasksCreated = 0;
  if (!firstRun && newOpen.length > 0 && (await hasActiveRelationship(conn, propertyId))) {
    const bySource = Object.entries(
      newOpen.reduce<Record<string, number>>((acc, v) => ({ ...acc, [v.source]: (acc[v.source] ?? 0) + 1 }), {}),
    )
      .map(([src, n]) => `${n} ${src}`)
      .join(", ");
    await conn.insert(s.tasks).values({
      title: `New violations at ${property.addressLine}: ${bySource} — draft outreach`,
      description: newOpen
        .slice(0, 20)
        .map((v) => `• [${v.source}${v.class ? ` class ${v.class}` : ""}] ${v.issuedDate ?? ""} ${v.description ?? ""}`)
        .join("\n"),
      source: "SYSTEM_RULE",
      propertyId,
      dueAt: new Date(now.getTime() + 86_400_000),
    });
    tasksCreated = 1;
  }

  return {
    status,
    violationCount: data.violations.length,
    openCount: data.violations.filter((v) => v.isOpen).length,
    newOpenViolations: firstRun ? 0 : newOpen.length,
    tasksCreated,
    errors: data.errors,
  };
}

/**
 * "Active relationship" = any non-archived job that wasn't Lost (past clients are the best outreach
 * targets), or an active OWNER/MANAGER contact on the property. See docs/DECISIONS.md.
 */
async function hasActiveRelationship(conn: Conn, propertyId: string): Promise<boolean> {
  const [job] = await conn
    .select({ id: s.jobs.id })
    .from(s.jobs)
    .where(and(eq(s.jobs.propertyId, propertyId), isNull(s.jobs.archivedAt), notInArray(s.jobs.stage, ["LOST"])))
    .limit(1);
  if (job) return true;
  const [role] = await conn
    .select({ id: s.propertyRoles.id })
    .from(s.propertyRoles)
    .where(
      and(
        eq(s.propertyRoles.propertyId, propertyId),
        eq(s.propertyRoles.active, true),
        inArray(s.propertyRoles.role, ["OWNER", "MANAGER"]),
      ),
    )
    .limit(1);
  return Boolean(role);
}
