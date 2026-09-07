-- The escape hatch in the episode rule was dead, and not for want of an
-- argument — for want of a column.
--
-- postmortem/prompt.ts has grouped lessons into "one situation" episodes since
-- it was written, and its rule has always had two halves: plans on the same
-- pair in the same direction inside a day are the same decision, UNLESS the
-- earlier plan had already settled more than four hours before the next one
-- was made, in which case the market had moved on and the second plan is a
-- fresh reading. The second half read `closed_at` off the lesson.
--
-- public.lessons has never had a settlement time. Not selected, not mapped,
-- not stored — the column did not exist. So `closed_at` arrived null on every
-- lesson, `Date.parse(null)` is NaN, `Number.isFinite(NaN)` is false, and the
-- escape `!(false && ...)` was true for every plan that has ever been
-- diagnosed. Measured 2026-09-07 on synthetic input: the same two lessons give
-- two episodes when the settlement time is supplied and one when it is
-- omitted, which is what the call site did.
--
-- The consequence is not cosmetic. Episodes are the unit of evidence: a rule
-- with support 0 is dropped at the next revision, and support is the count of
-- distinct episodes among the lessons citing it. Fusing separate decisions
-- into one episode understates every rule's support in exactly one direction.
--
-- public.analyses.closed_at already holds the settlement instant, so the past
-- is recoverable rather than merely lost.
alter table public.lessons add column if not exists plan_closed_at timestamptz;

comment on column public.lessons.plan_closed_at is
  'When the plan this lesson is about settled, copied from public.analyses.closed_at. Read by the episode rule (supabase/functions/_shared/episodes.ts): a plan made more than CLUSTER_REOPEN_MS after the previous one settled starts a new episode even inside the 24h window. Null means the plan had not settled when the lesson was written, and an unsettled previous plan never opens the escape.';

update public.lessons l
set plan_closed_at = a.closed_at
from public.analyses a
where a.id = l.analysis_id
  and l.plan_closed_at is null
  and a.closed_at is not null;
