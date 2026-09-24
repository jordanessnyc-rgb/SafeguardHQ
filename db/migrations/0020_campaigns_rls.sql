-- 0020 — campaign scans: staff can read counts; rows are written by the public /q/<slug> route
-- through the service connection. Campaign costs stay OWNER-only (campaign_costs, Phase 1).
alter table public.campaign_events enable row level security;
revoke all on public.campaign_events from anon;
create policy staff_select on public.campaign_events for select to authenticated using (public.is_staff());
-- One QR slug per campaign.
create unique index if not exists campaigns_qr_slug_uq on public.campaigns ((tracking ->> 'qrSlug')) where tracking ->> 'qrSlug' is not null;
