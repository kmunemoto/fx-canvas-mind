-- The trade a WAIT stood aside from, fixed AT THE MOMENT OF THE CALL.
--
-- wait_check is the resolution of this plan and nothing else. Keeping the two
-- in separate columns is what makes it checkable by hand that nothing after
-- the call leaked into the prediction: the scorer may read wait_plan and must
-- never write it.
--
-- Until now the scorer chose the direction itself, by walking a long and a
-- short from the decision price and reporting whichever paid. That is the
-- outcome choosing the prediction, in the one number the app has for
-- over-caution.
--
-- No backfill and no re-scoring: production holds 3 rows with outcome =
-- 'skipped' (of 21 analyses) and all three carry wait_check.verdict =
-- 'unknown' with bars_examined = 0 — they predate price_at_signal and
-- entry_check, so the two-sided scorer never actually produced a verdict on
-- this database. Nothing measured is being discarded, and nothing
-- decision-time can be invented for those three: they stay 'unknown', which
-- already says the call cannot be judged.
alter table public.analyses add column if not exists wait_plan jsonb;

comment on column public.analyses.wait_plan is
  'The hypothetical trade a WAIT is graded against — direction, entry, stop, target, risk, reward, ATR and spread — all fixed at the moment of the call by analyze (waitPlanFor). Written once, never updated. wait_check is its resolution; a row without a direction here is graded no_call rather than scored.';
