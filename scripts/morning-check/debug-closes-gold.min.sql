with recursive
p as (select {{START_MS}}::bigint as start_ms, {{END_MS}}::bigint as end_ms),
pp as (
select start_ms, end_ms,
to_char(to_timestamp((start_ms + 10800000) / 1000.0) at time zone 'UTC', 'YYYYMMDD') as k_first,
to_char(to_timestamp((end_ms - 1 + 10800000) / 1000.0) at time zone 'UTC', 'YYYYMMDD') as k_last,
to_char((to_timestamp((start_ms + 10800000) / 1000.0) at time zone 'UTC')::date - 40, 'YYYYMMDD') as from_key,
(end_ms - start_ms = 86400000 and start_ms % 86400000 = 75600000) as range_ok
from p
),
syms as (select 'XAU_USD'::text as symbol, 'XAU/USD'::text as pair, 1 as ord, 1791867600000::bigint as live_ms, 2 as d),
grow0 as (
select f.bars, f.fetched_at, floor(extract(epoch from f.fetched_at) * 1000)::bigint as fetched_ms
from public.live_chart_fallback f where f.pair = 'XAU/USD' and f.interval = '1h'
),
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
us as (
select y.symbol, b.ot, b.pos as seq, b.cl as m8, y.d
from bgold2 b cross join syms y
where b.ok and b.ot + 3600000 <= b.fetched_ms and b.cl > 0
),
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
s as (select symbol, ot, d, row_number() over (partition by symbol order by seq) as rn, cn, cn::float8 as c, bad from r),
w as (select symbol, rn as jr, ot from s where rn >= 600 and ot >= (select start_ms from pp) and ot < (select end_ms from pp)),
closes as (select symbol, array_agg(c order by rn) as arr from s group by symbol),
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
fin as materialized (
select symbol, ot, jr, m, sg, (m - sg) as h, side_p, side, sabs / 599 as scale, 0.8::float8 * (sabs / 599) as lvl, c as clo,
(side_p is not null and side is not null and side_p <> side) as cross_
from rec where t = 599
),
need as (select symbol, greatest(1, min(jr) - 599) as r_from, max(jr) as r_to from w group by symbol),
sel as (
select s.symbol, s.d, s.rn, s.ot, s.cn, (s.rn - n.r_from) / 250 as chunk
from s join need n on n.symbol = s.symbol and s.rn between n.r_from and n.r_to
),
ch as (
select symbol, d, chunk, count(*) as n_bars, min(rn) as first_rank, min(ot) as first_ot, max(ot) as last_ot,
string_agg(ot::text || ':' || round(cn, d)::text, ';' order by rn) as closes
from sel group by symbol, d, chunk
)
select ch.symbol, ch.d as decimals, ch.chunk, (select max(c2.chunk) + 1 from ch c2 where c2.symbol = ch.symbol) as chunks, ch.n_bars, ch.first_rank,
to_char(to_timestamp(ch.first_ot / 1000.0) at time zone 'UTC', 'YYYY-MM-DD HH24:MI') as first_open_utc,
to_char(to_timestamp(ch.last_ot / 1000.0) at time zone 'UTC', 'YYYY-MM-DD HH24:MI') as last_open_utc,
(select to_char(fetched_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS') from grow0) as row_read_utc,
md5(ch.closes) as md5, case when {{CHUNK}} < 0 then null else ch.closes end as closes
from ch
where {{CHUNK}} < 0 or ch.chunk = {{CHUNK}}
order by ch.symbol, ch.chunk
