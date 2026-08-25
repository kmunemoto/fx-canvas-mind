-- Brings public.profiles under version control and hardens plan handling.
--
-- The table already existed in production; every statement here is idempotent so
-- it can be applied to an existing database or to a fresh one.
--
-- Why the grants matter: the analyze function updates the usage counters with the
-- caller's own JWT (role "authenticated"). A blanket UPDATE grant would therefore
-- let any signed-in user PATCH their own plan to "pro" through PostgREST, so the
-- update grant is restricted to the two counter columns.

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text,
  plan text default 'free',
  stripe_customer_id text,
  stripe_subscription_id text,
  daily_analysis_count integer default 0,
  last_analysis_date date,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'profiles_plan_check' and conrelid = 'public.profiles'::regclass
  ) then
    alter table public.profiles
      add constraint profiles_plan_check check (plan in ('free', 'light', 'standard', 'pro'));
  end if;
end$$;

-- stripe-webhook updates rows by customer id
create index if not exists profiles_stripe_customer_id_idx
  on public.profiles (stripe_customer_id);

alter table public.profiles enable row level security;

-- Kept as-is where it already exists, created on a fresh database
do $$
begin
  if not exists (
    select 1 from pg_policy
    where polrelid = 'public.profiles'::regclass and polname = 'Users can read own profile'
  ) then
    create policy "Users can read own profile"
      on public.profiles for select
      using ((select auth.uid()) = id);
  end if;
end$$;

-- Without this policy the analyze function's PATCH silently affects zero rows,
-- so daily usage never accumulates and the plan limits never apply.
drop policy if exists "Users can update own profile" on public.profiles;
create policy "Users can update own profile"
  on public.profiles for update to authenticated
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);

revoke all on public.profiles from anon, authenticated;
grant select on public.profiles to authenticated;
grant update (daily_analysis_count, last_analysis_date) on public.profiles to authenticated;
grant all on public.profiles to service_role;

-- Every new signup gets a profile row
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
