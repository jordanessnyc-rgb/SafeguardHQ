-- Weekly CRM export (Phase 7a): private Storage bucket used when Google Drive isn't configured.
-- No policies on purpose: only the service role (worker, owner-only download route) can touch it.
do $$
begin
  if exists (select 1 from information_schema.schemata where schema_name = 'storage') then
    insert into storage.buckets (id, name, public) values ('backups', 'backups', false)
      on conflict (id) do nothing;
  end if;
end $$;
