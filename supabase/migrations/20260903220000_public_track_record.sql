-- A landing page for a paid-only product has to prove the loop is real to
-- someone who cannot sign in and try it. The proof is the rulebook: it is
-- rewritten only by the post-mortem consolidation, so its version and its
-- last-changed time are evidence the machine actually runs, and they cannot
-- be staged from the front end.
--
-- What this deliberately does NOT expose: the rule text (that is the product),
-- any per-user row, and any win rate. The sample is far too small for a win
-- rate to mean anything, and quoting one would be the exact dishonesty this
-- whole loop exists to avoid.
create or replace function public.public_track_record()
returns json
language sql
security definer
stable
set search_path = public
as $$
  select json_build_object(
    'rulebook_version', coalesce((select version from rulebook where id = 1), 0),
    'rules', coalesce((select jsonb_array_length(rules) from rulebook where id = 1), 0),
    'updated_at', (select updated_at from rulebook where id = 1)
  );
$$;

revoke all on function public.public_track_record() from public;
grant execute on function public.public_track_record() to anon, authenticated;

comment on function public.public_track_record() is
  'Counts only, no rule text and no per-user data: lets the public landing page show that the learning loop is live.';
