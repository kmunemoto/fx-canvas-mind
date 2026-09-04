-- Which entry contract each lesson's plan was made under.
--
-- The cause taxonomy now has two eras: entry_chosen_v1, where the analyst
-- picked the entry price, and market_v1, where the server fills at the market
-- and no plan can go unfilled. A lesson drawn from the first era can name a
-- remedy that no longer exists ("wait for the pullback"), so the consolidation
-- editor has to be able to tell the two apart before it copies wording.
--
-- Three readers: the per-lesson `contract` in the consolidation payload
-- (prompt.ts buildConsolidationPrompt), `stats.lessons_by_contract`
-- (summarizeRecord), and the prompt sentence that tells the editor how to read
-- a lesson from the other era.
--
-- Deliberately no CHECK: it must accept whatever `analyses` holds, including
-- whatever the next contract is called. No cause string is rewritten anywhere
-- by this migration — the rename is applied on read (canonicalCause) and on
-- the next rulebook revision, so nothing on disk has to change.
alter table public.lessons add column if not exists plan_contract text;

-- Total in practice, not just nullable: lessons.analysis_id is NOT NULL and
-- references analyses(id), and analyses.plan_contract is NOT NULL DEFAULT
-- 'entry_chosen_v1'. A null after this therefore means exactly one thing — a
-- lesson written by the previous bundle between this migration and the
-- upload — which is why this UPDATE is re-run once after deploying.
update public.lessons l
   set plan_contract = a.plan_contract
  from public.analyses a
 where a.id = l.analysis_id
   and l.plan_contract is null;
