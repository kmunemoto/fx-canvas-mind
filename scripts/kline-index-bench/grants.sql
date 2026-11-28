-- check.sh's model of the project's grants around public.gmo_kline_files (written from the repository, NOT read from the
-- project): the API roles may use the schema public, and a function made there may be run by them unless revoked (the
-- default privileges Supabase sets for functions; PostgreSQL also gives EXECUTE to PUBLIC); the table is the service
-- role's only, with row level security on and no policy (20260929060000_indicator_alerts.sql; no migration adds a
-- policy), so the service role reads it through BYPASSRLS (Supabase's service_role has it; the function is security
-- invoker, so its rows depend on it). Applied after ../morning-check/bench/schema.sql, on a scratch database only (the
-- role's attribute is the scratch server's).
grant usage on schema public to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant execute on functions to anon, authenticated, service_role;
revoke all on public.gmo_kline_files from anon, authenticated;
grant all on public.gmo_kline_files to service_role;
alter table public.gmo_kline_files enable row level security;
alter role service_role bypassrls;
