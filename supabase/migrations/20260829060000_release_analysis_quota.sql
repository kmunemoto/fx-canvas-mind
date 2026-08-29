-- Refund a consumed analysis credit when the work it paid for never happened.
--
-- consume_analysis_quota deliberately spends the credit before any billable
-- work (that is what closes the TOCTOU race), so every failure path after it
-- has to hand the credit back — otherwise a run of market-data rate limits
-- burns a free user's whole daily allowance without producing one analysis.
--
-- The last_analysis_date guard keeps a refund from crossing midnight and
-- handing out an extra credit against the new day's count.

create or replace function public.release_analysis_quota(p_user_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  update public.profiles
  set daily_analysis_count = greatest(coalesce(daily_analysis_count, 0) - 1, 0),
      updated_at = now()
  where id = p_user_id
    and last_analysis_date = current_date
    and coalesce(daily_analysis_count, 0) > 0
  returning daily_analysis_count into v_count;

  return v_count;
end;
$$;

revoke execute on function public.release_analysis_quota(uuid) from public, anon, authenticated;
grant execute on function public.release_analysis_quota(uuid) to service_role;
