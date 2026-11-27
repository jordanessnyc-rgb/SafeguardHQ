-- ============================================================================================
-- 0039 — Workflows RLS. Staff (OWNER + VA) can see workflows and what they did; only the OWNER
-- creates, edits, switches on or deletes them, since a workflow can message clients (CLAUDE.md
-- rule 6). Runs are written by the worker's privileged connection, which bypasses RLS.
-- ============================================================================================
do $$
declare t text;
begin
  foreach t in array array['workflows', 'workflow_runs'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('create policy staff_select on public.%I for select to authenticated using (public.is_staff())', t);
    execute format('create policy owner_write on public.%I for all to authenticated using (public.is_owner()) with check (public.is_owner())', t);
    execute format('drop trigger if exists set_updated_at on public.%I', t);
    execute format('create trigger set_updated_at before update on public.%I for each row execute function public.set_updated_at()', t);
  end loop;
end $$;
