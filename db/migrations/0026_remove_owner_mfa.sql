-- 0026 — Jordan decided against two-step sign-in (2026-09-25). current_app_role() goes back to the
-- plain profile lookup from 0001: the session's `aal` no longer matters.
create or replace function public.current_app_role() returns public.user_role
language sql stable security definer set search_path = public as $$
  select role from public.profiles where user_id = auth.uid()
$$;
