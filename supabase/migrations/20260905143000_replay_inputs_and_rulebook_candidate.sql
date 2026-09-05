-- Phase 0: make the record replayable, and separate "a new rulebook was
-- written" from "the analyst is now following it".
--
-- 1. analyses.prompt — the two strings actually sent to the model.
--    The prompt's market content is ~75% candle blocks that nothing stored,
--    and econ_events overwrites forecast/previous in place as the week runs,
--    so the as-of inputs were being destroyed. Without them a plan cannot be
--    replayed, and without replay a champion/challenger comparison has no
--    same-snapshot arm. Storing the rendered strings sidesteps rebuilding
--    them from parts that no longer exist.
--
-- 2. analyses.quote_at_signal — bid and ask at the moment the plan was shown,
--    with their bar time. The row already keeps price_at_signal, which is a
--    mid; execution is one-sided, so the honest fill and any holding cost
--    have to start from the two-sided quote the user was actually looking at.
--
-- Both are the caller's own row and hold nothing they cannot already see
-- (their market data, and rulebook text public.rulebook_for_client already
-- serves), so row-level security is left to do the work.
alter table public.analyses
  add column if not exists prompt jsonb,
  add column if not exists quote_at_signal jsonb;

comment on column public.analyses.prompt is
  'The system and user strings sent to the model, verbatim, so the plan can be replayed. {system, user, model, at}.';
comment on column public.analyses.quote_at_signal is
  'Two-sided quote at the moment of the plan: {bid, ask, at, source}. price_at_signal is the mid of the same instant.';

-- 3. public.rulebook.candidate — a revision that has been written but is not
--    in force. Revisions were replacing each other faster than trades settled
--    (versions 6, 7 and 8 have zero decided trades between them), so no
--    version was ever measured and no comparison was possible. Experience
--    still flows into a candidate on the old cadence; only the swap into
--    `rules` now waits until the live version has been measured.
alter table public.rulebook
  add column if not exists candidate jsonb;

comment on column public.rulebook.candidate is
  'A revision written but not in force: {base_version, rules, summary, changes, lessons_considered, created_at}. Promoted into rules once the live version has enough decided trades.';
