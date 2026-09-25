-- #112, step 2 of 2: with signal-alerts v5 live (it writes with the
-- per-rule keys added in 20260925180000), drop the old keys that would stop
-- the two rules from firing on the same chart, bar and side.

alter table public.signal_alert_subscriptions drop constraint if exists signal_alert_subscriptions_user_id_pair_interval_key;
alter table public.signal_events drop constraint if exists signal_events_pair_interval_bar_time_side_key;
alter table public.signal_alerts drop constraint if exists signal_alerts_user_id_kind_pair_interval_bar_time_side_key;
