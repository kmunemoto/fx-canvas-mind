#!/usr/bin/env python3
"""#188: an independent check of research/money.ts (docs §8.99), written apart
from it: its author has not opened money.ts or any money-*.ts.

From the study it takes only money-signals.csv (the pair, the signal bar, the
side and which rules mailed it) and works the rest out again from GMO's raw
files (the run's cache, or a fixture's gmo/):

  * every trade under five variants: main (the whole out at TP1 4 pips or the
    stop 13 pips), tp2 and tp3 (the whole at TP2 10 or TP3 16: the thirds
    row's legs), late (in at the close of the first 5-minute bar, as
    tf-winrate's late entry; not entered where a level was already passed)
    and rakuten (re-followed on GMO's mid ± half Rakuten's advertised spread,
    §8.99's schedule);
  * the account on the union grid of 5-minute closes, bar by bar in §8.99's
    order ①–⑥, for the 25 cells and every told row's cells: the ledger (every
    event) and the summary, and for the 10,000-unit ones E* with its four
    terms;
  * the 20 hash orders' final equity on the 12 cells that depend on order, the
    first 3 thinning draws on the 10 thinning cells, the kept-minus-skipped
    point values and the 52-week windows' E*;

and compares them with money.ts's files in --out: prices to 1e-9, pips to
1e-6, yen to 1e-6, units, kinds, times and counts exactly. It prints each
class's compared and mismatched with up to 5 examples and exits 1 on any
mismatch or missing file.

--fixture DIR runs DIR/fixture.json's runs on DIR/gmo/ and DIR/signals.csv and
compares them with its expect. --plant NAME puts an error into this check's
own reading, to show the comparison catches it: exitlate (one exit a 5-minute
bar later), pipplus (one trade's pips +1), balance (one ledger balance +1
yen). --write DIR writes this check's own numbers in money.ts's formats (to
test the comparison itself on a synthetic walk).

Usage: python3 research/money-check.py [--cache research/.cache]
  [--out research/out] [--start 2024-01-01] [--split 2025-05-19]
  [--end 2026-10-02T21:00:00Z] [--fixture DIR] [--plant NAME] [--write DIR]
  [--quick]
Read-only (but --write): prints to the job log.
"""

import argparse
import bisect
import csv
import glob
import hashlib
import json
import math
import os
import sys
import time
from array import array
from datetime import datetime, timedelta, timezone
from decimal import ROUND_HALF_UP, Decimal
from zoneinfo import ZoneInfo

MIN = 60_000
HOUR = 60 * MIN
DAY = 24 * HOUR
WEEK = 7 * DAY
FINE = 5 * MIN
FOUR = 4 * HOUR
STEP = {"5min": FINE, "4hour": FOUR}
# weeks from Sunday 21:00 UTC (stop2n's weekOf), days for the worst day from 21:00 UTC
WEEK_OFFSET = 3 * DAY + 21 * HOUR
DAY_OFFSET = 21 * HOUR

CALL9 = ["USD/JPY", "EUR/JPY", "GBP/JPY", "AUD/JPY", "NZD/JPY", "CAD/JPY", "CHF/JPY", "EUR/USD", "AUD/USD"]
C3 = ["TRY/JPY", "ZAR/JPY", "MXN/JPY"]
# Rakuten's list (LIVE_PAIRS) restricted to the pairs in play: the order one
# bar's emails are judged in, a pair's BUY before its SELL
LIVE_ORDER = ["USD/JPY", "EUR/JPY", "GBP/JPY", "AUD/JPY", "EUR/USD", "AUD/USD", "MXN/JPY", "NZD/JPY", "ZAR/JPY", "CAD/JPY", "CHF/JPY", "TRY/JPY"]

# the email's levels (#192): the stop 13 pips, TP1/2/3 4, 10 and 16, from the mid close
SL_PIPS = 13
TP_OF = {"main": 4, "tp2": 10, "tp3": 16, "late": 4, "rakuten": 4}
VARIANTS = ["main", "tp2", "tp3", "late", "rakuten"]
LIMIT = 30
NEED = 120
READ_AFTER = (0, 4, 6)
START_EQUITY = 1_000_000.0
LOT = 1000
SIZING = {"F10k": None, "FF025": 0.0025, "FF05": 0.005, "FF1": 0.01, "FF2": 0.02}
CAPS = ["C0", "T1", "T3", "P1", "J2"]
CELLS = [f"{s}_{c}" for s in SIZING for c in CAPS]
# the told rows: (row, cell)
TOLD = [
    ("p12", "F10k_C0"), ("p12", "FF1_C0"),
    ("late", "F10k_C0"), ("late", "FF1_C0"),
    ("nights", "F10k_C0"), ("nights", "FF1_C0"),
    ("thirds", "F10k_C0"), ("thirds", "FF1_C0"),
    ("net", "F10k_C0"), ("net", "FF1_C0"),
    ("rakuten", "F10k_C0"), ("rakuten", "FF1_C0"),
    ("x10", "FF1_C0"), ("x10", "FF05_C0"),
    ("lcworst", "F10k_C0"), ("lcworst", "FF1_C0"),
    ("strict", "FF1_C0"),
    ("nomargin", "FF1_C0"),
    ("zero", "F10k_C0"), ("zero", "FF1_C0"),
    ("turtle", "FF1_C0"), ("turtle", "FF05_C0"),
]
# the owner's table less F10k_C0 (which no order changes): the 20 orders' cells
ORDER_CELLS = ["FF025_C0", "FF05_C0", "FF1_C0", "FF2_C0"] + [f"F10k_{c}" for c in CAPS[1:]] + [f"FF05_{c}" for c in CAPS[1:]]
ORDERS = 20
# the cells whose skipped emails are set against random ones and against the kept
THIN_CELLS = [f"F10k_{c}" for c in CAPS[1:]] + [f"FF05_{c}" for c in CAPS[1:]] + ["FF1_C0", "FF2_C0"]
THIN_DRAWS = 3
NIGHT_HOURS = (16, 20)
TERMS = ["order", "nyclose", "losscut", "negative"]

EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)
NY = ZoneInfo("America/New_York")


# ---- times ----------------------------------------------------------------------------------


def ms_of(s):
    """an ISO UTC time (or milliseconds as a string) to milliseconds"""
    s = str(s).strip()
    if s.lstrip("-").isdigit():
        return int(s)
    if len(s) == 10:
        s += "T00:00:00Z"
    d = datetime.fromisoformat(s.replace("Z", "+00:00"))
    if d.tzinfo is None:
        d = d.replace(tzinfo=timezone.utc)
    return int(round(d.timestamp() * 1000))


def iso(ms):
    """JavaScript's new Date(ms).toISOString()"""
    d = EPOCH + timedelta(milliseconds=ms)
    return d.strftime("%Y-%m-%dT%H:%M:%S.") + f"{ms % 1000:03d}Z"


def week_of(t):
    return (t - WEEK_OFFSET) // WEEK


def utc(ms):
    return EPOCH + timedelta(milliseconds=ms)


# ---- the week (as _shared/market-hours.ts says it, written again) --------------------------


def market_closed(ms):
    d = utc(ms)
    day = (d.weekday() + 1) % 7  # Sunday 0 .. Saturday 6
    if day == 6:
        return True
    if day == 5 and d.hour >= 22:
        return True
    if day == 0 and d.hour < 21:
        return True
    return False


def possibly_closed(ms):
    d = utc(ms)
    day = (d.weekday() + 1) % 7
    if day == 6:
        return True
    if day == 5 and d.hour >= 21:
        return True
    if day == 0 and d.hour < 22:
        return True
    return False


def inside_closure(t, step):
    # WEEKEND=inside: out only when the bar lies wholly in the closure
    if step > 47 * HOUR:
        return False
    return market_closed(t) and market_closed(t + step - 1)


def mailed(T):
    """the sweep reads the 4-hour close 0, 4 and 6 minutes after it: mailed when
    any of those is not possibly closed"""
    return any(not possibly_closed(T + m * MIN) for m in READ_AFTER)


# ---- New York's close (Rakuten's 追証 time) --------------------------------------------------


def ny_closes(lo, hi):
    """every weekday's 16:55 New York (Rakuten's 06:55 JST in US standard time,
    05:55 JST in US daylight time) from lo to hi, with its deadline: the next
    weekday (Friday → Monday) at 09:00 UTC"""
    out = []
    d = utc(lo).date() - timedelta(days=1)
    last = utc(hi).date() + timedelta(days=1)
    while d <= last:
        if d.weekday() < 5:
            tau = int(datetime(d.year, d.month, d.day, 16, 55, tzinfo=NY).timestamp() * 1000)
            nxt = d + timedelta(days=3 if d.weekday() == 4 else 1)
            deadline = int(datetime(nxt.year, nxt.month, nxt.day, 9, 0, tzinfo=timezone.utc).timestamp() * 1000)
            if lo <= tau <= hi:
                out.append((tau, deadline))
        d += timedelta(days=1)
    return out


# ---- rounding as the program's JavaScript does ------------------------------------------------


def to_fixed(x, d):
    """Number(x.toFixed(d)): the exact value, halves up"""
    return float(Decimal(x).quantize(Decimal(1).scaleb(-d), rounding=ROUND_HALF_UP))


# ---- Rakuten's advertised spread (§8.99), pips; None where GMO's own prices stand ----------


def jst(y, mo, d, h=0, mi=0):
    return int(datetime(y, mo, d, h, mi, tzinfo=timezone.utc).timestamp() * 1000) - 9 * HOUR


RK_USDJPY_FROM = jst(2025, 3, 6, 7, 10)
RK_STOPPED = (jst(2024, 8, 14, 6, 10), jst(2025, 2, 5, 7, 10))
RK_CAMPAIGN = (jst(2026, 7, 13, 7, 0), jst(2026, 8, 8, 5, 55))
RK_NOW_FROM = jst(2026, 9, 14, 7, 0)
RK_STANDARD = {"EUR/JPY": 0.5, "AUD/JPY": 0.6, "NZD/JPY": 1.2, "CAD/JPY": 1.7, "CHF/JPY": 1.8, "EUR/USD": 0.4, "AUD/USD": 0.9}
RK_CAMPAIGN_V = {"EUR/JPY": 0.4, "AUD/JPY": 0.5, "NZD/JPY": 0.7, "CAD/JPY": 0.6, "CHF/JPY": 0.8, "EUR/USD": 0.3, "AUD/USD": 0.4}
RK_NOW = {"EUR/JPY": 0.4, "AUD/JPY": 0.5, "NZD/JPY": 0.6, "CAD/JPY": 0.6, "CHF/JPY": 0.8, "EUR/USD": 0.3, "AUD/USD": 0.4}
# the left-out days, JST calendar days: [00:00 JST, 24:00 JST)
RK_OUT_DAYS = [(jst(y, m, d), jst(y, m, d) + DAY) for y, m, d in ((2024, 11, 11), (2024, 11, 28), (2026, 6, 19))]


def rakuten_spread(pair, t):
    """the rule in force at t ([start, end) at every boundary): a 5-minute bar
    by its open, an entry by T"""
    for a, b in RK_OUT_DAYS:
        if a <= t < b:
            return None
    if pair == "USD/JPY":
        # 0.2 from 9:00 to 3:00 JST (00:00 to 18:00 UTC), 3.8 from 3:00 to 9:00 JST;
        # before 2025-03-06 07:10 JST unread or stopped: GMO
        if t < RK_USDJPY_FROM:
            return None
        return 3.8 if t % DAY >= 18 * HOUR else 0.2
    if pair not in RK_STANDARD:
        return None  # GBP/JPY (advertised "-") and the told row's three
    if t >= RK_NOW_FROM:
        return RK_NOW[pair]
    if RK_CAMPAIGN[0] <= t < RK_CAMPAIGN[1]:
        return RK_CAMPAIGN_V[pair]
    if RK_STOPPED[0] <= t < RK_STOPPED[1]:
        return None
    return RK_STANDARD[pair]


# ---- GMO's files ------------------------------------------------------------------------------


def read_bars(cache, symbol, interval, from_ms, now_ms):
    """Both sides by open time, as stop2n-check.py keeps them: on both sides, the
    ask's close not under the bid's, opened from from_ms, closed by now, the
    weekend's out (inside). A time in two files: the first read (the files in
    name order). Returns [(t, bid ohlc, ask ohlc)] sorted, and the times read
    twice with different prices."""
    sides = {}
    differ = 0
    for side in ("bid", "ask"):
        rows = {}
        for path in sorted(glob.glob(os.path.join(cache, symbol, interval, side, "*.json"))):
            with open(path) as f:
                body = json.load(f)
            if not isinstance(body, dict) or not isinstance(body.get("data"), list):
                continue
            for r in body["data"]:
                t = int(r["openTime"])
                c = (float(r["open"]), float(r["high"]), float(r["low"]), float(r["close"]))
                if t in rows:
                    differ += rows[t] != c
                    continue
                rows[t] = c
        sides[side] = rows
    step = STEP[interval]
    out = []
    for t, b in sides["bid"].items():
        a = sides["ask"].get(t)
        if a is None or a[3] < b[3]:
            continue
        if t < from_ms or inside_closure(t, step) or t + step > now_ms:
            continue
        out.append((t, b, a))
    out.sort()
    return out, differ


class Fine:
    """a pair's 5-minute bars, both sides, in arrays by open time"""

    def __init__(self, pair, rows):
        self.pair = pair
        self.t = [r[0] for r in rows]
        self.end = [r[0] + FINE for r in rows]
        self.bo = [r[1][0] for r in rows]
        self.bh = [r[1][1] for r in rows]
        self.bl = [r[1][2] for r in rows]
        self.bc = [r[1][3] for r in rows]
        self.ao = [r[2][0] for r in rows]
        self.ah = [r[2][1] for r in rows]
        self.al = [r[2][2] for r in rows]
        self.ac = [r[2][3] for r in rows]
        # the mid close (not rounded): marks for margin, the call, USD/JPY's conversion
        self.mc = [(b + a) / 2 for b, a in zip(self.bc, self.ac)]
        # half Rakuten's spread (price) by each bar's open; −1: GMO's own prices
        self.rk = None

    def rakuten(self, unit):
        if self.rk is None:
            self.rk = array("d", [(-1.0 if s is None else s * unit / 2) for s in (rakuten_spread(self.pair, t) for t in self.t)])
        return self.rk


class Four:
    """a pair's 4-hour bars"""

    def __init__(self, rows):
        self.t = [r[0] for r in rows]
        self.at = {t: i for i, t in enumerate(self.t)}
        self.b = [r[1] for r in rows]
        self.a = [r[2] for r in rows]


# ---- the trades -------------------------------------------------------------------------------


class Sig:
    """one row of money-signals.csv: one trade"""

    __slots__ = ("id", "pair", "group", "bar", "T", "side", "rules", "dir", "buy", "jpy", "unit", "digits", "i4", "close", "spread", "tv", "T_iso")


class TV:
    """one trade under one variant. f_exit: the index of the 5-minute bar it went
    out in (its pair's); x: that bar's end"""

    __slots__ = ("sig", "variant", "fill", "close", "sl", "tp", "entry_g", "kind", "f_exit", "exit_open", "x", "px", "pips")


def follow(t, o, h, l, c, f0, buy, sl, tp, end, base=0):
    """The trade on the 5-minute bars from f0 to the end of the 30th 4-hour bar
    after the signal bar (end): (kind, the index of the bar it went out in, the
    price), or None when the data ends first. As stop2n.ts's tradeAt: a bar
    opening past a level, out at that open (the stop asked first); both in one
    bar, the stop ("amb"); else at the level; at the end, the close of the
    last 5-minute bar before it ("time"). The price arrays may start at base."""
    n = len(t)
    f = f0
    while f < n and (end is None or t[f] < end):
        j = f - base
        of = o[j]
        if (of <= sl) if buy else (of >= sl):
            return ("sl", f, of)
        if (of >= tp) if buy else (of <= tp):
            return ("tp", f, of)
        hit_sl = (l[j] <= sl) if buy else (h[j] >= sl)
        hit_tp = (h[j] >= tp) if buy else (l[j] <= tp)
        if hit_sl and hit_tp:
            return ("amb", f, sl)
        if hit_sl:
            return ("sl", f, sl)
        if hit_tp:
            return ("tp", f, tp)
        f += 1
    if end is None or f == 0:
        return None
    if f >= n and t[n - 1] + FINE < end:
        return None
    return ("time", f - 1, c[f - 1 - base])


def rakuten_slice(f, f0, f1, buy):
    """the exit side's open, high, low and close of bars f0..f1−1 on Rakuten's
    spread: GMO's mid ± half, or GMO's own where the schedule says GMO"""
    rk = f.rk
    o, h, l, c = [], [], [], []
    for k in range(f0, f1):
        half = rk[k]
        if half < 0:
            if buy:
                o.append(f.bo[k]); h.append(f.bh[k]); l.append(f.bl[k]); c.append(f.bc[k])
            else:
                o.append(f.ao[k]); h.append(f.ah[k]); l.append(f.al[k]); c.append(f.ac[k])
            continue
        s = -half if buy else half
        o.append((f.bo[k] + f.ao[k]) / 2 + s)
        h.append((f.bh[k] + f.ah[k]) / 2 + s)
        l.append((f.bl[k] + f.al[k]) / 2 + s)
        c.append((f.bc[k] + f.ac[k]) / 2 + s)
    return o, h, l, c


def build_trade(sg, f, four, wrong):
    """the five variants of one signal's trade"""
    i = sg.i4
    b4, a4 = four.b[i], four.a[i]
    buy = sg.buy
    d = sg.dir
    unit = sg.unit
    close = to_fixed((b4[3] + a4[3]) / 2, sg.digits)
    sg.close = close
    sg.spread = (a4[3] - b4[3]) / unit
    fill = a4[3] if buy else b4[3]
    sl = close - d * SL_PIPS * unit
    end = four.t[i + LIMIT] + FOUR if i + LIMIT < len(four.t) else None
    T = sg.T
    f0 = bisect.bisect_left(f.t, T)
    o, h, l, c = (f.bo, f.bh, f.bl, f.bc) if buy else (f.ao, f.ah, f.al, f.ac)
    out = {}

    def make(variant, fill_, tp, res, entry_g):
        tv = TV()
        tv.sig = sg
        tv.variant = variant
        tv.fill = fill_
        tv.close = close
        tv.sl = sl
        tv.tp = tp
        tv.entry_g = entry_g
        if res is None:
            wrong.append(f"{sg.id} {variant}: not followed to its end in the raw files")
            return None
        kind, fx, px = res
        tv.kind = kind
        tv.f_exit = fx
        tv.exit_open = f.t[fx]
        tv.x = f.t[fx] + FINE
        tv.px = px
        tv.pips = (px - fill_) / unit if buy else (fill_ - px) / unit
        return tv

    for v in ("main", "tp2", "tp3"):
        tp = close + d * TP_OF[v] * unit
        out[v] = make(v, fill, tp, follow(f.t, o, h, l, c, f0, buy, sl, tp, end), T)

    # five minutes late (tf-winrate's): in at the close of the first 5-minute bar
    # from T, not entered where that close is already past TP1 or the stop, then
    # followed from the next bar to the same end
    tp1 = close + d * TP_OF["late"] * unit
    if f0 < len(f.t):
        e = f0
        late_fill = f.ac[e] if buy else f.bc[e]
        now = f.bc[e] if buy else f.ac[e]
        passed = (now >= tp1 or now <= sl) if buy else (now <= tp1 or now >= sl)
        if passed:
            tv = TV()
            tv.sig = sg
            tv.variant = "late"
            tv.fill = late_fill
            tv.close = close
            tv.sl = sl
            tv.tp = tp1
            tv.entry_g = f.t[e] + FINE
            tv.kind = "passed"
            tv.f_exit = e
            tv.exit_open = tv.x = tv.px = tv.pips = None
            out["late"] = tv
        else:
            out["late"] = make("late", late_fill, tp1, follow(f.t, o, h, l, c, e + 1, buy, sl, tp1, end), f.t[e] + FINE)
    else:
        wrong.append(f"{sg.id} late: no 5-minute bar from T")
        out["late"] = None

    # Rakuten's spread: in at the 4-hour mid close ± half by the rule at T, each
    # 5-minute bar by the rule at its open; the levels the email's
    half_t = rakuten_spread(sg.pair, T)
    rk_fill = fill if half_t is None else (b4[3] + a4[3]) / 2 + d * half_t * unit / 2
    f.rakuten(unit)
    f1 = bisect.bisect_left(f.t, end) if end is not None else len(f.t)
    ro, rh, rl, rc = rakuten_slice(f, f0, f1, buy)
    out["rakuten"] = make("rakuten", rk_fill, tp1, follow(f.t[:f1], ro, rh, rl, rc, f0, buy, sl, tp1, end, base=f0), T)
    sg.tv = out


# ---- the union grid ---------------------------------------------------------------------------


def last_index(G, ends):
    """for each grid time, the index of the last bar ending at or before it (−1: none yet)"""
    out = array("i", [-1]) * len(G)
    j = -1
    n = len(ends)
    for i, g in enumerate(G):
        while j + 1 < n and ends[j + 1] <= g:
            j += 1
        out[i] = j
    return out


class World:
    """the union grid of the pairs in play: every 5-minute bar's end of any of
    them, sorted; each pair's last bar by each grid time; the NY closes judged
    after each grid time; the 4-hour closes on the grid"""

    def __init__(self, pairs, F, fours, taus):
        self.pairs = pairs
        ends = set()
        for p in pairs:
            ends.update(F[p].end)
        self.G = sorted(ends)
        self.at = {g: i for i, g in enumerate(self.G)}
        self.F = F
        self.ff = {}
        for p in set(pairs) | ({"USD/JPY"} if "USD/JPY" in F else set()):
            self.ff[p] = last_index(self.G, F[p].end)
        self.ffu = self.ff.get("USD/JPY")
        # a NY close is judged on the grid time equal to it, or on the last before
        # it when no 5-minute bar ends at it (stale prices), right after that time
        self.tau_at = {}
        self.taus = [tau for tau, _ in taus]
        for tau, deadline in taus:
            gi = bisect.bisect_right(self.G, tau) - 1
            if gi < 0:
                continue
            if gi not in self.tau_at:
                self.tau_at[gi] = (tau, deadline)
        self.tau_g = sorted(self.tau_at)
        four_ends = set()
        for p in pairs:
            four_ends.update(t + FOUR for t in fours[p].t)
        self.four_g = sorted(self.at[g] for g in four_ends if g in self.at)
        self.four_set = set(self.four_g)

    def conv(self, gi):
        """USD/JPY's mid close at grid index gi (its last bar ending by then)"""
        k = self.ffu[gi]
        if k < 0:
            raise RuntimeError(f"no USD/JPY bar by {iso(self.G[gi])}")
        return self.F["USD/JPY"].mc[k]

    def gT(self, T):
        return bisect.bisect_right(self.G, T) - 1


# ---- the account ------------------------------------------------------------------------------


class Spec:
    """one account: a sizing, a cap, a course and a told row"""

    def __init__(self, key, sizing, cap, row=None, course=25, losscut=0.5, start=None, order=None):
        self.key = key
        self.sizing = sizing
        self.k = SIZING[sizing]
        self.f10k = self.k is None
        self.cap = cap
        self.row = row
        self.course = course
        self.rate = 0.10 if course == 10 else 0.04
        # 10,000 units: every email but the cap's taken (no call, margin or
        # loss-cut); 10× course: no call; nomargin: none of the three
        self.calls = not self.f10k and course == 25 and row != "nomargin"
        self.margin = not self.f10k and row != "nomargin"
        self.losscut = None if (self.f10k or row == "nomargin") else losscut
        self.strict = row == "strict"
        self.lcworst = row == "lcworst"
        self.turtle = row == "turtle"
        self.net = row == "net"
        self.thirds = row == "thirds"
        self.zero = row == "zero"
        self.rk = row == "rakuten"
        self.start = float(start) if start is not None else (0.0 if self.f10k else START_EQUITY)
        self.order = order
        self.estar = self.f10k


class Email:
    """an email in one run: the trade (or the thirds' three legs) it would open"""

    __slots__ = ("sig", "id", "pair", "side", "dir", "buy", "jpy", "unit", "T", "T_iso", "gT", "legs", "gx", "hold", "sh", "key")


class Pos:
    __slots__ = ("seq", "em", "tv", "leg", "units", "pair", "dir", "fill", "gT", "hold", "sh", "gx", "open", "parts", "rec")


class Call:
    __slots__ = ("tau", "g", "d", "C", "held", "mids", "M")


def hash_key(r, em):
    return hashlib.sha256(f"{r}|{em.pair}|{em.side}|{em.T_iso}".encode()).hexdigest()


def thirds_units(total):
    """the whole in 1,000-unit blocks split into three, the larger parts first (TP1 first)"""
    n = total // LOT
    base, rest = divmod(n, 3)
    return [(base + (1 if j < rest else 0)) * LOT for j in range(3)]


def run(W, emails, spec, ledger=True):
    """One account on the grid. Returns the ledger rows and the summary. The bar
    B ending at grid time G[gi] opens at s = G[gi] − 5 min; its order (§8.99):
    ① a call past its deadline: everything out; ② the emails with T in B's
    open (the state at s: the closes of the bars ending by s); ③ the exits
    inside B in the order of their entries (their cap slots free after B), then
    the late entries at B's close; ④ at G[gi]: the loss-cut, then the cure of
    an open call; ⑤ a NY close: the call; ⑥ the equity and margin recorded."""
    G = W.G
    F = W.F
    ff = W.ff
    rate = spec.rate
    start = spec.start
    lc = spec.losscut
    rk = spec.rk
    rows = []
    bal = start
    seq = 0
    open_pos = {}
    exits_at = {}
    pend_at = {}
    pend = []
    # per pair: [long units, short units, Σ long units·fill, Σ short units·fill, open count]
    active = {}
    call = None
    counts = {"calls": 0, "cures": 0, "deadlines": 0, "losscuts": 0, "netted_all": 0}
    skipped = {"call": 0, "cap": 0, "lot": 0, "margin": 0, "passed": 0}
    skipped_emails = []
    taken = []
    shortfall = 0.0
    first_lot = None
    est = [[-math.inf, None, 0.0, 0.0] for _ in TERMS]
    bpeak = start
    mdd_closed = 0.0
    # the worst prices are looked up only where they are used
    want_bad = spec.lcworst or ledger

    def prices(p, gi):
        """the exit side's closes (bid, ask) and the mid close at grid index gi
        (the pair's last bar by then)"""
        f = F[p]
        k = ff[p][gi]
        if k < 0:
            raise RuntimeError(f"{p}: no bar by {iso(G[gi])}")
        bc, ac = f.bc[k], f.ac[k]
        if rk and f.rk is not None and f.rk[k] >= 0:
            m = (bc + ac) / 2
            bc, ac = m - f.rk[k], m + f.rk[k]
        return bc, ac, f.mc[k]

    def worst(p, gi):
        """each side's worst in the pair's bar ending at G[gi] (the bid low, the
        ask high); its close when no bar of the pair ends there"""
        f = F[p]
        k = ff[p][gi]
        if f.end[k] != G[gi]:
            bc, ac, _ = prices(p, gi)
            return bc, ac
        bl, ah = f.bl[k], f.ah[k]
        if rk and f.rk is not None and f.rk[k] >= 0:
            bl = (f.bl[k] + f.al[k]) / 2 - f.rk[k]
            ah = (f.bh[k] + f.ah[k]) / 2 + f.rk[k]
        return bl, ah

    def shift(gi):
        # the zero row: each position's path moved by its full shift times the
        # share of its 5-minute closes passed
        s = 0.0
        for pos in open_pos.values():
            s += pos.units * pos.sh * (gi - pos.gT) / pos.hold
        return s

    def state(gi, mid=False, bad=False):
        """(equity on the exit side's closes, margin on mids, equity on mids,
        equity at the bars' worst) at grid index gi, of the positions open now"""
        e = bal
        m = 0.0
        em = bal
        ew = bal
        usd = None
        for p, st in active.items():
            L, S, FL, FS = st[0], st[1], st[2], st[3]
            bc, ac, mc = prices(p, gi)
            if p.endswith("/JPY"):
                cv = 1.0
            else:
                if usd is None:
                    usd = W.conv(gi)
                cv = usd
            e += cv * (bc * L - FL + FS - ac * S)
            m += cv * mc * (L if L > S else S)
            if mid:
                em += cv * (mc * (L - S) - FL + FS)
            if bad:
                wl, wh = worst(p, gi)
                ew += cv * (wl * L - FL + FS - wh * S)
        if spec.zero and open_pos:
            z = shift(gi)
            e -= z
            em -= z
            ew -= z
        return e, rate * m, em, ew

    def margin_with(gi, extra):
        """the margin at grid index gi's mids with orders (pair, dir, units) added (MAX method)"""
        m = 0.0
        pairs = set(active) | {p for p, _, _ in extra}
        for p in pairs:
            st = active.get(p)
            L = st[0] if st else 0
            S = st[1] if st else 0
            for q, d, u in extra:
                if q == p:
                    if d > 0:
                        L += u
                    else:
                        S += u
            _, _, mc = prices(p, gi)
            cv = 1.0 if p.endswith("/JPY") else W.conv(gi)
            m += cv * mc * (L if L > S else S)
        return rate * m

    def row(g, kind, id_="", units="", px="", pnl="", eq=None, reason=""):
        if ledger:
            rows.append([g, kind, id_, units, px, pnl, bal, eq[0], eq[1], reason])

    def note_bal():
        # the drawdown on the balance alone (each exit), §8.99's 「決済だけ」
        nonlocal bpeak, mdd_closed
        if bal > bpeak:
            bpeak = bal
        elif bpeak - bal > mdd_closed:
            mdd_closed = bpeak - bal

    def add(pos):
        st = active.get(pos.pair)
        if st is None:
            st = active[pos.pair] = [0, 0, 0.0, 0.0, 0]
        if pos.dir > 0:
            st[0] += pos.units
            st[2] += pos.units * pos.fill
        else:
            st[1] += pos.units
            st[3] += pos.units * pos.fill
        st[4] += 1

    def close(pos, units, px, gi_conv, gi_frac, kind):
        """out units of a position at px; the realised P/L converted at USD/JPY's
        mid at grid index gi_conv"""
        nonlocal bal
        cv = 1.0 if pos.pair.endswith("/JPY") else W.conv(gi_conv)
        pnl = units * pos.dir * (px - pos.fill) * cv
        if spec.zero:
            pnl -= units * pos.sh * min(1.0, (gi_frac - pos.gT) / pos.hold)
        bal += pnl
        st = active[pos.pair]
        if pos.dir > 0:
            st[0] -= units
            st[2] -= units * pos.fill
        else:
            st[1] -= units
            st[3] -= units * pos.fill
        pos.units -= units
        if pos.units == 0:
            pos.open = False
            del open_pos[pos.seq]
            st[4] -= 1
            if st[4] == 0:
                del active[pos.pair]
        pos.parts.append((units, px, pnl, kind))
        note_bal()
        return pnl

    def enter(em, tv, units, leg):
        nonlocal seq
        seq += 1
        pos = Pos()
        pos.seq = seq
        pos.em = em
        pos.tv = tv
        pos.leg = leg
        pos.units = units
        pos.pair = em.pair
        pos.dir = em.dir
        pos.fill = tv.fill
        pos.gT = em.gT
        pos.hold = em.hold
        pos.sh = em.sh
        pos.gx = W.at[tv.x]
        pos.open = True
        pos.parts = []
        open_pos[seq] = pos
        add(pos)
        exits_at.setdefault(pos.gx, []).append(pos)
        return pos

    def forced(kind, gi_row_eq, g_row, how):
        """everything out (a loss-cut or a deadline): one row for the event, one
        exit row per position, then a shortfall row when the balance is below 0"""
        nonlocal shortfall
        row(g_row, kind, eq=state(gi_row_eq))
        for pos in list(open_pos.values()):
            px, gc = how(pos)
            u = pos.units
            pnl = close(pos, u, px, gc, gc, kind)
            row(g_row, "exit", pos.em.id + (f"#{pos.leg}" if spec.thirds else ""), u, px, pnl, state(gi_row_eq), kind)
        if bal < 0:
            shortfall = max(shortfall, -bal)
            row(g_row, "shortfall", pnl=-bal, eq=state(gi_row_eq))

    # the emails by the bar they are judged in: the first grid bar opening at or after T
    adm = {}
    for em in emails:
        adm.setdefault(em.gT + 1, []).append(em)
    for gi, group in adm.items():
        if spec.order is None:
            group.sort(key=lambda e: (e.T, e.key))
        else:
            group.sort(key=lambda e: (e.T, hash_key(spec.order, e)))
    adm_g = sorted(adm)
    if not adm_g:
        return rows, None

    # the summary's running numbers
    peak = start
    peak_g = None
    mdd = 0.0
    mdd_at = (None, None, None)
    mdd_pct = 0.0
    below = 0.0
    peak4 = start
    mdd4 = 0.0
    mddw = 0.0
    samples = []
    trough_peak = None
    recovered = None
    last_e = start

    def note4(e):
        nonlocal peak4, mdd4
        if e > peak4:
            peak4 = e
        elif peak4 - e > mdd4:
            mdd4 = peak4 - e

    ai = 0
    ti = bisect.bisect_left(W.tau_g, adm_g[0])
    fi = bisect.bisect_left(W.four_g, adm_g[0])
    gi = adm_g[0]
    n = len(G)
    while True:
        s = G[gi] - FINE
        gk = gi - 1
        g = G[gi]
        # ① a call not cured by its deadline: everything out at the open (exit
        # side) of its pair's first 5-minute bar opening at or after the deadline
        if call is not None and call.d <= s:
            d = call.d

            def at_deadline(pos):
                f = F[pos.pair]
                k = bisect.bisect_left(f.t, d)
                if k >= len(f.t):
                    raise RuntimeError(f"{pos.pair}: no bar after the deadline {iso(d)}")
                px = f.bo[k] if pos.dir > 0 else f.ao[k]
                if rk and f.rk is not None and f.rk[k] >= 0:
                    px = (f.bo[k] + f.ao[k]) / 2 - pos.dir * f.rk[k]
                return px, W.at[f.end[k]]

            forced("deadline", gk, s, at_deadline)
            counts["deadlines"] += 1
            call = None

        # ② the emails of this bar, judged one by one on the state at s
        if ai < len(adm_g) and adm_g[ai] == gi:
            group = adm[gi]
            ai += 1
            j = 0
            while j < len(group):
                T = group[j].T
                same = []
                while j < len(group) and group[j].T == T:
                    same.append(group[j])
                    j += 1
                eT = state(gk)[0]
                pl_T = eT - start
                cap_base = eT
                if spec.turtle:
                    m_ = math.floor((start - eT) / (0.1 * start))
                    if m_ >= 1:
                        cap_base = min(eT, start * 0.8 ** m_)
                extra = []
                for em in same:
                    units = None
                    if not spec.f10k:
                        cv = 1.0 if em.jpy else W.conv(gk)
                        units = math.floor(spec.k * cap_base / (SL_PIPS * em.unit * cv) / LOT) * LOT
                    else:
                        units = 10_000
                    # the AS netting: the opposite positions out, the oldest first,
                    # at the email's own fill; only what is left is judged
                    if spec.net and units > 0:
                        left = units
                        for pos in list(open_pos.values()):
                            if left == 0:
                                break
                            if pos.pair != em.pair or pos.dir == em.dir:
                                continue
                            c = min(left, pos.units)
                            pnl = close(pos, c, em.legs[0].fill, gk, gk, "net")
                            row(s, "exit", pos.em.id, c, em.legs[0].fill, pnl, state(gk), "net")
                            left -= c
                        if left == 0:
                            counts["netted_all"] += 1
                            continue
                        units = left
                    if spec.calls and call is not None:
                        skipped["call"] += 1
                        skipped_emails.append(em)
                        row(s, "skip", em.id, eq=state(gk), reason="call")
                        continue
                    if cap_blocks(spec.cap, em, open_pos, pend):
                        skipped["cap"] += 1
                        skipped_emails.append(em)
                        row(s, "skip", em.id, eq=state(gk), reason="cap")
                        continue
                    if units < LOT:
                        if first_lot is None:
                            first_lot = T
                        skipped["lot"] += 1
                        skipped_emails.append(em)
                        row(s, "skip", em.id, units, eq=state(gk), reason="lot")
                        continue
                    m_after = margin_with(gk, extra + [(em.pair, em.dir, units)])
                    if spec.margin and m_after > eT:
                        skipped["margin"] += 1
                        skipped_emails.append(em)
                        row(s, "skip", em.id, units, eq=state(gk), reason="margin")
                        continue
                    if spec.estar:
                        v = m_after - pl_T
                        if v > est[0][0]:
                            est[0] = [v, T, -pl_T, m_after]
                    rec = [em, []]
                    taken.append(rec)
                    if spec.thirds:
                        parts = [4000, 3000, 3000] if spec.f10k else thirds_units(units)
                        for leg, (tv, u) in enumerate(zip(em.legs, parts), 1):
                            if u == 0:
                                continue
                            pos = enter(em, tv, u, leg)
                            pos.rec = rec
                            rec[1].append(pos)
                            row(s, "enter", f"{em.id}#{leg}", u, tv.fill, eq=state(gk))
                        continue
                    tv = em.legs[0]
                    if tv.variant == "late":
                        # judged and sized at T; in at the close of the first bar, or
                        # out of it there when a level was already passed
                        ge = W.at[tv.entry_g]
                        pend.append((em, units, rec))
                        pend_at.setdefault(ge, []).append((em, units, rec))
                        extra.append((em.pair, em.dir, units))
                        continue
                    pos = enter(em, tv, units, 1)
                    pos.rec = rec
                    rec[1].append(pos)
                    row(s, "enter", em.id, units, tv.fill, eq=state(gk))

        # ③ the exits inside the bar, in the order of their entries
        xs = exits_at.pop(gi, None)
        if xs:
            xs.sort(key=lambda p: p.seq)
            for pos in xs:
                if not pos.open:
                    continue
                u = pos.units
                pnl = close(pos, u, pos.tv.px, gi, gi, pos.tv.kind)
                row(g, "exit", pos.em.id + (f"#{pos.leg}" if spec.thirds else ""), u, pos.tv.px, pnl, state(gi), pos.tv.kind)
        # ... then the late entries at the bar's close
        ps = pend_at.pop(gi, None)
        if ps:
            for em, units, rec in ps:
                pend[:] = [q for q in pend if q[0] is not em]
                tv = em.legs[0]
                if tv.kind == "passed":
                    skipped["passed"] += 1
                    skipped_emails.append(em)
                    taken.remove(rec)
                    row(g, "skip", em.id, units, eq=state(gi), reason="passed")
                    continue
                pos = enter(em, tv, units, 1)
                pos.rec = rec
                rec[1].append(pos)
                row(g, "enter", em.id, units, tv.fill, eq=state(gi))

        # ④ the loss-cut on the closes (lcworst: at the bars' worst, out there),
        # then the cure of an open call
        if lc is not None and open_pos:
            e, m, _, ew = state(gi, bad=spec.lcworst)
            if (ew if spec.lcworst else e) < lc * m:
                if spec.lcworst:
                    forced("losscut", gi, g, lambda pos: (worst(pos.pair, gi)[0 if pos.dir > 0 else 1], gi))
                else:
                    forced("losscut", gi, g, lambda pos: (prices(pos.pair, gi)[0 if pos.dir > 0 else 1], gi))
                counts["losscuts"] += 1
        if call is not None:
            held = [open_pos.get(q) for q in call.held]
            if spec.strict:
                cured = all(p_ is None for p_ in held)
            else:
                # the margin, at the close's mids (MAX method), of what is still
                # held of the positions held at the close
                left = {}
                for p_ in held:
                    if p_ is None:
                        continue
                    lr = left.setdefault(p_.pair, [0, 0])
                    lr[0 if p_.dir > 0 else 1] += p_.units
                m_left = rate * sum(call.mids[p] * max(L, S) for p, (L, S) in left.items())
                cured = call.M - m_left >= call.C
            if cured:
                counts["cures"] += 1
                call = None
                row(g, "cure", eq=state(gi))

        # ⑤ New York's close: the call, on mids
        if gi in W.tau_at:
            tau, deadline = W.tau_at[gi]
            e, m, em_, _ = state(gi, mid=True)
            if spec.estar:
                v = m - (em_ - start)
                if v > est[1][0]:
                    est[1] = [v, g, -(em_ - start), m]
            if spec.calls and call is None and em_ < m:
                call = Call()
                call.tau = tau
                call.g = g
                call.d = deadline
                call.C = m - em_
                call.M = m
                call.held = list(open_pos.keys())
                call.mids = {}
                for p in active:
                    cv = 1.0 if p.endswith("/JPY") else W.conv(gi)
                    call.mids[p] = prices(p, gi)[2] * cv
                counts["calls"] += 1
                row(g, "call", pnl=call.C, eq=(e, m))

        # ⑥ the equity and margin at the close
        e, m, _, ew = state(gi, bad=want_bad)
        samples.append((g, e))
        last_e = e
        if e > peak:
            peak = e
            peak_g = g
        dd = peak - e
        if dd > mdd:
            mdd = dd
            mdd_at = (peak, peak_g, g)
            trough_peak = peak
            recovered = None
        elif trough_peak is not None and recovered is None and e >= trough_peak:
            recovered = g
        if not spec.f10k and peak > 0 and dd / peak > mdd_pct:
            mdd_pct = dd / peak
        if start - e > below:
            below = start - e
        # the bound: every open position at its bar's worst at once, against
        # the peak on the closes
        if want_bad and peak - ew > mddw:
            mddw = peak - ew
        if gi in W.four_set:
            note4(e)
        if spec.estar:
            pl = e - start
            plw = (ew - start) if spec.lcworst else pl
            v = 0.5 * m - plw
            if v > est[2][0]:
                est[2] = [v, g, -plw, 0.5 * m]
            if -pl > est[3][0]:
                est[3] = [-pl, g, -pl, 0.0]

        # the next bar worth a look: the next one while anything is open or
        # waiting; else the next email's, NY close's or deadline's
        if open_pos or pend:
            nxt = gi + 1
        else:
            cands = []
            if ai < len(adm_g):
                cands.append(adm_g[ai])
            while ti < len(W.tau_g) and W.tau_g[ti] <= gi:
                ti += 1
            # every NY close to the grid's end (E*'s second term, a call on a
            # balance below 0)
            if ti < len(W.tau_g):
                cands.append(W.tau_g[ti])
            if call is not None:
                cands.append(bisect.bisect_left(G, call.d + FINE))
            nxt = min(cands) if cands else None
            # nothing moves in between: the 4-hour closes there stand at the balance
            hi = nxt if nxt is not None else n
            while fi < len(W.four_g) and W.four_g[fi] < hi:
                if W.four_g[fi] > gi:
                    note4(bal)
                fi += 1
        if nxt is None or nxt >= n:
            break
        gi = nxt

    return rows, finish(spec, rows, samples, taken, skipped, skipped_emails, counts, bal, last_e, start, shortfall, est,
                        dict(mdd=mdd, mdd_at=mdd_at, mdd_pct=mdd_pct, below=below, mdd_closed=mdd_closed, mdd4=mdd4, mddw=mddw, recovered=recovered, first_lot=first_lot))


def cap_blocks(cap, em, open_pos, pend):
    """the cap (positions open now, and late orders waiting for their fill)"""
    if cap == "C0":
        return False
    held = [(p.pair, p.dir) for p in open_pos.values()] + [(q.pair, q.dir) for q, _, _ in pend]
    if cap == "T1":
        return len(held) >= 1
    if cap == "T3":
        return len(held) >= 3
    if cap == "P1":
        return any(p == em.pair for p, _ in held)
    if cap == "J2":
        if not em.jpy:
            return False
        return sum(1 for p, d in held if p.endswith("/JPY") and d == em.dir) >= 2
    raise ValueError(cap)


def changes(samples, start, offset, length):
    """each period's change of equity (a period from offset, of length; a grid
    time on a boundary closes the period before it): the smallest"""
    if not samples:
        return 0.0
    ends = {}
    for g, e in samples:
        ends[(g - 1 - offset) // length] = e
    keys = sorted(ends)
    worst = math.inf
    prev = start
    last = None
    for k in keys:
        if last is not None and k > last + 1:
            worst = min(worst, 0.0)  # a period with nothing moving
        worst = min(worst, ends[k] - prev)
        prev = ends[k]
        last = k
    return worst


def finish(spec, rows, samples, taken, skipped, skipped_emails, counts, bal, last_e, start, shortfall, est, mm):
    """the run's summary"""
    wins = 0
    resolved = 0
    pips = []
    yen = []
    for em, poss in taken:
        units = 0
        psum = 0.0
        ysum = 0.0
        kinds = []
        for pos in poss:
            for u, px, pnl, kind in pos.parts:
                units += u
                psum += u * pos.dir * (px - pos.fill) / em.unit
                ysum += pnl
                kinds.append((pos.leg, kind))
        if units == 0:
            continue
        if spec.net and any(k == "net" for _, k in kinds):
            kind = "net"
        else:
            kind = [k for leg, k in kinds if leg == 1][-1]
        wins += kind == "tp"
        resolved += kind != "time"
        pips.append(psum / units)
        yen.append(ysum)
    n = len(taken)
    out = {
        "final_balance": bal,
        "final_equity": last_e,
        "total_yen": bal - start,
        "mdd_yen": mm["mdd"],
        "mdd_pct": mm["mdd_pct"],
        "worst_week_yen": changes(samples, start, WEEK_OFFSET, WEEK),
        "worst_day_yen": changes(samples, start, DAY_OFFSET, DAY),
        "taken": n,
        "skipped": dict(skipped),
        "calls": counts["calls"],
        "cures": counts["cures"],
        "deadlines": counts["deadlines"],
        "losscuts": counts["losscuts"],
        "shortfall_yen": shortfall,
        "win_all": wins / n if n else None,
        "win_resolved": wins / resolved if resolved else None,
        "mean_pips": sum(pips) / len(pips) if pips else None,
        "mean_yen": sum(yen) / len(yen) if yen else None,
        # beyond the interface's list: compared only where money.json has them
        "mdd_4h_yen": mm["mdd4"],
        "mdd_closed_yen": mm["mdd_closed"],
        "mdd_worst_yen": mm["mddw"],
        "below_start_yen": mm["below"],
        "netted_all": counts["netted_all"],
        "first_lot_skip_g": iso(mm["first_lot"]) if mm["first_lot"] is not None else None,
    }
    if mm["mdd_at"][1] is not None:
        out["mdd_peak_g"] = iso(mm["mdd_at"][1])
        out["mdd_trough_g"] = iso(mm["mdd_at"][2])
        out["mdd_recovered_g"] = iso(mm["recovered"]) if mm["recovered"] is not None else None
    if spec.estar:
        j = max(range(len(TERMS)), key=lambda q: (est[q][0], -q))
        v = est[j][0]
        out["estar"] = {
            "value": v,
            "terms": [{"name": TERMS[q], "value": est[q][0], "g": iso(est[q][1]) if est[q][1] is not None else None} for q in range(len(TERMS))],
            "lost": est[j][2],
            "margin": est[j][3],
        }
        # the ratio against the account the cell needed: E* + the yen path
        peak = v
        worst = 0.0
        for _, e in samples:
            x = v + e
            if x > peak:
                peak = x
            elif peak > 0 and (peak - x) / peak > worst:
                worst = (peak - x) / peak
        out["mdd_pct"] = worst
    out["_skipped_emails"] = skipped_emails
    out["_taken"] = taken
    out["_samples"] = samples
    return out


# ---- the runs ---------------------------------------------------------------------------------


def emails_for(W, sigs, variant, legs=None, drop=None):
    """the emails of a run: each signal's trade under a variant (the thirds: its
    three legs), placed on the world's grid"""
    out = []
    for sg in sigs:
        if drop is not None and drop(sg):
            continue
        em = Email()
        em.sig = sg
        em.id = sg.id
        em.pair = sg.pair
        em.side = sg.side
        em.dir = sg.dir
        em.buy = sg.buy
        em.jpy = sg.jpy
        em.unit = sg.unit
        em.T = sg.T
        em.T_iso = iso(sg.T)
        em.gT = W.gT(sg.T)
        em.legs = [sg.tv[v] for v in (legs or [variant])]
        main = sg.tv["main"]
        em.gx = W.at[main.x]
        em.hold = em.gx - em.gT
        em.sh = 0.0
        em.key = (LIVE_ORDER.index(sg.pair), 0 if sg.buy else 1)
        out.append(em)
    return out


def yen10k(W, tv):
    """a trade's yen at 10,000 units (a USD pair at USD/JPY's mid at its exit)"""
    sg = tv.sig
    cv = 1.0 if sg.jpy else W.conv(W.at[tv.x])
    return 10_000 * sg.dir * (tv.px - tv.fill) * cv


def run_key(row, cell):
    return f"row_{row}_{cell}" if row else cell


def spec_of(key, cell, row=None, order=None, start=None):
    sizing, cap = cell.split("_")
    course = 10 if row == "x10" else 25
    return Spec(key, sizing, cap, row=row, course=course, start=start, order=order)


def told_emails(W9, W12, sigs9, sigs12, row, cell, zero_delta):
    """a told row's world and emails"""
    if row == "p12":
        return W12, emails_for(W12, sigs12, "main")
    if row == "late":
        return W9, emails_for(W9, sigs9, "late")
    if row == "rakuten":
        return W9, emails_for(W9, sigs9, "rakuten")
    if row == "nights":
        return W9, emails_for(W9, sigs9, "main", drop=lambda sg: utc(sg.T).hour in NIGHT_HOURS and sg.T % HOUR == 0)
    if row == "thirds":
        return W9, emails_for(W9, sigs9, "main", legs=["main", "tp2", "tp3"])
    ems = emails_for(W9, sigs9, "main")
    if row == "zero":
        d_yen, d_r = zero_delta
        for em in ems:
            if cell.startswith("F10k"):
                em.sh = d_yen / 10_000
            else:
                # δ in R: per unit, R's yen (13 pips at T's conversion) times δ
                cv = 1.0 if em.jpy else W9.conv(em.gT)
                em.sh = d_r * SL_PIPS * em.unit * cv
    return W9, ems


# ---- this check's numbers in money.ts's formats --------------------------------------------------


def fmt(x):
    if x is None:
        return ""
    if isinstance(x, bool):
        return "true" if x else "false"
    if isinstance(x, int):
        return str(x)
    if isinstance(x, float):
        if x == int(x) and abs(x) < 1e21:
            return str(int(x))
        return repr(x)
    return str(x)


TRADE_COLS = ["id", "variant", "fill", "mid_close", "sl", "tp", "entry_g", "exit_kind", "exit_open", "x", "exit_px", "pips", "hold_grid", "cal_ms", "weekend", "nights_ny"]
LEDGER_COLS = ["seq", "g", "kind", "id", "units", "px", "pnl_yen", "balance", "equity", "margin", "reason"]


def trade_rows(W9, W12, sigs, taus):
    """money-trades.csv's rows, keyed (id, variant)"""
    out = {}
    for sg in sigs:
        W = W9 if sg.group == "CALL9" else W12
        gT = W.gT(sg.T)
        for v in VARIANTS:
            tv = sg.tv[v]
            if tv is None:
                continue
            r = {"id": sg.id, "variant": v, "fill": tv.fill, "mid_close": tv.close, "sl": tv.sl, "tp": tv.tp, "entry_g": tv.entry_g, "exit_kind": tv.kind}
            if tv.kind == "passed":
                for c in ("exit_open", "x", "exit_px", "pips", "hold_grid", "cal_ms", "weekend", "nights_ny"):
                    r[c] = None
            else:
                r["exit_open"] = tv.exit_open
                r["x"] = tv.x
                r["exit_px"] = tv.px
                r["pips"] = tv.pips
                r["hold_grid"] = W.at[tv.x] - gT
                r["cal_ms"] = tv.x - sg.T
                r["weekend"] = week_of(tv.x) - week_of(sg.T)
                r["nights_ny"] = bisect.bisect_left(taus, tv.x) - bisect.bisect_right(taus, sg.T)
            out[(sg.id, v)] = r
    return out


def write_mine(outdir, trades, ledgers, js):
    os.makedirs(outdir, exist_ok=True)
    with open(os.path.join(outdir, "money-trades.csv"), "w") as f:
        f.write(",".join(TRADE_COLS) + "\n")
        for r in trades.values():
            f.write(",".join(iso(r[c]) if c in ("entry_g", "exit_open", "x") and r[c] is not None else fmt(r[c]) for c in TRADE_COLS) + "\n")
    for key, rows in ledgers.items():
        with open(os.path.join(outdir, f"money-ledger-{key}.csv"), "w") as f:
            f.write(",".join(LEDGER_COLS) + "\n")
            for i, r in enumerate(rows, 1):
                g, kind, id_, units, px, pnl, bal, eq, m, reason = r
                f.write(",".join([str(i), iso(g), kind, id_, fmt(units), fmt(px), fmt(pnl), fmt(bal), fmt(eq), fmt(m), reason]) + "\n")
    with open(os.path.join(outdir, "money.json"), "w") as f:
        json.dump(js, f, indent=1)


def public(summary):
    return {k: v for k, v in summary.items() if not k.startswith("_")}


# ---- comparing ----------------------------------------------------------------------------------


class Checks:
    def __init__(self):
        self.c = {}

    def tally(self, cls, ok, example):
        x = self.c.setdefault(cls, [0, 0, []])
        x[0] += 1
        if not ok:
            x[1] += 1
            if len(x[2]) < 5:
                x[2].append(example() if callable(example) else example)

    def bad(self):
        return sum(x[1] for x in self.c.values())

    def print(self):
        for cls, (n, m, ex) in self.c.items():
            print(f"  {cls}: compared {n}, mismatched {m}")
            for e in ex:
                print(f"      {e}")


TIME_COLS = {"entry_g", "exit_open", "x", "g"}
PRICE_COLS = {"fill", "mid_close", "sl", "tp", "exit_px", "px"}
PIP_COLS = {"pips", "mean_pips"}
YEN_COLS = {"pnl_yen", "balance", "equity", "margin"}
RATE_COLS = {"win_all", "win_resolved", "mdd_pct", "timeout_share"}
EXACT_INT_COLS = {"hold_grid", "cal_ms", "weekend", "nights_ny", "units", "seq"}


def same(col, mine, theirs):
    """mine (a number, a string or None) against theirs (a CSV cell or a JSON value)"""
    if isinstance(theirs, str):
        theirs = theirs.strip()
        if theirs == "":
            theirs = None
    if mine is None or mine == "":
        return theirs is None or theirs == "" or theirs == "null"
    if theirs is None:
        return False
    if col in TIME_COLS or col == "g":
        try:
            return (mine if isinstance(mine, int) else ms_of(mine)) == ms_of(theirs)
        except Exception:
            return False
    if isinstance(mine, bool) or isinstance(theirs, bool):
        return bool(mine) == (theirs in (True, "true", "1", 1))
    if isinstance(mine, str):
        return mine == str(theirs)
    try:
        t = float(theirs) if not isinstance(theirs, bool) else float(theirs)
    except (TypeError, ValueError):
        if theirs in ("true", "false"):
            t = 1.0 if theirs == "true" else 0.0
        else:
            return False
    m = float(mine)
    if col in EXACT_INT_COLS or isinstance(mine, int):
        return m == t
    if col in PRICE_COLS:
        return abs(m - t) <= 1e-9
    if col in PIP_COLS or col == "r":
        return abs(m - t) <= 1e-6
    if col in RATE_COLS:
        return abs(m - t) <= 1e-9
    # yen and the rest: 1e-6, or 1e-12 of the size for sums near millions
    return abs(m - t) <= max(1e-6, 1e-12 * abs(m))


def read_csv(path):
    with open(path) as f:
        return list(csv.DictReader(f))


def compare_trades(ck, mine, path):
    if not os.path.exists(path):
        ck.tally("files", False, f"missing {path}")
        return
    ck.tally("files", True, "")
    theirs = {}
    for r in read_csv(path):
        theirs[(r["id"], r["variant"])] = r
    for k, r in mine.items():
        t = theirs.pop(k, None)
        if t is None:
            ck.tally("trades", False, f"{k[0]} {k[1]}: not in money-trades.csv")
            continue
        for c in TRADE_COLS[2:]:
            ok = same(c, r[c], t.get(c))
            cls = "trades:" + ("prices" if c in PRICE_COLS else "pips" if c in PIP_COLS else "times" if c in TIME_COLS else "kinds/counts")
            ck.tally(cls, ok, lambda c=c, r=r, t=t: f"{r['id']} {r['variant']} {c}: money.ts {t.get(c)!r}, here {fmt(r[c]) if c not in TIME_COLS or r[c] is None else iso(r[c])}")
    for k in theirs:
        ck.tally("trades", False, f"{k[0]} {k[1]}: in money-trades.csv, not here")


def compare_ledger(ck, key, rows, path):
    if not os.path.exists(path):
        ck.tally("files", False, f"missing {path}")
        return
    ck.tally("files", True, "")
    theirs = read_csv(path)
    ck.tally("ledger:rows", len(theirs) == len(rows), f"{key}: {len(theirs)} rows in money.ts's ledger, {len(rows)} here")
    first = None
    for i, (r, t) in enumerate(zip(rows, theirs)):
        g, kind, id_, units, px, pnl, bal, eq, m, reason = r
        mine = {"g": g, "kind": kind, "id": id_, "units": units if units != "" else None, "px": px if px != "" else None, "pnl_yen": pnl if pnl != "" else None, "balance": bal, "equity": eq, "margin": m, "reason": reason}
        try:
            seq0 = int(theirs[0]["seq"])
            ck.tally("ledger:seq", int(t["seq"]) - seq0 == i, f"{key} row {i}: seq {t['seq']}")
        except (KeyError, ValueError):
            ck.tally("ledger:seq", False, f"{key} row {i}: seq {t.get('seq')!r}")
        for c, v in mine.items():
            ok = same(c, v, t.get(c))
            cls = "ledger:" + ("times" if c == "g" else "prices" if c == "px" else "yen" if c in YEN_COLS else "kinds/units")
            if not ok and first is None:
                first = i
            ck.tally(cls, ok, lambda c=c, v=v, t=t, i=i: f"{key} row {i + 1} ({kind} {id_}) {c}: money.ts {t.get(c)!r}, here {iso(v) if c == 'g' else fmt(v)}")


SUMMARY_KEYS = ["final_balance", "final_equity", "total_yen", "mdd_yen", "mdd_pct", "worst_week_yen", "worst_day_yen", "taken", "skipped", "calls", "cures", "deadlines", "losscuts", "shortfall_yen", "win_all", "win_resolved", "mean_pips", "mean_yen"]
EXTRA_KEYS = ["mdd_4h_yen", "mdd_closed_yen", "mdd_worst_yen", "below_start_yen", "netted_all", "mdd_peak_g", "mdd_trough_g", "mdd_recovered_g", "first_lot_skip_g"]


def num_class(k):
    if k in ("taken", "calls", "cures", "deadlines", "losscuts", "netted_all") or k.startswith("skipped"):
        return "summary:counts"
    if k.endswith("_g") or k == "g":
        return "summary:times"
    if k in ("mean_pips",):
        return "summary:pips"
    if k in ("win_all", "win_resolved", "mdd_pct"):
        return "summary:rates"
    return "summary:yen"


def compare_summary(ck, key, mine, theirs, absent):
    if theirs is None:
        ck.tally("summary:missing", False, f"{key}: not in money.json")
        return
    for k in SUMMARY_KEYS:
        if k not in theirs:
            ck.tally("summary:missing", False, f"{key}.{k}: not in money.json")
            continue
        if k == "skipped":
            for r in ("call", "cap", "lot", "margin", "passed"):
                got = (theirs[k] or {}).get(r)
                ck.tally("summary:counts", same("units", mine[k][r], got if got is not None else 0), f"{key}.skipped.{r}: money.ts {got}, here {mine[k][r]}")
            continue
        col = "mean_pips" if k == "mean_pips" else ("units" if num_class(k) == "summary:counts" else k)
        ck.tally(num_class(k), same(col, mine[k], theirs[k]), f"{key}.{k}: money.ts {theirs[k]!r}, here {mine[k]!r}")
    for k in EXTRA_KEYS:
        if k not in mine:
            continue
        if k not in theirs:
            absent.add(k)
            continue
        col = "g" if k.endswith("_g") else ("units" if k == "netted_all" else k)
        ck.tally(num_class(k), same(col, mine[k], theirs[k]), f"{key}.{k}: money.ts {theirs[k]!r}, here {mine[k]!r}")
    if "estar" in mine:
        t = theirs.get("estar")
        if not isinstance(t, dict):
            ck.tally("estar", False, f"{key}.estar: not in money.json")
            return
        m = mine["estar"]
        ck.tally("estar", same("yen", m["value"], t.get("value")), f"{key}.estar.value: money.ts {t.get('value')!r}, here {m['value']!r}")
        for k in ("lost", "margin"):
            ck.tally("estar", same("yen", m[k], t.get(k)), f"{key}.estar.{k}: money.ts {t.get(k)!r}, here {m[k]!r}")
        terms = t.get("terms") or []
        ck.tally("estar", len(terms) == len(m["terms"]), f"{key}.estar.terms: {len(terms)} in money.json")
        for q, (a, b) in enumerate(zip(m["terms"], terms)):
            ck.tally("estar", same("yen", a["value"], b.get("value")), f"{key}.estar.terms[{q}] ({a['name']}/{b.get('name')}) value: money.ts {b.get('value')!r}, here {a['value']!r}")
            ck.tally("estar:times", same("g", a["g"], b.get("g")), f"{key}.estar.terms[{q}] ({a['name']}) g: money.ts {b.get('g')!r}, here {a['g']}")


# ---- the main check -----------------------------------------------------------------------------


def load_signals(path, wrong):
    sigs = []
    for r in read_csv(path):
        sg = Sig()
        sg.id = r["id"]
        sg.pair = r["pair"]
        sg.group = r.get("group", "CALL9")
        sg.bar = ms_of(r["bar_open"])
        sg.T = ms_of(r["T"])
        sg.side = r["side"]
        sg.rules = r.get("rules", "")
        sg.buy = sg.side == "BUY"
        sg.dir = 1 if sg.buy else -1
        sg.jpy = sg.pair.endswith("/JPY")
        sg.unit = 0.01 if sg.jpy else 0.0001
        sg.digits = 3 if sg.jpy else 5
        sg.T_iso = iso(sg.T)
        if sg.T != sg.bar + FOUR:
            wrong.append(f"{sg.id}: T is not the bar's open + 4 h")
        if sg.side not in ("BUY", "SELL"):
            wrong.append(f"{sg.id}: side {sg.side}")
        if sg.pair not in LIVE_ORDER:
            wrong.append(f"{sg.id}: {sg.pair} is not a pair in play")
        sigs.append(sg)
    return sigs


def load_data(cache, pairs, start, now):
    """GMO's 5-minute and 4-hour files of the pairs: 5-minute bars from 5 days
    before START, 4-hour bars from 9 hours before the 1st of January of the year
    before START"""
    F = {}
    fours = {}
    differ = 0
    year0 = utc(start).year - 1
    long_from = int(datetime(year0, 1, 1, tzinfo=timezone.utc).timestamp() * 1000) - 9 * HOUR
    for p in pairs:
        sym = p.replace("/", "_")
        rows, x1 = read_bars(cache, sym, "5min", start - 5 * DAY, now)
        four, x2 = read_bars(cache, sym, "4hour", long_from, now)
        differ += x1 + x2
        F[p] = Fine(p, rows)
        fours[p] = Four(four)
        print(f"{p}: 5-minute bars {len(rows)}, 4-hour bars {len(four)}")
    return F, fours, differ


def prepare(sigs, F, fours, ck, need=True, start=None, digits=None):
    """each signal's bar in the raw files, its five trades"""
    wrong = []
    for sg in sigs:
        if digits and sg.pair in digits:
            sg.digits = int(digits[sg.pair])
        four = fours.get(sg.pair)
        i = four.at.get(sg.bar) if four else None
        ok = i is not None
        ck.tally("signals", ok, f"{sg.id}: no such 4-hour bar in the raw files")
        if not ok:
            sg.tv = {v: None for v in VARIANTS}
            continue
        sg.i4 = i
        if need:
            ck.tally("signals", i + NEED < len(four.t), f"{sg.id}: fewer than {NEED} 4-hour bars after it")
            ck.tally("signals", mailed(sg.T), f"{sg.id}: T not mailed (possibly closed 0, 4 and 6 minutes after)")
            ck.tally("signals", start is None or sg.T >= start, f"{sg.id}: before START")
        build_trade(sg, F[sg.pair], four, wrong)
    for w in wrong:
        ck.tally("signals", False, w)


def plant_trades(sigs, plant, F):
    """--plant: an error put into this check's own reading of the trades"""
    for sg in sigs:
        tv = sg.tv.get("main")
        if tv is None or sg.group != "CALL9":
            continue
        if plant == "exitlate" and tv.kind in ("tp", "sl"):
            # the exit one 5-minute bar later (its price kept)
            f = F[sg.pair]
            if tv.f_exit + 1 >= len(f.t):
                continue
            print(f"planted: {sg.id} main out a 5-minute bar later")
            tv.f_exit += 1
            tv.exit_open = f.t[tv.f_exit]
            tv.x = tv.exit_open + FINE
            return True
        if plant == "pipplus":
            print(f"planted: {sg.id} main 1 pip more")
            tv.pips += 1
            return True
    return False


def ordered_sigs(sigs):
    return sorted(sigs, key=lambda sg: (sg.T, LIVE_ORDER.index(sg.pair), 0 if sg.buy else 1))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cache", default="research/.cache")
    ap.add_argument("--out", default="research/out")
    ap.add_argument("--start", default="2024-01-01")
    ap.add_argument("--split", default="2025-05-19")
    ap.add_argument("--end", default="2026-10-02T21:00:00Z")
    ap.add_argument("--fixture", default="")
    ap.add_argument("--plant", default="none", choices=["none", "exitlate", "pipplus", "balance"])
    ap.add_argument("--write", default="")
    ap.add_argument("--quick", action="store_true", help="the cells and told rows only (no orders, thinning or windows)")
    args = ap.parse_args()
    t0 = time.time()
    if args.fixture:
        sys.exit(fixture_main(args))

    ck = Checks()
    start = ms_of(args.start)
    split = ms_of(args.split)
    now = ms_of(args.end)
    sig_path = os.path.join(args.out, "money-signals.csv")
    if not os.path.exists(sig_path):
        print(f"missing {sig_path}")
        sys.exit(1)
    wrong = []
    sigs = ordered_sigs(load_signals(sig_path, wrong))
    for w in wrong:
        ck.tally("signals", False, w)
    in_play = [p for p in LIVE_ORDER if any(sg.pair == p for sg in sigs)]
    need_pairs = list(in_play)
    if any(not p.endswith("/JPY") for p in in_play) and "USD/JPY" not in need_pairs:
        need_pairs.append("USD/JPY")
    F, fours, differ = load_data(args.cache, need_pairs, start, now)
    print(f"rows in two files with different prices: {differ}")
    prepare(sigs, F, fours, ck, need=True, start=start)
    if args.plant in ("exitlate", "pipplus"):
        plant_trades(sigs, args.plant, F)
    sigs = [sg for sg in sigs if all(sg.tv.get(v) is not None for v in VARIANTS)]
    sigs9 = [sg for sg in sigs if sg.group == "CALL9"]
    sigs12 = [sg for sg in sigs if sg.group in ("CALL9", "C3")]
    lo = min(F[p].t[0] for p in need_pairs if F[p].t)
    hi = max(F[p].end[-1] for p in need_pairs if F[p].t)
    taus = ny_closes(lo, hi)
    p9 = [p for p in CALL9 if p in F]
    W9 = World(p9, F, fours, taus)
    W12 = World([p for p in CALL9 + C3 if p in F], F, fours, taus) if any(sg.group == "C3" for sg in sigs) else W9
    print(f"grid: {len(W9.G)} times (9 pairs), {len(W12.G)} (12); NY closes {len(taus)}; {time.time() - t0:.0f} s")

    trades = trade_rows(W9, W12, sigs, W9.taus)
    js, ledgers = compute_all(W9, W12, sigs9, sigs12, split, args.quick, args.plant)
    print(f"computed in {time.time() - t0:.0f} s")
    if args.plant == "balance":
        for rows in ledgers.values():
            if rows:
                rows[0][6] += 1
                print(f"planted: the first ledger's first balance 1 yen more")
                break
    if args.write:
        write_mine(args.write, trades, ledgers, js)
        print(f"wrote this check's own numbers to {args.write}")
        return

    compare_trades(ck, trades, os.path.join(args.out, "money-trades.csv"))
    for key, rows in ledgers.items():
        compare_ledger(ck, key, rows, os.path.join(args.out, f"money-ledger-{key}.csv"))
    jp = os.path.join(args.out, "money.json")
    if not os.path.exists(jp):
        ck.tally("files", False, f"missing {jp}")
    else:
        compare_json(ck, js, json.load(open(jp)), args.quick)
    print("\nthe check:")
    ck.print()
    bad = ck.bad()
    print(f"\n{'MONEY.TS AGREES WITH THE CHECK' if bad == 0 else 'MONEY.TS DOES NOT AGREE WITH THE CHECK'} ({bad} mismatched; {time.time() - t0:.0f} s)")
    sys.exit(0 if bad == 0 else 1)


def compute_all(W9, W12, sigs9, sigs12, split, quick, plant):
    """every run, and money.json's parts this check recomputes"""
    js = {"cells": {}, "rows": {}, "orders": {}, "thin": {}, "kept": {}}
    ledgers = {}
    results = {}
    main9 = emails_for(W9, sigs9, "main")
    # the trades (CALL9, main)
    tvs = [sg.tv["main"] for sg in sigs9]
    n = len(tvs)
    per_pair = {p: sum(1 for sg in sigs9 if sg.pair == p) for p in CALL9}
    first = sum(1 for sg in sigs9 if sg.T < split)
    wins = sum(1 for tv in tvs if tv.kind == "tp")
    res = sum(1 for tv in tvs if tv.kind != "time")
    js["trades"] = {
        "n": n,
        "per_pair": per_pair,
        "halves": [first, n - first],
        "win_all": wins / n if n else None,
        "win_resolved": wins / res if res else None,
        "mean_pips": sum(tv.pips for tv in tvs) / n if n else None,
        "timeout_share": sum(1 for tv in tvs if tv.kind == "time") / n if n else None,
    }
    d_yen = sum(yen10k(W9, tv) for tv in tvs) / n if n else 0.0
    d_r = (sum(tv.pips for tv in tvs) / n / SL_PIPS) if n else 0.0
    js["zero_delta"] = {"yen": d_yen, "r": d_r}

    for cell in CELLS:
        t1 = time.time()
        rows, sm = run(W9, [*main9], spec_of(cell, cell))
        ledgers[cell] = rows
        results[cell] = sm
        js["cells"][cell] = public(sm) if sm else None
        print(f"  {cell}: {len(rows)} ledger rows, taken {sm and sm['taken']}, final {sm and sm['final_balance']:.2f} ({time.time() - t1:.1f} s)")
    for row, cell in TOLD:
        key = run_key(row, cell)
        W, ems = told_emails(W9, W12, sigs9, sigs12, row, cell, (d_yen, d_r))
        rows, sm = run(W, ems, spec_of(key, cell, row=row))
        ledgers[key] = rows
        js["rows"][key] = public(sm) if sm else None
        print(f"  {key}: {len(rows)} ledger rows, taken {sm and sm['taken']}, final {sm and sm['final_balance']:.2f}")

    # kept against skipped: R (pips ÷ 13) of the trades each took and skipped,
    # and with the spread paid at the entry put back
    for cell in THIN_CELLS:
        sm = results[cell]
        kept = [em.sig for em, _ in sm["_taken"]]
        skip = [em.sig for em in sm["_skipped_emails"]]

        def mean(xs):
            return sum(xs) / len(xs) if xs else None

        rk = mean([sg.tv["main"].pips / SL_PIPS for sg in kept])
        rs = mean([sg.tv["main"].pips / SL_PIPS for sg in skip])
        nk = mean([(sg.tv["main"].pips + sg.spread) / SL_PIPS for sg in kept])
        ns = mean([(sg.tv["main"].pips + sg.spread) / SL_PIPS for sg in skip])
        js["kept"][cell] = {
            "mean_r_kept": rk,
            "mean_r_skipped": rs,
            "diff": None if rk is None or rs is None else rk - rs,
            "diff_nospread": None if nk is None or ns is None else nk - ns,
        }
    if quick:
        return js, ledgers

    for cell in ORDER_CELLS:
        t1 = time.time()
        js["orders"][cell] = []
        for r in range(1, ORDERS + 1):
            _, sm = run(W9, [*main9], spec_of(cell, cell, order=r), ledger=False)
            js["orders"][cell].append(sm["final_equity"])
        print(f"  orders {cell}: {time.time() - t1:.1f} s")
    for cell in THIN_CELLS:
        sm = results[cell]
        by_week = {}
        for em in sm["_skipped_emails"]:
            by_week[week_of(em.T)] = by_week.get(week_of(em.T), 0) + 1
        sizing = cell.split("_")[0]
        draws = []
        weeks = {}
        for em in main9:
            weeks.setdefault(week_of(em.T), []).append(em)
        for d in range(1, THIN_DRAWS + 1):
            # draw d: in each week, as many of its emails as the cell skipped
            # there, the smallest sha256("{d}|{pair}|{side}|{T}") first
            drop = set()
            for w, k in by_week.items():
                pool = sorted(weeks.get(w, []), key=lambda e: hash_key(d, e))
                drop.update(e.id for e in pool[:k])
            ems = [em for em in main9 if em.id not in drop]
            _, s2 = run(W9, ems, spec_of(cell, f"{sizing}_C0"), ledger=False)
            draws.append({"taken": s2["taken"], "final_equity": s2["final_equity"], "mdd_yen": s2["mdd_yen"], "worst_week_yen": s2["worst_week_yen"]})
        js["thin"][cell] = draws
    js["windows"] = windows(W9, main9)
    return js, ledgers


def windows(W, ems):
    """E* of 10,000 units with no cap on every 52-week window from the first
    entry's week: the trades entered in it, followed to their exits, P/L 0 at
    its start; a window ending after the last entry is not used"""
    if not ems:
        return []
    w0 = week_of(min(em.T for em in ems))
    last_T = max(em.T for em in ems)
    out = []
    w = w0
    while (w + 52) * WEEK + WEEK_OFFSET <= last_T:
        a = w * WEEK + WEEK_OFFSET
        b = a + 52 * WEEK
        sub = [em for em in ems if a <= em.T < b]
        if sub:
            _, sm = run(W, sub, spec_of("window", "F10k_C0"), ledger=False)
            out.append({"start": iso(a), "estar": sm["estar"]["value"]})
        w += 1
    return out


def compare_json(ck, mine, theirs, quick):
    absent = set()
    for part in ("cells", "rows"):
        for key, sm in mine[part].items():
            if sm is None:
                continue
            compare_summary(ck, key, sm, (theirs.get(part) or {}).get(key), absent)
    t = theirs.get("trades") or {}
    m = mine["trades"]
    for k in ("n", "win_all", "win_resolved", "mean_pips"):
        if k not in t:
            ck.tally("trades:summary", False, f"trades.{k}: not in money.json")
            continue
        ck.tally("trades:summary", same("units" if k == "n" else ("mean_pips" if k == "mean_pips" else k), m[k], t[k]), f"trades.{k}: money.ts {t[k]!r}, here {m[k]!r}")
    pp = t.get("per_pair")
    if isinstance(pp, dict):
        for p, v in m["per_pair"].items():
            ck.tally("trades:summary", same("units", v, pp.get(p)), f"trades.per_pair.{p}: money.ts {pp.get(p)!r}, here {v}")
    elif isinstance(pp, list):
        ck.tally("trades:summary", [int(x) for x in pp] == [m["per_pair"][p] for p in CALL9], f"trades.per_pair: money.ts {pp}, here {m['per_pair']}")
    else:
        ck.tally("trades:summary", False, "trades.per_pair: not in money.json")
    hv = t.get("halves")
    if isinstance(hv, list):
        flat = [x["n"] if isinstance(x, dict) else x for x in hv]
        ck.tally("trades:summary", [int(x) for x in flat[:2]] == m["halves"], f"trades.halves: money.ts {hv}, here {m['halves']}")
    elif isinstance(hv, dict):
        vals = [hv.get(k, {}).get("n") if isinstance(hv.get(k), dict) else hv.get(k) for k in sorted(hv)]
        ck.tally("trades:summary", sorted(int(x) for x in vals if x is not None) == sorted(m["halves"]), f"trades.halves: money.ts {hv}, here {m['halves']}")
    else:
        ck.tally("trades:summary", False, "trades.halves: not in money.json")
    for part, cls in (("kept", "kept"),):
        for key, v in mine[part].items():
            tv = (theirs.get(part) or {}).get(key)
            if not isinstance(tv, dict):
                ck.tally(cls, False, f"{part}.{key}: not in money.json")
                continue
            for k in ("mean_r_kept", "mean_r_skipped", "diff", "diff_nospread"):
                ck.tally(cls, same("r", v[k], tv.get(k)), f"{part}.{key}.{k}: money.ts {tv.get(k)!r}, here {v[k]!r}")
    if quick:
        return
    for key, v in mine["orders"].items():
        tv = (theirs.get("orders") or {}).get(key)
        if not isinstance(tv, list) or len(tv) != len(v):
            ck.tally("orders", False, f"orders.{key}: {tv!r:.80} in money.json")
            continue
        for r, (a, b) in enumerate(zip(v, tv), 1):
            ck.tally("orders", same("yen", a, b), f"orders.{key}[r={r}]: money.ts {b!r}, here {a!r}")
    for key, v in mine["thin"].items():
        tv = (theirs.get("thin") or {}).get(key)
        if not isinstance(tv, list) or len(tv) < len(v):
            ck.tally("thin", False, f"thin.{key}: {str(tv)[:80]} in money.json")
            continue
        for d, (a, b) in enumerate(zip(v, tv), 1):
            for k in ("taken", "final_equity", "mdd_yen", "worst_week_yen"):
                ck.tally("thin", same("units" if k == "taken" else "yen", a[k], (b or {}).get(k)), f"thin.{key}[d={d}].{k}: money.ts {(b or {}).get(k)!r}, here {a[k]!r}")
    tw = theirs.get("windows")
    mw = mine["windows"]
    vals = None
    if isinstance(tw, list):
        vals = [x if isinstance(x, (int, float)) else (x.get("estar") if isinstance(x.get("estar"), (int, float)) else (x.get("estar") or {}).get("value") if isinstance(x.get("estar"), dict) else x.get("value")) for x in tw]
    elif isinstance(tw, dict) and isinstance(tw.get("list") or tw.get("values"), list):
        vals = tw.get("list") or tw.get("values")
        vals = [x if isinstance(x, (int, float)) else x.get("estar", x.get("value")) for x in vals]
    if vals is None:
        print(f"  (the 52-week windows NOT compared: money.json's `windows` is {str(tw)[:80]}; here {len(mw)} windows)")
    else:
        ck.tally("windows", len(vals) == len(mw), f"windows: {len(vals)} in money.json, {len(mw)} here")
        for i, (a, b) in enumerate(zip(mw, vals)):
            ck.tally("windows", same("yen", a["estar"], b), f"windows[{i}] ({a['start']}): money.ts {b!r}, here {a['estar']!r}")
    if absent:
        print(f"  (not in money.json, so not compared: {', '.join(sorted(absent))})")


# ---- fixtures -----------------------------------------------------------------------------------


def fixture_main(args):
    """DIR/fixture.json's runs on DIR/gmo/ and DIR/signals.csv, against its expect"""
    d = args.fixture
    fx = json.load(open(os.path.join(d, "fixture.json")))
    start = ms_of(fx["start"])
    now = ms_of(fx["end"])
    pairs = [p for p in LIVE_ORDER if p in fx["pairs"]]
    ck = Checks()
    wrong = []
    sigs = ordered_sigs(load_signals(os.path.join(d, "signals.csv"), wrong))
    for w in wrong:
        ck.tally("signals", False, w)
    need_pairs = list(pairs)
    if any(not p.endswith("/JPY") for p in pairs) and "USD/JPY" not in need_pairs:
        need_pairs.append("USD/JPY")
    F, fours, _ = load_data(os.path.join(d, "gmo"), need_pairs, start, now)
    prepare(sigs, F, fours, ck, need=False, digits=fx.get("digits"))
    if args.plant in ("exitlate", "pipplus"):
        plant_trades(sigs, args.plant, F)
    sigs = [sg for sg in sigs if all(sg.tv.get(v) is not None for v in VARIANTS)]
    lo = min(F[p].t[0] for p in need_pairs if F[p].t)
    hi = max(F[p].end[-1] for p in need_pairs if F[p].t)
    taus = ny_closes(lo, hi)
    W = World(pairs, F, fours, taus)
    tvs = [sg.tv["main"] for sg in sigs if sg.group == "CALL9"]
    d_yen = sum(yen10k(W, tv) for tv in tvs) / len(tvs) if tvs else 0.0
    d_r = sum(tv.pips for tv in tvs) / len(tvs) / SL_PIPS if tvs else 0.0
    print(f"fixture {fx.get('name')}: {fx.get('what', '')}")
    planted_balance = args.plant == "balance"
    for r in fx["runs"]:
        key = r["key"]
        sizing, cap = r.get("sizing", "F10k"), r.get("cap", "C0")
        row = r.get("row") or None
        course = int(r.get("course") or 25)
        spec = Spec(key, sizing, cap, row=row, course=course, losscut=float(r.get("losscut") if r.get("losscut") is not None else 0.5), start=r.get("start_equity"), order=r.get("order"))
        cell = f"{sizing}_{cap}"
        W_, ems = told_emails(W, W, sigs, sigs, row, cell, (d_yen, d_r)) if row else (W, emails_for(W, sigs, "main"))
        rows, sm = run(W_, ems, spec)
        if planted_balance and rows:
            rows[0][6] += 1
            planted_balance = False
            print(f"planted: {key}'s first ledger balance 1 yen more")
        exp = (fx.get("expect") or {}).get(key) or {}
        before = ck.bad()
        for i, er in enumerate(exp.get("ledger") or []):
            j = int(er["seq"]) - 1 if "seq" in er else i
            if j >= len(rows):
                ck.tally("fixture:ledger", False, f"{key}: no row {j + 1} here")
                continue
            g, kind, id_, units, px, pnl, bal, eq, m, reason = rows[j]
            mine = {"g": g, "kind": kind, "id": id_, "units": units if units != "" else None, "px": px if px != "" else None, "pnl_yen": pnl if pnl != "" else None, "balance": bal, "equity": eq, "margin": m, "reason": reason}
            for c, v in er.items():
                if c == "seq":
                    continue
                ck.tally("fixture:ledger", same(c, mine.get(c), v), f"{key} row {j + 1} {c}: expect {v!r}, here {iso(mine.get(c)) if c == 'g' else fmt(mine.get(c))}")
        if "ledger" in exp:
            ck.tally("fixture:ledger", len(rows) == len(exp["ledger"]) or any("seq" in x for x in exp["ledger"]), f"{key}: {len(rows)} rows here, {len(exp['ledger'])} expected")
        for k, v in (exp.get("summary") or {}).items():
            mv = (sm or {}).get(k)
            if isinstance(v, dict) and isinstance(mv, dict):
                for kk, vv in v.items():
                    if isinstance(vv, (dict, list)):
                        continue
                    col = "units" if k == "skipped" else ("g" if kk == "g" else "yen")
                    ck.tally("fixture:summary", same(col, mv.get(kk), vv), f"{key}.{k}.{kk}: expect {vv!r}, here {mv.get(kk)!r}")
            else:
                cls = num_class(k)
                col = "units" if cls == "summary:counts" else "g" if cls == "summary:times" else "mean_pips" if cls == "summary:pips" else k
                ck.tally("fixture:summary", same(col, mv, v), f"{key}.{k}: expect {v!r}, here {mv!r}")
        print(f"  {key}: {'PASS' if ck.bad() == before else 'FAIL'}")
    ck.print()
    bad = ck.bad()
    if args.plant != "none" and args.plant in (fx.get("plants") or []):
        if bad == 0:
            print(f"PLANT {args.plant} NOT CAUGHT by fixture {fx.get('name')}")
            return 1
        print(f"plant {args.plant} caught ({bad} mismatched): as it must")
        return 0
    print("FIXTURE PASS" if bad == 0 else "FIXTURE FAIL")
    return 0 if bad == 0 else 1


if __name__ == "__main__":
    main()
