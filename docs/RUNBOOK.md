# Runbook

## Local development
```bash
pnpm install
npx supabase start -x studio,edge-runtime,realtime,imgproxy,vector,logflare,supavisor,postgres-meta
cp .env.example .env.local   # fill from `npx supabase status` + `openssl rand -base64 32`
DOTENV_CONFIG_PATH=.env.local pnpm db:migrate
# create yourself in the local Auth admin, or via supabase-js admin.createUser, then:
DOTENV_CONFIG_PATH=.env.local pnpm db:make-owner you@example.com
pnpm dev            # magic-link emails land in Mailpit: http://127.0.0.1:54324
```

## Tests
```bash
pnpm test:db     # starts a throwaway Postgres (scripts/test-db.sh) + runs everything
pnpm test        # unit tests only if TEST_DATABASE_URL is unset (DB suites skip)
pnpm lint && pnpm typecheck
```
The DB suites apply `db/test/supabase-stub.sql` (a minimal `auth.users` + `auth.uid()` and the Supabase roles) and then every migration, using the real drizzle migrator.

## Production setup (one time)
1. **Supabase project**
   - Authentication → Sign In / Providers: **Allow new users to sign up = OFF**, Email provider = ON.
   - Authentication → URL Configuration: Site URL = production URL; add it to Redirect URLs.
   - Authentication → Email Templates: paste `supabase/templates/magic_link.html` (Magic Link) and `invite.html` (Invite User). They link to `/auth/confirm?token_hash=…`.
   - Set up custom SMTP (the built-in sender is rate-limited).
2. **Migrate:** GitHub → Actions → **Production database** → Run workflow (uses the `PRODUCTION_DATABASE_URL` repo secret: Supabase → Connect → Session pooler string). It also runs by itself whenever a push to main adds a migration. This also creates the `job-files` and `job-files-pricing` buckets and their policies.
3. **First owner:** Supabase → Authentication → Users → Invite Jordan, then run the **Production database** workflow again with Jordan's email in `owner_email`. Jordan invites VAs from Settings → Team.
4. **Vercel** env vars: `DATABASE_URL` (pooler, transaction mode), the `NEXT_PUBLIC_SUPABASE_*` values, `SUPABASE_SECRET_KEY`, `NEXT_PUBLIC_SITE_URL`, `AIRNYC_ENCRYPTION_KEY`, `SOCRATA_APP_TOKEN`, and the Google credentials.
5. **Worker** (Railway): New project → Deploy from GitHub repo → this repo. `railway.json` sets the start command (`pnpm worker`, no build step, always restart). Variables: `DATABASE_URL` (Supabase session pooler string, same as the GitHub secret), `SOCRATA_APP_TOKEN`, plus the integration keys as each one is connected. /admin → System health shows its heartbeat.
6. **Google Drive:** either
   - a service account, added as a Content Manager to a **Shared Drive** that holds the parent + template folders (`GOOGLE_SERVICE_ACCOUNT_JSON`), or
   - an OAuth client + refresh token for Jordan's account (`GOOGLE_OAUTH_*`).

   Then paste the folder URLs into Settings.
7. **Socrata app token:** register at data.cityofnewyork.us → Developer Settings.

## Phase 2 setup (communications)
1. **Quo**
   - Workspace Settings → API: create a key and set `QUO_API_KEY`.
   - Create the webhook with the **2026-03-30** API. Save the returned `key` (whsec_…) as `QUO_WEBHOOK_SECRET`:
     ```bash
     curl -X POST https://api.quo.com/webhooks -H "Authorization: $QUO_API_KEY" -H "Quo-Api-Version: 2026-03-30" \
       -H "Content-Type: application/json" -d '{"url":"https://<crm>/api/webhooks/quo","label":"ESS CRM","events":
       ["message.received","message.delivered","message.failed","call.completed","call.missed",
        "call.summary.completed","call.transcript.completed","contact.updated"]}'
     ```
   - Settings → Communications: **Import numbers from Quo**. Set each line's key (e.g. `ESS_MAIN`, `GAS_PRO`, `AIRNYC`) and brand, and choose which lines get missed-call text-back. **The key `AIRNYC` makes that line's texts and calls encrypted.**
   - Turn on "Quo call summaries" only on a Business or Scale plan.
2. **Titan**
   - Create `crm@ess-nyc.com`. In Webmail → Settings, turn on **Enable Titan on Other Apps**, and create an app password if 2FA is on.
   - Set up forwarding/copy from `sales@` (and any other mailboxes) to `crm@`.
   - Set `TITAN_USER` / `TITAN_PASSWORD` on the **worker** (Railway/Fly) *and* on Vercel (for sending).
   - EU-hosted Titan accounts and GoDaddy-managed domains use different hosts; set `TITAN_IMAP_HOST` / `TITAN_SMTP_HOST`.
   - Test sending as `sales@`. If Titan rejects the alias as From, use `crm@` as the default From in Settings → Communications.
   - After the first send, check Sent in Titan. If there are two copies, set `MAIL_APPEND_TO_SENT=false`.
3. **Anthropic:** set `ANTHROPIC_API_KEY` on the worker, and set a monthly AI cost cap in Settings.
4. **Alerts:** in Settings → Communications, set "Alert texts go to" (Jordan's cell) and the line they're sent from.

### Local end-to-end (what Phase 2 was verified against)
- **Services:** local Supabase (`npx supabase start …`), GreenMail as a stand-in for Titan (`docker run -p 3025:3025 -p 3993:3993 -p 3465:3465 greenmail/standalone`), and a tiny mock of Quo's `/v1/messages` (`QUO_API_BASE=http://127.0.0.1:4010`).
- **Run with:** `MAIL_ALLOW_SELF_SIGNED_FOR_LOCAL_TESTING=true`, `NODE_TLS_REJECT_UNAUTHORIZED=0` for the worker, and `pnpm dev` (the flag is ignored in production builds).
- **Measured:**
  - Quo webhook → timeline: under 0.5s.
  - Email via IMAP IDLE → timeline: 0.8–1.5s.
  - EMSL email → sample RESULTS_IN and job moved to Drafting: working.
  - Duplicate webhook deliveries: no duplicate rows.

## Phase 3 setup (FreshBooks, digest)
1. **FreshBooks app**
   - At <https://my.freshbooks.com/#/developer>, create an app.
   - **Redirect URI** must be HTTPS: `https://<crm>/api/freshbooks/callback`.
   - **Scopes:** `user:profile:read`, `user:clients:read`, `user:clients:write`, `user:invoices:read`, `user:invoices:write`, `user:payments:read`.
   - Set `FRESHBOOKS_CLIENT_ID`, `FRESHBOOKS_CLIENT_SECRET`, `FRESHBOOKS_REDIRECT_URI` on **Vercel and the worker**.
2. **Connect (owner):** Settings → FreshBooks → **Connect FreshBooks**, then approve in FreshBooks. The callback saves encrypted tokens and registers the webhooks at `https://<crm>/api/webhooks/freshbooks`. Within about a minute, each should show ✓ on the page. If any stays "waiting", click **Register webhooks again**.
3. **Import clients:** **Import / refresh clients from FreshBooks**, then work through the review list (Link / Create new / Ignore). Link before the first invoice goes out, so FreshBooks doesn't end up with duplicate clients.
4. **Settings:**
   - Payment terms (days) and "Hold reports until paid" default.
   - Digest on/off, the SMS line, recipients and time.
   - Per-client hold: on the organization page.
5. **Auto-send FreshBooks invoices** stays **off** until Jordan has checked a few drafts.

### Local end-to-end (what Phase 3 was verified against)
FreshBooks has no sandbox that accepts `http://localhost`. Locally, `FRESHBOOKS_API_BASE` / `FRESHBOOKS_AUTH_BASE` point at a mock server (same routes and envelopes as `tests/helpers/fake-freshbooks.ts`). Never set these in production (they're ignored when `NODE_ENV=production`).
Verified in the browser on 2026-09-24:
- **Connect:** Connect → OAuth → all 8 webhooks verified.
  - This run found and fixed a bug: concurrent handshakes overwrote each other's verifiers.
- **Import:** 2 clients; Pat Lee suggested by name and linked; Parkside created.
- **Delivered → draft:** moving a QA job to Delivered in the UI created a draft within a second. It went to FreshBooks client 9001, with the two line items ($1,650), due in 30 days, and "ESS job ESS-2026-0003" plus the address in the notes. Nothing was emailed.
- **Sent and paid:** "sent" moved the job to Invoiced; $650 kept it Invoiced; $1,000 more moved it to Paid.
- **After payment:** the held report was released with a task, and a review-request draft was waiting in the Outbox.
- **VA:** sees no Reports link; `/reports` and `/settings/freshbooks` redirect; no financials on the job.

## Phase 4 setup (documents, pricing, compliance)
1. **Templates.** Save ESS's Word templates as `/templates/ESS_Proposal.docx` and `/templates/ESS_Report.docx`, then commit them. Until then, the red-bannered placeholders in `/templates/placeholder` are used. `pnpm tsx scripts/make-placeholder-templates.ts` regenerates them. Tags use `{name}`:
   - **Proposal tags:**
     - Details: `{brand_name} {proposal_number} {proposal_date} {client_name} {client_org} {property_address} {service_name} {scope} {total} {valid_days}`.
     - Line items: a table row with `{#lines}{description}` | `{qty}` | `{unit_price}` | `{amount}{/lines}`.
     - Signature block: client only.
   - **Report tags:**
     - Details: `{brand_name} {report_title} {draft_notice} {report_status} {job_number} {report_date} {client_name} {property_address} {assessor}`.
     - Sections: `{#sections}` / `{title}` / `{body}` / `{/sections}`, each on its own paragraph.
     - Samples: a table row with `{#samples}{sample_id}` | `{type}` | `{location}` | `{result}{/samples}`.
     - Photos: `{@photo_log}`, alone in its paragraph.
2. **Pricing.** Go to Settings → Pricing and enter each service's base price, included sq ft and samples, per-unit rates, minimum and default scope. It is owner-only.
3. **Compliance.** Go to Compliance → Cycle rules and enter each service's cycle and lead time. Then fill in ESS license numbers and expiry dates, and each subcontractor's COI date on its organization page.
4. **DocuSign.**
   - **App setup:** in the DocuSign developer account (Apps and Keys), create an integration key and add an RSA keypair. Set `DOCUSIGN_INTEGRATION_KEY`, `DOCUSIGN_USER_ID` (the sending user's GUID) and `DOCUSIGN_PRIVATE_KEY`.
   - **Consent:** register the redirect URI `https://<crm>/settings?docusign=consented`, then click Settings → **DocuSign consent** once while logged in to DocuSign as that user.
   - **Webhooks:** in eSignature Admin → Connect → Connect Keys, add a secret and put it in `DOCUSIGN_HMAC_KEYS`. Without it, check signatures with the job page button instead.
   - **Your own template:** a real proposal template needs the hidden anchors `\ess_sign\` and `\ess_date\` (white, tiny text) where the client signs and dates.
   - **Production:** requires DocuSign's Go-Live review (a paid account). Afterwards, set `DOCUSIGN_ENV=production` and re-add the secret, redirect URI and HMAC key in production.
5. **Titan calendar (worker).**
   - **Enable it:** set `TITAN_CALDAV_ENABLED=true`. It uses `TITAN_USER`/`TITAN_PASSWORD` unless `TITAN_CALDAV_USERNAME`/`_PASSWORD` are set; use an app password if 2FA is on.
   - **Host:** `dav.titan.email` by default. EU-hosted accounts use `dav-eu.titan.email`; mailboxes bought through GoDaddy use `dav.myprofessionalmail.com`.
   - **Pick a calendar:** pin one with `TITAN_CALDAV_CALENDAR_URL`, or choose one by name with `TITAN_CALDAV_CALENDAR_NAME`.
   - **First run:** schedule a test job and confirm the event appears in Titan within 5 minutes.
6. **AI.** Go to Settings → Communications → "How Jordan writes" and describe your tone. Reply drafts, call extraction and report drafts need `ANTHROPIC_API_KEY`; the model names are in `AI_MODEL_*`.

## Operations
- **Key custody:** back up `AIRNYC_ENCRYPTION_KEY` somewhere outside Vercel (e.g. a password manager). Without it, AIRnyc member data can't be decrypted.
- **Refreshing a property's NYC data:** use the property page → "Refresh NYC data". The worker also refreshes nightly.
- **Failed jobs:** failed pg-boss jobs land in the `dead-letter` queue (`pgboss` schema). An admin page for this comes in Phase 2.


## Weekly export (Phase 6)

- Create a Drive folder only Jordan can open (e.g. "ESS CRM exports") and put its id in
  `GOOGLE_DRIVE_EXPORT_FOLDER_ID` on the worker. The same Google credentials as the job folders are used;
  with a service account, the folder must be in a Shared Drive the account belongs to.
- Every Sunday at 2 AM a zip of CSVs appears there; the newest 12 are kept. /admin shows the last run.

## Error tracking (Sentry, Phase 6)

- Create a free Sentry project (platform: Next.js). Put its DSN in `SENTRY_DSN` and
  `NEXT_PUBLIC_SENTRY_DSN` on Vercel, and `SENTRY_DSN` on the worker. Optional: `SENTRY_ORG`,
  `SENTRY_PROJECT` and `SENTRY_AUTH_TOKEN` on Vercel for readable stack traces.
- Reports are scrubbed (no contact details, amounts, request bodies or replays). Don't turn on
  Session Replay in the Sentry dashboard.
