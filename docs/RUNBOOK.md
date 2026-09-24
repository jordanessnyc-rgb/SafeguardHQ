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

## Operations
- **Key custody:** back up `AIRNYC_ENCRYPTION_KEY` somewhere outside Vercel (e.g. a password manager). Without it, AIRnyc member data can't be decrypted.
- **Refreshing a property's NYC data:** use the property page → "Refresh NYC data". The worker also refreshes nightly.
- **Failed jobs:** failed pg-boss jobs land in the `dead-letter` queue (`pgboss` schema). An admin page for this comes in Phase 2.
