-- ============================================================================================
-- 0002 — Default configuration (SPEC §5, §7.2, §4.10). All of it is editable by the OWNER in
-- Settings; stale_after_days values are starting guesses for Jordan to tune.
-- ============================================================================================

insert into public.pipelines (key, name, service_codes, position) values
  ('INSPECTION', 'Inspection / assessment',
   '{MOLD_ASSESS,MOLD_CLEAR,LEAD_RA,LEAD_CLEAR,LEAD_WATER,ASB_SURVEY,LL152,LL126,LL31,AIRNYC}', 1),
  ('WORK_PLAN', 'Work plans / violation support', '{MOLD_PLAN,VIOLATION}', 2),
  ('AIRNYC', 'AIRnyc SCN cases', '{}', 3)
on conflict (key) do nothing;

insert into public.pipeline_stages (pipeline_key, key, name, position, stale_after_days, is_terminal) values
  ('INSPECTION', 'LEAD',                 'Lead',                    1,  2, false),
  ('INSPECTION', 'QUALIFIED',            'Qualified',               2,  3, false),
  ('INSPECTION', 'PROPOSAL_SENT',        'Proposal Sent',           3,  7, false),
  ('INSPECTION', 'SIGNED',               'Signed',                  4,  5, false),
  ('INSPECTION', 'SCHEDULED',            'Scheduled',               5, 14, false),
  ('INSPECTION', 'FIELD_COMPLETE',       'Field Complete',          6,  2, false),
  ('INSPECTION', 'LAB_PENDING',          'Lab Pending',             7,  7, false),
  ('INSPECTION', 'DRAFTING',             'Drafting',                8,  3, false),
  ('INSPECTION', 'QA',                   'QA',                      9,  2, false),
  ('INSPECTION', 'DELIVERED',            'Delivered',              10,  3, false),
  ('INSPECTION', 'INVOICED',             'Invoiced',               11, 30, false),
  ('INSPECTION', 'PAID',                 'Paid',                   12,  7, false),
  ('INSPECTION', 'CLOSED',               'Closed',                 13, null, true),
  ('INSPECTION', 'NEXT_CYCLE_SCHEDULED', 'Next Cycle Scheduled',   14, null, true),
  ('INSPECTION', 'LOST',                 'Lost',                   99, null, true),

  ('WORK_PLAN', 'LEAD',                  'Lead',                    1,  2, false),
  ('WORK_PLAN', 'PROPOSAL_SENT',         'Proposal Sent',           2,  7, false),
  ('WORK_PLAN', 'SIGNED',                'Signed',                  3,  5, false),
  ('WORK_PLAN', 'SITE_VISIT',            'Site Visit',              4,  7, false),
  ('WORK_PLAN', 'DRAFTING',              'Drafting',                5,  3, false),
  ('WORK_PLAN', 'SUBMITTED_TO_AGENCY',   'Submitted to Agency',     6, 21, false),
  ('WORK_PLAN', 'AGENCY_RESPONSE',       'Agency Response',         7,  7, false),
  ('WORK_PLAN', 'CLOSED',                'Closed',                  8, null, true),
  ('WORK_PLAN', 'LOST',                  'Lost',                   99, null, true),

  ('AIRNYC', 'REFERRAL_RECEIVED',        'Referral Received',       1,  1, false),
  ('AIRNYC', 'MEMBER_CONTACTED',         'Member Contacted',        2,  3, false),
  ('AIRNYC', 'CONSENT',                  'Consent (tenant/landlord)', 3, 7, false),
  ('AIRNYC', 'ASSESSMENT_SCHEDULED',     'Assessment Scheduled',    4, 14, false),
  ('AIRNYC', 'ASSESSMENT_DONE',          'Assessment Done',         5,  2, false),
  ('AIRNYC', 'REPORT_DRAFTED',           'Report Drafted',          6,  3, false),
  ('AIRNYC', 'SUBMITTED_FOR_QC',         'Submitted for QC',        7,  7, false),
  ('AIRNYC', 'QC_REVISIONS',             'QC Revisions',            8,  3, false),
  ('AIRNYC', 'APPROVED',                 'Approved',                9,  3, false),
  ('AIRNYC', 'SUB_COPY_SENT',            'Sub Copy Sent',          10,  7, false),
  ('AIRNYC', 'REMEDIATION_SCHEDULED',    'Remediation Scheduled',  11, 21, false),
  ('AIRNYC', 'REMEDIATION_DONE',         'Remediation Done',       12,  3, false),
  ('AIRNYC', 'CLEARANCE',                'Clearance',              13,  7, false),
  ('AIRNYC', 'CLOSEOUT_DOCS_UPLOADED',   'Closeout Docs Uploaded', 14,  3, false),
  ('AIRNYC', 'INVOICED',                 'Invoiced',               15, 30, false),
  ('AIRNYC', 'PAID',                     'Paid',                   16, null, true),
  ('AIRNYC', 'LOST',                     'Not Proceeding',         99, null, true)
on conflict do nothing;

-- Placeholder file names — confirm AIRnyc's required naming with Jordan before relying on them.
insert into public.airnyc_checklist_items (stage, label, file_name_pattern, position) values
  ('CONSENT',                'Tenant consent form',        '{CASE_ID}_Tenant_Consent.pdf',     1),
  ('CONSENT',                'Landlord consent form',      '{CASE_ID}_Landlord_Consent.pdf',   2),
  ('SUBMITTED_FOR_QC',       'Assessment report',          '{CASE_ID}_Assessment_Report.pdf',  1),
  ('SUBMITTED_FOR_QC',       'Assessment photo log',       '{CASE_ID}_Assessment_Photos.pdf',  2),
  ('CLEARANCE',              'Clearance report',           '{CASE_ID}_Clearance_Report.pdf',   1),
  ('CLOSEOUT_DOCS_UPLOADED', 'Remediation photo log',      '{CASE_ID}_Remediation_Photos.pdf', 1),
  ('CLOSEOUT_DOCS_UPLOADED', 'Closeout package',           '{CASE_ID}_Closeout.pdf',           2),
  ('INVOICED',               'Invoice',                    '{CASE_ID}_Invoice.pdf',            1);

insert into public.settings (id, business_hours) values (1, '{
  "mon": {"open": "08:00", "close": "18:00"},
  "tue": {"open": "08:00", "close": "18:00"},
  "wed": {"open": "08:00", "close": "18:00"},
  "thu": {"open": "08:00", "close": "18:00"},
  "fri": {"open": "08:00", "close": "18:00"},
  "sat": null,
  "sun": null
}'::jsonb)
on conflict (id) do nothing;

-- Exactly one settings row.
alter table public.settings add constraint settings_singleton check (id = 1);
