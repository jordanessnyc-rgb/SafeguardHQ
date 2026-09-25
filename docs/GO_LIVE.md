# Go-live checklist (in progress)

State as of 2026-09-25. A new session should pick up here when Jordan says "continue go-live".

## Live (2026-09-25)
- **Web:** https://ess-crm-opal.vercel.app (Vercel project `ess-crm`, team "Jordan Adhami's projects",
  region pdx1 next to the database). Production env vars: `NEXT_PUBLIC_SUPABASE_URL`,
  `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `DATABASE_URL` (transaction pooler :6543),
  `SUPABASE_SECRET_KEY`, `AIRNYC_ENCRYPTION_KEY`, `NEXT_PUBLIC_SITE_URL`. Secrets are "sensitive" and production-only.
- **Database:** Supabase project `dukwctpevwvthkyrheqr` ("ESS CRM", us-west-2). Migrations 0000–0025 applied via
  the Management API with drizzle's bookkeeping (`drizzle.__drizzle_migrations`), so `pnpm db:migrate` and the
  Production database workflow continue from here. The DB password was rotated during setup and lives only in
  Vercel/Railway env vars; reset it in Supabase (Database → Settings) if you ever need it.
- **Auth:** site URL + redirect allow-list set, sign-ups off, TOTP MFA on. Owner: jordanessnyc@gmail.com (OWNER).
  Custom email templates need custom SMTP on the free plan, so the default Supabase emails are used for now. They
  link via PKCE `code`, which `/auth/confirm` accepts. The built-in sender only mails project team members and is
  rate-limited, so set up SMTP (Titan) before inviting VAs.
- **Worker:** Railway project `ess-crm-worker` → service `worker` (from `main`, `railway.json`). Env: `DATABASE_URL`
  (session pooler :5432), `AIRNYC_ENCRYPTION_KEY` (same as Vercel), `SUPABASE_SECRET_KEY`,
  `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SITE_URL`. First run: heartbeat OK, City Record pulled 3 bids.
  (The other Railway project, "courteous-hope", is unrelated; leave it.)

## Next
1. Custom SMTP (Titan `crm@`/`sales@`) in Supabase → Auth → SMTP, then paste `supabase/templates/*` as the email templates.
2. Connect integrations one at a time: Quo, FreshBooks, Titan IMAP/CalDAV, Google Drive (+ export folder), Anthropic,
   Socrata app token, Sentry. Each one = env vars on Vercel and/or Railway (see `.env.example` and RUNBOOK).
3. Custom domain `crm.ess-nyc.com` (Vercel domain + DNS CNAME), then update the site URL in Vercel env, Supabase auth and Railway.
4. Revoke the setup tokens (Supabase access token, Vercel token, Railway token) and issue new ones only when needed.
