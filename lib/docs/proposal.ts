/**
 * ESS-branded proposal (SPEC §10): the job's quoted lines rendered into ESS_Proposal.docx, with a
 * client-signature-only block. It carries prices, so it is stored in the OWNER-only bucket and
 * marked contains_pricing (never visible to VAs or subs).
 */
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { schema as s, type Db } from "@/lib/db";
import type { Uploader } from "@/lib/mail/ingest";
import { BRAND_INFO } from "@/lib/comms/templates";
import { label, personName, SERVICE_LABELS, usd } from "@/lib/labels";
import { loadTemplate, renderDocx } from "./render";

export const DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export async function generateProposal(db: Db, jobId: string, uploader: Uploader, now = new Date()): Promise<{ documentId: string; placeholder: boolean; storagePath: string }> {
  const [row] = await db
    .select({ job: s.jobs, fin: s.jobFinancials, prop: s.properties, org: s.organizations, contact: s.contacts })
    .from(s.jobs)
    .leftJoin(s.jobFinancials, eq(s.jobFinancials.jobId, s.jobs.id))
    .leftJoin(s.properties, eq(s.properties.id, s.jobs.propertyId))
    .leftJoin(s.organizations, eq(s.organizations.id, s.jobs.clientOrgId))
    .leftJoin(s.contacts, eq(s.contacts.id, s.jobs.clientContactId))
    .where(eq(s.jobs.id, jobId));
  if (!row) throw new Error("Job not found.");
  const lines = row.fin?.lineItems ?? [];
  if (!lines.length) throw new Error("Build the quote first — the proposal needs line items.");
  const [rule] = await db.select().from(s.pricingRules).where(eq(s.pricingRules.serviceCode, row.job.serviceCode));

  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(s.documents).where(and(eq(s.documents.jobId, jobId), eq(s.documents.kind, "PROPOSAL")));
  const version = n + 1;
  const total = lines.reduce((t, l) => t + l.quantity * l.unitPrice, 0);
  const p = row.prop;
  const tpl = loadTemplate("ESS_Proposal");
  const buffer = renderDocx(tpl.buffer, {
    brand_name: BRAND_INFO[row.job.brand].name,
    proposal_number: `${row.job.jobNumber}-P${version}`,
    proposal_date: now.toLocaleDateString("en-US", { timeZone: "America/New_York", dateStyle: "long" }),
    client_name: row.contact ? personName(row.contact) : (row.org?.name ?? null),
    client_org: row.contact && row.org ? row.org.name : "",
    property_address: p ? [p.addressLine, p.unit && `Apt ${p.unit}`, p.borough, p.zip].filter(Boolean).join(", ") : null,
    service_name: label(SERVICE_LABELS, row.job.serviceCode),
    scope: row.fin?.quoteInputs?.scope ?? rule?.defaultScope ?? null,
    lines: lines.map((l) => ({ description: l.description, qty: l.quantity.toLocaleString("en-US"), unit_price: usd(l.unitPrice), amount: usd(l.quantity * l.unitPrice) })),
    total: usd(total),
    valid_days: row.fin?.quoteInputs?.validDays ?? 30,
  });

  const title = `Proposal ${row.job.jobNumber}-P${version}.docx`;
  const storagePath = `jobs/${jobId}/${randomUUID()}-${title.replace(/[^\w.\- ]+/g, "_")}`;
  await uploader.upload("job-files-pricing", storagePath, buffer, DOCX_TYPE);
  const [doc] = await db
    .insert(s.documents)
    .values({ jobId, kind: "PROPOSAL", status: "DRAFT", version, title, containsPricing: true, storageBucket: "job-files-pricing", storagePath })
    .returning({ id: s.documents.id });
  return { documentId: doc.id, placeholder: tpl.placeholder, storagePath };
}
