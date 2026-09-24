-- 0022 — MCP tokens: staff manage their OWN tokens only (hashes; the token is shown once).
-- The /api/mcp route verifies tokens with the privileged connection, then runs every tool as
-- the token's user so RLS applies.
alter table public.mcp_tokens enable row level security;
revoke all on public.mcp_tokens from anon;
create policy own_tokens on public.mcp_tokens for all to authenticated
  using (public.is_staff() and user_id = auth.uid())
  with check (public.is_staff() and user_id = auth.uid());
