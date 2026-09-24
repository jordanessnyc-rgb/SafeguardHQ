"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { schema as s } from "@/lib/db";
import { requireStaff } from "@/lib/auth/session";
import { checkbox, formObject, optionalUuid, safeAction, type ActionState } from "@/lib/actions";
import { geosearch, normalizeBbl, type AddressCandidate } from "@/lib/integrations/nyc-open-data";
import { enrichProperty } from "@/lib/properties/enrich";

export async function searchAddress(query: string): Promise<{ candidates: Omit<AddressCandidate, "raw">[]; error?: string }> {
  await requireStaff();
  try {
    const found = await geosearch(query, { size: 6 });
    return { candidates: found.map(({ raw: _raw, ...c }) => c) };
  } catch (e) {
    return { candidates: [], error: `Address lookup failed: ${(e as Error).message}. You can still save it unresolved.` };
  }
}

const createSchema = z.object({
  addressLine: z.string().min(3, "Address is required"),
  unit: z.string().max(40).optional(),
  borough: z.string().optional(),
  zip: z.string().max(10).optional(),
  bbl: z.string().optional(),
  bin: z.string().optional(),
  lat: z.coerce.number().optional(),
  lng: z.coerce.number().optional(),
});

export async function createProperty(_prev: ActionState, form: FormData): Promise<ActionState> {
  const user = await requireStaff();
  let id: string | undefined;
  const res = await safeAction(async () => {
    const input = createSchema.parse(formObject(form));
    const bbl = normalizeBbl(input.bbl);
    id = await user.db(async (tx) => {
      if (bbl) {
        const [dupe] = await tx
          .select({ id: s.properties.id })
          .from(s.properties)
          .where(
            and(
              eq(s.properties.bbl, bbl),
              sql`coalesce(${s.properties.unit}, '') = ${input.unit ?? ""}`,
              isNull(s.properties.archivedAt),
            ),
          );
        if (dupe) return dupe.id; // already on file → go to it
      }
      const [row] = await tx
        .insert(s.properties)
        .values({
          addressLine: input.addressLine,
          unit: input.unit,
          borough: input.borough,
          zip: input.zip,
          bbl,
          bin: input.bin || null,
          lat: input.lat?.toString(),
          lng: input.lng?.toString(),
        })
        .returning({ id: s.properties.id });
      return row.id;
    });
    // Enrich right away so violations show on first view; failures are recorded, not fatal.
    await user.db((tx) => enrichProperty(tx, id!)).catch((e) => console.error("enrichment failed", e));
  });
  if (res.error || !id) return res;
  redirect(`/properties/${id}`);
}

export async function refreshProperty(id: string): Promise<ActionState> {
  const user = await requireStaff();
  const res = await safeAction(async () => {
    const out = await user.db((tx) => enrichProperty(tx, id));
    const msg =
      out.status === "FAILED"
        ? `Refresh failed: ${out.errors.join("; ")}`
        : `Refreshed: ${out.violationCount} violations (${out.openCount} open)` +
          (out.newOpenViolations ? `, ${out.newOpenViolations} new` : "") +
          (out.errors.length ? `. Partial: ${out.errors.join("; ")}` : "");
    return out.status === "FAILED" ? { error: msg } : { ok: true, message: msg };
  });
  revalidatePath(`/properties/${id}`);
  return res;
}

const updateSchema = z.object({
  unit: z.string().max(40).optional(),
  managementOrgId: optionalUuid,
  isNycha: checkbox,
  notes: z.string().max(5000).optional(),
});

export async function updateProperty(id: string, _prev: ActionState, form: FormData): Promise<ActionState> {
  const user = await requireStaff();
  const res = await safeAction(async () => {
    const input = updateSchema.parse({ ...formObject(form), isNycha: form.get("isNycha") });
    await user.db((tx) =>
      tx
        .update(s.properties)
        .set({ unit: input.unit ?? null, managementOrgId: input.managementOrgId ?? null, isNycha: input.isNycha, notes: input.notes ?? null })
        .where(eq(s.properties.id, id)),
    );
    return { ok: true, message: "Saved." };
  });
  revalidatePath(`/properties/${id}`);
  return res;
}

const roleSchema = z
  .object({
    role: z.enum(["OWNER", "MANAGER", "TENANT", "SUPER", "BROKER"]),
    contactId: optionalUuid,
    orgId: optionalUuid,
  })
  .refine((v) => v.contactId || v.orgId, "Pick a contact or an organization");

export async function addPropertyRole(propertyId: string, _prev: ActionState, form: FormData): Promise<ActionState> {
  const user = await requireStaff();
  const res = await safeAction(async () => {
    const input = roleSchema.parse(formObject(form));
    await user.db((tx) => tx.insert(s.propertyRoles).values({ propertyId, ...input }));
  });
  revalidatePath(`/properties/${propertyId}`);
  return res;
}

export async function deactivatePropertyRole(propertyId: string, roleId: string) {
  const user = await requireStaff();
  await user.db((tx) => tx.update(s.propertyRoles).set({ active: false }).where(eq(s.propertyRoles.id, roleId)));
  revalidatePath(`/properties/${propertyId}`);
}
