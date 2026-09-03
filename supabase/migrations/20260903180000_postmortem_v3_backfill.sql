-- Post-mortem v3: nothing is left unreviewed, and the record is measurable.
--
-- 1. The first post-mortem version wrote diagnoses without the thin/revisions
--    keys the v2 revisit filter keys on, so plans diagnosed on three bars of
--    aftermath were never looked at again. Backfill both from the stored
--    facts: thin when fewer than MIN_AFTER_BARS (8) bars followed the
--    settlement, revisions 0, so the next sweep revisits the thin ones.
update public.analyses
set postmortem = postmortem || jsonb_build_object(
  'thin', coalesce((postmortem->'facts'->>'bars_after_settlement')::int, 0) < 8,
  'revisions', 0
)
where postmortem is not null
  and postmortem->>'status' = 'done'
  and (postmortem->'thin') is null;

-- 2. The post-mortem now records which rule it blames or credits, so a rule
--    can be judged on the plans made under it.
alter table public.lessons add column if not exists rule_blamed text;
alter table public.lessons add column if not exists rule_credited text;

-- 3. The consolidation reads settled plans by rulebook version to score each
--    version (and each rule) on what its plans then did.
create index if not exists analyses_rulebook_version_idx
  on public.analyses (rulebook_version, outcome)
  where rulebook_version is not null and shadow = false;
