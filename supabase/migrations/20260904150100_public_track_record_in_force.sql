-- The landing page badge was counting rules STORED, not rules in force.
--
-- 20260903220000 counts jsonb_array_length(rules) unconditionally, so a book
-- holding a rule that reaches no prompt still advertises it. That badge sits
-- directly above copy claiming these rules were derived from losing trades and
-- are being followed — and after the contract-stamp repair the live book holds
-- four rules of which three are in force. Counting four there would overstate
-- the loop to someone who cannot sign in and check.
--
-- Only the 'rules' key changes. Same test as analyze/rules.ts inForce; the
-- 'market_v1' literal is pinned to PLAN_CONTRACT by src/test/entry-contract.test.ts.
create or replace function public.public_track_record()
returns json
language sql
security definer
stable
set search_path = public
as $$
  select json_build_object(
    'rulebook_version', coalesce((select version from rulebook where id = 1), 0),
    'rules', coalesce((
      select count(*)
      from rulebook r, jsonb_array_elements(r.rules) e
      where r.id = 1 and e->>'contract' = 'market_v1'
    ), 0),
    'updated_at', (select updated_at from rulebook where id = 1)
  );
$$;

revoke all on function public.public_track_record() from public;
grant execute on function public.public_track_record() to anon, authenticated;

comment on function public.public_track_record() is
  'Counts only, no rule text and no per-user data: lets the public landing page show that the learning loop is live. The rule count is rules IN FORCE under the current entry contract, not rules stored.';
