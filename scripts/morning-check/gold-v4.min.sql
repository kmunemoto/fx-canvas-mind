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
syms as (select 'XAU_USD'::text as symbol, 'XAU/USD'::text as pair, 1 as ord, 1792011600000::bigint as live_ms, 2 as d),
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
hj as (
select h as ot_h
from pp, generate_series(pp.start_ms, pp.end_ms - 3600000, 3600000::bigint) h
cross join lateral (select extract(dow from to_timestamp((h + 3600000) / 1000.0) at time zone 'UTC') as cdw,
extract(hour from to_timestamp((h + 3600000) / 1000.0) at time zone 'UTC') as chh) c
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
(select count(*) from bgold2 where ok and ot + 3600000 > fetched_ms) as forming_in_row,
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
case when g.row_found = 0 then 'no XAU/USD 1h row in public.live_chart_fallback: nothing was recounted'
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
'note', 'latest stored row: production judged each bar on the row as it was about 1 minute after the close') as guard
from syms y cross join pp cross join gg g
join sstat ss on ss.symbol = y.symbol
left join subs sb on sb.pair = y.pair
left join othr ot on ot.pair = y.pair
),
extra_reasons as (
select 'XAU/USD'::text as pair, f.ot, 'twelve_daily_cap'::text as reason
from fx2 f
join public.twelve_data_usage u on u.day = (to_timestamp((f.ot + 3600000) / 1000.0) at time zone 'UTC')::date
where u.used >= 780
),
dayend as (
select y.symbol, coalesce(ss.day_bars > 0 and ss.last_day_ot < g.last_judgeable_ot, false) as cut
from syms y cross join gg g join sstat ss on ss.symbol = y.symbol
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
json_build_object('sql', 'gold.sql v4', 'rule', 'macdx_12_26_9_w600_1h_z90of120_v4', 'keys', pp.k_first || '..' || pp.k_last,
'range_utc', to_char(to_timestamp(pp.start_ms / 1000.0) at time zone 'UTC', 'YYYY-MM-DD HH24:MI') || ' .. ' || to_char(to_timestamp(pp.end_ms / 1000.0) at time zone 'UTC', 'YYYY-MM-DD HH24:MI'),
'range_is_one_gmo_day', pp.range_ok, 'db_now_utc', to_char(now() at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
'go_live_utc', (select to_char(to_timestamp(min(live_ms) / 1000.0) at time zone 'UTC', 'YYYY-MM-DD HH24:MI') from syms),
'lines', (select count(*) from verdicts), 'elapsed_s', round(extract(epoch from clock_timestamp() - statement_timestamp())::numeric, 2),
'sql_md5', md5(split_part(current_query(), E'\n\n-- source: POST /mcp', 1)), 'sql_chars', length(split_part(current_query(), E'\n\n-- source: POST /mcp', 1)))
from pp
)
select row_type, instrument, bar_open_utc, side, verdict, data from u order by o1, o2, o3
