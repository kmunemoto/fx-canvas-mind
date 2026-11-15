#!/usr/bin/env python3
"""Local test bench of morning-check v9: scenarios. The rows the simulation left are changed on purpose (inside a transaction that is rolled back),
and the statement must say so in the right words.

usage: python3 -I scen.py DATADIR [--db NAME] [--sql FILE] [--only NAME]
The database must hold DATADIR's rows already (check.py DATADIR --db NAME --load).
"""
import datetime as dt
import json
import os
import re
import shlex
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))

args = sys.argv[1:]
d = args[0]
opt = lambda k, default=None: (args[args.index(k) + 1] if k in args else default)
DB = opt("--db", "mc9s")
SQLFILE = opt("--sql", os.path.join(HERE, "..", "pairs-v9.min.sql"))
ONLY = opt("--only")
PSQL = shlex.split(os.environ.get("MC_PSQL", "psql -h 127.0.0.1 -p 54329 -U postgres")) + ["-d", DB, "-q", "-v", "ON_ERROR_STOP=1", "-At", "-F", "\x1f"]
UTC = dt.timezone.utc
HOUR = 3600000
text = open(SQLFILE, encoding="utf-8").read()
expect = json.load(open(f"{d}/expect.json", encoding="utf-8"))
RULE = "macdx_12_26_9_w600_1h_ride90to96of120"
# the statement's go-live constant, written once per instrument (the only 13-digit bigint constants of the text; scenario 29 checks its value through the RUN row)
LIVES = set(re.findall(r"(\d{13})::bigint", text))
assert len(LIVES) == 1, LIVES
LIVE = LIVES.pop()


def day_of(ms):
    """START_MS of the GMO day a bar (open ms) belongs to"""
    return (ms - 75600000) // 86400000 * 86400000 + 75600000


def run(start, mutation, live=None):
    """the statement for the GMO day starting at `start`, after `mutation`; `live`: another go-live instant (ms) in place of the statement's own"""
    stmt = text if live is None else text.replace(LIVE, str(live))
    sql = "begin;\n" + mutation + "\n" + stmt.replace("{{START_MS}}", str(start)).replace("{{END_MS}}", str(start + 86400000)) + ";\nrollback;\n"
    r = subprocess.run(PSQL, input=sql, capture_output=True, text=True)
    if r.returncode:
        sys.exit("psql failed: " + r.stderr[:3000])
    rows = []
    for ln in r.stdout.strip().split("\n"):
        if ln.count("\x1f") == 5:
            rt, inst, bar, side, verdict, data = ln.split("\x1f")
            rows.append({"rt": rt, "inst": inst, "bar": bar, "side": side, "verdict": verdict, **{"data": json.loads(data)}})
    return rows


fmt = lambda ms: dt.datetime.fromtimestamp(ms / 1000, UTC).strftime("%Y-%m-%d %H:%M")
tsq = lambda ms: "'" + dt.datetime.fromtimestamp(ms / 1000, UTC).strftime("%Y-%m-%dT%H:%M:%SZ") + "'::timestamptz"


def line(rows, pair, bar_ms, side, kind):
    got = [r for r in rows if r["rt"] == "LINE" and r["inst"] == pair and r["bar"] == fmt(bar_ms) and r["side"] == side and r["data"]["kind"] == kind]
    return got[0] if len(got) == 1 else None


def summary(rows, pair):
    return [r for r in rows if r["rt"] == "SUMMARY" and r["inst"] == pair][0]


# the events the scenarios are played on: a ride whose entry and end are both judged and in the same GMO day (so one run shows both), a skip, a quiet, a notice
ins = [x for x in expect if x["kind"] == "in" and x["verdict"] == "ok"]
outs = {(x["pair"], x["entryBar"], x["side"]): x for x in expect if x["kind"] == "out"}
same = [(i, outs[(i["pair"], i["bar"], i["side"])]) for i in ins if (i["pair"], i["bar"], i["side"]) in outs and day_of(outs[(i["pair"], i["bar"], i["side"])]["bar"]) == day_of(i["bar"])
        and outs[(i["pair"], i["bar"], i["side"])]["bar"] - i["bar"] >= 2 * HOUR]
assert same, "no ride that is entered and reached in one day, two bars apart or more"
I, O = same[0]
P, S, B, R = I["pair"], I["side"], I["bar"], O["bar"]
D = day_of(B)
skips = [x for x in expect if x["verdict"] == "skip"]
quiets = [x for x in expect if x["verdict"] == "quiet"]
ats = [x for x in expect if x["kind"] == "at" and x["verdict"] == "ok"]
print(f"ride: {P} {S} entry {fmt(B)} reached {fmt(R)} (day {fmt(D)}); skips {len(skips)}, quiets {len(quiets)}, notices {len(ats)}")
where_in = f"pair = '{P}' and side = '{S}' and bar_time = {tsq(B)} and rule = '{RULE}_in_v9'"
where_out = f"pair = '{P}' and side = '{S}' and bar_time = {tsq(B)} and rule = '{RULE}_out_v9'"
where_ride = f"pair = '{P}' and side = '{S}' and entry_bar = {tsq(B)}"
OPP = "SELL" if S == "BUY" else "BUY"
TICK = 0.01 if P == "XAU/USD" else 0.001 if "JPY" in P else 0.00001  # one unit of the instrument's last decimal
results = []


def scen(name, start, mutation, test, live=None):
    if ONLY and ONLY != name:
        return
    rows = run(start, mutation, live)
    try:
        why = test(rows)
        ok = why is None
    except Exception as e:  # a missing line, a missing key
        ok, why = False, f"{type(e).__name__}: {e}"
    results.append((name, ok))
    print(("PASS " if ok else "FAIL ") + name + ("" if ok else f"  <- {why}"))
    if not ok:
        for r in rows:
            if r["rt"] != "RUN" and (r["rt"] == "LINE" or r["inst"] == P):
                print("     ", r["rt"], r["inst"], r["bar"], r["side"], r["verdict"], json.dumps(r["data"])[:700])


def want(cond, msg):
    return None if cond else msg


def base(rows):
    a, b, s = line(rows, P, B, S, "in"), line(rows, P, R, S, "out"), summary(rows, P)
    return want(a["verdict"] == "ok" and b["verdict"] == "ok" and b["data"]["reach_check"] == "same" and s["verdict"] == "OK" and a["data"]["ride_row"] == "reached"
                and a["data"]["entry_diff_ticks"] == 0 and a["data"]["ride_diff_ticks"] == 0, "the untouched day is not clean")


scen("00 untouched", D, "", base)
scen("01 email 1 deleted", D, f"delete from public.signal_alerts where {where_in};",
     lambda rows: want(line(rows, P, B, S, "in")["verdict"] == "missing" and line(rows, P, B, S, "in")["data"]["ride_row"] == "reached"
                       and "missing=1" in summary(rows, P)["data"]["attention"] and summary(rows, P)["verdict"] == "CHECK", "in is not missing"))
scen("02 email 1 not sent", D, f"update public.signal_alerts set status = 'failed', sent_at = null where {where_in};",
     lambda rows: want(line(rows, P, B, S, "in")["verdict"] == "not_sent" and "not_sent_rows=1" in summary(rows, P)["data"]["attention"], "in is not not_sent"))
scen("03 email 1 twice", D, f"insert into public.signal_alerts (kind, pair, interval, bar_time, closed_at, side, entry, rule, status, sent_at, who) select kind, pair, interval, bar_time, closed_at, side, entry, rule, status, sent_at, 'u2' from public.signal_alerts where {where_in};",
     lambda rows: want(line(rows, P, B, S, "in")["verdict"] == "dup" and "dup=1" in summary(rows, P)["data"]["attention"], "in is not dup"))
scen("04 email 2 deleted", D, f"delete from public.signal_alerts where {where_out};",
     lambda rows: want(line(rows, P, R, S, "out")["verdict"] == "missing" and "no email 2 row" in line(rows, P, R, S, "out")["data"]["why"], "out is not missing"))
scen("05 ride row deleted", D, f"delete from public.macd_rides where {where_ride};",
     lambda rows: want(line(rows, P, B, S, "in")["verdict"] == "ok" and line(rows, P, B, S, "in")["data"]["ride_row"] == "none"
                       and "mail_without_ride_row=1" in summary(rows, P)["data"]["attention"]
                       and any(r["rt"] == "LINE" and r["inst"] == P and r["data"]["kind"] == "out" and r["verdict"] == "extra" and r["data"]["entry_bar_utc"] == fmt(B) for r in rows),
                       "the mail without a ride row is not told, or its email 2 is not extra"))
scen("06 ride still open, email 2 there", D, f"update public.macd_rides set status = 'open', reached_at = null, reached_bar = null, seen_price = null, late = null, share1 = null where {where_ride};",
     lambda rows: want(line(rows, P, R, S, "out")["verdict"] == "extra" and line(rows, P, R, S, "out")["data"]["reach_check"] == "not_reached_in_table", "out is not extra / not_reached_in_table"))
scen("07 ride still open, no email 2", D, f"update public.macd_rides set status = 'open', reached_at = null, reached_bar = null, seen_price = null, late = null, share1 = null where {where_ride}; delete from public.signal_alerts where {where_out};",
     lambda rows: want(line(rows, P, R, S, "out")["verdict"] == "missing" and "is still open" in line(rows, P, R, S, "out")["data"]["why"]
                       and "reach_differs=1" in summary(rows, P)["data"]["attention"], "the touch the ride did not see is not told"))
scen("08 reached one bar later", D, f"update public.macd_rides set reached_bar = reached_bar + interval '1 hour' where {where_ride};",
     lambda rows: want(line(rows, P, R + HOUR, S, "out")["verdict"] == "reach_differs" and line(rows, P, R + HOUR, S, "out")["data"]["reach_check"] == "recount_earlier"
                       and line(rows, P, R + HOUR, S, "out")["data"]["recount_touch_bar_utc"] == fmt(R), "a later reached bar is not told"))
scen("09 reached one bar earlier", D, f"update public.macd_rides set reached_bar = reached_bar - interval '1 hour' where {where_ride};",
     lambda rows: want(line(rows, P, R - HOUR, S, "out")["verdict"] == "reach_differs" and line(rows, P, R - HOUR, S, "out")["data"]["reach_check"] == "recount_no_touch_at_reached_bar", "an earlier reached bar is not told"))
scen("10 email 1 at a bar with no entry", D, f"insert into public.signal_alerts (kind, pair, interval, bar_time, closed_at, side, entry, rule, status, sent_at) values ('signal', '{P}', '1h', {tsq(B - HOUR)}, {tsq(B)}, '{S}', 1, '{RULE}_in_v9', 'sent', {tsq(B + 4000)});",
     lambda rows: want(line(rows, P, B - HOUR, S, "in")["verdict"] == "extra", "an email 1 with no entry is not extra"))
scen("11 email 1 of the opposite side", D, f"insert into public.signal_alerts (kind, pair, interval, bar_time, closed_at, side, entry, rule, status, sent_at) values ('signal', '{P}', '1h', {tsq(B)}, {tsq(B + HOUR)}, '{OPP}', 1, '{RULE}_in_v9', 'sent', {tsq(B + HOUR + 4000)});",
     lambda rows: want(line(rows, P, B, OPP, "in")["verdict"] == "extra" and "OPPOSITE" in line(rows, P, B, OPP, "in")["data"]["why"] and line(rows, P, B, S, "in")["verdict"] == "ok", "the opposite email 1 is not told"))
scen("12 a notice where email 1 is due", D, f"insert into public.signal_alerts (kind, pair, interval, bar_time, closed_at, side, entry, rule, status, sent_at) values ('signal', '{P}', '1h', {tsq(B)}, {tsq(B + HOUR)}, '{S}', 1, '{RULE}_at_v9', 'sent', {tsq(B + HOUR + 4000)});",
     lambda rows: want(line(rows, P, B, S, "at")["verdict"] == "extra" and "short of 96%" in line(rows, P, B, S, "at")["data"]["why"], "a notice at an email 1 bar is not extra"))
scen("13 no subscription", D, f"delete from public.signal_alert_subscriptions where pair = '{P}';",
     lambda rows: want("no_subscription_row" in summary(rows, P)["data"]["attention"] and line(rows, P, B, S, "in")["verdict"] == "ok"
                       and "mailed although no_subscription" in line(rows, P, B, S, "in")["data"]["why"], "no subscription is not told"))
scen("14 a state row changed", D, f"update public.macd_ride_state set e12 = e12 + 1e-9 where pair = '{P}' and bar_time = {tsq(B)};",
     lambda rows: want("state_differs=1" in summary(rows, P)["data"]["attention"] and summary(rows, P)["verdict"] == "CHECK", "a changed state row is not told"))
scen("15 the ride's price changed", D, f"update public.macd_rides set entry_price = entry_price + {2 * TICK} where {where_ride};",
     lambda rows: want("ride_price_differs=1" in summary(rows, P)["data"]["attention"] and line(rows, P, B, S, "in")["data"]["ride_diff_ticks"] != 0
                       and line(rows, P, R, S, "out")["data"]["entry_diff_ticks"] != 0, "a changed ride price is not told"))
scen("16 email 1's price changed", D, f"update public.signal_alerts set entry = entry - {3 * TICK} where {where_in};",
     lambda rows: want("entry_differs=1" in summary(rows, P)["data"]["attention"] and line(rows, P, B, S, "in")["data"]["entry_diff_ticks"] != 0, "a changed mail price is not told"))
scen("17 a v8 mail in the range", D, f"insert into public.signal_alerts (kind, pair, interval, bar_time, closed_at, side, entry, rule, status, sent_at) values ('signal', '{P}', '1h', {tsq(B)}, {tsq(B + HOUR)}, '{S}', 1, 'macdx_12_26_9_w600_1h_z95of120_v8', 'sent', {tsq(B + HOUR + 4000)});",
     lambda rows: want("other_macdx_1h_rule_rows=1" in summary(rows, P)["data"]["attention"], "another rule's mail is not told"))
scen("18 seen a day late: the day of the bar", D, f"update public.macd_rides set reached_at = reached_at + interval '1 day', late = true where {where_ride}; update public.signal_alerts set closed_at = closed_at + interval '1 day', sent_at = sent_at + interval '1 day' where {where_out};",
     lambda rows: want(line(rows, P, R, S, "out")["verdict"] == "ok" and line(rows, P, R, S, "out")["data"]["late"] is True and line(rows, P, R, S, "out")["data"]["reach_check"] == "same", "a ride seen late is not ok on the day of its bar"))
scen("19 seen a day late: the day it was seen", D + 86400000, f"update public.macd_rides set reached_at = reached_at + interval '1 day', late = true where {where_ride}; update public.signal_alerts set closed_at = closed_at + interval '1 day', sent_at = sent_at + interval '1 day' where {where_out};",
     lambda rows: want(line(rows, P, R, S, "out")["verdict"] == "ok" and line(rows, P, R, S, "out")["data"]["reach_check"] == "reached_bar_before_range", "a ride seen late is not shown on the day it was seen"))
scen("20 email 2 with no ride at all", D, f"insert into public.signal_alerts (kind, pair, interval, bar_time, closed_at, side, entry, rule, status, sent_at) values ('signal', '{P}', '1h', {tsq(B - 5 * HOUR)}, {tsq(B + 1200000)}, '{S}', 1, '{RULE}_out_v9', 'sent', {tsq(B + 1203000)});",
     lambda rows: want(any(r["rt"] == "LINE" and r["inst"] == P and r["data"]["kind"] == "out" and r["verdict"] == "extra" and r["data"]["ride_row"] == "none" and r["bar"] == fmt(B) for r in rows), "an email 2 without a ride is not extra"))
# the go-live instant: a bar opened at it is the rule's, a bar opened before it is not (its mails are told as mailed although before_go_live; without the mail, not_mailable)
scen("26 go-live at the entry bar's open", D, "", lambda rows: want(line(rows, P, B, S, "in")["verdict"] == "ok" and "why" not in line(rows, P, B, S, "in")["data"], "the bar opened at go-live is not the rule's"), live=B)
scen("27 go-live one bar after the entry bar", D, "", lambda rows: want(line(rows, P, B, S, "in")["verdict"] == "ok" and "before_go_live" in line(rows, P, B, S, "in")["data"].get("why", ""), "a mail before go-live is not told"), live=B + HOUR)
scen("28 go-live one bar after the entry bar, no email 1", D, f"delete from public.signal_alerts where {where_in};",
     lambda rows: want(line(rows, P, B, S, "in")["verdict"] == "not_mailable" and line(rows, P, B, S, "in")["data"]["why"] == "before_go_live", "an entry before go-live is not not_mailable"), live=B + HOUR)
# The sources of the highs and lows, one at a time and by the hour: the table is made to say the ride was reached one bar EARLIER (where nothing touches: scenario 09), and a
# spike is put into that bar alone, in one source: the bar's high for a BUY ride, its low for a SELL ride. The recount must then find the touch in that very bar, from that source.
dtq = lambda ms: dt.datetime.fromtimestamp(ms / 1000, UTC).strftime("%Y-%m-%d %H:%M:%S")
for side in ("BUY", "SELL"):
    got = [(i, o) for i, o in same if i["side"] == side]
    if not got:
        print(f"(no {side} ride entered and reached in one day: its spike scenarios are not played)")
        continue
    i2, o2 = got[0]
    P2, B2, R2 = i2["pair"], i2["bar"], o2["bar"]
    X = R2 - HOUR  # the bar before the reached one (after the entry bar: the two are two bars apart or more)
    end = "high" if side == "BUY" else "low"
    earlier = f"update public.macd_rides set reached_bar = reached_bar - interval '1 hour' where pair = '{P2}' and side = '{side}' and entry_bar = {tsq(B2)};"
    found = lambda rows, src, P2=P2, X=X, side=side: want(line(rows, P2, X, side, "out")["verdict"] == "ok" and line(rows, P2, X, side, "out")["data"]["reach_check"] == "same"
                                                         and line(rows, P2, X, side, "out")["data"]["touch_from"] == src, f"the spike of {src} in the bar is not found there")
    if P2 == "XAU/USD":
        num = "999999" if side == "BUY" else "0.01"
        scen(f"30 {side}: a spike of the stored bar's {end} in the bar before", day_of(B2), earlier +
             f" update public.live_chart_fallback set bars = (select jsonb_agg(case when e ->> 'datetime' = '{dtq(X)}' then e || jsonb_build_object('{end}', {num}) else e end order by ord)"
             f" from jsonb_array_elements(bars) with ordinality as x(e, ord)) where pair = 'XAU/USD' and interval = '1h';", lambda rows, f=found: f(rows, "twelve"))
        m = tsq(X + 30 * 60000)
        px = i2.get("price", 4000)
        scen(f"31 {side}: a spike of the recorded minutes' {end} in the bar before", day_of(B2), earlier +
             f" insert into public.gold_tick_bars (minute, open, high, low, close, first_at, last_at, samples, source) select {m}, c, {'999999' if side == 'BUY' else 'c'}, {'c' if side == 'BUY' else '0.01'}, c, {m}, {m}, 1, 'bench'"
             f" from (select coalesce((select close from public.gold_tick_bars where minute < {m} order by minute desc limit 1), 4000) as c) q"
             f" on conflict (minute) do update set {end} = excluded.{end};", lambda rows, f=found: f(rows, "ticks"))
    else:
        sym = P2.replace("/", "_")
        val = "999999" if side == "BUY" else "0.01"
        scen(f"30 {side}: a spike of the day file's {end} (BID and ASK) in the bar before", day_of(B2), earlier +
             f" update public.gmo_kline_files f set body = jsonb_set(f.body, '{{data}}', (select jsonb_agg(case when e ->> 'openTime' = '{X}' then e || jsonb_build_object('{end}', '{val}') else e end order by ord)"
             f" from jsonb_array_elements(f.body -> 'data') with ordinality as x(e, ord))) where f.symbol = '{sym}' and f.interval = '1hour' and f.body -> 'data' @> '[{{\"openTime\": \"{X}\"}}]'::jsonb;",
             lambda rows, f=found: f(rows, "gmo"))
# The review of 2026-11-13 (docs 8.151). 32: the bar the ride was reached in is missing from the data (the five pairs: from both day files; gold: from the stored row and the
# recorded minutes): the end is not recounted, so it is "unchecked" (not_recounted), never reach_differs. 33 (gold): a touch only the recorded minutes show, in the hour before the
# reached one, made unwatched by deleting that hour's state row (production runs the minute's check only in an hour with a state row): the end stays ok / same, the touch is shown.
if P == "XAU/USD":
    gone = (f"update public.live_chart_fallback set bars = (select jsonb_agg(e order by ord) from jsonb_array_elements(bars) with ordinality as x(e, ord) where e ->> 'datetime' <> '{dtq(R)}')"
            f" where pair = 'XAU/USD' and interval = '1h'; delete from public.gold_tick_bars where minute >= {tsq(R)} and minute < {tsq(R + HOUR)};")
else:
    gone = (f"update public.gmo_kline_files f set body = jsonb_set(f.body, '{{data}}', (select coalesce(jsonb_agg(e order by ord), '[]'::jsonb) from jsonb_array_elements(f.body -> 'data') with ordinality as x(e, ord)"
            f" where e ->> 'openTime' <> '{R}')) where f.symbol = '{P.replace('/', '_')}' and f.interval = '1hour' and f.body -> 'data' @> '[{{\"openTime\": \"{R}\"}}]'::jsonb;")
scen("32 the reached bar missing from the data", D, gone,
     lambda rows: want(line(rows, P, R, S, "out")["verdict"] == "unchecked" and line(rows, P, R, S, "out")["data"]["reach_check"] == "not_recounted"
                       and "touch_price" not in line(rows, P, R, S, "out")["data"] and "reach_differs" not in (summary(rows, P)["data"]["attention"] or "")
                       and "unchecked=" in (summary(rows, P)["data"]["attention"] or ""), "a reached bar with no data is not told as not recounted"))
if P == "XAU/USD":
    X3 = R - HOUR
    m3 = tsq(X3 + 30 * 60000)
    spike = ("999999" if S == "BUY" else "c", "c" if S == "BUY" else "0.01")
    unwatched = (f"delete from public.macd_ride_state where pair = 'XAU/USD' and bar_time = {tsq(X3)};"
                 f" insert into public.gold_tick_bars (minute, open, high, low, close, first_at, last_at, samples, source) select {m3}, c, {spike[0]}, {spike[1]}, c, {m3}, {m3}, 1, 'bench'"
                 f" from (select coalesce((select close from public.gold_tick_bars where minute < {m3} order by minute desc limit 1), 4000) as c) q"
                 f" on conflict (minute) do update set {'high' if S == 'BUY' else 'low'} = excluded.{'high' if S == 'BUY' else 'low'};")
    scen("33 gold: a touch only the minutes show, in an hour with no state row", D, unwatched,
         lambda rows: want(line(rows, P, R, S, "out")["verdict"] == "ok" and line(rows, P, R, S, "out")["data"]["reach_check"] == "same"
                           and line(rows, P, R, S, "out")["data"].get("ticks_touch_unwatched_bar_utc") == fmt(X3)
                           and "reach_differs" not in (summary(rows, P)["data"]["attention"] or ""), "a minutes-only touch in an unwatched hour is counted, or not shown"))
    scen("33b gold: the same touch in an hour WITH its state row is counted", D, unwatched.split(";", 1)[1],
         lambda rows: want(line(rows, P, R, S, "out")["verdict"] == "reach_differs" and line(rows, P, R, S, "out")["data"]["reach_check"] == "recount_earlier"
                           and line(rows, P, R, S, "out")["data"]["recount_touch_bar_utc"] == fmt(X3), "a minutes-only touch in a watched hour is not counted"))
scen("29 the go-live constant is 2026-11-12 07:00 UTC", D, "", lambda rows: want([r for r in rows if r["rt"] == "RUN"][0]["data"]["go_live_utc"] == "2026-11-12 07:00", "the statement's go-live instant is not the one of the record"))
if skips:
    K = skips[0]
    scen("21 email 1 at a skipped entry", day_of(K["bar"]), f"insert into public.signal_alerts (kind, pair, interval, bar_time, closed_at, side, entry, rule, status, sent_at) values ('signal', '{K['pair']}', '1h', {tsq(K['bar'])}, {tsq(K['bar'] + HOUR)}, '{K['side']}', 1, '{RULE}_in_v9', 'sent', {tsq(K['bar'] + HOUR + 4000)});",
         lambda rows: want([r for r in rows if r["rt"] == "LINE" and r["inst"] == K["pair"] and r["bar"] == fmt(K["bar"]) and r["data"]["kind"] == "in"][0]["verdict"] == "extra"
                           and "skip" in [r for r in rows if r["rt"] == "LINE" and r["inst"] == K["pair"] and r["bar"] == fmt(K["bar"]) and r["data"]["kind"] == "in"][0]["data"]["why"], "an email 1 at a skip is not extra"))
    scen("22 the held ride gone: the skip becomes an email 1 that is missing", day_of(K["bar"]), f"delete from public.macd_rides where pair = '{K['pair']}' and side = '{K['side']}' and entry_bar < {tsq(K['bar'])};",
         lambda rows: want([r for r in rows if r["rt"] == "LINE" and r["inst"] == K["pair"] and r["bar"] == fmt(K["bar"]) and r["data"]["kind"] == "in"][0]["verdict"] == "missing", "a skip without its ride is not an email 1 missing"))
if quiets:
    Q = quiets[0]
    scen("23 a notice at a quiet entry", day_of(Q["bar"]), f"insert into public.signal_alerts (kind, pair, interval, bar_time, closed_at, side, entry, rule, status, sent_at) values ('signal', '{Q['pair']}', '1h', {tsq(Q['bar'])}, {tsq(Q['bar'] + HOUR)}, '{Q['side']}', 1, '{RULE}_at_v9', 'sent', {tsq(Q['bar'] + HOUR + 4000)});",
         lambda rows: want([r for r in rows if r["rt"] == "LINE" and r["inst"] == Q["pair"] and r["bar"] == fmt(Q["bar"]) and r["data"]["kind"] == "at"][0]["verdict"] == "extra"
                           and "quiet" in [r for r in rows if r["rt"] == "LINE" and r["inst"] == Q["pair"] and r["bar"] == fmt(Q["bar"]) and r["data"]["kind"] == "at"][0]["data"]["why"], "a notice at a quiet is not extra"))
if ats:
    A = ats[0]
    scen("24 the notice deleted", day_of(A["bar"]), f"delete from public.signal_alerts where pair = '{A['pair']}' and side = '{A['side']}' and bar_time = {tsq(A['bar'])} and rule = '{RULE}_at_v9';",
         lambda rows: want([r for r in rows if r["rt"] == "LINE" and r["inst"] == A["pair"] and r["bar"] == fmt(A["bar"]) and r["data"]["kind"] == "at"][0]["verdict"] == "missing", "a deleted notice is not missing"))
    scen("25 a ride row at a notice's bar", day_of(A["bar"]), f"insert into public.macd_rides (pair, side, entry_bar, entry_closed_at, entry_price, entry_mid, status, reached_at, reached_bar, seen_price, late) values ('{A['pair']}', '{A['side']}', {tsq(A['bar'])}, {tsq(A['bar'] + HOUR)}, 1, 1, 'reached', {tsq(A['bar'] + HOUR + 60000)}, {tsq(A['bar'] + HOUR)}, 1, false);",
         lambda rows: want([r for r in rows if r["rt"] == "LINE" and r["inst"] == A["pair"] and r["bar"] == fmt(A["bar"]) and r["data"]["kind"] == "in"][0]["verdict"] == "extra", "a ride row at a notice's bar is not extra"))
print("scenarios", len(results), "passed", sum(1 for _, ok in results if ok), "failed", [n for n, ok in results if not ok])
