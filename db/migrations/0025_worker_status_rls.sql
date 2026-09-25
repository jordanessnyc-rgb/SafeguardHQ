-- 0025 — worker_status: written only by the worker (privileged connection); the owner reads it
-- on the admin health page. Error text can mention clients, so VAs don't see it.
alter table public.worker_status enable row level security;
revoke all on public.worker_status from anon;
create policy owner_read on public.worker_status for select to authenticated using (public.is_owner());
