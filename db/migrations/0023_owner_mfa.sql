-- 0023 — Owner accounts need two-factor login (SPEC §13, Phase 6).
-- A Supabase session carries `aal` in its JWT: aal1 after the email link, aal2 after a TOTP code.
-- An OWNER whose session is still aal1 gets NO app role at all, so every RLS policy denies them
-- (pricing, invoices, everything) until they finish the second step. Enforced here, not just in
-- the UI. Sessions without an `aal` claim (the worker's and MCP's synthetic claims, tests) are not
-- Supabase logins and are unaffected.
create or replace function public.current_app_role() returns public.user_role
language sql stable security definer set search_path = public as $$
  select p.role from public.profiles p
  where p.user_id = auth.uid()
    and not (p.role = 'OWNER' and coalesce(auth.jwt() ->> 'aal', 'aal2') <> 'aal2')
$$;
