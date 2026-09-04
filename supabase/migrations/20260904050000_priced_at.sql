-- When the price the plan is filled at was actually read.
--
-- Deliberately not derivable from the newest candle's own timestamp: that is
-- the OPEN of a still-forming bar, so on a daily plan it would back-date the
-- fill up to 24 hours into price action that is already known. This is the
-- wall clock at the moment the market-data fetch resolved.
alter table public.analyses add column if not exists priced_at timestamptz;

comment on column public.analyses.priced_at is
  'Wall clock when the market data behind this plan was fetched. created_at minus this is the model turn, i.e. how stale the entry price was by the time the user saw it.';
