# ESS CRM — Product & Technical Specification

Version 1.0 · September 24, 2026 · Owner: Jordan Adhami, Environmental Safeguard Solutions

---

## 1. Purpose

ESS runs every job across disconnected tools: Quo (phone/SMS), Titan (email), FreshBooks (invoicing),
Google Sheets trackers, Google Drive folders, and the AIRnyc SharePoint portal. This CRM follows a job
from **first contact → proposal → field work → lab → report → invoice → payment → next compliance
cycle** in one place.

Design principle: the CRM is built around **properties and compliance work**, not generic "deals."

### Business lines the system must support

| Code | Service | Notes |
|---|---|---|
| MOLD_ASSESS | Mold assessment | Air/surface sampling, EMSL lab, NYS assessor license |
| MOLD_PLAN | Mold remediation work plan | Often tied to HPD violations |
| MOLD_CLEAR | Post-remediation clearance | |
| LEAD_RA | Lead risk assessment / inspection | EPA licenses |
| LEAD_CLEAR | Lead dust wipe clearance | |
| LEAD_WATER | Lead in drinking water | |
| ASB_SURVEY | Asbestos survey / bulk sampling | Sometimes field work by a partner firm |
| LL152 | Gas piping inspection | Gas Pro Inspectors brand |
| LL126 | Parapet inspection | Portfolio clients (e.g., management cos with ~100 buildings) |
| LL31 | Lead paint compliance | |
| VIOLATION | HPD/DOB violation support | |
| AIRNYC | AIRnyc SCN referral case | Medicaid-funded; separate pipeline (§7) |
| BID | Government RFP/RFQ/RFB | Separate pipeline (§8) |

Brands: **ESS** and **Gas Pro Inspectors** (subsidiary). Every contact, job, phone line, and outbound
message carries a `brand` field.

---

## 2. Users & roles

| Role | Can see | Cannot see |
|---|---|---|
| OWNER (Jordan) | Everything | — |
| VA | Contacts, properties, jobs, tasks, documents, AIRnyc cases, message drafts | Prices, invoices, job profitability, sub rates |
| FIELD | Assigned jobs, property info, field data entry, photos | Prices, other jobs |
| SUB (subcontractor portal, Phase 5) | Only jobs assigned to them; "sub copy" scope documents | All pricing, client billing, consent forms, other subs |

Enforce with Supabase row-level security. Financial data lives in separate tables (`job_financials`,
`invoices_cache`, `sub_costs`) readable only by OWNER.

---

## 3. Architecture

```
            ┌────────────── Vercel ──────────────┐
 Browser ──▶│ Next.js app (UI + API routes)      │
            │  /api/webhooks/quo                 │◀── Quo webhooks
            │  /api/webhooks/freshbooks          │◀── FreshBooks webhooks
            │  /api/webhooks/airnyc (future)     │◀── Power Automate (if approved)
            └──────────────┬─────────────────────┘
                           │ Postgres (Supabase) + Storage
            ┌──────────────┴─────────────────────┐
            │ Worker (Railway / Fly.io)          │
            │  • Titan IMAP IDLE listener        │──▶ imap.titan.email
            │  • pg-boss job consumers           │──▶ Anthropic API, NYC Open Data,
            │  • schedulers (digest, reminders)  │    FreshBooks, Quo, Google Drive
            └────────────────────────────────────┘
```

Why a separate worker: Vercel functions are short-lived and cannot hold an IMAP connection open.
Everything slow or retry-prone (AI calls, Open Data enrichment, FreshBooks sync) goes through the queue.

---

## 4. Data model

All tables have `id (uuid)`, `created_at`, `updated_at`, `created_by`. Soft-delete via `archived_at`.

### 4.1 Properties (the anchor)
`properties`: `bbl` (unique, nullable until resolved), `bin`, `address_line`, `unit`, `borough`,
`zip`, `lat`, `lng`, `building_class`, `units_res`, `year_built`, `owner_name` (from PLUTO/HPD),
`hpd_registration_id`, `management_org_id`, `is_nycha` (flag — landlord-consent risk), `notes`.

Address entry → resolve BBL/BIN via NYC Planning **GeoSearch** (or Geoclient) → enrich (§6.5).

`property_violations`: cached HPD/DOB/ECB violations per property (`source`, `violation_id`, `class`,
`order_number`, `status`, `issued_date`, `description`, `raw jsonb`).

### 4.2 Organizations & contacts
`organizations`: `name`, `type` (OWNER, MANAGEMENT_CO, REFERRAL_PARTNER, GOV_AGENCY, SUBCONTRACTOR,
LAB, OTHER), `brand`, `freshbooks_client_id`, `website`, `notes`.

`contacts`: `first_name`, `last_name`, `org_id`, `title`, `emails[]`, `phones[]` (E.164),
`quo_contact_id`, `preferred_channel`, `do_not_contact`, `source` (web form, Quo, email, mailer
campaign, referral, bid), `campaign_id`.

`property_roles`: many-to-many — `property_id`, `contact_id` / `org_id`, `role` (OWNER, MANAGER,
TENANT, SUPER, BROKER), `active`.

### 4.3 Jobs
`jobs`: `job_number` (ESS-YYYY-####), `brand`, `service_code`, `property_id`, `client_org_id`,
`client_contact_id`, `stage` (per-pipeline, §5), `priority`, `source`, `scheduled_at`,
`field_completed_at`, `delivered_at`, `drive_folder_url`, `assigned_to`, `sub_org_id`,
`hpd_violation_ref`, `airnyc_case_id` (nullable FK), `next_cycle_due` (§6.6).

`job_financials` (OWNER only): `quoted_amount`, `line_items jsonb`, `sub_cost`, `lab_cost`,
`other_cost`, `freshbooks_estimate_id`, `freshbooks_invoice_id`, `invoice_status`, `amount_paid`,
`paid_at`, computed `gross_margin`.

`field_data`: per job — `readings jsonb` (moisture, RH, temp), `observations`, `photos[]` (storage
paths + captions + area), `areas[]`.

### 4.4 Samples & lab
`samples`: `job_id`, `sample_id`, `type` (AIR, SWAB, TAPE, BULK, DUST_WIPE, WATER), `location`,
`lab_org_id` (EMSL default), `coc_number`, `submitted_at`, `results_received_at`, `result_pdf_path`,
`results jsonb`, `status` (COLLECTED, SUBMITTED, RESULTS_IN, REVIEWED).

### 4.5 Documents
`documents`: `job_id`, `kind` (PROPOSAL, REPORT, WORK_PLAN, SUB_COPY, CLEARANCE, INVOICE_PDF,
CONSENT, LAB_RESULT, PHOTO_LOG, OTHER), `version`, `storage_path`, `drive_file_id`, `status`
(DRAFT, QA, FINAL, SENT, SIGNED), `contains_pricing` (bool — never exposed to SUB/VA if true).

### 4.6 Activity timeline (unified)
`activities`: `type` (CALL, SMS, EMAIL_IN, EMAIL_OUT, NOTE, STAGE_CHANGE, DOC, PAYMENT, SYSTEM),
`direction`, `contact_id`, `property_id`, `job_id`, `airnyc_case_id`, `bid_id`, `brand`,
`channel_line` (which Quo number / which mailbox), `subject`, `body`, `summary`, `next_steps[]`,
`external_id`, `external_url` (e.g., Quo deep link), `raw jsonb`, `ai_classification`.

### 4.7 Tasks
`tasks`: `title`, `description`, `due_at`, `assignee`, `status`, `source` (MANUAL, QUO_NEXT_STEP,
EMAIL_AI, SYSTEM_RULE), `linked job/case/bid/contact`.

### 4.8 Subcontractors & credentials
`sub_profiles`: `org_id`, `trades[]`, `license_numbers jsonb`, `insurance_expires`, `coi_path`,
`default_rates jsonb` (OWNER only), scorecard fields (§10).

`credentials`: ESS's own licenses/certs — `name`, `number`, `issuer`, `expires_at`, `file_path`.
Seed with Jordan's EPA risk assessor, EPA firm, and NYS mold assessor licenses.

### 4.9 Campaigns
`campaigns`: `name`, `brand`, `channel` (DIRECT_MAIL, EMAIL, WEB, DOOR_TO_DOOR), `sent_count`,
`cost`, `tracking` (QR slug, dedicated Quo number, landing URL). Leads link back via `campaign_id`.

### 4.10 Settings
`settings` (single row): `auto_send_email`, `auto_send_sms`, `auto_create_invoice`,
`hold_report_until_paid_default`, `airnyc_ai_allowed` (default false), `airnyc_mode`
(MANUAL | EMAIL | POWER_AUTOMATE | GRAPH), digest recipients, business hours.

---

## 5. Pipelines

Stages are configurable per service in a `pipelines` table; seed with these defaults.

**Inspection / assessment jobs**
Lead → Qualified → Proposal Sent → Signed → Scheduled → Field Complete → Lab Pending → Drafting →
QA → Delivered → Invoiced → Paid → Closed (→ Next Cycle Scheduled)

**Work plans / violation support**
Lead → Proposal Sent → Signed → Site Visit → Drafting → Submitted to Agency → Agency Response → Closed

**Lost** is reachable from any open stage with a required `lost_reason`.

Rules:
- A job cannot enter **Delivered** without a FINAL report document.
- Entering **Lab Pending** requires ≥1 sample in SUBMITTED status.
- Entering **Delivered** triggers the FreshBooks invoice draft (§6.2).
- Any job idle in one stage longer than its `stale_after_days` appears in the digest.

---

## 6. Integrations

> Claude Code: confirm every endpoint, header, and event name against current official docs.

### 6.1 Quo (phone + SMS)

- Base URL `https://api.quo.com`; dated versioning via the `Quo-Api-Version` header (current docs
  reference `2026-03-30`). API key in env.
- **Webhooks to subscribe:** `message.received`, `message.delivered` (if available), `call.completed`,
  `call.recording.completed`, `call.summary.completed`, `call.transcript.completed`, `contact.updated`.
- **Handler behavior**
  - Verify signature using the webhook signing secret; dedupe on the `webhook-id` header; events may
    arrive out of order — upsert by call/message ID.
  - Match counterpart phone → `contacts.phones`. No match → create a Lead contact + task "New
    inbound — qualify."
  - Tag `channel_line` by which Quo number was involved (ESS main, Gas Pro, AIRnyc line, etc.) —
    configured in a `phone_lines` table.
  - Store Quo deep link (`data.links.quo`) as `activities.external_url`.
  - `call.summary.completed`: store summary; each `nextSteps` item → Task (source QUO_NEXT_STEP).
  - `call.transcript.completed`: store transcript text (searchable), then enqueue AI extraction (§9).
  - Note: summaries/transcripts require a Quo Business or Scale plan — feature-flag them.
- **Outbound:** send SMS from a job/contact page via templates (appointment confirmation, access
  instructions, "lab results in," "report ready," review request). Draft → approve unless
  `auto_send_sms`.
- **Missed-call text-back** (configurable per line, business hours aware).
- **Contact sync:** push new CRM contacts to Quo; pull `contact.updated`.
- **Lead response SLA:** unanswered inbound lead > 24h → "Going cold" list + digest.

### 6.2 FreshBooks (invoicing)

- OAuth 2.0 app (authorization code flow). Store refresh token encrypted; handle token rotation
  (refresh tokens may be single-use — persist the new one each refresh).
- **Client sync:** CRM organization/contact ↔ FreshBooks client (`freshbooks_client_id`). Initial
  import of existing FreshBooks clients with a match-review screen for duplicates.
- **Estimates:** optional — a signed proposal can create a FreshBooks estimate.
- **Invoices:** job enters Delivered → create DRAFT invoice with property address + service line
  items from `job_financials.line_items`. Sending remains manual unless `auto_create_invoice`.
- **Webhooks:** subscribe to invoice and payment events (e.g., `invoice.create`, `invoice.update`,
  `payment.create`, `payment.update`) and client events. Complete FreshBooks' webhook verification
  handshake on registration. Payment → update `job_financials`, move job to Paid, fire review-request
  task.
- **Hold report until paid:** per client/job flag; report stays in QA-approved state and is released
  automatically on payment.
- **Reports (OWNER only):** A/R aging by client type (private, management co, AIRnyc, government);
  revenue, sub cost, lab cost, and margin by service code and by month.

### 6.3 Titan email (IMAP/SMTP)

Jordan keeps Titan. Titan blocks third-party IMAP when 2FA is on, so:
- Create a **dedicated mailbox** (e.g., `crm@ess-nyc.com`) with third-party access enabled and a long
  random password stored as a secret. Main mailboxes keep 2FA on and forward/copy to it.
- **Worker listener:** IMAP `imap.titan.email:993` (SSL) using IDLE; fall back to polling every 60s;
  reconnect with backoff. Track `UIDVALIDITY` + last UID to avoid reprocessing.
- **Processing per message:** parse (mailparser) → store as `activities` (EMAIL_IN) → match sender to
  contact/org → attach to job by thread, job number in subject, address, or case ID → save
  attachments to storage and the job's Drive folder → enqueue AI classification (§9.1).
- **Special parsers:**
  - EMSL results: match chain-of-custody number → attach PDF to `samples`, mark RESULTS_IN, move job
    to Drafting, notify Jordan.
  - AIRnyc notifications: detect case IDs (`PHS_`, `Emblem_`, `SIPPS_`, etc.) → create/update case.
  - Bid notices: addenda, Q&A, deadline changes → attach to `bids`.
- **Sending:** SMTP `smtp.titan.email:465` (SSL) or 587 (STARTTLS); after send, IMAP APPEND the
  message into the Sent folder so Titan stays the full record. Test early whether the CRM mailbox can
  send as `sales@ess-nyc.com`.
- **Calendar (Phase 4):** Titan CalDAV for inspection appointments (confirm the CalDAV URL in Titan
  settings).
- **Health check:** if IMAP auth fails or no connection for 15 min → SMS Jordan via Quo.

### 6.4 Google Drive (job folders)

- On job creation, clone the folder template into the correct parent and store `drive_folder_url`.
- Naming: `{JOB_NUMBER}_{ClientLastName}_{Address}`; AIRnyc: `{AIRNYC_ID}_{LastName}_{Address}`.
- Final documents are uploaded to Drive as well as Supabase storage.

### 6.5 NYC Open Data enrichment

On property create (and nightly for active properties), pull and cache:
- HPD Violations (`wvxf-dwi5`), HPD Registrations (`tesw-yqqr`), HPD Registration Contacts
  (`feu5-w2e2`), PLUTO (`64uk-42ks`), DOB Violations (`3h2n-5cm9`), DOB/ECB Violations (`6bgk-3dad`).
  Verify dataset IDs; use a Socrata app token.
- New violation on a property with an active relationship → alert + draft outreach task. This is the
  engine that can later power **CityWatch** (citywatch.ess-nyc.com) as a paid monitoring product.

### 6.6 Compliance calendar

- `compliance_rules` table, **entered and maintained by Jordan** (do not hardcode legal cycles):
  `service_code`, `cycle_months` or rule expression, `lead_time_days`, `notes`.
- When a job closes, compute `next_cycle_due` and schedule outreach tasks at the lead time.
- Calendar view of upcoming cycles by client and by borough.

### 6.7 DocuSign (Phase 4)

Send proposals for signature; `envelope completed` → attach signed PDF, move job to Signed.

### 6.8 AIRnyc SharePoint — see §7.4.

---

## 7. AIRnyc SCN cases

### 7.1 Case record
`airnyc_cases`: `case_id` (e.g., PHS_0148 — prefix indicates network), `network` (PHS, EMBLEM, SIPPS,
…), `member_name`, `guardian_name`, `member_phone`, `address`, `property_id`, `case_manager_name`,
`case_manager_email`, `approved_services[]` (e.g., 2.2a Mold, 2.3b Asthma Remediation),
`tracker_row` (row # in AIRnyc tracker), `landlord_consent_status`, `tenant_consent_status`,
`is_nycha`, `qc_reviewer`, `qc_status`, `sharepoint_folder_url`, `stage`, `job_id`.

All member fields encrypted at rest (pgcrypto or Supabase Vault); every read logged to `audit_log`.

### 7.2 Pipeline
Referral Received → Member Contacted → Consent (tenant/landlord) → Assessment Scheduled → Assessment
Done → Report Drafted → Submitted for QC → QC Revisions → Approved → Sub Copy Sent → Remediation
Scheduled → Remediation Done → Clearance → Closeout Docs Uploaded → Invoiced → Paid.

Flags: NYCHA building (consent risk), approved services don't cover recommended scope, out-of-scope
observations (pests, etc.) requiring separate referral.

### 7.3 Upload checklist
Per stage, a checklist of what must be posted to AIRnyc (report, photos, consent forms, invoice,
clearance) with required file names. VA ticks items off; CRM generates correctly named files.

### 7.4 Connection modes (`settings.airnyc_mode`)
1. **MANUAL (build first):** case created by VA; SharePoint folder link stored; upload checklist.
2. **EMAIL:** parse AIRnyc notification emails into cases (§6.3).
3. **POWER_AUTOMATE:** AIRnyc's IT configures a flow on the ESS folder that POSTs to
   `/api/webhooks/airnyc` (shared-secret header).
4. **GRAPH:** Microsoft Graph with access scoped to the ESS folder/tracker only, via an app registered
   in an ESS Microsoft Entra tenant and approved by AIRnyc IT.

Modes 3–4 require written approval from AIRnyc. Build the module behind an interface so modes are
swappable without touching case logic. Never automate a browser login to their portal.

---

## 8. Government bids

`bids`: `agency`, `solicitation_number`, `title`, `type` (RFP, RFQ, RFB, IFB), `prime_entity` (ESS or
partner), `role` (PRIME, SUB), `questions_due`, `due_at`, `opening_at`, `buyer_name`, `buyer_email`,
`required_certs[]`, `cert_gaps[]`, `insurance_requirements`, `status` (Watching, Go/No-Go, Drafting,
Submitted, Awarded, Lost), `documents`.

Pipeline with countdown badges; digest lists anything due within 7 days. Phase 5: ingest listings
from NYS Contract Reporter and county procurement sites; AI-assisted go/no-go (§9.6).

---

## 9. AI layer (Anthropic API)

Models (confirm current names in Anthropic docs): `claude-haiku-4-5-20251001` for high-volume
classification/extraction; `claude-sonnet-5` for drafting; `claude-opus-5-5` for complex report
drafting if quality demands it. Keep model names in config, not code.

### 9.1 Email & message triage
Classify every inbound email/SMS: NEW_LEAD, EXISTING_JOB, LAB_RESULT, INVOICE_QUESTION, BID_NOTICE,
AIRNYC, VENDOR, SPAM, OTHER. Output strict JSON: `{category, confidence, job_match_hints, address,
service_code, urgency, summary}`. Low confidence → human review queue.

### 9.2 Drafted replies
Given the thread + job context (stage, schedule, non-confidential details), draft a reply in Jordan's
voice. Always DRAFT; never includes pricing unless OWNER is the approver.

### 9.3 Call extraction
From Quo transcripts: property address, service needed, urgency, promised follow-ups → fill fields,
create tasks.

### 9.4 Redaction (required)
`lib/ai/redact.ts` replaces member names, DOBs, phone numbers, case IDs, and addresses with tokens
before any AIRnyc-linked text leaves the system, and re-inserts them after. Enforced centrally in the
Anthropic client wrapper: if the payload is AIRnyc-linked and `airnyc_ai_allowed = false`, the call
is blocked and logged.

### 9.5 Report drafting (Phase 4)
Inputs: field data, photos + captions, sample results, service template. Output: section-by-section
draft into the ESS DOCX template. Jordan reviews every report; nothing is finalized by AI.

### 9.6 Natural-language search & bid analysis (Phase 5)
- "Which management companies haven't paid in 60 days?" → generated SQL against a read-only role
  scoped to the asker's permissions.
- Upload an RFP PDF → extract deadlines, required certs, insurance, scope → go/no-go checklist
  against `credentials`.

### 9.7 Daily digest
Weekday 7:30 AM email + short SMS: stale jobs, lab results waiting, unpaid invoices by age, bids due
within 7 days, going-cold leads, expiring licenses/COIs, compliance cycles coming due.

### 9.8 Guardrails
Log every AI call (model, tokens, cost, feature, job ID). Monthly cost cap setting. No AI output is
sent externally without approval while `auto_send_*` is off.

---

## 10. Documents & operations

- **Template rendering:** docxtemplater with ESS templates in `/templates` (ESS_Header.docx etc.).
- **Sub copy generator:** from a report, produce a version with all pricing, funding references,
  signature blocks, and consent forms removed; in-scope work and work-area photos kept. Validate by
  scanning output text for `$`, "price," "cost," "invoice," "funding" before release.
- **Quote builder (Phase 4):** pricing rules by service, sq ft, sample count; compare sub quotes side
  by side; output ESS-branded proposal (client-signature-only block).
- **Field view (mobile-friendly):** readings, observations, sample IDs, photos with area tags.
- **Route planning (Phase 5):** order a day's scheduled inspections by drive time.
- **Sub scorecards:** turnaround, callbacks, clearance pass rate, insurance status.
- **Credential alerts:** 60/30/7 days before any ESS license or sub COI expires.

---

## 11. Sales & marketing

- Web form on ess-nyc.com → `/api/leads` → contact + property + job (Lead) → auto SMS acknowledgment
  (draft by default) + task.
- Campaign attribution via QR slugs, dedicated Quo numbers, landing URLs.
- Prospect lists: import CSVs from Open Data pulls (LL152 violations, HPD management companies,
  condo/co-op scoring) as `prospects` with score, and convert to contacts on engagement.
- Review request SMS after Paid.
- **Management-company account view:** all buildings, open violations, jobs, invoices, next cycles.

---

## 12. Build phases & acceptance criteria

### Phase 1 — Foundation
- Supabase schema + migrations for §4 core tables; RLS for OWNER / VA roles.
- Auth (email magic link) for Jordan + VA.
- Properties with GeoSearch BBL resolution + Open Data enrichment (§6.5).
- Contacts, organizations, jobs, pipelines (§5) with Kanban and list views; tasks.
- Google Drive folder creation.
- Settings page.
**Done when:** Jordan can create a property from an address, see its HPD/DOB violations, create a job,
move it through stages with rules enforced, and a VA account cannot read any financial table (tested).

### Phase 2 — Communications
- Quo webhooks + timeline + tasks from next steps + SMS templates + missed-call text-back.
- Titan worker (IMAP IDLE, parsing, attachment storage, SMTP send + Sent append, health alert).
- EMSL results parser.
- AI triage (§9.1) with review queue; redaction wrapper (§9.4) in place from day one.
**Done when:** a test call, SMS, and email each appear on the right contact's timeline within 60
seconds; duplicate webhook deliveries create no duplicate records; an EMSL test email attaches to the
right sample.

### Phase 3 — Money
- FreshBooks OAuth, client sync with duplicate review, invoice drafts on Delivered, payment webhooks,
  hold-until-paid, A/R aging and margin reports.
- Daily digest (§9.7).
**Done when:** marking a test job Delivered creates a correct draft invoice in FreshBooks, and a test
payment moves the job to Paid.

### Phase 4 — Documents & AI drafting
- DOCX template rendering, sub copy generator with validation, quote builder.
- AI reply drafts, call extraction, report drafting.
- Compliance calendar, credential alerts, DocuSign, Titan calendar.

### Phase 5 — Growth
- AIRnyc modes 2–4 (once approved), sub portal, bid ingestion + go/no-go, natural-language search,
  route planning, campaign attribution, CityWatch monitoring, MCP server exposing read-only CRM
  queries to Claude.

AIRnyc MANUAL mode (§7.4 mode 1) ships in Phase 1 alongside jobs.

---

## 13. Non-functional requirements

- **Security:** RLS on every table; secrets in host secret stores; encrypted member fields;
  `audit_log` for reads of AIRnyc data and all financial changes; 2FA on the CRM login for OWNER.
- **Reliability:** all integrations retry with exponential backoff via pg-boss; dead-letter queue
  visible in an admin page; webhook signature verification required.
- **Backups:** Supabase daily backups + weekly export of core tables to Drive.
- **Mobile:** all core screens usable on a phone (field use).
- **Observability:** error tracking (Sentry), integration health page (last successful Quo event,
  IMAP connection, FreshBooks token age).

---

## 14. Open items (Jordan to confirm)

1. Quo plan tier (summaries/transcripts need Business or Scale).
2. Create `crm@ess-nyc.com` in Titan with third-party access; confirm send-as for sales@.
3. FreshBooks account owner access to authorize the OAuth app.
4. Provide DOCX templates and current pricing sheet.
5. Compliance cycle rules for each service (§6.6).
6. AIRnyc response on access mode and data-handling terms (controls `airnyc_mode` and
   `airnyc_ai_allowed`).
7. Which Quo numbers map to which brand/line.
