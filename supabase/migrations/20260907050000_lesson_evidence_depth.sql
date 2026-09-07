-- A lesson did not say how much aftermath it was drawn from, so every lesson
-- read as if it had been drawn from the same amount.
--
-- The post-mortem diagnoses a plan soon after it settles, on purpose:
-- AFTER_WAIT_MS (supabase/functions/postmortem/facts.ts) waits one hour on a
-- 15min plan, two on a 1h, four on a 4h, eight on a daily. postmortem.facts
-- has always recorded bars_after_settlement — how many bars of "what happened
-- next" the diagnosis actually saw — and public.lessons has never carried it.
-- The rulebook editor reads lessons. So an eight-bar reading and a
-- ninety-five-bar reading reached it indistinguishable, and so did every
-- later reader.
--
-- That difference is not theoretical. Measured 2026-09-07, re-diagnosing four
-- stored losses once 48-95 bars existed:
--   * 1b003cf3 — at 8 bars: direction_wrong, confidence 72, max_favorable_r 0,
--     "never once in profit". At 48 bars: chased_move, max_favorable_r 7. The
--     direction was RIGHT; price reached TP1 23 bars later; the fault was
--     jumping into a bounce.
--   * c8788083 — became stop_too_tight at 81 bars.
--   * 32d167d3 — kept its cause at 95 bars, but avoidable flipped to false.
-- Three of four diagnoses written at 8 bars did not survive contact with the
-- full window, and every one of them carried a confidence in the 70s. The
-- confidence number does not know how deep the record under it was.
--
-- These columns record the depth and the build, and nothing else. Whether a
-- shallow diagnosis should count for less is a judgement to be made FROM this
-- record, later, by its owner — this migration does not make it, and nothing
-- in this build weights, filters or re-orders anything by these values.
--
-- Both are recoverable for the rows already written: the diagnosis document on
-- public.analyses.postmortem holds them, which is why the backfill below can
-- be exact rather than approximate. On 2026-09-07 all 22 existing lessons had
-- both values available on their analyses row.
alter table public.lessons add column if not exists bars_after_settlement integer;
alter table public.lessons add column if not exists postmortem_version text;

comment on column public.lessons.bars_after_settlement is
  'How many bars after the plan settled the diagnosis behind this lesson could see, copied from analyses.postmortem->facts->>bars_after_settlement. Small means the lesson rests on little aftermath: MIN_AFTER_BARS (8) is the threshold the post-mortem itself calls thin. Null on a lesson written before this column existed.';

comment on column public.lessons.postmortem_version is
  'Which post-mortem build wrote the diagnosis this lesson came from, copied from analyses.postmortem->>version. Paired with bars_after_settlement so a lesson can be placed against the taxonomy and the waits in force when it was written.';

update public.lessons l
set bars_after_settlement = (a.postmortem->'facts'->>'bars_after_settlement')::int
from public.analyses a
where a.id = l.analysis_id
  and l.bars_after_settlement is null
  and (a.postmortem->'facts'->>'bars_after_settlement') is not null;

update public.lessons l
set postmortem_version = a.postmortem->>'version'
from public.analyses a
where a.id = l.analysis_id
  and l.postmortem_version is null
  and (a.postmortem->>'version') is not null;
