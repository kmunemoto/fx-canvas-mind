-- #112: a second rule beside RSI + SAR, the GA-style rule
-- (supabase/functions/analyze/gainz.ts), in the alert tables.
--
-- Step 1 of 2, additive only, so the function already deployed keeps
-- working while the new one goes out:
--   * a subscription names the rule it is for ('rsi_sar' for every row so
--     far), and the same chart may be followed for both rules;
--   * a recorded signal and a mailed alert are unique per rule as well, so
--     both rules firing on the same bar and side are two rows.
-- Step 2 (20260925181000) drops the old unique keys once the function that
-- writes with the new ones is live.

alter table public.signal_alert_subscriptions
  add column if not exists rule text not null default 'rsi_sar';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'signal_alert_subscriptions_rule_check') then
    alter table public.signal_alert_subscriptions
      add constraint signal_alert_subscriptions_rule_check check (rule in ('rsi_sar', 'gainz'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'signal_alert_subscriptions_user_pair_interval_rule_key') then
    alter table public.signal_alert_subscriptions
      add constraint signal_alert_subscriptions_user_pair_interval_rule_key unique (user_id, pair, interval, rule);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'signal_events_pair_interval_bar_side_rule_key') then
    alter table public.signal_events
      add constraint signal_events_pair_interval_bar_side_rule_key unique (pair, interval, bar_time, side, rule);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'signal_alerts_user_kind_pair_interval_bar_side_rule_key') then
    alter table public.signal_alerts
      add constraint signal_alerts_user_kind_pair_interval_bar_side_rule_key unique (user_id, kind, pair, interval, bar_time, side, rule);
  end if;
end
$$;
