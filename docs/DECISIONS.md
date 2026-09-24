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
