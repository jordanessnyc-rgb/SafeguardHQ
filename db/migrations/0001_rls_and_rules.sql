-- ============================================================================================
-- 0001 — Role helpers, row-level security, pipeline stage rules, audit triggers.
--
-- Access model (SPEC §2, CLAUDE.md rule 4):
--   OWNER  everything
--   VA     core CRM tables; never financial tables; never documents with contains_pricing
--   FIELD  (no policies yet → no access; assigned-jobs policies land with the field view)
--   SUB    (no policies yet → no access; sub portal is Phase 5)
--   anon   nothing (no policies target anon)
-- Financial tables: job_financials, invoices_cache, sub_costs, campaign_costs → OWNER only.
-- ============================================================================================

-- --------------------------------------------------------------------------------------------
-- Role helpers. SECURITY DEFINER so they can read profiles regardless of the caller's RLS.
-- --------------------------------------------------------------------------------------------
create or replace function public.current_app_role() returns public.user_role
language sql stable security definer set search_path = public as $$
  select role from public.profiles where user_id = auth.uid()
$$;

create or replace function public.is_owner() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.current_app_role() = 'OWNER', false)
$$;

-- "Staff" = office users who work the CRM: OWNER and VA.
create or replace function public.is_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.current_app_role() in ('OWNER', 'VA'), false)
$$;

revoke all on function public.current_app_role(), public.is_owner(), public.is_staff() from public;
grant execute on function public.current_app_role(), public.is_owner(), public.is_staff()
  to authenticated, service_role;

-- next_job_number() is only ever called from the jobs.job_number default.
revoke all on function public.next_job_number() from public;
grant execute on function public.next_job_number() to authenticated, service_role;

-- --------------------------------------------------------------------------------------------
-- updated_at maintenance on every table that has the column.
-- --------------------------------------------------------------------------------------------
create or replace function public.set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

do $$
declare t record;
begin
  for t in
    select c.table_name from information_schema.columns c
    join information_schema.tables tb
      on tb.table_schema = c.table_schema and tb.table_name = c.table_name and tb.table_type = 'BASE TABLE'
    where c.table_schema = 'public' and c.column_name = 'updated_at'
  loop
    execute format('drop trigger if exists set_updated_at on public.%I', t.table_name);
    execute format(
      'create trigger set_updated_at before update on public.%I for each row execute function public.set_updated_at()',
      t.table_name);
  end loop;
end $$;

-- --------------------------------------------------------------------------------------------
-- New auth user → profile. Role comes from app_metadata (only settable with the service role,
-- i.e. by the OWNER's invite flow), never from user-editable user_metadata.
-- --------------------------------------------------------------------------------------------
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  requested text := new.raw_app_meta_data ->> 'role';
begin
  insert into public.profiles (user_id, email, full_name, role)
  values (
    new.id,
    coalesce(new.email, ''),
    new.raw_user_meta_data ->> 'full_name',
    case when requested in ('OWNER', 'VA', 'FIELD', 'SUB') then requested::public.user_role end
  )
  on conflict (user_id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- --------------------------------------------------------------------------------------------
-- Pipeline stage rules (SPEC §5). This trigger is the authority; lib/pipeline/rules.ts mirrors
-- it only to give friendly errors in the UI before a round trip.
-- SECURITY DEFINER so the checks see every sample/document regardless of the caller's RLS.
-- Error messages start with 'STAGE_RULE:' so the app can surface them verbatim.
-- --------------------------------------------------------------------------------------------
create or replace function public.enforce_job_stage_rules() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  from_terminal boolean;
begin
  if tg_op = 'UPDATE'
     and new.stage is not distinct from old.stage
     and new.pipeline_key is not distinct from old.pipeline_key then
    return new;
  end if;

  if new.stage = 'LOST' then
    if coalesce(btrim(new.lost_reason), '') = '' then
      raise exception 'STAGE_RULE: A lost reason is required to mark a job Lost.';
    end if;
    if tg_op = 'UPDATE' then
      select s.is_terminal into from_terminal
      from public.pipeline_stages s
      where s.pipeline_key = old.pipeline_key and s.key = old.stage;
      if coalesce(from_terminal, false) then
        raise exception 'STAGE_RULE: Lost can only be entered from an open stage.';
      end if;
    end if;
  end if;

  if new.stage = 'LAB_PENDING' and not exists (
    select 1 from public.samples
    where job_id = new.id and status = 'SUBMITTED' and archived_at is null
  ) then
    raise exception 'STAGE_RULE: Lab Pending requires at least one sample in SUBMITTED status.';
  end if;

  if new.stage = 'DELIVERED' and not exists (
    select 1 from public.documents
    where job_id = new.id and kind = 'REPORT' and status in ('FINAL', 'SENT') and archived_at is null
  ) then
    raise exception 'STAGE_RULE: Delivered requires a FINAL report document.';
  end if;

  new.stage_entered_at := now();
  if new.stage = 'DELIVERED' and new.delivered_at is null then
    new.delivered_at := now();
  end if;
  if new.stage = 'FIELD_COMPLETE' and new.field_completed_at is null then
    new.field_completed_at := now();
  end if;
  -- Phase 3: entering DELIVERED enqueues the FreshBooks draft invoice (SPEC §6.2).
  return new;
end $$;

drop trigger if exists enforce_job_stage_rules on public.jobs;
create trigger enforce_job_stage_rules before insert or update of stage, pipeline_key on public.jobs
  for each row execute function public.enforce_job_stage_rules();

create or replace function public.log_job_stage_change() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' or new.stage is distinct from old.stage then
    insert into public.activities (type, direction, job_id, property_id, brand, subject, body, raw, created_by)
    values (
      'STAGE_CHANGE', 'INTERNAL', new.id, new.property_id, new.brand,
      case when tg_op = 'INSERT' then 'Job created in ' || new.stage
           else old.stage || ' → ' || new.stage end,
      case when new.stage = 'LOST' then 'Lost reason: ' || new.lost_reason end,
      jsonb_build_object('from', case when tg_op = 'UPDATE' then old.stage end, 'to', new.stage),
      auth.uid()
    );
  end if;
  return null;
end $$;

drop trigger if exists log_job_stage_change on public.jobs;
create trigger log_job_stage_change after insert or update of stage on public.jobs
  for each row execute function public.log_job_stage_change();

create or replace function public.touch_case_stage() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' or new.stage is distinct from old.stage then
    new.stage_entered_at := now();
  end if;
  return new;
end $$;

drop trigger if exists touch_case_stage on public.airnyc_cases;
create trigger touch_case_stage before insert or update of stage on public.airnyc_cases
  for each row execute function public.touch_case_stage();

-- --------------------------------------------------------------------------------------------
-- Audit: every change to a financial table (SPEC §13). Reads of AIRnyc data are logged by the
-- app's data-access layer (lib/airnyc/cases.ts) because Postgres has no SELECT triggers.
-- --------------------------------------------------------------------------------------------
create or replace function public.audit_row_change() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  row_id text;
begin
  row_id := coalesce(
    to_jsonb(coalesce(new, old)) ->> 'id',
    to_jsonb(coalesce(new, old)) ->> 'job_id',
    to_jsonb(coalesce(new, old)) ->> 'campaign_id'
  );
  insert into public.audit_log (actor, action, entity, entity_id, detail)
  values (
    auth.uid(), tg_op, tg_table_name, row_id,
    jsonb_build_object(
      'old', case when tg_op <> 'INSERT' then to_jsonb(old) end,
      'new', case when tg_op <> 'DELETE' then to_jsonb(new) end
    )
  );
  return null;
end $$;

do $$
declare t text;
begin
  foreach t in array array['job_financials', 'invoices_cache', 'sub_costs', 'campaign_costs'] loop
    execute format('drop trigger if exists audit_row_change on public.%I', t);
    execute format(
      'create trigger audit_row_change after insert or update or delete on public.%I for each row execute function public.audit_row_change()',
      t);
  end loop;
end $$;

-- ============================================================================================
-- Row-level security. Enabled on EVERY table in public (SPEC §13), then policies per group.
-- Not FORCEd: the table owner (used by migrations, the worker, and the SECURITY DEFINER helpers
-- above) must bypass RLS, otherwise is_staff() → profiles policy → is_staff() would recurse.
-- ============================================================================================
do $$
declare t record;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t.tablename);
  end loop;
end $$;

-- Core CRM tables: OWNER + VA read/write; hard delete OWNER only (normal flow is archived_at).
do $$
declare t text;
begin
  foreach t in array array[
    'organizations', 'contacts', 'properties', 'property_violations', 'property_roles',
    'jobs', 'field_data', 'samples', 'activities', 'tasks', 'campaigns',
    'airnyc_cases', 'airnyc_case_checklist'
  ] loop
    execute format('create policy staff_select on public.%I for select to authenticated using (public.is_staff())', t);
    execute format('create policy staff_insert on public.%I for insert to authenticated with check (public.is_staff())', t);
    execute format('create policy staff_update on public.%I for update to authenticated using (public.is_staff()) with check (public.is_staff())', t);
    execute format('create policy owner_delete on public.%I for delete to authenticated using (public.is_owner())', t);
  end loop;
end $$;

-- Configuration tables: staff can read, only OWNER can change.
do $$
declare t text;
begin
  foreach t in array array['pipelines', 'pipeline_stages', 'airnyc_checklist_items', 'settings'] loop
    execute format('create policy staff_select on public.%I for select to authenticated using (public.is_staff())', t);
    execute format('create policy owner_write on public.%I for all to authenticated using (public.is_owner()) with check (public.is_owner())', t);
  end loop;
end $$;

-- Financial tables: OWNER only, all operations.
do $$
declare t text;
begin
  foreach t in array array['job_financials', 'invoices_cache', 'sub_costs', 'campaign_costs'] loop
    execute format('create policy owner_all on public.%I for all to authenticated using (public.is_owner()) with check (public.is_owner())', t);
  end loop;
end $$;

-- Documents: VA never sees (or creates, or flips to) a document that contains pricing.
create policy owner_all on public.documents for all to authenticated
  using (public.is_owner()) with check (public.is_owner());
create policy va_select on public.documents for select to authenticated
  using (public.current_app_role() = 'VA' and not contains_pricing);
create policy va_insert on public.documents for insert to authenticated
  with check (public.current_app_role() = 'VA' and not contains_pricing);
create policy va_update on public.documents for update to authenticated
  using (public.current_app_role() = 'VA' and not contains_pricing)
  with check (public.current_app_role() = 'VA' and not contains_pricing);

-- Profiles: everyone signed in can see their own row; staff can see the team (for assignment);
-- only the OWNER can change anything (prevents a user from promoting themselves).
create policy self_select on public.profiles for select to authenticated
  using (user_id = auth.uid() or public.is_staff());
create policy owner_write on public.profiles for all to authenticated
  using (public.is_owner()) with check (public.is_owner());

-- Audit log: append-only. Staff may append entries as themselves; only OWNER may read.
create policy staff_append on public.audit_log for insert to authenticated
  with check (public.is_staff() and actor = auth.uid());
create policy owner_select on public.audit_log for select to authenticated
  using (public.is_owner());

-- job_number_counters is only touched by next_job_number() (SECURITY DEFINER): no policies.

-- Belt and braces: anon gets no table privileges at all.
revoke all on all tables in schema public from anon;

-- ============================================================================================
-- Supabase Storage (only when running on Supabase; the storage schema doesn't exist in plain PG).
--   job-files          staff read/write
--   job-files-pricing  OWNER only — documents with contains_pricing = true are stored here
-- ============================================================================================
do $$
begin
  if exists (select 1 from information_schema.schemata where schema_name = 'storage') then
    insert into storage.buckets (id, name, public) values ('job-files', 'job-files', false)
      on conflict (id) do nothing;
    insert into storage.buckets (id, name, public) values ('job-files-pricing', 'job-files-pricing', false)
      on conflict (id) do nothing;

    execute $p$create policy "job-files staff read" on storage.objects for select to authenticated
      using (bucket_id = 'job-files' and public.is_staff())$p$;
    execute $p$create policy "job-files staff write" on storage.objects for insert to authenticated
      with check (bucket_id = 'job-files' and public.is_staff())$p$;
    execute $p$create policy "job-files owner delete" on storage.objects for delete to authenticated
      using (bucket_id = 'job-files' and public.is_owner())$p$;
    execute $p$create policy "job-files-pricing owner all" on storage.objects for all to authenticated
      using (bucket_id = 'job-files-pricing' and public.is_owner())
      with check (bucket_id = 'job-files-pricing' and public.is_owner())$p$;
  end if;
end $$;
