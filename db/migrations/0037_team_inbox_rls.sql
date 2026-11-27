-- ============================================================================================
-- 0037 — Team inbox & internal chat RLS. Office staff (OWNER + VA) only; FIELD, SUB and no-role
-- users see none of it. Nothing here is ever sent outside the team.
--  - conversation_assignments: staff can assign, reassign and unassign any conversation.
--  - team_messages: staff read the room; you post as yourself; you (or the OWNER) delete yours.
--  - notifications: you only see and mark your own; staff can create them for teammates
--    (that's how an @mention or an assignment reaches someone).
--  - chat_reads, conversation_reads, conversation_stars: your own rows only (personal read state
--    and stars).
-- ============================================================================================
do $$
declare t text;
begin
  foreach t in array array['conversation_assignments', 'team_messages', 'notifications', 'chat_reads', 'conversation_reads', 'conversation_stars'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon', t);
  end loop;
end $$;

create policy staff_all on public.conversation_assignments for all to authenticated
  using (public.is_staff()) with check (public.is_staff());

create policy staff_select on public.team_messages for select to authenticated using (public.is_staff());
create policy author_insert on public.team_messages for insert to authenticated
  with check (public.is_staff() and author_id = auth.uid());
create policy author_update on public.team_messages for update to authenticated
  using (public.is_staff() and (author_id = auth.uid() or public.is_owner()))
  with check (public.is_staff() and (author_id = auth.uid() or public.is_owner()));

create policy own_select on public.notifications for select to authenticated using (user_id = auth.uid() and public.is_staff());
create policy own_update on public.notifications for update to authenticated
  using (user_id = auth.uid() and public.is_staff()) with check (user_id = auth.uid() and public.is_staff());
create policy own_delete on public.notifications for delete to authenticated using (user_id = auth.uid() and public.is_staff());
create policy staff_insert on public.notifications for insert to authenticated with check (public.is_staff());

create policy own_all on public.chat_reads for all to authenticated
  using (user_id = auth.uid() and public.is_staff()) with check (user_id = auth.uid() and public.is_staff());

create policy own_all on public.conversation_reads for all to authenticated
  using (user_id = auth.uid() and public.is_staff()) with check (user_id = auth.uid() and public.is_staff());
create policy own_all on public.conversation_stars for all to authenticated
  using (user_id = auth.uid() and public.is_staff()) with check (user_id = auth.uid() and public.is_staff());
