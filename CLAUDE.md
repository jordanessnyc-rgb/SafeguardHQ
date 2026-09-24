# ESS CRM — Claude Code Project Instructions

You are building a custom CRM for **Environmental Safeguard Solutions (ESS)**, a NYC environmental
inspection and compliance firm (mold, lead, asbestos, LL152 gas piping, LL126 parapets, HPD/DOB
violation support). The owner is Jordan Adhami. Read `docs/SPEC.md` before writing any code — it is the
source of truth for scope, data model, integrations, and build phases.

## Ground rules

1. **Build phase by phase.** Only work on the current phase in `docs/SPEC.md` §12. Do not start a later
   phase until the current phase's acceptance criteria pass and Jordan confirms.
2. **Verify every external API against its current official docs before implementing it.** Endpoints,
   event names, and headers in the spec are a starting point, not gospel. If the docs disagree with the
   spec, follow the docs and note the difference in `docs/DECISIONS.md`.
3. **Never commit secrets.** All credentials (Quo API key, FreshBooks OAuth, Titan mailbox password,
   Anthropic API key, Google credentials) live in environment variables / the host's secret store.
   Keep `.env.example` updated with names only.
4. **Pricing is confidential.** Subcontractors and VAs must never see what ESS charges. Enforce this in
   the database (row-level security + separate financial tables), not just by hiding UI fields.
5. **AIRnyc member data is sensitive** (Medicaid members, health-related housing conditions). Encrypt at
   rest, log every access, and never send it to the AI layer while `settings.airnyc_ai_allowed = false`
   (the default). Use the redaction helper described in SPEC §9.4.
6. **Nothing is sent to clients automatically** (email, SMS, invoices) unless the relevant
   `auto_send_*` setting is explicitly turned on. Default is draft → human approval.
7. **Idempotent webhooks.** Every inbound webhook handler must verify its signature, dedupe on the
   provider's delivery ID, and tolerate out-of-order events.
8. **Small, reviewable commits** with clear messages. Write tests for integration handlers and
   permission rules at minimum.

## Stack (see SPEC §3 for rationale)

- Next.js (App Router) + TypeScript, Tailwind, shadcn/ui
- Postgres on Supabase (auth, row-level security, storage)
- Drizzle ORM + SQL migrations checked into `db/migrations`
- Web app on Vercel; long-running **worker** (IMAP listener + job queue) on Railway or Fly.io
- Job queue: pg-boss (Postgres-backed) so there is no extra infrastructure
- Anthropic TypeScript SDK for AI features

## Repo layout

```
/app                 Next.js routes (UI + API routes for webhooks)
/app/api/webhooks    quo/, freshbooks/, airnyc/ (inbound webhook handlers)
/lib/integrations    quo.ts, freshbooks.ts, titan-mail.ts, nyc-open-data.ts, google-drive.ts, anthropic.ts
/lib/ai              prompts/, redact.ts, classify.ts, draft.ts
/lib/docs            DOCX template rendering (proposals, reports, sub copies)
/worker              IMAP IDLE listener, scheduled jobs, queue consumers
/db                  schema.ts, migrations/, seed.ts
/templates           ESS DOCX templates (ESS_Header.docx etc.) — provided by Jordan
/docs                SPEC.md, DECISIONS.md, RUNBOOK.md
```

## Brand

Forest green `#146432`, sage `#50823C`. ESS contact block: 47-58 43rd Street, Queens, NY 11377 ·
929-305-1232 · sales@ess-nyc.com · ess-nyc.com. Jordan Adhami is the named assessor on all reports.

## When unsure

Ask Jordan rather than guessing on anything involving money, client communications, legal/compliance
language in reports, or AIRnyc data handling.

@AGENTS.md
