-- Atomic daily-quota consumption, replacing the read-check-write the analyze
-- function used to do in three separate steps.
--
-- With the old flow, K concurrent requests all read the same
-- daily_analysis_count, all passed the limit check, and all wrote back the
-- same count+1 — so a burst advanced the counter by one and billed K
-- Anthropic + market-data calls. The check and the increment now happen in a
-- single UPDATE whose WHERE clause carries the limit.
--
-- Returns the new count, or NULL when the limit is already reached.

create or replace function public.consume_analysis_quota(
  p_user_id uuid,
  p_limit integer
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  insert into public.profiles (id)
  values (p_user_id)
  on conflict (id) do nothing;

  update public.profiles
  set daily_analysis_count = case
        when last_analysis_date is distinct from current_date then 1
        else coalesce(daily_analysis_count, 0) + 1
      end,
      last_analysis_date = current_date,
      updated_at = now()
  where id = p_user_id
    and (
      last_analysis_date is distinct from current_date
      or coalesce(daily_analysis_count, 0) < p_limit
    )
  returning daily_analysis_count into v_count;

  return v_count;
end;
$$;

-- Only the edge functions (service_role) may spend quota
revoke execute on function public.consume_analysis_quota(uuid, integer) from public, anon, authenticated;
grant execute on function public.consume_analysis_quota(uuid, integer) to service_role;

-- Cooldown marker for track-outcomes so a single account cannot drain the
-- shared market-data credits by calling it in a loop
alter table public.profiles add column if not exists last_tracked_at timestamptz;
