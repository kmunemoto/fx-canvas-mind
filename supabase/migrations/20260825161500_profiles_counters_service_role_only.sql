-- analyze now writes the usage counters with the service role (see
-- supabase/functions/analyze/index.ts), so signed-in users no longer need — and
-- must not have — write access to profiles: with it they could reset
-- daily_analysis_count through PostgREST and bypass the plan limits.
-- Reads are unchanged: the "Users can read own profile" policy still applies.

revoke update on public.profiles from authenticated;
drop policy if exists "Users can update own profile" on public.profiles;
