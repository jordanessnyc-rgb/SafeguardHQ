-- ============================================================================================
-- 0009 — Phase 4a RLS. Compliance rules, licenses and sub COIs hold no prices, so staff can read
-- them. Only the OWNER edits cycle rules and ESS licenses; staff may keep sub profiles current
-- (COI dates arrive by email and a VA files them). Alert bookkeeping is written by the worker.
-- ============================================================================================
do $$
declare t text;
begin
  foreach t in array array['compliance_rules','credentials','sub_profiles','expiry_alerts'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon', t);
  end loop;
  foreach t in array array['compliance_rules','credentials','sub_profiles'] loop
    execute format('drop trigger if exists set_updated_at on public.%I', t);
    execute format('create trigger set_updated_at before update on public.%I for each row execute function public.set_updated_at()', t);
  end loop;
end $$;

create policy staff_select on public.compliance_rules for select to authenticated using (public.is_staff());
create policy owner_write on public.compliance_rules for all to authenticated using (public.is_owner()) with check (public.is_owner());
create policy staff_select on public.credentials for select to authenticated using (public.is_staff());
create policy owner_write on public.credentials for all to authenticated using (public.is_owner()) with check (public.is_owner());
create policy staff_all on public.sub_profiles for all to authenticated using (public.is_staff()) with check (public.is_staff());
create policy staff_select on public.expiry_alerts for select to authenticated using (public.is_staff());

-- SPEC §4.8: seed Jordan's licenses. Numbers and expiry dates are left for Jordan to enter.
insert into public.credentials (name, issuer) values
  ('EPA Lead Risk Assessor', 'US EPA'),
  ('EPA Lead-Safe Firm', 'US EPA'),
  ('NYS Mold Assessor', 'NYS Department of Labor');
