-- ============================================================================================
-- 0006 — Phase 3 RLS. FreshBooks tokens, payments and digests are OWNER only. The client
-- import/review table has names and emails only (no money), so staff can read it; only the
-- OWNER resolves matches.
-- ============================================================================================
do $$
declare t text;
begin
  foreach t in array array['freshbooks_connection','freshbooks_clients','payments_cache','digest_runs'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon', t);
  end loop;
  foreach t in array array['freshbooks_connection','freshbooks_clients','payments_cache'] loop
    execute format('drop trigger if exists set_updated_at on public.%I', t);
    execute format('create trigger set_updated_at before update on public.%I for each row execute function public.set_updated_at()', t);
  end loop;
end $$;

create policy owner_all on public.freshbooks_connection for all to authenticated using (public.is_owner()) with check (public.is_owner());
create policy owner_all on public.payments_cache for all to authenticated using (public.is_owner()) with check (public.is_owner());
create policy owner_all on public.digest_runs for all to authenticated using (public.is_owner()) with check (public.is_owner());
create policy staff_select on public.freshbooks_clients for select to authenticated using (public.is_staff());
create policy owner_write on public.freshbooks_clients for all to authenticated using (public.is_owner()) with check (public.is_owner());

alter table public.freshbooks_connection add constraint freshbooks_connection_singleton check (id = 1);

-- Payments are financial changes → audited like the other money tables (SPEC §13).
drop trigger if exists audit_row_change on public.payments_cache;
create trigger audit_row_change after insert or update or delete on public.payments_cache
  for each row execute function public.audit_row_change();
