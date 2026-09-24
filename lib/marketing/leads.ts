/**
 * Web form leads (SPEC §11): ess-nyc.com form → contact + property + Lead job + task + a DRAFT
 * acknowledgment text (sent only if auto_send_sms is on — CLAUDE.md rule 6), with first-touch
 * campaign attribution from the landing page's ?utm_campaign / QR slug.
 */
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { schema as s, type Db } from "@/lib/db";
import { createDraft } from "@/lib/comms/outbound";
import { findContactByPhone } from "@/lib/comms/contacts";
import { BRAND_INFO, renderTemplate } from "@/lib/comms/templates";
import { geosearch, normalizeBbl, type Fetch } from "@/lib/integrations/nyc-open-data";
import { toE164 } from "@/lib/phone";

export const WebLeadSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    email: z.email().max(200).optional().or(z.literal("").transform(() => undefined)),
    phone: z.string().max(40).optional(),
    address: z.string().max(200).optional(),
    unit: z.string().max(20).optional(),
    service: z.enum(s.serviceCodeEnum.enumValues).optional(),
    message: z.string().max(4000).optional(),
    campaign: z.string().max(80).optional(), // utm_campaign or QR slug
    brand: z.enum(["ESS", "GAS_PRO"]).optional(),
    website: z.string().max(200).optional(), // honeypot: real people leave it empty
  })
  .refine((v) => v.email || (v.phone && toE164(v.phone)), { message: "An email or a valid phone number is required." });
export type WebLead = z.infer<typeof WebLeadSchema>;

export async function campaignForSlug(db: Db, slug: string | undefined | null) {
  if (!slug) return null;
  const [c] = await db.select().from(s.campaigns).where(and(sql`lower(${s.campaigns.tracking} ->> 'qrSlug') = ${slug.trim().toLowerCase()}`, isNull(s.campaigns.archivedAt)));
  return c ?? null;
}

export async function campaignForQuoNumber(db: Db, e164: string | null | undefined) {
  if (!e164) return null;
  const [c] = await db.select().from(s.campaigns).where(and(sql`${s.campaigns.tracking} ->> 'quoNumber' = ${e164}`, isNull(s.campaigns.archivedAt)));
  return c ?? null;
}

export type LeadOutcome = { status: "created" | "duplicate" | "spam"; contactId?: string; jobId?: string };

export async function acceptWebLead(db: Db, input: WebLead, opts: { fetch?: Fetch; now?: Date } = {}): Promise<LeadOutcome> {
  if (input.website) return { status: "spam" };
  const now = opts.now ?? new Date();
  const email = input.email?.toLowerCase();
  const phone = toE164(input.phone) ?? undefined;
  const campaign = await campaignForSlug(db, input.campaign);

  return db.transaction(async (tx) => {
    // Existing contact by email, then phone. First-touch: an existing contact keeps its campaign.
    let contact: typeof s.contacts.$inferSelect | undefined = email
      ? (await tx.select().from(s.contacts).where(and(isNull(s.contacts.archivedAt), sql`exists (select 1 from unnest(${s.contacts.emails}) e where lower(e) = ${email})`)).limit(1))[0]
      : undefined;
    if (!contact && phone) contact = (await findContactByPhone(tx, phone)) ?? undefined;

    // Double submits: same person, another web lead in the last 10 minutes → ignore.
    if (contact) {
      const [recent] = await tx
        .select({ id: s.activities.id })
        .from(s.activities)
        .where(and(eq(s.activities.contactId, contact.id), eq(s.activities.subject, "Web form lead"), gt(s.activities.occurredAt, new Date(now.getTime() - 10 * 60_000))))
        .limit(1);
      if (recent) return { status: "duplicate" as const, contactId: contact.id };
    }

    const [first, ...rest] = input.name.split(/\s+/);
    if (!contact) {
      [contact] = await tx
        .insert(s.contacts)
        .values({ firstName: first, lastName: rest.join(" ") || null, emails: email ? [email] : [], phones: phone ? [phone] : [], source: campaign ? "MAILER_CAMPAIGN" : "WEB_FORM", campaignId: campaign?.id ?? null, brand: input.brand ?? "ESS" })
        .returning();
    } else {
      const fill: Partial<typeof s.contacts.$inferInsert> = {};
      if (email && !contact.emails.map((e) => e.toLowerCase()).includes(email)) fill.emails = [...contact.emails, email];
      if (phone && !contact.phones.includes(phone)) fill.phones = [...contact.phones, phone];
      if (Object.keys(fill).length) await tx.update(s.contacts).set(fill).where(eq(s.contacts.id, contact.id));
    }

    // Property: resolved through GeoSearch when possible (best effort), else kept as typed.
    let propertyId: string | null = null;
    if (input.address?.trim()) {
      const hit = (await geosearch(input.address, { size: 1, fetch: opts.fetch }).catch(() => []))[0];
      const bbl = normalizeBbl(hit?.bbl);
      const [existing] = bbl
        ? await tx.select({ id: s.properties.id }).from(s.properties).where(and(eq(s.properties.bbl, bbl), sql`coalesce(${s.properties.unit}, '') = ${input.unit ?? ""}`, isNull(s.properties.archivedAt)))
        : [];
      propertyId =
        existing?.id ??
        (
          await tx
            .insert(s.properties)
            .values({ addressLine: hit?.addressLine ?? input.address.trim(), unit: input.unit || null, borough: hit?.borough ?? null, zip: hit?.zip ?? null, bbl, bin: hit?.bin ?? null, lat: hit?.lat?.toString(), lng: hit?.lng?.toString() })
            .returning({ id: s.properties.id })
        )[0].id;
    }

    const serviceCode = input.service ?? "MOLD_ASSESS";
    const [pipeline] = await tx.select({ key: s.pipelines.key }).from(s.pipelines).where(sql`${serviceCode} = any(${s.pipelines.serviceCodes})`).limit(1);
    const [job] = await tx
      .insert(s.jobs)
      .values({ serviceCode, pipelineKey: pipeline?.key ?? "INSPECTION", stage: "LEAD", source: "WEB_FORM", propertyId, clientContactId: contact.id, brand: input.brand ?? "ESS", campaignId: campaign?.id ?? null, title: input.service ? null : "Service to confirm (web form)", notes: input.message ?? null })
      .returning();

    await tx.insert(s.activities).values({ type: "NOTE", direction: "INBOUND", contactId: contact.id, jobId: job.id, propertyId, subject: "Web form lead", body: [input.message, campaign && `Campaign: ${campaign.name}`].filter(Boolean).join("\n\n") || null, occurredAt: now, triageStatus: "SKIPPED" });
    await tx.insert(s.tasks).values({ title: `New web lead — ${input.name}${input.address ? `, ${input.address}` : ""}`, description: input.message?.slice(0, 500) ?? null, source: "SYSTEM_RULE", contactId: contact.id, jobId: job.id, dueAt: new Date(now.getTime() + 2 * 3600_000) });

    // Acknowledgment text: a DRAFT in the Outbox (auto-sent by the outbound pipeline only when allowed).
    const [tpl] = await tx.select().from(s.messageTemplates).where(and(eq(s.messageTemplates.key, "NEW_LEAD_ACK"), eq(s.messageTemplates.active, true)));
    const [line] = await tx.select().from(s.phoneLines).where(eq(s.phoneLines.brand, input.brand ?? "ESS")).limit(1);
    if (tpl && line && phone && !contact.doNotContact) {
      const { text } = renderTemplate(tpl.body, { first_name: first, brand_name: BRAND_INFO[input.brand ?? "ESS"].name, brand_phone: BRAND_INFO[input.brand ?? "ESS"].phone });
      await createDraft(tx, { channel: "SMS", source: "TEMPLATE", templateKey: "NEW_LEAD_ACK", toAddress: phone, fromLineId: line.id, body: text, brand: input.brand ?? "ESS", contactId: contact.id, jobId: job.id });
    }
    return { status: "created" as const, contactId: contact.id, jobId: job.id };
  });
}

/** QR code hit: count the scan and send the visitor to the campaign's landing page. */
export async function recordScan(db: Db, slug: string): Promise<string | null> {
  const c = await campaignForSlug(db, slug);
  if (!c) return null;
  await db.insert(s.campaignEvents).values({ campaignId: c.id, kind: "SCAN" });
  const landing = c.tracking?.landingUrl || "https://ess-nyc.com/";
  const url = new URL(landing);
  if (!url.searchParams.has("utm_campaign")) url.searchParams.set("utm_campaign", c.tracking!.qrSlug!);
  if (!url.searchParams.has("utm_medium")) url.searchParams.set("utm_medium", "qr");
  return url.toString();
}
