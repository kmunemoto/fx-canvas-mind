-- pairs-v12.sql  -  the morning check of the MACD fade e-mails on the 15-minute chart for the TWO PAIRS that move to it (USD/JPY, AUD/USD), rule v12.
-- (research/macdfade15min-prod-spec.md 7.3, the per-pair form: EUR/JPY, AUD/JPY and EUR/USD stay on v40's 1-hour form, checked by pairs1h-v11.sql; gold by gold-v11.sql.)
-- ONE read-only statement (WITH ... SELECT) for mcp__Supabase__execute_sql. Replace the two markers START_MS and END_MS (each written once, in double curly braces, in the first CTE) by the epoch
-- milliseconds of the range: bars are judged by their OPEN time, START_MS <= open < END_MS; the Routine's day is (X-2d) 21:00 UTC .. (X-1d) 21:00 UTC,
-- END_MS = START_MS + 86400000. Nothing else is to be edited.
-- THE GO-LIVE CONSTANTS ARE NOT SET YET: GO_LIVE_MS_PAIRS and END_1H_MS_PAIRS (double curly braces, in syms) are placeholders that are replaced in src/syms-pairs-v12.part at
-- the release of signal-alerts v41 (README.md v12.1); while they are there, the statement does not run. Bars that opened before GO_LIVE_MS_PAIRS were judged by v40 on the
-- 1-hour chart (the MACD fade on 1-hour bars, README.md v11).
-- It recounts the rule macdx_12_26_9_w600_15min_fade96of120_in_v12 (signal-alerts v41, research/macdfade15min-prod-spec.md: at a closed 15-MINUTE bar, the MACD line, the
-- blue line, is at 96% of the top / bottom edge of the MACD pane of the newest 120 bars and was not one bar earlier in the same 600-bar window; the FADE side: top -> SELL,
-- bottom -> BUY; the price in is the bar's ask close on a BUY and bid close on a SELL; no stop and no target) from public.gmo_kline_files (interval 15min) as production
-- reads the data, and compares the expected entries with public.signal_alerts (kind signal, interval 15min, that rule id): the bar, the side, the entry against the ask /
-- bid close, one side a bar (other_side), no stop or target (stop_or_target).
-- It is v11's statement (pairs-v11.sql) on v7's 15-minute parts (pairs-v7.sql: head-v7, front-pairs-v7 with the bars' bid and ask closes, guard-pairs-v7, dayend-pairs-v7),
-- with the 15-minute constants of v7 in BACK 1 and BACK 2, the new id, and the switch's fields (README.md v12.2).
-- The RUN row also counts macdx_15min_rows_other_pairs: the day's signal_alerts rows (kind signal, interval 15min, rule like macdx%) of a pair NOT in syms (EUR/JPY, AUD/JPY,
-- EUR/USD, gold: v41 judging a chart that is not the pair's). No other statement reads them, so any count above 0 is a finding (README.md v12.3). It is written through the
-- slot RUN_OTHER_PAIRS of back2-v12.part, which build.sh fills for this file only (gold-v12.sql gets an empty string there and stays byte for byte as it was).
-- It reads no user_id / event_id / e-mail address and writes nothing.
-- Result: columns row_type (RUN | SUMMARY | LINE), instrument, bar_open_utc, side, verdict, data (json). See README.md (sections v12, v11, v7 and v8) for every field.
-- Written to be run in well under a minute (one day: a few seconds).
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
-- ===== FRONT (two pairs: USD/JPY, AUD/USD): public.gmo_kline_files -> us(symbol, ot, seq, m8, d, bc, ac), the 15-minute series production judges on, and paid, the price in =====
-- instrument table: GMO symbol, the app's pair name, display order, the instant from which the v12 rule (signal-alerts v41, the MACD fade on the 15-minute chart) was live,
-- the decimals of the chart's rounding (decimalsOf: 3 for a ...JPY pair, 5 for the others), and the end of v40's 1-hour form for the chart.
-- Two rows only (research/macdfade15min-prod-spec.md 7.3, the per-pair form): USD/JPY and AUD/USD move to the 15-minute chart; EUR/JPY, AUD/JPY and EUR/USD stay on v40's
-- 1-hour form under v11's id and are checked by pairs1h-v11.sql, gold by gold-v11.sql (README.md v12.1). Every CTE of this statement is scoped by syms, so their rows are
-- not read here; a stray 15-minute macdx row of theirs (or of gold) is counted in the RUN row's macdx_15min_rows_other_pairs (back2-v12.part, the RUN_OTHER_PAIRS slot).
-- live_ms = 1795161600000 (2026-11-20 08:00 UTC), set at the release (README.md v12.1) from the run's records in net._http_response: v41 (signal-alerts-v41-2026-11-20)
-- first answered at 08:05:00 UTC, and the first 15-minute bar it judged for both pairs is the one opened at 08:00 (closing 08:15; research/macdfade15min-prod-spec.md 6.2,
-- 6.3 step 5; docs/OPERATIONS.md section 8.156).
-- end_1h_ms = 1795161600000 (08:00 UTC), the end (open + 1 h) of the last 1-hour bar v40 judged: v40 answered every minute up to 08:04:00 UTC, its reads of the 08:00 close at 08:00
-- and 08:03 (gmoIntervalsDue: 1-hour charts at minutes 0, 3 and 5; the read at 08:05 was v41's, which no longer reads these two pairs' 1-hour chart). The records of those
-- two reads expired (about 6 hours) before they were read for this, so whether either of them judged the hour is NOT confirmed (no 'macdx failed' line in the function's
-- log 07:59-08:06 UTC; docs/OPERATIONS.md section 8.156). 08:00 is spec 7.3's value for a judged hour; had neither judged it, v40's last judged bar would end at 07:00 (spec 6.2's four-bar
-- gap), and an entry on the 07:00 bar would show as missing in pairs-v11 on the switch day (read before end_1h_ms) rather than be hidden.
-- It is not a limit of the recount: it tells the 1-hour macdx rows of the day that came after v40's last judged bar (a finding,
-- macdx_1h_rows_after_end_1h) from v40's own last rows (expected on the switch day), and, with live_ms, the 15-minute bars of the switch day judged by neither form (live_ms
-- after end_1h_ms) or by both (live_ms before end_1h_ms). Both pairs have the same numbers (each row holds its own, should they ever differ).
-- The rest of the FRONT is v7's 15-minute one (front-pairs-v7.part: interval '15min', the closure test on open + 15 min) with v9's two closes: each bar's BID close (bc) and ASK
-- close (ac) as given, and the CTE paid (paid_buy = the ASK close, paid_sell = the BID close, per bar of the range: ridePaidAt on the 15-minute read's own quote, as the fade
-- prices a pair's entry from fadeQuotes, research/macdfade15min-prod-spec.md 2.3).
syms as (
  select * from (values
    ('USD_JPY', 'USD/JPY', 1, 1795161600000::bigint, 3, 1795161600000::bigint),
    ('AUD_USD', 'AUD/USD', 5, 1795161600000::bigint, 5, 1795161600000::bigint)
  ) v(symbol, pair, ord, live_ms, d, end_1h_ms)
),
-- the day files of the 13 days up to the last key (15-minute files, interval '15min', BID and ASK; GMO_INTERVALS['15min'].name in track-outcomes/quotes.ts)
files as (
  select f.symbol, f.price_type, f.date_key, f.body,
         case when jsonb_typeof(f.body -> 'data') = 'array' then jsonb_array_length(f.body -> 'data') else 0 end as nbars,
         case when f.body ->> 'responsetime' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z$' then (f.body ->> 'responsetime')::timestamptz end as resp,
         (extract(epoch from to_date(f.date_key, 'YYYYMMDD'))::bigint - 10800) * 1000 as key_start_ms
  from public.gmo_kline_files f, pp
  where f.interval = '15min' and f.price_type in ('BID', 'ASK') and f.symbol in (select symbol from syms)
    and f.date_key between pp.from_key and pp.k_last
),
-- every row of every file, with its place (pos) in the file: parseKlines reads the rows of a file sorted by openTime, equal times keeping their file order
rows_ as (
  select f.symbol, f.price_type, f.date_key, f.key_start_ms, e.pos, e.x ->> 'openTime' as ot_s, e.x ->> 'open' as o_s, e.x ->> 'high' as h_s, e.x ->> 'low' as l_s, e.x ->> 'close' as c_s
  from files f
  cross join lateral jsonb_array_elements(case when jsonb_typeof(f.body -> 'data') = 'array' then f.body -> 'data' else '[]'::jsonb end) with ordinality as e(x, pos)
),
-- a row counts only if openTime/open/high/low/close are plain numbers (production's parseKlines drops the others; a missing field is not a number: ok = false, never NULL)
rows2 as (
  select *, coalesce(ot_s ~ '^[0-9]{1,15}$' and o_s ~ '^[0-9]+(\.[0-9]+)?$' and h_s ~ '^[0-9]+(\.[0-9]+)?$' and l_s ~ '^[0-9]+(\.[0-9]+)?$' and c_s ~ '^[0-9]+(\.[0-9]+)?$', false) as ok from rows_
),
parsed as (
  select symbol, price_type, date_key, key_start_ms, pos, ok,
         case when ok then ot_s::bigint end as ot, case when ok then c_s::float8 end as cl
  from rows2
),
-- mergeSides (track-outcomes/quotes.ts), arrival order = files in ascending key order, inside a file by (openTime, file position):
--   the ASK of a bar is the LAST ASK row for its openTime (a Map built from the ASK rows in arrival order: the newest key, in one file the last row);
--   the BID rows are walked in arrival order and the FIRST one that has an ASK and is not above it (ask < bid skips the row without emitting it, so a later
--   duplicate may still be emitted) is the bar; a bar with no ASK row is dropped (an ASK row with no BID row never appears). Nothing is dropped for a zero close.
-- v12: the two closes as given (bc, ac: the fade pays the ask close on a BUY and the bid close on a SELL, ridePaidAt) are carried along, as v9's FRONT carries them for the
--   1-hour files (front-pairs-v9.part); the engine reads symbol, ot, seq, m8 and d only.
bid as (select symbol, date_key, pos, ot, cl as bc from parsed where price_type = 'BID' and ok),
ask as (select distinct on (symbol, ot) symbol, ot, cl as ac from parsed where price_type = 'ASK' and ok order by symbol, ot, date_key desc, pos desc),
mg0 as (
  select distinct on (b.symbol, b.ot) b.symbol, b.ot, b.date_key, b.pos, (b.bc + a.ac) / 2 as m8, b.bc, a.ac
  from bid b join ask a on a.symbol = b.symbol and a.ot = b.ot
  where not (a.ac < b.bc)
  order by b.symbol, b.ot, b.date_key, b.pos
),
-- the merged list keeps the BID arrival order (never sorted again by production): seq = the place of the emitted BID row in that order
mg as (select *, row_number() over (partition by symbol order by date_key, ot, pos) as seq from mg0),
-- usableBars: drop a bar the market was shut for the whole of (barInsideClosure = isMarketClosed(open) and isMarketClosed(open + 15 min - 1 ms), the bar's length
-- being intervalMsOf('15min') = 900000 ms;
-- isMarketClosed = Saturday, Friday from 22:00, Sunday before 21:00, UTC)
mc as (
  select symbol, ot, seq, m8, bc, ac,
         extract(dow from to_timestamp(ot / 1000.0) at time zone 'UTC') as dw0, extract(hour from to_timestamp(ot / 1000.0) at time zone 'UTC') as hr0,
         extract(dow from to_timestamp((ot + 899999) / 1000.0) at time zone 'UTC') as dw1, extract(hour from to_timestamp((ot + 899999) / 1000.0) at time zone 'UTC') as hr1
  from mg
),
us as (
  select m.symbol, m.ot, m.seq, m.m8, y.d, m.bc, m.ac
  from mc m join syms y on y.symbol = m.symbol
  where not ((m.dw0 = 6 or (m.dw0 = 5 and m.hr0 >= 22) or (m.dw0 = 0 and m.hr0 < 21)) and (m.dw1 = 6 or (m.dw1 = 5 and m.hr1 >= 22) or (m.dw1 = 0 and m.hr1 < 21)))
),
-- v12: what the fade pays at a bar's close (ridePaidAt): the ask close on a BUY, the bid close on a SELL, as given (unrounded), per bar of the range (v9's CTE paid)
paid as (select symbol, ot, ac as paid_buy, bc as paid_sell from us where ot >= (select start_ms from pp) and ot < (select end_ms from pp)),
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
-- ===== GUARDS (five pairs, 15-minute files): is the data there, is it whole, is the history long enough =====
-- the dates (not Sundays: a JST-Sunday key is never stored) the 13-day load should hold, 2 files each (BID, ASK)
dates as (
  select to_char(d, 'YYYYMMDD') as dk
  from pp, generate_series(to_date(pp.from_key, 'YYYYMMDD')::timestamp, to_date(pp.k_last, 'YYYYMMDD')::timestamp, interval '1 day') d
  where extract(dow from d) <> 0
),
-- newer_bars = for each expected key dk, the usable bars (us) of the keys NEWER than dk that opened at or before the range's first bar (sstat.first_day_ot; START_MS
-- when the range has no bar): production's walk (fetchRecentQuotes,
-- analyze/price-source.ts:210-226, asked for HISTORY_BARS + 1 = 601 bars by signal-alerts/index.ts:780) reads the keys newest first and stops as soon as it holds 601
-- usable bars, so for the range's first bar it reaches dk only when newer_bars < 601 (later bars of the range need no older key). Counted on the stored bars: a newer key
-- that is missing as well makes newer_bars smaller, so the older key is still asked for (the attention errs towards CHECK). The forming bar production also holds is not
-- counted (one bar on the cautious side).
-- (gkb = those bars counted once per key, the key being the file the merged bar came from: mergeSides keeps the BID row's)
gkb as (
  select m.symbol, m.date_key, count(*) as n
  from mg m join us u on u.symbol = m.symbol and u.seq = m.seq join sstat ss on ss.symbol = m.symbol cross join pp
  where m.ot <= coalesce(ss.first_day_ot, pp.start_ms)
  group by m.symbol, m.date_key
),
gneed as (
  select y.symbol, dt.dk, coalesce(sum(b.n), 0)::bigint as newer_bars
  from syms y cross join dates dt left join gkb b on b.symbol = y.symbol and b.date_key > dt.dk
  group by y.symbol, dt.dk
),
-- the files that are missing among the keys production's walk would read (newer_bars < 601; a key older than that is never read by production, so its file may never be
-- stored, and its absence changes nothing: not counted, v7.6 of README.md); all of them are counted, only the first 6 are named
gmiss as (
  select q.symbol, count(*) as n,
         string_agg(q.dk || '/' || q.t, ' ' order by q.dk, q.t) filter (where q.r <= 6) || case when count(*) > 6 then ' ... (+' || (count(*) - 6) || ' more)' else '' end as keys
  from (
    select y.symbol, dt.dk, pt.t, row_number() over (partition by y.symbol order by dt.dk, pt.t) as r
    from syms y cross join dates dt cross join (values ('BID'), ('ASK')) pt(t)
    join gneed gn on gn.symbol = y.symbol and gn.dk = dt.dk
    where gn.newer_bars < 601 and not exists (select 1 from files f where f.symbol = y.symbol and f.date_key = dt.dk and f.price_type = pt.t)
  ) q
  group by q.symbol
),
gfile as (
  select y.symbol,
         count(f.date_key) filter (where f.price_type = 'BID' and f.date_key between pp.k_first and pp.k_last) as files_bid,
         count(f.date_key) filter (where f.price_type = 'ASK' and f.date_key between pp.k_first and pp.k_last) as files_ask,
         coalesce(sum(f.nbars) filter (where f.price_type = 'BID' and f.date_key between pp.k_first and pp.k_last), 0) as bars_bid,
         coalesce(sum(f.nbars) filter (where f.price_type = 'ASK' and f.date_key between pp.k_first and pp.k_last), 0) as bars_ask,
         count(f.date_key) as files_loaded,
         -- a non-empty file whose answer was made before its GMO day had ended is a cut copy (its last bar may be unfinished)
         count(f.date_key) filter (where f.nbars > 0 and f.resp < (to_date(f.date_key, 'YYYYMMDD') + interval '21 hours') at time zone 'UTC' and f.date_key between pp.k_first and pp.k_last) as early_key_files,
         count(f.date_key) filter (where f.nbars > 0 and f.resp < (to_date(f.date_key, 'YYYYMMDD') + interval '21 hours') at time zone 'UTC') as early_files_all
  from syms y cross join pp left join files f on f.symbol = y.symbol
  group by y.symbol
),
grow as (
  select y.symbol, count(r.symbol) filter (where not r.ok) as unparsable_rows,
         count(r.symbol) filter (where r.ok and r.date_key between pp.k_first and pp.k_last and (r.ot < r.key_start_ms or r.ot >= r.key_start_ms + 86400000)) as rows_outside_day
  from syms y cross join pp left join parsed r on r.symbol = y.symbol
  group by y.symbol
),
-- merge_dropped = the bars (openTimes) mergeSides leaves out: a BID bar with no ASK bar or with an ask below its bid, and an ASK bar with no BID bar;
-- closure_dropped = the merged bars usableBars leaves out (the market was shut for the whole bar); dup_ots = openTimes present more than once on one side
gmerge as (
  select y.symbol,
         (select count(*) from (select distinct b.symbol, b.ot from bid b where b.symbol = y.symbol) q) - (select count(*) from mg where mg.symbol = y.symbol)
           + (select count(*) from ask a where a.symbol = y.symbol and not exists (select 1 from bid b where b.symbol = a.symbol and b.ot = a.ot)) as merge_dropped,
         (select count(*) from mg where mg.symbol = y.symbol) - (select count(*) from us where us.symbol = y.symbol) as closure_dropped,
         (select count(*) from (select 1 from parsed pr where pr.symbol = y.symbol and pr.ok group by pr.price_type, pr.ot having count(*) > 1) q) as dup_ots
  from syms y
),
-- the guard row of each pair: status says whether the recount could be made at all
gd as (
  select y.symbol,
         case when gf.files_bid = 0 or gf.files_ask = 0 then 'NO_DATA'
              when ss.day_bars = 0 then 'NO_DATA'
              when not pp.range_ok then 'BAD_RANGE'
              else 'ok' end as status,
         case when gf.files_bid = 0 or gf.files_ask = 0 then 'no BID/ASK 15min file for key ' || pp.k_first || '..' || pp.k_last || ' in public.gmo_kline_files (a day not over yet, not stored yet, or no trading): nothing was recounted'
              when ss.day_bars = 0 then 'files found but 0 bars in the range (a Saturday key, a holiday): nothing to recount'
              when not pp.range_ok then 'the range is not one whole GMO day (24 h from 21:00 UTC): check START_MS / END_MS'
              else null end as why,
         concat_ws('; ',
           case when gf.files_bid <> gf.files_ask or gf.bars_bid <> gf.bars_ask then 'bid_ask_files_or_bars_differ' end,
           case when gf.early_key_files > 0 then 'key_file_answered_before_day_end(cut copy?)=' || gf.early_key_files end,
           case when coalesce(gm.n, 0) > 0 then 'history_files_missing=' || gm.n end,
           case when gr.unparsable_rows > 0 then 'unparsable_rows=' || gr.unparsable_rows end,
           case when gx.merge_dropped > 0 then 'merge_dropped=' || gx.merge_dropped end,
           case when gx.closure_dropped > 0 then 'closure_dropped=' || gx.closure_dropped end,
           case when gr.rows_outside_day > 0 then 'rows_outside_key_day(day roll moved?)=' || gr.rows_outside_day end,
           case when gx.dup_ots > 0 then 'duplicate_bars=' || gx.dup_ots end,
           case when ss.day_bars > 0 and ss.first_day_rank < 600 then 'history_shorter_than_600_before_day' end,
           case when coalesce(sb.n, 0) = 0 then 'no_subscription_row' end,
           case when coalesce(ot.n, 0) > 0 then 'other_macdx_1h_rule_rows=' || ot.n end) as warn,
         json_build_object(
           'files_bid', gf.files_bid, 'files_ask', gf.files_ask, 'bars_in_files_bid', gf.bars_bid, 'bars_in_files_ask', gf.bars_ask,
           'files_loaded', gf.files_loaded, 'files_expected', (select count(*) * 2 from dates), 'missing_files', gm.keys,
           'early_key_files', gf.early_key_files, 'early_files_all', gf.early_files_all,
           'bars_before_day', ss.first_day_rank - 1, 'history_ok', coalesce(ss.first_day_rank >= 600, false),
           'unparsable_rows', gr.unparsable_rows, 'rows_outside_day', gr.rows_outside_day,
           'merge_dropped', gx.merge_dropped, 'closure_dropped', gx.closure_dropped, 'duplicate_bars', gx.dup_ots,
           'subscriptions', coalesce(sb.n, 0), 'other_macdx_1h_rows', coalesce(ot.n, 0)) as guard
  from syms y cross join pp
  join gfile gf on gf.symbol = y.symbol
  join grow gr on gr.symbol = y.symbol
  join gmerge gx on gx.symbol = y.symbol
  join sstat ss on ss.symbol = y.symbol
  left join gmiss gm on gm.symbol = y.symbol
  left join subs sb on sb.pair = y.pair
  left join othr ot on ot.pair = y.pair
),
-- reasons beyond the weekend window / go-live / subscription that make a fire unmailable: none for the pairs
extra_reasons as (select null::text as pair, null::bigint as ot, null::text as reason where false),
-- cut = the day's last bar is not the last 15-minute bar of the GMO day (it opened at END_MS minus 15 min = 900000 ms): a cut file, or a day that ends early (a holiday). The
-- pairs' 15-minute day files hold the Friday 20:45 bar although its close (Friday 21:00) is in the weekend window and production never judges it, so the v3 test with the
-- 15-minute step is right for the pairs.
dayend as (
  select y.symbol, (ss.day_bars > 0 and ss.last_day_ot <> pp.end_ms - 900000) as cut
  from syms y cross join pp join sstat ss on ss.symbol = y.symbol
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
         json_build_object('sql', 'pairs.sql v12', 'rule', 'macdx_12_26_9_w600_15min_fade96of120_in_v12', 'keys', pp.k_first || '..' || pp.k_last,
           'range_utc', to_char(to_timestamp(pp.start_ms / 1000.0) at time zone 'UTC', 'YYYY-MM-DD HH24:MI') || ' .. ' || to_char(to_timestamp(pp.end_ms / 1000.0) at time zone 'UTC', 'YYYY-MM-DD HH24:MI'),
           'range_is_one_gmo_day', pp.range_ok, 'db_now_utc', to_char(now() at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
           'go_live_utc', (select to_char(to_timestamp(min(live_ms) / 1000.0) at time zone 'UTC', 'YYYY-MM-DD HH24:MI') from syms),
           'end_1h_utc', (select to_char(to_timestamp(max(end_1h_ms) / 1000.0) at time zone 'UTC', 'YYYY-MM-DD HH24:MI') from syms), 'macdx_15min_rows_other_pairs', (select count(*) from public.signal_alerts a where a.kind = 'signal' and a.interval = '15min' and a.rule like 'macdx%' and a.pair not in (select pair from syms) and a.bar_time >= to_timestamp(pp.start_ms / 1000.0) and a.bar_time < to_timestamp(pp.end_ms / 1000.0)),
           'lines', (select count(*) from verdicts), 'elapsed_s', round(extract(epoch from clock_timestamp() - statement_timestamp())::numeric, 2),
           -- the md5 and length of the statement text AS THE DATABASE RECEIVED IT (the tool appends a comment after a blank line: cut off). The caller compares it with the md5 of the text it meant to send,
           -- so that a slip made while copying the 20 kB text into the tool call shows (a mismatch means: send again from the file; the numbers of this answer are then not to be trusted)
           'sql_md5', md5(split_part(current_query(), E'\n\n-- source: POST /mcp', 1)), 'sql_chars', length(split_part(current_query(), E'\n\n-- source: POST /mcp', 1)))
  from pp
)
select row_type, instrument, bar_open_utc, side, verdict, data from u order by o1, o2, o3
