-- The rulebook is one shared artifact learned from every account's results,
-- and the client only ever needs to render it. Reading the table directly
-- also hands every signed-in browser three things it has no use for:
--
--   rules[].supported_by  the analysis ids the rule was written from — rows
--                         belonging to other accounts, which RLS will not let
--                         this reader open
--   stats                 the pooled cross-account record
--   history               every previous version of the rulebook
--
-- None of it is dangerous on its own; none of it is the client's either. So
-- the panel gets a function that returns exactly what it draws, with the
-- citations stripped.
--
-- SECURITY DEFINER on purpose: the rulebook is deliberately shared, so the
-- function does not check who is asking beyond requiring a signed-in role,
-- and it reads one fixed row.
create or replace function public.rulebook_for_client()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'version', r.version,
    'rules', (
      select coalesce(jsonb_agg(rule - 'supported_by' order by ord), '[]'::jsonb)
      from jsonb_array_elements(r.rules) with ordinality as t(rule, ord)
    ),
    'summary', r.summary,
    'updated_at', r.updated_at
  )
  from public.rulebook r
  where r.id = 1;
$$;

revoke all on function public.rulebook_for_client() from public;
revoke all on function public.rulebook_for_client() from anon;
grant execute on function public.rulebook_for_client() to authenticated;

comment on function public.rulebook_for_client() is
  'The learned rules as the app draws them: no citations, no pooled stats, no history. The direct SELECT policy on public.rulebook is dropped once every client is reading this instead.';
