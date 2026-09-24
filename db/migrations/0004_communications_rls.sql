-- ============================================================================================
-- 0004 — Phase 2 RLS, template seed, and updated_at triggers for the communications tables.
-- ============================================================================================

do $$
declare t text;
begin
  foreach t in array array['phone_lines','webhook_deliveries','message_templates','outbound_messages','mail_sync_state','ai_calls'] loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
  foreach t in array array['phone_lines','message_templates','outbound_messages','mail_sync_state'] loop
    execute format('drop trigger if exists set_updated_at on public.%I', t);
    execute format('create trigger set_updated_at before update on public.%I for each row execute function public.set_updated_at()', t);
  end loop;
end $$;

-- Configuration: staff read, OWNER writes.
create policy staff_select on public.phone_lines for select to authenticated using (public.is_staff());
create policy owner_write on public.phone_lines for all to authenticated using (public.is_owner()) with check (public.is_owner());
create policy staff_select on public.message_templates for select to authenticated using (public.is_staff());
create policy owner_write on public.message_templates for all to authenticated using (public.is_owner()) with check (public.is_owner());

-- Integration health is visible to staff; only the worker (table owner) writes it.
create policy staff_select on public.mail_sync_state for select to authenticated using (public.is_staff());

-- Raw webhook payloads and AI spend: OWNER only.
create policy owner_select on public.webhook_deliveries for select to authenticated using (public.is_owner());
create policy owner_select on public.ai_calls for select to authenticated using (public.is_owner());

-- Outbound messages: staff draft/approve; anything flagged as containing pricing is OWNER-only
-- (SPEC §9.2 "never includes pricing unless OWNER is the approver").
create policy owner_all on public.outbound_messages for all to authenticated
  using (public.is_owner()) with check (public.is_owner());
create policy va_select on public.outbound_messages for select to authenticated
  using (public.current_app_role() = 'VA' and not contains_pricing);
create policy va_insert on public.outbound_messages for insert to authenticated
  with check (public.current_app_role() = 'VA' and not contains_pricing);
create policy va_update on public.outbound_messages for update to authenticated
  using (public.current_app_role() = 'VA' and not contains_pricing)
  with check (public.current_app_role() = 'VA' and not contains_pricing);

revoke all on public.phone_lines, public.webhook_deliveries, public.message_templates,
  public.outbound_messages, public.mail_sync_state, public.ai_calls from anon;

-- Draft wording — Jordan to review before any template is used with clients (Settings → Templates).
insert into public.message_templates (key, name, channel, subject, body) values
  ('NEW_LEAD_ACK', 'New lead acknowledgment', 'SMS', null,
   'Hi {{first_name}}, this is {{brand_name}}. We got your request and will call you shortly. Questions? {{brand_phone}}'),
  ('MISSED_CALL', 'Missed call text-back (business hours)', 'SMS', null,
   'Hi, this is {{brand_name}} — sorry we missed your call. We''ll call you back shortly. You can also text us here.'),
  ('MISSED_CALL_AFTER_HOURS', 'Missed call text-back (after hours)', 'SMS', null,
   'Hi, this is {{brand_name}}. Our office is closed right now — we''ll call you back next business day. You can also text us here.'),
  ('APPOINTMENT_CONFIRMATION', 'Appointment confirmation', 'SMS', null,
   'Hi {{first_name}}, {{brand_name}} is confirmed for {{scheduled_date}} at {{scheduled_time}} at {{address}}. Reply here with any questions.'),
  ('ACCESS_INSTRUCTIONS', 'Access instructions request', 'SMS', null,
   'Hi {{first_name}}, for our visit to {{address}} on {{scheduled_date}}, please let us know how to access the unit (super, key, buzzer).'),
  ('LAB_RESULTS_IN', 'Lab results in', 'SMS', null,
   'Hi {{first_name}}, lab results for {{address}} (job {{job_number}}) are in. We''re preparing your report now.'),
  ('REPORT_READY', 'Report ready', 'SMS', null,
   'Hi {{first_name}}, your report for {{address}} (job {{job_number}}) is ready. Check your email for the link.'),
  ('REVIEW_REQUEST', 'Review request', 'SMS', null,
   'Thanks for choosing {{brand_name}}, {{first_name}}! If we did a good job, a quick review would mean a lot: {{review_url}}')
on conflict (key) do nothing;
