/**
 * What natural-language search may query (SPEC §9.6). Only tables/columns listed here are described
 * to the model AND accepted by the validator. Encrypted, secret and raw-payload columns are never
 * listed. Owner-only tables are described only to the owner (RLS would return nothing to a VA anyway).
 */
export type CatalogTable = { name: string; about: string; columns: Record<string, string>; ownerOnly?: boolean };

export const CATALOG: CatalogTable[] = [
  { name: "jobs", about: "One row per job/engagement.", columns: { id: "uuid", job_number: "ESS-YYYY-####", service_code: "MOLD_ASSESS, MOLD_PLAN, MOLD_CLEAR, LEAD_RA, LEAD_CLEAR, LEAD_WATER, ASB_SURVEY, LL152, LL126, LL31, VIOLATION, AIRNYC, BID", brand: "ESS or GAS_PRO", stage: "LEAD, QUALIFIED, PROPOSAL_SENT, SIGNED, SCHEDULED, FIELD_COMPLETE, LAB_PENDING, DRAFTING, QA, DELIVERED, INVOICED, PAID, CLOSED, NEXT_CYCLE_SCHEDULED, LOST", stage_entered_at: "timestamptz", property_id: "→ properties.id", client_org_id: "→ organizations.id", client_contact_id: "→ contacts.id", sub_org_id: "→ organizations.id (subcontractor)", priority: "LOW/NORMAL/HIGH/URGENT", source: "lead source", title: "short description", scheduled_at: "timestamptz", field_completed_at: "timestamptz", delivered_at: "timestamptz", next_cycle_due: "date", campaign_id: "→ campaigns.id", created_at: "timestamptz", archived_at: "timestamptz, null = active" } },
  { name: "properties", about: "Buildings/units.", columns: { id: "uuid", address_line: "street address", unit: "apartment", borough: "Manhattan, Bronx, Brooklyn, Queens, Staten Island", zip: "zip", bbl: "NYC BBL", year_built: "int", building_class: "text", management_org_id: "→ organizations.id", archived_at: "timestamptz" } },
  { name: "property_violations", about: "Cached HPD/DOB/ECB violations per property.", columns: { property_id: "→ properties.id", source: "HPD, DOB or ECB", violation_id: "text", class: "HPD class A/B/C", status: "text", is_open: "boolean", issued_date: "date", description: "text" } },
  { name: "organizations", about: "Companies: clients, management companies, agencies, subcontractors, labs.", columns: { id: "uuid", name: "text", type: "OWNER, MANAGEMENT_CO, REFERRAL_PARTNER, GOV_AGENCY, SUBCONTRACTOR, LAB, OTHER", email: "text", phone: "text", archived_at: "timestamptz" } },
  { name: "contacts", about: "People.", columns: { id: "uuid", first_name: "text", last_name: "text", org_id: "→ organizations.id", emails: "text[]", phones: "text[] E.164", source: "text", campaign_id: "→ campaigns.id", do_not_contact: "boolean", created_at: "timestamptz", archived_at: "timestamptz" } },
  { name: "tasks", about: "To-dos.", columns: { title: "text", status: "OPEN, IN_PROGRESS, DONE, CANCELED", due_at: "timestamptz", assignee: "user id", job_id: "→ jobs.id", contact_id: "→ contacts.id", bid_id: "→ bids.id", source: "text", created_at: "timestamptz" } },
  { name: "samples", about: "Lab samples.", columns: { job_id: "→ jobs.id", sample_id: "text", type: "AIR, SWAB, TAPE, BULK, DUST_WIPE, WATER", location: "text", status: "COLLECTED, SUBMITTED, RESULTS_IN, REVIEWED", submitted_at: "timestamptz", results_received_at: "timestamptz" } },
  { name: "activities", about: "Timeline: calls, texts, emails, notes (no message bodies here).", columns: { type: "CALL, SMS, EMAIL_IN, EMAIL_OUT, NOTE, STAGE_CHANGE, DOC, PAYMENT, SYSTEM", direction: "INBOUND/OUTBOUND/INTERNAL", contact_id: "→ contacts.id", job_id: "→ jobs.id", occurred_at: "timestamptz", call_status: "text", triage_category: "NEW_LEAD, EXISTING_JOB, LAB_RESULT, INVOICE_QUESTION, BID_NOTICE, AIRNYC, VENDOR, SPAM, OTHER" } },
  { name: "bids", about: "Government solicitations.", columns: { title: "text", agency: "text", solicitation_number: "text", type: "RFP/RFQ/RFB/IFB/OTHER", status: "WATCHING, GO_NO_GO, DRAFTING, SUBMITTED, AWARDED, LOST, NO_BID", due_at: "timestamptz", source: "text", decision: "GO/NO_GO", archived_at: "timestamptz" } },
  { name: "campaigns", about: "Marketing campaigns.", columns: { id: "uuid", name: "text", channel: "DIRECT_MAIL, EMAIL, WEB, DOOR_TO_DOOR", sent_count: "int" } },
  { name: "credentials", about: "ESS licenses.", columns: { name: "text", number: "text", issuer: "text", expires_at: "date" } },
  { name: "job_financials", about: "OWNER ONLY. Money per job.", ownerOnly: true, columns: { job_id: "→ jobs.id", quoted_amount: "numeric", sub_cost: "numeric", lab_cost: "numeric", other_cost: "numeric", gross_margin: "numeric", invoice_status: "text", amount_paid: "numeric", paid_at: "timestamptz" } },
  { name: "invoices_cache", about: "OWNER ONLY. FreshBooks invoices.", ownerOnly: true, columns: { job_id: "→ jobs.id", invoice_number: "text", status: "draft/sent/viewed/partial/paid/...", amount: "numeric", outstanding: "numeric", paid: "numeric", issued_at: "date", due_at: "date" } },
  { name: "payments_cache", about: "OWNER ONLY. Payments received.", ownerOnly: true, columns: { job_id: "→ jobs.id", amount: "numeric", paid_on: "date", type: "text" } },
];

export function catalogFor(isOwner: boolean): CatalogTable[] {
  return CATALOG.filter((t) => isOwner || !t.ownerOnly);
}

export function describeCatalog(tables: CatalogTable[]): string {
  return tables.map((t) => `${t.name} — ${t.about}\n${Object.entries(t.columns).map(([c, d]) => `  ${c}: ${d}`).join("\n")}`).join("\n\n");
}
