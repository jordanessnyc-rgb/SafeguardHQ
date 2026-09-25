# Go-live checklist (in progress)

State as of 2026-09-25. A new session should pick up here when Jordan says "continue go-live".

## Done
- Phases 1–6 merged to `main`.
- `.github/workflows/production-db.yml`: migrates the live DB (secret `PRODUCTION_DATABASE_URL`) and can make the first owner.
- `railway.json`: worker service config (Railpack, no build, `pnpm worker`, always restart).
- Supabase project created: ref `dukwctpevwvthkyrheqr`, URL `https://dukwctpevwvthkyrheqr.supabase.co`,
  region East US. Publishable key `sb_publishable_xFyluGu_xT6b_TMMm-g9nA_IQ4KjbwB` (public).
  Sign-ups are already disabled.

## Credentials (session environment variables, never in chat or the repo)
`SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD`, `VERCEL_TOKEN` (team `team_7wDoXnnIvlvgF9SAgjlVFOOU`,
"Jordan Adhami's projects"), `RAILWAY_TOKEN`. The session can reach api.supabase.com, api.vercel.com
and backboard.railway.com over HTTPS, but NOT Postgres ports, so SQL goes through the Supabase
Management API (`POST /v1/projects/{ref}/database/query`) or the GitHub workflow.

## To do
1. **Supabase (Management API):**
   - Read the secret key (`GET /v1/projects/{ref}/api-keys`).
   - Get the pooler strings (`GET /v1/projects/{ref}/config/database/pooler`) and build `DATABASE_URL`
     with `SUPABASE_DB_PASSWORD`: transaction pooler :6543 for Vercel, session pooler :5432 for the
     worker and migrations.
   - Apply `db/migrations` in order, recording them in `drizzle.__drizzle_migrations` exactly as
     drizzle-kit does, or set the GitHub secret and run the workflow.
   - Auth config (`PATCH /v1/projects/{ref}/config/auth`): site URL = production URL, redirect URLs,
     MFA TOTP on, magic-link and invite templates from `supabase/templates/`.
2. **Vercel (REST with VERCEL_TOKEN):**
   - Create project `ess-crm` linked to `jordanessnyc-rgb/SafeguardHQ`, framework nextjs, region iad1.
   - Env: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`,
     `DATABASE_URL` (transaction pooler), `AIRNYC_ENCRYPTION_KEY` (new 32-byte base64; the worker needs
     the same value), `NEXT_PUBLIC_SITE_URL`.
   - Deploy and check `/login` loads. The Vercel GitHub app must be allowed on the repo (Jordan approves in the browser).
3. **First owner:** invite Jordan's email (`POST /auth/v1/invite` with the secret key), then make the
   profile OWNER (SQL via the Management API). His first login goes through TOTP setup.
4. **Railway (GraphQL with RAILWAY_TOKEN):** project + service from the GitHub repo. Vars `DATABASE_URL`
   (session pooler), `AIRNYC_ENCRYPTION_KEY` (same as Vercel), `NEXT_PUBLIC_SITE_URL`. Confirm the
   heartbeat on /admin.
5. **Later, one at a time:** Quo, FreshBooks, Titan, Google Drive (+ export folder), Anthropic, Sentry,
   custom domain `crm.ess-nyc.com`.
