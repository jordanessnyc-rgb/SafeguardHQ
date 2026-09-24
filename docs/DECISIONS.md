# Decisions log

Deviations from / clarifications of `docs/SPEC.md`, and what the official docs said when checked.

## 2026-09-24 — Phase 1

### API verification (CLAUDE.md rule 2)
| Item | Spec said | Docs / live check said | What we did |
|---|---|---|---|
| NYC GeoSearch | "GeoSearch (or Geoclient)" | `GET geosearch.planninglabs.nyc/v2/search?text=` returns GeoJSON; BBL/BIN at `properties.addendum.pad.{bbl,bin}`; coords `[lng,lat]`; no key | Used `/v2/search`. PAD placeholder "million BINs" (`x000000`) treated as no BIN. |
| Open Data dataset IDs | `wvxf-dwi5`, `tesw-yqqr`, `feu5-w2e2`, `64uk-42ks`, `3h2n-5cm9`, `6bgk-3dad` | All six confirmed live via `/api/views/{id}.json` | HPD violations by `bbl`; DOB + ECB by `bin`; HPD registrations by unpadded `boroid/block/lot`; PLUTO `bbl` is numeric (`4001750027.00000000`). |
| Socrata limits | — | Default `$limit` 1,000; token via `X-App-Token`; unthrottled with token | Page with `$limit=1000&$offset`, stable `$order …, :id`, cap 5,000 rows/dataset/property. |
| Google Drive | "clone the folder template" | Folders can't be copied; `files.copy` takes one parent; service accounts have **no storage quota** | Recursive create-folder + copy-file. Service accounts only work with a Shared Drive; OAuth refresh token supported as the alternative. |
| Supabase SSR auth | magic link | Next 16 uses `proxy.ts`; protect with `getClaims()`; SSR magic links use `/auth/confirm?token_hash=…&type=email` + `verifyOtp` | Implemented that; `/auth/confirm` also accepts a PKCE `code`. Email templates must be changed (RUNBOOK). |
| Supabase invites | — | `inviteUserByEmail` can't set `app_metadata` | Owner invite creates the user, then sets `profiles.role` directly (owner-only via RLS). |
| Supabase config | — | `[auth.email] enable_signup=false` disables email login entirely | Invite-only = global "Allow new users to sign up" OFF, email provider ON. |
| Drizzle + RLS | — | Supabase `postgres` has BYPASSRLS; set `request.jwt.claims` + `set local role authenticated` per transaction | All request-time queries go through `runAsUser()`. |

### Data model
- **Properties unique on (bbl, unit)**, not bbl alone: tenant/unit-level jobs in one building share a BBL.
- **`sub_profiles.default_rates` → `sub_costs` rows with `is_rate_card = true`.** RLS is row-level, so an owner-only column inside a VA-readable table isn't enforceable. The same logic moved campaign spend into `campaign_costs`.
- **`invoices_cache` and `sub_costs` exist now** (empty until Phase 3) so the financial-table RLS is tested from day one.
- **Stage rules live in a DB trigger** (`enforce_job_stage_rules`, SECURITY DEFINER so it sees priced docs a VA can't). `lib/pipeline/rules.ts` mirrors it for UI hints; both are tested. They also apply on INSERT, so a job can't be created straight into Delivered. A report in status SENT counts as FINAL.
- Stages are stored by key (`LAB_PENDING`, …), with a composite FK to `pipeline_stages`. Terminal stages are Closed, Next Cycle Scheduled, and Lost. Lost can't be entered from them.
- AIRNYC-service jobs use the Inspection pipeline; the case has its own AIRNYC pipeline. We added a terminal "Not Proceeding" (`LOST`) case stage, which isn't in the spec.
- `stale_after_days` defaults are guesses. Jordan can tune them in Settings.

### Security
- RLS is enabled on every public table but not FORCEd: the SECURITY DEFINER role helpers need the owner to bypass RLS, otherwise the `profiles` policy recurses.
- FIELD and SUB roles have **no policies yet**, so they have no access. Assigned-job policies come with the field view and sub portal.
- AIRnyc member fields are encrypted in the app with AES-256-GCM (`lib/crypto.ts`, `v1.` prefix so the key can be rotated), not pgcrypto. This keeps the key out of SQL and statement logs. The `case_id` stays plaintext because email parsing needs to match on it. The case→property link reveals the building but not the unit or member.
- AIRnyc reads are audited by `lib/airnyc/cases.ts` (one `audit_log` row per case per view), because Postgres has no SELECT triggers. Financial-table changes are audited by trigger.
- Priced documents go to the owner-only `job-files-pricing` bucket, so storage RLS protects the file as well as the row.

### Behaviour
- "Active relationship" for violation alerts and the nightly refresh means: any non-archived job not Lost, or an active OWNER/MANAGER property contact, or an open AIRnyc case. Past clients count.
- The first enrichment of a property never raises alerts; only violations that appear later do.
- Open Data enrichment runs inline on property create (so violations show immediately) and nightly at 3 AM ET in the worker (pg-boss).
- Drive folder creation is inline and best-effort. Jobs never fail because Drive is down, and the job page has a retry. It reuses a same-named folder instead of duplicating.
- Kanban drag-and-drop is desktop only. On phones, use the stage selector on the job page.
- Server-action uploads are capped at 4 MB (Vercel's limit is 4.5 MB). Big photo sets will upload straight from the browser in the Phase 4 field view.

### Not in Phase 1 (deliberately)
Owner 2FA (Supabase TOTP) is in §13 but not in Phase 1's list. It's planned before real client data goes in. Also deferred: FreshBooks invoice on Delivered (a trigger hook point is marked), the Quo and Titan integrations, and the compliance calendar.

## 2026-09-24 — Phase 2 (Communications)

### API verification
| Item | Spec said | Docs / live check said | What we did |
|---|---|---|---|
| Quo API versions | `Quo-Api-Version: 2026-03-30` | Two generations run side by side: **2026-03-30** (header-versioned) has webhooks, users, contacts (read-only); **v1** (path-versioned) still owns messages, calls, transcripts, summaries, and phone numbers | Webhooks are created on 2026-03-30; sending SMS uses `POST /v1/messages`; line import uses `GET /v1/phone-numbers`. Auth header is the raw key (`Authorization: <key>`, no Bearer). |
| Quo webhook signing | "verify signature; dedupe on `webhook-id`" | Standard Webhooks: `webhook-id` / `webhook-timestamp` / `webhook-signature: v1,<b64>`, HMAC-SHA256 over `id.timestamp.body`, secret `whsec_<b64>`. `webhook-id` is per delivery and stable across retries. Retries for about 27h. Ordering not guaranteed. | Implemented in `lib/integrations/quo.ts` with a 5-minute timestamp tolerance and multi-signature (key rotation) support. Dedupe ledger: `webhook_deliveries(provider, delivery_id)`, row-locked while processing. |
| Quo payloads | `data.links.quo`, `nextSteps` | Envelope `{id,type,data:{resource,context,links}}`. SMS text is `resource.text`, not `body`. The counterpart number is `context.senderIdentifier`/`recipientIdentifiers` (messages) or `context.participants.external` (calls). `summary` is a **string array**. Summary/transcript events use `resource.callId`. | Parsed accordingly. Calls upsert by call ID, so a summary that arrives before `call.completed` still lands correctly. |
| Quo events | message.received/delivered, call.* , contact.updated | All confirmed. `call.missed` and `message.failed/undelivered` also exist. | Handled: message.*, call.completed, call.missed, call.summary.completed, call.transcript.completed, contact.updated. Everything else is acknowledged and ignored. |
| Titan | IMAP 993 / SMTP 465 or 587. "Titan blocks third-party IMAP when 2FA is on." | Hosts/ports confirmed. Titan now offers **app passwords with 2FA on**. The docs conflict on whether SMTP sends are auto-filed in Sent. IDLE support isn't documented. | Use an app password on `crm@`. The Sent APPEND is behind `MAIL_APPEND_TO_SENT` (default on — turn it off if duplicates appear). If IDLE is missing, imapflow polls every 60s. |
| imapflow v2 / nodemailer v10 | — | imapflow does **not** auto-reconnect. It only auto-IDLEs when no mailbox lock is held. `uidValidity` is a bigint. nodemailer ignores `NODE_TLS_REJECT_UNAUTHORIZED`. | The worker owns the reconnect/backoff loop, holds the lock only per fetch (holding it permanently made new mail wait 20–35s; releasing it brought pickup down to about 1s), and stores UIDVALIDITY as text. |
| Anthropic | Haiku for classification | Structured outputs (`messages.parse` + `zodOutputFormat`) are supported on Haiku 4.5. | Triage uses `claude-haiku-4-5` (`AI_MODEL_CLASSIFY`), with the schema enforced by the API and validated again client-side. |

### Behaviour
- **Missed-call text-back is a draft unless `auto_send_sms` is on** (CLAUDE.md rule 6). It creates an Outbox draft plus an "Approve" task. It fires at most once per number per 24h, and never to do-not-contact contacts. When auto-send is on, the text is approved inside the webhook transaction and sent **after commit**, so a retry can't text twice.
- **Staff "Send now" counts as a human approval.** Approval runs under the user's RLS; the actual SMTP/Quo call runs *outside* any DB transaction.
- **Template placeholders:** manual compose shows unfilled fields as `[scheduled date]` and refuses to send until they're filled. Automatic messages drop empty fields.
- **Unknown numbers** create a `source=QUO` contact plus a "New inbound — qualify" task, once. Calls and texts are also filed under the contact's job when it has exactly one open job.
- **Summaries/transcripts** are ignored unless Settings → Communications → "Quo call summaries" is on (they need a Business or Scale plan). Next steps become `QUO_NEXT_STEP` tasks exactly once per call.
- **Email job matching order:** reply thread → `ESS-YYYY-####` in subject/body → a property address in the subject (only when it has exactly one open job) → AIRnyc case ID. ESS-sent copies (from our own domains) are stored as `EMAIL_OUT`.
- **EMSL parser.** Confirmed with Jordan on 2026-09-24 using a real EMSL file:
  - EMSL results emails carry **three attachments**. The one whose name ends in `002` holds the lab report and chain of custody. It's attached to the samples and filed as the job's LAB_RESULT document.
  - The other attachments include EMSL's **invoice** (ESS's lab cost). They go to the owner-only storage bucket, are marked contains-pricing, and stay out of the shared Drive folder.
  - EMSL's file names contain the 9-digit order number and the property address, e.g. `…_062654144__420_Central_Park_West_New_York_NY_10025_Apt_2E`.
  - Matching order: a pending sample's COC number, then an ESS job number, then the **property address + unit** from the email or file names. The address match is only accepted when it points to a single job.
  - A job moves from Lab Pending to Drafting when no samples are still out. Anything unmatched becomes an owner task.
- **The first IMAP connect starts from "now"** (it doesn't backfill the inbox). A UIDVALIDITY change also resets the cursor. A message that fails to import advances the cursor and opens a task, so one bad message can't stall the mailbox.
- **Health alert:** an SMS to `settings.health_alert_phone` when IMAP auth fails or there's been no successful sync for 15 minutes. It re-alerts at most hourly and allows a 15-minute grace period after the worker starts. Empty polls count as successful syncs.
- **AI triage:** confidence below `triage_confidence_threshold` (default 0.75), or category OTHER, goes to the Inbox review queue. A confident NEW_LEAD also creates a lead task. Confident EXISTING_JOB with a job-number hint files the message under that job. Call-transcript extraction (§9.3) and drafted replies (§9.2) are Phase 4.

### AIRnyc data (CLAUDE.md rule 5)
- **Sealed content:** anything AIRnyc-linked — the Quo line with key `AIRNYC`, an email with a case ID, a sender domain on the AIRnyc list, or a message about a case — stores subject/body/summary/transcript **encrypted** in `activities.sensitive_enc`. Raw payloads are dropped, and the webhook delivery log keeps IDs only (a test caught plaintext in both before this was fixed). Viewing goes through an audited "Reveal".
- **AI calls:** the wrapper blocks AIRnyc-linked calls while `airnyc_ai_allowed=false`, and logs the block to `ai_calls`. Triage doesn't even decrypt the content in that case. When AI is allowed, text is redacted before it's sent and un-redacted afterwards.
- **Outbox drafts to AIRnyc members stay unencrypted until sent** (the sealed copy is on the timeline). Jordan decided this on 2026-09-24: no HIPAA or similar rules apply to these drafts. Member fields on the case record are still encrypted.

### Deferred (not in the Phase 2 list)
- Pushing new CRM contacts to Quo (§6.1 contact sync). `contact.updated` is pulled and links `quo_contact_id`.
- The "Going cold" lead-SLA list (it lands with the Phase 3 daily digest).
- AIRnyc email mode (§7.4 mode 2) is Phase 5. Case-ID emails are already sealed and linked.

## 2026-09-24 — Phase 3 (Money)

### API verification (FreshBooks)
| Item | Spec said | Docs said | What we did |
|---|---|---|---|
| OAuth | OAuth 2 | Authorize at `auth.freshbooks.com/oauth/authorize`; token at `POST api.freshbooks.com/auth/oauth/token` (JSON body). **The redirect URI must be HTTPS**, even in development. Access tokens last 12h. **Refresh tokens are single-use**: each refresh returns a new pair, and the old refresh token stops working. | Tokens are stored encrypted (AES-256-GCM, same key as AIRnyc fields). Refresh happens 2 minutes before expiry, under a Postgres advisory lock plus `select … for update`, so the web app and worker can't both spend the same refresh token. A 401 forces one refresh, then one retry. |
| Account ID | — | `GET /auth/api/v1/users/me` → `response.business_memberships[].business.account_id`. Accounting URLs are `/accounting/account/{account_id}/…`. | Saved on the connection row. |
| Invoices | "Create DRAFT invoice" | New invoices are drafts by default. Sending is a separate `PUT` with `action_email: true` + `email_recipients`. Lines use `unit_cost: {amount, code}` + `qty`. `due_offset_days` sets the due date. | Drafts only. `action_email` is used only when Settings → "Auto-send FreshBooks invoices" is on (CLAUDE.md rule 6). |
| Webhooks | "verify signature; dedupe on delivery id" | Callbacks are created at `/events/account/{account_id}/events/callbacks`. FreshBooks POSTs a `verifier` to the URL, and we confirm with `PUT …/callbacks/{id}` `{callback:{verifier}}`. Deliveries are **form-encoded** (`name`, `object_id`, `account_id`, `business_id`, `identity_id`) and signed with `X-FreshBooks-Hmac-SHA256` = base64 HMAC-SHA256 of the Python `json.dumps()` of the form fields, keyed with the verifier. **There is no delivery ID, and ordering and exactly-once are not guaranteed.** | **Deviation from CLAUDE.md rule 7:** with no delivery ID there's nothing to dedupe on. Each delivery is a signed *trigger*: we re-fetch the invoice/payment/client from the API and apply its current state idempotently. Invoice cache writes never replace a newer `updated` with an older one. "Job paid" side effects (stage → Paid, report release, review request) run once, gated on an atomic `paid_at is null` claim. Every delivery is still logged in `webhook_deliveries` with a random ID. Signatures are checked against every stored verifier, in both the received key order and sorted order (the docs don't pin the order). |
| Pagination | — | `per_page` max 100. `Api-Version: alpha` header on accounting calls. | As documented. |

### Behaviour
- **Draft on Delivered:** a job entering Delivered gets a FreshBooks draft invoice. This runs right away (after the stage change responds) and also in the worker every minute as a backstop.
  - **Lines:** the job's line items, else one line for the quoted amount. If there's neither, it records an error on the job plus one owner task — nothing is guessed.
  - **Notes and due date:** the invoice notes carry `ESS job ESS-YYYY-####` plus the service address. The due date comes from Settings → payment terms (default 30 days).
  - **FreshBooks client:** it uses the organization's `freshbooks_client_id`, else the contact's, else finds one by email, else creates one.
- **Never two invoices per job:** an attempt is claimed atomically (`invoice_attempt_at`, 2-minute window), so the stage-move trigger and the worker can't both create one. After a crash between FreshBooks and our DB, the retry searches that client's invoices for the job marker before creating another.
- **Only jobs delivered after connecting are auto-invoiced.** Jobs already Delivered when FreshBooks was connected may have been billed by hand, so they get a draft only via the job page's "Create draft invoice now" button.
- **Stages:**
  - An invoice that FreshBooks reports as sent/viewed/partial moves Delivered → Invoiced.
  - Fully paid moves Delivered/Invoiced → Paid, and creates a review-request **draft** text in the Outbox (when `REVIEW_URL`, a line and a phone exist) plus a task.
- **Hold report until paid:**
  - **Where the flag is set:** the effective flag is job → client organization → Settings default.
  - **What "released automatically on payment" (SPEC §6.2) means here:** payment clears the hold and creates an owner task "Paid — release the report". Nothing is emailed to the client by itself (CLAUDE.md rule 6).
  - **Where it shows:** the job page shows the hold.
- **Client import never merges anything.** Every FreshBooks client lands in a review list with a suggested match (same email → same company name ignoring LLC/Inc/punctuation → same person name). Jordan chooses Link / Create new / Ignore. When there's an organization, the link is stored on it (invoices go to the company).
- **Reports** (owner only; enforced by RLS on `invoices_cache` / `job_financials` / `payments_cache`, and the page also redirects VAs):
  - **A/R aging:** open (non-draft, non-void) invoices by client type (AIRnyc if the job is AIRnyc; Government = a GOV_AGENCY org; Management co.; otherwise Private) and days past due.
  - **Margins:** by service and by month delivered (New York time). Revenue is the invoice amount, else the quoted amount.
- **Daily digest (§9.7):**
  - **Schedule:** weekdays at `digest_time` (New York), once per day (`digest_runs` is the idempotency key).
  - **Channels:** email to the digest recipients from the default From address, plus an optional one-line SMS to the alert number.
  - **Contents:** stale jobs, lab results waiting for review, the unpaid total by age, going-cold leads (inbound more than 24h ago in the last 14 days, no reply since, no job past Qualified, not do-not-contact), and overdue tasks.
  - **Deferred sections:** open bids (Phase 5), expiring licenses (Phase 6) and compliance deadlines (Phase 6) are left out because those modules don't exist yet.

### Deferred
- FreshBooks estimates from signed proposals (optional in §6.2; proposals are Phase 4).
- Pushing CRM contact edits back to FreshBooks clients (only the link is kept).
