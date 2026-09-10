-- Three scores kept apart: was the call right about DIRECTION, how much heat
-- the entry took (TIMING), and whether the stop and the target were put in
-- defensible places (PLACEMENT).
--
-- WHY NOW, AND WHY NOTHING UNDER supabase/functions/ CHANGES.
--
-- Win/loss collapses all three into one number. A plan that was right about
-- which way price went and wrong about where the stop went comes out as
-- "loss", identical to a plan that was simply wrong. The facts needed to tell
-- those apart are ALREADY WRITTEN, per row, by the post-mortem into
-- public.analyses.postmortem->'facts' (supabase/functions/postmortem/facts.ts).
-- This migration reads them and rolls them up. It computes no new fact, it
-- rewrites no stored row, and it changes how not one existing row is scored.
--
-- That restraint is the point rather than politeness. The forward evaluation
-- (#65 stage B) has just been frozen and has collected zero rows. Every row it
-- will collect is scored from here on, so a scoring definition introduced today
-- applies uniformly to that whole population; one introduced next week would
-- split it across two definitions and there would be nothing in the stored rows
-- to say which cell belonged to which. Hence `definition_version` in the
-- output: a change in how something is counted looks exactly like the analyst
-- getting better or worse, and nothing else on the object can tell them apart.
--
-- ---------------------------------------------------------------------------
-- SECURITY: THIS IS SECURITY INVOKER, AND THE BRIEF ASKED FOR DEFINER.
-- ---------------------------------------------------------------------------
--
-- The brief for this change said to match public.performance_stats() and
-- described it as security definer. It is not. Checked against production on
-- 2026-09-10 with pg_get_functiondef: performance_stats is SECURITY INVOKER
-- (pg_proc.prosecdef = false) with `set search_path to 'public', 'pg_temp'`,
-- and the migration that last replaced it
-- (20260908093000_who_declined_is_not_who_refused.sql) spells out why —
-- public.analyses has RLS enabled, so running as the caller IS the whole of how
-- the function is scoped to one account, and there is deliberately no
-- `user_id = auth.uid()` in its body.
--
-- Copying "definer" out of the brief here would have been a data leak, not a
-- style choice. This database holds TWO accounts (2026-09-10). A definer
-- function over public.analyses with no auth.uid() filter would pool both of
-- them into one owner's win rate — which is the exact defect
-- 20260907042000_loop_health_counts_episodes.sql documents in loop_health, and
-- the reason loop_health carries an explicit auth.uid() on every counter.
--
-- So: invoker, RLS does the scoping, same search_path, same grants. The
-- brief's other security instruction — that this must never return another
-- user's analysis ids (#46) — is honoured the strongest way available: this
-- function returns NO ids of any kind, from any table. Every value in its
-- output is a count, a rate, an interval bound or a threshold constant. There
-- is no row identifier to leak, so there is no filter anybody can forget.

-- ---------------------------------------------------------------------------
-- WHAT EACH SCORE IS COMPUTED FROM, AND WHERE THE NUMBERS CAME FROM
-- ---------------------------------------------------------------------------
--
-- Every threshold below is one that already exists in
-- supabase/functions/postmortem/facts.ts. None was invented here, because a
-- new boundary would mean the rollup and the per-row diagnosis disagreed about
-- the same row:
--
--   DIRECTION_DEAD_R  0.1  — price never came this far the signal's way
--   EARLY_ADVERSE_R   0.5  — adverse move in the first bars after the fill
--   LUCKY_MAE_R       0.8  — MAE this close to the stop makes a win a lucky one
--
-- (a) DIRECTION reuses causeGrounds('direction_wrong') exactly, both of its
--     positive tests and neither more:
--       ran_past   — after.beyond_sl_r >= 1 and the target was never reached
--                    afterwards: price kept going past the stop.
--       never_came — from_signal.max_favorable_r_in_life < DIRECTION_DEAD_R:
--                    it never came our way at all while the plan was live.
--     Right = neither test fires AND both measurements exist. The life-only
--     excursion is used, not the one that includes the after-window, for the
--     reason facts.ts gives: a plan that died flat and bounced after the stop
--     was already paid would otherwise read as though the direction had been
--     fine — post-decision noise deciding a question about the decision.
--     Note what this does NOT read: whether the trade won. A direction can be
--     right on a losing row, and separating that is the whole point.
--
-- (b) TIMING is facts.early_adverse_r against EARLY_ADVERSE_R: how far price
--     went against the plan in the first EARLY_BARS bars after the fill. A
--     second, deeper measure — facts.mae_r against LUCKY_MAE_R — is reported
--     BESIDE it with its own n rather than merged into it, because the two are
--     measured over different rows and different windows.
--
-- (c) PLACEMENT reuses causeGrounds('stop_too_tight') and
--     causeGrounds('target_too_far'), which are the counterfactual levers the
--     post-mortem already runs through the same judge the real plan went
--     through. `leverMoved` is transcribed literally, tri-state and all:
--     a variant that came back null or 'ambiguous' has not answered, and an
--     'untriggered' stop or target variant describes a trade that never
--     happened, which answers nothing about the trade that did. Placement is
--     scored only when both questions were answered; the rest are counted as
--     unscored and shown.
--
-- ---------------------------------------------------------------------------
-- THREE DENOMINATORS, NEVER ONE (#38, #25)
-- ---------------------------------------------------------------------------
--
-- The three scores are taken over three DIFFERENT populations and the gaps are
-- large. Measured on production 2026-09-10, contract market_v1, 36 diagnosed
-- trade rows: direction is scoreable on 33, timing on 26, placement on 24. So
-- every score carries its own `n`, its own Wilson interval, and its own
-- `unscored` count, and a reader is never handed three percentages that look
-- like they share a denominator.
--
-- A WARNING FOR ANYONE READING THE FACTS TABLE DIRECTLY. The KEY and the VALUE
-- are not the same count, and confusing them overstates every denominator:
--
--   early_adverse_r   key present on 82 rows, non-null on 37
--   mae_r             key present on 79 rows, non-null on 45
--
-- `facts ? 'early_adverse_r'` says the post-mortem build that wrote the row
-- knew about the field. `facts->>'early_adverse_r' is not null` says it was
-- actually measured — and it is null whenever the fill instant was
-- unparseable or the order was a stop entry. This function counts VALUES.
-- Everything else lands in `unscored`, which is published rather than dropped.
--
-- ---------------------------------------------------------------------------
-- WHAT THE THREE MAY NOT CLAIM
-- ---------------------------------------------------------------------------
--
--   * direction can be right while the trade lost. That is what separating it
--     is for, and it is why direction reads no outcome column.
--   * timing measured as adverse excursion says how much HEAT the entry took,
--     not whether the entry was wrong. A trend entry takes heat by
--     construction, and this record is one sustained downtrend.
--   * placement is partly a CONSEQUENCE of direction and timing. The three are
--     not independent and they are not a decomposition: they do not add up to
--     the win rate, they do not partition anything, and no arithmetic here
--     invites that reading. Three views of the same rows.
--
-- ---------------------------------------------------------------------------
-- THE POPULATION IS NARROW AND THE OUTPUT SAYS SO
-- ---------------------------------------------------------------------------
--
-- Production on 2026-09-10 holds 101 analyses rows. THIS FUNCTION COUNTS 97 OF
-- THEM: 4 are weekend previews and the filter below drops them, exactly as
-- performance_stats does. So the raw table reads 55 SELL / 45 WAIT / 1 BUY and
-- `population` reports 55 / 41 / 1, and the difference is those 4 preview
-- WAITs and nothing else. ONE pair (USD/JPY), about two weeks (2026-08-29 to
-- 2026-09-10), one sustained downtrend.
--
-- AND NO CALLER WILL SEE THOSE 97. That figure is an admin read across both
-- accounts. The function is INVOKER (see above), so each caller's `population`
-- is their own rows only — measured 2026-09-10, the two accounts see 76 calls
-- (SELL 38 / WAIT 38, 2026-09-07 to 2026-09-10) and 21 calls (SELL 17 / WAIT 3
-- / BUY 1, 2026-08-29 to 2026-09-04) respectively. Every figure in this header
-- is therefore a pooled number that appears on nobody's screen; the screen's
-- own numbers come from `population`, which is why `population` is computed
-- and shipped rather than written into a caption.
--
-- Three confident percentages printed without saying what they rest on is the
-- class of thing #83 has already had to remove from this screen twice. So
-- `population` ships in the same object as the scores — pairs, signal mix,
-- span, and the count of rows that carry no diagnosis at all — and the panel
-- renders it above the numbers, not under a disclosure nobody opens, and
-- renders it FROM THE DATA rather than from a sentence that goes stale.

-- public.wilson95(int, int) already exists
-- (20260905200000_performance_stats.sql) and is reused verbatim rather than
-- re-derived here: two implementations of one interval is how one number with
-- one name becomes two.

create or replace function public.separated_scores(live_contract text default 'market_v1')
returns jsonb
language sql
stable
-- See the block above. INVOKER, exactly as performance_stats: RLS on
-- public.analyses and public.lessons scopes this to the caller's own rows, and
-- there is deliberately no user_id = auth.uid() in the body.
security invoker
set search_path to 'public', 'pg_temp'
as $function$
with
-- Constants, named once. They are the facts.ts constants and must stay the
-- facts.ts constants; src/test/separated-scores.test.ts pins this block
-- against that file so a change on either side breaks loudly.
k as (
  select
    0.1::numeric as direction_dead_r,
    0.5::numeric as early_adverse_r,
    0.8::numeric as lucky_mae_r
),
-- Same population filter as performance_stats: no shadows (plans the gate
-- refused, tracked apart and never part of the record) and no previews (a
-- weekend read is what the analyst says when it cannot act).
mine as (
  select
    a.id,
    a.pair, a.signal, a.interval, a.created_at,
    coalesce(a.plan_contract, 'entry_chosen_v1') as contract,
    a.postmortem,
    a.postmortem->'facts' as f
  from public.analyses a
  where a.shadow = false and a.preview = false
),
-- The scoreable population: a diagnosed TRADE. A WAIT is excluded from all
-- three scores rather than scored as 0 or as 100 — it has no fill, no stop and
-- no target, so none of the three questions is even asked of it. WAITs have
-- their own verdict (wait_check) and their own strip on the screen; counting
-- them here would let a call that declined to trade improve a placement score.
-- They are counted in `population.waits` so the exclusion is visible.
graded as (
  select
    m.id, m.contract,
    (m.f->'from_signal'->>'max_favorable_r_in_life')::numeric as fav_life,
    (m.f->'after'->>'beyond_sl_r')::numeric as beyond_sl_r,
    -- `is not null` AND `<> 'null'::jsonb`: an absent key and an explicit JSON
    -- null both mean "the target was not reached after the settlement", and
    -- only one of them is caught by a null test. Reading `->` alone here made
    -- every row look like the target had come back.
    (m.f->'after'->'reached_tp1' is not null and m.f->'after'->'reached_tp1' <> 'null'::jsonb) as tp1_after,
    (m.f->>'early_adverse_r')::numeric as early_adverse_r,
    (m.f->>'mae_r')::numeric as mae_r,
    nullif(m.f->>'resolution', '') as res,
    coalesce((m.f->>'bars_after_settlement')::int, 0) as bars_after,
    m.f->'counterfactual'->'stop_x1_5' as cf_stop_x1_5,
    m.f->'counterfactual'->'stop_x2'   as cf_stop_x2,
    m.f->'counterfactual'->'tp_half'   as cf_tp_half
  from mine m
  where m.signal in ('BUY', 'SELL')
    and m.postmortem->>'status' = 'done'
    and m.f is not null
),
-- leverMoved(), transcribed. Tri-state on purpose: NULL is "the question was
-- asked and has not been answered", which is evidence for nothing in either
-- direction, and it must never collapse to false.
--
--   null       — not computed, still open, or 'ambiguous'
--   null       — 'untriggered' on a stop or target variant: those keep the
--                original entry, so an untriggered one describes a trade that
--                never happened
--   res <> our — the lever moved the outcome
--
-- Compared against what the REAL plan settled as, never against 'win': "did
-- this lever change the ending" is a question about the difference between two
-- endings, not about one of them being good. On a loss, an EXPIRED wider-stop
-- variant is a lever that moved — the -1R never happens.
levers as (
  select g.*,
    case
      when g.cf_stop_x1_5 is null or g.cf_stop_x1_5 = 'null'::jsonb then null
      when g.cf_stop_x1_5->>'resolution' is null
        or g.cf_stop_x1_5->>'resolution' in ('ambiguous', 'untriggered') then null
      when g.res is null then null
      else (g.cf_stop_x1_5->>'resolution') <> g.res
    end as moved_stop_x1_5,
    case
      when g.cf_stop_x2 is null or g.cf_stop_x2 = 'null'::jsonb then null
      when g.cf_stop_x2->>'resolution' is null
        or g.cf_stop_x2->>'resolution' in ('ambiguous', 'untriggered') then null
      when g.res is null then null
      else (g.cf_stop_x2->>'resolution') <> g.res
    end as moved_stop_x2,
    case
      when g.cf_tp_half is null or g.cf_tp_half = 'null'::jsonb then null
      when g.cf_tp_half->>'resolution' is null
        or g.cf_tp_half->>'resolution' in ('ambiguous', 'untriggered') then null
      when g.res is null then null
      else (g.cf_tp_half->>'resolution') <> g.res
    end as moved_tp_half
  from graded g
),
scored as (
  select l.*,
    -- (a) DIRECTION. The two positive tests for a wrong direction, and nothing
    -- else. The fallback that used to file every otherwise-unexplained loss as
    -- direction_wrong is what those two tests were written to replace, and it
    -- must not come back in through a rollup.
    (l.beyond_sl_r is not null and l.beyond_sl_r >= 1 and not l.tp1_after) as dir_ran_past,
    (l.fav_life is not null and l.fav_life < (select direction_dead_r from k)) as dir_never_came,
    -- (c) PLACEMENT, one verdict per lever, three-valued.
    --
    -- The stop: only a LOSS can be asked whether its stop was too tight. On a
    -- win or an expiry "a wider stop would have done better" is not a claim
    -- these numbers carry — on an expired plan a wider stop that LOST reads as
    -- a lever that moved the outcome, which is true and is the opposite of
    -- this cause. So a settled non-loss scores the stop as defensible and a
    -- row with no recorded resolution scores as unknown.
    --
    -- READ THAT AGAIN, BECAUSE IT IS THE WEAKEST JOINT IN THIS WHOLE FUNCTION.
    -- `res <> 'loss' then 'ok'` means a WINNING trade passes the stop test
    -- WITHOUT ITS STOP EVER BEING SIMULATED. stop_verdict = 'bad' is
    -- unreachable on a win by construction. Measured 2026-09-10 on market_v1:
    -- of the 13 rows scored "placement fine", 10 are wins whose stop was never
    -- tested and only 3 are losses where both wider-stop variants were
    -- actually run and did not move the outcome. So a run of wins lifts this
    -- score whether or not the stops moved an inch.
    --
    -- This is a faithful transcription of causeGrounds('stop_too_tight') and
    -- it is not changed here — changing it would be a new scoring definition,
    -- which is the one thing #65 stage B forbids this week. It is instead
    -- COUNTED and PUBLISHED as `stop_untested`, so the panel can say how much
    -- of the placement score rests on a stop nothing examined. A caveat that
    -- lives only in this comment is a caveat the owner never reads.
    case
      when l.res is null then 'unknown'
      when l.res <> 'loss' then 'ok'
      when l.tp1_after or l.moved_stop_x1_5 is true or l.moved_stop_x2 is true then 'bad'
      when l.moved_stop_x1_5 is false and l.moved_stop_x2 is false and l.bars_after > 0 then 'ok'
      else 'unknown'
    end as stop_verdict,
    case
      when l.moved_tp_half is true then 'bad'
      when l.moved_tp_half is false then 'ok'
      else 'unknown'
    end as target_verdict
  from levers l
),
-- One row per contract plus one for the live contract's headline scope. Shaped
-- like performance_stats: the headline describes the LIVE contract only,
-- because under entry_chosen_v1 a plan the market never reached went unscored
-- and under market_v1 that cannot happen — pooling the two answers a question
-- nobody asked. by_contract is computed over every row so a record made
-- entirely under an older contract is still visible, correctly labelled.
tagged as (
  select s.*, 'scope'::text as dim, 'all_time'::text as key
  from scored s where s.contract = live_contract
  union all
  select s.*, 'by_contract'::text as dim, s.contract as key
  from scored s
),
agg as (
  select
    t.dim, t.key,
    count(*)::int as graded_trades,

    -- (a) direction
    count(*) filter (
      where t.dir_ran_past or t.dir_never_came
         or (t.beyond_sl_r is not null and t.fav_life is not null)
    )::int as dir_n,
    count(*) filter (
      where not (t.dir_ran_past or t.dir_never_came)
        and t.beyond_sl_r is not null and t.fav_life is not null
    )::int as dir_right,
    count(*) filter (where t.dir_ran_past)::int as dir_ran_past,
    count(*) filter (where t.dir_never_came)::int as dir_never_came,
    -- The one asymmetry in this denominator, counted so it is visible the day
    -- it starts to bite. A row enters dir_n either because a wrong-direction
    -- test FIRED or because both measurements are present; so a row missing
    -- beyond_sl_r can join the denominator as a MISS (never_came fired on
    -- fav_life alone) but the same row could never have joined it as a HIT.
    -- That is causeGrounds' supported/contradicted/unknown trichotomy read
    -- verbatim, and departing from it here would mean the rollup and the
    -- per-row diagnosis disagreed about the same row — so it stays, and this
    -- counter is how a reader sees how many rows it applies to. Measured
    -- 2026-09-10: 0, on both contracts.
    count(*) filter (
      where (t.dir_ran_past or t.dir_never_came)
        and not (t.beyond_sl_r is not null and t.fav_life is not null)
    )::int as dir_wrong_partial,

    -- (b) timing
    count(*) filter (where t.early_adverse_r is not null)::int as tim_n,
    count(*) filter (
      where t.early_adverse_r is not null
        and t.early_adverse_r < (select early_adverse_r from k)
    )::int as tim_calm,
    count(*) filter (where t.mae_r is not null)::int as mae_n,
    count(*) filter (
      where t.mae_r is not null and t.mae_r >= (select lucky_mae_r from k)
    )::int as mae_deep,

    -- (c) placement
    count(*) filter (
      where t.stop_verdict <> 'unknown' and t.target_verdict <> 'unknown'
    )::int as pl_n,
    count(*) filter (where t.stop_verdict = 'ok' and t.target_verdict = 'ok')::int as pl_ok,
    -- Both counted over pl_n, NOT over graded_trades. They are printed beside
    -- the placement rate, so they must be over the rate's own denominator: a
    -- row with a bad stop and an unanswered target is excluded from pl_n and
    -- therefore excluded here too (it is already visible in `unscored`).
    -- Counted over graded_trades these two happened to equal pl_n - pl_ok on
    -- today's data by coincidence, which is exactly how a reader learns to add
    -- up three numbers that are not required to add up.
    count(*) filter (
      where t.stop_verdict <> 'unknown' and t.target_verdict <> 'unknown'
        and t.stop_verdict = 'bad')::int as pl_stop_bad,
    count(*) filter (
      where t.stop_verdict <> 'unknown' and t.target_verdict <> 'unknown'
        and t.target_verdict = 'bad')::int as pl_target_bad,
    -- Of the rows counted as "placement fine", how many passed the stop leg
    -- without the stop being simulated at all — see the long comment on
    -- stop_verdict. Published so the panel can put a number on it.
    count(*) filter (
      where t.stop_verdict = 'ok' and t.target_verdict = 'ok'
        and t.res is distinct from 'loss')::int as pl_stop_untested
  from tagged t
  group by t.dim, t.key
),
-- The cause taxonomy is ALREADY separated on public.lessons.cause. It is read
-- here and not duplicated: no cause is re-derived from the facts, and no row is
-- re-diagnosed. The families below are a grouping of the existing vocabulary
-- and nothing more.
--
-- The grouping is NOT a partition, and saying so is the honest part.
-- stop_too_tight is a fact about where the stop sat AND about how much noise
-- the entry sat in; it is filed under placement here because a stop's location
-- is placement, and the doc says it straddles. entry_too_far and
-- entry_too_early are legacy vocabulary that market_v1 cannot produce; they are
-- kept because stored rows carry them, with entry_too_early folded into
-- chased_move exactly as canonicalCause() folds it.
--
-- AND IT IS A DIFFERENT POPULATION FROM THE THREE SCORES. The scores exclude
-- WAITs on principle (see `graded`); this table does not, because a WAIT has a
-- cause and that cause is worth reading. Measured 2026-09-10 on market_v1: 65
-- lesson rows, of which 29 come from WAITs (good_wait 18, wait_missed_trade
-- 11) and land in `neither`. So the count of WAIT rows ships alongside the
-- total, and the panel prints both — three scores over 36 trades and a
-- histogram over 65 lessons under one heading, with no n on the second, is the
-- same denominator error this whole function exists to refuse.
--
-- The join to `mine` is what keeps the two populations filtered the same way.
-- public.lessons has a `shadow` column but NO `preview` column, so the
-- preview filter cannot be written on the lessons row itself; joining to the
-- already-filtered analyses is the only way to apply it. Today it changes
-- nothing (0 orphaned lessons, 0 lessons under a preview parent), which is the
-- point: the guard goes in while it is free.
lesson_rows as (
  select
    coalesce(l.plan_contract, 'entry_chosen_v1') as contract,
    case when l.cause = 'entry_too_early' then 'chased_move' else l.cause end as cause,
    m.signal
  from public.lessons l
  join mine m on m.id = l.analysis_id
  where l.shadow = false and l.cause is not null
),
lesson_family as (
  select r.contract, r.cause, r.signal,
    case r.cause
      when 'direction_wrong' then 'direction'
      when 'regime_misread'  then 'direction'
      when 'chased_move'     then 'timing'
      when 'stop_too_tight'  then 'placement'
      when 'target_too_far'  then 'placement'
      when 'entry_too_far'   then 'placement'
      else 'neither'
    end as family
  from lesson_rows r
),
lesson_tagged as (
  select f.*, 'scope'::text as dim, 'all_time'::text as key
  from lesson_family f where f.contract = live_contract
  union all
  select f.*, 'by_contract'::text as dim, f.contract as key
  from lesson_family f
),
lesson_agg as (
  select
    lt.dim, lt.key,
    jsonb_build_object(
      'total', count(*)::int,
      -- How many of `total` came from a call that declined to trade. Those
      -- rows are in this histogram and in NONE of the three scores above it,
      -- and the gap is large enough (29 of 65 on 2026-09-10) that a reader who
      -- assumes one population is reading a different set by nearly half.
      'waits', count(*) filter (where lt.signal = 'WAIT')::int,
      'direction', count(*) filter (where lt.family = 'direction')::int,
      'timing', count(*) filter (where lt.family = 'timing')::int,
      'placement', count(*) filter (where lt.family = 'placement')::int,
      'neither', count(*) filter (where lt.family = 'neither')::int,
      'by_cause', coalesce(
        (select jsonb_object_agg(c.cause, c.n)
         from (
           select lt2.cause, count(*)::int as n
           from lesson_tagged lt2
           where lt2.dim = lt.dim and lt2.key = lt.key
           group by lt2.cause
         ) c),
        '{}'::jsonb)
    ) as value
  from lesson_tagged lt
  group by lt.dim, lt.key
),
shaped as (
  select
    a.dim, a.key,
    jsonb_build_object(
      -- The population every score below was drawn FROM, before any of them
      -- dropped a row for want of a measurement.
      'graded_trades', a.graded_trades,
      -- (a) DIRECTION. Right about which way price went, over the plan's own
      -- life, whatever the trade settled as.
      'direction', jsonb_build_object(
        'n', a.dir_n,
        'hits', a.dir_right,
        'rate', case when a.dir_n > 0 then round(a.dir_right::numeric * 100 / a.dir_n)::int end,
        'ci95', case when a.dir_n > 0 then public.wilson95(a.dir_right, a.dir_n) end,
        -- Rows the score could not be taken on, shown rather than dropped.
        'unscored', a.graded_trades - a.dir_n,
        'ran_past_stop', a.dir_ran_past,
        'never_came', a.dir_never_came,
        -- Rows in this denominator that could only ever have been a miss.
        -- Zero today; published so it is not zero silently. See agg.
        'wrong_partial', a.dir_wrong_partial,
        'below_min_n', a.dir_n < 20
      ),
      -- (b) TIMING. How much the entry went underwater at once. NOT a claim
      -- that the entry was wrong.
      'timing', jsonb_build_object(
        'n', a.tim_n,
        'hits', a.tim_calm,
        'rate', case when a.tim_n > 0 then round(a.tim_calm::numeric * 100 / a.tim_n)::int end,
        'ci95', case when a.tim_n > 0 then public.wilson95(a.tim_calm, a.tim_n) end,
        'unscored', a.graded_trades - a.tim_n,
        'below_min_n', a.tim_n < 20,
        -- The deeper excursion, over its OWN rows. Beside the early one and
        -- never merged into it: different window, different denominator.
        'deep_mae', jsonb_build_object(
          'n', a.mae_n,
          'hits', a.mae_deep,
          'rate', case when a.mae_n > 0 then round(a.mae_deep::numeric * 100 / a.mae_n)::int end,
          'ci95', case when a.mae_n > 0 then public.wilson95(a.mae_deep, a.mae_n) end,
          'unscored', a.graded_trades - a.mae_n,
          'below_min_n', a.mae_n < 20
        )
      ),
      -- (c) PLACEMENT. Both levers answered, and neither of them moved.
      'placement', jsonb_build_object(
        'n', a.pl_n,
        'hits', a.pl_ok,
        'rate', case when a.pl_n > 0 then round(a.pl_ok::numeric * 100 / a.pl_n)::int end,
        'ci95', case when a.pl_n > 0 then public.wilson95(a.pl_ok, a.pl_n) end,
        'unscored', a.graded_trades - a.pl_n,
        'stop_bad', a.pl_stop_bad,
        'target_bad', a.pl_target_bad,
        -- How many of `hits` passed the stop leg only because the trade did
        -- not lose, its stop never having been simulated. On 2026-09-10 that
        -- is 10 of 13. The panel prints it beside the rate.
        'stop_untested', a.pl_stop_untested,
        'below_min_n', a.pl_n < 20
      ),
      'causes', coalesce(
        (select la.value from lesson_agg la where la.dim = a.dim and la.key = a.key),
        jsonb_build_object('total', 0, 'waits', 0, 'direction', 0, 'timing', 0, 'placement', 0,
                           'neither', 0, 'by_cause', '{}'::jsonb))
    ) as value
  from agg a
)
select jsonb_build_object(
  'generated_at', now(),
  'live_contract', live_contract,
  -- Bump this and every stored comparison across the boundary becomes two
  -- experiments reported as one. See the header.
  'definition_version', 1,
  -- Published so a reader can check the rollup against facts.ts rather than
  -- take it on trust, and so a drift between the two is visible on the screen
  -- rather than only in a test.
  'thresholds', (select jsonb_build_object(
    'direction_dead_r', direction_dead_r,
    'early_adverse_r', early_adverse_r,
    'lucky_mae_r', lucky_mae_r) from k),
  -- WHAT THE NUMBERS REST ON. Shipped in the same object as the scores, on
  -- purpose: three confident percentages over one pair, one direction and two
  -- weeks is the shape of the thing #83 removed twice.
  'population', (
    select jsonb_build_object(
      'calls', count(*)::int,
      'trades', count(*) filter (where signal in ('BUY', 'SELL'))::int,
      'waits', count(*) filter (where signal = 'WAIT')::int,
      'diagnosed_trades', count(*) filter (
        where signal in ('BUY', 'SELL') and postmortem->>'status' = 'done' and f is not null)::int,
      -- Trades with no diagnosis yet. The gap between this and `trades` is the
      -- first thing that shrinks every denominator below, before any missing
      -- field does.
      'undiagnosed_trades', count(*) filter (
        where signal in ('BUY', 'SELL')
          and not (postmortem->>'status' = 'done' and f is not null))::int,
      'pairs', coalesce((select to_jsonb(array_agg(distinct pair order by pair)) from mine), '[]'::jsonb),
      'intervals', coalesce((select to_jsonb(array_agg(distinct interval order by interval)) from mine), '[]'::jsonb),
      'signals', (select coalesce(jsonb_object_agg(signal, n), '{}'::jsonb)
                  from (select signal, count(*)::int as n from mine group by signal) s),
      'first_call_at', min(created_at),
      'last_call_at', max(created_at)
    )
    from mine
  ),
  'scopes', coalesce((select jsonb_object_agg(key, value) from shaped where dim = 'scope'), '{}'::jsonb),
  'by_contract', coalesce((select jsonb_object_agg(key, value) from shaped where dim = 'by_contract'), '{}'::jsonb),
  'other_contract_rows', (select count(*)::int from mine where contract <> live_contract),
  'other_contracts', coalesce(
    (select to_jsonb(array_agg(distinct contract)) from mine where contract <> live_contract),
    '[]'::jsonb)
);
$function$;

comment on function public.separated_scores(text) is
  'Direction, timing and placement scored apart, rolled up from facts the post-mortem already wrote (analyses.postmortem->facts). Each score carries its own n, its own Wilson interval and its own unscored count, because the three are taken over three different populations. Not a decomposition: the three are not independent and do not add up to the win rate. Returns no row ids.';

revoke all on function public.separated_scores(text) from public;
revoke all on function public.separated_scores(text) from anon;
grant execute on function public.separated_scores(text) to authenticated;
