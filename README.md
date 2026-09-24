# ESS CRM

Custom CRM for Environmental Safeguard Solutions. It's built around NYC properties and compliance work, and it follows a job from first contact through report, invoice, and the next compliance cycle.

- **Spec:** [`docs/SPEC.md`](docs/SPEC.md) (the source of truth)
- **Decisions and API verification notes:** [`docs/DECISIONS.md`](docs/DECISIONS.md)
- **Setup and operations:** [`docs/RUNBOOK.md`](docs/RUNBOOK.md)

**Stack:** Next.js 16 (App Router), TypeScript, Tailwind + shadcn/ui, Supabase (Postgres, Auth, Storage, RLS), Drizzle, and pg-boss for the worker.

## Layout
```
app/            routes: (auth)/login, auth/confirm, (app)/{jobs,properties,contacts,organizations,airnyc,tasks,settings}
lib/            db (RLS runner), auth, integrations (nyc-open-data, google-drive), pipeline rules, airnyc, crypto
db/             schema.ts, migrations/ (0001 = RLS + stage rules, 0002 = seed), migrate.ts, make-owner.ts
worker/         pg-boss worker (nightly Open Data refresh; IMAP in Phase 2)
supabase/       local Supabase config + auth email templates
tests/          unit + DB (RLS, stage rules, enrichment, AIRnyc) suites
```

## Status
Phase 1 (Foundation) is implemented. See the PR for the acceptance checklist.
