/**
 * ESS CRM — Drizzle schema (Phase 1 core tables, SPEC §4).
 *
 * Row-level security policies, triggers, and helper functions are NOT declared here; they live in
 * hand-written SQL migrations under db/migrations (see 0001_rls_and_rules.sql) so they can be
 * reviewed line by line. Every table in `public` has RLS enabled there.
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  pgView,
  primaryKey,
  text,
  time,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { authUsers } from "drizzle-orm/supabase";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const brandEnum = pgEnum("brand", ["ESS", "GAS_PRO"]);

export const userRoleEnum = pgEnum("user_role", ["OWNER", "VA", "FIELD", "SUB"]);

export const serviceCodeEnum = pgEnum("service_code", [
  "MOLD_ASSESS",
  "MOLD_PLAN",
  "MOLD_CLEAR",
  "LEAD_RA",
  "LEAD_CLEAR",
  "LEAD_WATER",
  "ASB_SURVEY",
  "LL152",
  "LL126",
  "LL31",
  "VIOLATION",
  "AIRNYC",
  "BID",
]);

export const orgTypeEnum = pgEnum("org_type", [
  "OWNER",
  "MANAGEMENT_CO",
  "REFERRAL_PARTNER",
  "GOV_AGENCY",
  "SUBCONTRACTOR",
  "LAB",
  "OTHER",
]);

export const contactSourceEnum = pgEnum("contact_source", [
  "WEB_FORM",
  "QUO",
  "EMAIL",
  "MAILER_CAMPAIGN",
  "REFERRAL",
  "BID",
  "MANUAL",
]);

export const preferredChannelEnum = pgEnum("preferred_channel", ["PHONE", "SMS", "EMAIL"]);

export const propertyRoleEnum = pgEnum("property_role", [
  "OWNER",
  "MANAGER",
  "TENANT",
  "SUPER",
  "BROKER",
]);

export const violationSourceEnum = pgEnum("violation_source", ["HPD", "DOB", "ECB"]);

export const priorityEnum = pgEnum("priority", ["LOW", "NORMAL", "HIGH", "URGENT"]);

export const sampleTypeEnum = pgEnum("sample_type", [
  "AIR",
  "SWAB",
  "TAPE",
  "BULK",
  "DUST_WIPE",
  "WATER",
]);

export const sampleStatusEnum = pgEnum("sample_status", [
  "COLLECTED",
  "SUBMITTED",
  "RESULTS_IN",
  "REVIEWED",
]);

export const documentKindEnum = pgEnum("document_kind", [
  "PROPOSAL",
  "REPORT",
  "WORK_PLAN",
  "SUB_COPY",
  "CLEARANCE",
  "INVOICE_PDF",
  "CONSENT",
  "LAB_RESULT",
  "PHOTO_LOG",
  "OTHER",
]);

export const documentStatusEnum = pgEnum("document_status", [
  "DRAFT",
  "QA",
  "FINAL",
  "SENT",
  "SIGNED",
]);

export const activityTypeEnum = pgEnum("activity_type", [
  "CALL",
  "SMS",
  "EMAIL_IN",
  "EMAIL_OUT",
  "NOTE",
  "STAGE_CHANGE",
  "DOC",
  "PAYMENT",
  "SYSTEM",
]);

export const directionEnum = pgEnum("direction", ["INBOUND", "OUTBOUND", "INTERNAL"]);

export const taskStatusEnum = pgEnum("task_status", ["OPEN", "IN_PROGRESS", "DONE", "CANCELED"]);

export const taskSourceEnum = pgEnum("task_source", [
  "MANUAL",
  "QUO_NEXT_STEP",
  "EMAIL_AI",
  "SYSTEM_RULE",
  "CALL_AI",
]);

export const campaignChannelEnum = pgEnum("campaign_channel", [
  "DIRECT_MAIL",
  "EMAIL",
  "WEB",
  "DOOR_TO_DOOR",
]);

export const airnycModeEnum = pgEnum("airnyc_mode", [
  "MANUAL",
  "EMAIL",
  "POWER_AUTOMATE",
  "GRAPH",
]);

export const consentStatusEnum = pgEnum("consent_status", [
  "NOT_REQUESTED",
  "REQUESTED",
  "RECEIVED",
  "DECLINED",
  "NOT_REQUIRED",
]);

export const qcStatusEnum = pgEnum("qc_status", [
  "NOT_SUBMITTED",
  "SUBMITTED",
  "REVISIONS_REQUESTED",
  "APPROVED",
]);

export const enrichmentStatusEnum = pgEnum("enrichment_status", [
  "PENDING",
  "OK",
  "PARTIAL",
  "FAILED",
]);

// Phase 2 — communications
export const outboundChannelEnum = pgEnum("outbound_channel", ["SMS", "EMAIL"]);
export const outboundStatusEnum = pgEnum("outbound_status", ["DRAFT", "APPROVED", "SENDING", "SENT", "FAILED", "DISCARDED"]);
export const outboundSourceEnum = pgEnum("outbound_source", ["MANUAL", "TEMPLATE", "MISSED_CALL", "AI_DRAFT", "SYSTEM"]);
export const triageStatusEnum = pgEnum("triage_status", ["PENDING", "AUTO", "NEEDS_REVIEW", "REVIEWED", "BLOCKED", "SKIPPED"]);

// ---------------------------------------------------------------------------
// Shared columns (SPEC §4: id, created_at, updated_at, created_by; soft delete via archived_at)
// ---------------------------------------------------------------------------

const baseColumns = () => ({
  id: uuid("id").primaryKey().defaultRandom(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid("created_by").default(sql`auth.uid()`),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
});

// ---------------------------------------------------------------------------
// Users / profiles
// ---------------------------------------------------------------------------

export const profiles = pgTable("profiles", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => authUsers.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  fullName: text("full_name"),
  // NULL = no access until the OWNER assigns a role.
  role: userRoleEnum("role"),
  // For SUB users (Phase 5): the subcontractor organization they belong to.
  orgId: uuid("org_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// §4.9 Campaigns (minimal in Phase 1 so contacts.campaign_id has a target)
// ---------------------------------------------------------------------------

export const campaigns = pgTable("campaigns", {
  ...baseColumns(),
  name: text("name").notNull(),
  brand: brandEnum("brand").notNull().default("ESS"),
  channel: campaignChannelEnum("channel").notNull(),
  sentCount: integer("sent_count"),
  tracking: jsonb("tracking").$type<{ qrSlug?: string; quoNumber?: string; landingUrl?: string }>(),
  notes: text("notes"),
});

// Campaign spend is financial → OWNER only (kept out of `campaigns`, which VAs can read).
export const campaignCosts = pgTable("campaign_costs", {
  campaignId: uuid("campaign_id")
    .primaryKey()
    .references(() => campaigns.id, { onDelete: "cascade" }),
  cost: numeric("cost", { precision: 12, scale: 2 }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// §4.2 Organizations & contacts
// ---------------------------------------------------------------------------

export const organizations = pgTable(
  "organizations",
  {
    ...baseColumns(),
    name: text("name").notNull(),
    type: orgTypeEnum("type").notNull().default("OTHER"),
    brand: brandEnum("brand").notNull().default("ESS"),
    freshbooksClientId: text("freshbooks_client_id"),
    // null = use settings.hold_report_until_paid_default; a job's own flag overrides this.
    holdReportUntilPaid: boolean("hold_report_until_paid"),
    website: text("website"),
    phone: text("phone"),
    email: text("email"),
    notes: text("notes"),
  },
  (t) => [index("organizations_name_idx").on(t.name)],
);

export const contacts = pgTable(
  "contacts",
  {
    ...baseColumns(),
    firstName: text("first_name"),
    lastName: text("last_name"),
    orgId: uuid("org_id").references(() => organizations.id, { onDelete: "set null" }),
    title: text("title"),
    emails: text("emails").array().notNull().default(sql`'{}'::text[]`),
    // E.164, normalized by lib/phone.ts before insert.
    phones: text("phones").array().notNull().default(sql`'{}'::text[]`),
    quoContactId: text("quo_contact_id"),
    freshbooksClientId: text("freshbooks_client_id"),
    preferredChannel: preferredChannelEnum("preferred_channel"),
    doNotContact: boolean("do_not_contact").notNull().default(false),
    source: contactSourceEnum("source").notNull().default("MANUAL"),
    campaignId: uuid("campaign_id").references(() => campaigns.id, { onDelete: "set null" }),
    brand: brandEnum("brand").notNull().default("ESS"),
    notes: text("notes"),
  },
  (t) => [
    index("contacts_org_idx").on(t.orgId),
    index("contacts_phones_gin").using("gin", t.phones),
    index("contacts_emails_gin").using("gin", t.emails),
  ],
);

// ---------------------------------------------------------------------------
// §4.1 Properties
// ---------------------------------------------------------------------------

export const properties = pgTable(
  "properties",
  {
    ...baseColumns(),
    bbl: text("bbl"),
    bin: text("bin"),
    addressLine: text("address_line").notNull(),
    unit: text("unit"),
    borough: text("borough"),
    zip: text("zip"),
    lat: numeric("lat", { precision: 9, scale: 6 }),
    lng: numeric("lng", { precision: 9, scale: 6 }),
    buildingClass: text("building_class"),
    unitsRes: integer("units_res"),
    yearBuilt: integer("year_built"),
    ownerName: text("owner_name"),
    hpdRegistrationId: text("hpd_registration_id"),
    hpdRegistrationContacts: jsonb("hpd_registration_contacts"),
    managementOrgId: uuid("management_org_id").references(() => organizations.id, {
      onDelete: "set null",
    }),
    isNycha: boolean("is_nycha").notNull().default(false),
    notes: text("notes"),
    geosearchRaw: jsonb("geosearch_raw"),
    enrichmentStatus: enrichmentStatusEnum("enrichment_status").notNull().default("PENDING"),
    enrichedAt: timestamp("enriched_at", { withTimezone: true }),
    enrichmentError: text("enrichment_error"),
  },
  (t) => [
    // Unique when resolved; nullable until then. Units in the same building share a BBL, so the
    // uniqueness is on (bbl, unit) — see docs/DECISIONS.md.
    uniqueIndex("properties_bbl_unit_uq")
      .on(t.bbl, sql`coalesce(${t.unit}, '')`)
      .where(sql`${t.bbl} is not null and ${t.archivedAt} is null`),
    index("properties_bin_idx").on(t.bin),
    index("properties_address_idx").on(t.addressLine),
  ],
);

export const propertyViolations = pgTable(
  "property_violations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    propertyId: uuid("property_id")
      .notNull()
      .references(() => properties.id, { onDelete: "cascade" }),
    source: violationSourceEnum("source").notNull(),
    violationId: text("violation_id").notNull(),
    class: text("class"),
    orderNumber: text("order_number"),
    status: text("status"),
    isOpen: boolean("is_open").notNull().default(true),
    issuedDate: date("issued_date"),
    description: text("description"),
    raw: jsonb("raw"),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("property_violations_uq").on(t.propertyId, t.source, t.violationId),
    index("property_violations_open_idx").on(t.propertyId, t.isOpen),
  ],
);

export const propertyRoles = pgTable(
  "property_roles",
  {
    ...baseColumns(),
    propertyId: uuid("property_id")
      .notNull()
      .references(() => properties.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "cascade" }),
    orgId: uuid("org_id").references(() => organizations.id, { onDelete: "cascade" }),
    role: propertyRoleEnum("role").notNull(),
    active: boolean("active").notNull().default(true),
  },
  (t) => [index("property_roles_property_idx").on(t.propertyId)],
);

// ---------------------------------------------------------------------------
// §5 Pipelines (configurable; seeded with defaults)
// ---------------------------------------------------------------------------

export const pipelines = pgTable("pipelines", {
  key: text("key").primaryKey(), // INSPECTION | WORK_PLAN | AIRNYC
  name: text("name").notNull(),
  serviceCodes: serviceCodeEnum("service_codes").array().notNull().default(sql`'{}'`),
  position: integer("position").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const pipelineStages = pgTable(
  "pipeline_stages",
  {
    pipelineKey: text("pipeline_key")
      .notNull()
      .references(() => pipelines.key, { onDelete: "cascade", onUpdate: "cascade" }),
    key: text("key").notNull(),
    name: text("name").notNull(),
    position: integer("position").notNull(),
    staleAfterDays: integer("stale_after_days"),
    // Terminal stages are not "open": Lost cannot be entered from them.
    isTerminal: boolean("is_terminal").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.pipelineKey, t.key] })],
);

// ---------------------------------------------------------------------------
// §4.3 Jobs
// ---------------------------------------------------------------------------

export const jobs = pgTable(
  "jobs",
  {
    ...baseColumns(),
    // ESS-YYYY-#### — next_job_number() is defined at the top of migration 0000.
    jobNumber: text("job_number")
      .notNull()
      .unique()
      .default(sql`public.next_job_number()`),
    brand: brandEnum("brand").notNull().default("ESS"),
    serviceCode: serviceCodeEnum("service_code").notNull(),
    pipelineKey: text("pipeline_key").notNull(),
    stage: text("stage").notNull(),
    stageEnteredAt: timestamp("stage_entered_at", { withTimezone: true }).notNull().defaultNow(),
    lostReason: text("lost_reason"),
    priority: priorityEnum("priority").notNull().default("NORMAL"),
    source: contactSourceEnum("source"),
    title: text("title"),
    propertyId: uuid("property_id").references(() => properties.id, { onDelete: "restrict" }),
    clientOrgId: uuid("client_org_id").references(() => organizations.id, {
      onDelete: "set null",
    }),
    clientContactId: uuid("client_contact_id").references(() => contacts.id, {
      onDelete: "set null",
    }),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
    fieldCompletedAt: timestamp("field_completed_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    driveFolderUrl: text("drive_folder_url"),
    driveFolderId: text("drive_folder_id"),
    assignedTo: uuid("assigned_to").references(() => profiles.userId, { onDelete: "set null" }),
    subOrgId: uuid("sub_org_id").references(() => organizations.id, { onDelete: "set null" }),
    hpdViolationRef: text("hpd_violation_ref"),
    airnycCaseId: uuid("airnyc_case_id"),
    nextCycleDue: date("next_cycle_due"),
    // Set when the compliance worker has scheduled this job's next cycle (SPEC §6.6), so it runs once.
    cycleScheduledAt: timestamp("cycle_scheduled_at", { withTimezone: true }),
    // Titan calendar sync (SPEC §6.3): hash of the last event written; null = not on the calendar.
    calendarHash: text("calendar_hash"),
    calendarSequence: integer("calendar_sequence").notNull().default(0),
    calendarError: text("calendar_error"),
    notes: text("notes"),
  },
  (t) => [
    foreignKey({
      columns: [t.pipelineKey, t.stage],
      foreignColumns: [pipelineStages.pipelineKey, pipelineStages.key],
      name: "jobs_pipeline_stage_fk",
    }).onUpdate("cascade"),
    index("jobs_stage_idx").on(t.pipelineKey, t.stage),
    index("jobs_property_idx").on(t.propertyId),
  ],
);

export const jobNumberCounters = pgTable("job_number_counters", {
  year: integer("year").primaryKey(),
  lastValue: integer("last_value").notNull().default(0),
});

// OWNER only (SPEC §2). Everything with a dollar sign lives here, not on `jobs`.
export const jobFinancials = pgTable("job_financials", {
  jobId: uuid("job_id")
    .primaryKey()
    .references(() => jobs.id, { onDelete: "cascade" }),
  quotedAmount: numeric("quoted_amount", { precision: 12, scale: 2 }),
  lineItems: jsonb("line_items")
    .$type<{ description: string; quantity: number; unitPrice: number }[]>()
    .notNull()
    .default(sql`'[]'::jsonb`),
  subCost: numeric("sub_cost", { precision: 12, scale: 2 }),
  labCost: numeric("lab_cost", { precision: 12, scale: 2 }),
  otherCost: numeric("other_cost", { precision: 12, scale: 2 }),
  freshbooksEstimateId: text("freshbooks_estimate_id"),
  freshbooksInvoiceId: text("freshbooks_invoice_id"),
  invoiceStatus: text("invoice_status"),
  amountPaid: numeric("amount_paid", { precision: 12, scale: 2 }),
  paidAt: timestamp("paid_at", { withTimezone: true }),
  holdReportUntilPaid: boolean("hold_report_until_paid"),
  reportReleasedAt: timestamp("report_released_at", { withTimezone: true }),
  invoiceError: text("invoice_error"),
  invoiceAttemptAt: timestamp("invoice_attempt_at", { withTimezone: true }), // set before calling FreshBooks (crash-safe retry)
  grossMargin: numeric("gross_margin", { precision: 12, scale: 2 }).generatedAlwaysAs(
    sql`coalesce(quoted_amount, 0) - coalesce(sub_cost, 0) - coalesce(lab_cost, 0) - coalesce(other_cost, 0)`,
  ),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  // Quote builder inputs (SPEC §10) — the lines above are computed from these + pricing_rules.
  quoteInputs: jsonb("quote_inputs").$type<QuoteInputs>(),
});

// OWNER only. Filled by FreshBooks sync in Phase 3; created now so RLS is in place from day one.
export const invoicesCache = pgTable("invoices_cache", {
  id: uuid("id").primaryKey().defaultRandom(),
  freshbooksInvoiceId: text("freshbooks_invoice_id").notNull().unique(),
  jobId: uuid("job_id").references(() => jobs.id, { onDelete: "set null" }),
  orgId: uuid("org_id").references(() => organizations.id, { onDelete: "set null" }),
  status: text("status"),
  amount: numeric("amount", { precision: 12, scale: 2 }),
  outstanding: numeric("outstanding", { precision: 12, scale: 2 }),
  issuedAt: date("issued_at"),
  dueAt: date("due_at"),
  raw: jsonb("raw"),
  // --- Phase 3 ---
  invoiceNumber: text("invoice_number"),
  freshbooksClientId: text("freshbooks_client_id"),
  paid: numeric("paid", { precision: 12, scale: 2 }),
  currency: text("currency"),
  fbUpdatedAt: timestamp("fb_updated_at", { withTimezone: true }), // last-modified per FreshBooks (ordering guard)
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// OWNER only. Per-job subcontractor costs and per-sub default rate cards.
export const subCosts = pgTable("sub_costs", {
  id: uuid("id").primaryKey().defaultRandom(),
  jobId: uuid("job_id").references(() => jobs.id, { onDelete: "cascade" }),
  subOrgId: uuid("sub_org_id").references(() => organizations.id, { onDelete: "cascade" }),
  // Rate card rows have job_id null (replaces sub_profiles.default_rates — see DECISIONS.md).
  isRateCard: boolean("is_rate_card").notNull().default(false),
  description: text("description"),
  amount: numeric("amount", { precision: 12, scale: 2 }),
  rates: jsonb("rates"),
  // Quote comparison (SPEC §10): the sub quote chosen for the job.
  selected: boolean("selected").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const fieldData = pgTable("field_data", {
  ...baseColumns(),
  jobId: uuid("job_id")
    .notNull()
    .unique()
    .references(() => jobs.id, { onDelete: "cascade" }),
  readings: jsonb("readings").$type<FieldReading[]>().notNull().default(sql`'[]'::jsonb`),
  observations: text("observations"),
  photos: jsonb("photos").$type<FieldPhoto[]>().notNull().default(sql`'[]'::jsonb`),
  areas: text("areas").array().notNull().default(sql`'{}'::text[]`),
});

// ---------------------------------------------------------------------------
// §4.4 Samples
// ---------------------------------------------------------------------------

export const samples = pgTable(
  "samples",
  {
    ...baseColumns(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    sampleId: text("sample_id").notNull(),
    type: sampleTypeEnum("type").notNull(),
    location: text("location"),
    labOrgId: uuid("lab_org_id").references(() => organizations.id, { onDelete: "set null" }),
    cocNumber: text("coc_number"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    resultsReceivedAt: timestamp("results_received_at", { withTimezone: true }),
    resultPdfPath: text("result_pdf_path"),
    results: jsonb("results"),
    status: sampleStatusEnum("status").notNull().default("COLLECTED"),
  },
  (t) => [
    index("samples_job_idx").on(t.jobId),
    index("samples_coc_idx").on(t.cocNumber),
    uniqueIndex("samples_job_sample_uq").on(t.jobId, t.sampleId),
  ],
);

// ---------------------------------------------------------------------------
// §4.5 Documents
// ---------------------------------------------------------------------------

export const documents = pgTable(
  "documents",
  {
    ...baseColumns(),
    jobId: uuid("job_id").references(() => jobs.id, { onDelete: "cascade" }),
    airnycCaseId: uuid("airnyc_case_id"),
    bidId: uuid("bid_id"),
    kind: documentKindEnum("kind").notNull(),
    title: text("title"),
    version: integer("version").notNull().default(1),
    storageBucket: text("storage_bucket"),
    storagePath: text("storage_path"),
    driveFileId: text("drive_file_id"),
    status: documentStatusEnum("status").notNull().default("DRAFT"),
    // Never exposed to SUB/VA if true (enforced in RLS and in storage bucket choice).
    containsPricing: boolean("contains_pricing").notNull().default(false),
    // DocuSign (SPEC §6.7): the envelope this proposal was sent in, and its last known status.
    docusignEnvelopeId: text("docusign_envelope_id"),
    docusignStatus: text("docusign_status"),
    signedDocumentId: uuid("signed_document_id"),
  },
  (t) => [index("documents_job_idx").on(t.jobId)],
);

// ---------------------------------------------------------------------------
// §7 AIRnyc cases (MANUAL mode ships in Phase 1)
// ---------------------------------------------------------------------------

export const airnycCases = pgTable(
  "airnyc_cases",
  {
    ...baseColumns(),
    caseId: text("case_id").notNull(), // e.g. PHS_0148
    network: text("network"), // derived from case_id prefix
    // --- Member fields: AES-256-GCM ciphertext produced by lib/crypto.ts. Never plaintext. ---
    memberNameEnc: text("member_name_enc"),
    guardianNameEnc: text("guardian_name_enc"),
    memberPhoneEnc: text("member_phone_enc"),
    addressEnc: text("address_enc"),
    // ---------------------------------------------------------------------------------------
    propertyId: uuid("property_id").references(() => properties.id, { onDelete: "set null" }),
    caseManagerName: text("case_manager_name"),
    caseManagerEmail: text("case_manager_email"),
    approvedServices: text("approved_services").array().notNull().default(sql`'{}'::text[]`),
    trackerRow: integer("tracker_row"),
    landlordConsentStatus: consentStatusEnum("landlord_consent_status")
      .notNull()
      .default("NOT_REQUESTED"),
    tenantConsentStatus: consentStatusEnum("tenant_consent_status")
      .notNull()
      .default("NOT_REQUESTED"),
    isNycha: boolean("is_nycha").notNull().default(false),
    qcReviewer: text("qc_reviewer"),
    qcStatus: qcStatusEnum("qc_status").notNull().default("NOT_SUBMITTED"),
    sharepointFolderUrl: text("sharepoint_folder_url"),
    pipelineKey: text("pipeline_key").notNull().default("AIRNYC"),
    stage: text("stage").notNull().default("REFERRAL_RECEIVED"),
    stageEnteredAt: timestamp("stage_entered_at", { withTimezone: true }).notNull().defaultNow(),
    jobId: uuid("job_id").references(() => jobs.id, { onDelete: "set null" }),
    // §7.2 flags
    scopeNotCovered: boolean("scope_not_covered").notNull().default(false),
    outOfScopeObservations: text("out_of_scope_observations"),
    driveFolderUrl: text("drive_folder_url"),
    driveFolderId: text("drive_folder_id"),
  },
  (t) => [
    uniqueIndex("airnyc_cases_case_id_uq").on(t.caseId),
    foreignKey({
      columns: [t.pipelineKey, t.stage],
      foreignColumns: [pipelineStages.pipelineKey, pipelineStages.key],
      name: "airnyc_cases_pipeline_stage_fk",
    }).onUpdate("cascade"),
  ],
);

// §7.3 Upload checklist template (configurable by OWNER) + per-case ticks.
export const airnycChecklistItems = pgTable("airnyc_checklist_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  stage: text("stage").notNull(),
  label: text("label").notNull(),
  // Tokens: {CASE_ID}, {LAST_NAME}, {DATE}. Placeholder patterns until AIRnyc confirms naming.
  fileNamePattern: text("file_name_pattern"),
  position: integer("position").notNull().default(0),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const airnycCaseChecklist = pgTable(
  "airnyc_case_checklist",
  {
    caseId: uuid("case_id")
      .notNull()
      .references(() => airnycCases.id, { onDelete: "cascade" }),
    itemId: uuid("item_id")
      .notNull()
      .references(() => airnycChecklistItems.id, { onDelete: "cascade" }),
    doneAt: timestamp("done_at", { withTimezone: true }).notNull().defaultNow(),
    doneBy: uuid("done_by"),
  },
  (t) => [primaryKey({ columns: [t.caseId, t.itemId] })],
);

// ---------------------------------------------------------------------------
// §4.6 Activities, §4.7 Tasks
// ---------------------------------------------------------------------------

export const activities = pgTable(
  "activities",
  {
    ...baseColumns(),
    type: activityTypeEnum("type").notNull(),
    direction: directionEnum("direction"),
    contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "set null" }),
    propertyId: uuid("property_id").references(() => properties.id, { onDelete: "set null" }),
    jobId: uuid("job_id").references(() => jobs.id, { onDelete: "cascade" }),
    airnycCaseId: uuid("airnyc_case_id").references(() => airnycCases.id, {
      onDelete: "cascade",
    }),
    bidId: uuid("bid_id"),
    brand: brandEnum("brand"),
    channelLine: text("channel_line"),
    subject: text("subject"),
    body: text("body"),
    summary: text("summary"),
    nextSteps: text("next_steps").array(),
    externalId: text("external_id"),
    externalUrl: text("external_url"),
    raw: jsonb("raw"),
    aiClassification: jsonb("ai_classification"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    // --- Phase 2 ---
    fromAddress: text("from_address"), // E.164 or email of the counterpart / sender
    toAddress: text("to_address"),
    threadKey: text("thread_key"), // email Message-ID root / Quo conversation id
    transcript: text("transcript"),
    attachments: jsonb("attachments").$type<{ filename: string; contentType: string; size: number; storageBucket: string; storagePath: string; documentId?: string; ownerOnly?: boolean }[]>(),
    callStatus: text("call_status"),
    durationSeconds: integer("duration_seconds"),
    // Set once AI call extraction (SPEC §9.3) has run on this call's transcript.
    aiExtractedAt: timestamp("ai_extracted_at", { withTimezone: true }),
    triageStatus: triageStatusEnum("triage_status"),
    triageCategory: text("triage_category"),
    // AIRnyc-linked content is stored encrypted here instead of subject/body/transcript (CLAUDE.md rule 5).
    sensitive: boolean("sensitive").notNull().default(false),
    sensitiveEnc: text("sensitive_enc"),
  },
  (t) => [
    index("activities_job_idx").on(t.jobId, t.occurredAt),
    index("activities_contact_idx").on(t.contactId, t.occurredAt),
    index("activities_property_idx").on(t.propertyId, t.occurredAt),
    uniqueIndex("activities_external_uq").on(t.type, t.externalId),
    index("activities_thread_idx").on(t.threadKey),
    index("activities_triage_idx").on(t.triageStatus),
  ],
);

export const tasks = pgTable(
  "tasks",
  {
    ...baseColumns(),
    title: text("title").notNull(),
    description: text("description"),
    dueAt: timestamp("due_at", { withTimezone: true }),
    assignee: uuid("assignee").references(() => profiles.userId, { onDelete: "set null" }),
    status: taskStatusEnum("status").notNull().default("OPEN"),
    source: taskSourceEnum("source").notNull().default("MANUAL"),
    jobId: uuid("job_id").references(() => jobs.id, { onDelete: "cascade" }),
    airnycCaseId: uuid("airnyc_case_id").references(() => airnycCases.id, {
      onDelete: "cascade",
    }),
    bidId: uuid("bid_id"),
    contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "set null" }),
    propertyId: uuid("property_id").references(() => properties.id, { onDelete: "set null" }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [index("tasks_open_idx").on(t.status, t.dueAt)],
);

// ---------------------------------------------------------------------------
// §4.10 Settings (single row, id = 1)
// ---------------------------------------------------------------------------

export type BusinessHours = Record<
  "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun",
  { open: string; close: string } | null
>;

export const settings = pgTable("settings", {
  id: integer("id").primaryKey().default(1),
  autoSendEmail: boolean("auto_send_email").notNull().default(false),
  autoSendSms: boolean("auto_send_sms").notNull().default(false),
  autoCreateInvoice: boolean("auto_create_invoice").notNull().default(false),
  holdReportUntilPaidDefault: boolean("hold_report_until_paid_default").notNull().default(false),
  airnycAiAllowed: boolean("airnyc_ai_allowed").notNull().default(false),
  airnycMode: airnycModeEnum("airnyc_mode").notNull().default("MANUAL"),
  digestRecipients: text("digest_recipients").array().notNull().default(sql`'{}'::text[]`),
  digestTime: time("digest_time").notNull().default("07:30"),
  timezone: text("timezone").notNull().default("America/New_York"),
  businessHours: jsonb("business_hours").$type<BusinessHours>().notNull(),
  driveJobsParentFolderId: text("drive_jobs_parent_folder_id"),
  driveAirnycParentFolderId: text("drive_airnyc_parent_folder_id"),
  driveTemplateFolderId: text("drive_template_folder_id"),
  aiMonthlyCostCapUsd: numeric("ai_monthly_cost_cap_usd", { precision: 10, scale: 2 }),
  // --- Phase 2 ---
  quoSummariesEnabled: boolean("quo_summaries_enabled").notNull().default(false), // Business/Scale plan only
  healthAlertPhone: text("health_alert_phone"), // E.164; Jordan's cell for integration alerts
  healthAlertLineId: uuid("health_alert_line_id"),
  defaultFromEmail: text("default_from_email").notNull().default("sales@ess-nyc.com"),
  airnycSenderDomains: text("airnyc_sender_domains").array().notNull().default(sql`'{}'::text[]`),
  triageConfidenceThreshold: numeric("triage_confidence_threshold", { precision: 3, scale: 2 }).notNull().default("0.75"),
  // --- Phase 3 ---
  digestEnabled: boolean("digest_enabled").notNull().default(true),
  digestSmsEnabled: boolean("digest_sms_enabled").notNull().default(true),
  invoicePaymentTermsDays: integer("invoice_payment_terms_days").notNull().default(30),
  // Jordan's notes on how he writes (tone, sign-off, phrases) — fed to AI reply drafts (SPEC §9.2).
  aiVoiceNotes: text("ai_voice_notes"),
  // Bid ingestion (SPEC §8): listings whose title/description match any of these are kept.
  bidKeywords: text("bid_keywords")
    .array()
    .notNull()
    .default(sql`'{mold,asbestos,lead,"industrial hygiene",environmental,abatement,"hazardous material","air monitoring","air sampling","indoor air",radon,"gas piping","local law 152",parapet,"local law 126","lead-based paint",microbial}'::text[]`),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid("updated_by"),
});

// ---------------------------------------------------------------------------
// Audit log (SPEC §13): AIRnyc reads + all financial changes. Append-only.
// ---------------------------------------------------------------------------

export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    actor: uuid("actor"),
    action: text("action").notNull(), // READ | INSERT | UPDATE | DELETE | BLOCKED
    entity: text("entity").notNull(),
    entityId: text("entity_id"),
    detail: jsonb("detail"),
  },
  (t) => [index("audit_log_entity_idx").on(t.entity, t.entityId, t.at)],
);

// ===========================================================================
// Phase 2 — Communications (SPEC §6.1, §6.3, §9)
// ===========================================================================

/** Which Quo number is which line (SPEC §6.1 "configured in a phone_lines table"). */
export const phoneLines = pgTable("phone_lines", {
  ...baseColumns(),
  quoPhoneNumberId: text("quo_phone_number_id").notNull().unique(), // e.g. PN123…
  number: text("number").notNull(), // E.164
  label: text("label").notNull(), // "ESS main", "Gas Pro", "AIRnyc line"
  lineKey: text("line_key").notNull(), // stored on activities.channel_line
  brand: brandEnum("brand").notNull().default("ESS"),
  missedCallTextback: boolean("missed_call_textback").notNull().default(false),
});

/** Provider webhook deliveries — the dedupe ledger (CLAUDE.md rule 7). */
export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider: text("provider").notNull(), // QUO | FRESHBOOKS | AIRNYC | DOCUSIGN
    deliveryId: text("delivery_id").notNull(),
    eventType: text("event_type"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    error: text("error"),
    payload: jsonb("payload"),
  },
  (t) => [uniqueIndex("webhook_deliveries_uq").on(t.provider, t.deliveryId)],
);

export const messageTemplates = pgTable("message_templates", {
  ...baseColumns(),
  key: text("key").notNull().unique(), // APPOINTMENT_CONFIRMATION, MISSED_CALL, …
  name: text("name").notNull(),
  channel: outboundChannelEnum("channel").notNull(),
  brand: brandEnum("brand"),
  subject: text("subject"),
  // Tokens: {{first_name}}, {{job_number}}, {{address}}, {{scheduled_date}}, {{scheduled_time}}, {{brand_name}}, {{brand_phone}}
  body: text("body").notNull(),
  active: boolean("active").notNull().default(true),
});

/** Every outbound SMS/email starts as a row here: draft → approve → send (CLAUDE.md rule 6). */
export const outboundMessages = pgTable(
  "outbound_messages",
  {
    ...baseColumns(),
    channel: outboundChannelEnum("channel").notNull(),
    status: outboundStatusEnum("status").notNull().default("DRAFT"),
    source: outboundSourceEnum("source").notNull().default("MANUAL"),
    templateKey: text("template_key"),
    toAddress: text("to_address").notNull(), // E.164 or email
    fromLineId: uuid("from_line_id").references(() => phoneLines.id, { onDelete: "set null" }),
    fromEmail: text("from_email"),
    subject: text("subject"),
    body: text("body").notNull(),
    inReplyTo: text("in_reply_to"),
    brand: brandEnum("brand").notNull().default("ESS"),
    contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "set null" }),
    jobId: uuid("job_id").references(() => jobs.id, { onDelete: "set null" }),
    airnycCaseId: uuid("airnyc_case_id").references(() => airnycCases.id, { onDelete: "set null" }),
    replyToActivityId: uuid("reply_to_activity_id"),
    approvedBy: uuid("approved_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    externalId: text("external_id"),
    error: text("error"),
    // Contains pricing → only the OWNER may approve (SPEC §9.2).
    containsPricing: boolean("contains_pricing").notNull().default(false),
  },
  (t) => [index("outbound_status_idx").on(t.status, t.createdAt)],
);

/** IMAP listener state per mailbox/folder + health (SPEC §6.3). */
export const mailSyncState = pgTable(
  "mail_sync_state",
  {
    mailbox: text("mailbox").notNull(),
    folder: text("folder").notNull(),
    uidValidity: text("uid_validity"),
    lastUid: integer("last_uid").notNull().default(0),
    lastConnectedAt: timestamp("last_connected_at", { withTimezone: true }),
    lastOkAt: timestamp("last_ok_at", { withTimezone: true }),
    lastError: text("last_error"),
    lastAlertAt: timestamp("last_alert_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.mailbox, t.folder] })],
);

/** SPEC §9.8: every AI call (or blocked attempt) with model, tokens, cost, feature, job. */
export const aiCalls = pgTable(
  "ai_calls",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    feature: text("feature").notNull(), // TRIAGE | CALL_EXTRACT | DRAFT_REPLY …
    model: text("model").notNull(),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    costUsd: numeric("cost_usd", { precision: 10, scale: 5 }),
    jobId: uuid("job_id"),
    activityId: uuid("activity_id"),
    airnycLinked: boolean("airnyc_linked").notNull().default(false),
    redacted: boolean("redacted").notNull().default(false),
    blocked: text("blocked"), // reason when the wrapper refused to call
    error: text("error"),
  },
  (t) => [index("ai_calls_at_idx").on(t.at)],
);

// ===========================================================================
// Phase 3 — Money (SPEC §6.2, §9.7)
// ===========================================================================

export const clientMatchStatusEnum = pgEnum("client_match_status", ["PENDING", "LINKED", "CREATED", "IGNORED"]);

/** FreshBooks OAuth connection (single row). Tokens are AES-GCM encrypted; OWNER only. */
export const freshbooksConnection = pgTable("freshbooks_connection", {
  id: integer("id").primaryKey().default(1),
  accountId: text("account_id").notNull(),
  businessId: text("business_id"),
  businessName: text("business_name"),
  accessTokenEnc: text("access_token_enc").notNull(),
  refreshTokenEnc: text("refresh_token_enc").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  scopes: text("scopes"),
  connectedBy: uuid("connected_by"),
  lastRefreshAt: timestamp("last_refresh_at", { withTimezone: true }),
  lastError: text("last_error"),
  // callbackId → { event, verified, verifierEnc }. Each callback's verifier (sent during the
  // handshake) is also the HMAC key FreshBooks signs that callback's deliveries with.
  webhookCallbacks: jsonb("webhook_callbacks").$type<Record<string, { event: string; verified: boolean; verifierEnc?: string }>>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Initial FreshBooks client import + duplicate review (SPEC §6.2). */
export const freshbooksClients = pgTable("freshbooks_clients", {
  freshbooksClientId: text("freshbooks_client_id").primaryKey(),
  organization: text("organization"),
  firstName: text("first_name"),
  lastName: text("last_name"),
  email: text("email"),
  phone: text("phone"),
  matchStatus: clientMatchStatusEnum("match_status").notNull().default("PENDING"),
  suggestedOrgId: uuid("suggested_org_id").references(() => organizations.id, { onDelete: "set null" }),
  suggestedContactId: uuid("suggested_contact_id").references(() => contacts.id, { onDelete: "set null" }),
  matchReason: text("match_reason"),
  linkedOrgId: uuid("linked_org_id").references(() => organizations.id, { onDelete: "set null" }),
  linkedContactId: uuid("linked_contact_id").references(() => contacts.id, { onDelete: "set null" }),
  raw: jsonb("raw"),
  importedAt: timestamp("imported_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** FreshBooks payments (OWNER only). */
export const paymentsCache = pgTable("payments_cache", {
  freshbooksPaymentId: text("freshbooks_payment_id").primaryKey(),
  freshbooksInvoiceId: text("freshbooks_invoice_id"),
  jobId: uuid("job_id").references(() => jobs.id, { onDelete: "set null" }),
  amount: numeric("amount", { precision: 12, scale: 2 }),
  paidOn: date("paid_on"),
  type: text("type"),
  deleted: boolean("deleted").notNull().default(false),
  raw: jsonb("raw"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Daily digest runs (idempotency: one per NY date). */
export const digestRuns = pgTable("digest_runs", {
  runDate: date("run_date").primaryKey(),
  sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
  recipients: text("recipients").array(),
  summary: jsonb("summary"),
  error: text("error"),
});

// ---------------------------------------------------------------------------
// Phase 4a — compliance calendar & credentials (SPEC §6.6, §4.8, §10)
// ---------------------------------------------------------------------------

/** Entered and maintained by Jordan — legal cycles are never hard-coded (SPEC §6.6). */
export const complianceRules = pgTable("compliance_rules", {
  ...baseColumns(),
  serviceCode: serviceCodeEnum("service_code").notNull().unique(),
  // null → no automatic date; the worker asks for the next cycle to be set by hand.
  cycleMonths: integer("cycle_months"),
  leadTimeDays: integer("lead_time_days").notNull().default(60),
  notes: text("notes"),
  active: boolean("active").notNull().default(true),
});

/** ESS's own licenses and certifications. */
export const credentials = pgTable("credentials", {
  ...baseColumns(),
  name: text("name").notNull(),
  number: text("number"),
  issuer: text("issuer"),
  expiresAt: date("expires_at"),
  filePath: text("file_path"),
  notes: text("notes"),
});

/** Subcontractor details (rates live in sub_costs, OWNER only — see DECISIONS.md). */
export const subProfiles = pgTable("sub_profiles", {
  orgId: uuid("org_id")
    .primaryKey()
    .references(() => organizations.id, { onDelete: "cascade" }),
  trades: text("trades").array().notNull().default(sql`'{}'::text[]`),
  licenseNumbers: jsonb("license_numbers").$type<Record<string, string>>().notNull().default({}),
  insuranceExpires: date("insurance_expires"),
  coiPath: text("coi_path"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const expirySubjectEnum = pgEnum("expiry_subject", ["CREDENTIAL", "SUB_COI"]);

/** One row per alert raised (60/30/7 days, and expired), so each fires once per expiry date. */
export const expiryAlerts = pgTable(
  "expiry_alerts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    subjectType: expirySubjectEnum("subject_type").notNull(),
    subjectId: uuid("subject_id").notNull(),
    expiresOn: date("expires_on").notNull(),
    thresholdDays: integer("threshold_days").notNull(),
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("expiry_alerts_once").on(t.subjectType, t.subjectId, t.expiresOn, t.thresholdDays)],
);

/** Quote builder inputs, per job (OWNER only via job_financials). */
export type QuoteInputs = {
  sqft?: number | null;
  samples?: number | null;
  extras?: { description: string; quantity: number; unitPrice: number }[];
  scope?: string | null;
  validDays?: number | null;
};

/** Jordan's pricing rules per service (SPEC §10). OWNER only — never visible to VAs or subs. */
export const pricingRules = pgTable("pricing_rules", {
  ...baseColumns(),
  serviceCode: serviceCodeEnum("service_code").notNull().unique(),
  baseAmount: numeric("base_amount", { precision: 12, scale: 2 }).notNull(),
  includedSqft: integer("included_sqft").notNull().default(0),
  perSqft: numeric("per_sqft", { precision: 12, scale: 4 }),
  includedSamples: integer("included_samples").notNull().default(0),
  perSample: numeric("per_sample", { precision: 12, scale: 2 }),
  minimumAmount: numeric("minimum_amount", { precision: 12, scale: 2 }),
  defaultScope: text("default_scope"),
  notes: text("notes"),
  active: boolean("active").notNull().default(true),
});

export type FieldReading = { area: string; moisture?: string | null; rh?: string | null; temp?: string | null; note?: string | null };
export type FieldPhoto = { path: string; caption: string; area?: string | null; contentType: string; width?: number; height?: number };

// ---------------------------------------------------------------------------
// Phase 5 — government bids (SPEC §8, §9.6)
// ---------------------------------------------------------------------------

export const bidTypeEnum = pgEnum("bid_type", ["RFP", "RFQ", "RFB", "IFB", "OTHER"]);
export const bidRoleEnum = pgEnum("bid_role", ["PRIME", "SUB"]);
export const bidStatusEnum = pgEnum("bid_status", ["WATCHING", "GO_NO_GO", "DRAFTING", "SUBMITTED", "AWARDED", "LOST", "NO_BID"]);
export const bidSourceEnum = pgEnum("bid_source", ["MANUAL", "NYSCR", "CITY_RECORD", "PASSPORT", "COUNTY", "EMAIL"]);

export type GoNoGo = {
  recommendation: "GO" | "NO_GO" | "REVIEW";
  summary: string;
  checklist: { item: string; status: "MET" | "GAP" | "UNKNOWN"; note: string }[];
  submission: string[];
  model?: string;
  at?: string;
};

export const bids = pgTable(
  "bids",
  {
    ...baseColumns(),
    agency: text("agency"),
    solicitationNumber: text("solicitation_number"),
    title: text("title").notNull(),
    type: bidTypeEnum("type").notNull().default("OTHER"),
    primeEntity: text("prime_entity").notNull().default("ESS"),
    role: bidRoleEnum("role").notNull().default("PRIME"),
    questionsDue: timestamp("questions_due", { withTimezone: true }),
    dueAt: timestamp("due_at", { withTimezone: true }),
    openingAt: timestamp("opening_at", { withTimezone: true }),
    siteVisitAt: timestamp("site_visit_at", { withTimezone: true }),
    buyerName: text("buyer_name"),
    buyerEmail: text("buyer_email"),
    buyerPhone: text("buyer_phone"),
    requiredCerts: text("required_certs").array().notNull().default(sql`'{}'::text[]`),
    certGaps: text("cert_gaps").array().notNull().default(sql`'{}'::text[]`),
    insuranceRequirements: text("insurance_requirements"),
    scope: text("scope"),
    status: bidStatusEnum("status").notNull().default("WATCHING"),
    source: bidSourceEnum("source").notNull().default("MANUAL"),
    sourceUrl: text("source_url"),
    externalId: text("external_id"),
    goNoGo: jsonb("go_no_go").$type<GoNoGo>(),
    decision: text("decision"), // GO | NO_GO (a person's call; the AI only recommends)
    decidedBy: uuid("decided_by"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    notes: text("notes"),
  },
  (t) => [uniqueIndex("bids_source_external_uq").on(t.source, t.externalId), index("bids_due_idx").on(t.dueAt)],
);

// ---------------------------------------------------------------------------
// Phase 5 — subcontractor portal views (defined in migration 0018; SUB reads only these)
// ---------------------------------------------------------------------------
export const subPortalJobs = pgView("sub_portal_jobs", {
  id: uuid("id").notNull(),
  jobNumber: text("job_number").notNull(),
  serviceCode: serviceCodeEnum("service_code").notNull(),
  stage: text("stage").notNull(),
  scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
  fieldCompletedAt: timestamp("field_completed_at", { withTimezone: true }),
  addressLine: text("address_line"),
  unit: text("unit"),
  borough: text("borough"),
  zip: text("zip"),
}).existing();

export const subPortalDocuments = pgView("sub_portal_documents", {
  id: uuid("id").notNull(),
  jobId: uuid("job_id").notNull(),
  title: text("title"),
  version: integer("version").notNull(),
  status: documentStatusEnum("status").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  storageBucket: text("storage_bucket"),
  storagePath: text("storage_path"),
}).existing();
