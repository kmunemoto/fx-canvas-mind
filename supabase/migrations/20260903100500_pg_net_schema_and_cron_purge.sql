-- Housekeeping flagged by the Supabase advisor after the sweep migration.
--
-- pg_net was created without a schema and landed in public (its objects live
-- in the `net` schema either way, so net.http_post and the cron job are
-- unaffected; only the transient request/response queue is lost). pg_cron
-- keeps one job_run_details row per tick with no cleanup of its own.
drop extension if exists pg_net;
create extension if not exists pg_net with schema extensions;

select cron.schedule(
  'purge-cron-history',
  '0 3 * * *',
  $$delete from cron.job_run_details where end_time < now() - interval '7 days'$$
);
