-- Scoring the calls that declined to trade.
--
-- 'untriggered' used to carry the reason 'missed' — price ran to the target
-- without ever returning to the entry — and that was the only signal anywhere
-- in the system for "too cautious". Every other signal (a loss, a stop too
-- tight) punishes being too bold. With entries moving to the market price
-- that reason disappears, and a one-directional learning loop would drift
-- toward answering WAIT to everything, which is never wrong and never useful.
--
-- So a WAIT is scored too, in its own column: it is not a trade evaluation
-- and putting it in `evaluation` would make that column mean two things.
alter table public.analyses add column if not exists wait_check jsonb;

comment on column public.analyses.wait_check is
  'Was standing aside right? Judged against the smallest trade the entry gate would itself have allowed, from the price at the moment of the call.';

-- The sweep looks for WAITs that have not been judged, or whose verdict is
-- still provisional because the window had not run out.
create index if not exists analyses_wait_pending_idx
  on public.analyses (created_at)
  where outcome = 'skipped';
