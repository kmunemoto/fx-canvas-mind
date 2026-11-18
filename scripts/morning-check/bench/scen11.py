#!/usr/bin/env python3
"""Local test bench of morning-check v11 (README.md v11.4): rows changed on purpose. Each scenario changes rows inside a transaction, runs one statement (pairs-v11, gold-v11
or stocks-v11) for one GMO day, checks its answer, and rolls back. The data folders must already be loaded (check11.py --load: the pairs into --dbp, gold into --dbg).

usage: python3 -I scen11.py PAIRS_DATADIR GOLD_DATADIR [--dbp NAME] [--dbg NAME] [--pairs FILE] [--gold FILE] [--stocks FILE] [--only NAME] [--show]
Prints one line per scenario (PASS / FAIL and why) and the count; with --show also the LINE / SUMMARY rows each scenario is about. Exit 1 on any FAIL.
"""
import datetime as dt
import json
import os
import shlex
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
args = sys.argv[1:]
pdir, gdir = args[0], args[1]
opt = lambda k, default=None: (args[args.index(k) + 1] if k in args else default)
BASE = shlex.split(os.environ.get("MC_PSQL", "psql -h 127.0.0.1 -p 54351 -U postgres"))
DB = {"pairs": opt("--dbp", "mc11p"), "stocks": opt("--dbp", "mc11p"), "gold": opt("--dbg", "mc11g")}
UTC = dt.timezone.utc
HOUR = 3600000
LIVE_P = int(dt.datetime(2026, 11, 18, 10, tzinfo=UTC).timestamp() * 1000)
LIVE_G = int(dt.datetime(2026, 11, 18, 9, tzinfo=UTC).timestamp() * 1000)
TEXT = {"pairs": open(opt("--pairs", os.path.join(HERE, "..", "pairs-v11.min.sql")), encoding="utf-8").read(),
        "gold": open(opt("--gold", os.path.join(HERE, "..", "gold-v11.min.sql")), encoding="utf-8").read(),
        "stocks": open(opt("--stocks", os.path.join(HERE, "..", "stocks-v11.min.sql")), encoding="utf-8").read()}
RULE = "macdx_12_26_9_w600_1h_fade96of120_in_v11"
SRULE = "stockmacd_12_26_9_w600_1h_fade96of120_in_v4"
fmt = lambda ms: dt.datetime.fromtimestamp(ms / 1000, UTC).strftime("%Y-%m-%d %H:%M")
iso = lambda ms: dt.datetime.fromtimestamp(ms / 1000, UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
SHOW = "--show" in args


def day_of(ms):
    """the GMO day [start, end) holding a bar opened at ms"""
    t = dt.datetime.fromtimestamp(ms / 1000, UTC)
    s = t.replace(hour=21, minute=0, second=0, microsecond=0)
    if t < s:
        s -= dt.timedelta(days=1)
    s = int(s.timestamp() * 1000)
    return s, s + 86400000


# production's go-live constant (README v11.1, set 2026-11-18): the bench puts its own go-live instants in its place; `raw`
# puts the marker of the form before the release back in its place (p23 / g10: a statement with the marker in does not run)
PROD_LIVE = "1795003200000::bigint"


def run(kind, change, s, e, live_p=LIVE_P, live_g=LIVE_G, raw=False):
    text = TEXT[kind].replace("{{START_MS}}", str(s)).replace("{{END_MS}}", str(e))
    if raw:
        text = text.replace(PROD_LIVE, "{{GO_LIVE_MS_PAIRS}}::bigint" if kind == "pairs" else "{{GO_LIVE_MS_GOLD}}::bigint")
    else:
        text = text.replace("{{GO_LIVE_MS_PAIRS}}", str(live_p)).replace("{{GO_LIVE_MS_GOLD}}", str(live_g))
        text = text.replace(PROD_LIVE, f"{live_p if kind == 'pairs' else live_g}::bigint")
    r = subprocess.run(BASE + ["-d", DB[kind], "-q", "-v", "ON_ERROR_STOP=1", "-At", "-F", "\x1f"], input="begin;\n" + change + "\n" + text + ";\nrollback;\n",
                       capture_output=True, text=True)
    if r.returncode:
        return None, r.stderr[:500]
    out = []
    for ln in r.stdout.strip().split("\n"):
        if ln:
            rt, inst, bar, side, verdict, data = ln.split("\x1f")
            out.append({"rt": rt, "inst": inst, "bar": bar, "side": side, "verdict": verdict, "data": json.loads(data)})
    return out, None


ex_p = json.load(open(f"{pdir}/expect.json", encoding="utf-8"))
ex_g = json.load(open(f"{gdir}/expect.json", encoding="utf-8"))
after = lambda x, live: x["bar"] >= live + 2 * 86400000  # well after go-live
okp = [x for x in ex_p if x["verdict"] == "ok" and after(x, LIVE_P)]
P = next(x for x in okp if x["pair"] != "USD/JPY")  # a pair with one follower
PB = next(x for x in okp if x["pair"] != "USD/JPY" and x["side"] == "BUY")
PS = next(x for x in okp if x["pair"] != "USD/JPY" and x["side"] == "SELL")
U = next(x for x in okp if x["pair"] == "USD/JPY")  # two followers
G = next(x for x in ex_g if x["verdict"] == "ok" and after(x, LIVE_G))
# an entry before go-live (not mailed: before_go_live), on the switch day or earlier
PL = next(x for x in ex_p if x["verdict"] == "not_mailable" and x["why"] == "before_go_live" and x["pair"] != "USD/JPY" and x["bar"] >= LIVE_P - 14 * 86400000)
entries_p = {(x["pair"], x["bar"]) for x in ex_p}


def where(x):
    return f"pair = '{x['pair']}' and bar_time = '{iso(x['bar'])}' and rule = '{RULE}'"


def line(out, x, side=None):
    for r in out:
        if r["rt"] == "LINE" and r["inst"] == x["pair"] and r["bar"] == fmt(x["bar"]) and r["side"] == (side or x["side"]):
            return r
    return None


def summary(out, inst):
    for r in out:
        if r["rt"] == "SUMMARY" and r["inst"] == inst:
            return r
    return None


def att(out, inst):
    return (summary(out, inst) or {"data": {}})["data"].get("attention") or ""


other = lambda side: "BUY" if side == "SELL" else "SELL"
results = []


def scen(name, kind, x, change, check, **kw):
    if opt("--only") and opt("--only") != name.split(" ")[0]:
        return
    s, e = day_of(x["bar"]) if x else (kw.pop("s"), kw.pop("e"))
    expect_error = kw.pop("expect_error", None)
    out, err = run(kind, change, s, e, **kw)
    if expect_error is not None:
        okk = out is None and expect_error in (err or "")
        results.append((name, okk, "" if okk else f"wanted a psql error with {expect_error!r}, got {err!r}"))
        if SHOW:
            print(f"  [{name}] psql: {(err or '').strip()[:200]}")
        return
    if out is None:
        results.append((name, False, "psql: " + err))
        return
    if SHOW:
        insts = {x["pair"]} if x else {r["inst"] for r in out if r["rt"] != "RUN"}
        for r in out:
            if r["rt"] == "LINE" and r["inst"] in insts and (x is None or r["bar"] == fmt(x["bar"])):
                keep = {k: r["data"][k] for k in ("mail_rows", "entry", "paid", "close", "entry_diff_ticks", "other_side", "stop_or_target_rows", "entries", "why") if k in r["data"]}
                print(f"  [{name}] LINE {r['inst']} {r['bar']} {r['side']} {r['verdict']} {json.dumps(keep)}")
            if r["rt"] == "SUMMARY" and r["inst"] in insts:
                print(f"  [{name}] SUMMARY {r['inst']} {r['verdict']} attention={r['data'].get('attention')}")
    try:
        why = check(out)
    except Exception as ex:  # a missing line or key is a failure, said as such
        why = f"{type(ex).__name__}: {ex}"
    results.append((name, why is None, why or ""))


def expect_line(x, verdict, side=None, **keys):
    def check(out):
        r = line(out, x, side)
        if r is None:
            return "no LINE"
        if r["verdict"] != verdict:
            return f"verdict {r['verdict']} (want {verdict}); why {r['data'].get('why')}"
        for k, v in keys.items():
            got = r["data"].get(k)
            if callable(v):
                if not v(got):
                    return f"{k} = {got!r}"
            elif got != v:
                return f"{k} = {got!r} (want {v!r})"
        return None
    return check


def no_line(x, side):
    def check(out):
        return None if line(out, x, side) is None else f"a LINE on the {side} side"
    return check


def both(*checks):
    def check(out):
        for c in checks:
            w = c(out)
            if w:
                return w
        return None
    return check


def attention_has(inst, *parts):
    def check(out):
        a = att(out, inst)
        miss = [p for p in parts if p not in a]
        v = summary(out, inst)["verdict"]
        if miss or v != "CHECK":
            return f"SUMMARY {v}, attention {a!r} (want {parts})"
        return None
    return check


def summary_ok(inst):
    def check(out):
        r = summary(out, inst)
        return None if r["verdict"] == "OK" else f"SUMMARY {r['verdict']} {r['data'].get('attention')}"
    return check


def copy_row(x, **cols):
    """a second row of x's mail with some columns changed (who u9 unless given)"""
    names = ["kind", "pair", "interval", "bar_time", "closed_at", "side", "entry", "stop", "target", "rule", "status", "sent_at", "who"]
    vals = [cols.get(n, "'u9'" if n == "who" else n) for n in names]
    return f"insert into public.signal_alerts ({', '.join(names)}) select {', '.join(str(v) for v in vals)} from public.signal_alerts where {where(x)} limit 1;"


# ---- the pairs (P: one follower; U: USD/JPY, two followers) ----
scen("p00 control: a fade entry the mail matches (the ask / bid close, no stop or target)", "pairs", P, "",
     both(expect_line(P, "ok", entry_diff_ticks=0, paid=P["price"], close=P["close"]), summary_ok(P["pair"])))
scen("p01 missing: the row deleted", "pairs", P, f"delete from public.signal_alerts where {where(P)};", both(expect_line(P, "missing"), attention_has(P["pair"], "missing=1")))
scen("p02 wrong side: the row says the other side", "pairs", P, f"update public.signal_alerts set side = '{other(P['side'])}' where {where(P)};",
     both(expect_line(P, "missing"), expect_line(P, "extra", side=other(P["side"]), why=lambda w: w and "OPPOSITE" in w), attention_has(P["pair"], "missing=1", "extra=1")))
scen("p03 wrong price: a BUY at the mid close (v8's price, not the ask close)", "pairs", PB, f"update public.signal_alerts set entry = {PB['close']!r} where {where(PB)};",
     both(expect_line(PB, "ok", entry_diff_ticks=lambda v: v is not None and v < 0), attention_has(PB["pair"], "entry_differs=1")))
scen("p04 wrong price: a SELL at the mid close (v8's price, not the bid close)", "pairs", PS, f"update public.signal_alerts set entry = {PS['close']!r} where {where(PS)};",
     both(expect_line(PS, "ok", entry_diff_ticks=lambda v: v is not None and v > 0), attention_has(PS["pair"], "entry_differs=1")))
scen("p05 wrong price: a BUY at the bid close (the other side of the book)", "pairs", PB,
     f"""update public.signal_alerts set entry = (select (x ->> 'close')::float8 from public.gmo_kline_files f, jsonb_array_elements(f.body -> 'data') x
           where f.symbol = '{PB['pair'].replace('/', '_')}' and f.price_type = 'BID' and f.interval = '1hour' and x ->> 'openTime' = '{PB['bar']}') where {where(PB)};""",
     both(expect_line(PB, "ok", entry_diff_ticks=lambda v: v is not None and v <= -2), attention_has(PB["pair"], "entry_differs=1")))
scen("p06 both sides in one bar: a row of the other side in the entry's bar", "pairs", P, copy_row(P, side=f"'{other(P['side'])}'"),
     both(expect_line(P, "ok", other_side=True, why=lambda w: w and "other_side" in w),
          expect_line(P, "extra", side=other(P["side"]), other_side=True, why=lambda w: w and "OPPOSITE" in w and "other_side" in w),
          attention_has(P["pair"], "other_side=1", "extra=1")))
scen("p07 a row with a stop", "pairs", P, f"update public.signal_alerts set stop = entry - 0.1 where {where(P)};",
     both(expect_line(P, "ok", stop_or_target_rows=1, why=lambda w: w and "stop_or_target" in w), attention_has(P["pair"], "stop_or_target=1")))
scen("p08 a row with a target", "pairs", P, f"update public.signal_alerts set target = entry + 0.1 where {where(P)};",
     both(expect_line(P, "ok", stop_or_target_rows=1), attention_has(P["pair"], "stop_or_target=1")))
scen("p09 a bar before live_ms, no mail: not_mailable before_go_live (the sim's own line)", "pairs", PL, "", both(expect_line(PL, "not_mailable", why="before_go_live")))
scen("p10 a bar before live_ms, mailed anyway", "pairs", PL,
     f"insert into public.signal_alerts (kind, pair, interval, bar_time, closed_at, side, entry, rule, status, sent_at) values ('signal', '{PL['pair']}', '1h', '{iso(PL['bar'])}', '{iso(PL['bar'] + HOUR)}', '{PL['side']}', {PL['price']!r}, '{RULE}', 'sent', '{iso(PL['bar'] + HOUR + 2000)}');",
     expect_line(PL, "ok", why="mailed although before_go_live", entry_diff_ticks=0))
scen("p11 go-live one bar after the entry, mail there", "pairs", P, "", expect_line(P, "ok", why="mailed although before_go_live"), live_p=P["bar"] + HOUR)
scen("p12 go-live one bar after the entry, no mail", "pairs", P, f"delete from public.signal_alerts where {where(P)};", expect_line(P, "not_mailable", why="before_go_live"),
     live_p=P["bar"] + HOUR)
scen("p13 go-live at the entry's bar: due", "pairs", P, f"delete from public.signal_alerts where {where(P)};", expect_line(P, "missing"), live_p=P["bar"])
scen("p14 not_sent: status failed", "pairs", P, f"update public.signal_alerts set status = 'failed' where {where(P)};",
     both(expect_line(P, "not_sent", mail_status="failed"), attention_has(P["pair"], "not_sent_rows=1")))
scen("p15 dup: a second row for one follower", "pairs", P, copy_row(P), both(expect_line(P, "dup", mail_rows=2), attention_has(P["pair"], "dup=1")))
nb = next(b for b in range(P["bar"] + HOUR, P["bar"] + 40 * HOUR, HOUR) if (P["pair"], b) not in entries_p and dt.datetime.fromtimestamp(b / 1000, UTC).weekday() < 4)
NB = dict(P, bar=nb)
scen("p16 extra: a row at a bar with no entry", "pairs", NB,
     f"insert into public.signal_alerts (kind, pair, interval, bar_time, closed_at, side, entry, rule, status, sent_at) values ('signal', '{P['pair']}', '1h', '{iso(nb)}', '{iso(nb + HOUR)}', 'SELL', 1, '{RULE}', 'sent', '{iso(nb + HOUR + 2000)}');",
     both(expect_line(NB, "extra", side="SELL", why=lambda w: w and "recount" in w), attention_has(P["pair"], "extra=1")))
scen("p17 a v9 ride row (_in_v9, the switch day's rows) in the day: counted, not compared", "pairs", P,
     f"insert into public.signal_alerts (kind, pair, interval, bar_time, closed_at, side, entry, rule, status) values ('signal', '{P['pair']}', '1h', '{iso(P['bar'] - HOUR)}', '{iso(P['bar'])}', 'BUY', 1, 'macdx_12_26_9_w600_1h_ride90to96of120_in_v9', 'sent');",
     both(expect_line(P, "ok"), attention_has(P["pair"], "other_macdx_1h_rule_rows=1")))
scen("p18 the mail under v8's id (a renamed rule): missing, and counted", "pairs", P, f"update public.signal_alerts set rule = 'macdx_12_26_9_w600_1h_z95of120_v8' where {where(P)};",
     both(expect_line(P, "missing"), attention_has(P["pair"], "missing=1", "other_macdx_1h_rule_rows=1")))
scen("p19 no subscription, mail there", "pairs", P, f"delete from public.signal_alert_subscriptions where pair = '{P['pair']}';",
     both(expect_line(P, "ok", why="mailed although no_subscription"), attention_has(P["pair"], "no_subscription_row")))
scen("p20 no subscription, no mail", "pairs", P, f"delete from public.signal_alert_subscriptions where pair = '{P['pair']}'; delete from public.signal_alerts where {where(P)};",
     expect_line(P, "not_mailable", why="no_subscription"))
scen("p21 USD/JPY: one of two followers' rows deleted (one row is enough: a limit)", "pairs", U, f"delete from public.signal_alerts where {where(U)} and who = 'u2';",
     both(expect_line(U, "ok", mail_rows=1), summary_ok("USD/JPY")))
scen("p22 USD/JPY: both rows, two followers: ok", "pairs", U, "", both(expect_line(U, "ok", mail_rows=2), summary_ok("USD/JPY")))
scen("p23 the go-live marker left in: the statement does not run", "pairs", P, "", None, raw=True, expect_error="syntax error")
# ---- gold ----
scen("g00 control: as production left it (the close)", "gold", G, "", both(expect_line(G, "ok", entry_diff_ticks=0, paid=G["close"], close=G["close"]), summary_ok("XAU/USD")))
scen("g01 missing", "gold", G, f"delete from public.signal_alerts where {where(G)};", both(expect_line(G, "missing"), attention_has("XAU/USD", "missing=1")))
scen("g02 wrong side", "gold", G, f"update public.signal_alerts set side = '{other(G['side'])}' where {where(G)};",
     both(expect_line(G, "missing"), expect_line(G, "extra", side=other(G["side"]), why=lambda w: w and "OPPOSITE" in w)))
scen("g03 entry one cent above the close", "gold", G, f"update public.signal_alerts set entry = entry + 0.01 where {where(G)};",
     both(expect_line(G, "ok", entry_diff_ticks=1), attention_has("XAU/USD", "entry_differs=1")))
scen("g04 entry 0.4 cent above the close (a limit: under half a tick, not seen)", "gold", G, f"update public.signal_alerts set entry = entry + 0.004 where {where(G)};",
     both(expect_line(G, "ok", entry_diff_ticks=0), summary_ok("XAU/USD")))
scen("g05 both sides in one bar", "gold", G, copy_row(G, side=f"'{other(G['side'])}'", who="'u2'"),
     both(expect_line(G, "ok", other_side=True), expect_line(G, "extra", side=other(G["side"]), other_side=True), attention_has("XAU/USD", "other_side=1")))
scen("g06 a row with a stop", "gold", G, f"update public.signal_alerts set stop = entry - 5 where {where(G)};",
     both(expect_line(G, "ok", stop_or_target_rows=1), attention_has("XAU/USD", "stop_or_target=1")))
scen("g07 Twelve Data cap reached that day, mail there", "gold", G,
     f"insert into public.twelve_data_usage (day, used) values ((timestamptz '{iso(G['bar'] + HOUR)}' at time zone 'UTC')::date, 780);",
     expect_line(G, "ok", why="mailed although twelve_daily_cap"))
scen("g08 Twelve Data cap reached, no mail", "gold", G,
     f"insert into public.twelve_data_usage (day, used) values ((timestamptz '{iso(G['bar'] + HOUR)}' at time zone 'UTC')::date, 780); delete from public.signal_alerts where {where(G)};",
     expect_line(G, "not_mailable", why="twelve_daily_cap"))
scen("g09 go-live one bar after the entry, no mail", "gold", G, f"delete from public.signal_alerts where {where(G)};", expect_line(G, "not_mailable", why="before_go_live"),
     live_g=G["bar"] + HOUR)
scen("g10 the go-live marker left in: the statement does not run", "gold", G, "", None, raw=True, expect_error="syntax error")
# ---- the shares (no recount: rows only); a New York share's 1-hour bar on a weekday of the bench: 2026-12-02 09:30 New York (14:30 UTC) to 10:30 ----
S0 = int(dt.datetime(2026, 12, 2, 14, 30, tzinfo=UTC).timestamp() * 1000)
SS, SE = day_of(S0)
SH = {"pair": "AAPL", "bar": S0, "side": "SELL"}


def srow(side="SELL", entry=231.45, who="u1", bar=S0, closed=None, interval="1h", status="sent", stop="null", target="null", rule=SRULE):
    closed = bar + HOUR if closed is None else closed
    return (f"insert into public.signal_alerts (kind, pair, interval, bar_time, closed_at, side, entry, stop, target, rule, status, sent_at, who) values "
            f"('signal', 'AAPL', '{interval}', '{iso(bar)}', '{iso(closed)}', '{side}', {entry}, {stop}, {target}, '{rule}', '{status}', '{iso(closed + 61000)}', '{who}');")


SUBS = "insert into public.signal_alert_subscriptions (who, pair, interval, rule) values ('u1', 'AAPL', '1h', 'stockmacd'), ('u2', 'AAPL', '1h', 'stockmacd');"
CLEAN = SUBS + srow() + srow(who="u2")
scen("s00 control: two followers, one side, one entry, no stop or target", "stocks", None, CLEAN,
     both(expect_line(SH, "ok", mail_rows=2, entries=1, subscriptions=2), summary_ok("AAPL")), s=SS, e=SE)
scen("s01 both sides in one bar (other_side)", "stocks", None, CLEAN + srow(side="BUY", who="u3"),
     both(expect_line(SH, "check", side="BUY,SELL", why=lambda w: w and "other_side" in w), attention_has("AAPL", "other_side=1")), s=SS, e=SE)
scen("s02 two entries in one bar (entries_differ)", "stocks", None, SUBS + srow() + srow(who="u2", entry=231.47),
     both(expect_line(SH, "check", entries=2, why=lambda w: w and "entries_differ" in w), attention_has("AAPL", "entries_differ=1")), s=SS, e=SE)
scen("s03 a row with a target (stop_or_target)", "stocks", None, SUBS + srow() + srow(who="u2", target=232),
     both(expect_line(SH, "check", stop_or_target_rows=1), attention_has("AAPL", "stop_or_target=1")), s=SS, e=SE)
scen("s04 a row with a stop (stop_or_target)", "stocks", None, SUBS + srow() + srow(who="u2", stop=230),
     both(expect_line(SH, "check", stop_or_target_rows=1), attention_has("AAPL", "stop_or_target=1")), s=SS, e=SE)
scen("s05 interval not 1h", "stocks", None, SUBS + srow() + srow(who="u2", interval="15min"),
     both(expect_line(SH, "check", interval_not_1h_rows=1), attention_has("AAPL", "interval_not_1h=1")), s=SS, e=SE)
scen("s06 closed_at two hours after the open", "stocks", None, SUBS + srow() + srow(who="u2", closed=S0 + 2 * HOUR),
     both(expect_line(SH, "check", closed_at_not_within_1h_rows=1), attention_has("AAPL", "closed_at_not_within_1h=1")), s=SS, e=SE)
S1 = S0 + 6 * HOUR  # 15:30 New York: the half bar, closed at 16:00
scen("s07 New York's 15:30 bar closed 30 minutes after its open: ok", "stocks", None, SUBS + srow(bar=S1, closed=S1 + HOUR // 2) + srow(bar=S1, closed=S1 + HOUR // 2, who="u2"),
     both(expect_line(dict(SH, bar=S1), "ok", mail_rows=2), summary_ok("AAPL")), s=SS, e=SE)
scen("s08 not_sent", "stocks", None, SUBS + srow() + srow(who="u2", status="failed"),
     both(expect_line(SH, "check", why="not_sent"), attention_has("AAPL", "not_sent_rows=1")), s=SS, e=SE)
scen("s09 dup", "stocks", None, CLEAN + srow(who="u3"), both(expect_line(SH, "check", why="dup"), attention_has("AAPL", "dup=1")), s=SS, e=SE)
scen("s10 a v9 ride row of the share (other id) in the day", "stocks", None, CLEAN + srow(rule="stockmacd_12_26_9_w600_1h_ride90to96of120_in_v2", bar=S0 - HOUR),
     both(expect_line(SH, "ok"), attention_has("AAPL", "other_stockmacd_rule_rows=1")), s=SS, e=SE)
scen("s11 a row, nobody follows", "stocks", None, srow(), both(expect_line(SH, "ok", subscriptions=0), attention_has("AAPL", "no_subscription_row")), s=SS, e=SE)
scen("s12 a row of the day before: not in this day", "stocks", None, SUBS + srow(bar=SS - HOUR),
     lambda out: None if not [r for r in out if r["rt"] != "RUN"] else f"rows {[(r['rt'], r['inst'], r['bar']) for r in out]}", s=SS, e=SE)

npass = sum(1 for _, okk, _ in results if okk)
for name, okk, why in results:
    print(("PASS " if okk else "FAIL ") + name + ("" if okk else ": " + why))
print(f"scenarios {len(results)}, passed {npass}, failed {len(results) - npass}")
sys.exit(0 if npass == len(results) else 1)
