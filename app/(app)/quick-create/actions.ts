"use server";

/**
 * "+ Add new" from inside a picker (job form, property people): creates the record without leaving the
 * form and returns what the picker needs to select it. Same rules as the full create pages: staff only,
 * RLS applies, a building already on file (same BBL + unit) is reused instead of duplicated.
 */
import { after } from "next/server";
import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { schema as s } from "@/lib/db";
import { requireStaff } from "@/lib/auth/session";
import { optionalUuid, safeAction } from "@/lib/actions";
import { personName } from "@/lib/labels";
import { normalizeBbl } from "@/lib/integrations/nyc-open-data";
import { enrichProperty } from "@/lib/properties/enrich";
import { formatPhone, toE164 } from "@/lib/phone";

export type Created = { id: string; label: string; detail?: string | null; orgId?: string | null };
type Result = { ok?: boolean; error?: string; created?: Created };

const blank = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : typeof v === "string" ? v.trim() : v);

const orgInput = z.object({
  name: z.preprocess(blank, z.string().min(1, "Enter a name").max(200)),
  type: z.enum(s.orgTypeEnum.enumValues).default("OWNER"),
  email: z.preprocess(blank, z.email("That email doesn't look right").optional()),
  phone: z.preprocess(blank, z.string().optional()),
});

export async function quickCreateOrganization(input: z.input<typeof orgInput>): Promise<Result> {
  const user = await requireStaff();
  let created: Created | undefined;
  const res = await safeAction(async () => {
    const v = orgInput.parse(input);
    const [row] = await user.db((tx) =>
      tx
        .insert(s.organizations)
        .values({ name: v.name, type: v.type, email: v.email, phone: v.phone ? (toE164(v.phone) ?? v.phone) : undefined })
        .returning({ id: s.organizations.id, name: s.organizations.name }),
    );
    created = { id: row.id, label: row.name };
  });
  return res.error ? res : { ok: true, created };
}

const contactInput = z
  .object({
    firstName: z.preprocess(blank, z.string().max(100).optional()),
    lastName: z.preprocess(blank, z.string().max(100).optional()),
    email: z.preprocess(blank, z.email("That email doesn't look right").optional()),
    phone: z.preprocess(blank, z.string().optional()),
    orgId: z.preprocess(blank, optionalUuid),
  })
  .refine((v) => v.firstName || v.lastName, "Enter a first or last name");

export async function quickCreateContact(input: z.input<typeof contactInput>): Promise<Result> {
  const user = await requireStaff();
  let created: Created | undefined;
  const res = await safeAction(async () => {
    const v = contactInput.parse(input);
    const phone = v.phone ? toE164(v.phone) : null;
    if (v.phone && !phone) return { error: `"${v.phone}" isn't a valid phone number` };
    const [row] = await user.db((tx) =>
      tx
        .insert(s.contacts)
        .values({ firstName: v.firstName, lastName: v.lastName, orgId: v.orgId ?? null, emails: v.email ? [v.email] : [], phones: phone ? [phone] : [], source: "MANUAL", brand: "ESS" })
        .returning(),
    );
    created = { id: row.id, label: personName(row), detail: row.emails[0] ?? (row.phones[0] ? formatPhone(row.phones[0]) : null), orgId: row.orgId };
  });
  return res.error ? res : { ok: true, created };
}

const propertyInput = z.object({
  addressLine: z.preprocess(blank, z.string().min(3, "Enter the street address")),
  unit: z.preprocess(blank, z.string().max(40).optional()),
  borough: z.preprocess(blank, z.string().optional()),
  zip: z.preprocess(blank, z.string().max(10).optional()),
  bbl: z.preprocess(blank, z.string().optional()),
  bin: z.preprocess(blank, z.string().optional()),
  lat: z.number().nullable().optional(),
  lng: z.number().nullable().optional(),
});

export async function quickCreateProperty(input: z.input<typeof propertyInput>): Promise<Result> {
  const user = await requireStaff();
  let created: Created | undefined;
  const res = await safeAction(async () => {
    const v = propertyInput.parse(input);
    const bbl = normalizeBbl(v.bbl);
    const label = `${v.addressLine}${v.unit ? ` #${v.unit}` : ""}${v.borough ? `, ${v.borough}` : ""}`;
    const id = await user.db(async (tx) => {
      if (bbl) {
        const [dupe] = await tx
          .select({ id: s.properties.id })
          .from(s.properties)
          .where(and(eq(s.properties.bbl, bbl), sql`coalesce(${s.properties.unit}, '') = ${v.unit ?? ""}`, isNull(s.properties.archivedAt)));
        if (dupe) return dupe.id;
      }
      const [row] = await tx
        .insert(s.properties)
        .values({ addressLine: v.addressLine, unit: v.unit, borough: v.borough, zip: v.zip, bbl, bin: v.bin || null, lat: v.lat?.toString(), lng: v.lng?.toString() })
        .returning({ id: s.properties.id });
      return row.id;
    });
    // Building data (violations, owner) loads after the response, so the form doesn't wait on the city's APIs.
    after(() => user.db((tx) => enrichProperty(tx, id)).catch((e) => console.error("enrichment failed", e)));
    created = { id, label };
  });
  return res.error ? res : { ok: true, created };
}
