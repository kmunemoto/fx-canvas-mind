-- stocks-v11.sql  -  the morning check of the MACD fade e-mails on the 1-hour chart for the SHARES (rule stockmacd_12_26_9_w600_1h_fade96of120_in_v4, signal-alerts v40).
-- ONE read-only statement (WITH ... SELECT) for mcp__Supabase__execute_sql. Replace the two markers START_MS and END_MS (each written once, in double curly braces, in the first CTE) by the epoch
-- milliseconds of the range: the same GMO day as pairs-v11 / gold-v11, (X-2d) 21:00 UTC .. (X-1d) 21:00 UTC, END_MS = START_MS + 86400000; a row belongs to the range by its
-- bar's OPEN (bar_time). Nothing else is to be edited. It has no go-live constant: it reads rows only, and before v40 there are none under its rule id.
-- The shares' bars are not stored, so NOTHING IS RECOUNTED: an entry production missed, a mail at a bar with no entry, a wrong side or a wrong price cannot be seen here
-- (research/macdfade1h-prod-spec.md 7.3: rows against mails only). What is checked are the rows of public.signal_alerts themselves, per bar: one side a bar (other_side),
-- one entry in every row of the bar (entries_differ), no stop and no target (stop_or_target), interval 1h, closed_at within an hour after the open (stockBarEnd), and, as
-- for the pairs, rows not sent (not_sent) and more rows than followers (dup).
-- It reads no user_id / event_id / e-mail address and writes nothing.
-- Result: the same columns as pairs-v11.sql: row_type (RUN | SUMMARY | LINE), instrument, bar_open_utc, side, verdict, data (json). See README.md (section v11).
with
-- The ONLY two inputs: bar OPEN time in [START_MS, END_MS), epoch milliseconds (the Routine writes the numbers in place of the two markers). One GMO day (21:00 UTC to 21:00 UTC)
-- holds one Tokyo session and one New York session. range_ok = the range is one whole GMO day (24 h, starting at 21:00 UTC); keys as in pairs-v11.
p as (select {{START_MS}}::bigint as start_ms, {{END_MS}}::bigint as end_ms),
pp as (
  select start_ms, end_ms,
         to_char(to_timestamp((start_ms + 10800000) / 1000.0) at time zone 'UTC', 'YYYYMMDD') as k_first,
         to_char(to_timestamp((end_ms - 1 + 10800000) / 1000.0) at time zone 'UTC', 'YYYYMMDD') as k_last,
         (end_ms - start_ms = 86400000 and start_ms % 86400000 = 75600000) as range_ok
  from p
),
-- every row of THE SHARES' FADE RULE (any interval: a row not on '1h' is told) whose bar opened in the range; no user_id / event_id is read.
-- len_s = closed_at - bar_time (stockBarEnd, stocks.ts: the open + 1 hour, Tokyo's 11:00 and 15:00 bars and New York's 15:30 bar the open + 30 minutes, or the session's end
-- when earlier, so in (0, 3600] s; this checks only that range, not which of the lengths is due); lag_s = sent_at - closed_at
sr as (
  select a.pair, a.side, (extract(epoch from a.bar_time) * 1000)::bigint as ot, a.interval as iv, a.entry, a.stop, a.target, a.status,
         extract(epoch from (a.closed_at - a.bar_time)) as len_s, extract(epoch from (a.sent_at - a.closed_at)) as lag_s
  from public.signal_alerts a, pp
  where a.kind = 'signal' and a.rule = 'stockmacd_12_26_9_w600_1h_fade96of120_in_v4'
    and a.bar_time >= to_timestamp(pp.start_ms / 1000.0) and a.bar_time < to_timestamp(pp.end_ms / 1000.0)
),
-- subscriptions now (count only): the shares' 1-hour stockmacd subscriptions, which v40 reads as v39 did (research/macdfade1h-prod-spec.md 3.6: none moves); for the RUN
-- row, any stockmacd subscription on another interval (mailed by neither version)
subs as (select pair, count(*) as n from public.signal_alert_subscriptions where interval = '1h' and rule = 'stockmacd' group by pair),
-- the stockmacd rows in the range under any OTHER rule id (v39's ride rows, stockmacd_..._ride90to96of120_{in,at,out}_v2, on the switch day and in a rollback, a renamed rule):
-- counted, never compared
othr as (
  select a.pair, count(*) as n
  from public.signal_alerts a, pp
  where a.kind = 'signal' and a.rule like 'stockmacd%' and a.rule <> 'stockmacd_12_26_9_w600_1h_fade96of120_in_v4'
    and a.bar_time >= to_timestamp(pp.start_ms / 1000.0) and a.bar_time < to_timestamp(pp.end_ms / 1000.0)
  group by a.pair
),
-- one line per bar (share, bar open) with rows of the rule. n_sides = how many sides its rows have (production mails one side a bar: mailRide reads the bar's rows whatever
-- their side); n_entries = how many different entries its rows hold (every follower of a bar gets the same price in, the bar's close: one); n_st = rows with a stop or a target
-- (the fade states neither); n_iv = rows whose interval is not '1h'; n_len = rows whose closed_at is not within an hour after the open
sb as (
  select r.pair, r.ot, count(*) as n_rows, count(*) filter (where r.status = 'sent') as n_sent, string_agg(distinct r.status, ',') as statuses,
         count(distinct r.side) as n_sides, string_agg(distinct r.side, ',') as sides,
         count(distinct r.entry) as n_entries, count(*) filter (where r.entry is null) as n_entry_null, min(r.entry) as entry, max(r.entry) as entry_max,
         count(*) filter (where r.stop is not null or r.target is not null) as n_st,
         count(*) filter (where r.iv is distinct from '1h') as n_iv,
         count(*) filter (where not coalesce(r.len_s > 0 and r.len_s <= 3600, false)) as n_len,
         min(r.lag_s) as lag_min, max(r.lag_s) as lag_max
  from sr r
  group by r.pair, r.ot
),
-- the verdict of each bar: ok, or check with the parts that failed (why)
ln as (
  select b.*, coalesce(s.n, 0) as subs,
         concat_ws(';',
           case when b.n_sides > 1 then 'other_side' end,
           case when b.n_entries > 1 or b.n_entry_null > 0 then 'entries_differ' end,
           case when b.n_st > 0 then 'stop_or_target' end,
           case when b.n_iv > 0 then 'interval_not_1h' end,
           case when b.n_len > 0 then 'closed_at_not_within_1h' end,
           case when b.n_rows > b.n_sent then 'not_sent' end,
           case when b.n_rows > greatest(coalesce(s.n, 0), 1) then 'dup' end) as parts
  from sb b left join subs s on s.pair = b.pair
),
-- the shares listed: those with rows of the rule or of another stockmacd rule in the range
sh as (select pair from ln union select pair from othr),
cnt as (
  select h.pair, coalesce(s.n, 0) as subs, coalesce(o.n, 0) as other_rows,
         count(l.ot) as bars, coalesce(sum(l.n_rows), 0) as mail_rows, coalesce(sum(l.n_rows - l.n_sent), 0) as not_sent_rows,
         count(l.ot) filter (where l.n_sides > 1) as other_side, count(l.ot) filter (where l.n_entries > 1 or l.n_entry_null > 0) as entries_differ,
         coalesce(sum(l.n_st), 0) as stop_or_target, coalesce(sum(l.n_iv), 0) as interval_not_1h, coalesce(sum(l.n_len), 0) as closed_at_odd,
         count(l.ot) filter (where l.n_rows > greatest(coalesce(s.n, 0), 1)) as dups,
         count(l.ot) filter (where l.sides = 'BUY') as buy_bars, count(l.ot) filter (where l.sides = 'SELL') as sell_bars,
         min(l.lag_min) as lag_min, max(l.lag_max) as lag_max
  from sh h
  left join ln l on l.pair = h.pair
  left join subs s on s.pair = h.pair
  left join othr o on o.pair = h.pair
  group by h.pair, s.n, o.n
),
u as (
  -- one SUMMARY row per share listed
  select 1 as o1, 0::bigint as o2, row_number() over (order by c.pair) as o3, 'SUMMARY'::text as row_type, c.pair as instrument, null::text as bar_open_utc, null::text as side,
         case when pp.range_ok and att.t = '' then 'OK' when not pp.range_ok then 'BAD_RANGE' else 'CHECK' end as verdict,
         json_strip_nulls(json_build_object(
           'bars', c.bars, 'buy_bars', c.buy_bars, 'sell_bars', c.sell_bars, 'mail_rows', c.mail_rows, 'not_sent_rows', c.not_sent_rows, 'duplicates', c.dups,
           'other_side', c.other_side, 'entries_differ', c.entries_differ, 'stop_or_target', c.stop_or_target,
           'interval_not_1h', c.interval_not_1h, 'closed_at_not_within_1h', c.closed_at_odd,
           'lag_min_s', round(c.lag_min::numeric, 3), 'lag_max_s', round(c.lag_max::numeric, 3),
           'subscriptions', c.subs, 'other_stockmacd_rows', c.other_rows, 'attention', nullif(att.t, ''))) as data
  from cnt c cross join pp
  cross join lateral (select concat_ws('; ',
      case when c.other_side > 0 then 'other_side=' || c.other_side end, case when c.entries_differ > 0 then 'entries_differ=' || c.entries_differ end,
      case when c.stop_or_target > 0 then 'stop_or_target=' || c.stop_or_target end, case when c.interval_not_1h > 0 then 'interval_not_1h=' || c.interval_not_1h end,
      case when c.closed_at_odd > 0 then 'closed_at_not_within_1h=' || c.closed_at_odd end,
      case when c.not_sent_rows > 0 then 'not_sent_rows=' || c.not_sent_rows end, case when c.dups > 0 then 'dup=' || c.dups end,
      case when c.bars > 0 and c.subs = 0 then 'no_subscription_row' end,
      case when c.other_rows > 0 then 'other_stockmacd_rule_rows=' || c.other_rows end) as t) att
  union all
  -- one LINE per bar with rows of the rule
  select 2, l.ot, dense_rank() over (order by l.pair), 'LINE', l.pair, to_char(to_timestamp(l.ot / 1000.0) at time zone 'UTC', 'YYYY-MM-DD HH24:MI'), l.sides,
         case when l.parts = '' then 'ok' else 'check' end,
         json_strip_nulls(json_build_object(
           'mail_rows', l.n_rows, 'mail_status', l.statuses, 'subscriptions', l.subs, 'entry', l.entry, 'entry_max', case when l.entry_max <> l.entry then l.entry_max end,
           'entries', l.n_entries, 'rows_without_entry', nullif(l.n_entry_null, 0), 'stop_or_target_rows', nullif(l.n_st, 0),
           'interval_not_1h_rows', nullif(l.n_iv, 0), 'closed_at_not_within_1h_rows', nullif(l.n_len, 0),
           'lag_min_s', round(l.lag_min::numeric, 3), 'lag_max_s', round(l.lag_max::numeric, 3), 'why', nullif(l.parts, ''))) as data
  from ln l
  union all
  -- the run itself (last in this list, so that elapsed_s is read after everything else was done; shown first)
  select 0, 0, 0, 'RUN', null, null, null, 'info',
         json_build_object('sql', 'stocks.sql v11', 'rule', 'stockmacd_12_26_9_w600_1h_fade96of120_in_v4', 'keys', pp.k_first || '..' || pp.k_last,
           'range_utc', to_char(to_timestamp(pp.start_ms / 1000.0) at time zone 'UTC', 'YYYY-MM-DD HH24:MI') || ' .. ' || to_char(to_timestamp(pp.end_ms / 1000.0) at time zone 'UTC', 'YYYY-MM-DD HH24:MI'),
           'range_is_one_gmo_day', pp.range_ok, 'db_now_utc', to_char(now() at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
           'recounted', false,
           'shares_followed_1h', (select count(*) from subs), 'subscriptions_1h', (select coalesce(sum(n), 0) from subs),
           'stockmacd_subscriptions_not_1h', (select count(*) from public.signal_alert_subscriptions where rule = 'stockmacd' and interval <> '1h'),
           'lines', (select count(*) from ln), 'elapsed_s', round(extract(epoch from clock_timestamp() - statement_timestamp())::numeric, 2),
           -- the md5 and length of the statement text AS THE DATABASE RECEIVED IT (the tool appends a comment after a blank line: cut off), as in pairs-v11
           'sql_md5', md5(split_part(current_query(), E'\n\n-- source: POST /mcp', 1)), 'sql_chars', length(split_part(current_query(), E'\n\n-- source: POST /mcp', 1)))
  from pp
)
select row_type, instrument, bar_open_utc, side, verdict, data from u order by o1, o2, o3
