-- Which contract a plan was made under.
--
-- The entry contract is changing: the model stops choosing an entry price and
-- the server sets it to the market price at the moment of analysis. Plans made
-- either side of that line are not comparable — under the old one 47% of calls
-- never filled and were never scored at all — so pooling them in one win rate
-- would describe a population that never existed.
--
-- rulebook_version is NOT a substitute. The two axes are orthogonal: a plan can
-- be made under rulebook v7 on both sides of the cut, so a rulebook-versioned
-- before/after table would answer "did the entry contract change?" loudly and
-- wrongly.
--
-- The values are names rather than v1/v2 on purpose. "Surely v2 is a superset
-- of v1" is exactly the wrong reading of a change that removes an output.
alter table public.analyses
  add column if not exists plan_contract text not null default 'entry_chosen_v1';

alter table public.analyses
  drop constraint if exists analyses_plan_contract_check;
alter table public.analyses
  add constraint analyses_plan_contract_check
  check (plan_contract in ('entry_chosen_v1', 'market_v1'));

comment on column public.analyses.plan_contract is
  'entry_chosen_v1: the model picked the entry price and a plan could go unfilled. market_v1: the server sets the entry to the market price at analysis, so every non-WAIT call is scored.';

-- Every existing row predates the change. The default already covers them; this
-- is here so the intent survives a restore from a dump taken mid-migration.
update public.analyses set plan_contract = 'entry_chosen_v1' where plan_contract is null;

create index if not exists analyses_plan_contract_idx on public.analyses (plan_contract, created_at desc);
