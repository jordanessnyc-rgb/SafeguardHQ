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
2. **Migrate:** `DATABASE_URL=<direct connection> pnpm db:migrate`. This also creates the `job-files` and `job-files-pricing` buckets and their policies.
3. **First owner:** Supabase → Authentication → Users → Invite Jordan, then run `pnpm db:make-owner <jordan's email>`. Jordan invites VAs from Settings → Team.
4. **Vercel** env vars: `DATABASE_URL` (pooler, transaction mode), the `NEXT_PUBLIC_SUPABASE_*` values, `SUPABASE_SECRET_KEY`, `NEXT_PUBLIC_SITE_URL`, `AIRNYC_ENCRYPTION_KEY`, `SOCRATA_APP_TOKEN`, and the Google credentials.
5. **Worker** (Railway/Fly): `pnpm worker`, with the same `DATABASE_URL` and `SOCRATA_APP_TOKEN`.
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

## Operations
- **Key custody:** back up `AIRNYC_ENCRYPTION_KEY` somewhere outside Vercel (e.g. a password manager). Without it, AIRnyc member data can't be decrypted.
- **Refreshing a property's NYC data:** use the property page → "Refresh NYC data". The worker also refreshes nightly.
- **Failed jobs:** failed pg-boss jobs land in the `dead-letter` queue (`pgboss` schema). An admin page for this comes in Phase 2.
