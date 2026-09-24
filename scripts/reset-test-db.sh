#!/usr/bin/env bash
# Drops and rebuilds the test database: Supabase stub + all migrations (via psql).
set -euo pipefail
export PGOPTIONS="-c client_min_messages=warning"
: "${TEST_DATABASE_URL:?set TEST_DATABASE_URL (see scripts/test-db.sh)}"
cd "$(dirname "$0")/.."
psql "$TEST_DATABASE_URL" -q -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
drop schema if exists public cascade; create schema public;
drop schema if exists auth cascade; drop schema if exists drizzle cascade;
SQL
psql "$TEST_DATABASE_URL" -q -v ON_ERROR_STOP=1 -f db/test/supabase-stub.sql >/dev/null
for f in db/migrations/0*.sql; do psql "$TEST_DATABASE_URL" -q -v ON_ERROR_STOP=1 -f "$f" >/dev/null; done
