-- 0016 — bids hold public solicitation data (no ESS pricing), so staff work them; only the OWNER
-- deletes. Our own bid price, when tracked, belongs in an owner-only table, not here.
alter table public.bids enable row level security;
revoke all on public.bids from anon;
create policy staff_select on public.bids for select to authenticated using (public.is_staff());
create policy staff_insert on public.bids for insert to authenticated with check (public.is_staff());
create policy staff_update on public.bids for update to authenticated using (public.is_staff()) with check (public.is_staff());
create policy owner_delete on public.bids for delete to authenticated using (public.is_owner());
drop trigger if exists set_updated_at on public.bids;
create trigger set_updated_at before update on public.bids for each row execute function public.set_updated_at();
alter table public.documents add constraint documents_bid_id_fk foreign key (bid_id) references public.bids(id) on delete cascade;
alter table public.tasks add constraint tasks_bid_id_fk foreign key (bid_id) references public.bids(id) on delete cascade;
alter table public.activities add constraint activities_bid_id_fk foreign key (bid_id) references public.bids(id) on delete set null;
