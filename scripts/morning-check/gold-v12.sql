-- gold-v12.sql  -  the morning check of the MACD fade e-mails on the 15-minute chart for GOLD (XAU/USD), rule v12.
-- ONE read-only statement (WITH ... SELECT) for mcp__Supabase__execute_sql. Replace the two markers START_MS and END_MS (each written once, in double curly braces, in the first CTE) by the epoch
-- milliseconds of the range: bars are judged by their OPEN time, START_MS <= open < END_MS; the Routine's day is (X-2d) 21:00 UTC .. (X-1d) 21:00 UTC,
-- END_MS = START_MS + 86400000. Nothing else is to be edited.
-- THE GO-LIVE CONSTANTS ARE NOT SET YET: GO_LIVE_MS_GOLD and END_1H_MS_GOLD (double curly braces, in syms) are placeholders that are replaced in src/syms-gold-v12.part at
-- the release of signal-alerts v41 (README.md v12.1); while they are there, the statement does not run. Bars that opened before GO_LIVE_MS_GOLD were judged by v40 on the
-- 1-hour chart (README.md v11).
-- It recounts the rule macdx_12_26_9_w600_15min_fade96of120_in_v12 (signal-alerts v41, research/macdfade15min-prod-spec.md: at a closed 15-MINUTE bar, the MACD line, the
-- blue line, is at 96% of the top / bottom edge of the MACD pane of the newest 120 bars and was not one bar earlier in the same 600-bar window; the FADE side: top -> SELL,
-- bottom -> BUY; the price in is the bar's close; no stop and no target) from the closed bars of the ONE stored row public.live_chart_fallback (XAU/USD, 15min; Twelve Data),
-- and compares the expected entries with public.signal_alerts (pair XAU/USD, kind signal, interval 15min, that rule id): the bar, the side, the entry against the close, one
-- side a bar (other_side), no stop or target (stop_or_target).
-- It is v11's statement (gold-v11.sql) on v7's 15-minute parts (gold-v7.sql: head-v7, front-gold-v7, guard-gold-v7) with the 15-minute constants of v7 in BACK 1 and BACK 2,
-- the new id, and the switch's fields (README.md v12.2).
-- The row is the LATEST read: production judged each bar on the row as it was 1 to 15 minutes after the close. No user_id / event_id / e-mail is read; nothing is written.
-- Result: the same columns as pairs-v12.sql: row_type (RUN | SUMMARY | LINE), instrument, bar_open_utc, side, verdict, data (json). See README.md (sections v12, v11 and v7).
with recursive
-- The ONLY two inputs: bar OPEN time in [START_MS, END_MS), epoch milliseconds (the Routine writes the numbers in place of the two markers).
p as (select {{START_MS}}::bigint as start_ms, {{END_MS}}::bigint as end_ms),
-- GMO's day starts at 21:00 UTC (06:00 JST), so START_MS + 3 h falls on the key's date (the 15-minute day files are keyed by that GMO day, like the 1-hour ones).
-- k_first / k_last = the keys of the first and the last instant of the range; range_ok = the range is one whole GMO day (24 h, starting at 21:00 UTC).
-- from_key = 13 days before k_first: production's own reach back on the 15-minute chart. fetchRecentQuotes (analyze/price-source.ts) walks the day keys newest first
-- for HISTORY_BARS + 1 = 601 bars: 96 bars a day -> 7 open days -> ceil(7 * 7 / 5) + 2 = 12 days, and dateKeys pads the far end by one day more: 13 days back from the JST day of
-- the judging moment (that is K or K + 1 for a bar of GMO day K). 600 bars before a Monday key's first bar need the keys back to K - 11 in a normal week.
pp as (
  select start_ms, end_ms,
         to_char(to_timestamp((start_ms + 10800000) / 1000.0) at time zone 'UTC', 'YYYYMMDD') as k_first,
         to_char(to_timestamp((end_ms - 1 + 10800000) / 1000.0) at time zone 'UTC', 'YYYYMMDD') as k_last,
         to_char((to_timestamp((start_ms + 10800000) / 1000.0) at time zone 'UTC')::date - 13, 'YYYYMMDD') as from_key,
         (end_ms - start_ms = 86400000 and start_ms % 86400000 = 75600000) as range_ok
  from p
),
-- ===== FRONT (gold): public.live_chart_fallback (XAU/USD, 15min) -> us(symbol, ot, seq, m8, d), the closed 15-minute bars production judges on =====
-- instrument table (gold): the live_chart_fallback pair, the app's pair name, display order, the instant from which the v12 rule (signal-alerts v41, the MACD fade on the
-- 15-minute chart) was live for gold, the decimals of the chart's rounding for gold (decimalsOf: 2), and the end of v40's 1-hour form for gold.
-- live_ms = GO_LIVE_MS_GOLD, A PLACEHOLDER TO BE SET AT THE RELEASE (README.md v12.1): the open (epoch ms) of the first 15-minute bar v41 judged for gold, read from the run's
-- record in net._http_response (research/macdfade15min-prod-spec.md 6.2). Gold's newest close is looked at from a minute after it until the next close, the pairs' at
-- minutes 0, 1 and 3 only, so when v41 first answered between minute 4 and minute 14 of a quarter hour, gold's first judged bar is one bar earlier than the pairs'.
-- end_1h_ms = END_1H_MS_GOLD, A PLACEHOLDER TO BE SET AT THE RELEASE (README.md v12.1): the end (open + 1 h) of the last 1-hour bar v40 judged for gold (v40 looked at
-- gold's 1-hour close from minute 1 to minute 29 after it, spec 6.2). As for the pairs (syms-pairs-v12.part), it tells late 1-hour rows and the switch's gap and overlap;
-- gold's overlap (a 15-minute bar inside v40's last hour judged by both forms: live_ms before end_1h_ms) is what spec 6.2 expects when v41 first answers from H:06 to H:14.
-- Until both markers are replaced by those numbers (here, then bash build.sh), the statement does not run: a marker is not SQL.
syms as (select 'XAU_USD'::text as symbol, 'XAU/USD'::text as pair, 1 as ord, {{GO_LIVE_MS_GOLD}}::bigint as live_ms, 2 as d, {{END_1H_MS_GOLD}}::bigint as end_1h_ms),
-- gold has ONE stored row (the latest read of Twelve Data); the sweep replaces it at every read, so older versions of the row do not exist
grow0 as (
  select f.bars, f.fetched_at, floor(extract(epoch from f.fetched_at) * 1000)::bigint as fetched_ms
  from public.live_chart_fallback f where f.pair = 'XAU/USD' and f.interval = '15min'
),
-- every bar of the row in the row's own order; datetime = the bar's OPEN, 'YYYY-MM-DD HH:MM:SS' UTC
braw as (
  select e.ord as pos, e.x ->> 'datetime' as dt_s, e.x ->> 'close' as c_s, g.fetched_ms
  from grow0 g
  cross join lateral jsonb_array_elements(case when jsonb_typeof(g.bars) = 'array' then g.bars else '[]'::jsonb end) with ordinality as e(x, ord)
),
bgold as (
  select pos, fetched_ms, coalesce(dt_s ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}$' and c_s ~ '^[0-9]+(\.[0-9]+)?$', false) as ok, dt_s, c_s
  from braw
),
bgold2 as (
  select pos, fetched_ms, ok,
         case when ok then floor(extract(epoch from (dt_s::timestamp at time zone 'UTC')) * 1000)::bigint end as ot,
         case when ok then c_s::float8 end as cl
  from bgold
),
-- closedOf / closedBy: a stored bar counts as closed only when its end (barEndMs: open + 15 min = 900000 ms) is not after the moment the row was read (a bar still forming then
-- is left out).
-- seq = the place of the bar in the row: production keeps the row's order (closedOf only filters). The stored bars already passed parseCandles (every price > 0,
-- coherent bar, sorted, one bar per time), so cl > 0 drops nothing a stored row can hold.
us as (
  select y.symbol, b.ot, b.pos as seq, b.cl as m8, y.d
  from bgold2 b cross join syms y
  where b.ok and b.ot + 900000 <= b.fetched_ms and b.cl > 0
),
-- v12: gold has one price, the closed bar's close (fadeAtClose: price = the last closed bar's close, research/macdfade15min-prod-spec.md 2.3), the engine's rounded close clo:
-- no bid / ask, so no row here; BACK 2 compares a gold mail's entry with clo (as v11 does, front-gold-v11.part)
paid as (select symbol, ot, null::float8 as paid_buy, null::float8 as paid_sell from us where false),
-- ===== ENGINE (the same text in pairs-v4.sql and gold-v4.sql): rounded closes -> ranks -> MACD -> the edges of its pane at each judged bar =====
-- Input: us(symbol, ot, seq, m8, d)  = the unrounded mid close m8 (a double) of every usable bar, ot = bar OPEN (epoch ms), seq = its place in the order production keeps
-- (pairs: the merged list's arrival order; gold: the row's order), d = decimals (JPY 3, other pairs 5, gold 2).
-- 1. Rounding: JS  Number(m.toFixed(d))  of the EXACT double m8 (half up on the exact binary value), done with the double's 52-bit mantissa:
--    m8 = mant / 2^(52-k) exactly, k = floor(log2(m8)); n = round_half_up(mant * 10^d / 2^(52-k)); close = n / 10^d. bad = mant outside [2^52, 2^53), or a close that
--    is zero / absurdly small or large (nothing is dropped for it: production keeps such a bar, and bad_mantissas makes it visible; the statement must not stop on it).
kk as (select symbol, ot, seq, m8, d, case when m8 > 0 then floor(ln(m8) / ln(2::float8))::int else 0 end as k0 from us),
k1 as (
  select symbol, ot, seq, m8, d,
         case when m8 >= power(2::float8, k0 + 1) then k0 + 1 when m8 < power(2::float8, k0) then k0 - 1 else k0 end as k
  from kk
),
fx as (select symbol, ot, seq, d, k, (least(m8, 1e15::float8) * power(2::float8, 52 - k))::bigint as mant from k1),
r0 as (select symbol, ot, seq, d, k, mant, (10::float8 ^ d)::numeric as p10, (1::bigint << least(greatest(52 - k, 0), 62))::numeric as den from fx),
r1 as (select symbol, ot, seq, d, k, mant, p10, mant::numeric * p10 as num, den from r0),
r as (
  select symbol, ot, seq, d,
         (div(num, den) + case when 2 * mod(num, den) >= den then 1 else 0 end) / p10 as cn,
         (mant < 4503599627370496 or mant >= 9007199254740992 or 52 - k < 0 or 52 - k > 62) as bad
  from r1
),
-- 2. The series, in the order production keeps (seq), rank rn = 1, 2, ... per symbol. A window is the 600 ENTRIES ending at a bar (not 600 hours).
s as (select symbol, ot, d, row_number() over (partition by symbol order by seq) as rn, cn, cn::float8 as c, bad from r),
-- 3. The judged bars: open in [START_MS, END_MS) with a full window (rank >= 600). closes = each symbol's whole series as one array, so that the
--    recursion below looks a close up by its rank (arr[rn]) and never joins the series again (a join inside a recursion can be planned badly).
w as (select symbol, rn as jr, ot from s where rn >= 600 and ot >= (select start_ms from pp) and ot < (select end_ms from pp)),
closes as (select symbol, array_agg(c order by rn) as arr from s group by symbol),
-- 4. MACD(12, 26, 9) of each window as Pine / _shared/pine.ts computes it, on that window's 600 closes alone: SMA seed, then alpha*v + (1-alpha)*prev,
--    same order of double operations as the TypeScript (this step is the v3 text). t = index inside the window (0..599; the close at t has rank jr - 599 + t);
--    acc = running seed sums; m = the blue line (MACD), sg = the orange line (signal), h = m - sg (the bars): all unrounded.
--    The edges of the chart's MACD pane (macd-level.ts zoneAt, without the chart's drawing margin) are kept as running extremes of 0 and of m, sg and h:
--      ta / tb  highest / lowest from t = 480 on: in the last row (t = 599) the 120 positions 480..599 ending at the judged bar, i.e. T(i) and B(i)
--      tp / bp  highest / lowest over t = 479..598 and frozen after that: the 120 positions ending at the bar BEFORE the judged one, T(i-1) and B(i-1)
--      mp       m at t = 598: the blue line one bar earlier, read from the SAME 600-bar computation (as zoneEntryAt reads it)
--    e12_p, e26_p, sg_p, ta_p, tb_p = e12, e26, sg, ta, tb of the row before (in the last row: the state at t = 598), kept so that near_edge can evaluate the
--    last step again for another last close (back1-v4.part).
rec(symbol, jr, ot, t, c, acc12, e12, acc26, e26, m, acc9, sg, ta, tb, tp, bp, mp, e12_p, e26_p, sg_p, ta_p, tb_p) as (
  select w.symbol, w.jr, w.ot, 0, cl.arr[w.jr - 599], cl.arr[w.jr - 599], null::float8, cl.arr[w.jr - 599], null::float8, null::float8, null::float8, null::float8,
         0::float8, 0::float8, 0::float8, 0::float8, null::float8, null::float8, null::float8, null::float8, null::float8, null::float8
  from w join closes cl on cl.symbol = w.symbol
  union all
  select r.symbol, r.jr, r.ot, r.t + 1, sn.c,
         case when r.t + 1 <= 11 then r.acc12 + sn.c else r.acc12 end,
         x.ne12,
         case when r.t + 1 <= 25 then r.acc26 + sn.c else r.acc26 end,
         x.ne26,
         y.nm,
         z.nacc9,
         z.nsg,
         case when r.t + 1 >= 480 then greatest(r.ta, y.nm, z.nsg, y.nm - z.nsg) else r.ta end,
         case when r.t + 1 >= 480 then least(r.tb, y.nm, z.nsg, y.nm - z.nsg) else r.tb end,
         case when r.t + 1 between 479 and 598 then greatest(r.tp, y.nm, z.nsg, y.nm - z.nsg) else r.tp end,
         case when r.t + 1 between 479 and 598 then least(r.bp, y.nm, z.nsg, y.nm - z.nsg) else r.bp end,
         case when r.t + 1 = 598 then y.nm else r.mp end,
         r.e12, r.e26, r.sg, r.ta, r.tb
  from rec r join closes cl on cl.symbol = r.symbol
  cross join lateral (select cl.arr[r.jr - 598 + r.t] as c) sn
  cross join lateral (select
      case when r.t + 1 < 11 then null::float8 when r.t + 1 = 11 then (r.acc12 + sn.c) / 12.0::float8
           else (2.0::float8 / 13.0::float8) * sn.c + (1 - (2.0::float8 / 13.0::float8)) * r.e12 end as ne12,
      case when r.t + 1 < 25 then null::float8 when r.t + 1 = 25 then (r.acc26 + sn.c) / 26.0::float8
           else (2.0::float8 / 27.0::float8) * sn.c + (1 - (2.0::float8 / 27.0::float8)) * r.e26 end as ne26) x
  cross join lateral (select case when r.t + 1 >= 25 then x.ne12 - x.ne26 end as nm) y
  cross join lateral (select
      case when r.t + 1 < 25 then null::float8 when r.t + 1 = 25 then y.nm when r.t + 1 <= 33 then r.acc9 + y.nm else r.acc9 end as nacc9,
      case when r.t + 1 < 33 then null::float8 when r.t + 1 = 33 then (r.acc9 + y.nm) / 9.0::float8
           else (2.0::float8 / 10.0::float8) * y.nm + (1 - (2.0::float8 / 10.0::float8)) * r.sg end as nsg) z
  where r.t < 599
),
-- 5. The numbers at the last bar of each window (t = 599): m, sg, h and the pane's top / bottom tn / bn (T(i), B(i)) at the judged bar; tp, bp, mp one bar earlier;
--    clo = the judged bar's own (rounded) close, the last of its 600: the mail's `entry` must be this. The decision (the bands, the entry) is made in back1-v4.part.
fin as materialized (
  select symbol, ot, jr, m, sg, (m - sg) as h, ta as tn, tb as bn, tp, bp, mp, c as clo, e12_p, e26_p, sg_p, ta_p, tb_p
  from rec where t = 599
),
-- ===== BACK 1 (v12; the same text in pairs-v12.sql and gold-v12.sql): the bands at 96%, the decision and near_edge per judged bar, facts per instrument, and the mails =====
-- v12 = v11's text (back1-v11.part: v8's with the share 0.96, the stop / target of each row and the sides of each bar) on the 15-minute chart, as v7 moved v6's
-- (back1-v7.part): the rule id macdx_12_26_9_w600_15min_fade96of120_in_v12 (fadeRuleId("macdx", MACDH_INTERVALS[0], 12), research/macdfade15min-prod-spec.md 3.7), the
-- mails and the subscriptions on '15min', the other macdx rows of both charts (v7's reading), and the 1-hour macdx rows after end_1h_ms (late1h, new).
-- one row per judged bar. m = the blue line, sg = the orange line, h = the bars (m - sg); tn / bn = the top / bottom edge of the MACD pane of the 120 positions ending at the
-- bar (the highest / lowest of 0, m, sg and h); tp / bp / mp = the same one bar earlier (the 120 positions ending at the bar before, from the same 600-bar computation).
-- At 96% (macd-fade.ts closeEntryAt, Z = zoneAt at 599 and Zp = zoneAt at 598 of the bar's own 600-bar window): top = tn > 0 and m >= 0.96 * tn, bottom = bn < 0 and
-- m <= 0.96 * bn; 0.96 = the double nearest 0.96 (FADE_SHARE = 96 / 100 is that double), the product is held against as it comes (equality in), nothing is rounded; only m
-- comes to 96%, sg and h only set the edges. in_top / in_bot = at 96% at the bar (Z), p_top / p_bot = at 96% one bar earlier in the same window (Zp, not Z of the bar
-- before on its own window). sd = the entry, already the FADE side (fadeSideOf): SELL = at the top now and not before, BUY = at the bottom now and not before, null = no
-- entry (the two cannot both hold: the top needs m > 0, the bottom m < 0). The column names in_top / in_bot / band_bars are v8's (the band is now the 96% one).
-- clo = the bar's own rounded close (the chart's close; gold's mail `entry` is this, a pair's is the ask / bid close: the FRONT's paid).
fin2 as (
  select f.symbol, f.ot, f.jr, y.pair, y.d, f.m, f.sg, f.h, f.tn, f.bn, f.clo, f.e12_p, f.e26_p, f.sg_p, f.ta_p, f.tb_p,
         b.in_top, b.in_bot, b.p_top, b.p_bot,
         case when b.in_top and not b.p_top then 'SELL' when b.in_bot and not b.p_bot then 'BUY' end as sd
  from fin f join syms y on y.symbol = f.symbol
  cross join lateral (select (f.tn > 0 and f.m >= 0.96::float8 * f.tn) as in_top, (f.bn < 0 and f.m <= 0.96::float8 * f.bn) as in_bot,
                             (f.tp > 0 and f.mp >= 0.96::float8 * f.tp) as p_top, (f.bp < 0 and f.mp <= 0.96::float8 * f.bp) as p_bot) b
),
-- near_edge: would moving the judged bar's OWN close (the last of its 600) by 2 ticks, up or down, change the decision at that bar (SELL / BUY / none)? Production read the live
-- file 2-6 s after the close and the table holds the final one, so a revised last close could flip a fire. One tick = 10^-d (JPY pairs 0.001, other pairs 0.00001, gold 0.01); the
-- moved close is the rounded price 2 ticks away (exact decimal arithmetic, then the nearest double, like the rounded closes themselves). Only the last step of the recursion
-- depends on that close, so that step is evaluated again here in closed form from the state one row earlier (e12_p, e26_p, sg_p, ta_p, tb_p), the same double operations
-- as in the recursion; the bar before (tp, bp, mp, p_top, p_bot) does not depend on it. The decision is monotone in the close (SELL for high closes, BUY for low ones, none
-- between), so the two end points tell whether any move inside +-2 ticks changes it.
ne as (
  select f.symbol, f.jr, bool_or(coalesce(x.sd, '') <> coalesce(f.sd, '')) as near_edge
  from fin2 f
  join s on s.symbol = f.symbol and s.rn = f.jr
  cross join (values (-2), (2)) q(k)
  cross join lateral (select (s.cn + q.k / (10::float8 ^ s.d)::numeric)::float8 as c2) c
  cross join lateral (select (2.0::float8 / 13.0::float8) * c.c2 + (1 - (2.0::float8 / 13.0::float8)) * f.e12_p as ne12,
                             (2.0::float8 / 27.0::float8) * c.c2 + (1 - (2.0::float8 / 27.0::float8)) * f.e26_p as ne26) a
  cross join lateral (select a.ne12 - a.ne26 as nm) b
  cross join lateral (select (2.0::float8 / 10.0::float8) * b.nm + (1 - (2.0::float8 / 10.0::float8)) * f.sg_p as nsg) z
  cross join lateral (select greatest(f.ta_p, b.nm, z.nsg, b.nm - z.nsg) as t2, least(f.tb_p, b.nm, z.nsg, b.nm - z.nsg) as b2) e
  cross join lateral (select case when e.t2 > 0 and b.nm >= 0.96::float8 * e.t2 and not f.p_top then 'SELL'
                                  when e.b2 < 0 and b.nm <= 0.96::float8 * e.b2 and not f.p_bot then 'BUY' end as sd) x
  group by f.symbol, f.jr
),
-- fire = the entry (the rule fires at this bar). mk_top / mk_bot = 0.96 * tn / 0.96 * bn, the marks the 96% starts at (the same products the comparisons above use).
-- tick = one unit of the last decimal.
fx2 as (
  select f.*, (f.sd is not null) as fire, n.near_edge, 0.96::float8 * f.tn as mk_top, 0.96::float8 * f.bn as mk_bot, power(10::float8, -f.d) as tick
  from fin2 f join ne n on n.symbol = f.symbol and n.jr = f.jr
),
-- the series per instrument: its length, the bars of the day (first / last open: a whole day ends with the bar that opened 15 min before the range ends; 15-minute bars missing
-- between the first and the last bar of the day mean a hole in the data), bad closes, and the rank of the day's first bar
sstat as (
  select y.symbol, count(s.rn) as history_bars,
         count(s.rn) filter (where s.ot >= pp.start_ms and s.ot < pp.end_ms) as day_bars,
         count(s.rn) filter (where s.bad) as bad_mantissas,
         min(s.rn) filter (where s.ot >= pp.start_ms and s.ot < pp.end_ms) as first_day_rank,
         min(s.ot) filter (where s.ot >= pp.start_ms and s.ot < pp.end_ms) as first_day_ot,
         max(s.ot) filter (where s.ot >= pp.start_ms and s.ot < pp.end_ms) as last_day_ot
  from syms y cross join pp left join s on s.symbol = y.symbol
  group by y.symbol
),
wstat as (
  select y.symbol, count(f.ot) as windows, count(f.ot) filter (where f.in_top or f.in_bot) as band_bars, count(f.ot) filter (where f.fire) as exp_fires
  from syms y left join fx2 f on f.symbol = y.symbol
  group by y.symbol
),
-- the mails: public.signal_alerts rows of THIS rule on the 15-minute chart (interval '15min'), grouped per signal (pair, side, bar); no user_id / event_id is read.
-- n_st = the rows with a stop or a target (the fade states neither: signalRow writes both null; any such row is told, stop_or_target)
mails as (
  select a.pair, a.side, (extract(epoch from a.bar_time) * 1000)::bigint as ot,
         count(*) as n_rows, count(*) filter (where a.status = 'sent') as n_sent, string_agg(distinct a.status, ',') as statuses,
         min(extract(epoch from (a.sent_at - a.closed_at))) as lag_min, max(extract(epoch from (a.sent_at - a.closed_at))) as lag_max,
         min(a.entry) as entry, max(a.entry) as entry_max,
         count(*) filter (where a.stop is not null or a.target is not null) as n_st
  from public.signal_alerts a, pp
  where a.kind = 'signal' and a.interval = '15min' and a.rule = 'macdx_12_26_9_w600_15min_fade96of120_in_v12'
    and a.pair in (select pair from syms)
    and a.bar_time >= to_timestamp(pp.start_ms / 1000.0) and a.bar_time < to_timestamp(pp.end_ms / 1000.0)
  group by a.pair, a.side, a.bar_time
),
-- one side a bar (research/macdfade15min-prod-spec.md 2.5: mailRide reads the bar's rows under the rule whatever their side, and a row of the other side means nothing is
-- mailed, other_side): msides = the bars of the range with rows of THIS rule of both sides (n_sides 2); every line of such a bar is told, other_side
msides as (select pair, ot, count(*) as n_sides from mails group by pair, ot having count(*) > 1),
-- subscriptions now (count only; the 15-minute macdx subscriptions, which v41 reads: spec 3.6, the '15min' twins; the '1h' rows v40 read are not counted) and the macdx
-- rows in the range that are NOT this rule on the 15-minute chart (v7's reading, back1-v7.part): every macdx row of the 1-hour chart (v40's fade rows _1h_..._in_v11 on
-- the switch day and in a rollback, any older id, and this rule's id on '1h') and every 15-minute macdx row of another rule id (v7's _15min_z95of120_v7, a renamed rule:
-- it would make every mail look "missing"). The 5-minute macdx rows of the old 5-minute rule are not counted (as in v4 / v6 / v7). The fields keep their v6 names
-- other_macdx_1h_rows / other_macdx_1h_rule_rows (the Routine reads them).
subs as (select pair, count(*) as n from public.signal_alert_subscriptions where interval = '15min' and rule = 'macdx' group by pair),
othr as (
  select a.pair, count(*) as n
  from public.signal_alerts a, pp
  where a.kind = 'signal' and a.interval in ('1h', '15min') and a.rule like 'macdx%' and not (a.interval = '15min' and a.rule = 'macdx_12_26_9_w600_15min_fade96of120_in_v12')
    and a.pair in (select pair from syms)
    and a.bar_time >= to_timestamp(pp.start_ms / 1000.0) and a.bar_time < to_timestamp(pp.end_ms / 1000.0)
  group by a.pair
),
-- late1h = of those, the 1-hour macdx rows (any id) whose bar closed (bar_time + 1 h) after end_1h_ms, the end of the last 1-hour bar v40 judged for the chart (syms): v40
-- judged no 1-hour bar after it, so such a row is a finding on every day (the switch day included); v40's own rows up to end_1h_ms are only counted in othr (expected
-- on the switch day). In a rollback (v40 answering again) its rows after the v41 window come here too (README.md v12.1).
late1h as (
  select a.pair, count(*) as n
  from public.signal_alerts a join syms y on y.pair = a.pair, pp
  where a.kind = 'signal' and a.interval = '1h' and a.rule like 'macdx%'
    and a.bar_time >= to_timestamp(pp.start_ms / 1000.0) and a.bar_time < to_timestamp(pp.end_ms / 1000.0)
    and a.bar_time + interval '1 hour' > to_timestamp(y.end_1h_ms / 1000.0)
  group by a.pair
),
-- the switch (only on the GMO day that holds it; zero on every other day): the 15-minute slots of the range judged by neither form (open at or after end_1h_ms and before
-- live_ms: v40 had stopped, v41 had not started; an entry there is not_mailable before_go_live) and by both (open at or after live_ms and closing at or before end_1h_ms:
-- a 15-minute bar inside v40's last judged hour, gold's overlap of spec 6.2). Slots of the weekend window are counted too (none at a switch made as spec 6.2 says).
swb as (
  select y.symbol,
         count(h) filter (where h >= y.end_1h_ms and h < y.live_ms) as gap_bars,
         count(h) filter (where h >= y.live_ms and h + 900000 <= y.end_1h_ms) as overlap_bars
  from syms y cross join pp cross join lateral generate_series(pp.start_ms, pp.end_ms - 900000, 900000::bigint) h
  group by y.symbol
),
-- ===== GUARDS (gold): is the stored row there, does it reach the end of the range, is the history long enough =====
-- the 15-minute slots of the range whose bar production can judge (its close time, open + 900000 ms, is not in isPossiblyClosed: Fri >= 21:00, Sat, Sun < 22:00 UTC).
-- The field names judgeable_hours_without_a_bar / last_judgeable_open_utc are v6's; in v7 they count 15-minute slots.
hj as (
  select h as ot_h
  from pp, generate_series(pp.start_ms, pp.end_ms - 900000, 900000::bigint) h
  cross join lateral (select extract(dow from to_timestamp((h + 900000) / 1000.0) at time zone 'UTC') as cdw,
                             extract(hour from to_timestamp((h + 900000) / 1000.0) at time zone 'UTC') as chh) c
  where not ((c.cdw = 5 and c.chh >= 21) or c.cdw = 6 or (c.cdw = 0 and c.chh < 22))
),
gchk as (
  select count(*) filter (where lag_ot is not null and ot <= lag_ot) as non_ascending
  from (select ot, lag(ot) over (order by pos) as lag_ot from bgold2 where ok) q
),
gg as (
  select (select count(*) from grow0) as row_found,
         (select fetched_at from grow0) as fetched_at,
         (select count(*) from braw) as row_bars,
         (select count(*) from bgold2 where not ok) as unparsable_rows,
         (select count(*) from bgold2 where ok and ot + 900000 > fetched_ms) as forming_in_row,
         (select count(*) from us) as closed_bars,
         (select max(ot) from us) as newest_closed_ot,
         (select max(ot_h) from hj) as last_judgeable_ot,
         (select count(*) from hj h where not exists (select 1 from us where us.ot = h.ot_h)) as missing_judgeable_hours,
         (select non_ascending from gchk) as non_ascending
),
gd as (
  select y.symbol,
         case when g.row_found = 0 or ss.day_bars = 0 or g.last_judgeable_ot is null then 'NO_DATA'
              when g.newest_closed_ot < g.last_judgeable_ot then 'STALE_ROW'
              when not pp.range_ok then 'BAD_RANGE'
              else 'ok' end as status,
         case when g.row_found = 0 then 'no XAU/USD 15min row in public.live_chart_fallback: nothing was recounted'
              when ss.day_bars = 0 then 'the stored row holds no closed bar in the range: nothing to recount'
              when g.last_judgeable_ot is null then 'no hour of the range can be judged by production (a Saturday key: its bars all close in the weekend window): nothing to recount'
              when g.newest_closed_ot < g.last_judgeable_ot then 'the stored row (read ' || to_char(g.fetched_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS') || ' UTC) ends before the range does: its newest closed bar opened '
                   || to_char(to_timestamp(g.newest_closed_ot / 1000.0) at time zone 'UTC', 'YYYY-MM-DD HH24:MI') || ', the last bar production could judge opened '
                   || to_char(to_timestamp(g.last_judgeable_ot / 1000.0) at time zone 'UTC', 'YYYY-MM-DD HH24:MI') || ': "no fire" cannot be told from "not read yet"'
              when not pp.range_ok then 'the range is not one whole GMO day (24 h from 21:00 UTC): check START_MS / END_MS'
              else null end as why,
         concat_ws('; ',
           case when g.non_ascending > 0 then 'row_not_ascending=' || g.non_ascending end,
           case when g.unparsable_rows > 0 then 'unparsable_rows=' || g.unparsable_rows end,
           case when g.missing_judgeable_hours > 0 then 'judgeable_hours_without_a_bar=' || g.missing_judgeable_hours end,
           case when ss.day_bars > 0 and ss.first_day_rank < 600 then 'history_shorter_than_600_before_day' end,
           case when coalesce(sb.n, 0) = 0 then 'no_subscription_row' end,
           case when coalesce(ot.n, 0) > 0 then 'other_macdx_1h_rule_rows=' || ot.n end) as warn,
         json_build_object(
           'row_read_utc', to_char(g.fetched_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS'), 'row_bars', g.row_bars, 'closed_bars', g.closed_bars, 'forming_bars_left_out', g.forming_in_row,
           'newest_closed_open_utc', to_char(to_timestamp(g.newest_closed_ot / 1000.0) at time zone 'UTC', 'YYYY-MM-DD HH24:MI'),
           'last_judgeable_open_utc', to_char(to_timestamp(g.last_judgeable_ot / 1000.0) at time zone 'UTC', 'YYYY-MM-DD HH24:MI'),
           'judgeable_hours_without_a_bar', g.missing_judgeable_hours, 'non_ascending', g.non_ascending, 'unparsable_rows', g.unparsable_rows,
           'bars_before_day', ss.first_day_rank - 1, 'history_ok', coalesce(ss.first_day_rank >= 600, false),
           'subscriptions', coalesce(sb.n, 0), 'other_macdx_1h_rows', coalesce(ot.n, 0),
           'note', 'latest stored row: production judged each bar on the row as it was 1 to 15 minutes after the close') as guard
  from syms y cross join pp cross join gg g
  join sstat ss on ss.symbol = y.symbol
  left join subs sb on sb.pair = y.pair
  left join othr ot on ot.pair = y.pair
),
-- gold only: Twelve Data's daily credit cap (the sweep reads only while the UTC day's count is below 780, ALERT_TWELVE_CAP); a fire on a day that reached it may have been
-- blocked (the day of the bar's close, open + 900000 ms)
extra_reasons as (
  select 'XAU/USD'::text as pair, f.ot, 'twelve_daily_cap'::text as reason
  from fx2 f
  join public.twelve_data_usage u on u.day = (to_timestamp((f.ot + 900000) / 1000.0) at time zone 'UTC')::date
  where u.used >= 780
),
-- cut = the day's last bar opened BEFORE the last bar production could judge in the range (last_judgeable_ot of the gold guard): the stored row is cut, or has a hole at the end of
-- the day. Gold's stored row is the latest read of Twelve Data and the sweep stops at the weekend window: on a Saturday the row of a Friday day ends with the 19:00 bar, because
-- the 20:00 bar closes at Friday 21:00 (weekend window), is never judged and is not in the row yet. v3 compared the last bar with END_MS minus 1 h and flagged that as
-- last_day_bar_not_at_day_end (review finding F1, 2026-10-13); v4 compares it with the last judgeable bar. A row read later that does hold the 20:00 bar is fine too.
dayend as (
  select y.symbol, coalesce(ss.day_bars > 0 and ss.last_day_ot < g.last_judgeable_ot, false) as cut
  from syms y cross join gg g join sstat ss on ss.symbol = y.symbol
),
-- ===== BACK 2 (v12; the same text in pairs-v12.sql and gold-v12.sql): the comparison, the verdicts, the summaries, the result =====
-- v12 = v11's text (back2-v11.part: the price in, other_side, stop_or_target) on the 15-minute chart, as v7 moved v6's (back2-v7.part): the close time open + 15 min,
-- day_hours_missing in 15-minute steps, the RUN row's sql and rule; and new: the switch's fields (go_live_utc, end_1h_utc, switch_gap_bars, switch_overlap_bars) and
-- macdx_1h_rows_after_end_1h (late1h of BACK 1) in each SUMMARY, end_1h_utc in the RUN row.
-- every signal either side knows (the recount's expected entries and the mail groups), joined on (pair, bar open, side)
j as (
  select coalesce(e.pair, m.pair) as pair, coalesce(e.ot, m.ot) as ot, coalesce(e.sd, m.side) as side,
         (e.ot is not null) as has_exp, (m.ot is not null) as has_mail, m.n_rows, m.n_sent, m.statuses, m.lag_min, m.lag_max, m.entry, m.entry_max, coalesce(m.n_st, 0) as n_st
  from (select f.pair, f.ot, f.sd from fx2 f where f.fire) e
  full join mails m on m.pair = e.pair and m.ot = e.ot and m.side = e.sd
),
-- the facts of the bar's own window (also for a mail whose bar is no expected entry), the bar's close time = open + 15 min (Fri >= 21:00, Sat, Sun < 22:00 UTC = production
-- does not judge it: the sweep is skipped while isPossiblyClosed(now), and a 15-minute bar is judged only while it is the newest closed one, by the reads at +0, +1 and +3
-- minutes after its close (pairs, gmoIntervalsDue) or from +1 minute until the next close (gold, twelveCloseDue), all inside the close's own quarter hour; with closes on
-- the quarter hours the window on the close time is the same as for the hourly bars).
-- x_paid = the recount's price in for the line's side: a pair's ask close (BUY) or bid close (SELL) of the bar as the stored file gives it (the FRONT's paid, unrounded);
-- gold's (no row in paid) the bar's own rounded close clo, the price production put in. ms = the bar has rows of this rule of both sides (other_side).
j2 as (
  select j.*, y.symbol, y.ord, y.live_ms, y.d, coalesce(sb.n, 0) as subs,
         extract(dow from to_timestamp((j.ot + 900000) / 1000.0) at time zone 'UTC') as cdw,
         extract(hour from to_timestamp((j.ot + 900000) / 1000.0) at time zone 'UTC') as chh,
         x.m as x_m, x.sg as x_sg, x.tn as x_tn, x.bn as x_bn, x.mk_top as x_mk_top, x.mk_bot as x_mk_bot,
         x.in_top as x_in_top, x.in_bot as x_in_bot, x.p_top as x_p_top, x.p_bot as x_p_bot, x.sd as x_sd,
         x.near_edge as x_ne, x.tick as x_tick, x.clo as x_clo,
         coalesce(case j.side when 'BUY' then pd.paid_buy when 'SELL' then pd.paid_sell end, x.clo::float8) as x_paid,
         (ms.ot is not null) as other_side
  from j join syms y on y.pair = j.pair
  left join subs sb on sb.pair = j.pair
  left join fx2 x on x.symbol = y.symbol and x.ot = j.ot
  left join paid pd on pd.symbol = y.symbol and pd.ot = j.ot
  left join msides ms on ms.pair = j.pair and ms.ot = j.ot
),
-- why production could not have mailed an expected entry (empty = it should have); entry_diff_ticks = how many ticks the mail's entry (its farthest row) lies from the
-- recount's price in, x_paid (0 = the same price; production priced a pair's entry from the 15-minute read it judged on, at minute 0, 1 or 3 after the close, fadeQuotes;
-- the table holds the day file stored after the GMO day ended)
v0 as (
  select j2.*, concat_ws(';',
           case when (j2.cdw = 5 and j2.chh >= 21) or j2.cdw = 6 or (j2.cdw = 0 and j2.chh < 22) then 'weekend_window' end,
           case when j2.ot < j2.live_ms then 'before_go_live' end,
           case when j2.subs = 0 then 'no_subscription' end,
           (select string_agg(r.reason, ';') from extra_reasons r where r.pair = j2.pair and r.ot = j2.ot)) as reasons,
         case when j2.entry is not null and j2.x_paid is not null
              then round(((case when abs(j2.entry_max - j2.x_paid) > abs(j2.entry - j2.x_paid) then j2.entry_max else j2.entry end) - j2.x_paid) * power(10::float8, j2.d))::int end as entry_diff_ticks
  from j2
),
-- the verdict of each line
verdicts as (
  select v0.*,
         case when has_exp and has_mail then (case when n_rows > n_sent then 'not_sent' when n_rows > greatest(subs, 1) then 'dup' else 'ok' end)
              when has_exp then (case when reasons <> '' then 'not_mailable' else 'missing' end)
              when x_m is null then 'unchecked'
              else 'extra' end as verdict
  from v0
),
cnt as (
  select y.symbol,
         count(v.pair) filter (where v.verdict in ('ok', 'not_sent', 'dup')) as matched,
         count(v.pair) filter (where v.verdict = 'missing') as missing,
         count(v.pair) filter (where v.verdict = 'extra') as extra,
         count(v.pair) filter (where v.verdict = 'unchecked') as unchecked,
         count(v.pair) filter (where v.verdict = 'not_mailable') as not_mailable,
         count(v.pair) filter (where v.verdict = 'dup') as dups,
         count(v.pair) filter (where v.entry_diff_ticks <> 0) as entry_diff,
         coalesce(sum(v.n_rows), 0) as mail_rows, count(v.pair) filter (where v.has_mail) as mail_signals,
         coalesce(sum(v.n_rows - v.n_sent), 0) as not_sent_rows,
         min(v.lag_min) as lag_min, max(v.lag_max) as lag_max,
         count(v.pair) filter (where v.verdict = 'not_mailable' and v.reasons like '%weekend_window%') as nm_weekend,
         count(v.pair) filter (where v.verdict = 'not_mailable' and v.reasons like '%before_go_live%') as nm_live,
         count(v.pair) filter (where v.verdict = 'not_mailable' and v.reasons like '%no_subscription%') as nm_subs,
         count(v.pair) filter (where v.verdict = 'not_mailable' and v.reasons like '%twelve_daily_cap%') as nm_cap,
         count(distinct v.ot) filter (where v.other_side) as other_side_bars,
         coalesce(sum(v.n_st), 0) as st_rows
  from syms y left join verdicts v on v.symbol = y.symbol
  group by y.symbol
),
u as (
  -- one SUMMARY row per instrument
  select 1 as o1, y.ord::bigint as o2, 0::bigint as o3, 'SUMMARY'::text as row_type, y.pair as instrument, null::text as bar_open_utc, null::text as side,
         case when gd.status <> 'ok' then gd.status when att.t <> '' then 'CHECK' else 'OK' end as verdict,
         json_build_object(
           'history_bars', ss.history_bars, 'day_bars', ss.day_bars,
           'first_bar_utc', to_char(to_timestamp(ss.first_day_ot / 1000.0) at time zone 'UTC', 'YYYY-MM-DD HH24:MI'),
           'last_bar_utc', to_char(to_timestamp(ss.last_day_ot / 1000.0) at time zone 'UTC', 'YYYY-MM-DD HH24:MI'),
           'windows', ws.windows, 'bad_mantissas', ss.bad_mantissas,
           'band_bars', ws.band_bars, 'expected_fires', ws.exp_fires,
           'not_mailable', c.not_mailable,
           'not_mailable_why', nullif(concat_ws(';', case when c.nm_weekend > 0 then 'weekend_window:' || c.nm_weekend end, case when c.nm_live > 0 then 'before_go_live:' || c.nm_live end,
                                                    case when c.nm_subs > 0 then 'no_subscription:' || c.nm_subs end, case when c.nm_cap > 0 then 'twelve_daily_cap:' || c.nm_cap end), ''),
           'mail_rows', c.mail_rows, 'mail_signals', c.mail_signals, 'matched', c.matched, 'missing', c.missing, 'extra', c.extra, 'unchecked', c.unchecked,
           'not_sent_rows', c.not_sent_rows, 'duplicates', c.dups, 'entry_differs', c.entry_diff,
           'other_side', c.other_side_bars, 'stop_or_target', c.st_rows,
           'macdx_1h_rows_after_end_1h', coalesce(lt.n, 0),
           'go_live_utc', to_char(to_timestamp(y.live_ms / 1000.0) at time zone 'UTC', 'YYYY-MM-DD HH24:MI'),
           'end_1h_utc', to_char(to_timestamp(y.end_1h_ms / 1000.0) at time zone 'UTC', 'YYYY-MM-DD HH24:MI'),
           'switch_gap_bars', sw.gap_bars, 'switch_overlap_bars', sw.overlap_bars,
           'lag_min_s', round(c.lag_min::numeric, 3), 'lag_max_s', round(c.lag_max::numeric, 3),
           'attention', nullif(att.t, ''), 'no_data_why', gd.why, 'guard', gd.guard) as data
  from syms y cross join pp
  join gd on gd.symbol = y.symbol join sstat ss on ss.symbol = y.symbol join wstat ws on ws.symbol = y.symbol join cnt c on c.symbol = y.symbol join dayend de on de.symbol = y.symbol
  join swb sw on sw.symbol = y.symbol left join late1h lt on lt.pair = y.pair
  cross join lateral (select concat_ws('; ',
      case when c.missing > 0 then 'missing=' || c.missing end, case when c.extra > 0 then 'extra=' || c.extra end,
      case when c.unchecked > 0 then 'unchecked=' || c.unchecked end, case when c.not_sent_rows > 0 then 'not_sent_rows=' || c.not_sent_rows end,
      case when c.dups > 0 then 'dup=' || c.dups end, case when c.entry_diff > 0 then 'entry_differs=' || c.entry_diff end,
      case when c.other_side_bars > 0 then 'other_side=' || c.other_side_bars end, case when c.st_rows > 0 then 'stop_or_target=' || c.st_rows end,
      case when coalesce(lt.n, 0) > 0 then 'macdx_1h_rows_after_end_1h=' || lt.n end,
      case when ss.bad_mantissas > 0 then 'bad_mantissas=' || ss.bad_mantissas end,
      case when ws.windows < ss.day_bars then 'bars_without_600_window=' || (ss.day_bars - ws.windows) end,
      case when de.cut then 'last_day_bar_not_at_day_end' end,
      case when ss.day_bars > 0 and (ss.last_day_ot - ss.first_day_ot) / 900000 + 1 > ss.day_bars then 'day_hours_missing=' || ((ss.last_day_ot - ss.first_day_ot) / 900000 + 1 - ss.day_bars) end,
      nullif(gd.warn, '')) as t) att
  union all
  -- one LINE per expected entry and per mail
  select 2, f.ot, f.ord::bigint, 'LINE', f.pair, to_char(to_timestamp(f.ot / 1000.0) at time zone 'UTC', 'YYYY-MM-DD HH24:MI'), f.side, f.verdict,
         json_strip_nulls(json_build_object(
           'mail_rows', f.n_rows, 'mail_status', f.statuses, 'lag_min_s', round(f.lag_min::numeric, 3), 'lag_max_s', round(f.lag_max::numeric, 3), 'entry', f.entry,
           'paid', f.x_paid, 'close', f.x_clo, 'entry_diff_ticks', f.entry_diff_ticks,
           'other_side', case when f.other_side then true end, 'stop_or_target_rows', nullif(f.n_st, 0),
           'macd', f.x_m, 'signal', f.x_sg,
           'top', case when f.side = 'SELL' then f.x_tn end, 'bottom', case when f.side = 'BUY' then f.x_bn end,
           'mark', case f.side when 'SELL' then f.x_mk_top when 'BUY' then f.x_mk_bot end,
           'mark_dist_ticks', round(((case f.side when 'SELL' then f.x_m - f.x_mk_top when 'BUY' then f.x_mk_bot - f.x_m end) / f.x_tick)::numeric, 1),
           'band_before', case when (case f.side when 'SELL' then f.x_p_top when 'BUY' then f.x_p_bot end) then true end,
           'near_edge', f.x_ne,
           'why', nullif(concat_ws('; ', case f.verdict
                    when 'not_mailable' then f.reasons
                    when 'missing' then 'no row in signal_alerts for an expected entry that production could mail'
                    when 'dup' then 'rows ' || f.n_rows || ' > subscriptions ' || f.subs
                    when 'unchecked' then 'the recount has no window for this bar (bar not in the data, or fewer than 600 bars before it)'
                    when 'extra' then case when f.x_sd is not null and f.x_sd <> f.side then 'recount has the OPPOSITE entry (' || f.x_sd || ')'
                                           when case f.side when 'SELL' then f.x_in_top and f.x_p_top else f.x_in_bot and f.x_p_bot end
                                                then 'recount: the blue line is in the ' || case f.side when 'SELL' then 'top' else 'bottom' end || ' band here but was already in it one bar earlier (no new entry)'
                                           when case f.side when 'SELL' then f.x_tn <= 0 else f.x_bn >= 0 end
                                                then 'recount has no ' || case f.side when 'SELL' then 'top' else 'bottom' end || ' band here (no value ' || case f.side when 'SELL' then 'above' else 'below' end || ' zero in the 120 bars of the pane)'
                                           else 'recount: the blue line is not in the ' || case f.side when 'SELL' then 'top' else 'bottom' end || ' band here (macd short of the mark)' end
                    when 'ok' then case when f.reasons <> '' then 'mailed although ' || f.reasons end
                    when 'not_sent' then case when f.reasons <> '' then 'also ' || f.reasons end end,
                  case when f.other_side then 'other_side: this bar has rows of this rule of both sides (one side a bar)' end,
                  case when f.n_st > 0 then 'stop_or_target: ' || f.n_st || ' row(s) carry a stop or a target (the fade states neither)' end), '')))
  from verdicts f
  union all
  -- the run itself (last in this list, so that elapsed_s is read after everything else was done; shown first)
  select 0, 0, 0, 'RUN', null, null, null, 'info',
         json_build_object('sql', 'gold.sql v12', 'rule', 'macdx_12_26_9_w600_15min_fade96of120_in_v12', 'keys', pp.k_first || '..' || pp.k_last,
           'range_utc', to_char(to_timestamp(pp.start_ms / 1000.0) at time zone 'UTC', 'YYYY-MM-DD HH24:MI') || ' .. ' || to_char(to_timestamp(pp.end_ms / 1000.0) at time zone 'UTC', 'YYYY-MM-DD HH24:MI'),
           'range_is_one_gmo_day', pp.range_ok, 'db_now_utc', to_char(now() at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
           'go_live_utc', (select to_char(to_timestamp(min(live_ms) / 1000.0) at time zone 'UTC', 'YYYY-MM-DD HH24:MI') from syms),
           'end_1h_utc', (select to_char(to_timestamp(max(end_1h_ms) / 1000.0) at time zone 'UTC', 'YYYY-MM-DD HH24:MI') from syms),
           'lines', (select count(*) from verdicts), 'elapsed_s', round(extract(epoch from clock_timestamp() - statement_timestamp())::numeric, 2),
           -- the md5 and length of the statement text AS THE DATABASE RECEIVED IT (the tool appends a comment after a blank line: cut off). The caller compares it with the md5 of the text it meant to send,
           -- so that a slip made while copying the 20 kB text into the tool call shows (a mismatch means: send again from the file; the numbers of this answer are then not to be trusted)
           'sql_md5', md5(split_part(current_query(), E'\n\n-- source: POST /mcp', 1)), 'sql_chars', length(split_part(current_query(), E'\n\n-- source: POST /mcp', 1)))
  from pp
)
select row_type, instrument, bar_open_utc, side, verdict, data from u order by o1, o2, o3
