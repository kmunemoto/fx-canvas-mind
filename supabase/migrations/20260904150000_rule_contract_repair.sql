-- One-time repair of the contract stamps the previous build wrote.
--
-- postmortem/prompt.ts stamped every rule it emitted with the PLAN_CONTRACT of
-- the running build, so the field recorded which era happened to be current
-- when the editor ran — never whether the analyst could actually carry the rule
-- out. Version 7 carries four rules stamped market_v1 whose evidence is
-- entirely entry_chosen_v1 (measured: analyses 21/21 and lessons 17/17 are
-- entry_chosen_v1; not one market_v1 row exists). One of them, r1, has cause
-- entry_too_far — a cause causesFor('market_v1') excludes — and instructs the
-- analyst where to enter under a contract in which the server fills at the
-- price of the moment and no such instruction is executable.
--
-- The parser now derives the stamp on every path, so the next consolidation
-- would correct this by itself. That is up to a day away (revisionDue needs one
-- new lesson plus 24h from rulebook.updated_at) and analyze injects these rules
-- into every prompt in the meantime. So: repair now, and let the derivation own
-- the field from here.
--
-- ORDERING: the rebuilt postmortem must be deployed BEFORE this runs. The
-- consolidation cron fires at 8,23,38,53 past the hour; if the old parser is
-- still live when a revision falls due it re-stamps r1 market_v1 and bumps the
-- book to v8, silently undoing this file.
--
-- Predicate: the CAUSE half of stampFor only. The cause list below must stay
-- behaviourally identical to causeOutsideContract(cause, 'market_v1') in
-- postmortem/facts.ts; src/test/entry-contract.test.ts pins the two together.
-- entry_too_early is deliberately absent — canonicalCause folds it to
-- chased_move, which market_v1 does produce.
--
-- The TEXT half of stampFor is not reproduced here: the only v7 rule it would
-- catch (r1) is already caught by the cause. A pre-flight read of the surviving
-- rules' text against ENTRY_LEVER_PHRASES is part of applying this migration;
-- if one names the entry lever, unstamp it by id here rather than porting the
-- phrase list into SQL.
--
-- Three deliberate non-actions:
--   * version is NOT bumped. This is a repair, not a revision; inventing v8
--     invents a cohort in by_rulebook_version that no plan was ever made under.
--   * updated_at is NOT touched. It is the clock revisionDue reads, so moving
--     it would postpone the next revision.
--   * history is NOT edited. It records what the book WAS, and it was this.

update public.rulebook r
set rules = (
      select jsonb_agg(
               case
                 when e->>'contract' = 'market_v1' and e->>'cause' in ('entry_too_far')
                   then jsonb_set(e, '{contract}', 'null'::jsonb)
                 else e
               end
               order by ord)
      from jsonb_array_elements(r.rules) with ordinality as t(e, ord)
    ),
    stats = coalesce(r.stats, '{}'::jsonb) || jsonb_build_object(
      'repair', jsonb_build_object(
        'at', now(),
        'reason', 'contract stamp recorded the build date, not followability',
        'unstamped', (
          select coalesce(jsonb_agg(e->>'id'), '[]'::jsonb)
          from jsonb_array_elements(r.rules) e
          where e->>'contract' = 'market_v1' and e->>'cause' in ('entry_too_far')
        )
      ))
where r.id = 1
  and jsonb_typeof(r.rules) = 'array'
  and exists (
    select 1 from jsonb_array_elements(r.rules) e
    where e->>'contract' = 'market_v1' and e->>'cause' in ('entry_too_far')
  );

-- Companion: backfill evidence_contracts so the era marker is right a day
-- early, instead of waiting for the next consolidation to compute it.
--
-- Written to be TOTAL, not partial. jsonb_agg over zero rows returns SQL NULL,
-- and rulebook.rules is NOT NULL DEFAULT '[]' (20260903150000, line 67) with an
-- id-1 seed row that no migration ever fills. So on any replay of the chain
-- from scratch — supabase db reset, a fresh local DB, a staging project — this
-- statement meets rules = '[]' and, without the guards below, writes NULL into
-- a NOT NULL column and aborts the whole file, taking the repair above with it.
-- The outer coalesce is the belt and the array-length predicate the braces;
-- keep both. supported_by is type-checked rather than coalesced because a jsonb
-- 'null' is not SQL NULL and would slip past coalesce into jsonb_array_elements.
update public.rulebook r
set rules = coalesce((
      select jsonb_agg(
               jsonb_set(e, '{evidence_contracts}', (
                 select coalesce(jsonb_agg(distinct coalesce(l.plan_contract, 'entry_chosen_v1')), '[]'::jsonb)
                 from jsonb_array_elements_text(
                        case when jsonb_typeof(e->'supported_by') = 'array'
                             then e->'supported_by' else '[]'::jsonb end) s
                 join public.lessons l on l.analysis_id = s::uuid
               ))
               order by ord)
      from jsonb_array_elements(r.rules) with ordinality as t(e, ord)
    ), '[]'::jsonb)
where r.id = 1
  and jsonb_typeof(r.rules) = 'array'
  and jsonb_array_length(r.rules) > 0;
