#!/usr/bin/env python3
"""Local test bench of morning-check v12 (README.md v12.4): rows changed on purpose (scen11.py on 15-minute bars, with the switch day). Each scenario changes rows inside a
transaction, runs one statement (pairs-v12, gold-v12 or stocks-v12) for one GMO day, checks its answer, and rolls back. The data folders must already be loaded
(check12.py --load: the pairs into --dbp, gold into --dbg).
The pairs are USD/JPY and AUD/USD only (research/macdfade15min-prod-spec.md 7.3, the per-pair form: sim12.ts follows those two; pairs-v12's syms holds those two). The
weekend scenarios p33, p34 (an entry of AUD/USD in the weekend window) and p37 (an entry on a Friday bar opened 20:00 to 20:30) FAIL, not skip, when the data folder's walk
has no such entry: pick a first seed that has both (run12.sh's default, seed 5, does; seed 1 has neither in the two-pair walk). p21 also needs, on the switch day (key
20261125), an entry before live_ms and one from it (seed 5 has both; seed 3 has the weekend kinds but no entry from live_ms that day).

usage: python3 -I scen12.py PAIRS_DATADIR GOLD_DATADIR [--dbp NAME] [--dbg NAME] [--pairs FILE] [--gold FILE] [--stocks FILE] [--only NAME] [--show] [--jobs N]
Prints one line per scenario (PASS / FAIL and why) and the count; with --show also the LINE / SUMMARY rows each scenario is about. Exit 1 on any FAIL.
--jobs: how many scenarios run at once (default 4; each in its own transaction, rolled back, so they do not see each other's rows).
"""
import concurrent.futures
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
BASE = shlex.split(os.environ.get("MC_PSQL", "psql -h 127.0.0.1 -p 54361 -U postgres"))
DB = {"pairs": opt("--dbp", "mc12p"), "stocks": opt("--dbp", "mc12p"), "gold": opt("--dbg", "mc12g")}
UTC = dt.timezone.utc
M15 = 900000
HOUR = 3600000
ms_of = lambda *a: int(dt.datetime(*a, tzinfo=UTC).timestamp() * 1000)
# the bench's constants (as sim12.ts and check12.py): the pairs first judge the bar opened 10:00 on Wednesday 2026-11-25 (the switch day, GMO key 20261125), gold the bar
# opened 09:45 (one bar earlier); v40's last judged 1-hour bar ended at 10:00 for all six (so the pairs switch cleanly and gold has one bar judged by both forms)
LIVE_P, LIVE_G = ms_of(2026, 11, 25, 10), ms_of(2026, 11, 25, 9, 45)
END_P = END_G = ms_of(2026, 11, 25, 10)
SW_S, SW_E = ms_of(2026, 11, 24, 21), ms_of(2026, 11, 25, 21)
TEXT = {"pairs": open(opt("--pairs", os.path.join(HERE, "..", "pairs-v12.min.sql")), encoding="utf-8").read(),
        "gold": open(opt("--gold", os.path.join(HERE, "..", "gold-v12.min.sql")), encoding="utf-8").read(),
        "stocks": open(opt("--stocks", os.path.join(HERE, "..", "stocks-v12.min.sql")), encoding="utf-8").read()}
RULE = "macdx_12_26_9_w600_15min_fade96of120_in_v12"
RULE_V11 = "macdx_12_26_9_w600_1h_fade96of120_in_v11"
SRULE = "stockmacd_12_26_9_w600_15min_fade96of120_in_v5"
SRULE_V11 = "stockmacd_12_26_9_w600_1h_fade96of120_in_v4"
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


def run(kind, change, s, e, live_p=LIVE_P, live_g=LIVE_G, end_p=END_P, end_g=END_G, keep=()):
    """keep: the markers left in the text (the statement before the release: it must not run)"""
    text = TEXT[kind].replace("{{START_MS}}", str(s)).replace("{{END_MS}}", str(e))
    for mk, v in (("GO_LIVE_MS_PAIRS", live_p), ("GO_LIVE_MS_GOLD", live_g), ("END_1H_MS_PAIRS", end_p), ("END_1H_MS_GOLD", end_g)):
        if mk not in keep:
            text = text.replace("{{" + mk + "}}", str(v))
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
# an entry on a bar that closes in the weekend window (Friday from 21:00 UTC), if the seed has one
PW = next((x for x in ex_p if x["why"] == "weekend_window" and x["pair"] != "USD/JPY"), None)
entries_p = {(x["pair"], x["bar"]) for x in ex_p}


def where(x, rule=RULE):
    return f"pair = '{x['pair']}' and bar_time = '{iso(x['bar'])}' and rule = '{rule}'"


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
tasks = []


def scen(name, kind, x, change, check, **kw):
    """queues one scenario; they run at the end, --jobs at a time, and are told in this order"""
    if opt("--only") and opt("--only") != name.split(" ")[0]:
        return
    tasks.append(lambda: scen_run(name, kind, x, change, check, **kw))


def scen_run(name, kind, x, change, check, **kw):
    """runs one scenario: (name, passed, why, the lines --show prints)"""
    shown = []
    s, e = day_of(x["bar"]) if x else (kw.pop("s"), kw.pop("e"))
    expect_error = kw.pop("expect_error", None)
    out, err = run(kind, change, s, e, **kw)
    if expect_error is not None:
        okk = out is None and expect_error in (err or "")
        shown.append(f"  [{name}] psql: {(err or '').strip()[:200]}")
        return name, okk, "" if okk else f"wanted a psql error with {expect_error!r}, got {err!r}", shown
    if out is None:
        return name, False, "psql: " + err, shown
    insts = {x["pair"]} if x else {r["inst"] for r in out if r["rt"] != "RUN"}
    for r in out:
        if r["rt"] == "LINE" and r["inst"] in insts and (x is None or r["bar"] == fmt(x["bar"])):
            keep = {k: r["data"][k] for k in ("mail_rows", "entry", "paid", "close", "entry_diff_ticks", "other_side", "stop_or_target_rows", "entries", "why") if k in r["data"]}
            shown.append(f"  [{name}] LINE {r['inst']} {r['bar']} {r['side']} {r['verdict']} {json.dumps(keep)}")
        if r["rt"] == "SUMMARY" and r["inst"] in insts:
            sw = {k: r["data"].get(k) for k in ("switch_gap_bars", "switch_overlap_bars", "macdx_1h_rows_after_end_1h") if r["data"].get(k)}
            shown.append(f"  [{name}] SUMMARY {r['inst']} {r['verdict']} attention={r['data'].get('attention')}{' ' + json.dumps(sw) if sw else ''}")
        if r["rt"] == "RUN" and kind == "stocks":
            shown.append(f"  [{name}] RUN {json.dumps({k: v for k, v in r['data'].items() if 'subscri' in k or 'shares' in k})}")
    try:
        why = check(out)
    except Exception as ex:  # a missing line or key is a failure, said as such
        why = f"{type(ex).__name__}: {ex}"
    return name, why is None, why or "", shown


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


def both(*checks):
    def check(out):
        for c in checks:
            w = c(out)
            if w:
                return w
        return None
    return check


def attention_has(inst, *parts, lacks=()):
    def check(out):
        a = att(out, inst)
        miss = [p for p in parts if p not in a]
        extra = [p for p in lacks if p in a]
        v = summary(out, inst)["verdict"]
        if miss or extra or v != "CHECK":
            return f"SUMMARY {v}, attention {a!r} (want {parts}, without {lacks})"
        return None
    return check


def summary_ok(inst):
    def check(out):
        r = summary(out, inst)
        return None if r["verdict"] == "OK" else f"SUMMARY {r['verdict']} {r['data'].get('attention')}"
    return check


def summary_has(inst, **keys):
    def check(out):
        d = summary(out, inst)["data"]
        bad = {k: d.get(k) for k, v in keys.items() if d.get(k) != v}
        return None if not bad else f"SUMMARY {inst} {bad} (want {keys})"
    return check


def run_has(**keys):
    def check(out):
        d = next(r for r in out if r["rt"] == "RUN")["data"]
        bad = {k: d.get(k) for k, v in keys.items() if d.get(k) != v}
        return None if not bad else f"RUN {bad} (want {keys})"
    return check


def only_insts(want):
    """the SUMMARY and LINE rows of the answer are of these instruments only (pairs-v12: USD/JPY and AUD/USD)"""
    def check(out):
        got = {r["inst"] for r in out if r["rt"] != "RUN"}
        return None if got == want else f"instruments {sorted(got)} (want {sorted(want)})"
    return check


def no_case(name, why):
    """a scenario the data folder cannot give: told as a FAIL, not skipped (research/macdfade15min-prod-spec.md 7.3, the weekend scenarios must still run)"""
    if opt("--only") and opt("--only") != name.split(" ")[0]:
        return
    tasks.append(lambda: (name, False, why + ": run the bench with a first seed that has it (README.md v12.4; run12.sh's default seed 5)", []))


def copy_row(x, **cols):
    """a second row of x's mail with some columns changed (who u9 unless given)"""
    names = ["kind", "pair", "interval", "bar_time", "closed_at", "side", "entry", "stop", "target", "rule", "status", "sent_at", "who"]
    vals = [cols.get(n, "'u9'" if n == "who" else n) for n in names]
    return f"insert into public.signal_alerts ({', '.join(names)}) select {', '.join(str(v) for v in vals)} from public.signal_alerts where {where(x)} limit 1;"


def row1h(pair, bar, rule=RULE_V11, side="SELL", entry=1):
    """a 1-hour macdx row (v40's fade rows, or another id) of the bar opened at `bar`"""
    return (f"insert into public.signal_alerts (kind, pair, interval, bar_time, closed_at, side, entry, rule, status, sent_at) values ('signal', '{pair}', '1h', "
            f"'{iso(bar)}', '{iso(bar + HOUR)}', '{side}', {entry}, '{rule}', 'sent', '{iso(bar + HOUR + 2000)}');")


# ---- the pairs (P: AUD/USD, one follower; U: USD/JPY, two followers) ----
scen("p00 control: a fade entry the mail matches (the ask / bid close, no stop or target)", "pairs", P, "",
     both(expect_line(P, "ok", entry_diff_ticks=0, paid=P["price"], close=P["close"]), summary_ok(P["pair"]),
          summary_has(P["pair"], switch_gap_bars=0, switch_overlap_bars=0, macdx_1h_rows_after_end_1h=0, go_live_utc=fmt(LIVE_P), end_1h_utc=fmt(END_P)),
          run_has(macdx_15min_rows_other_pairs=0), only_insts({"USD/JPY", "AUD/USD"})))
scen("p01 missing: the row deleted", "pairs", P, f"delete from public.signal_alerts where {where(P)};", both(expect_line(P, "missing"), attention_has(P["pair"], "missing=1")))
scen("p02 wrong side: the row says the other side", "pairs", P, f"update public.signal_alerts set side = '{other(P['side'])}' where {where(P)};",
     both(expect_line(P, "missing"), expect_line(P, "extra", side=other(P["side"]), why=lambda w: w and "OPPOSITE" in w), attention_has(P["pair"], "missing=1", "extra=1")))
scen("p03 wrong price: a BUY at the mid close (not the ask close)", "pairs", PB, f"update public.signal_alerts set entry = {PB['close']!r} where {where(PB)};",
     both(expect_line(PB, "ok", entry_diff_ticks=lambda v: v is not None and v < 0), attention_has(PB["pair"], "entry_differs=1")))
scen("p04 wrong price: a SELL at the mid close (not the bid close)", "pairs", PS, f"update public.signal_alerts set entry = {PS['close']!r} where {where(PS)};",
     both(expect_line(PS, "ok", entry_diff_ticks=lambda v: v is not None and v > 0), attention_has(PS["pair"], "entry_differs=1")))
scen("p05 wrong price: a BUY at the bid close of the 15-minute file (the other side of the book)", "pairs", PB,
     f"""update public.signal_alerts set entry = (select (x ->> 'close')::float8 from public.gmo_kline_files f, jsonb_array_elements(f.body -> 'data') x
           where f.symbol = '{PB['pair'].replace('/', '_')}' and f.price_type = 'BID' and f.interval = '15min' and x ->> 'openTime' = '{PB['bar']}') where {where(PB)};""",
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
     f"insert into public.signal_alerts (kind, pair, interval, bar_time, closed_at, side, entry, rule, status, sent_at) values ('signal', '{PL['pair']}', '15min', '{iso(PL['bar'])}', '{iso(PL['bar'] + M15)}', '{PL['side']}', {PL['price']!r}, '{RULE}', 'sent', '{iso(PL['bar'] + M15 + 2000)}');",
     expect_line(PL, "ok", why="mailed although before_go_live", entry_diff_ticks=0))
scen("p11 go-live one bar after the entry, mail there", "pairs", P, "", expect_line(P, "ok", why="mailed although before_go_live"), live_p=P["bar"] + M15)
scen("p12 go-live one bar after the entry, no mail", "pairs", P, f"delete from public.signal_alerts where {where(P)};", expect_line(P, "not_mailable", why="before_go_live"),
     live_p=P["bar"] + M15)
scen("p13 go-live at the entry's bar: due", "pairs", P, f"delete from public.signal_alerts where {where(P)};", expect_line(P, "missing"), live_p=P["bar"])
scen("p14 not_sent: status failed", "pairs", P, f"update public.signal_alerts set status = 'failed' where {where(P)};",
     both(expect_line(P, "not_sent", mail_status="failed"), attention_has(P["pair"], "not_sent_rows=1")))
scen("p15 dup: a second row for one follower", "pairs", P, copy_row(P), both(expect_line(P, "dup", mail_rows=2), attention_has(P["pair"], "dup=1")))
nb = next(b for b in range(P["bar"] + M15, P["bar"] + 700 * M15, M15) if (P["pair"], b) not in entries_p and dt.datetime.fromtimestamp(b / 1000, UTC).weekday() < 4)
NB = dict(P, bar=nb)
scen("p16 extra: a row at a bar with no entry", "pairs", NB,
     f"insert into public.signal_alerts (kind, pair, interval, bar_time, closed_at, side, entry, rule, status, sent_at) values ('signal', '{P['pair']}', '15min', '{iso(nb)}', '{iso(nb + M15)}', 'SELL', 1, '{RULE}', 'sent', '{iso(nb + M15 + 2000)}');",
     both(expect_line(NB, "extra", side="SELL", why=lambda w: w and "recount" in w), attention_has(P["pair"], "extra=1")))
# ---- the switch day (GMO key 20261125: v40 judged the 1-hour bars up to the one that ended at 10:00 UTC, v41 the 15-minute bars from 10:00) ----
# SP: a pair that switches (spec 7.3: EUR/JPY no longer does; AUD/USD, one follower)
SP = "AUD/USD"
scen("p17 switch day: v40's 1-hour fade row of the bar 09:00-10:00 (ended at end_1h_ms): counted, expected, not late", "pairs", None, row1h(SP, END_P - HOUR),
     both(attention_has(SP, "other_macdx_1h_rule_rows=1", lacks=("macdx_1h_rows_after_end_1h",)), summary_has(SP, macdx_1h_rows_after_end_1h=0)), s=SW_S, e=SW_E)
scen("p18 switch day: a 1-hour fade row of the bar 10:00-11:00 (after end_1h_ms): counted and late", "pairs", None, row1h(SP, END_P),
     both(attention_has(SP, "other_macdx_1h_rule_rows=1", "macdx_1h_rows_after_end_1h=1"), summary_has(SP, macdx_1h_rows_after_end_1h=1)), s=SW_S, e=SW_E)
scen("p19 switch day: v40's rows before (03:00, 08:00) and one after (12:00): 3 counted, 1 late", "pairs", None,
     row1h(SP, END_P - 7 * HOUR) + row1h(SP, END_P - 2 * HOUR, side="BUY") + row1h(SP, END_P + 2 * HOUR),
     both(attention_has(SP, "other_macdx_1h_rule_rows=3", "macdx_1h_rows_after_end_1h=1")), s=SW_S, e=SW_E)
scen("p20 the day after the switch: any 1-hour macdx row is late", "pairs", P, row1h(P["pair"], P["bar"] - P["bar"] % HOUR),
     both(expect_line(P, "ok"), attention_has(P["pair"], "other_macdx_1h_rule_rows=1", "macdx_1h_rows_after_end_1h=1")))


def switch_lines(out):
    """on the switch day: every not_mailable line is a bar opened before live_ms (before_go_live), every bar from live_ms on is ok, and there are both"""
    ls = [r for r in out if r["rt"] == "LINE"]
    nm = [r for r in ls if r["verdict"] == "not_mailable"]
    okl = [r for r in ls if r["verdict"] == "ok"]
    bad = [(r["inst"], r["bar"], r["verdict"], r["data"].get("why")) for r in ls
           if (r["bar"] < fmt(LIVE_P)) != (r["verdict"] == "not_mailable") or (r["verdict"] == "not_mailable" and r["data"].get("why") != "before_go_live")]
    why = "" if nm and okl else " (the data's switch day lacks an entry " + ("before live_ms and one " if not nm and not okl else "before live_ms" if not nm else "from live_ms") + ": pick a first seed that has both)"
    return None if nm and okl and not bad and len(nm) + len(okl) == len(ls) else f"lines {[(r['inst'], r['bar'], r['verdict']) for r in ls]}; bad {bad}{why}"


scen("p21 switch day: the entries before live_ms are before_go_live, those from it ok (the sim's lines), no gap, no overlap", "pairs", None, "",
     both(switch_lines, summary_has(SP, switch_gap_bars=0, switch_overlap_bars=0)), s=SW_S, e=SW_E)
scen("p22 switch day with a gap: v41 first judged the bar opened 10:30 (live_ms 30 minutes after end_1h_ms): 2 bars judged by neither", "pairs", None, "",
     both(summary_has(SP, switch_gap_bars=2, switch_overlap_bars=0, go_live_utc="2026-11-25 10:30", end_1h_utc="2026-11-25 10:00"), summary_ok("USD/JPY")),
     s=SW_S, e=SW_E, live_p=END_P + 2 * M15)
scen("p23 switch day with an overlap: v41 first judged the bar opened 09:45 (live_ms before end_1h_ms): 1 bar judged by both", "pairs", None, "",
     both(summary_has(SP, switch_gap_bars=0, switch_overlap_bars=1), summary_ok(SP)), s=SW_S, e=SW_E, live_p=END_P - M15)
scen("p24 switch day: the 15-minute day files of the two keys before it missing for one pair (not stored before v41's first read): history_files_missing", "pairs", None,
     f"delete from public.gmo_kline_files where symbol = '{SP.replace('/', '_')}' and interval = '15min' and date_key in ('20261123', '20261124');",
     attention_has(SP, "history_files_missing=4"), s=SW_S, e=SW_E)
scen("p25 the mail under v40's id on the 1-hour chart (a renamed rule): missing, counted, late", "pairs", P,
     f"update public.signal_alerts set rule = '{RULE_V11}', interval = '1h' where {where(P)};",
     both(expect_line(P, "missing"), attention_has(P["pair"], "missing=1", "other_macdx_1h_rule_rows=1", "macdx_1h_rows_after_end_1h=1")))
scen("p26 the mail under the new id on the 1-hour chart (the wrong interval): missing, counted (v7's reading of the other rows)", "pairs", P,
     f"update public.signal_alerts set interval = '1h' where {where(P)};",
     both(expect_line(P, "missing"), attention_has(P["pair"], "missing=1", "other_macdx_1h_rule_rows=1")))
scen("p27 a 15-minute row of v7's id in the day: counted, not late", "pairs", P,
     f"update public.signal_alerts set rule = 'macdx_12_26_9_w600_15min_z95of120_v7' where {where(P)};",
     both(expect_line(P, "missing"), attention_has(P["pair"], "missing=1", "other_macdx_1h_rule_rows=1", lacks=("macdx_1h_rows_after_end_1h",))))
scen("p28 no subscription, mail there", "pairs", P, f"delete from public.signal_alert_subscriptions where pair = '{P['pair']}';",
     both(expect_line(P, "ok", why="mailed although no_subscription"), attention_has(P["pair"], "no_subscription_row")))
scen("p29 no subscription, no mail", "pairs", P, f"delete from public.signal_alert_subscriptions where pair = '{P['pair']}'; delete from public.signal_alerts where {where(P)};",
     expect_line(P, "not_mailable", why="no_subscription"))
scen("p30 only the '1h' row of the follower (its '15min' twin missing): no subscription for v12", "pairs", P,
     f"update public.signal_alert_subscriptions set interval = '1h' where pair = '{P['pair']}';",
     both(expect_line(P, "ok", why="mailed although no_subscription"), attention_has(P["pair"], "no_subscription_row")))
scen("p31 USD/JPY: one of two followers' rows deleted (one row is enough: a limit)", "pairs", U, f"delete from public.signal_alerts where {where(U)} and who = 'u2';",
     both(expect_line(U, "ok", mail_rows=1), summary_ok("USD/JPY")))
scen("p32 USD/JPY: both rows, two followers: ok", "pairs", U, "", both(expect_line(U, "ok", mail_rows=2), summary_ok("USD/JPY")))
if PW:
    scen("p33 a bar that closes in the weekend window (Friday 21:00 UTC), mailed anyway: ok, said", "pairs", PW,
         f"insert into public.signal_alerts (kind, pair, interval, bar_time, closed_at, side, entry, rule, status, sent_at) values ('signal', '{PW['pair']}', '15min', '{iso(PW['bar'])}', '{iso(PW['bar'] + M15)}', '{PW['side']}', {PW['price']!r}, '{RULE}', 'sent', '{iso(PW['bar'] + M15 + 2000)}');",
         expect_line(PW, "ok", why="mailed although weekend_window"))
    scen("p34 the same bar, no mail: not_mailable weekend_window", "pairs", PW, "", expect_line(PW, "not_mailable", why="weekend_window"))
else:
    no_case("p33 a bar that closes in the weekend window (Friday 21:00 UTC), mailed anyway: ok, said", "the data has no weekend_window entry of a pair other than USD/JPY after go-live")
    no_case("p34 the same bar, no mail: not_mailable weekend_window", "the data has no weekend_window entry of a pair other than USD/JPY after go-live")
# an entry on a Friday bar that closes before 21:00 UTC (opened 20:00 to 20:30): production judges it (the weekend gate starts at Friday 21:00), if the seed has one
PF = next((x for x in ex_p if dt.datetime.fromtimestamp(x["bar"] / 1000, UTC).weekday() == 4 and 1200 <= dt.datetime.fromtimestamp(x["bar"] / 1000, UTC).hour * 60
           + dt.datetime.fromtimestamp(x["bar"] / 1000, UTC).minute <= 1230), None)
if PF:
    scen("p37 a Friday bar that closes before 21:00 UTC, go-live before it, no mail: missing (judged by production, not weekend_window)", "pairs", PF,
         f"delete from public.signal_alerts where {where(PF)};", expect_line(PF, "missing"), live_p=PF["bar"] - M15)
else:
    no_case("p37 a Friday bar that closes before 21:00 UTC, go-live before it, no mail: missing (judged by production, not weekend_window)",
            "the data has no entry on a Friday bar opened 20:00 to 20:30 UTC")
# the RUN row's count of the day's 15-minute macdx rows of a pair NOT in pairs-v12's syms (research/macdfade15min-prod-spec.md 7.3, "A blind spot closed"): 0 on a clean day
# (p00), and here a stray row of EUR/JPY under the v12 id and one of gold under v7's 15-minute id (both counted: 2) beside a 1-hour row of EUR/USD (v40's id: not counted)
# and a 15-minute row of AUD/USD of another id (a pair in syms: counted in its own SUMMARY, not here)
scen("p38 stray 15-minute macdx rows of EUR/JPY and gold in the day: RUN macdx_15min_rows_other_pairs 2 (a 1-hour row of EUR/USD and AUD/USD's own rows not counted)", "pairs", P,
     f"insert into public.signal_alerts (kind, pair, interval, bar_time, closed_at, side, entry, rule, status, sent_at) values ('signal', 'EUR/JPY', '15min', '{iso(P['bar'])}', '{iso(P['bar'] + M15)}', 'SELL', 1, '{RULE}', 'sent', '{iso(P['bar'] + M15 + 2000)}');"
     f"insert into public.signal_alerts (kind, pair, interval, bar_time, closed_at, side, entry, rule, status, sent_at) values ('signal', 'XAU/USD', '15min', '{iso(P['bar'])}', '{iso(P['bar'] + M15)}', 'BUY', 1, 'macdx_12_26_9_w600_15min_z95of120_v7', 'sent', '{iso(P['bar'] + M15 + 2000)}');"
     + row1h("EUR/USD", P["bar"] - P["bar"] % HOUR)
     + f"insert into public.signal_alerts (kind, pair, interval, bar_time, closed_at, side, entry, rule, status, sent_at) values ('signal', 'AUD/USD', '15min', '{iso(P['bar'])}', '{iso(P['bar'] + M15)}', '{P['side']}', 1, 'macdx_12_26_9_w600_15min_z95of120_v7', 'sent', '{iso(P['bar'] + M15 + 2000)}');",
     both(run_has(macdx_15min_rows_other_pairs=2), expect_line(P, "ok"), attention_has(P["pair"], "other_macdx_1h_rule_rows=1"), only_insts({"USD/JPY", "AUD/USD"})))
scen("p35 the go-live marker left in: the statement does not run", "pairs", P, "", None, keep=("GO_LIVE_MS_PAIRS",), expect_error="syntax error")
scen("p36 the end_1h marker left in: the statement does not run", "pairs", P, "", None, keep=("END_1H_MS_PAIRS",), expect_error="syntax error")
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
     f"insert into public.twelve_data_usage (day, used) values ((timestamptz '{iso(G['bar'] + M15)}' at time zone 'UTC')::date, 780);",
     expect_line(G, "ok", why="mailed although twelve_daily_cap"))
scen("g08 Twelve Data cap reached, no mail", "gold", G,
     f"insert into public.twelve_data_usage (day, used) values ((timestamptz '{iso(G['bar'] + M15)}' at time zone 'UTC')::date, 780); delete from public.signal_alerts where {where(G)};",
     expect_line(G, "not_mailable", why="twelve_daily_cap"))
scen("g09 go-live one bar after the entry, no mail", "gold", G, f"delete from public.signal_alerts where {where(G)};", expect_line(G, "not_mailable", why="before_go_live"),
     live_g=G["bar"] + M15)
scen("g10 switch day: gold's overlap (live_ms 09:45, end_1h_ms 10:00): one bar judged by both forms, told, not a finding", "gold", None, "",
     both(summary_has("XAU/USD", switch_overlap_bars=1, switch_gap_bars=0, go_live_utc="2026-11-25 09:45", end_1h_utc="2026-11-25 10:00"), summary_ok("XAU/USD")),
     s=SW_S, e=SW_E)
scen("g11 switch day: v40's gold rows of 08:00 and 09:00 (before end_1h_ms) and of 10:00 (after): 3 counted, 1 late", "gold", None,
     row1h("XAU/USD", END_G - 2 * HOUR) + row1h("XAU/USD", END_G - HOUR, side="BUY") + row1h("XAU/USD", END_G),
     attention_has("XAU/USD", "other_macdx_1h_rule_rows=3", "macdx_1h_rows_after_end_1h=1"), s=SW_S, e=SW_E)
scen("g12 the go-live marker left in: the statement does not run", "gold", G, "", None, keep=("GO_LIVE_MS_GOLD",), expect_error="syntax error")
scen("g13 the end_1h marker left in: the statement does not run", "gold", G, "", None, keep=("END_1H_MS_GOLD",), expect_error="syntax error")
# ---- the shares (no recount: rows only); a New York share's 15-minute bar on a weekday of the bench: 2026-12-02 09:30 New York (14:30 UTC) to 09:45 ----
S0 = ms_of(2026, 12, 2, 14, 30)
SS, SE = day_of(S0)
SH = {"pair": "AAPL", "bar": S0, "side": "SELL"}


def srow(side="SELL", entry=231.45, who="u1", bar=S0, closed=None, interval="15min", status="sent", stop="null", target="null", rule=SRULE, pair="AAPL"):
    closed = bar + M15 if closed is None else closed
    return (f"insert into public.signal_alerts (kind, pair, interval, bar_time, closed_at, side, entry, stop, target, rule, status, sent_at, who) values "
            f"('signal', '{pair}', '{interval}', '{iso(bar)}', '{iso(closed)}', '{side}', {entry}, {stop}, {target}, '{rule}', '{status}', '{iso(closed + 61000)}', '{who}');")


SUBS = "insert into public.signal_alert_subscriptions (who, pair, interval, rule) values ('u1', 'AAPL', '15min', 'stockmacd'), ('u2', 'AAPL', '15min', 'stockmacd');"
CLEAN = SUBS + srow() + srow(who="u2")
scen("s00 control: two followers, one side, one entry, no stop or target", "stocks", None, CLEAN,
     both(expect_line(SH, "ok", mail_rows=2, entries=1, subscriptions=2), summary_ok("AAPL"), run_has(shares_followed_15min=1, subscriptions_15min=2, stockmacd_subscriptions_not_15min=0)),
     s=SS, e=SE)
scen("s01 both sides in one bar (other_side)", "stocks", None, CLEAN + srow(side="BUY", who="u3"),
     both(expect_line(SH, "check", side="BUY,SELL", why=lambda w: w and "other_side" in w), attention_has("AAPL", "other_side=1")), s=SS, e=SE)
scen("s02 two entries in one bar (entries_differ)", "stocks", None, SUBS + srow() + srow(who="u2", entry=231.47),
     both(expect_line(SH, "check", entries=2, why=lambda w: w and "entries_differ" in w), attention_has("AAPL", "entries_differ=1")), s=SS, e=SE)
scen("s03 a row with a target (stop_or_target)", "stocks", None, SUBS + srow() + srow(who="u2", target=232),
     both(expect_line(SH, "check", stop_or_target_rows=1), attention_has("AAPL", "stop_or_target=1")), s=SS, e=SE)
scen("s04 a row with a stop (stop_or_target)", "stocks", None, SUBS + srow() + srow(who="u2", stop=230),
     both(expect_line(SH, "check", stop_or_target_rows=1), attention_has("AAPL", "stop_or_target=1")), s=SS, e=SE)
scen("s05 a row on '1h' under the new id (interval_not_15min)", "stocks", None, SUBS + srow() + srow(who="u2", interval="1h"),
     both(expect_line(SH, "check", interval_not_15min_rows=1), attention_has("AAPL", "interval_not_15min=1")), s=SS, e=SE)
scen("s06 closed_at 16 minutes after the open (closed_at_not_within_15min)", "stocks", None, SUBS + srow() + srow(who="u2", closed=S0 + 16 * 60000),
     both(expect_line(SH, "check", closed_at_not_within_15min_rows=1), attention_has("AAPL", "closed_at_not_within_15min=1")), s=SS, e=SE)
scen("s07 closed_at an hour after the open (v40's bar length): closed_at_not_within_15min", "stocks", None, SUBS + srow() + srow(who="u2", closed=S0 + HOUR),
     both(expect_line(SH, "check", closed_at_not_within_15min_rows=1), attention_has("AAPL", "closed_at_not_within_15min=1")), s=SS, e=SE)
S1 = ms_of(2026, 12, 2, 20, 45)  # New York's 15:45 bar, the session's last (closes 16:00 New York = 21:00 UTC, the GMO day's end): exactly 15 minutes long
scen("s08 New York's last bar (15:45, closed at 16:00): ok", "stocks", None, SUBS + srow(bar=S1) + srow(bar=S1, who="u2"),
     both(expect_line(dict(SH, bar=S1), "ok", mail_rows=2), summary_ok("AAPL")), s=SS, e=SE)
S2 = ms_of(2026, 12, 2, 2, 15)  # a Tokyo bar: 11:15 JST (the morning session's last, closed 11:30), judged about 16 minutes later (Yahoo's delay)
T0 = {"pair": "7203.T", "bar": S2, "side": "BUY"}
scen("s09 a Tokyo share's 11:15 bar mailed 16 minutes after its close: ok (the lag is told, not judged)", "stocks", None,
     "insert into public.signal_alert_subscriptions (who, pair, interval, rule) values ('u1', '7203.T', '15min', 'stockmacd');" +
     f"insert into public.signal_alerts (kind, pair, interval, bar_time, closed_at, side, entry, rule, status, sent_at, who) values ('signal', '7203.T', '15min', '{iso(S2)}', '{iso(S2 + M15)}', 'BUY', 2875.5, '{SRULE}', 'sent', '{iso(S2 + M15 + 16 * 60000)}', 'u1');",
     both(expect_line(T0, "ok", mail_rows=1, lag_min_s=960.0), summary_ok("7203.T")), s=SS, e=SE)
scen("s10 not_sent", "stocks", None, SUBS + srow() + srow(who="u2", status="failed"),
     both(expect_line(SH, "check", why="not_sent"), attention_has("AAPL", "not_sent_rows=1")), s=SS, e=SE)
scen("s11 dup", "stocks", None, CLEAN + srow(who="u3"), both(expect_line(SH, "check", why="dup"), attention_has("AAPL", "dup=1")), s=SS, e=SE)
scen("s12 switch day: v40's 1-hour fade row of the share (stockmacd_..._1h_..._in_v4) in the day: counted, never compared", "stocks", None,
     CLEAN + srow(rule=SRULE_V11, interval="1h", bar=S0 - HOUR, closed=S0),
     both(expect_line(SH, "ok"), attention_has("AAPL", "other_stockmacd_rule_rows=1")), s=SS, e=SE)
scen("s13 a row, nobody follows", "stocks", None, srow(), both(expect_line(SH, "ok", subscriptions=0), attention_has("AAPL", "no_subscription_row")), s=SS, e=SE)
scen("s14 the followers' '1h' rows only (their '15min' twins missing): no_subscription_row, and the RUN row counts them as not on '15min'", "stocks", None,
     SUBS.replace("'15min'", "'1h'") + srow() + srow(who="u2"),
     both(attention_has("AAPL", "no_subscription_row"), run_has(shares_followed_15min=0, subscriptions_15min=0, stockmacd_subscriptions_not_15min=2)), s=SS, e=SE)
scen("s15 a row of the day before: not in this day", "stocks", None, SUBS + srow(bar=SS - M15),
     lambda out: None if not [r for r in out if r["rt"] != "RUN"] else f"rows {[(r['rt'], r['inst'], r['bar']) for r in out]}", s=SS, e=SE)

with concurrent.futures.ThreadPoolExecutor(max_workers=int(opt("--jobs", "4"))) as pool:
    results = list(pool.map(lambda t: t(), tasks))
npass = sum(1 for _, okk, _, _ in results if okk)
for name, okk, why, shown in results:
    if SHOW:
        print("\n".join(shown))
    print(("PASS " if okk else "FAIL ") + name + ("" if okk else ": " + why))
print(f"scenarios {len(results)}, passed {npass}, failed {len(results) - npass}")
sys.exit(0 if npass == len(results) else 1)
