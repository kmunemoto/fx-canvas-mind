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
syms as (
select * from (values
('USD_JPY', 'USD/JPY', 1, 1794466800000::bigint, 3), ('EUR_JPY', 'EUR/JPY', 2, 1794466800000::bigint, 3), ('AUD_JPY', 'AUD/JPY', 3, 1794466800000::bigint, 3),
('EUR_USD', 'EUR/USD', 4, 1794466800000::bigint, 5), ('AUD_USD', 'AUD/USD', 5, 1794466800000::bigint, 5)
) v(symbol, pair, ord, live_ms, d)
),
files as (
select f.symbol, f.price_type, f.date_key, f.body,
case when jsonb_typeof(f.body -> 'data') = 'array' then jsonb_array_length(f.body -> 'data') else 0 end as nbars,
case when f.body ->> 'responsetime' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z$' then (f.body ->> 'responsetime')::timestamptz end as resp,
(extract(epoch from to_date(f.date_key, 'YYYYMMDD'))::bigint - 10800) * 1000 as key_start_ms
from public.gmo_kline_files f, pp
where f.interval = '1hour' and f.price_type in ('BID', 'ASK') and f.symbol in (select symbol from syms)
and f.date_key between pp.from_key and pp.k_last
),
rows_ as (
select f.symbol, f.price_type, f.date_key, f.key_start_ms, e.pos, e.x ->> 'openTime' as ot_s, e.x ->> 'open' as o_s, e.x ->> 'high' as h_s, e.x ->> 'low' as l_s, e.x ->> 'close' as c_s
from files f
cross join lateral jsonb_array_elements(case when jsonb_typeof(f.body -> 'data') = 'array' then f.body -> 'data' else '[]'::jsonb end) with ordinality as e(x, pos)
),
rows2 as (
select *, coalesce(ot_s ~ '^[0-9]{1,15}$' and o_s ~ '^[0-9]+(\.[0-9]+)?$' and h_s ~ '^[0-9]+(\.[0-9]+)?$' and l_s ~ '^[0-9]+(\.[0-9]+)?$' and c_s ~ '^[0-9]+(\.[0-9]+)?$', false) as ok from rows_
),
parsed as (
select symbol, price_type, date_key, key_start_ms, pos, ok,
case when ok then ot_s::bigint end as ot, case when ok then c_s::float8 end as cl,
case when ok then h_s::float8 end as hi, case when ok then l_s::float8 end as lo
from rows2
),
bid as (select symbol, date_key, pos, ot, cl as bc, hi as bh, lo as bl from parsed where price_type = 'BID' and ok),
ask as (select distinct on (symbol, ot) symbol, ot, cl as ac, hi as ah, lo as al from parsed where price_type = 'ASK' and ok order by symbol, ot, date_key desc, pos desc),
mg0 as (
select distinct on (b.symbol, b.ot) b.symbol, b.ot, b.date_key, b.pos, (b.bc + a.ac) / 2 as m8,
(b.bh + a.ah) / 2 as h8, (b.bl + a.al) / 2 as l8, b.bc, a.ac
from bid b join ask a on a.symbol = b.symbol and a.ot = b.ot
where not (a.ac < b.bc)
order by b.symbol, b.ot, b.date_key, b.pos
),
mg as (select *, row_number() over (partition by symbol order by date_key, ot, pos) as seq from mg0),
mc as (
select symbol, ot, seq, m8, h8, l8, bc, ac,
extract(dow from to_timestamp(ot / 1000.0) at time zone 'UTC') as dw0, extract(hour from to_timestamp(ot / 1000.0) at time zone 'UTC') as hr0,
extract(dow from to_timestamp((ot + 3599999) / 1000.0) at time zone 'UTC') as dw1, extract(hour from to_timestamp((ot + 3599999) / 1000.0) at time zone 'UTC') as hr1
from mg
),
us as (
select m.symbol, m.ot, m.seq, m.m8, y.d, m.h8, m.l8, m.bc, m.ac
from mc m join syms y on y.symbol = m.symbol
where not ((m.dw0 = 6 or (m.dw0 = 5 and m.hr0 >= 22) or (m.dw0 = 0 and m.hr0 < 21)) and (m.dw1 = 6 or (m.dw1 = 5 and m.hr1 >= 22) or (m.dw1 = 0 and m.hr1 < 21)))
),
hsrc as (select symbol, ot, 'gmo'::text as src, h8, l8, d from us where ot >= (select start_ms from pp) and ot < (select end_ms from pp)),
paid as (select symbol, ot, ac as paid_buy, bc as paid_sell from us where ot >= (select start_ms from pp) and ot < (select end_ms from pp)),
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
fin as materialized (
select symbol, ot, jr, m, sg, (m - sg) as h, ta as tn, tb as bn, tp, bp, mp, c as clo, e12_p, e26_p, sg_p, ta_p, tb_p
from rec where t = 599
),
fz as (
select f.symbol, f.ot, f.jr, y.pair, y.d, f.m, f.sg, f.h, f.tn, f.bn, f.clo, f.e12_p, f.e26_p, f.sg_p, f.ta_p, f.tb_p,
b.in_top, b.in_bot, b.p_top, b.p_bot,
case when b.in_top and not b.p_top then 'BUY' when b.in_bot and not b.p_bot then 'SELL' end as sd,
case when b.in_top and not b.p_top then b.at_top when b.in_bot and not b.p_bot then b.at_bot end as already,
case when b.in_top and not b.p_top then case when b.at_top then 'BUY@' else 'BUY' end
when b.in_bot and not b.p_bot then case when b.at_bot then 'SELL@' else 'SELL' end end as cls
from fin f join syms y on y.symbol = f.symbol
cross join lateral (select (f.tn > 0 and f.m >= 0.9::float8 * f.tn) as in_top, (f.bn < 0 and f.m <= 0.9::float8 * f.bn) as in_bot,
(f.tp > 0 and f.mp >= 0.9::float8 * f.tp) as p_top, (f.bp < 0 and f.mp <= 0.9::float8 * f.bp) as p_bot,
(f.tn > 0 and f.m >= 0.96::float8 * f.tn) as at_top, (f.bn < 0 and f.m <= 0.96::float8 * f.bn) as at_bot) b
),
ne as (
select f.symbol, f.jr, bool_or(coalesce(x.cls, '') <> coalesce(f.cls, '')) as near_edge
from fz f
join s on s.symbol = f.symbol and s.rn = f.jr
cross join (values (-2), (2)) q(k)
cross join lateral (select (s.cn + q.k / (10::float8 ^ s.d)::numeric)::float8 as c2) c
cross join lateral (select (2.0::float8 / 13.0::float8) * c.c2 + (1 - (2.0::float8 / 13.0::float8)) * f.e12_p as ne12,
(2.0::float8 / 27.0::float8) * c.c2 + (1 - (2.0::float8 / 27.0::float8)) * f.e26_p as ne26) a
cross join lateral (select a.ne12 - a.ne26 as nm) b
cross join lateral (select (2.0::float8 / 10.0::float8) * b.nm + (1 - (2.0::float8 / 10.0::float8)) * f.sg_p as nsg) z
cross join lateral (select greatest(f.ta_p, b.nm, z.nsg, b.nm - z.nsg) as t2, least(f.tb_p, b.nm, z.nsg, b.nm - z.nsg) as b2) e
cross join lateral (select case when e.t2 > 0 and b.nm >= 0.9::float8 * e.t2 and not f.p_top then case when b.nm >= 0.96::float8 * e.t2 then 'BUY@' else 'BUY' end
when e.b2 < 0 and b.nm <= 0.9::float8 * e.b2 and not f.p_bot then case when b.nm <= 0.96::float8 * e.b2 then 'SELL@' else 'SELL' end end as cls) x
group by f.symbol, f.jr
),
fx2 as (
select f.*, n.near_edge, 0.9::float8 * f.tn as mk_top, 0.9::float8 * f.bn as mk_bot, 0.96::float8 * f.tn as out_top, 0.96::float8 * f.bn as out_bot, power(10::float8, -f.d) as tick
from fz f join ne n on n.symbol = f.symbol and n.jr = f.jr
),
hv as (
select u.symbol, u.ot, u.src, u.d, q.w, case q.w when 'h' then u.h8 else u.l8 end as v8
from hsrc u cross join (values ('h'), ('l')) q(w)
),
hk as (select symbol, ot, src, d, w, v8, case when v8 > 0 then floor(ln(v8) / ln(2::float8))::int else 0 end as k0 from hv where v8 is not null),
hk1 as (
select symbol, ot, src, d, w, v8, case when v8 >= power(2::float8, k0 + 1) then k0 + 1 when v8 < power(2::float8, k0) then k0 - 1 else k0 end as k
from hk
),
hfx as (select symbol, ot, src, d, w, k, (least(v8, 1e15::float8) * power(2::float8, 52 - k))::bigint as mant from hk1),
hr0 as (select symbol, ot, src, d, w, k, mant, (10::float8 ^ d)::numeric as p10, (1::bigint << least(greatest(52 - k, 0), 62))::numeric as den from hfx),
hl as (
select symbol, ot, src, d, w,
(div(mant::numeric * p10, den) + case when 2 * mod(mant::numeric * p10, den) >= den then 1 else 0 end) / p10 as vn,
(mant < 4503599627370496 or mant >= 9007199254740992 or 52 - k < 0 or 52 - k > 62) as bad
from hr0
),
tq as (
select f.symbol, f.ot, f.jr, h.src, z.zside, q.k, h.vn, x.xv, e.nm, e.edge,
case z.zside when 'top' then e.edge > 0 and e.nm >= 0.96::float8 * e.edge else e.edge < 0 and e.nm <= 0.96::float8 * e.edge end as touch
from fz f
cross join (values ('top', 'h'), ('bottom', 'l')) z(zside, w)
join hl h on h.symbol = f.symbol and h.ot = f.ot and h.w = z.w
cross join (values (-2), (0), (2)) q(k)
cross join lateral (select (h.vn + q.k / (10::float8 ^ h.d)::numeric)::float8 as xv) x
cross join lateral (select (2.0::float8 / 13.0::float8) * x.xv + (1 - (2.0::float8 / 13.0::float8)) * f.e12_p as ne12,
(2.0::float8 / 27.0::float8) * x.xv + (1 - (2.0::float8 / 27.0::float8)) * f.e26_p as ne26) a
cross join lateral (select a.ne12 - a.ne26 as nm) b
cross join lateral (select (2.0::float8 / 10.0::float8) * b.nm + (1 - (2.0::float8 / 10.0::float8)) * f.sg_p as nsg) g
cross join lateral (select b.nm as nm, case z.zside when 'top' then greatest(f.ta_p, b.nm, g.nsg, b.nm - g.nsg) else least(f.tb_p, b.nm, g.nsg, b.nm - g.nsg) end as edge) e
),
ts as (
select symbol, ot, jr, src, zside, bool_or(touch) filter (where k = 0) as touch, (bool_or(touch) filter (where k = -2)) <> (bool_or(touch) filter (where k = 2)) as near,
max(xv) filter (where k = 0) as x, max(nm) filter (where k = 0) as m, max(edge) filter (where k = 0) as edge
from tq group by symbol, ot, jr, src, zside
),
tb as (
select t.symbol, t.ot, t.jr, t.zside, bool_or(t.touch) as touch, bool_or(t.near) as near,
string_agg(t.src, ',' order by t.src) filter (where t.touch) as srcs, string_agg(t.src, ',' order by t.src) as srcs_all,
(array_agg(t.x order by t.touch desc, t.src))[1] as x, (array_agg(t.m order by t.touch desc, t.src))[1] as m, (array_agg(t.edge order by t.touch desc, t.src))[1] as edge
from ts t group by t.symbol, t.ot, t.jr, t.zside
),
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
subs as (select pair, count(*) as n from public.signal_alert_subscriptions where interval = '1h' and rule = 'macdx' group by pair),
othr as (
select a.pair, count(*) as n
from public.signal_alerts a, pp
where a.kind = 'signal' and a.interval = '1h' and a.rule like 'macdx%'
and a.rule not in ('macdx_12_26_9_w600_1h_ride90to96of120_in_v9', 'macdx_12_26_9_w600_1h_ride90to96of120_at_v9', 'macdx_12_26_9_w600_1h_ride90to96of120_out_v9')
and a.pair in (select pair from syms)
and a.bar_time >= to_timestamp(pp.start_ms / 1000.0) and a.bar_time < to_timestamp(pp.end_ms / 1000.0)
group by a.pair
),
rd as (
select r.pair, r.side, (extract(epoch from r.entry_bar) * 1000)::bigint as eot, r.status, (extract(epoch from r.reached_bar) * 1000)::bigint as rot,
r.reached_at, r.entry_closed_at, r.created_at, r.late, r.entry_price, r.entry_mid, r.seen_price, r.share0, r.share1
from public.macd_rides r, pp
where r.pair in (select pair from syms) and r.entry_bar < to_timestamp(pp.end_ms / 1000.0)
and (r.status = 'open' or r.entry_bar >= to_timestamp(pp.start_ms / 1000.0) or r.reached_bar >= to_timestamp(pp.start_ms / 1000.0)
or r.reached_at >= to_timestamp(pp.start_ms / 1000.0))
),
st as (
select t.pair, (extract(epoch from t.bar_time) * 1000)::bigint as ot, t.e12, t.e26, t.sig, t.top119, t.bottom119
from public.macd_ride_state t, pp
where t.pair in (select pair from syms) and t.bar_time >= to_timestamp(pp.start_ms / 1000.0) and t.bar_time < to_timestamp(pp.end_ms / 1000.0)
),
stc as (
select y.symbol, count(t.ot) as state_rows, count(f.ot) as state_checked,
count(f.ot) filter (where t.e12 = f.e12_p and t.e26 = f.e26_p and t.sig = f.sg_p and t.top119 = f.ta_p and t.bottom119 = f.tb_p) as state_equal,
max(greatest(abs(t.e12 - f.e12_p), abs(t.e26 - f.e26_p), abs(t.sig - f.sg_p), abs(t.top119 - f.ta_p), abs(t.bottom119 - f.tb_p)) / power(10::float8, -y.d)) as state_max_diff_ticks
from syms y left join st t on t.pair = y.pair left join fz f on f.symbol = y.symbol and f.ot = t.ot
group by y.symbol
),
ev as (
select f.symbol, f.pair, f.ot, f.sd as side, f.already, w.by_eot,
case when f.already then case when w.by_eot is not null then 'quiet' else 'at' end else case when w.by_eot is not null then 'skip' else 'in' end end as step
from fx2 f
cross join lateral (select min(r.eot) as by_eot from rd r
where r.pair = f.pair and r.side = f.sd
and case when f.already then r.status = 'reached' and r.rot = f.ot else r.eot < f.ot and (r.status = 'open' or r.rot > f.ot) end) w
where f.sd is not null
),
wstat as (
select y.symbol, count(f.ot) as windows, count(f.ot) filter (where f.in_top or f.in_bot) as band_bars, count(f.ot) filter (where f.sd is not null) as entries,
(select count(*) from ev e where e.symbol = y.symbol and e.step = 'in') as exp_in, (select count(*) from ev e where e.symbol = y.symbol and e.step = 'at') as exp_at,
(select count(*) from ev e where e.symbol = y.symbol and e.step = 'skip') as exp_skip, (select count(*) from ev e where e.symbol = y.symbol and e.step = 'quiet') as exp_quiet
from syms y left join fx2 f on f.symbol = y.symbol
group by y.symbol
),
mails as (
select a.pair, a.side, case a.rule when 'macdx_12_26_9_w600_1h_ride90to96of120_in_v9' then 'in' else 'at' end as kind, (extract(epoch from a.bar_time) * 1000)::bigint as ot,
count(*) as n_rows, count(*) filter (where a.status = 'sent') as n_sent, string_agg(distinct a.status, ',') as statuses,
min(extract(epoch from (a.sent_at - a.closed_at))) as lag_min, max(extract(epoch from (a.sent_at - a.closed_at))) as lag_max,
min(a.entry) as entry, max(a.entry) as entry_max
from public.signal_alerts a, pp
where a.kind = 'signal' and a.interval = '1h'
and a.rule in ('macdx_12_26_9_w600_1h_ride90to96of120_in_v9', 'macdx_12_26_9_w600_1h_ride90to96of120_at_v9')
and a.pair in (select pair from syms)
and a.bar_time >= to_timestamp(pp.start_ms / 1000.0) and a.bar_time < to_timestamp(pp.end_ms / 1000.0)
group by a.pair, a.side, a.rule, a.bar_time
),
rx as (
select r.*, y.symbol, t.xot,
(r.rot is not null and r.rot >= pp.start_ms and r.rot < pp.end_ms) as in_range,
(r.rot is not null and r.rot < pp.start_ms and r.reached_at >= to_timestamp(pp.start_ms / 1000.0) and r.reached_at < to_timestamp(pp.end_ms / 1000.0)) as seen_late_in_range
from rd r join syms y on y.pair = r.pair cross join pp
cross join lateral (select min(b.ot) as xot from tb b
where b.symbol = y.symbol and b.zside = case r.side when 'BUY' then 'top' else 'bottom' end and b.touch and b.ot > r.eot) t
),
ro as (
select x.*, case when x.in_range or x.seen_late_in_range then x.rot else x.xot end as lot
from rx x
where x.in_range or x.seen_late_in_range or (x.xot is not null and (x.status = 'open' or x.rot >= (select end_ms from pp)))
),
mo as (
select a.pair, a.side, (extract(epoch from a.bar_time) * 1000)::bigint as eot,
count(*) as n_rows, count(*) filter (where a.status = 'sent') as n_sent, string_agg(distinct a.status, ',') as statuses,
min(extract(epoch from (a.sent_at - a.closed_at))) as lag_min, max(extract(epoch from (a.sent_at - a.closed_at))) as lag_max,
min(a.entry) as entry, max(a.entry) as entry_max, min(a.closed_at) as seen_min, max(a.closed_at) as seen_max
from public.signal_alerts a, pp
where a.kind = 'signal' and a.interval = '1h' and a.rule = 'macdx_12_26_9_w600_1h_ride90to96of120_out_v9'
and a.pair in (select pair from syms)
and ((a.closed_at >= to_timestamp(pp.start_ms / 1000.0) and a.closed_at < to_timestamp(pp.end_ms / 1000.0))
or exists (select 1 from ro o where o.pair = a.pair and o.side = a.side and to_timestamp(o.eot / 1000.0) = a.bar_time))
group by a.pair, a.side, a.bar_time
),
dates as (
select to_char(d, 'YYYYMMDD') as dk
from pp, generate_series(to_date(pp.from_key, 'YYYYMMDD')::timestamp, to_date(pp.k_last, 'YYYYMMDD')::timestamp, interval '1 day') d
where extract(dow from d) <> 0
),
gmiss as (
select q.symbol, count(*) as n,
string_agg(q.dk || '/' || q.t, ' ' order by q.dk, q.t) filter (where q.r <= 6) || case when count(*) > 6 then ' ... (+' || (count(*) - 6) || ' more)' else '' end as keys
from (
select y.symbol, dt.dk, pt.t, row_number() over (partition by y.symbol order by dt.dk, pt.t) as r
from syms y cross join dates dt cross join (values ('BID'), ('ASK')) pt(t)
where not exists (select 1 from files f where f.symbol = y.symbol and f.date_key = dt.dk and f.price_type = pt.t)
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
gmerge as (
select y.symbol,
(select count(*) from (select distinct b.symbol, b.ot from bid b where b.symbol = y.symbol) q) - (select count(*) from mg where mg.symbol = y.symbol)
+ (select count(*) from ask a where a.symbol = y.symbol and not exists (select 1 from bid b where b.symbol = a.symbol and b.ot = a.ot)) as merge_dropped,
(select count(*) from mg where mg.symbol = y.symbol) - (select count(*) from us where us.symbol = y.symbol) as closure_dropped,
(select count(*) from (select 1 from parsed pr where pr.symbol = y.symbol and pr.ok group by pr.price_type, pr.ot having count(*) > 1) q) as dup_ots
from syms y
),
gd as (
select y.symbol,
case when gf.files_bid = 0 or gf.files_ask = 0 then 'NO_DATA'
when ss.day_bars = 0 then 'NO_DATA'
when not pp.range_ok then 'BAD_RANGE'
else 'ok' end as status,
case when gf.files_bid = 0 or gf.files_ask = 0 then 'no BID/ASK 1hour file for key ' || pp.k_first || '..' || pp.k_last || ' in public.gmo_kline_files (a day not over yet, not stored yet, or no trading): nothing was recounted'
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
extra_reasons as (select null::text as pair, null::bigint as ot, null::text as reason where false),
dayend as (
select y.symbol, (ss.day_bars > 0 and ss.last_day_ot <> pp.end_ms - 3600000) as cut
from syms y cross join pp join sstat ss on ss.symbol = y.symbol
),
ck as (
select e.pair, e.ot, e.side, case when e.step in ('in', 'skip') then 'in' else 'at' end as kind from ev e
union
select m.pair, m.ot, m.side, m.kind from mails m
union
select r.pair, r.eot, r.side, 'in' from rd r, pp where r.eot >= pp.start_ms and r.eot < pp.end_ms
),
c2 as (
select k.pair, k.ot, k.side, k.kind, y.symbol, y.ord, y.live_ms, y.d, coalesce(sb.n, 0) as subs,
e.step, e.by_eot, (e.step is not null and e.step = k.kind) as has_exp,
(m.ot is not null) as has_mail, m.n_rows, m.n_sent, m.statuses, m.lag_min, m.lag_max, m.entry, m.entry_max,
(r.eot is not null) as has_ride, r.status as r_status, r.rot as r_rot, r.entry_price as r_price, r.entry_mid as r_mid, r.share0 as r_share0,
extract(epoch from (r.created_at - r.entry_closed_at)) as r_opened_s,
extract(dow from to_timestamp((k.ot + 3600000) / 1000.0) at time zone 'UTC') as cdw,
extract(hour from to_timestamp((k.ot + 3600000) / 1000.0) at time zone 'UTC') as chh,
x.m as x_m, x.sg as x_sg, x.tn as x_tn, x.bn as x_bn, x.mk_top as x_mk_top, x.mk_bot as x_mk_bot, x.out_top as x_out_top, x.out_bot as x_out_bot,
x.in_top as x_in_top, x.in_bot as x_in_bot, x.p_top as x_p_top, x.p_bot as x_p_bot, x.cls as x_cls, x.near_edge as x_ne, x.tick as x_tick, x.clo as x_clo,
case when k.kind = 'at' then x.clo::float8 else coalesce(case k.side when 'BUY' then pd.paid_buy else pd.paid_sell end, x.clo::float8) end as x_paid
from ck k join syms y on y.pair = k.pair
left join subs sb on sb.pair = k.pair
left join ev e on e.pair = k.pair and e.ot = k.ot and e.side = k.side and case when e.step in ('in', 'skip') then 'in' else 'at' end = k.kind
left join mails m on m.pair = k.pair and m.ot = k.ot and m.side = k.side and m.kind = k.kind
left join rd r on k.kind = 'in' and r.pair = k.pair and r.eot = k.ot and r.side = k.side
left join fx2 x on x.symbol = y.symbol and x.ot = k.ot
left join paid pd on pd.symbol = y.symbol and pd.ot = k.ot
),
c3 as (
select c2.*, concat_ws(';',
case when (c2.cdw = 5 and c2.chh >= 21) or c2.cdw = 6 or (c2.cdw = 0 and c2.chh < 22) then 'weekend_window' end,
case when c2.ot < c2.live_ms then 'before_go_live' end,
case when c2.subs = 0 then 'no_subscription' end,
(select string_agg(r.reason, ';') from extra_reasons r where r.pair = c2.pair and r.ot = c2.ot)) as reasons,
case when c2.entry is not null and c2.x_paid is not null
then round(((case when abs(c2.entry_max - c2.x_paid) > abs(c2.entry - c2.x_paid) then c2.entry_max else c2.entry end) - c2.x_paid) * power(10::float8, c2.d))::int end as entry_diff_ticks,
case when c2.has_ride and c2.x_paid is not null then round((c2.r_price - c2.x_paid) * power(10::float8, c2.d))::int end as ride_diff_ticks
from c2
),
cv as (
select c3.*,
case when has_exp and has_mail then (case when n_rows > n_sent then 'not_sent' when n_rows > greatest(subs, 1) then 'dup' else 'ok' end)
when has_exp then (case when reasons <> '' then 'not_mailable' else 'missing' end)
when has_mail or has_ride then (case when x_m is null then 'unchecked' else 'extra' end)
else step end as verdict
from c3
),
oj0 as (
select coalesce(o.pair, m.pair) as pair, coalesce(o.side, m.side) as side, coalesce(o.eot, m.eot) as eot,
(o.eot is not null) as has_ride, (o.eot is not null and (o.in_range or o.seen_late_in_range)) as has_exp, (m.eot is not null) as has_mail,
o.status, o.rot, o.xot, o.in_range, o.seen_late_in_range, o.reached_at, o.late, o.entry_price, o.seen_price, o.share1,
coalesce(o.lot, (floor(extract(epoch from m.seen_min) / 3600) * 3600000)::bigint) as lot,
m.n_rows, m.n_sent, m.statuses, m.lag_min, m.lag_max, m.entry, m.entry_max, m.seen_min, m.seen_max
from ro o full join mo m on m.pair = o.pair and m.side = o.side and m.eot = o.eot
),
oj2 as (
select k.*, y.symbol, y.ord, y.d, coalesce(sb.n, 0) as subs, power(10::float8, -y.d) as tick,
case k.side when 'BUY' then 'top' else 'bottom' end as zside,
case when not k.has_ride then null
when k.in_range then case when k.xot = k.rot then 'same' when k.xot < k.rot then 'recount_earlier' else 'recount_no_touch_at_reached_bar' end
when k.seen_late_in_range then 'reached_bar_before_range'
else 'not_reached_in_table' end as reach_check
from oj0 k join syms y on y.pair = k.pair
left join subs sb on sb.pair = k.pair
),
oj3 as (
select oj2.*, b.touch as b_touch, b.near as b_near, b.srcs as b_srcs, b.x as b_x, b.m as b_m, b.edge as b_edge,
case when oj2.entry is not null and oj2.entry_price is not null
then round(((case when abs(oj2.entry_max - oj2.entry_price) > abs(oj2.entry - oj2.entry_price) then oj2.entry_max else oj2.entry end) - oj2.entry_price) * power(10::float8, oj2.d))::int end as entry_diff_ticks
from oj2
left join tb b on b.symbol = oj2.symbol and b.zside = oj2.zside and b.ot = case when oj2.reach_check in ('recount_earlier', 'not_reached_in_table') then oj2.xot else oj2.rot end
),
ov as (
select oj3.*,
case when has_exp and has_mail then (case when n_rows > n_sent then 'not_sent' when n_rows > greatest(subs, 1) then 'dup'
when reach_check in ('recount_earlier', 'recount_no_touch_at_reached_bar') then 'reach_differs' else 'ok' end)
when has_exp then (case when subs = 0 then 'not_mailable' else 'missing' end)
when has_mail then 'extra'
else (case when subs = 0 then 'not_mailable' else 'missing' end) end as verdict
from oj3
),
al as (
select symbol, pair, verdict, n_rows, n_sent, lag_min, lag_max, entry_diff_ticks, has_mail,
case when verdict = 'not_mailable' then reasons end as reasons, kind, (kind = 'in' and has_exp and has_mail and not has_ride) as no_ride_row,
(has_ride and ride_diff_ticks <> 0) as ride_diff, false as reach_diff
from cv
union all
select symbol, pair, verdict, n_rows, n_sent, lag_min, lag_max, entry_diff_ticks, has_mail,
case when verdict = 'not_mailable' then 'no_subscription' end, 'out', false, false, coalesce(reach_check in ('recount_earlier', 'recount_no_touch_at_reached_bar', 'not_reached_in_table'), false)
from ov
),
cnt as (
select y.symbol,
count(v.pair) filter (where v.verdict in ('ok', 'not_sent', 'dup', 'reach_differs')) as matched,
count(v.pair) filter (where v.verdict = 'missing') as missing,
count(v.pair) filter (where v.verdict = 'extra') as extra,
count(v.pair) filter (where v.verdict = 'unchecked') as unchecked,
count(v.pair) filter (where v.verdict = 'not_mailable') as not_mailable,
count(v.pair) filter (where v.verdict = 'dup') as dups,
count(v.pair) filter (where v.verdict = 'skip') as skips,
count(v.pair) filter (where v.verdict = 'quiet') as quiets,
count(v.pair) filter (where v.entry_diff_ticks <> 0) as entry_diff,
count(v.pair) filter (where v.no_ride_row) as no_ride_row,
count(v.pair) filter (where v.ride_diff) as ride_diff,
count(v.pair) filter (where v.reach_diff) as reach_diff,
coalesce(sum(v.n_rows), 0) as mail_rows, count(v.pair) filter (where v.has_mail) as mail_signals,
count(v.pair) filter (where v.has_mail and v.kind = 'in') as mails_in, count(v.pair) filter (where v.has_mail and v.kind = 'at') as mails_at,
count(v.pair) filter (where v.has_mail and v.kind = 'out') as mails_out,
coalesce(sum(v.n_rows - v.n_sent), 0) as not_sent_rows,
min(v.lag_min) as lag_min, max(v.lag_max) as lag_max,
count(v.pair) filter (where v.verdict = 'not_mailable' and v.reasons like '%weekend_window%') as nm_weekend,
count(v.pair) filter (where v.verdict = 'not_mailable' and v.reasons like '%before_go_live%') as nm_live,
count(v.pair) filter (where v.verdict = 'not_mailable' and v.reasons like '%no_subscription%') as nm_subs,
count(v.pair) filter (where v.verdict = 'not_mailable' and v.reasons like '%twelve_daily_cap%') as nm_cap
from syms y left join al v on v.symbol = y.symbol
group by y.symbol
),
rstat as (
select y.symbol,
count(r.eot) filter (where r.eot >= pp.start_ms) as rides_entered,
count(r.eot) filter (where r.rot >= pp.start_ms and r.rot < pp.end_ms) as rides_reached,
count(r.eot) filter (where r.rot < pp.start_ms and r.reached_at >= to_timestamp(pp.start_ms / 1000.0) and r.reached_at < to_timestamp(pp.end_ms / 1000.0)) as rides_seen_late,
count(r.eot) filter (where r.status = 'open' or r.rot >= pp.end_ms) as rides_held_at_end,
count(r.eot) filter (where r.status = 'open') as rides_open_now
from syms y cross join pp left join rd r on r.pair = y.pair
group by y.symbol
),
hstat as (select y.symbol, count(h.ot) filter (where h.bad) as bad_hl from syms y left join hl h on h.symbol = y.symbol group by y.symbol),
u as (
select 1 as o1, y.ord::bigint as o2, 0::bigint as o3, 'SUMMARY'::text as row_type, y.pair as instrument, null::text as bar_open_utc, null::text as side,
case when gd.status <> 'ok' then gd.status when att.t <> '' then 'CHECK' else 'OK' end as verdict,
json_build_object(
'history_bars', ss.history_bars, 'day_bars', ss.day_bars,
'first_bar_utc', to_char(to_timestamp(ss.first_day_ot / 1000.0) at time zone 'UTC', 'YYYY-MM-DD HH24:MI'),
'last_bar_utc', to_char(to_timestamp(ss.last_day_ot / 1000.0) at time zone 'UTC', 'YYYY-MM-DD HH24:MI'),
'windows', ws.windows, 'bad_mantissas', ss.bad_mantissas + hs.bad_hl,
'band_bars', ws.band_bars, 'entries', ws.entries, 'expected_in', ws.exp_in, 'expected_at', ws.exp_at, 'skips', ws.exp_skip, 'quiets', ws.exp_quiet,
'rides_entered', rs.rides_entered, 'rides_reached', rs.rides_reached, 'rides_seen_late', rs.rides_seen_late, 'rides_held_at_end', rs.rides_held_at_end,
'rides_open_now', rs.rides_open_now,
'state_rows', sc.state_rows, 'state_checked', sc.state_checked, 'state_equal', sc.state_equal, 'state_max_diff_ticks', round(sc.state_max_diff_ticks::numeric, 6),
'not_mailable', c.not_mailable,
'not_mailable_why', nullif(concat_ws(';', case when c.nm_weekend > 0 then 'weekend_window:' || c.nm_weekend end, case when c.nm_live > 0 then 'before_go_live:' || c.nm_live end,
case when c.nm_subs > 0 then 'no_subscription:' || c.nm_subs end, case when c.nm_cap > 0 then 'twelve_daily_cap:' || c.nm_cap end), ''),
'mail_rows', c.mail_rows, 'mail_signals', c.mail_signals, 'mails_in', c.mails_in, 'mails_at', c.mails_at, 'mails_out', c.mails_out,
'matched', c.matched, 'missing', c.missing, 'extra', c.extra, 'unchecked', c.unchecked,
'not_sent_rows', c.not_sent_rows, 'duplicates', c.dups, 'entry_differs', c.entry_diff, 'reach_differs', c.reach_diff,
'lag_min_s', round(c.lag_min::numeric, 3), 'lag_max_s', round(c.lag_max::numeric, 3),
'attention', nullif(att.t, ''), 'no_data_why', gd.why, 'guard', gd.guard) as data
from syms y cross join pp
join gd on gd.symbol = y.symbol join sstat ss on ss.symbol = y.symbol join wstat ws on ws.symbol = y.symbol join cnt c on c.symbol = y.symbol join dayend de on de.symbol = y.symbol
join rstat rs on rs.symbol = y.symbol join stc sc on sc.symbol = y.symbol join hstat hs on hs.symbol = y.symbol
cross join lateral (select concat_ws('; ',
case when c.missing > 0 then 'missing=' || c.missing end, case when c.extra > 0 then 'extra=' || c.extra end,
case when c.unchecked > 0 then 'unchecked=' || c.unchecked end, case when c.not_sent_rows > 0 then 'not_sent_rows=' || c.not_sent_rows end,
case when c.dups > 0 then 'dup=' || c.dups end, case when c.entry_diff > 0 then 'entry_differs=' || c.entry_diff end,
case when c.reach_diff > 0 then 'reach_differs=' || c.reach_diff end,
case when c.no_ride_row > 0 then 'mail_without_ride_row=' || c.no_ride_row end, case when c.ride_diff > 0 then 'ride_price_differs=' || c.ride_diff end,
case when sc.state_checked > sc.state_equal then 'state_differs=' || (sc.state_checked - sc.state_equal) end,
case when ss.bad_mantissas + hs.bad_hl > 0 then 'bad_mantissas=' || (ss.bad_mantissas + hs.bad_hl) end,
case when ws.windows < ss.day_bars then 'bars_without_600_window=' || (ss.day_bars - ws.windows) end,
case when de.cut then 'last_day_bar_not_at_day_end' end,
case when ss.day_bars > 0 and (ss.last_day_ot - ss.first_day_ot) / 3600000 + 1 > ss.day_bars then 'day_hours_missing=' || ((ss.last_day_ot - ss.first_day_ot) / 3600000 + 1 - ss.day_bars) end,
nullif(gd.warn, '')) as t) att
union all
select 2, f.ot, f.ord::bigint * 10 + case f.kind when 'in' then 0 else 1 end, 'LINE', f.pair, to_char(to_timestamp(f.ot / 1000.0) at time zone 'UTC', 'YYYY-MM-DD HH24:MI'), f.side, f.verdict,
json_strip_nulls(json_build_object(
'kind', f.kind, 'recount', f.step,
'mail_rows', f.n_rows, 'mail_status', f.statuses, 'lag_min_s', round(f.lag_min::numeric, 3), 'lag_max_s', round(f.lag_max::numeric, 3), 'entry', f.entry,
'paid', case when f.kind = 'in' then f.x_paid end, 'close', f.x_clo, 'entry_diff_ticks', f.entry_diff_ticks,
'ride_row', case when f.kind = 'in' and (f.has_exp or f.has_mail or f.has_ride) then case when f.has_ride then f.r_status else 'none' end end,
'ride_reached_bar_utc', to_char(to_timestamp(f.r_rot / 1000.0) at time zone 'UTC', 'YYYY-MM-DD HH24:MI'),
'ride_entry_price', f.r_price, 'ride_diff_ticks', f.ride_diff_ticks, 'ride_opened_after_close_s', round(f.r_opened_s::numeric, 1),
'held_ride_entry_bar_utc', to_char(to_timestamp(f.by_eot / 1000.0) at time zone 'UTC', 'YYYY-MM-DD HH24:MI'),
'macd', f.x_m, 'signal', f.x_sg,
'top', case when f.side = 'BUY' then f.x_tn end, 'bottom', case when f.side = 'SELL' then f.x_bn end,
'mark', case f.side when 'BUY' then f.x_mk_top when 'SELL' then f.x_mk_bot end,
'mark96', case f.side when 'BUY' then f.x_out_top when 'SELL' then f.x_out_bot end,
'mark_dist_ticks', round(((case f.side when 'BUY' then f.x_m - f.x_mk_top when 'SELL' then f.x_mk_bot - f.x_m end) / f.x_tick)::numeric, 1),
'mark96_dist_ticks', round(((case f.side when 'BUY' then f.x_m - f.x_out_top when 'SELL' then f.x_out_bot - f.x_m end) / f.x_tick)::numeric, 1),
'band_before', case when (case f.side when 'BUY' then f.x_p_top when 'SELL' then f.x_p_bot end) then true end,
'near_edge', f.x_ne,
'why', case f.verdict
when 'not_mailable' then f.reasons
when 'missing' then 'no row in signal_alerts for an expected ' || case f.kind when 'in' then 'email 1' else 'notice' end || ' that production could mail'
when 'dup' then 'rows ' || f.n_rows || ' > subscriptions ' || f.subs
when 'unchecked' then 'the recount has no window for this bar (bar not in the data, or fewer than 600 bars before it)'
when 'skip' then 'an entry while a ride of the side is held: nothing is mailed'
when 'quiet' then 'already at 96%, and a ride of the side was reached in this very bar: its email 2 says the same, no notice'
when 'extra' then case when f.step = 'skip' then 'recount: skip (a ride of the side is held)'
when f.step = 'quiet' then 'recount: quiet (a ride of the side was reached in this bar)'
when f.x_cls is null then 'recount has no entry at this bar'
when left(f.x_cls, length(f.side)) <> f.side then 'recount has the OPPOSITE entry (' || f.x_cls || ')'
when f.kind = 'in' then 'recount: the line is already at 96% here (a notice, no ride)'
else 'recount: the line is in the 90% band but short of 96% here (email 1, not a notice)' end
when 'ok' then case when f.reasons <> '' then 'mailed although ' || f.reasons end
when 'not_sent' then case when f.reasons <> '' then 'also ' || f.reasons end end))
from cv f
union all
select 2, f.lot, f.ord::bigint * 10 + 5, 'LINE', f.pair, to_char(to_timestamp(f.lot / 1000.0) at time zone 'UTC', 'YYYY-MM-DD HH24:MI'), f.side, f.verdict,
json_strip_nulls(json_build_object(
'kind', 'out', 'entry_bar_utc', to_char(to_timestamp(f.eot / 1000.0) at time zone 'UTC', 'YYYY-MM-DD HH24:MI'),
'ride_row', case when f.has_ride then f.status else 'none' end,
'reached_bar_utc', to_char(to_timestamp(f.rot / 1000.0) at time zone 'UTC', 'YYYY-MM-DD HH24:MI'),
'recount_touch_bar_utc', to_char(to_timestamp(f.xot / 1000.0) at time zone 'UTC', 'YYYY-MM-DD HH24:MI'),
'reach_check', f.reach_check,
'seen_utc', to_char(f.reached_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS'), 'late', f.late,
'mail_rows', f.n_rows, 'mail_status', f.statuses, 'lag_min_s', round(f.lag_min::numeric, 3), 'lag_max_s', round(f.lag_max::numeric, 3),
'entry_price', f.entry_price, 'seen_price', f.seen_price,
'pl_ticks', round(((case f.side when 'BUY' then f.seen_price - f.entry_price else f.entry_price - f.seen_price end) / f.tick)::numeric, 1),
'entry', f.entry, 'entry_diff_ticks', f.entry_diff_ticks,
'touch_price', f.b_x, 'touch_from', f.b_srcs, 'macd_at_touch', f.b_m, 'edge_at_touch', f.b_edge, 'mark96', 0.96::float8 * f.b_edge,
'mark96_dist_ticks', round(((case f.zside when 'top' then f.b_m - 0.96::float8 * f.b_edge else 0.96::float8 * f.b_edge - f.b_m end) / f.tick)::numeric, 1),
'near_edge', f.b_near, 'share1', f.share1,
'why', case f.verdict
when 'missing' then case when f.has_exp then 'the ride is reached in the table but there is no email 2 row in signal_alerts'
else 'recount: the line touched 96% in this bar, but the ride ' || case when f.status = 'open' then 'is still open' else 'was reached in a later bar' end end
when 'not_mailable' then 'no_subscription'
when 'dup' then 'rows ' || f.n_rows || ' > subscriptions ' || f.subs
when 'extra' then case when f.has_ride then 'an email 2 row for a ride the table does not hold reached in the range' else 'an email 2 row with no ride row of its entry bar and side' end
when 'reach_differs' then case f.reach_check when 'recount_earlier' then 'recount: the line touched 96% in an earlier bar of the range (recount_touch_bar_utc)'
else 'recount: no touch of 96% in the bar the ride was reached in (by the stored high / low)' end
when 'ok' then case when f.reach_check = 'reached_bar_before_range' then 'reached in a bar before the range, seen in it (found late); the touch is not recounted here' end end))
from ov f
union all
select 0, 0, 0, 'RUN', null, null, null, 'info',
json_build_object('sql', 'pairs.sql v9', 'rule', 'macdx_12_26_9_w600_1h_ride90to96of120_{in,at,out}_v9', 'keys', pp.k_first || '..' || pp.k_last,
'range_utc', to_char(to_timestamp(pp.start_ms / 1000.0) at time zone 'UTC', 'YYYY-MM-DD HH24:MI') || ' .. ' || to_char(to_timestamp(pp.end_ms / 1000.0) at time zone 'UTC', 'YYYY-MM-DD HH24:MI'),
'range_is_one_gmo_day', pp.range_ok, 'db_now_utc', to_char(now() at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
'go_live_utc', (select to_char(to_timestamp(min(live_ms) / 1000.0) at time zone 'UTC', 'YYYY-MM-DD HH24:MI') from syms),
'lines', (select count(*) from cv) + (select count(*) from ov), 'elapsed_s', round(extract(epoch from clock_timestamp() - statement_timestamp())::numeric, 2),
'sql_md5', md5(split_part(current_query(), E'\n\n-- source: POST /mcp', 1)), 'sql_chars', length(split_part(current_query(), E'\n\n-- source: POST /mcp', 1)))
from pp
)
select row_type, instrument, bar_open_utc, side, verdict, data from u order by o1, o2, o3
