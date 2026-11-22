-- The local check of signal-alerts v42's migration (research/allstocks-prod-spec.md section 9, "Local PostgreSQL"):
-- stand-ins for what a Supabase project has and this local PostgreSQL does not (as scripts/morning-check/bench/schema.sql
-- did for the earlier checks): the auth schema's users table and auth.uid() (the subscriptions' policy calls it). The
-- roles anon, authenticated, service_role and authenticator are made by db-check.sh when they are missing. Made-up rows
-- only: the users are created with gen_random_uuid() at run time; nothing here is production's.
-- Supabase's default rights in schema public: every table, function and sequence the migrations' role (here postgres)
-- makes there is open to anon, authenticated and service_role (which is why the repository's migrations revoke from
-- anon and authenticated, as 20260928060000_twelve_data_usage.sql does). Run first, so that the rights checks of
-- db-check.sh fail when one of the migration's revokes is missing, as such a migration would leave Supabase open.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
create schema if not exists auth;
create table if not exists auth.users (id uuid primary key default gen_random_uuid());
create or replace function auth.uid() returns uuid language sql stable
  as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
-- the check's own names for its made-up users (u0, u1, u2, probe)
create table public.v42_users (name text primary key, id uuid not null references auth.users (id));
