-- ============================================================================================
-- 0037 — Tags RLS. Tags are working labels, not money or member data: OWNER + VA can see, add and
-- remove them (like the other core CRM tables). Renaming a tag is staff; deleting one (which
-- removes it from every record) is OWNER only. FIELD / SUB / no-role users see nothing.
-- ============================================================================================
do $$
declare t text;
begin
  foreach t in array array['tags', 'contact_tags', 'organization_tags', 'job_tags'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('create policy staff_select on public.%I for select to authenticated using (public.is_staff())', t);
    execute format('create policy staff_insert on public.%I for insert to authenticated with check (public.is_staff())', t);
  end loop;
  foreach t in array array['contact_tags', 'organization_tags', 'job_tags'] loop
    execute format('create policy staff_delete on public.%I for delete to authenticated using (public.is_staff())', t);
  end loop;
end $$;

create policy staff_update on public.tags for update to authenticated using (public.is_staff()) with check (public.is_staff());
create policy owner_delete on public.tags for delete to authenticated using (public.is_owner());

drop trigger if exists set_updated_at on public.tags;
create trigger set_updated_at before update on public.tags for each row execute function public.set_updated_at();
