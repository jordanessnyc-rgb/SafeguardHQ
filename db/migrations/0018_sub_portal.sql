-- ============================================================================================
-- 0018 — Subcontractor portal (SPEC §2 "SUB", Phase 5). A SUB user belongs to one subcontractor
-- organization (profiles.org_id). SUB gets NO policies on any table: everything it can see goes
-- through the two views below, which expose only non-financial job facts and released sub
-- copies for jobs assigned to that sub. So pricing, client billing, contacts, consent forms and
-- other subs' work are unreachable by construction (not just hidden in the UI).
-- The views run with their owner's rights and filter on current_sub_org() themselves.
-- ============================================================================================
create or replace function public.current_sub_org() returns uuid
language sql stable security definer set search_path = public as $$
  select org_id from public.profiles where user_id = auth.uid() and role = 'SUB'
$$;
revoke all on function public.current_sub_org() from public;
grant execute on function public.current_sub_org() to authenticated, service_role;

create or replace view public.sub_portal_jobs with (security_barrier = true) as
  select j.id, j.job_number, j.service_code, j.stage, j.scheduled_at, j.field_completed_at,
         p.address_line, p.unit, p.borough, p.zip
  from public.jobs j
  left join public.properties p on p.id = j.property_id
  where j.sub_org_id is not null
    and j.sub_org_id = public.current_sub_org()
    and j.archived_at is null
    and j.stage <> 'LOST';

create or replace view public.sub_portal_documents with (security_barrier = true) as
  select d.id, d.job_id, d.title, d.version, d.status, d.created_at, d.storage_bucket, d.storage_path
  from public.documents d
  join public.jobs j on j.id = d.job_id
  where d.kind = 'SUB_COPY'
    and not d.contains_pricing
    and d.status in ('FINAL', 'SENT')   -- released by the owner
    and d.storage_bucket = 'job-files'
    and d.archived_at is null
    and j.sub_org_id is not null
    and j.sub_org_id = public.current_sub_org()
    and j.archived_at is null;

revoke all on public.sub_portal_jobs, public.sub_portal_documents from public, anon;
grant select on public.sub_portal_jobs, public.sub_portal_documents to authenticated;
