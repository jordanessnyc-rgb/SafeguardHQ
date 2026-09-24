-- 0012 — pricing rules are money: OWNER only (CLAUDE.md rule 4), audited like other financial tables.
alter table public.pricing_rules enable row level security;
revoke all on public.pricing_rules from anon;
create policy owner_all on public.pricing_rules for all to authenticated using (public.is_owner()) with check (public.is_owner());
drop trigger if exists set_updated_at on public.pricing_rules;
create trigger set_updated_at before update on public.pricing_rules for each row execute function public.set_updated_at();
drop trigger if exists audit_row_change on public.pricing_rules;
create trigger audit_row_change after insert or update or delete on public.pricing_rules
  for each row execute function public.audit_row_change();
