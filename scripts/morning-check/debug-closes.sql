-- debug-closes.sql  (task #352)  -  the rounded closes of the five pairs that pairs.sql used, as compact strings, for Deno / Python replays.
-- ONE read-only statement. Markers to replace: {{START_MS}} {{END_MS}} (the day's range, as in pairs.sql), {{SYMBOL}} (USD_JPY | EUR_JPY | AUD_JPY | EUR_USD | AUD_USD | *)
-- and {{CHUNK}} (-1 = the list of pieces with their md5 and no strings; 0, 1, 2 ... = one piece of about 250 bars). The chain before the last CTE is the very text of pairs.sql.
-- A piece is "open_ms:close;open_ms:close;..." (close with its decimals, e.g. 158.612); take the pieces of a symbol in chunk order and join them.
with recursive
-- The ONLY two inputs: bar OPEN time in [START_MS, END_MS), epoch milliseconds (the Routine writes the numbers in place of the two markers).
p as (select {{START_MS}}::bigint as start_ms, {{END_MS}}::bigint as end_ms),
-- GMO's day starts at 21:00 UTC (06:00 JST), so START_MS + 3 h falls on the key's date. k_first / k_last = the keys of the first and the last instant of the range;
-- from_key = 40 days before (production's own reach back); range_ok = the range is one whole GMO day (24 h, starting at 21:00 UTC).
pp as (
  select start_ms, end_ms,
         to_char(to_timestamp((start_ms + 10800000) / 1000.0) at time zone 'UTC', 'YYYYMMDD') as k_first,
         to_char(to_timestamp((end_ms - 1 + 10800000) / 1000.0) at time zone 'UTC', 'YYYYMMDD') as k_last,
         to_char((to_timestamp((start_ms + 10800000) / 1000.0) at time zone 'UTC')::date - 40, 'YYYYMMDD') as from_key,
         (end_ms - start_ms = 86400000 and start_ms % 86400000 = 75600000) as range_ok
  from p
),
-- ===== FRONT (five pairs): public.gmo_kline_files -> us(symbol, ot, seq, m8, d), the series production judges on =====
-- instrument table: GMO symbol, the app's pair name, display order, the instant from which the rule (signal-alerts v26) was live, and the decimals
-- of the chart's rounding (decimalsOf: 3 for a ...JPY pair, 5 for the others):
-- 1791820800000 = 2026-10-12 16:00 UTC, the first judged bar opened then (bars opened before it were judged by v25's other rule: no mails possible).
syms as (
  select * from (values
    ('USD_JPY', 'USD/JPY', 1, 1791820800000::bigint, 3), ('EUR_JPY', 'EUR/JPY', 2, 1791820800000::bigint, 3), ('AUD_JPY', 'AUD/JPY', 3, 1791820800000::bigint, 3),
    ('EUR_USD', 'EUR/USD', 4, 1791820800000::bigint, 5), ('AUD_USD', 'AUD/USD', 5, 1791820800000::bigint, 5)
  ) v(symbol, pair, ord, live_ms, d)
),
-- the day files of the 40 days up to the last key (1-hour files, BID and ASK)
files as (
  select f.symbol, f.price_type, f.date_key, f.body,
         case when jsonb_typeof(f.body -> 'data') = 'array' then jsonb_array_length(f.body -> 'data') else 0 end as nbars,
         case when f.body ->> 'responsetime' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z$' then (f.body ->> 'responsetime')::timestamptz end as resp,
         (extract(epoch from to_date(f.date_key, 'YYYYMMDD'))::bigint - 10800) * 1000 as key_start_ms
  from public.gmo_kline_files f, pp
  where f.interval = '1hour' and f.price_type in ('BID', 'ASK') and f.symbol in (select symbol from syms)
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
bid as (select symbol, date_key, pos, ot, cl as bc from parsed where price_type = 'BID' and ok),
ask as (select distinct on (symbol, ot) symbol, ot, cl as ac from parsed where price_type = 'ASK' and ok order by symbol, ot, date_key desc, pos desc),
mg0 as (
  select distinct on (b.symbol, b.ot) b.symbol, b.ot, b.date_key, b.pos, (b.bc + a.ac) / 2 as m8
  from bid b join ask a on a.symbol = b.symbol and a.ot = b.ot
  where not (a.ac < b.bc)
  order by b.symbol, b.ot, b.date_key, b.pos
),
-- the merged list keeps the BID arrival order (never sorted again by production): seq = the place of the emitted BID row in that order
mg as (select *, row_number() over (partition by symbol order by date_key, ot, pos) as seq from mg0),
-- usableBars: drop a bar the market was shut for the whole of (barInsideClosure = isMarketClosed(open) and isMarketClosed(open + 1 h - 1 ms);
-- isMarketClosed = Saturday, Friday from 22:00, Sunday before 21:00, UTC)
mc as (
  select symbol, ot, seq, m8,
         extract(dow from to_timestamp(ot / 1000.0) at time zone 'UTC') as dw0, extract(hour from to_timestamp(ot / 1000.0) at time zone 'UTC') as hr0,
         extract(dow from to_timestamp((ot + 3599999) / 1000.0) at time zone 'UTC') as dw1, extract(hour from to_timestamp((ot + 3599999) / 1000.0) at time zone 'UTC') as hr1
  from mg
),
us as (
  select m.symbol, m.ot, m.seq, m.m8, y.d
  from mc m join syms y on y.symbol = m.symbol
  where not ((m.dw0 = 6 or (m.dw0 = 5 and m.hr0 >= 22) or (m.dw0 = 0 and m.hr0 < 21)) and (m.dw1 = 6 or (m.dw1 = 5 and m.hr1 >= 22) or (m.dw1 = 0 and m.hr1 < 21)))
),
-- ===== ENGINE (the same text in pairs.sql and gold.sql): rounded closes -> ranks -> MACD / usual move / cross / fire =====
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
--    same order of double operations as the TypeScript. t = index inside the window (0..599; the close at t has rank jr - 599 + t); acc = running seed sums;
--    side = sign of h (0 keeps the side).
rec(symbol, jr, ot, t, c, acc12, e12, acc26, e26, m, acc9, sg, side, side_p, sabs) as (
  select w.symbol, w.jr, w.ot, 0, cl.arr[w.jr - 599], cl.arr[w.jr - 599], null::float8, cl.arr[w.jr - 599], null::float8, null::float8, null::float8, null::float8, null::int, null::int, 0::float8
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
         case when r.t + 1 < 33 then null when (y.nm - z.nsg) > 0 then 1 when (y.nm - z.nsg) < 0 then -1 else r.side end,
         r.side,
         r.sabs + abs(sn.c - r.c)
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
-- 5. The decision at the last bar of each window (decideScaledOnWindow): usual move = mean |close step| over the 599 steps added in order,
--    level = 0.8 x usual move (not rounded); cross = the side changed from the bar before; SELL needs macd >= level, BUY needs macd <= -level (equality fires).
--    clo = the judged bar's own (rounded) close, the last of its 600: the mail's `entry` must be this.
fin as materialized (
  select symbol, ot, jr, m, sg, (m - sg) as h, side_p, side, sabs / 599 as scale, 0.8::float8 * (sabs / 599) as lvl, c as clo,
         (side_p is not null and side is not null and side_p <> side) as cross_
  from rec where t = 599
),
-- ===== TAIL of debug-closes.sql (pairs): the rounded closes the recount used, as compact strings =====
-- Parameters besides the day's range: {{SYMBOL}} = 'USD_JPY' | 'EUR_JPY' | 'AUD_JPY' | 'EUR_USD' | 'AUD_USD' | '*' (all), {{CHUNK}} = 0, 1, 2 ... (one piece of about 250 bars)
-- or -1 (the list of pieces with their md5, no strings).
-- For each symbol the series needed to recount the day: from 599 bars before the day's first judged bar to the day's last bar, in pieces of 250 bars.
-- A piece is "open_ms:close;open_ms:close;..." with the close already rounded as the app rounds it (JS Number(m.toFixed(d))), written with d decimals.
need as (select symbol, greatest(1, min(jr) - 599) as r_from, max(jr) as r_to from w group by symbol),
sel as (
  select s.symbol, s.d, s.rn, s.ot, s.cn, (s.rn - n.r_from) / 250 as chunk
  from s join need n on n.symbol = s.symbol and s.rn between n.r_from and n.r_to
  where '{{SYMBOL}}' in ('*', s.symbol)
),
ch as (
  select symbol, d, chunk, count(*) as n_bars, min(rn) as first_rank, min(ot) as first_ot, max(ot) as last_ot,
         string_agg(ot::text || ':' || round(cn, d)::text, ';' order by rn) as closes
  from sel group by symbol, d, chunk
)
select ch.symbol, ch.d as decimals, ch.chunk, (select max(c2.chunk) + 1 from ch c2 where c2.symbol = ch.symbol) as chunks, ch.n_bars, ch.first_rank,
       to_char(to_timestamp(ch.first_ot / 1000.0) at time zone 'UTC', 'YYYY-MM-DD HH24:MI') as first_open_utc,
       to_char(to_timestamp(ch.last_ot / 1000.0) at time zone 'UTC', 'YYYY-MM-DD HH24:MI') as last_open_utc,
       md5(ch.closes) as md5, case when {{CHUNK}} < 0 then null else ch.closes end as closes
from ch
where {{CHUNK}} < 0 or ch.chunk = {{CHUNK}}
order by ch.symbol, ch.chunk
