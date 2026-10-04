#!/usr/bin/env python3
"""#188: the hand examples (docs §8.99 「手で計算した小さな例」), written as files
both programs read: research/money.ts (FIXTURE=<dir>) and research/money-check.py
(--fixture <dir>). Each must come out with the numbers worked out here by hand.

A fixture is a few 5-minute bars (bid; the ask is the bid plus the spread, 0.4
pip unless written), the emails' trades (signals.csv, the study's table), the
runs (cells or told rows) and, for each run, the ledger rows and summary worked
out by hand (fixture.json "expect"), with the steps in English ("hand"), and the
planted errors (interface.md §8) the fixture must catch ("plants").

What gets written, per fixture (research/money-fixtures/<name>/):
  * gmo/<SYMBOL>/5min/<bid|ask>/<UTC day>.json and gmo/<SYMBOL>/4hour/<bid|ask>/
    <UTC year>.json, GMO's own layout as stop2n.ts's dump writes it ({status: 0,
    data: [{openTime, open, high, low, close}]}, strings);
  * the 4-hour bars: each one made from the 5-minute bars written inside it
    (so a signal bar's close is the close of its 5-minute bar ending at T),
    one price where none is written, and 121 kept bars past the last signal bar
    (so a reader still asking for NEED = 120 bars after a signal, or for the
    30th bar's close, finds them; nothing else reads them). Only bars inside
    market hours (not wholly in the closure) are written;
  * signals.csv (interface.md §4.1) and fixture.json.

Every number in "expect" is typed here from the hand calculation. They are then
worked out again, apart, by recompute.py (it reads only the files written) and
the two must agree (1e-9 a price, 1e-6 a yen), or this stops. recompute.py also
puts each plant into its own reading, and every plant a fixture lists must move
at least one expected number there; every plant must be listed somewhere.

Choices the fixtures had to make that §8.99 and interface.md leave open (listed
in each fixture.json as "conventions" too, so a FAIL can be read against them):
"""

import csv
import json
import os
import shutil
import sys
from datetime import datetime, timezone

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import recompute  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
MIN = 60_000
HOUR = 60 * MIN
FINE = 5 * MIN
STEP4 = 4 * HOUR
PAD4 = 121
ORDER = recompute.ORDER
SYMBOL = recompute.SYMBOL

CONVENTIONS = [
    "g of a row decided at a bar's open s (an email's enter or skip at T, a deadline and its exits, an AS netting close) is s; rows of exits inside the bar, the loss-cut, the cure and the call carry the bar's end g; a late email's enter row (or its skip 'passed') carries its first bar's end, T + 5 min.",
    "seq counts from 1 in each run; rows in processing order (①–⑥), exits of one bar and the positions closed by one loss-cut or deadline in the admission order of their entries.",
    "a call, or E*'s NY-close term, judged at the stand-in (no 5-minute bar ends at τ) carries the stand-in grid time as its g, not τ.",
    "E* terms are named order, nyclose, losscut, loss; a term's g is the first time its largest value is reached; lost = −(P/L) at the binding term's time (order: the state at s before the order; nyclose: on mids), margin = value − lost (for the loss-cut term, half the margin held).",
    "the emails of one bar are sized on the equity at s, and the margin test compares the margin after the order (with the bar's earlier admitted orders, all at T's mids) with that same equity at s (the earlier orders' spread not taken off).",
    "F10k runs start at 0 yen, so balance and equity are the P/L; course 25 is the 25x course (4% margin), losscut 0.5, order 0 the fixed admission order.",
    "the losscut event row's equity is E(g) at the test (the same after closing at g's closes).",
    "a late email is judged at T (the order term too, margin at T's mids with the late orders before it), fills after ③ at its first bar's close, and is in E and the margin from that bar's end.",
    "taken counts emails that opened a position (a thirds email once; an AS email that only closed, zero).",
    "FF thirds: the 1,000-unit lots dealt to TP1, TP2, TP3 in turn (the larger first); the fixtures use 10 lots or fewer, where 0.4/0.3/0.3 with the largest remainders splits the same.",
    "every trade has its own exit (TP or stop) inside the bars written, after any forced close, so the trade is whole; each pair held at a deadline has a bar opening exactly at the deadline.",
    "a skip row carries no units; an exit row's units are the units closed; px is the price in the pair's own currency.",
    "each trade's first 5-minute bar opens at T: where a fixture writes none, a flat bar at the signal bar's close is written (bid and ask of the bar ending at T).",
    "after the last bar that matters, each pair has one wide 'flush' bar (1 yen, or 0.01 on a dollar pair, either side of its last close) and one flat bar after it, so every variant of every trade (TP2, TP3, five minutes late, Rakuten's spread) ends inside the data; no run holds anything then.",
]
__doc__ += "".join(f"  {i}. {c}\n" for i, c in enumerate(CONVENTIONS, start=1))


def at(s):
    """'2024-01-08 11:55' (UTC) as ms."""
    return int(datetime.strptime(s, "%Y-%m-%d %H:%M").replace(tzinfo=timezone.utc).timestamp() * 1000)


def iso(ms):
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def num(x):
    """A price as GMO's files hold it (a string); clean of float noise."""
    x = round(x, 7)
    return str(int(x)) if x == int(x) else repr(x)


def flat(when, bid, sp=None):
    return (when, bid, bid, bid, bid, sp)


def ohlc(when, o, h, l, c, sp=None):
    return (when, o, h, l, c, sp)


def tid(pair, bar_open, side):
    return f"{pair}|{iso(at(bar_open) + STEP4)}|{side}"


class Ledger:
    """The rows of one run, numbered as they are added (seq from 1)."""

    def __init__(self):
        self.rows = []

    def add(self, **r):
        self.rows.append({"seq": len(self.rows) + 1, **r})

    def enter(self, g, id_, units, px, **kw):
        self.add(g=iso(at(g)), kind="enter", id=id_, units=units, px=px, **kw)

    def skip(self, g, id_, reason):
        self.add(g=iso(at(g)), kind="skip", id=id_, reason=reason)

    def exit(self, g, id_, units, px, pnl, balance, reason):
        self.add(g=iso(at(g)), kind="exit", id=id_, units=units, px=px, pnl_yen=pnl, balance=balance, reason=reason)

    def call(self, g, C, margin):
        self.add(g=iso(at(g)), kind="call", pnl_yen=C, margin=margin)

    def cure(self, g):
        self.add(g=iso(at(g)), kind="cure")

    def deadline(self, g):
        self.add(g=iso(at(g)), kind="deadline")

    def losscut(self, g, equity):
        self.add(g=iso(at(g)), kind="losscut", equity=equity)


def summary(final, taken=None, call=0, cap=0, lot=0, margin=0, passed=0, calls=0, cures=0, deadlines=0, losscuts=0, estar=None):
    s = {"final_balance": final, "final_equity": final}
    if taken is not None:
        s["taken"] = taken
    s.update({"skipped": {"call": call, "cap": cap, "lot": lot, "margin": margin, "passed": passed},
              "calls": calls, "cures": cures, "deadlines": deadlines, "losscuts": losscuts, "shortfall_yen": 0.0})
    if estar is not None:
        s["estar"] = estar
    return s


def estar(order, nyclose, losscut, loss, binding, lost):
    """order/nyclose/losscut/loss as (value, 'YYYY-MM-DD HH:MM')."""
    terms = [{"name": n, "value": v, "g": iso(at(g))} for n, (v, g) in (("order", order), ("nyclose", nyclose), ("losscut", losscut), ("loss", loss))]
    top = {t["name"]: t for t in terms}[binding]
    if top["value"] != max(t["value"] for t in terms):
        raise SystemExit(f"E*: {binding} is not the largest term")
    return {"value": top["value"], "terms": terms, "lost": lost, "margin": top["value"] - lost}


def run(key, sizing, cap="C0", row=None, start=1_000_000):
    return {"key": key, "sizing": sizing, "cap": cap, "course": 25, "losscut": 0.5, "row": row,
            "start_equity": 0 if sizing == "F10k" else start, "order": 0}


FIXTURES = []


# ---- lot_floor: under 1,000 units, the floor, and the size at T ---------------------------


def lot_floor():
    u1, u2, u3 = tid("USD/JPY", "2024-01-08 08:00", "BUY"), tid("EUR/JPY", "2024-01-08 12:00", "BUY"), tid("AUD/JPY", "2024-01-08 16:00", "BUY")
    led = Ledger()
    led.enter("2024-01-08 12:00", u1, 1000, 150.002)
    led.enter("2024-01-08 16:00", u2, 1000, 160.002)
    led.exit("2024-01-08 20:00", u1, 1000, 149.870, 1000 * (149.870 - 150.002), 13_100 - 132, "sl")
    led.skip("2024-01-08 20:00", u3, "lot")
    led.exit("2024-01-08 21:05", u2, 1000, 160.040, 1000 * (160.040 - 160.002), 12_968 + 38, "tp")
    return {
        "name": "lot_floor",
        "what": "FF1 from 13,100 yen: 1,000 units, then under 1,000 after a stop whose bar ends at the next email's T (skip 'lot'); the size taken at T, not 4 hours later",
        "hand": [
            "Run FF1_C0 from 13,100 yen (k = 1%). A JPY pair's 13 pips are 0.13 yen a unit, so units = floor(0.01 x E / 0.13 / 1000) x 1000.",
            "Mon 2024-01-08 12:00 (T of USD/JPY BUY, bar 08:00): its 4-hour close bid 149.998 / ask 150.002, mid 150.000; TP1 150.040, stop 149.870; fill (ask) 150.002.",
            "  Nothing open: E = 13,100; 0.01 x 13,100 / 0.13 = 1,007.7 units -> 1,000. Margin after 0.04 x 1,000 x 150.000 = 6,000 <= 13,100: enter 1,000 at 150.002.",
            "16:00 (T of EUR/JPY BUY, bar 12:00; mid 160.000, fill 160.002, TP1 160.040, stop 159.870): USD/JPY marked at the bid close of its bar ending 16:00, 149.950: E = 13,100 + 1,000 x (149.950 - 150.002) = 13,048.",
            "  0.01 x 13,048 / 0.13 = 1,003.7 -> 1,000. Margin after 0.04 x 1,000 x 149.952 + 0.04 x 1,000 x 160.000 = 5,998.08 + 6,400 = 12,398.08 <= 13,048: enter 1,000 at 160.002.",
            "19:55 bar of USD/JPY (19:55-20:00): bid low 149.860 <= stop 149.870 (open 149.950 not past it; it closes back at 149.950): out at 149.870, the bar's end 20:00. P/L 1,000 x (149.870 - 150.002) = -132; balance 12,968.",
            "20:00 (T of AUD/JPY BUY, bar 16:00; mid 100.000): USD/JPY's exit bar ended at 20:00 = T, so it is closed (not marked at its close 149.950). E = 12,968 + EUR/JPY 1,000 x (159.998 - 160.002) = 12,964; 0.01 x 12,964 / 0.13 = 997.2 -> 0 < 1,000: skip 'lot'.",
            "  (Had USD/JPY still been counted open at T, marked at 149.950, E would be 13,100 - 52 - 4 = 13,044 -> 1,003.4 -> 1,000 units, and AUD/JPY would be skipped 'margin' instead: 0.04 x 1,000 x (149.952 + 160.000 + 100.000) = 16,398.08 > 13,044.)",
            "21:00 bar of EUR/JPY: bid high 160.045 >= TP1 160.040: out at 160.040 (21:05). P/L 1,000 x 0.038 = 38; balance 13,006. Nothing open at the NY close (21:55; no bar then, the stand-in is the last grid time, flat): no call.",
            "Plants: roundlot rounds 997.2 up to 1,000 and enters AUD/JPY at 20:00 (margin 6,400 + 4,000 = 10,400 <= 12,964), so the 'lot' skip becomes an entry and an AUD/JPY exit (TP 100.040 at 20:35) appears.",
            "  sizefuture sizes EUR/JPY (T 16:00) on the equity at 20:00, after USD/JPY's stop: 12,964 (or 12,968 without EUR/JPY's own mark) -> 0 units: a skip where 1,000 were entered.",
            "  pipplus (the first trade, USD/JPY, 1 pip better): its exit 149.880, P/L -122, every later balance 10 more.",
            "  exitlate: USD/JPY out at 20:05, so at 20:00 it is still open (E 13,044, 1,000 units) and AUD/JPY is skipped 'margin', not 'lot'; EUR/JPY out at 21:10.",
        ],
        "pairs": ["USD/JPY", "EUR/JPY", "AUD/JPY"],
        "bars": {
            "USD/JPY": [flat("2024-01-08 11:55", 149.998), flat("2024-01-08 15:55", 149.950), ohlc("2024-01-08 19:55", 149.950, 149.950, 149.860, 149.950), flat("2024-01-08 20:00", 149.950)],
            "EUR/JPY": [flat("2024-01-08 15:55", 159.998), flat("2024-01-08 19:55", 159.998), ohlc("2024-01-08 21:00", 159.998, 160.045, 159.998, 160.040), flat("2024-01-08 21:05", 160.040)],
            "AUD/JPY": [flat("2024-01-08 19:55", 99.998), ohlc("2024-01-08 20:30", 99.998, 100.045, 99.998, 100.040), flat("2024-01-08 20:35", 100.040)],
        },
        "signals": [("USD/JPY", "2024-01-08 08:00", "BUY"), ("EUR/JPY", "2024-01-08 12:00", "BUY"), ("AUD/JPY", "2024-01-08 16:00", "BUY")],
        "runs": [run("FF1_C0", "FF1", start=13_100)],
        "expect": {"FF1_C0": {"ledger": led.rows, "summary": summary(13_006, taken=2, lot=1)}},
        "plants": ["roundlot", "sizefuture", "pipplus", "exitlate"],
    }


FIXTURES.append(lot_floor)


# ---- cap_exit_in_entry_bar: a slot freed only after the exit's bar ------------------------


def cap_exit_in_entry_bar():
    a, b = tid("USD/JPY", "2024-01-09 08:00", "BUY"), tid("EUR/JPY", "2024-01-09 12:00", "BUY")
    c, d = tid("GBP/JPY", "2024-01-09 16:00", "BUY"), tid("AUD/JPY", "2024-01-09 20:00", "BUY")
    f10 = Ledger()
    f10.enter("2024-01-09 12:00", a, 10_000, 150.002)
    f10.skip("2024-01-09 16:00", b, "cap")
    f10.exit("2024-01-09 16:05", a, 10_000, 150.040, 10_000 * 0.038, 380, "tp")
    f10.enter("2024-01-09 20:00", c, 10_000, 190.002)
    f10.exit("2024-01-10 00:00", c, 10_000, 190.040, 10_000 * 0.038, 760, "tp")
    f10.enter("2024-01-10 00:00", d, 10_000, 100.002)
    f10.exit("2024-01-10 02:05", d, 10_000, 99.870, 10_000 * (99.870 - 100.002), 760 - 1320, "sl")
    ff = Ledger()
    ff.enter("2024-01-09 12:00", a, 38_000, 150.002)
    ff.skip("2024-01-09 16:00", b, "cap")
    ff.exit("2024-01-09 16:05", a, 38_000, 150.040, 38_000 * 0.038, 1_001_444, "tp")
    ff.enter("2024-01-09 20:00", c, 38_000, 190.002)
    ff.exit("2024-01-10 00:00", c, 38_000, 190.040, 38_000 * 0.038, 1_002_888, "tp")
    ff.enter("2024-01-10 00:00", d, 38_000, 100.002)
    ff.exit("2024-01-10 02:05", d, 38_000, 99.870, 38_000 * (99.870 - 100.002), 1_002_888 - 5016, "sl")
    es = estar(order=(76_000 - 380, "2024-01-09 20:00"), nyclose=(0.04 * 10_000 * 189.952 + 120, "2024-01-09 21:55"),
               losscut=(0.5 * 0.04 * 10_000 * 189.952 + 140, "2024-01-09 21:55"), loss=(1020.0, "2024-01-09 14:05"), binding="nyclose", lost=120.0)
    return {
        "name": "cap_exit_in_entry_bar",
        "what": "cap T1: an exit inside the bar the next email enters on keeps the slot (skip 'cap'); an exit in the bar ending at T frees it",
        "hand": [
            "Runs F10k_T1 (start 0) and FF05_T1 (1,000,000, k = 0.5%). JPY pairs, spread 0.4 pip; each 4-hour close mid is bid + 0.002.",
            "A USD/JPY BUY, T Tue 2024-01-09 12:00: mid 150.000, fill 150.002, TP1 150.040, stop 149.870. Nothing open: enter (F10k 10,000; FF05 0.005 x 1,000,000 / 0.13 = 38,461 -> 38,000).",
            "  A's bars: 12:00 bid 149.998, 14:00 bid 149.900, 15:55 bid 149.990, then the 16:00 bar (16:00-16:05) bid high 150.045 >= 150.040: out at 150.040, x = 16:05.",
            "B EUR/JPY BUY, T 16:00: A's exit bar is the bar opening at 16:00 itself, so at 16:00 A is still open (a slot frees only after the exit's bar ends): skip 'cap'.",
            "  A's P/L: F10k 10,000 x 0.038 = 380; FF05 38,000 x 0.038 = 1,444 -> 1,001,444.",
            "C GBP/JPY BUY, T 20:00: mid 190.000, fill 190.002, TP1 190.040. Nothing open: enter. FF05: 0.005 x 1,001,444 / 0.13 = 38,517 -> 38,000.",
            "  C's bars: 20:00 bid 189.998, 21:50 bid 189.950 (ends 21:55, the NY close), then 23:55 (23:55-00:00) bid high 190.050: out at 190.040, x = Wed 00:00. P/L F10k 380 (balance 760), FF05 1,444 (1,002,888).",
            "D AUD/JPY BUY, T Wed 00:00: C's exit bar ended at 00:00 = T, so C is closed and the slot is free: enter at 100.002 (FF05: 0.005 x 1,002,888 / 0.13 = 38,573 -> 38,000; C's 1,444 is in E at T).",
            "  D's 02:00 bar: bid low 99.860 <= stop 99.870: out at 99.870 (02:05). P/L F10k 10,000 x -0.132 = -1,320 (balance -560); FF05 38,000 x -0.132 = -5,016 (997,872).",
            "FF05 NY close Tue 21:55: E on mids 1,001,444 + 38,000 x (189.952 - 190.002) = 999,544 >= margin 0.04 x 38,000 x 189.952 = 288,727.04: no call.",
            "F10k E*: order term, at each order the margin after it less the P/L before: A 0.04 x 10,000 x 150.000 - 0 = 60,000; C 76,000 - 380 = 75,620 (the largest, Tue 20:00); D 40,000 - 760 = 39,240.",
            "  NY close Tue 21:55 (C open, P/L on mids 380 + 10,000 x (189.952 - 190.002) = -120): margin 0.04 x 10,000 x 189.952 = 75,980.8; 75,980.8 + 120 = 76,100.8. Later NY closes are flat (560).",
            "  Loss-cut term, half the margin less the P/L at each grid time: 12:05 30,000 + 40; 14:05 0.5 x 0.04 x 10,000 x 149.902 + 1,020 = 31,000.4; 20:05 38,000 - 340; 21:55 0.5 x 75,980.8 + 140 = 38,130.4 (the largest); 00:05 20,000 - 720.",
            "  Loss term, the deepest P/L: 14:05, A at 149.900: 10,000 x (149.900 - 150.002) = -1,020 -> 1,020 (later: 21:55 -140, flat end -560).",
            "  E* = 76,100.8, set by the NY close Tue 21:55: lost 120, margin 75,980.8.",
            "Plants: slotearly frees A's slot at its exit bar's open (16:00), so B enters. exitlate moves C's exit to the 00:00-00:05 bar, so at 00:00 C still holds the slot and D is skipped 'cap'.",
        ],
        "pairs": ["USD/JPY", "EUR/JPY", "GBP/JPY", "AUD/JPY"],
        "bars": {
            "USD/JPY": [flat("2024-01-09 11:55", 149.998), flat("2024-01-09 12:00", 149.998), flat("2024-01-09 14:00", 149.900), flat("2024-01-09 15:55", 149.990),
                        ohlc("2024-01-09 16:00", 149.990, 150.045, 149.990, 150.030), flat("2024-01-09 16:05", 150.030)],
            "EUR/JPY": [flat("2024-01-09 15:55", 159.998), ohlc("2024-01-09 16:30", 159.998, 160.045, 159.998, 160.040), flat("2024-01-09 16:35", 160.040)],
            "GBP/JPY": [flat("2024-01-09 19:55", 189.998), flat("2024-01-09 20:00", 189.998), flat("2024-01-09 21:50", 189.950),
                        ohlc("2024-01-09 23:55", 189.990, 190.050, 189.990, 190.040), flat("2024-01-10 00:00", 190.040)],
            "AUD/JPY": [flat("2024-01-09 23:55", 99.998), flat("2024-01-10 00:00", 99.998), ohlc("2024-01-10 02:00", 99.990, 99.990, 99.860, 99.870), flat("2024-01-10 02:05", 99.870)],
        },
        "signals": [("USD/JPY", "2024-01-09 08:00", "BUY"), ("EUR/JPY", "2024-01-09 12:00", "BUY"), ("GBP/JPY", "2024-01-09 16:00", "BUY"), ("AUD/JPY", "2024-01-09 20:00", "BUY")],
        "runs": [run("F10k_T1", "F10k", cap="T1"), run("FF05_T1", "FF05", cap="T1")],
        "expect": {
            "F10k_T1": {"ledger": f10.rows, "summary": summary(-560.0, taken=3, cap=1, estar=es)},
            "FF05_T1": {"ledger": ff.rows, "summary": summary(997_872.0, taken=3, cap=1)},
        },
        "plants": ["slotearly", "exitlate"],
    }


FIXTURES.append(cap_exit_in_entry_bar)


# ---- usd_pair_conversion: a dollar pair's yen at the same grid time ------------------------


def usd_pair_conversion():
    e = tid("EUR/USD", "2024-01-10 12:00", "BUY")
    gain = 1.10040 - 1.100016
    f10 = Ledger()
    f10.enter("2024-01-10 16:00", e, 10_000, 1.100016)
    f10.exit("2024-01-11 02:05", e, 10_000, 1.10040, 10_000 * gain * 156.0, 10_000 * gain * 156.0, "tp")
    ff = Ledger()
    ff.enter("2024-01-10 16:00", e, 51_000, 1.100016)
    ff.exit("2024-01-11 02:05", e, 51_000, 1.10040, 51_000 * gain * 156.0, 1_000_000 + 51_000 * gain * 156.0, "tp")
    m_tau = 0.04 * 10_000 * 1.099718 * 152.0
    es = estar(order=(0.04 * 10_000 * 1.099998 * 150.0, "2024-01-10 16:00"),
               nyclose=(m_tau + 10_000 * (1.100016 - 1.099718) * 152.0, "2024-01-10 21:55"),
               losscut=(0.5 * 0.04 * 10_000 * 1.099518 * 152.0 + 10_000 * (1.100016 - 1.0995) * 152.0, "2024-01-10 23:05"),
               loss=(10_000 * (1.100016 - 1.0995) * 152.0, "2024-01-10 23:05"), binding="nyclose", lost=10_000 * (1.100016 - 1.099718) * 152.0)
    return {
        "name": "usd_pair_conversion",
        "what": "EUR/USD in yen: sized, marked, margined and realised at the USD/JPY mid of the same grid time (the last earlier one where USD/JPY has no bar); the 5-digit mid close rounded",
        "hand": [
            "Runs F10k_C0 (start 0) and FF1_C0 (1,000,000). EUR/USD spread 0.36 pip (ask = bid + 0.000036), USD/JPY 0.4 pip; USD/JPY is read only for the yen.",
            "EUR/USD BUY, signal bar Wed 2024-01-10 12:00, T 16:00: 4-hour close bid 1.099980 / ask 1.100016, mid 1.099998, rounded to 5 digits 1.10000 (up). TP1 1.10000 + 0.0004 = 1.10040, stop 1.09870. Fill (ask) 1.100016.",
            "USD/JPY mid at T (its bar ending 16:00): 150.000. FF1: 13 pips of EUR/USD = 0.0013 x 150.000 = 0.195 yen a unit; 0.01 x 1,000,000 / 0.195 = 51,282 -> 51,000.",
            "  Margin after: 0.04 x 51,000 x 1.099998 (the pair's own 5-minute mid, not rounded) x 150.000 = 336,599.388 <= 1,000,000: enter. F10k: 10,000; margin 0.04 x 10,000 x 1.099998 x 150 = 65,999.88.",
            "Bars: EUR/USD 16:00 bid 1.099980; 21:50 bid 1.099700 (mid 1.099718); 23:00 bid 1.099500 (mid 1.099518; USD/JPY has no bar then, so its last mid, 152.000 at 21:55, is used); Thu 02:00 bid high 1.100410 >= 1.10040: out at 1.10040, x = Thu 02:05.",
            "  USD/JPY mid: 150.000 to 16:00, 152.000 at 21:55, 156.000 at Thu 02:05 (the exit's grid time).",
            "Realised: (1.10040 - 1.100016) = 0.000384 a unit, x 156.000: F10k 10,000 x 0.000384 x 156 = 599.04; FF1 51,000 x 0.000384 x 156 = 3,055.104 -> 1,003,055.104.",
            "FF1 NY close Wed 21:55: E on mids 1,000,000 + 51,000 x (1.099718 - 1.100016) x 152 = 997,689.904 >= margin 0.04 x 51,000 x 1.099718 x 152 = 341,000.55744: no call.",
            "F10k E*: order 65,999.88 (Wed 16:00, P/L 0).",
            "  NY close Wed 21:55: P/L on mids 10,000 x (1.099718 - 1.100016) x 152 = -452.96; margin 0.04 x 10,000 x 1.099718 x 152 = 66,862.8544; 66,862.8544 + 452.96 = 67,315.8144.",
            "  Loss-cut term: 16:05 0.5 x 65,999.88 + 54 (10,000 x 0.000036 x 150) = 33,053.94; 21:55 0.5 x 66,862.8544 + 480.32 (10,000 x 0.000316 x 152) = 33,911.7472; 23:05 0.5 x 0.04 x 10,000 x 1.099518 x 152 + 784.32 = 33,425.3472 + 784.32 = 34,209.6672 (the largest).",
            "  Loss term: 23:05, 10,000 x (1.099500 - 1.100016) x 152 = -784.32 -> 784.32 (152 is USD/JPY's last mid, from 21:55).",
            "  E* = 67,315.8144 from the NY close Wed 21:55: lost 452.96, margin 66,862.8544.",
            "Plants: usdentry turns the exit at the entry's 150.000: F10k 576, FF1 2,937.6 (not 599.04 / 3,055.104). pipplus: the exit 1 pip better (1.10050). exitlate: out at Thu 02:10.",
            "Rounding: with the mid not rounded (1.099998) TP1 would be 1.100398 and the exit price differ by 0.000002.",
        ],
        "pairs": ["USD/JPY", "EUR/USD"],
        "bars": {
            "USD/JPY": [flat("2024-01-10 15:55", 149.998), flat("2024-01-10 21:50", 151.998), flat("2024-01-11 02:00", 155.998)],
            "EUR/USD": [flat("2024-01-10 15:55", 1.099980), flat("2024-01-10 16:00", 1.099980), flat("2024-01-10 21:50", 1.099700), flat("2024-01-10 23:00", 1.099500),
                        ohlc("2024-01-11 02:00", 1.099980, 1.100410, 1.099980, 1.100300), flat("2024-01-11 02:05", 1.100300)],
        },
        "signals": [("EUR/USD", "2024-01-10 12:00", "BUY")],
        "runs": [run("F10k_C0", "F10k"), run("FF1_C0", "FF1")],
        "expect": {
            "F10k_C0": {"ledger": f10.rows, "summary": summary(10_000 * gain * 156.0, taken=1, estar=es)},
            "FF1_C0": {"ledger": ff.rows, "summary": summary(1_000_000 + 51_000 * gain * 156.0, taken=1)},
        },
        "plants": ["usdentry", "pipplus", "exitlate"],
    }


FIXTURES.append(usd_pair_conversion)


# ---- thirds_legs: TP1, TP2, TP3 as three parts --------------------------------------------


def thirds_legs():
    u = tid("USD/JPY", "2024-01-11 12:00", "BUY")
    fill = 150.0032
    f10 = Ledger()
    for leg, n in ((1, 4000), (2, 3000), (3, 3000)):
        f10.enter("2024-01-11 16:00", f"{u}#{leg}", n, fill)
    f10.exit("2024-01-11 18:05", f"{u}#1", 4000, 150.041, 4000 * (150.041 - fill), 151.2, "tp")
    f10.exit("2024-01-12 01:05", f"{u}#2", 3000, 150.101, 3000 * (150.101 - fill), 151.2 + 293.4, "tp")
    f10.exit("2024-01-12 03:05", f"{u}#3", 3000, 149.871, 3000 * (149.871 - fill), 151.2 + 293.4 - 396.6, "sl")
    ff = Ledger()
    for leg, n in ((1, 3000), (2, 2000), (3, 2000)):
        ff.enter("2024-01-11 16:00", f"{u}#{leg}", n, fill)
    ff.exit("2024-01-11 18:05", f"{u}#1", 3000, 150.041, 3000 * (150.041 - fill), 100_113.4, "tp")
    ff.exit("2024-01-12 01:05", f"{u}#2", 2000, 150.101, 2000 * (150.101 - fill), 100_309.0, "tp")
    ff.exit("2024-01-12 03:05", f"{u}#3", 2000, 149.871, 2000 * (149.871 - fill), 100_044.6, "sl")
    es = estar(order=(0.04 * 10_000 * 150.0012, "2024-01-11 16:00"), nyclose=(0.04 * 6000 * 149.952 + 156, "2024-01-11 21:55"),
               losscut=(0.5 * 0.04 * 10_000 * 150.0012 + 40, "2024-01-11 16:05"), loss=(168.0, "2024-01-11 21:55"), binding="order", lost=0.0)
    return {
        "name": "thirds_legs",
        "what": "the told row 'thirds': one email as three parts out at TP1, TP2 and TP3 (the last at the stop), the same stop; the mid close rounded to 3 digits",
        "hand": [
            "Runs row_thirds_F10k_C0 (start 0; parts 4,000 / 3,000 / 3,000) and row_thirds_FF1_C0 (from 100,000 yen; 0.01 x 100,000 / 0.13 = 7,692 -> 7,000, dealt 3,000 / 2,000 / 2,000).",
            "USD/JPY BUY, signal bar Thu 2024-01-11 12:00, T 16:00: 4-hour close bid 149.9992 / ask 150.0032, mid 150.0012, rounded to 150.001. TP1 150.041, TP2 150.101, TP3 150.161, stop 149.871 (not rounded again). Fill 150.0032.",
            "  Margin after (all parts) 0.04 x 10,000 x 150.0012 = 60,000.48 (F10k); 0.04 x 7,000 x 150.0012 = 42,000.336 <= 100,000 (FF1). One enter row per part, id suffixed #1, #2, #3.",
            "Thu 18:00 bar: bid high 150.050 >= TP1 150.041: part 1 out at 150.041 (18:05): (150.041 - 150.0032) = 0.0378 a unit: F10k 4,000 -> 151.2; FF1 3,000 -> 113.4 (100,113.4).",
            "Thu 21:50 bar bid 149.950 (mid 149.952): parts 2 and 3 still in. Fri 01:00 bar bid high 150.110 >= TP2 150.101: part 2 out at 150.101 (01:05): 0.0978 a unit: F10k 3,000 -> 293.4 (444.6); FF1 2,000 -> 195.6 (100,309).",
            "Fri 03:00 bar bid low 149.860 <= stop 149.871 (open 150.000): part 3 out at 149.871 (03:05): -0.1322 a unit: F10k 3,000 -> -396.6 (48); FF1 2,000 -> -264.4 (100,044.6).",
            "FF1 NY close Thu 21:55: E on mids 100,113.4 + 4,000 x (149.952 - 150.0032) = 99,908.6 >= margin 0.04 x 4,000 x 149.952 = 23,992.32: no call.",
            "F10k E*: order 60,000.48 (Thu 16:00, P/L 0): the largest.",
            "  NY close Thu 21:55: P/L on mids 151.2 + 6,000 x (149.952 - 150.0032) = -156; margin 0.04 x 6,000 x 149.952 = 35,988.48; 36,144.48.",
            "  Loss-cut term: 16:05 (bid 149.9992, P/L -40): 0.5 x 60,000.48 + 40 = 30,040.24 (the largest); 18:05: 0.5 x 0.04 x 6,000 x 150.032 - 312 = 17,691.84; 21:55: 17,994.24 + 168 = 18,162.24.",
            "  Loss term: 21:55, 151.2 + 6,000 x (149.950 - 150.0032) = -168 -> 168.",
            "  E* = 60,000.48 from the order at Thu 16:00: lost 0, margin 60,000.48.",
            "Rounding: with the mid not rounded (150.0012) TP1 would be 150.0412 and part 1's price and P/L differ.",
            "Plants: pipplus (the trade's TP1 exit 1 pip better: part 1 out at 150.051). exitlate: part 1 out at 21:55 (the next bar), and so on.",
        ],
        "pairs": ["USD/JPY"],
        "bars": {
            "USD/JPY": [flat("2024-01-11 15:55", 149.9992), flat("2024-01-11 16:00", 149.9992), ohlc("2024-01-11 18:00", 150.000, 150.050, 150.000, 150.030),
                        flat("2024-01-11 21:50", 149.950), ohlc("2024-01-12 01:00", 150.000, 150.110, 150.000, 150.080),
                        ohlc("2024-01-12 03:00", 150.000, 150.000, 149.860, 149.870), flat("2024-01-12 03:05", 149.870)],
        },
        "signals": [("USD/JPY", "2024-01-11 12:00", "BUY")],
        "runs": [run("row_thirds_F10k_C0", "F10k", row="thirds"), run("row_thirds_FF1_C0", "FF1", row="thirds", start=100_000)],
        "expect": {
            "row_thirds_F10k_C0": {"ledger": f10.rows, "summary": summary(48.0, estar=es)},
            "row_thirds_FF1_C0": {"ledger": ff.rows, "summary": summary(100_044.6)},
        },
        "plants": ["pipplus", "exitlate"],
    }


FIXTURES.append(thirds_legs)


# ---- late_passed: five minutes late, and a level already passed -----------------------------


def late_passed():
    us, gb, eu = tid("USD/JPY", "2024-01-15 12:00", "BUY"), tid("GBP/JPY", "2024-01-15 12:00", "BUY"), tid("EUR/JPY", "2024-01-15 16:00", "BUY")
    f10 = Ledger()
    f10.skip("2024-01-15 16:05", us, "passed")
    f10.enter("2024-01-15 16:05", gb, 10_000, 190.004)
    f10.enter("2024-01-15 20:05", eu, 10_000, 159.998)
    f10.exit("2024-01-16 01:05", gb, 10_000, 190.040, 10_000 * (190.040 - 190.004), 360, "tp")
    f10.exit("2024-01-16 02:05", eu, 10_000, 159.870, 10_000 * (159.870 - 159.998), 360 - 1280, "sl")
    ff = Ledger()
    ff.skip("2024-01-15 16:00", gb, "margin")
    ff.skip("2024-01-15 16:05", us, "passed")
    ff.enter("2024-01-15 20:05", eu, 76_000, 159.998)
    ff.exit("2024-01-16 02:05", eu, 76_000, 159.870, 76_000 * (159.870 - 159.998), 1_000_000 - 9728, "sl")
    m_tau = 0.04 * 10_000 * (189.952 + 159.952)
    es = estar(order=(76_000.8 + 64_000 + 40, "2024-01-15 20:00"), nyclose=(m_tau + 980, "2024-01-15 21:55"),
               losscut=(0.5 * m_tau + 1020, "2024-01-15 21:55"), loss=(1020.0, "2024-01-15 21:55"), binding="nyclose", lost=980.0)
    return {
        "name": "late_passed",
        "what": "the told row 'late': judged at T, filled at the first 5-minute close; one already past TP1 then (skip 'passed'), and a same-bar email skipped at T for margin not judged again",
        "hand": [
            "Runs row_late_F10k_C0 (start 0) and row_late_FF1_C0 (1,000,000). JPY pairs, spread 0.4 pip.",
            "T Mon 2024-01-15 16:00 (bar 12:00): USD/JPY BUY (mid 150.000, TP1 150.040, stop 149.870) and GBP/JPY BUY (mid 190.000, TP1 190.040, stop 189.870), in that order.",
            "  F10k at T: both admitted. Order term: USD/JPY 0.04 x 10,000 x 150.000 = 60,000; GBP/JPY 60,000 + 76,000 = 136,000 (P/L 0).",
            "  FF1 at T: E = 1,000,000, 76,000 units each. USD/JPY margin after 456,000 <= 1,000,000: admitted (its slot and margin held from T). GBP/JPY: 456,000 + 0.04 x 76,000 x 190 = 1,033,600 > 1,000,000: skip 'margin' at 16:00.",
            "First 5-minute bars (16:00-16:05): USD/JPY bid close 150.045 >= TP1 150.040: already passed -> skip 'passed' at 16:05 (no entry). GBP/JPY bid close 190.000, ask close 190.004: between the stop and TP1 -> F10k enters at 190.004 at 16:05.",
            "  FF1: GBP/JPY, skipped at T, is not judged again when USD/JPY's margin turns out unused.",
            "T 20:00 (bar 16:00): EUR/JPY BUY, mid 160.000, TP1 160.040, stop 159.870. F10k order term: GBP/JPY's margin at its last mid 190.002 (16:05) 76,000.8 + 0.04 x 10,000 x 160 = 64,000 -> 140,000.8, less the P/L at T, -40 (GBP/JPY 190.000 - 190.004): 140,040.8.",
            "  FF1: E = 1,000,000, 76,000 units, margin 486,400: admitted. Its first bar (20:00-20:05) bid close 159.994, ask 159.998: not passed -> enters at 159.998 at 20:05 (both runs).",
            "NY close Mon 21:55: GBP/JPY bid 189.950 (mid 189.952), EUR/JPY bid 159.950 (mid 159.952).",
            "  F10k: P/L exit side (189.950 - 190.004 + 159.950 - 159.998) x 10,000 = -1,020; on mids -980; margin 0.04 x 10,000 x (189.952 + 159.952) = 139,961.6.",
            "  FF1: E on mids 1,000,000 + 76,000 x (159.952 - 159.998) = 996,504 >= margin 486,254.08: no call.",
            "Tue 01:00 GBP/JPY bid high 190.050: out at TP1 190.040 (01:05): 10,000 x 0.036 = 360. Tue 02:00 EUR/JPY bid low 159.860: out at the stop 159.870 (02:05): F10k 10,000 x -0.128 = -1,280 (balance -920); FF1 76,000 x -0.128 = -9,728 (990,272).",
            "F10k E*: order 140,040.8 (Mon 20:00); NY close Mon 21:55 139,961.6 + 980 = 140,941.6 (the largest); loss-cut term 21:55 69,980.8 + 1,020 = 71,000.8; loss 1,020 at 21:55. E* = 140,941.6: lost 980, margin 139,961.6.",
            "Plants: exitlate (GBP/JPY out at 01:10, EUR/JPY at 02:10).",
        ],
        "pairs": ["USD/JPY", "GBP/JPY", "EUR/JPY"],
        "bars": {
            "USD/JPY": [flat("2024-01-15 15:55", 149.998), ohlc("2024-01-15 16:00", 149.998, 150.050, 149.998, 150.045)],
            "GBP/JPY": [flat("2024-01-15 15:55", 189.998), ohlc("2024-01-15 16:00", 189.998, 190.010, 189.990, 190.000), flat("2024-01-15 21:50", 189.950),
                        ohlc("2024-01-16 01:00", 190.000, 190.050, 190.000, 190.040), flat("2024-01-16 01:05", 190.040)],
            "EUR/JPY": [flat("2024-01-15 19:55", 159.998), ohlc("2024-01-15 20:00", 159.998, 160.000, 159.990, 159.994), flat("2024-01-15 21:50", 159.950),
                        ohlc("2024-01-16 02:00", 159.940, 159.940, 159.860, 159.870), flat("2024-01-16 02:05", 159.870)],
        },
        "signals": [("USD/JPY", "2024-01-15 12:00", "BUY"), ("GBP/JPY", "2024-01-15 12:00", "BUY"), ("EUR/JPY", "2024-01-15 16:00", "BUY")],
        "runs": [run("row_late_F10k_C0", "F10k", row="late"), run("row_late_FF1_C0", "FF1", row="late")],
        "expect": {
            "row_late_F10k_C0": {"ledger": f10.rows, "summary": summary(-920.0, taken=2, passed=1, estar=es)},
            "row_late_FF1_C0": {"ledger": ff.rows, "summary": summary(990_272.0, taken=1, margin=1, passed=1)},
        },
        "plants": ["exitlate"],
    }


FIXTURES.append(late_passed)


# ---- net_partial: the AS order closing the opposite side first --------------------------------


def net_partial():
    s1, s2, s3 = tid("USD/JPY", "2024-01-16 08:00", "BUY"), tid("USD/JPY", "2024-01-16 12:00", "SELL"), tid("USD/JPY", "2024-01-16 16:00", "SELL")
    f10 = Ledger()
    f10.enter("2024-01-16 12:00", s1, 10_000, 150.002)
    f10.exit("2024-01-16 16:00", s1, 10_000, 149.990, 10_000 * (149.990 - 150.002), -120, "net")
    f10.enter("2024-01-16 20:00", s3, 10_000, 149.980)
    f10.exit("2024-01-17 01:05", s3, 10_000, 149.942, 10_000 * (149.980 - 149.942), -120 + 380, "tp")
    ff = Ledger()
    ff.enter("2024-01-16 12:00", s1, 76_000, 150.002)
    ff.exit("2024-01-16 16:00", s1, 75_000, 149.990, 75_000 * (149.990 - 150.002), 987_600, "net")
    ff.exit("2024-01-16 20:00", s1, 1_000, 149.980, 1_000 * (149.980 - 150.002), 987_578, "net")
    ff.enter("2024-01-16 20:00", s3, 74_000, 149.980)
    ff.exit("2024-01-17 01:05", s3, 74_000, 149.942, 74_000 * (149.980 - 149.942), 987_578 + 2812, "tp")
    es = estar(order=(0.04 * 10_000 * 149.982 + 120, "2024-01-16 20:00"), nyclose=(0.04 * 10_000 * 150.032 + 640, "2024-01-16 21:55"),
               losscut=(0.5 * 0.04 * 10_000 * 150.032 + 660, "2024-01-16 21:55"), loss=(660.0, "2024-01-16 21:55"), binding="nyclose", lost=640.0)
    return {
        "name": "net_partial",
        "what": "the told row 'net' (AS order, oldest first): a SELL closing part of an open BUY, then a SELL closing the rest and opening only the remainder",
        "hand": [
            "Runs row_net_F10k_C0 (start 0) and row_net_FF1_C0 (from 988,500 yen, chosen so the units fall from 76,000 to 75,000 by a small move). USD/JPY only, spread 0.4 pip.",
            "S1 BUY, T Tue 2024-01-16 12:00: mid 150.000, fill 150.002, TP1 150.040, stop 149.870. F10k 10,000; FF1 0.01 x 988,500 / 0.13 = 76,038 -> 76,000 (margin 456,000): enter.",
            "S2 SELL, T 16:00: its 4-hour close bid 149.990 / ask 149.994, mid 149.992; the AS order sells at the bid, 149.990, and first closes the open BUY.",
            "  F10k: 10,000 against S1's 10,000: S1 out whole at 149.990, reason 'net': 10,000 x (149.990 - 150.002) = -120. Nothing is left to open: S2 is not a trade.",
            "  FF1: E at T = 988,500 + 76,000 x (149.990 - 150.002) = 987,588 -> 0.01 x 987,588 / 0.13 = 75,968 -> 75,000. 75,000 of S1 closed at 149.990: -900 (987,600); S1 keeps 1,000 with its own TP1 and stop. S2 opens nothing.",
            "S3 SELL, T 20:00: close bid 149.980 / ask 149.984, mid 149.982; TP1 149.942, stop 150.112; sells at 149.980.",
            "  F10k: no BUY open: enter 10,000 SELL at 149.980 (the order term: 0.04 x 10,000 x 149.982 = 59,992.8, less the P/L at T, -120: 60,112.8).",
            "  FF1: E = 987,600 + 1,000 x (149.980 - 150.002) = 987,578 -> 75,968 -> 75,000. First S1's last 1,000 closed at 149.980: -22 (987,578); the remainder 74,000 is judged alone: margin 0.04 x 74,000 x 149.982 = 443,946.72 <= 987,578: enter 74,000 SELL at 149.980.",
            "NY close Tue 21:55: bid 150.030, ask 150.034, mid 150.032 (S1's TP1 150.040 not reached).",
            "  F10k: P/L -120 + 10,000 x (149.980 - 150.034) = -660 (exit side), -640 on mids; margin 0.04 x 10,000 x 150.032 = 60,012.8.",
            "  FF1: E on mids 987,578 + 74,000 x (149.980 - 150.032) = 983,730 >= margin 444,094.72: no call.",
            "Wed 01:00 bar: ask low 149.930 <= S3's TP1 149.942 (ask open 149.964): out at 149.942 (01:05). F10k 10,000 x 0.038 = 380 (balance 260); FF1 74,000 x 0.038 = 2,812 (990,390).",
            "  (S1's own exit, the stop at Wed 03:05, and S2's TP1 at Wed 01:05 are the trades' own; nothing of them is open in either account then.)",
            "F10k E*: order 60,112.8 (Tue 20:00; S1's 60,000 at 12:00 is less); NY close 21:55 60,012.8 + 640 = 60,652.8 (the largest); loss-cut term 21:55 30,006.4 + 660 = 30,666.4; loss 660 at 21:55 (14:05, S1 at 149.940: 620).",
            "  E* = 60,652.8: lost 640, margin 60,012.8. Taken: S1 and S3 (2); S2 only closed.",
            "Plants: exitlate (S3 out at 03:05, the next USD/JPY bar).",
        ],
        "pairs": ["USD/JPY"],
        "bars": {
            "USD/JPY": [flat("2024-01-16 11:55", 149.998), flat("2024-01-16 12:00", 149.998), flat("2024-01-16 14:00", 149.940), flat("2024-01-16 15:55", 149.990),
                        flat("2024-01-16 19:55", 149.980), flat("2024-01-16 21:50", 150.030), ohlc("2024-01-17 01:00", 149.960, 149.960, 149.926, 149.930),
                        ohlc("2024-01-17 03:00", 149.920, 149.920, 149.860, 149.870), flat("2024-01-17 03:05", 149.870)],
        },
        "signals": [("USD/JPY", "2024-01-16 08:00", "BUY"), ("USD/JPY", "2024-01-16 12:00", "SELL"), ("USD/JPY", "2024-01-16 16:00", "SELL")],
        "runs": [run("row_net_F10k_C0", "F10k", row="net"), run("row_net_FF1_C0", "FF1", row="net", start=988_500)],
        "expect": {
            "row_net_F10k_C0": {"ledger": f10.rows, "summary": summary(260.0, taken=2, estar=es)},
            "row_net_FF1_C0": {"ledger": ff.rows, "summary": summary(990_390.0, taken=2)},
        },
        "plants": ["exitlate"],
    }


FIXTURES.append(net_partial)


# ---- hedge_margin_and_cure: MAX margin, and closing the larger side ---------------------------


def hedge_margin_and_cure():
    s1, s2, s3 = tid("USD/JPY", "2024-01-22 08:00", "BUY"), tid("GBP/JPY", "2024-01-22 08:00", "BUY"), tid("USD/JPY", "2024-01-22 12:00", "SELL")
    m_tau = 0.04 * (77_000 * 138.030 + 76_000 * 189.930)
    e_mid = 1_000_000 + 76_000 * (138.030 - 138.002) - 77_000 * (138.030 - 138.028) + 76_000 * (189.930 - 190.002)
    led = Ledger()
    led.enter("2024-01-22 12:00", s1, 76_000, 138.002, margin=0.04 * 76_000 * 138.000)
    led.enter("2024-01-22 12:00", s2, 76_000, 190.002, margin=0.04 * 76_000 * (138.000 + 190.000))
    led.enter("2024-01-22 16:00", s3, 77_000, 138.028, margin=0.04 * (77_000 * 138.030 + 76_000 * 190.030))
    led.call("2024-01-22 21:55", m_tau - e_mid, m_tau)
    led.exit("2024-01-23 00:05", s3, 77_000, 137.990, 77_000 * (138.028 - 137.990), 1_002_926, "tp")
    led.exit("2024-01-23 01:05", s1, 76_000, 138.040, 76_000 * (138.040 - 138.002), 1_005_814, "tp")
    led.cure("2024-01-23 01:05")
    led.exit("2024-01-23 02:05", s2, 76_000, 190.040, 76_000 * (190.040 - 190.002), 1_008_702, "tp")
    return {
        "name": "hedge_margin_and_cure",
        "what": "a hedge's margin on the larger side only (MAX), a call, the larger side closed first (releasing only the difference: no cure), then the other (cure)",
        "hand": [
            "Run FF1_C0 from 1,000,000. JPY pairs, spread 0.4 pip. Units = floor(E / 13,000) x 1,000 at 1%.",
            "T Mon 2024-01-22 12:00: S1 USD/JPY BUY (mid 138.000, fill 138.002, TP1 138.040, stop 137.870) and S2 GBP/JPY BUY (mid 190.000, fill 190.002, TP1 190.040, stop 189.870). E = 1,000,000: 76,000 each.",
            "  Margin after S1 0.04 x 76,000 x 138 = 419,520; after S2 + 0.04 x 76,000 x 190 = 577,600 -> 997,120 <= 1,000,000: both enter.",
            "T 16:00: S3 USD/JPY SELL (close bid 138.028 / ask 138.032, mid 138.030; TP1 137.990, stop 138.160; sells at 138.028). GBP/JPY bid 190.028 (mid 190.030).",
            "  E = 1,000,000 + 76,000 x (138.028 - 138.002) + 76,000 x (190.028 - 190.002) = 1,003,952 -> 77,000 units.",
            "  Margin after, MAX a pair: USD/JPY max(76,000 long, 77,000 short) x 138.030 x 0.04 = 425,132.4; GBP/JPY 76,000 x 190.030 x 0.04 = 577,691.2; total 1,002,823.6 <= 1,003,952: enter (longs plus shorts would be 1,422,434.8: skip).",
            "NY close Mon 21:55: USD/JPY bid 138.028 (mid 138.030), GBP/JPY bid 189.928 (mid 189.930).",
            "  Loss-cut first: E = 1,000,000 + 1,976 (S1) - 308 (S3: (138.032 - 138.028) x 77,000) - 5,624 (S2) = 996,044 >= half the margin: none.",
            "  On mids: 1,000,000 + 76,000 x 0.028 - 77,000 x 0.002 + 76,000 x (189.930 - 190.002) = 1,000,000 + 2,128 - 154 - 5,472 = 996,502.",
            "  Margin 0.04 x (77,000 x 138.030 + 76,000 x 189.930) = 425,132.4 + 577,387.2 = 1,002,519.6 > 996,502: call, C = 6,017.6. Deadline Tue 09:00.",
            "Tue 00:00 bar: USD/JPY ask low 137.986 <= S3's TP1 137.990: S3 (the larger side) out at 137.990 (00:05): 77,000 x 0.038 = 2,926 (1,002,926).",
            "  Cure test at the call's mids: the positions held at the call still open, S1 76,000 long and S2: 0.04 x (76,000 x 138.030 + 76,000 x 189.930) = 996,998.4. Released 1,002,519.6 - 996,998.4 = 5,521.2 (only the 1,000 difference) < 6,017.6: no cure.",
            "Tue 01:00 bar: USD/JPY bid high 138.045: S1 out at TP1 138.040 (01:05): 76,000 x 0.038 = 2,888 (1,005,814). Now only S2: 577,387.2 held; released 425,132.4 >= C: cure at 01:05.",
            "Tue 02:00 bar: GBP/JPY bid high 190.050: S2 out at 190.040 (02:05): 2,888 (1,008,702).",
            "Plants: hedgesum skips S3 for margin (1,422,434.8 > 1,003,952). callexitside makes C 1,002,519.6 - 996,044 = 6,475.6. marginentry fixes the margin at the entry prices, so C is not 6,017.6.",
            "  exitlate: S3 out at 01:05 (its next bar), the cure then; pipplus: S1's exit 1 pip better.",
        ],
        "pairs": ["USD/JPY", "GBP/JPY"],
        "bars": {
            "USD/JPY": [flat("2024-01-22 11:55", 137.998), flat("2024-01-22 15:55", 138.028), flat("2024-01-22 21:50", 138.028),
                        ohlc("2024-01-23 00:00", 138.010, 138.010, 137.982, 137.990), ohlc("2024-01-23 01:00", 138.000, 138.045, 138.000, 138.040), flat("2024-01-23 01:05", 138.040)],
            "GBP/JPY": [flat("2024-01-22 11:55", 189.998), flat("2024-01-22 15:55", 190.028), flat("2024-01-22 21:50", 189.928),
                        ohlc("2024-01-23 02:00", 189.990, 190.050, 189.990, 190.040), flat("2024-01-23 02:05", 190.040)],
        },
        "signals": [("USD/JPY", "2024-01-22 08:00", "BUY"), ("GBP/JPY", "2024-01-22 08:00", "BUY"), ("USD/JPY", "2024-01-22 12:00", "SELL")],
        "runs": [run("FF1_C0", "FF1")],
        "expect": {"FF1_C0": {"ledger": led.rows, "summary": summary(1_008_702.0, taken=3, calls=1, cures=1)}},
        "plants": ["hedgesum", "callexitside", "marginentry", "exitlate", "pipplus"],
    }


FIXTURES.append(hedge_margin_and_cure)


# ---- the calls: cured by an exit, closed at the deadline, Friday to Monday -------------------


def call_cured_by_exit():
    eu, ch, au = tid("EUR/JPY", "2024-01-23 08:00", "BUY"), tid("CHF/JPY", "2024-01-23 08:00", "BUY"), tid("AUD/JPY", "2024-01-23 20:00", "BUY")
    m_tau = 0.04 * 76_000 * (159.950 + 167.950)
    e_mid = 1_000_000 + 76_000 * (159.950 - 160.002) + 76_000 * (167.950 - 168.002)
    led = Ledger()
    led.enter("2024-01-23 12:00", eu, 76_000, 160.002)
    led.enter("2024-01-23 12:00", ch, 76_000, 168.002)
    led.call("2024-01-23 21:55", m_tau - e_mid, m_tau)
    led.skip("2024-01-24 00:00", au, "call")
    led.exit("2024-01-24 01:05", ch, 76_000, 168.040, 76_000 * (168.040 - 168.002), 1_002_888, "tp")
    led.cure("2024-01-24 01:05")
    led.exit("2024-01-24 02:05", eu, 76_000, 159.870, 76_000 * (159.870 - 160.002), 1_002_888 - 10_032, "sl")
    return {
        "name": "call_cured_by_exit",
        "what": "a call at the NY close on mids, an email skipped while it is open, equity back over the margin (not a cure), then cured by a take-profit releasing the call's margin",
        "hand": [
            "Run FF1_C0 from 1,000,000. JPY pairs, spread 0.4 pip.",
            "T Tue 2024-01-23 12:00: EUR/JPY BUY (mid 160.000, fill 160.002, TP1 160.040, stop 159.870), CHF/JPY BUY (mid 168.000, fill 168.002, TP1 168.040, stop 167.870). 76,000 each.",
            "  Margin after EUR/JPY 0.04 x 76,000 x 160 = 486,400; after CHF/JPY + 510,720 = 997,120 <= 1,000,000: both enter.",
            "NY close Tue 21:55 (winter): bids 159.948 and 167.948, mids 159.950 and 167.950.",
            "  Loss-cut: E = 1,000,000 - 76,000 x 0.054 x 2 = 991,792 >= half of 996,816: none.",
            "  On mids: E = 1,000,000 - 76,000 x 0.052 x 2 = 992,096; margin 0.04 x 76,000 x (159.950 + 167.950) = 996,816: call, C = 4,720. Deadline Wed 09:00.",
            "Wed 00:00 (bars 23:55-00:00 end): mids back at 160.000 and 168.000: E on mids 999,696 >= margin 997,120, but a move back is not a cure (nothing was closed).",
            "  T Wed 00:00: AUD/JPY BUY (bar Tue 20:00, mid 100.000): the call is open: skip 'call'.",
            "Wed 01:00 CHF/JPY bid high 168.045: out at TP1 168.040 (01:05): 76,000 x 0.038 = 2,888 (1,002,888).",
            "  Cure test at the call's mids: EUR/JPY still held, 0.04 x 76,000 x 159.950 = 486,248; released 996,816 - 486,248 = 510,568 >= 4,720: cure at 01:05.",
            "Wed 02:00 EUR/JPY bid low 159.860: out at the stop 159.870 (02:05): 76,000 x -0.132 = -10,032 (992,856).",
            "Plants: callexitside: C on the exit side 996,816 - 991,792 = 5,024. marginentry: the margin at the entry prices (997,120, or 997,132.16 at the fills) gives another C.",
            "  curemove cures at Wed 00:00 when the mids come back, so the AUD/JPY email is judged as if no call were open (then 'margin', 1,301,120 > 999,392). exitlate, pipplus (EUR/JPY's stop 1 pip better) move the exits.",
        ],
        "pairs": ["EUR/JPY", "AUD/JPY", "CHF/JPY"],
        "bars": {
            "EUR/JPY": [flat("2024-01-23 11:55", 159.998), flat("2024-01-23 21:50", 159.948), flat("2024-01-23 23:55", 159.998),
                        ohlc("2024-01-24 02:00", 159.990, 159.990, 159.860, 159.870), flat("2024-01-24 02:05", 159.870)],
            "CHF/JPY": [flat("2024-01-23 11:55", 167.998), flat("2024-01-23 21:50", 167.948), flat("2024-01-23 23:55", 167.998),
                        ohlc("2024-01-24 01:00", 168.000, 168.045, 168.000, 168.040), flat("2024-01-24 01:05", 168.040)],
            "AUD/JPY": [flat("2024-01-23 23:55", 99.998), ohlc("2024-01-24 00:30", 99.998, 100.045, 99.998, 100.040), flat("2024-01-24 00:35", 100.040)],
        },
        "signals": [("EUR/JPY", "2024-01-23 08:00", "BUY"), ("CHF/JPY", "2024-01-23 08:00", "BUY"), ("AUD/JPY", "2024-01-23 20:00", "BUY")],
        "runs": [run("FF1_C0", "FF1")],
        "expect": {"FF1_C0": {"ledger": led.rows, "summary": summary(992_856.0, taken=2, call=1, calls=1, cures=1)}},
        "plants": ["callexitside", "marginentry", "curemove", "exitlate", "pipplus"],
    }


FIXTURES.append(call_cured_by_exit)


def call_deadline():
    us, gb = tid("USD/JPY", "2024-01-24 08:00", "BUY"), tid("GBP/JPY", "2024-01-24 08:00", "BUY")
    m_tau = 0.04 * 76_000 * (139.940 + 187.950)
    e_mid = 1_000_000 + 76_000 * (139.940 - 140.002) + 76_000 * (187.950 - 188.002)
    led = Ledger()
    led.enter("2024-01-24 12:00", us, 76_000, 140.002)
    led.enter("2024-01-24 12:00", gb, 76_000, 188.002)
    led.call("2024-01-24 21:55", m_tau - e_mid, m_tau)
    led.deadline("2024-01-25 09:00")
    led.exit("2024-01-25 09:00", us, 76_000, 139.960, 76_000 * (139.960 - 140.002), 996_808, "deadline")
    led.exit("2024-01-25 09:00", gb, 76_000, 187.980, 76_000 * (187.980 - 188.002), 995_136, "deadline")
    return {
        "name": "call_deadline",
        "what": "a call not cured: the equity comes back over the margin overnight (not a cure), and every position is closed at the deadline (next weekday 09:00 UTC) at its bar's open",
        "hand": [
            "Run FF1_C0 from 1,000,000. JPY pairs, spread 0.4 pip.",
            "T Wed 2024-01-24 12:00: USD/JPY BUY (mid 140.000, fill 140.002, TP1 140.040, stop 139.870), GBP/JPY BUY (mid 188.000, fill 188.002, TP1 188.040, stop 187.870). 76,000 each; margin 425,600 + 571,520 = 997,120: both enter.",
            "NY close Wed 21:55: bids 139.938 and 187.948 (mids 139.940, 187.950).",
            "  Loss-cut: E = 1,000,000 + 76,000 x (139.938 - 140.002) + 76,000 x (187.948 - 188.002) = 991,032: none.",
            "  On mids: 1,000,000 - 4,712 - 3,952 = 991,336; margin 0.04 x 76,000 x (139.940 + 187.950) = 996,785.6: call, C = 5,449.6. Deadline Thu 09:00 UTC.",
            "Thu 03:00 bars: mids back at 140.000 and 188.000 (E on mids 999,696 >= 997,120). Nothing closed: no cure.",
            "Thu 09:00 (the first bars opening at the deadline): close everything at each bar's open on the exit side.",
            "  USD/JPY bid open 139.960: 76,000 x (139.960 - 140.002) = -3,192 (996,808). GBP/JPY bid open 187.980: 76,000 x (187.980 - 188.002) = -1,672 (995,136).",
            "  (The trades' own exits come later: USD/JPY's stop and GBP/JPY's TP1 at 10:05; the account no longer holds them.)",
            "Plants: curemove cures at Thu 03:05 and nothing is closed at 09:00. callexitside: C = 996,785.6 - 991,032 = 5,753.6. marginentry: the margin fixed at the entry (997,120 at the entry mids, 997,132.16 at the fills) gives C = 5,784 or 5,796.16.",
        ],
        "pairs": ["USD/JPY", "GBP/JPY"],
        "bars": {
            "USD/JPY": [flat("2024-01-24 11:55", 139.998), flat("2024-01-24 21:50", 139.938), flat("2024-01-25 03:00", 139.998),
                        ohlc("2024-01-25 09:00", 139.960, 139.970, 139.950, 139.960), ohlc("2024-01-25 10:00", 139.950, 139.950, 139.860, 139.870), flat("2024-01-25 10:05", 139.870)],
            "GBP/JPY": [flat("2024-01-24 11:55", 187.998), flat("2024-01-24 21:50", 187.948), flat("2024-01-25 03:00", 187.998),
                        ohlc("2024-01-25 09:00", 187.980, 187.990, 187.970, 187.980), ohlc("2024-01-25 10:00", 187.990, 188.050, 187.990, 188.040), flat("2024-01-25 10:05", 188.040)],
        },
        "signals": [("USD/JPY", "2024-01-24 08:00", "BUY"), ("GBP/JPY", "2024-01-24 08:00", "BUY")],
        "runs": [run("FF1_C0", "FF1")],
        "expect": {"FF1_C0": {"ledger": led.rows, "summary": summary(995_136.0, taken=2, calls=1, deadlines=1)}},
        "plants": ["curemove", "callexitside", "marginentry"],
    }


FIXTURES.append(call_deadline)


def call_friday_monday():
    us, gb = tid("USD/JPY", "2024-01-26 08:00", "BUY"), tid("GBP/JPY", "2024-01-26 08:00", "BUY")
    m_tau = 0.04 * 76_000 * (141.910 + 185.970)
    e_mid = 1_000_000 + 76_000 * (141.910 - 142.002) + 76_000 * (185.970 - 186.002)
    led = Ledger()
    led.enter("2024-01-26 12:00", us, 76_000, 142.002)
    led.enter("2024-01-26 12:00", gb, 76_000, 186.002)
    led.call("2024-01-26 21:00", m_tau - e_mid, m_tau)
    led.deadline("2024-01-29 09:00")
    led.exit("2024-01-29 09:00", us, 76_000, 141.970, 76_000 * (141.970 - 142.002), 997_568, "deadline")
    led.exit("2024-01-29 09:00", gb, 76_000, 185.990, 76_000 * (185.990 - 186.002), 996_656, "deadline")
    return {
        "name": "call_friday_monday",
        "what": "a Friday call in winter, judged at the stand-in (GMO's last bar ends 21:00, before the 21:55 NY close); its deadline Monday 09:00; the weekend's recovery is not a cure",
        "hand": [
            "Run FF1_C0 from 1,000,000. JPY pairs, spread 0.4 pip.",
            "T Fri 2024-01-26 12:00: USD/JPY BUY (mid 142.000, fill 142.002, TP1 142.040, stop 141.870), GBP/JPY BUY (mid 186.000, fill 186.002, TP1 186.040, stop 185.870). 76,000 each; margin 431,680 + 565,440 = 997,120: both enter.",
            "Friday's NY close is 21:55 UTC (winter); the last 5-minute bars end at 21:00 (bids 141.908 and 185.968, mids 141.910 and 185.970), and no bar ends at 21:55, so the call is judged on 21:00's closes (the stand-in).",
            "  Loss-cut at 21:00: E = 1,000,000 + 76,000 x (141.908 - 142.002) + 76,000 x (185.968 - 186.002) = 990,272: none.",
            "  On mids: 1,000,000 - 6,992 - 2,432 = 990,576; margin 0.04 x 76,000 x (141.910 + 185.970) = 996,755.2: call, C = 6,179.2, g = 21:00. Friday: the deadline is Monday 09:00 UTC.",
            "Sun 2024-01-28 22:00 bars: mids back at 142.000 and 186.000 (E on mids 999,696 >= 997,120): not a cure. (A reader waiting for the first bar after 21:55 would see no call at all.)",
            "Mon 09:00 bars (the first at the deadline): USD/JPY bid open 141.970: -2,432 (997,568); GBP/JPY bid open 185.990: -912 (996,656).",
            "  (The trades' own exits: USD/JPY TP1 and GBP/JPY stop at Mon 10:05.)",
            "Plants: curemove cures on Sunday night. callexitside: C = 996,755.2 - 990,272 = 6,483.2. marginentry: the margin fixed at the entry (997,120 at the entry mids, 997,132.16 at the fills) gives C = 6,544 or 6,556.16.",
        ],
        "pairs": ["USD/JPY", "GBP/JPY"],
        "bars": {
            "USD/JPY": [flat("2024-01-26 11:55", 141.998), flat("2024-01-26 20:55", 141.908), flat("2024-01-28 22:00", 141.998),
                        ohlc("2024-01-29 09:00", 141.970, 141.980, 141.960, 141.970), ohlc("2024-01-29 10:00", 141.990, 142.050, 141.990, 142.040), flat("2024-01-29 10:05", 142.040)],
            "GBP/JPY": [flat("2024-01-26 11:55", 185.998), flat("2024-01-26 20:55", 185.968), flat("2024-01-28 22:00", 185.998),
                        ohlc("2024-01-29 09:00", 185.990, 186.000, 185.980, 185.990), ohlc("2024-01-29 10:00", 185.950, 185.950, 185.860, 185.870), flat("2024-01-29 10:05", 185.870)],
        },
        "signals": [("USD/JPY", "2024-01-26 08:00", "BUY"), ("GBP/JPY", "2024-01-26 08:00", "BUY")],
        "runs": [run("FF1_C0", "FF1")],
        "expect": {"FF1_C0": {"ledger": led.rows, "summary": summary(996_656.0, taken=2, calls=1, deadlines=1)}},
        "plants": ["curemove", "callexitside", "marginentry"],
    }


FIXTURES.append(call_friday_monday)


# ---- dst_week: the NY close on either side of the US switch ----------------------------------


def dst_week():
    u1, g1 = tid("USD/JPY", "2024-03-07 08:00", "BUY"), tid("GBP/JPY", "2024-03-07 08:00", "BUY")
    u2, g2 = tid("USD/JPY", "2024-03-11 08:00", "BUY"), tid("GBP/JPY", "2024-03-11 08:00", "BUY")
    m_tau = 0.04 * 77_000 * (146.970 + 178.970)
    e_mid = 1_005_776 + 77_000 * (146.970 - 147.002) + 77_000 * (178.970 - 179.002)
    led = Ledger()
    led.enter("2024-03-07 12:00", u1, 76_000, 140.002)
    led.enter("2024-03-07 12:00", g1, 76_000, 186.002)
    led.exit("2024-03-08 01:05", u1, 76_000, 140.040, 76_000 * 0.038, 1_002_888, "tp")
    led.exit("2024-03-08 01:05", g1, 76_000, 186.040, 76_000 * 0.038, 1_005_776, "tp")
    led.enter("2024-03-11 12:00", u2, 77_000, 147.002)
    led.enter("2024-03-11 12:00", g2, 77_000, 179.002)
    led.call("2024-03-11 20:55", m_tau - e_mid, m_tau)
    led.exit("2024-03-12 01:05", u2, 77_000, 147.040, 77_000 * 0.038, 1_008_702, "tp")
    led.cure("2024-03-12 01:05")
    led.exit("2024-03-12 02:05", g2, 77_000, 179.040, 77_000 * 0.038, 1_011_628, "tp")
    return {
        "name": "dst_week",
        "what": "the NY close moves with US daylight time (from 2024-03-10): Thursday 7 March judged at 21:55 UTC (no call, though 20:55 is under the margin), Monday 11 March at 20:55 UTC (call, though 21:55 is over it)",
        "hand": [
            "Run FF1_C0 from 1,000,000. JPY pairs, spread 0.4 pip. Rakuten's NY close is 16:55 New York time: 21:55 UTC in US standard time, 20:55 UTC in daylight time (from Sun 2024-03-10 02:00 New York).",
            "T Thu 2024-03-07 12:00: USD/JPY BUY (mid 140.000, fill 140.002, TP1 140.040, stop 139.870) and GBP/JPY BUY (mid 186.000, fill 186.002, TP1 186.040, stop 185.870): 76,000 each; margin 425,600 + 565,440 = 991,040: both enter.",
            "  Thu 20:55 bars: bids 139.928 and 185.928 (mids 139.930, 185.930): E on mids 1,000,000 - 76,000 x 0.072 x 2 = 989,056 < margin 0.04 x 76,000 x 325.86 = 990,614.4, but 20:55 is not Thursday's NY close (winter): nothing.",
            "  Thu 21:55 (the NY close): back at 139.998 and 185.998: E on mids 999,696 >= 991,040: no call.",
            "  Fri 01:00 bars: bid highs 140.045 and 186.045: both out at TP1 (01:05): 76,000 x 0.038 = 2,888 each: 1,002,888, then 1,005,776. Nothing open at Friday's NY close.",
            "T Mon 2024-03-11 12:00: USD/JPY BUY (mid 147.000, fill 147.002, TP1 147.040) and GBP/JPY BUY (mid 179.000, fill 179.002, TP1 179.040). E = 1,005,776: floor(1,005,776 / 13,000) = 77 -> 77,000 each.",
            "  Margin after 0.04 x 77,000 x 147 = 452,760; + 0.04 x 77,000 x 179 = 551,320 -> 1,004,080 <= 1,005,776: both enter.",
            "  Mon 20:55 (the NY close, summer): bids 146.968 and 178.968 (mids 146.970, 178.970). Loss-cut: E = 1,005,776 - 77,000 x 0.034 x 2 = 1,000,540: none.",
            "  On mids: 1,005,776 - 77,000 x 0.032 x 2 = 1,000,848; margin 0.04 x 77,000 x (146.970 + 178.970) = 1,003,895.2: call, C = 3,047.2. Deadline Tue 09:00.",
            "  Mon 21:55: back at 146.998 and 178.998 (E on mids 1,005,468 >= 1,004,080): not a cure, and not a NY close now.",
            "  Tue 01:00 USD/JPY bid high 147.045: out at 147.040 (01:05): 77,000 x 0.038 = 2,926 (1,008,702). Cure test: GBP/JPY still held, 0.04 x 77,000 x 178.970 = 551,227.6; released 452,667.6 >= 3,047.2: cure at 01:05.",
            "  Tue 02:00 GBP/JPY bid high 179.045: out at 179.040 (02:05): 2,926 (1,011,628).",
            "Plants: nysummer judges Monday at 21:55, where E on mids is over the margin: no call, no cure. A reader with the switch on the wrong Sunday calls on Thursday at 20:55 instead.",
            "  curemove cures at 21:55. callexitside: C = 1,003,895.2 - 1,000,540 = 3,355.2. marginentry: C on the entry prices. exitlate and pipplus move exits.",
        ],
        "pairs": ["USD/JPY", "GBP/JPY"],
        "bars": {
            "USD/JPY": [flat("2024-03-07 11:55", 139.998), flat("2024-03-07 20:50", 139.928), flat("2024-03-07 21:50", 139.998),
                        ohlc("2024-03-08 01:00", 140.000, 140.045, 140.000, 140.040), flat("2024-03-08 01:05", 140.040),
                        flat("2024-03-11 11:55", 146.998), flat("2024-03-11 20:50", 146.968), flat("2024-03-11 21:50", 146.998),
                        ohlc("2024-03-12 01:00", 147.000, 147.045, 147.000, 147.040), flat("2024-03-12 01:05", 147.040)],
            "GBP/JPY": [flat("2024-03-07 11:55", 185.998), flat("2024-03-07 20:50", 185.928), flat("2024-03-07 21:50", 185.998),
                        ohlc("2024-03-08 01:00", 186.000, 186.045, 186.000, 186.040), flat("2024-03-08 01:05", 186.040),
                        flat("2024-03-11 11:55", 178.998), flat("2024-03-11 20:50", 178.968), flat("2024-03-11 21:50", 178.998),
                        ohlc("2024-03-12 02:00", 179.000, 179.045, 179.000, 179.040), flat("2024-03-12 02:05", 179.040)],
        },
        "signals": [("USD/JPY", "2024-03-07 08:00", "BUY"), ("GBP/JPY", "2024-03-07 08:00", "BUY"), ("USD/JPY", "2024-03-11 08:00", "BUY"), ("GBP/JPY", "2024-03-11 08:00", "BUY")],
        "runs": [run("FF1_C0", "FF1")],
        "expect": {"FF1_C0": {"ledger": led.rows, "summary": summary(1_011_628.0, taken=4, calls=1, cures=1)}},
        "plants": ["nysummer", "curemove", "callexitside", "marginentry", "exitlate", "pipplus"],
    }


FIXTURES.append(dst_week)


# ---- missing_bar: a pair without a bar at a grid time uses its last close --------------------


def missing_bar():
    us, gb = tid("USD/JPY", "2024-02-01 08:00", "BUY"), tid("GBP/JPY", "2024-02-01 08:00", "BUY")
    m_tau = 0.04 * 76_000 * (144.960 + 182.890)
    e_mid = 1_000_000 + 76_000 * (144.960 - 145.002) + 76_000 * (182.890 - 183.002)
    ff = Ledger()
    ff.enter("2024-02-01 12:00", us, 76_000, 145.002)
    ff.enter("2024-02-01 12:00", gb, 76_000, 183.002)
    ff.call("2024-02-01 21:55", m_tau - e_mid, m_tau)
    ff.exit("2024-02-02 01:05", us, 76_000, 145.040, 76_000 * 0.038, 1_002_888, "tp")
    ff.cure("2024-02-02 01:05")
    ff.exit("2024-02-02 02:05", gb, 76_000, 183.040, 76_000 * 0.038, 1_005_776, "tp")
    f10 = Ledger()
    f10.enter("2024-02-01 12:00", us, 10_000, 145.002)
    f10.enter("2024-02-01 12:00", gb, 10_000, 183.002)
    f10.exit("2024-02-02 01:05", us, 10_000, 145.040, 380.0, 380.0, "tp")
    f10.exit("2024-02-02 02:05", gb, 10_000, 183.040, 380.0, 760.0, "tp")
    m10 = 0.04 * 10_000 * (144.960 + 182.890)
    es = estar(order=(0.04 * 10_000 * (145.0 + 183.0), "2024-02-01 12:00"), nyclose=(m10 + 1540, "2024-02-01 21:55"),
               losscut=(0.5 * m10 + 1580, "2024-02-01 21:55"), loss=(1580.0, "2024-02-01 21:55"), binding="nyclose", lost=1540.0)
    return {
        "name": "missing_bar",
        "what": "GBP/JPY has no bar ending at the NY close (its last ended 21:25): the call and E*'s terms use its last close; USD/JPY is current",
        "hand": [
            "Runs FF1_C0 (1,000,000) and F10k_C0 (start 0). JPY pairs, spread 0.4 pip.",
            "T Thu 2024-02-01 12:00: USD/JPY BUY (mid 145.000, fill 145.002, TP1 145.040, stop 144.870), GBP/JPY BUY (mid 183.000, fill 183.002, TP1 183.040, stop 182.870).",
            "  FF1: 76,000 each; margin 440,800 + 556,320 = 997,120: both enter. F10k: 10,000 each; order term 0.04 x 10,000 x (145 + 183) = 131,200 (P/L 0).",
            "Bars: both 12:00 (bid 144.998 / 182.998); GBP/JPY 21:20 (ends 21:25) bid 182.888 (mid 182.890); USD/JPY 21:50 (ends 21:55, the NY close) bid 144.958 (mid 144.960); GBP/JPY 22:30 bid 182.958; Fri 01:00 USD/JPY TP1; Fri 02:00 GBP/JPY TP1.",
            "NY close Thu 21:55: USD/JPY's own close; GBP/JPY has no bar ending 21:55, its last close (21:25) is used.",
            "  FF1 loss-cut: E = 1,000,000 + 76,000 x (144.958 - 145.002) + 76,000 x (182.888 - 183.002) = 987,992: none.",
            "  FF1 on mids: 1,000,000 - 3,192 - 8,512 = 988,296; margin 0.04 x 76,000 x (144.960 + 182.890) = 996,664: call, C = 8,368.",
            "Fri 01:00 USD/JPY bid high 145.050: out at 145.040 (01:05): FF1 2,888 (1,002,888); cure test: GBP/JPY held, 0.04 x 76,000 x 182.890 = 555,985.6, released 440,678.4 >= 8,368: cure. Fri 02:00 GBP/JPY out at 183.040: 2,888 (1,005,776).",
            "F10k: USD/JPY 380, GBP/JPY 380: 760.",
            "F10k E*: NY close Thu 21:55: P/L on mids 10,000 x (144.960 - 145.002 + 182.890 - 183.002) = -1,540; margin 0.04 x 10,000 x 327.85 = 131,140; 132,680 (the largest).",
            "  Loss-cut term: 12:05 65,600 + 80; 21:25 (USD/JPY's last close 144.998, GBP/JPY 182.888): 0.5 x 0.04 x 10,000 x (145.000 + 182.890) + 1,180 = 66,758; 21:55: 65,570 + 1,580 = 67,150 (the largest); 22:35: 65,584 + 880.",
            "  Loss term: 21:55, 10,000 x (144.958 - 145.002) + 10,000 x (182.888 - 183.002) = -440 - 1,140 = -1,580 -> 1,580.",
            "  E* = 132,680 from the NY close: lost 1,540, margin 131,140.",
            "Plants: callexitside: C = 996,664 - 987,992 = 8,672. marginentry: C on the entry prices. exitlate, pipplus (USD/JPY's exit 1 pip better) move the exits.",
        ],
        "pairs": ["USD/JPY", "GBP/JPY"],
        "bars": {
            "USD/JPY": [flat("2024-02-01 11:55", 144.998), flat("2024-02-01 12:00", 144.998), flat("2024-02-01 21:50", 144.958),
                        ohlc("2024-02-02 01:00", 144.990, 145.050, 144.990, 145.040), flat("2024-02-02 01:05", 145.040)],
            "GBP/JPY": [flat("2024-02-01 11:55", 182.998), flat("2024-02-01 12:00", 182.998), flat("2024-02-01 21:20", 182.888), flat("2024-02-01 22:30", 182.958),
                        ohlc("2024-02-02 02:00", 182.990, 183.050, 182.990, 183.040), flat("2024-02-02 02:05", 183.040)],
        },
        "signals": [("USD/JPY", "2024-02-01 08:00", "BUY"), ("GBP/JPY", "2024-02-01 08:00", "BUY")],
        "runs": [run("FF1_C0", "FF1"), run("F10k_C0", "F10k")],
        "expect": {
            "FF1_C0": {"ledger": ff.rows, "summary": summary(1_005_776.0, taken=2, calls=1, cures=1)},
            "F10k_C0": {"ledger": f10.rows, "summary": summary(760.0, taken=2, estar=es)},
        },
        "plants": ["callexitside", "marginentry", "exitlate", "pipplus"],
    }


FIXTURES.append(missing_bar)


# ---- gap_losscut: the week's opening gap, the margin full, the loss-cut -----------------------


def gap_losscut():
    us, eu, nz = tid("USD/JPY", "2024-01-12 12:00", "SELL"), tid("EUR/USD", "2024-01-12 12:00", "BUY"), tid("NZD/JPY", "2024-01-12 12:00", "BUY")
    loss = -76_000 * (160.852 - 149.998)
    mark = 51_000 * (1.09998 - 1.10002) * 160.85
    ff = Ledger()
    ff.enter("2024-01-12 16:00", us, 76_000, 149.998)
    ff.enter("2024-01-12 16:00", eu, 51_000, 1.10002)
    ff.skip("2024-01-12 16:00", nz, "margin")
    ff.exit("2024-01-14 22:05", us, 76_000, 160.852, loss, 1_000_000 + loss, "sl")
    ff.losscut("2024-01-14 22:05", 1_000_000 + loss + mark)
    ff.exit("2024-01-14 22:05", eu, 51_000, 1.09998, mark, 1_000_000 + loss + mark, "losscut")
    l10 = -10_000 * (160.852 - 149.998)
    win = 10_000 * (1.10040 - 1.10002) * 160.85
    f10 = Ledger()
    f10.enter("2024-01-12 16:00", us, 10_000, 149.998)
    f10.enter("2024-01-12 16:00", eu, 10_000, 1.10002)
    f10.enter("2024-01-12 16:00", nz, 10_000, 80.002)
    f10.exit("2024-01-14 22:05", us, 10_000, 160.852, l10, l10, "sl")
    f10.exit("2024-01-15 01:05", eu, 10_000, 1.10040, win, l10 + win, "tp")
    f10.exit("2024-01-15 01:05", nz, 10_000, 80.040, 380.0, l10 + win + 380, "tp")
    p2210 = l10 + 10_000 * (1.09990 - 1.10002) * 160.85 - 40
    es = estar(order=(158_000.0, "2024-01-12 16:00"), nyclose=(158_070.0, "2024-01-12 21:00"),
               losscut=(0.5 * (0.04 * 10_000 * 1.09992 * 160.85 + 32_000) - p2210, "2024-01-14 22:10"), loss=(-p2210, "2024-01-14 22:10"),
               binding="losscut", lost=-p2210)
    return {
        "name": "gap_losscut",
        "what": "the margin full on Friday (a third email skipped 'margin'), Sunday's opening gap through a USD/JPY SELL's stop, and the loss-cut on that first bar of the week of the EUR/USD left, its yen margin risen with USD/JPY",
        "hand": [
            "Runs FF1_C0 (1,000,000) and F10k_C0 (start 0). Spread 0.4 pip (USD/JPY, NZD/JPY 0.004; EUR/USD 0.00004).",
            "T Fri 2024-01-12 16:00 (bar 12:00), in admission order: USD/JPY SELL (mid 150.000; sells at the bid 149.998; TP1 149.960, stop 150.130), EUR/USD BUY (bid 1.09998 / ask 1.10002, mid 1.10000; fill 1.10002, TP1 1.10040, stop 1.09870), NZD/JPY BUY (mid 80.000, fill 80.002, TP1 80.040).",
            "  FF1: E = 1,000,000. USD/JPY 0.01 x 1,000,000 / 0.13 -> 76,000; EUR/USD: 13 pips = 0.0013 x 150.000 (USD/JPY mid at T) = 0.195 yen a unit -> 51,282 -> 51,000; NZD/JPY 76,000.",
            "  Margin after USD/JPY 0.04 x 76,000 x 150 = 456,000; after EUR/USD + 0.04 x 51,000 x 1.1 x 150 = 336,600 -> 792,600; after NZD/JPY + 0.04 x 76,000 x 80 = 243,200 -> 1,035,800 > 1,000,000: NZD/JPY skipped 'margin'.",
            "Fri 20:55 bars (end 21:00, GMO's last of the week): unchanged. Friday's NY close is 21:55 (winter): no bar ends then, 21:00 stands in.",
            "  FF1 on mids: 1,000,000 - 76,000 x 0.002 - 51,000 x 0.00002 x 150 = 999,695 >= 792,600: no call.",
            "Sun 2024-01-14 22:00 bars, the week's first: USD/JPY bid opens 160.848, ask 160.852, past the SELL's stop 150.130: out at the ask open 160.852 (x = 22:05). EUR/USD unchanged (bid 1.09998), NZD/JPY 79.998.",
            "  FF1: -76,000 x (160.852 - 149.998) = -824,904 -> balance 175,096.",
            "  Loss-cut test at 22:05, on the exit side, EUR/USD turned at USD/JPY's mid then, 160.850: E = 175,096 + 51,000 x (1.09998 - 1.10002) x 160.85 = 175,096 - 328.134 = 174,767.866.",
            "  Margin 0.04 x 51,000 x 1.1 x 160.85 = 360,947.4 (it rose with USD/JPY); half 180,473.7 > E: loss-cut, EUR/USD closed at 1.09998: -328.134 -> 174,767.866.",
            "  With the margin fixed at the entry (USD/JPY 150), half would be 168,300 (168,303.06 at the fill) < 174,767.866: no loss-cut.",
            "F10k: all three enter, 10,000 each. USD/JPY -10,000 x 10.854 = -108,540 (Sun 22:05). Mon 01:00: EUR/USD bid high 1.10045, out at TP1 1.10040: 10,000 x 0.00038 x 160.85 = 611.23; NZD/JPY at TP1 80.040: 380. Balance -107,548.77.",
            "F10k E*: order: 60,000, + 66,000, + 32,000 = 158,000 (Fri 16:00, P/L 0).",
            "  NY close (stand-in Fri 21:00): P/L on mids -20 - 30 - 20 = -70; margin 158,000; 158,070.",
            "  Loss-cut term: Fri 16:05 and 21:00 79,000 + 140; Sun 22:05 (P/L -108,540 - 64.34 - 40 = -108,644.34; margin 0.04 x 10,000 x 1.1 x 160.85 + 32,000 = 102,774) 51,387 + 108,644.34 = 160,031.34;",
            "    Sun 22:10 (EUR/USD bid 1.09990: P/L -108,540 - 193.02 - 40 = -108,773.02; margin 0.04 x 10,000 x 1.09992 x 160.85 + 32,000 = 102,768.8528) 51,384.4264 + 108,773.02 = 160,157.4464 (the largest).",
            "  Loss term: 108,773.02 at Sun 22:10 (the end, flat: 107,548.77). E* = 160,157.4464 from the loss-cut term: lost 108,773.02, margin 51,384.4264.",
            "Plants: skipgaplc skips Sunday's first test: the loss-cut comes at 22:10 (EUR/USD at 1.09990). marginentry keeps EUR/USD (no loss-cut; it later reaches TP1). usdentry turns EUR/USD at 150: -306, not -328.134.",
            "  exitlate moves USD/JPY's exit to 22:10; pipplus (USD/JPY, the first trade) 1 pip better.",
        ],
        "pairs": ["USD/JPY", "EUR/USD", "NZD/JPY"],
        "bars": {
            "USD/JPY": [flat("2024-01-12 15:55", 149.998), flat("2024-01-12 20:55", 149.998), ohlc("2024-01-14 22:00", 160.848, 160.900, 160.800, 160.848),
                        flat("2024-01-14 22:05", 160.848), flat("2024-01-15 01:00", 160.848)],
            "EUR/USD": [flat("2024-01-12 15:55", 1.09998, 0.00004), flat("2024-01-12 20:55", 1.09998, 0.00004), flat("2024-01-14 22:00", 1.09998, 0.00004),
                        flat("2024-01-14 22:05", 1.09990, 0.00004), ohlc("2024-01-15 01:00", 1.09990, 1.10045, 1.09990, 1.10040, 0.00004), flat("2024-01-15 01:05", 1.10040, 0.00004)],
            "NZD/JPY": [flat("2024-01-12 15:55", 79.998), flat("2024-01-12 20:55", 79.998), flat("2024-01-14 22:00", 79.998), flat("2024-01-14 22:05", 79.998),
                        ohlc("2024-01-15 01:00", 79.998, 80.050, 79.998, 80.040), flat("2024-01-15 01:05", 80.040)],
        },
        "signals": [("USD/JPY", "2024-01-12 12:00", "SELL"), ("EUR/USD", "2024-01-12 12:00", "BUY"), ("NZD/JPY", "2024-01-12 12:00", "BUY")],
        "runs": [run("FF1_C0", "FF1"), run("F10k_C0", "F10k")],
        "expect": {
            "FF1_C0": {"ledger": ff.rows, "summary": summary(1_000_000 + loss + mark, taken=2, margin=1, losscuts=1)},
            "F10k_C0": {"ledger": f10.rows, "summary": summary(l10 + win + 380, taken=3, estar=es)},
        },
        "plants": ["skipgaplc", "marginentry", "usdentry", "exitlate", "pipplus"],
    }


FIXTURES.append(gap_losscut)


# ---- turtle_cap: the Turtles' cut, and its cap at the equity -----------------------------------


def turtle_cap():
    us, eu, au = tid("USD/JPY", "2024-02-05 04:00", "BUY"), tid("EUR/JPY", "2024-02-05 08:00", "BUY"), tid("AUD/JPY", "2024-02-05 12:00", "BUY")
    f1 = Ledger()
    f1.enter("2024-02-05 08:00", us, 76_000, 150.002)
    f1.exit("2024-02-05 09:05", us, 76_000, 143.752, 76_000 * (143.752 - 150.002), 525_000, "sl")
    f1.enter("2024-02-05 12:00", eu, 31_000, 160.002)
    f1.exit("2024-02-05 13:05", eu, 31_000, 148.002, 31_000 * (148.002 - 160.002), 153_000, "sl")
    f1.enter("2024-02-05 16:00", au, 11_000, 100.002)
    f1.exit("2024-02-05 17:05", au, 11_000, 100.040, 11_000 * 0.038, 153_418, "tp")
    f05 = Ledger()
    f05.enter("2024-02-05 08:00", us, 38_000, 150.002)
    f05.exit("2024-02-05 09:05", us, 38_000, 143.752, 38_000 * (143.752 - 150.002), 762_500, "sl")
    f05.enter("2024-02-05 12:00", eu, 24_000, 160.002)
    f05.exit("2024-02-05 13:05", eu, 24_000, 148.002, 24_000 * (148.002 - 160.002), 474_500, "sl")
    f05.enter("2024-02-05 16:00", au, 12_000, 100.002)
    f05.exit("2024-02-05 17:05", au, 12_000, 100.040, 12_000 * 0.038, 474_956, "tp")
    return {
        "name": "turtle_cap",
        "what": "the told row 'turtle': the sizing base cut 20% for each 10% lost (m steps), and capped at the equity once start x 0.8^m is above it (equity under ~21% of the start)",
        "hand": [
            "Runs row_turtle_FF1_C0 and row_turtle_FF05_C0, from 1,000,000. m = floor((1,000,000 - E) / 100,000); if m >= 1 the base = min(E, 1,000,000 x 0.8^m), else E. Units = floor(k x base / 0.13 / 1000) x 1000.",
            "Mon 2024-02-05, three JPY BUYs, each with its gap through the stop (out at the bar's open) or its TP1:",
            "  USD/JPY, T 08:00 (mid 150.000, fill 150.002); the 09:00 bar opens at bid 143.752, past the stop 149.870: out at 143.752 (09:05), -6.25 a unit.",
            "  EUR/JPY, T 12:00 (mid 160.000, fill 160.002); the 13:00 bar opens at 148.002, past the stop 159.870: out at 148.002 (13:05), -12 a unit.",
            "  AUD/JPY, T 16:00 (mid 100.000, fill 100.002); the 17:00 bar's high 100.050: out at TP1 100.040 (17:05), +0.038 a unit.",
            "FF1: USD/JPY E 1,000,000, m 0, base 1,000,000 -> 76,923 -> 76,000 (margin 456,000); -475,000 -> 525,000.",
            "  EUR/JPY: m = floor(475,000 / 100,000) = 4; 0.8^4 = 0.4096: base min(525,000, 409,600) = 409,600 -> 31,507 -> 31,000; 31,000 x -12 = -372,000 -> 153,000.",
            "  AUD/JPY: m = floor(847,000 / 100,000) = 8; 1,000,000 x 0.8^8 = 167,772.16 > 153,000: the base is capped at the equity, 153,000 -> 11,769 -> 11,000 (uncapped it would be 12,905 -> 12,000); 11,000 x 0.038 = 418 -> 153,418.",
            "FF05: USD/JPY 0.005 x 1,000,000 / 0.13 = 38,461 -> 38,000; -237,500 -> 762,500.",
            "  EUR/JPY: m = 2, base min(762,500, 640,000) = 640,000 -> 24,615 -> 24,000; -288,000 -> 474,500.",
            "  AUD/JPY: m = floor(525,500 / 100,000) = 5, 0.8^5 = 0.32768: base min(474,500, 327,680) = 327,680 -> 12,603 -> 12,000; 456 -> 474,956.",
            "Nothing open at a NY close; no loss-cut (each gap closes the only position at ③).",
            "Plants: roundlot (31,507.7 -> 32,000; 11,769 -> 12,000), pipplus (USD/JPY out at 143.762, and every size after), exitlate (each exit 5 minutes later).",
        ],
        "pairs": ["USD/JPY", "EUR/JPY", "AUD/JPY"],
        "bars": {
            "USD/JPY": [flat("2024-02-05 07:55", 149.998), ohlc("2024-02-05 09:00", 143.752, 143.800, 143.700, 143.760), flat("2024-02-05 09:05", 143.760)],
            "EUR/JPY": [flat("2024-02-05 11:55", 159.998), ohlc("2024-02-05 13:00", 148.002, 148.100, 148.000, 148.050), flat("2024-02-05 13:05", 148.050)],
            "AUD/JPY": [flat("2024-02-05 15:55", 99.998), ohlc("2024-02-05 17:00", 99.998, 100.050, 99.998, 100.040), flat("2024-02-05 17:05", 100.040)],
        },
        "signals": [("USD/JPY", "2024-02-05 04:00", "BUY"), ("EUR/JPY", "2024-02-05 08:00", "BUY"), ("AUD/JPY", "2024-02-05 12:00", "BUY")],
        "runs": [run("row_turtle_FF1_C0", "FF1", row="turtle"), run("row_turtle_FF05_C0", "FF05", row="turtle")],
        "expect": {
            "row_turtle_FF1_C0": {"ledger": f1.rows, "summary": summary(153_418.0, taken=3)},
            "row_turtle_FF05_C0": {"ledger": f05.rows, "summary": summary(474_956.0, taken=3)},
        },
        "plants": ["roundlot", "pipplus", "exitlate"],
    }


FIXTURES.append(turtle_cap)


# ---- cap_kinds: three open, one a pair, two JPY buys and two sells (an addition) -------------


def cap_kinds():
    ub, us = tid("USD/JPY", "2024-02-06 08:00", "BUY"), tid("USD/JPY", "2024-02-06 08:00", "SELL")
    eu, gb = tid("EUR/JPY", "2024-02-06 08:00", "BUY"), tid("GBP/JPY", "2024-02-06 08:00", "BUY")
    au, ed = tid("AUD/JPY", "2024-02-06 08:00", "SELL"), tid("EUR/USD", "2024-02-06 08:00", "BUY")
    win, lose, usd = 19_000 * 0.038, 19_000 * -0.132, 12_000 * (1.10040 - 1.10002) * 150.0
    t3 = Ledger()
    t3.enter("2024-02-06 12:00", ub, 19_000, 150.002)
    t3.enter("2024-02-06 12:00", us, 19_000, 149.998)
    t3.enter("2024-02-06 12:00", eu, 19_000, 160.002)
    for x in (gb, au, ed):
        t3.skip("2024-02-06 12:00", x, "cap")
    t3.exit("2024-02-06 13:05", ub, 19_000, 150.040, win, 1_000_000 + win, "tp")
    t3.exit("2024-02-06 13:35", eu, 19_000, 160.040, win, 1_000_000 + 2 * win, "tp")
    t3.exit("2024-02-06 14:05", us, 19_000, 149.960, win, 1_000_000 + 3 * win, "tp")
    p1 = Ledger()
    p1.enter("2024-02-06 12:00", ub, 19_000, 150.002)
    p1.skip("2024-02-06 12:00", us, "cap")
    p1.enter("2024-02-06 12:00", eu, 19_000, 160.002)
    p1.enter("2024-02-06 12:00", gb, 19_000, 190.002)
    p1.enter("2024-02-06 12:00", au, 19_000, 99.998)
    p1.enter("2024-02-06 12:00", ed, 12_000, 1.10002)
    p1.exit("2024-02-06 13:05", ub, 19_000, 150.040, win, 1_000_000 + win, "tp")
    p1.exit("2024-02-06 13:35", eu, 19_000, 160.040, win, 1_000_000 + 2 * win, "tp")
    p1.exit("2024-02-06 15:05", gb, 19_000, 189.870, lose, 1_000_000 + 2 * win + lose, "amb")
    p1.exit("2024-02-06 15:35", au, 19_000, 100.130, lose, 1_000_000 + 2 * win + 2 * lose, "sl")
    p1.exit("2024-02-06 16:35", ed, 12_000, 1.10040, usd, 1_000_000 + 2 * win + 2 * lose + usd, "tp")
    j2 = Ledger()
    j2.enter("2024-02-06 12:00", ub, 19_000, 150.002)
    j2.enter("2024-02-06 12:00", us, 19_000, 149.998)
    j2.enter("2024-02-06 12:00", eu, 19_000, 160.002)
    j2.skip("2024-02-06 12:00", gb, "cap")
    j2.enter("2024-02-06 12:00", au, 19_000, 99.998)
    j2.enter("2024-02-06 12:00", ed, 12_000, 1.10002)
    j2.exit("2024-02-06 13:05", ub, 19_000, 150.040, win, 1_000_000 + win, "tp")
    j2.exit("2024-02-06 13:35", eu, 19_000, 160.040, win, 1_000_000 + 2 * win, "tp")
    j2.exit("2024-02-06 14:05", us, 19_000, 149.960, win, 1_000_000 + 3 * win, "tp")
    j2.exit("2024-02-06 15:35", au, 19_000, 100.130, lose, 1_000_000 + 3 * win + lose, "sl")
    j2.exit("2024-02-06 16:35", ed, 12_000, 1.10040, usd, 1_000_000 + 3 * win + lose + usd, "tp")
    return {
        "name": "cap_kinds",
        "what": "(not in interface.md's list) six emails on one bar under the caps T3, P1 and J2: three open; one a pair (no hedge); JPY buys two and sells two, the dollar pair not counted; and a bar reaching both the stop and TP1 (the stop, 'amb')",
        "hand": [
            "Runs FF025_T3, FF025_P1, FF025_J2 from 1,000,000 (k = 0.25%, small enough that no margin test bites). Spread 0.4 pip.",
            "T Tue 2024-02-06 12:00 (bar 08:00), in admission order: USD/JPY BUY (mid 150.000, fill 150.002), USD/JPY SELL (fill 149.998; TP1 149.960, stop 150.130), EUR/JPY BUY (mid 160.000), GBP/JPY BUY (mid 190.000), AUD/JPY SELL (mid 100.000, fill 99.998, stop 100.130), EUR/USD BUY (mid 1.10000, fill 1.10002, TP1 1.10040).",
            "  Units on E = 1,000,000: a JPY pair 0.0025 x 1,000,000 / 0.13 = 19,230 -> 19,000; EUR/USD 0.0025 x 1,000,000 / (0.0013 x 150.000) = 12,820 -> 12,000.",
            "T3: USD/JPY BUY, USD/JPY SELL, EUR/JPY BUY enter (three open); GBP/JPY, AUD/JPY, EUR/USD skipped 'cap'.",
            "P1: USD/JPY BUY enters; USD/JPY SELL skipped 'cap' (the pair is held: no hedge); EUR/JPY, GBP/JPY, AUD/JPY, EUR/USD enter (margin 114,000 + 121,600 + 144,400 + 76,000 + 79,200 = 535,200).",
            "J2: JPY buys USD/JPY, EUR/JPY enter (two), GBP/JPY skipped 'cap' (a third JPY buy); JPY sells USD/JPY, AUD/JPY enter (two); EUR/USD enters (dollar pairs are not counted).",
            "Exits (the trades' own): USD/JPY BUY TP1 150.040 at 13:05 (19,000 x 0.038 = 722); EUR/JPY TP1 160.040 at 13:35 (722); USD/JPY SELL TP1 149.960 at 14:05, the 14:00 bar's ask low 149.954 (722);",
            "  GBP/JPY's 15:00 bar reaches both TP1 190.040 (high 190.050) and the stop 189.870 (low 189.860): the stop, kind 'amb', at 15:05 (19,000 x -0.132 = -2,508); AUD/JPY SELL stop 100.130 at 15:35, the ask high 100.134 (-2,508); EUR/USD TP1 1.10040 at 16:35, USD/JPY's mid then 150.000: 12,000 x 0.00038 x 150 = 684.",
            "Finals: T3 1,000,000 + 3 x 722 = 1,002,166; P1 1,000,000 + 722 + 722 - 2,508 - 2,508 + 684 = 997,112; J2 1,000,000 + 3 x 722 - 2,508 + 684 = 1,000,342.",
            "Plants: pipplus (USD/JPY BUY, the first trade, 1 pip better), exitlate.",
        ],
        "pairs": ["USD/JPY", "EUR/JPY", "GBP/JPY", "AUD/JPY", "EUR/USD"],
        "bars": {
            "USD/JPY": [flat("2024-02-06 11:55", 149.998), ohlc("2024-02-06 13:00", 150.000, 150.045, 150.000, 150.040), ohlc("2024-02-06 14:00", 150.000, 150.000, 149.950, 149.955),
                        flat("2024-02-06 14:05", 149.955), flat("2024-02-06 16:30", 149.998)],
            "EUR/JPY": [flat("2024-02-06 11:55", 159.998), ohlc("2024-02-06 13:30", 160.000, 160.045, 160.000, 160.040), flat("2024-02-06 13:35", 160.040)],
            "GBP/JPY": [flat("2024-02-06 11:55", 189.998), ohlc("2024-02-06 15:00", 189.990, 190.050, 189.860, 189.870), flat("2024-02-06 15:05", 189.870)],
            "AUD/JPY": [flat("2024-02-06 11:55", 99.998), ohlc("2024-02-06 15:30", 100.000, 100.130, 100.000, 100.120), flat("2024-02-06 15:35", 100.120)],
            "EUR/USD": [flat("2024-02-06 11:55", 1.09998, 0.00004), ohlc("2024-02-06 16:30", 1.10000, 1.10045, 1.10000, 1.10040, 0.00004), flat("2024-02-06 16:35", 1.10040, 0.00004)],
        },
        "signals": [("USD/JPY", "2024-02-06 08:00", "BUY"), ("USD/JPY", "2024-02-06 08:00", "SELL"), ("EUR/JPY", "2024-02-06 08:00", "BUY"),
                    ("GBP/JPY", "2024-02-06 08:00", "BUY"), ("AUD/JPY", "2024-02-06 08:00", "SELL"), ("EUR/USD", "2024-02-06 08:00", "BUY")],
        "runs": [run("FF025_T3", "FF025", cap="T3"), run("FF025_P1", "FF025", cap="P1"), run("FF025_J2", "FF025", cap="J2")],
        "expect": {
            "FF025_T3": {"ledger": t3.rows, "summary": summary(1_000_000 + 3 * win, taken=3, cap=3)},
            "FF025_P1": {"ledger": p1.rows, "summary": summary(1_000_000 + 2 * win + 2 * lose + usd, taken=5, cap=1)},
            "FF025_J2": {"ledger": j2.rows, "summary": summary(1_000_000 + 3 * win + lose + usd, taken=5, cap=1)},
        },
        "plants": ["pipplus", "exitlate"],
    }


FIXTURES.append(cap_kinds)


# ---- the files ------------------------------------------------------------------------------


def closed(ms):
    """_shared/market-hours.ts isMarketClosed, written again."""
    d = datetime.fromtimestamp(ms / 1000, tz=timezone.utc)
    day = (d.weekday() + 1) % 7
    return day == 6 or (day == 5 and d.hour >= 22) or (day == 0 and d.hour < 21)


def inside_closure(t, step):
    return closed(t) and closed(t + step - 1)


def spread_of(pair):
    return 0.004 if pair.endswith("/JPY") else 0.000036


def dump(path, rows, side):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    k = 1 if side == "bid" else 2
    data = [{"openTime": str(r[0]), "open": num(r[k][0]), "high": num(r[k][1]), "low": num(r[k][2]), "close": num(r[k][3])} for r in rows]
    with open(path, "w") as f:
        json.dump({"status": 0, "data": data}, f)


def write(fx):
    d = os.path.join(HERE, fx["name"])
    if os.path.isdir(d):
        shutil.rmtree(d)
    gmo = os.path.join(d, "gmo")
    bars = {}
    for pair in fx["pairs"]:
        out = []
        for when, o, h, l, c, sp in fx["bars"][pair]:
            t = at(when)
            b = (o, h, l, c)
            a = tuple(round(x + (spread_of(pair) if sp is None else sp), 7) for x in b)
            if not (h >= max(o, c) and l <= min(o, c)) or t % FINE or inside_closure(t, FINE):
                raise SystemExit(f"{fx['name']} {pair} {when}: not a bar the market could print")
            out.append((t, b, a))
        out.sort()
        if len({r[0] for r in out}) != len(out):
            raise SystemExit(f"{fx['name']} {pair}: two bars at one time")
        bars[pair] = out
    # the bar opening at T (the email's first followed bar), flat at the close
    # of the bar ending at T, where none is written
    for pair, bar_open, side in fx["signals"]:
        T = at(bar_open) + STEP4
        rows = bars[pair]
        if not any(r[0] == T for r in rows):
            last = [r for r in rows if r[0] + FINE == T]
            if not last:
                raise SystemExit(f"{fx['name']} {pair} {bar_open}: no 5-minute bar ends at T")
            rows.append((T, (last[0][1][3],) * 4, (last[0][2][3],) * 4))
            rows.sort()
    # the flush: an hour after the last bar written (the next open hour), one
    # wide bar a pair that every level still waiting is inside, then a flat bar
    t = max(rows[-1][0] for rows in bars.values()) + HOUR
    while inside_closure(t, FINE) or inside_closure(t + FINE, FINE):
        t += HOUR
    for pair, rows in bars.items():
        c = rows[-1][1][3]
        r = 1.0 if pair.endswith("/JPY") else 0.01
        sp = spread_of(pair)
        b = (c, round(c + r, 7), round(c - r, 7), c)
        rows.append((t, b, tuple(round(x + sp, 7) for x in b)))
        rows.append((t + FINE, (c,) * 4, (round(c + sp, 7),) * 4))
    for pair, rows in bars.items():
        days = {}
        for r in rows:
            days.setdefault(datetime.fromtimestamp(r[0] / 1000, tz=timezone.utc).strftime("%Y%m%d"), []).append(r)
        for key, rs in days.items():
            for side in ("bid", "ask"):
                dump(os.path.join(gmo, SYMBOL[pair], "5min", side, f"{key}.json"), rs, side)
    # the 4-hour bars: from the 5-minute bars inside, one price elsewhere
    sig_open = [at(s[1]) for s in fx["signals"]]
    first = min(min(sig_open), min((rows[0][0] // STEP4) * STEP4 for rows in bars.values()))
    last5 = max(rows[-1][0] for rows in bars.values())
    slots, after, t = [], 0, first
    while after < PAD4 or t <= last5:
        if not inside_closure(t, STEP4):
            slots.append(t)
            if t > max(sig_open):
                after += 1
        t += STEP4
    for pair, rows in bars.items():
        four = []
        prev = None
        for t in slots:
            inside = [r for r in rows if t <= r[0] < t + STEP4]
            if inside:
                b = (inside[0][1][0], max(r[1][1] for r in inside), min(r[1][2] for r in inside), inside[-1][1][3])
                a = (inside[0][2][0], max(r[2][1] for r in inside), min(r[2][2] for r in inside), inside[-1][2][3])
                prev = (b[3], a[3])
            else:
                bc, ac = prev if prev else (rows[0][1][0], rows[0][2][0])
                b, a = (bc,) * 4, (ac,) * 4
            four.append((t, b, a))
        years = {}
        for r in four:
            years.setdefault(datetime.fromtimestamp(r[0] / 1000, tz=timezone.utc).strftime("%Y"), []).append(r)
        for key, rs in years.items():
            for side in ("bid", "ask"):
                dump(os.path.join(gmo, SYMBOL[pair], "4hour", side, f"{key}.json"), rs, side)
    # the trade table: every signal's bar kept, and a 5-minute bar of its pair ending at T
    rows = []
    for pair, bar_open, side in fx["signals"]:
        T = at(bar_open) + STEP4
        if at(bar_open) not in slots or not any(r[0] + FINE == T for r in bars[pair]):
            raise SystemExit(f"{fx['name']} {pair} {bar_open}: the signal bar or its last 5-minute bar is missing")
        rows.append((T, ORDER.index(pair), 0 if side == "BUY" else 1, [tid(pair, bar_open, side), pair, "CALL9", iso(at(bar_open)), iso(T), side, "qtrend+ultra"]))
    rows.sort(key=lambda r: r[:3])
    with open(os.path.join(d, "signals.csv"), "w", newline="") as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow(["id", "pair", "group", "bar_open", "T", "side", "rules"])
        for r in rows:
            w.writerow(r[3])
    out = {
        "name": fx["name"],
        "what": fx["what"],
        "hand": fx["hand"],
        "conventions": CONVENTIONS,
        "start": datetime.fromtimestamp(slots[0] / 1000, tz=timezone.utc).strftime("%Y-%m-%d"),
        "end": iso(slots[-1] + STEP4).replace(".000Z", "Z"),
        "pairs": fx["pairs"],
        "digits": {p: 3 if p.endswith("/JPY") else 5 for p in fx["pairs"]},
        "runs": fx["runs"],
        "expect": fx["expect"],
        "plants": fx["plants"],
    }
    with open(os.path.join(d, "fixture.json"), "w") as f:
        json.dump(out, f, indent=1)
        f.write("\n")
    return d


def main():
    listed = set()
    bad = 0
    for make in FIXTURES:
        fx = make()
        d = write(fx)
        _, got = recompute.recompute(d)
        miss = recompute.diff(fx["expect"], got)
        print(f"{fx['name']}: the hand and the second calculation {'AGREE' if not miss else 'DIFFER'} ({sum(len(v['ledger']) for v in fx['expect'].values())} ledger rows, {len(fx['runs'])} runs)")
        for m in miss[:20]:
            print("    ", m)
        bad += bool(miss)
        for plant in fx["plants"]:
            if plant not in recompute.PLANTS:
                raise SystemExit(f"{fx['name']}: no plant {plant}")
            _, pg = recompute.recompute(d, [plant])
            moved = recompute.diff(fx["expect"], pg)
            print(f"    plant {plant}: {len(moved)} expected numbers move{'' if moved else '  <- NOT CAUGHT'}" + (f" (first: {moved[0]})" if moved else ""))
            bad += not moved
            listed.add(plant)
    for plant in recompute.PLANTS:
        if plant not in listed:
            print(f"plant {plant}: no fixture lists it")
            bad += 1
    if bad:
        raise SystemExit(f"{bad} problem(s)")
    print(f"all {len(FIXTURES)} fixtures written; every plant caught by at least one")


if __name__ == "__main__":
    main()
