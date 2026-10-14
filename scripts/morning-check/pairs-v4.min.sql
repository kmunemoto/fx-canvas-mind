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
('USD_JPY', 'USD/JPY', 1, 1792011600000::bigint, 3), ('EUR_JPY', 'EUR/JPY', 2, 1792011600000::bigint, 3), ('AUD_JPY', 'AUD/JPY', 3, 1792011600000::bigint, 3),
('EUR_USD', 'EUR/USD', 4, 1792011600000::bigint, 5), ('AUD_USD', 'AUD/USD', 5, 1792011600000::bigint, 5)
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
case when ok then ot_s::bigint end as ot, case when ok then c_s::float8 end as cl
from rows2
),
bid as (select symbol, date_key, pos, ot, cl as bc from parsed where price_type = 'BID' and ok),
ask as (select distinct on (symbol, ot) symbol, ot, cl as ac from parsed where price_type = 'ASK' and ok order by symbol, ot, date_key desc, pos desc),
mg0 as (
select distinct on (b.symbol, b.ot) b.symbol, b.ot, b.date_key, b.pos, (b.bc + a.ac) / 2 as m8
from bid b join ask a on a.symbol = b.symbol and a.ot = b.ot
where not (a.ac < b.bc)
order by b.symbol, b.ot, b.date_key, b.pos
),
mg as (select *, row_number() over (partition by symbol order by date_key, ot, pos) as seq from mg0),
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
fin2 as (
select f.symbol, f.ot, f.jr, y.pair, y.d, f.m, f.sg, f.h, f.tn, f.bn, f.clo, f.e12_p, f.e26_p, f.sg_p, f.ta_p, f.tb_p,
b.in_top, b.in_bot, b.p_top, b.p_bot,
case when b.in_top and not b.p_top then 'SELL' when b.in_bot and not b.p_bot then 'BUY' end as sd
from fin f join syms y on y.symbol = f.symbol
cross join lateral (select (f.tn > 0 and f.m >= 0.9::float8 * f.tn) as in_top, (f.bn < 0 and f.m <= 0.9::float8 * f.bn) as in_bot,
(f.tp > 0 and f.mp >= 0.9::float8 * f.tp) as p_top, (f.bp < 0 and f.mp <= 0.9::float8 * f.bp) as p_bot) b
),
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
cross join lateral (select case when e.t2 > 0 and b.nm >= 0.9::float8 * e.t2 and not f.p_top then 'SELL'
when e.b2 < 0 and b.nm <= 0.9::float8 * e.b2 and not f.p_bot then 'BUY' end as sd) x
group by f.symbol, f.jr
),
fx2 as (
select f.*, (f.sd is not null) as fire, n.near_edge, 0.9::float8 * f.tn as mk_top, 0.9::float8 * f.bn as mk_bot, power(10::float8, -f.d) as tick
from fin2 f join ne n on n.symbol = f.symbol and n.jr = f.jr
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
wstat as (
select y.symbol, count(f.ot) as windows, count(f.ot) filter (where f.in_top or f.in_bot) as band_bars, count(f.ot) filter (where f.fire) as exp_fires
from syms y left join fx2 f on f.symbol = y.symbol
group by y.symbol
),
mails as (
select a.pair, a.side, (extract(epoch from a.bar_time) * 1000)::bigint as ot,
count(*) as n_rows, count(*) filter (where a.status = 'sent') as n_sent, string_agg(distinct a.status, ',') as statuses,
min(extract(epoch from (a.sent_at - a.closed_at))) as lag_min, max(extract(epoch from (a.sent_at - a.closed_at))) as lag_max,
min(a.entry) as entry, max(a.entry) as entry_max
from public.signal_alerts a, pp
where a.kind = 'signal' and a.interval = '1h' and a.rule = 'macdx_12_26_9_w600_1h_z90of120_v4'
and a.pair in (select pair from syms)
and a.bar_time >= to_timestamp(pp.start_ms / 1000.0) and a.bar_time < to_timestamp(pp.end_ms / 1000.0)
group by a.pair, a.side, a.bar_time
),
subs as (select pair, count(*) as n from public.signal_alert_subscriptions where interval = '1h' and rule = 'macdx' group by pair),
othr as (
select a.pair, count(*) as n
from public.signal_alerts a, pp
where a.kind = 'signal' and a.interval = '1h' and a.rule like 'macdx%' and a.rule <> 'macdx_12_26_9_w600_1h_z90of120_v4'
and a.pair in (select pair from syms)
and a.bar_time >= to_timestamp(pp.start_ms / 1000.0) and a.bar_time < to_timestamp(pp.end_ms / 1000.0)
group by a.pair
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
j as (
select coalesce(e.pair, m.pair) as pair, coalesce(e.ot, m.ot) as ot, coalesce(e.sd, m.side) as side,
(e.ot is not null) as has_exp, (m.ot is not null) as has_mail, m.n_rows, m.n_sent, m.statuses, m.lag_min, m.lag_max, m.entry, m.entry_max
from (select f.pair, f.ot, f.sd from fx2 f where f.fire) e
full join mails m on m.pair = e.pair and m.ot = e.ot and m.side = e.sd
),
j2 as (
select j.*, y.symbol, y.ord, y.live_ms, y.d, coalesce(sb.n, 0) as subs,
extract(dow from to_timestamp((j.ot + 3600000) / 1000.0) at time zone 'UTC') as cdw,
extract(hour from to_timestamp((j.ot + 3600000) / 1000.0) at time zone 'UTC') as chh,
x.m as x_m, x.sg as x_sg, x.tn as x_tn, x.bn as x_bn, x.mk_top as x_mk_top, x.mk_bot as x_mk_bot,
x.in_top as x_in_top, x.in_bot as x_in_bot, x.p_top as x_p_top, x.p_bot as x_p_bot, x.sd as x_sd,
x.near_edge as x_ne, x.tick as x_tick, x.clo as x_clo
from j join syms y on y.pair = j.pair
left join subs sb on sb.pair = j.pair
left join fx2 x on x.symbol = y.symbol and x.ot = j.ot
),
v0 as (
select j2.*, concat_ws(';',
case when (j2.cdw = 5 and j2.chh >= 21) or j2.cdw = 6 or (j2.cdw = 0 and j2.chh < 22) then 'weekend_window' end,
case when j2.ot < j2.live_ms then 'before_go_live' end,
case when j2.subs = 0 then 'no_subscription' end,
(select string_agg(r.reason, ';') from extra_reasons r where r.pair = j2.pair and r.ot = j2.ot)) as reasons,
case when j2.entry is not null and j2.x_clo is not null
then round(((case when abs(j2.entry_max - j2.x_clo) > abs(j2.entry - j2.x_clo) then j2.entry_max else j2.entry end) - j2.x_clo) * power(10::float8, j2.d))::int end as entry_diff_ticks
from j2
),
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
count(v.pair) filter (where v.verdict = 'not_mailable' and v.reasons like '%twelve_daily_cap%') as nm_cap
from syms y left join verdicts v on v.symbol = y.symbol
group by y.symbol
),
u as (
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
'lag_min_s', round(c.lag_min::numeric, 3), 'lag_max_s', round(c.lag_max::numeric, 3),
'attention', nullif(att.t, ''), 'no_data_why', gd.why, 'guard', gd.guard) as data
from syms y cross join pp
join gd on gd.symbol = y.symbol join sstat ss on ss.symbol = y.symbol join wstat ws on ws.symbol = y.symbol join cnt c on c.symbol = y.symbol join dayend de on de.symbol = y.symbol
cross join lateral (select concat_ws('; ',
case when c.missing > 0 then 'missing=' || c.missing end, case when c.extra > 0 then 'extra=' || c.extra end,
case when c.unchecked > 0 then 'unchecked=' || c.unchecked end, case when c.not_sent_rows > 0 then 'not_sent_rows=' || c.not_sent_rows end,
case when c.dups > 0 then 'dup=' || c.dups end, case when c.entry_diff > 0 then 'entry_differs=' || c.entry_diff end,
case when ss.bad_mantissas > 0 then 'bad_mantissas=' || ss.bad_mantissas end,
case when ws.windows < ss.day_bars then 'bars_without_600_window=' || (ss.day_bars - ws.windows) end,
case when de.cut then 'last_day_bar_not_at_day_end' end,
case when ss.day_bars > 0 and (ss.last_day_ot - ss.first_day_ot) / 3600000 + 1 > ss.day_bars then 'day_hours_missing=' || ((ss.last_day_ot - ss.first_day_ot) / 3600000 + 1 - ss.day_bars) end,
nullif(gd.warn, '')) as t) att
union all
select 2, f.ot, f.ord::bigint, 'LINE', f.pair, to_char(to_timestamp(f.ot / 1000.0) at time zone 'UTC', 'YYYY-MM-DD HH24:MI'), f.side, f.verdict,
json_strip_nulls(json_build_object(
'mail_rows', f.n_rows, 'mail_status', f.statuses, 'lag_min_s', round(f.lag_min::numeric, 3), 'lag_max_s', round(f.lag_max::numeric, 3), 'entry', f.entry,
'close', f.x_clo, 'entry_diff_ticks', f.entry_diff_ticks,
'macd', f.x_m, 'signal', f.x_sg,
'top', case when f.side = 'SELL' then f.x_tn end, 'bottom', case when f.side = 'BUY' then f.x_bn end,
'mark', case f.side when 'SELL' then f.x_mk_top when 'BUY' then f.x_mk_bot end,
'mark_dist_ticks', round(((case f.side when 'SELL' then f.x_m - f.x_mk_top when 'BUY' then f.x_mk_bot - f.x_m end) / f.x_tick)::numeric, 1),
'band_before', case when (case f.side when 'SELL' then f.x_p_top when 'BUY' then f.x_p_bot end) then true end,
'near_edge', f.x_ne,
'why', case f.verdict
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
when 'not_sent' then case when f.reasons <> '' then 'also ' || f.reasons end end))
from verdicts f
union all
select 0, 0, 0, 'RUN', null, null, null, 'info',
json_build_object('sql', 'pairs.sql v4', 'rule', 'macdx_12_26_9_w600_1h_z90of120_v4', 'keys', pp.k_first || '..' || pp.k_last,
'range_utc', to_char(to_timestamp(pp.start_ms / 1000.0) at time zone 'UTC', 'YYYY-MM-DD HH24:MI') || ' .. ' || to_char(to_timestamp(pp.end_ms / 1000.0) at time zone 'UTC', 'YYYY-MM-DD HH24:MI'),
'range_is_one_gmo_day', pp.range_ok, 'db_now_utc', to_char(now() at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
'go_live_utc', (select to_char(to_timestamp(min(live_ms) / 1000.0) at time zone 'UTC', 'YYYY-MM-DD HH24:MI') from syms),
'lines', (select count(*) from verdicts), 'elapsed_s', round(extract(epoch from clock_timestamp() - statement_timestamp())::numeric, 2),
'sql_md5', md5(split_part(current_query(), E'\n\n-- source: POST /mcp', 1)), 'sql_chars', length(split_part(current_query(), E'\n\n-- source: POST /mcp', 1)))
from pp
)
select row_type, instrument, bar_open_utc, side, verdict, data from u order by o1, o2, o3
