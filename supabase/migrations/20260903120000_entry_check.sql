-- Why a plan was, or was not, publishable.
--
-- Five of the first eight BUY/SELL plans were never filled: every one of them
-- placed a limit entry waiting for a pullback while the model's own market
-- context said "Trend Day" or "Breakout". analyze now refuses such a plan and
-- records the refusal here, so the rate of unfillable entries can be measured
-- instead of guessed.
--
-- Shape: {proposed_signal, declared_type, entry_type, distance_atr,
--         risk_reward, rejection, atr}
alter table public.analyses add column if not exists entry_check jsonb;

-- Rejected plans are stored as WAIT/skipped, so this index serves the
-- "how often does the model produce something unfillable" query
create index if not exists analyses_entry_rejection_idx
  on public.analyses ((entry_check ->> 'rejection'))
  where entry_check ->> 'rejection' is not null;
