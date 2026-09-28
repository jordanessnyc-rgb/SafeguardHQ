ALTER TABLE "settings" ADD COLUMN "follow_up_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "follow_up_days" integer[] DEFAULT '{3,7}'::int[] NOT NULL;--> statement-breakpoint
insert into public.message_templates (key, name, channel, subject, body) values
  ('PROPOSAL_FOLLOWUP', 'Proposal follow-up (text)', 'SMS', null,
   'Hi {{first_name}}, this is {{brand_name}} checking in on the proposal for {{address}}. Any questions, or would you like to get it on the schedule?'),
  ('PROPOSAL_FOLLOWUP_EMAIL', 'Proposal follow-up (email)', 'EMAIL', 'Following up: your proposal for {{address}}',
   'Hi {{first_name}},

I wanted to check in on the proposal we sent for {{address}} (job {{job_number}}). Happy to answer any questions or adjust the scope. Just reply here and we can get it on the schedule.

Thank you,
{{brand_name}}
{{brand_phone}}')
on conflict (key) do nothing;
