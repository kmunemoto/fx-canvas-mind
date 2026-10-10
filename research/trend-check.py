#!/usr/bin/env python3
# #250 (docs §8.106 11 Python): stage 0's labels computed again, on their own, from GMO's files.
#
# Written from the docs, not from research/trend.ts: it reads the files the run read (research/.cache,
# or the walk's folder) with its own list of keys, builds each timeframe's bars the chart's way, and
# for every row of trend-labels.csv computes the chart's Dow line at C (§8.106 1):
#
#   * C: the signal bar's close T; T + 15 minutes for a late signal. The chart's reading a minute later.
#   * the bars: GMO's bid and ask, a bar on both sides only, an ask closing under the bid left out, a bar
#     the weekend shuts for all of its length left out (barInsideClosure: Friday 22:00 to Sunday 21:00
#     UTC at both ends), the mid of the two unrounded; each bar with the key of the newest file it is in.
#   * the window: the newest bar closed by C (start + length <= C); 300 closed bars when the next bar
#     has begun by C (it is counted, not read), 301 when it has not; none from a file older than the
#     oldest the chart's walk reads (day files: the JST day of now - (span + 1) days, span the days the
#     walk may look back for 301 bars; 4-hour: last JST year's file).
#   * the state: the Dow reading of _shared/dow.ts (written again here from its comment and rules).
#   * unreadable: fewer than 300 closed bars (1), a hole of 30 minutes or more among them, or among the
#     bars that should have closed between the newest of them and C, that neither the market's hours nor
#     GMO's own closures (a stamp most of the five pairs miss) explain (2).
#
# Then the halves (§8.106 5: the follow of 1,440 5-minute bars from C inside the half), the four
# candidates' counts, the floors (§8.106 2, 6) and the whole period's counts against the run's
# counts.json. Exit 1 on any difference; a count that differs is named, never printed (§8.106 11).
#
# Stage 1 (--mode syn1 / stage1; §8.106 段1の作り 7 "Python（別に書く）"), written from the docs only, not
# from research/trend1.ts or research/trend-stats.ts: the first half's emails (the labels file's H1 rows)
# and their join to (a)'s 1-day values, E and the entry's bid and ask, the follow on 5-minute bars, the
# outcomes, the verdicts, δ with its influence-function error and the clustering's choice, t, the choice,
# the random removals' lines (mulberry32, the same seeds), the yardstick (labels one bar further) and the
# counts' reconciliation; compared with the run's result.json and emails.csv (and summary.json on a walk).
# stage1 stops before reading any bar when the labels file's or (a)'s sha256 is not the fixed one.

import argparse
import bisect
import hashlib
import json
import math
import os
import sys
import time
from datetime import datetime, timezone, timedelta
from decimal import Decimal, ROUND_HALF_UP

MIN = 60_000
HOUR = 60 * MIN
DAY = 24 * HOUR
WINDOW = 300
STEP = {"15min": 15 * MIN, "1h": HOUR, "4h": 4 * HOUR, "5min": 5 * MIN}
FILE = {"15min": "15min", "1h": "1hour", "4h": "4hour", "5min": "5min"}
PAIRS = ["USD/JPY", "EUR/JPY", "AUD/JPY", "EUR/USD", "AUD/USD"]
STATES = ["none", "up", "down", "toUp", "toDown"]
# §8.106 6: stage 0's labels, research/ledger/trend-labels.csv (run 37947773957, 9,510 rows). Stages 1 and 2
# compute nothing when the file's sha256 is another (trend.yml checks the file against it on every push)
TREND_LABELS_SHA256 = "897b76cfdf2d0acd0a7337f802efbfd095f3570aeaec8d8dec614bd5ad73b64a"
DIR = {"none": 0, "up": 1, "toUp": 1, "down": -1, "toDown": -1}


def ms_of(text):
    return int(datetime.fromisoformat(text.replace("Z", "+00:00")).timestamp() * 1000)


def utc(ms):
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc)


def iso(ms):
    return utc(ms).strftime("%Y-%m-%dT%H:%M:%S.") + f"{ms % 1000:03d}Z"


def jst_day(ms):
    return (utc(ms) + timedelta(hours=9)).strftime("%Y%m%d")


def jst_year(ms):
    return (utc(ms) + timedelta(hours=9)).year


def gmo_day(ms):
    # GMO's day file: from 21:00 UTC the day before to 21:00 UTC
    return jst_day(ms - 6 * HOUR)


def market_closed(ms):
    d = utc(ms)
    wd = d.weekday()  # Monday 0 .. Sunday 6
    if wd == 5:
        return True
    if wd == 4 and d.hour >= 22:
        return True
    if wd == 6 and d.hour < 21:
        return True
    return False


def possibly_closed(ms):
    d = utc(ms)
    wd = d.weekday()
    if wd == 5:
        return True
    if wd == 4 and d.hour >= 21:
        return True
    if wd == 6 and d.hour < 22:
        return True
    return False


def inside_closure(open_ms, step):
    if step > 47 * HOUR:
        return False
    return market_closed(open_ms) and market_closed(open_ms + step - 1)


def should_exist(s, step):
    if inside_closure(s, step):
        return False
    m = s
    while m < s + step:
        if not possibly_closed(m):
            return True
        m += 5 * MIN
    return False


# ---- the files --------------------------------------------------------------------------------

def day_keys(from_ms, to_ms):
    # every GMO day from the one holding from_ms to the JST day of to_ms
    keys = []
    d = utc(from_ms - 6 * HOUR) + timedelta(hours=9)
    d = datetime(d.year, d.month, d.day, tzinfo=timezone.utc)
    last = jst_day(to_ms)
    while True:
        k = d.strftime("%Y%m%d")
        keys.append(k)
        if k >= last:
            break
        d += timedelta(days=1)
    return keys


def year_keys(from_ms, to_ms):
    return [str(y) for y in range(int(gmo_day(from_ms)[:4]), int(gmo_day(to_ms - 1)[:4]) + 1)]


def read_rows(path, problems):
    try:
        with open(path) as f:
            body = json.load(f)
    except FileNotFoundError:
        return None
    except Exception as e:  # noqa: BLE001
        problems.append(f"{path}: {e}")
        return None
    out = []
    for r in body.get("data") or []:
        try:
            t = int(r["openTime"])
            o, h, lo, c = float(r["open"]), float(r["high"]), float(r["low"]), float(r["close"])
        except (KeyError, ValueError, TypeError):
            continue
        if all(math.isfinite(x) for x in (o, h, lo, c)):
            out.append((t, o, h, lo, c))
    out.sort(key=lambda x: x[0])
    return out


class Bars:
    def __init__(self, t, bid, ask, key):
        self.t, self.bid, self.ask, self.key = t, bid, ask, key
        self.n = len(t)
        # rows are (t, open, high, low, close): the mids of high, low and close
        self.mid = [((b[2] + a[2]) / 2, (b[3] + a[3]) / 2, (b[4] + a[4]) / 2) for b, a in zip(bid, ask)]


def load(gmo, pair, tf, from_ms, to_ms, problems, missing):
    sym = pair.replace("/", "_")
    keys = year_keys(from_ms, to_ms) if tf == "4h" else day_keys(from_ms, to_ms)
    bid, ask, key_of = [], [], {}
    for k in keys:
        b = read_rows(f"{gmo}/{sym}/{FILE[tf]}/bid/{k}.json", problems)
        a = read_rows(f"{gmo}/{sym}/{FILE[tf]}/ask/{k}.json", problems)
        if b is None or a is None:
            missing.append(f"{pair} {tf} {k}")
            continue
        for x in b:
            if x[0] not in key_of or int(k) > key_of[x[0]]:
                key_of[x[0]] = int(k)
        bid.extend(b)
        ask.extend(a)
    bid.sort(key=lambda x: x[0])
    ask.sort(key=lambda x: x[0])
    asks = {}
    for x in ask:
        asks[x[0]] = x
    step = STEP[tf]
    T, B, A, K, seen = [], [], [], [], set()
    for x in bid:
        if x[0] in seen:
            continue
        a = asks.get(x[0])
        if a is None or a[4] < x[4]:
            continue
        seen.add(x[0])
        t = x[0]
        if t < from_ms or t + step > to_ms or inside_closure(t, step):
            continue
        T.append(t)
        B.append(x)
        A.append(a)
        K.append(key_of[t])
    return Bars(T, B, A, K)


# ---- holes ---------------------------------------------------------------------------------

def closures(series, step):
    # GMO's own closures: stamps missing from at least 80% of the pairs whose data spans them (at least five)
    have = [set(b.t) for b in series if b.n]
    spans = [(b.t[0], b.t[-1]) for b in series if b.n]
    if not spans:
        return set()
    lo = min(s[0] for s in spans)
    hi = max(s[1] for s in spans)
    out = set()
    s = lo
    while s <= hi:
        cover = sum(1 for (a, b) in spans if a <= s <= b)
        miss = sum(1 for (a, b), h in zip(spans, have) if a <= s <= b and s not in h)
        if cover >= 5 and miss >= 0.8 * cover and should_exist(s, step):
            out.add(s)
        s += step
    return out


def gap_prefix(b, step, holes):
    p = [0] * (b.n + 1)
    for i in range(b.n):
        bad = 0
        if i + 1 < b.n:
            frm = b.t[i] + step
            to = b.t[i + 1]
            if to - frm >= 30 * MIN:
                missing = 0
                s = frm
                while s < to:
                    if should_exist(s, step) and s not in holes:
                        missing += step
                    s += step
                bad = 1 if missing >= 30 * MIN else 0
        p[i + 1] = p[i] + bad
    return p


# ---- the Dow reading --------------------------------------------------------------------------

def dow_state(bars, pivot=4):
    # bars: (high, low, close). Swings: a high (low) with no higher (lower) high in the `pivot` bars
    # each side (equal on the left counts as higher); two of a kind in a row keep the more extreme.
    # up: a close over the last swing high; its key the swing low before (押し安値); a close under the key
    # is the first break (toDown); the turn is confirmed by a lower high and a close under the swing low
    # before it, and called off by a close over the old leg's top. Mirrored for down.
    n = len(bars)
    sw = []  # [i, kind, price]
    state = "none"
    key = None  # [i, price]
    broken_h = broken_l = -1
    break_at = -1
    extreme = 0.0

    def last_of(kind, after=-1):
        for k in range(len(sw) - 1, -1, -1):
            if sw[k][0] <= after:
                break
            if sw[k][1] == kind:
                return sw[k]
        return None

    def add(kind, i, price):
        if sw and sw[-1][1] == kind:
            last = sw[-1]
            if (price <= last[2]) if kind == "H" else (price >= last[2]):
                return
            sw.pop()
        sw.append([i, kind, price])

    for t in range(n):
        p = t - pivot
        if p - pivot >= 0:
            is_h = is_l = True
            for k in range(p - pivot, p + pivot + 1):
                if k == p:
                    continue
                if (bars[k][0] >= bars[p][0]) if k < p else (bars[k][0] > bars[p][0]):
                    is_h = False
                if (bars[k][1] <= bars[p][1]) if k < p else (bars[k][1] < bars[p][1]):
                    is_l = False
            if is_h:
                add("H", p, bars[p][0])
            if is_l:
                add("L", p, bars[p][1])
        c = bars[t][2]
        lh = last_of("H")
        ll = last_of("L")
        if state == "none":
            if lh and c > lh[2]:
                state, broken_h = "up", lh[0]
                key = [ll[0], ll[2]] if ll else None
            elif ll and c < ll[2]:
                state, broken_l = "down", ll[0]
                key = [lh[0], lh[2]] if lh else None
        elif state == "up":
            if lh and lh[0] > broken_h and c > lh[2]:
                broken_h = lh[0]
                if ll and (key is None or ll[0] > key[0]):
                    key = [ll[0], ll[2]]
            if key and c < key[1]:
                extreme = max(bars[k][0] for k in range(key[0], t + 1))
                break_at = t
                state = "toDown"
        elif state == "down":
            if ll and ll[0] > broken_l and c < ll[2]:
                broken_l = ll[0]
                if lh and (key is None or lh[0] > key[0]):
                    key = [lh[0], lh[2]]
            if key and c > key[1]:
                extreme = min(bars[k][1] for k in range(key[0], t + 1))
                break_at = t
                state = "toUp"
        elif state == "toDown":
            low2 = last_of("L", break_at - 1)
            high2 = last_of("H", low2[0]) if low2 else None
            if c > extreme:
                state = "up"
                if lh:
                    broken_h = lh[0]
                key = [ll[0], ll[2]] if ll else key
            elif low2 and high2 and high2[2] < extreme and c < low2[2]:
                state = "down"
                broken_l = low2[0]
                key = [high2[0], high2[2]]
        elif state == "toUp":
            high2 = last_of("H", break_at - 1)
            low2 = last_of("L", high2[0]) if high2 else None
            if c < extreme:
                state = "down"
                if ll:
                    broken_l = ll[0]
                key = [lh[0], lh[2]] if lh else key
            elif high2 and low2 and low2[2] > extreme and c > high2[2]:
                state = "up"
                broken_h = high2[0]
                key = [low2[0], low2[2]]
    return state


def oldest_key(tf, now):
    if tf == "4h":
        return jst_year(now) - 1
    per_day = max(1, DAY // STEP[tf])
    open_days = math.ceil((WINDOW + 1) / per_day)
    span = math.ceil(open_days * 7 / 5) + 2
    return int(jst_day(now - (span + 1) * DAY))


def label(b, gp, tf, C, holes):
    step = STEP[tf]
    # the newest bar closed by C
    lo, hi = 0, b.n
    while lo < hi:
        m = (lo + hi) // 2
        if b.t[m] + step <= C:
            lo = m + 1
        else:
            hi = m
    i = lo - 1
    if i < 0:
        return "-", 9
    forming = i + 1 < b.n and b.t[i + 1] <= C
    ok = oldest_key(tf, C + 60_000)
    lo, hi = 0, b.n
    while lo < hi:
        m = (lo + hi) // 2
        if b.key[m] < ok:
            lo = m + 1
        else:
            hi = m
    start = max(i - (WINDOW - 1) if forming else i - WINDOW, lo, 0)
    if start > i:
        return "-", 9
    state = dow_state(b.mid[start:i + 1])
    # the bars that should have closed after the newest one by C
    trail = 0
    s = b.t[i] + step
    while s + step <= C:
        if should_exist(s, step) and s not in holes:
            trail += step
        s += step
    x = (1 if i - start + 1 < WINDOW else 0) | (2 if gp[i] - gp[start] > 0 or trail >= 30 * MIN else 0)
    return state, x


# ---- the floors -------------------------------------------------------------------------------

def floor_miss(n, k, o, u, wk, wo, kb, ks, wkb, wks):
    """§8.106 6 for one candidate in one half: the floors it misses, in the run's order and words"""
    return [m for m, short in (
        ("kept<300", k < 300), ("out<300", o < 300), ("keptWeeks<30", wk < 30), ("outWeeks<30", wo < 30),
        ("BUY<50", kb < 50), ("SELL<50", ks < 50), ("BUYWeeks<40", wkb < 40), ("SELLWeeks<40", wks < 40),
        ("unread>2%", 50 * u > n),
    ) if short]


def floors_hand():
    """hand-made counts: all at the line meet the floors; each one short (the unreadable one over) misses it alone"""
    line = dict(n=5000, k=300, o=300, u=100, wk=30, wo=30, kb=50, ks=50, wkb=40, wks=40)
    bad = [] if not floor_miss(**line) else ["hand: at the line"]
    for key, v, want in (("k", 299, "kept<300"), ("o", 299, "out<300"), ("wk", 29, "keptWeeks<30"), ("wo", 29, "outWeeks<30"),
                         ("kb", 49, "BUY<50"), ("ks", 49, "SELL<50"), ("wkb", 39, "BUYWeeks<40"), ("wks", 39, "SELLWeeks<40"),
                         ("u", 101, "unread>2%")):
        if floor_miss(**{**line, key: v}) != [want]:
            bad.append(f"hand: {key} {v}")
    return bad


# ================================================================================================
# stage 1 (§8.106 段1の作り): the first half's choice computed again, from the docs alone
# ================================================================================================

A_CSV_SHA256 = "ce4c6acee90bdef30f616b6a018ae34864d4e48d3c443dcfc7e6d27988be70c2"
A_HEADER = ["T", "pair", "side", "P", "week", "v1d"]
LABEL_HEAD = ["T", "pair", "side", "late", "C", "half", "s15", "x15", "s1h", "x1h", "s4h", "x4h"]
EMAIL_HEAD = ["T", "pair", "side", "late", "C", "half", "E", "bidC", "askC", "k4", "p4", "k10", "p10", "k16", "p16",
              "v1d", "v1", "v2", "v3", "v4", "a1", "a2", "a3", "a4"]
S1_START = ms_of("2024-01-01T00:00:00Z")
S1_SPLIT = ms_of("2025-05-19T00:00:00Z")
S1_END = ms_of("2026-10-03T00:00:00Z")
WEEK = 7 * DAY
WEEK_OFFSET = 3 * DAY + 21 * HOUR      # a week starts Sunday 21:00 UTC
FOLLOW_BARS = 1440                     # 5 trading days of 5-minute bars
SL_PIPS = 13
TPS = (4, 10, 16)
W_OF = {4: "1", 10: "2", 16: "3"}      # W1/PL1 TP4, W2/PL2 TP10 (the main one), W3/PL3 TP16 (described)
NAMES = ["①1H", "②4H", "③1H+4H", "④15M"]
SIDES = ("BUY", "SELL")
N_RANDOM = 500
RANDOM_AT = math.ceil(0.975 * N_RANDOM)    # the 488th of 500, ascending
TFS = ("15min", "1h", "4h")
NAN = float("nan")


def week_of(ms):
    return (ms - WEEK_OFFSET) // WEEK


def day_of(ms):
    # GMO's day: from 21:00 UTC
    return (ms - 21 * HOUR) // DAY


def pip_of(pair):
    return 0.01 if pair.endswith("JPY") else 0.0001


def round_chart(x, dec):
    # the chart's Number(v.toFixed(dec)): the double's exact value, rounded to dec places, a tie upwards
    return float(Decimal(x).quantize(Decimal(1).scaleb(-dec), ROUND_HALF_UP))


def sha256_of(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


# ---- Student's t (Numerical Recipes' incomplete beta, bisection) -------------------------------

def _betacf(a, b, x):
    fpmin = 1e-300
    qab, qap, qam = a + b, a + 1.0, a - 1.0
    c = 1.0
    d = 1.0 - qab * x / qap
    if abs(d) < fpmin:
        d = fpmin
    d = 1.0 / d
    h = d
    for m in range(1, 10001):
        m2 = 2 * m
        aa = m * (b - m) * x / ((qam + m2) * (a + m2))
        d = 1.0 + aa * d
        if abs(d) < fpmin:
            d = fpmin
        c = 1.0 + aa / c
        if abs(c) < fpmin:
            c = fpmin
        d = 1.0 / d
        h *= d * c
        aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2))
        d = 1.0 + aa * d
        if abs(d) < fpmin:
            d = fpmin
        c = 1.0 + aa / c
        if abs(c) < fpmin:
            c = fpmin
        d = 1.0 / d
        de = d * c
        h *= de
        if abs(de - 1.0) < 1e-16:
            break
    return h


def _betai(a, b, x):
    if x <= 0.0:
        return 0.0
    if x >= 1.0:
        return 1.0
    bt = math.exp(math.lgamma(a + b) - math.lgamma(a) - math.lgamma(b) + a * math.log(x) + b * math.log(1.0 - x))
    if x < (a + 1.0) / (a + b + 2.0):
        return bt * _betacf(a, b, x) / a
    return 1.0 - bt * _betacf(b, a, 1.0 - x) / b


_T975 = {}


def t975(df):
    """t(0.975, df): the t where the upper tail 0.5·I_x(df/2, 1/2), x = df/(df + t²), is 0.025; bisection to 1e-12"""
    if df < 1:
        return NAN
    if df not in _T975:
        def upper(t):
            return 0.5 * _betai(0.5 * df, 0.5, df / (df + t * t))
        lo, hi = 0.0, 1.0
        while upper(hi) > 0.025:
            hi *= 2.0
        while hi - lo > 1e-12:
            mid = 0.5 * (lo + hi)
            if mid <= lo or mid >= hi:
                break
            if upper(mid) > 0.025:
                lo = mid
            else:
                hi = mid
        _T975[df] = 0.5 * (lo + hi)
    return _T975[df]


# ---- mulberry32 and Fisher–Yates (§8.106 段1の作り 4) ----------------------------------------------

class Mulberry32:
    def __init__(self, seed):
        self.s = seed & 0xFFFFFFFF

    def __call__(self):
        s = (self.s + 0x6D2B79F5) & 0xFFFFFFFF
        self.s = s
        t = ((s ^ (s >> 15)) * (s | 1)) & 0xFFFFFFFF
        t ^= (t + (((t ^ (t >> 7)) * (t | 61)) & 0xFFFFFFFF)) & 0xFFFFFFFF
        return (t ^ (t >> 14)) / 4294967296.0


def shuffle(xs, rnd):
    for i in range(len(xs) - 1, 0, -1):
        j = int(rnd() * (i + 1))
        xs[i], xs[j] = xs[j], xs[i]


# ---- the emails ---------------------------------------------------------------------------------

class Email:
    __slots__ = ("Tiso", "Ciso", "T", "C", "late", "pair", "pi", "side", "dirn", "half", "lab", "s", "w", "day",
                 "E", "bidC", "askC", "res", "y", "v1d", "ver", "yard", "yardLab", "againBad")


def read_emails(path):
    with open(path) as f:
        lines = [l.rstrip("\n") for l in f if l.strip()]
    if not lines or lines[0].split(",") != LABEL_HEAD:
        return None
    out = []
    for l in lines[1:]:
        r = dict(zip(LABEL_HEAD, l.split(",")))
        e = Email()
        e.Tiso, e.Ciso = r["T"], r["C"]
        e.T = ms_of(r["T"])
        e.late = r["late"] == "1"
        e.C = e.T + (15 * MIN if e.late else 0)
        e.pair, e.side, e.half = r["pair"], r["side"], r["half"]
        e.pi = PAIRS.index(e.pair)
        e.dirn = 1 if e.side == "BUY" else -1
        e.s = e.pi * 2 + (0 if e.side == "BUY" else 1)
        e.w, e.day = week_of(e.T), day_of(e.T)
        e.lab = {"15min": (r["s15"], int(r["x15"])), "1h": (r["s1h"], int(r["x1h"])), "4h": (r["s4h"], int(r["x4h"]))}
        e.res, e.y, e.v1d, e.yard, e.yardLab, e.againBad = None, {}, None, None, None, False
        e.E = e.bidC = e.askC = None
        out.append(e)
    return out


def verdict_of(c, dirn, lab):
    """§8.106 2: 1 kept, -1 left out, 0 unreadable (③ unreadable when either label is)"""
    def ok(tf):
        return lab[tf][0] != "-" and lab[tf][1] == 0

    def against(tf):
        return DIR.get(lab[tf][0], 0) == -dirn

    if c == 0:
        return (-1 if against("1h") else 1) if ok("1h") else 0
    if c == 1:
        return (-1 if against("4h") else 1) if ok("4h") else 0
    if c == 2:
        return (-1 if against("1h") and against("4h") else 1) if ok("1h") and ok("4h") else 0
    return (-1 if against("15min") else 1) if ok("15min") else 0


def floors_from_file(emails):
    """§8.106 6 again, from the labels file's labels: each half × candidate, the floors it misses"""
    out = {}
    for h in ("H1", "H2"):
        in_h = [e for e in emails if e.half == h]
        for c, name in enumerate(NAMES):
            cnt = {}
            for side in ("all",) + SIDES:
                sel = [e for e in in_h if side == "all" or e.side == side]
                v = [verdict_of(c, e.dirn, e.lab) for e in sel]
                cnt[side] = (sum(1 for x in v if x == 1), sum(1 for x in v if x == -1), sum(1 for x in v if x == 0),
                             len({e.w for e, x in zip(sel, v) if x == 1}), len({e.w for e, x in zip(sel, v) if x == -1}))
            k, o, u, wk, wo = cnt["all"]
            kb, _, _, wkb, _ = cnt["BUY"]
            ks, _, _, wks, _ = cnt["SELL"]
            out[f"{h}|{name}"] = floor_miss(len(in_h), k, o, u, wk, wo, kb, ks, wkb, wks)
    return out


# ---- the bars of a half -------------------------------------------------------------------------

def load_half(gmo, h, problems, missing):
    """the bars a half may use: closed by its end (H1 the split, H2 END); boundary files read, later bars dropped"""
    end = S1_SPLIT if h == "H1" else S1_END
    begin = S1_START if h == "H1" else S1_SPLIT
    y0 = utc(S1_START).year
    bars = {}
    for p in PAIRS:
        bars[p] = {"5min": load(gmo, p, "5min", begin - DAY, end, problems, missing)}
        if h == "H1":
            # the labels again and one bar further: stage 0's reach (§8.106 段0の作り)
            bars[p]["15min"] = load(gmo, p, "15min", S1_START - 12 * DAY, end, problems, missing)
            bars[p]["1h"] = load(gmo, p, "1h", S1_START - 45 * DAY, end, problems, missing)
            bars[p]["4h"] = load(gmo, p, "4h", int(datetime(y0 - 1, 1, 1, tzinfo=timezone.utc).timestamp() * 1000),
                                 end, problems, missing)
        else:
            bars[p]["15min"] = load(gmo, p, "15min", begin - DAY, end, problems, missing)
    newest = max(b.t[-1] + STEP[tf] for p in PAIRS for tf, b in bars[p].items() if b.n)
    return bars, newest


def ahead_label(b, gp, tf, C, holes, now):
    """§8.106 段1の作り 5: the window when the bar after the newest one closed by C (the next in the data,
    across closures) has closed; a label unreadable at C stays unreadable"""
    if now[0] == "-" or now[1] != 0:
        return now
    step = STEP[tf]
    i = bisect.bisect_right(b.t, C - step) - 1
    j = i + 1
    if i < 0 or j >= b.n:
        return ("-", 9)
    return label(b, gp, tf, b.t[j] + step, holes)


# ---- the follow (§8.106 段1の作り 2) ----------------------------------------------------------------

class Five:
    def __init__(self, b):
        self.t = b.t
        self.bid = ([x[1] for x in b.bid], [x[2] for x in b.bid], [x[3] for x in b.bid], [x[4] for x in b.bid])
        self.ask = ([x[1] for x in b.ask], [x[2] for x in b.ask], [x[3] for x in b.ask], [x[4] for x in b.ask])


def follow(five, C, dirn, E, entry, pip, n):
    """(kind, pips) or None when fewer than 1,440 bars from C are in the data"""
    i0 = bisect.bisect_left(five.t, C)
    end = i0 + FOLLOW_BARS
    if end > len(five.t):
        return None
    O, H, L, Cl = five.bid if dirn == 1 else five.ask
    sl = E - dirn * SL_PIPS * pip
    tp = E + dirn * n * pip
    if dirn == 1:
        for k in range(i0, end):
            o = O[k]
            if o <= sl:
                return ("sl", (o - entry) / pip)
            if o >= tp:
                return ("tp", (o - entry) / pip)
            hs, ht = L[k] <= sl, H[k] >= tp
            if hs and ht:
                return ("amb", (sl - entry) / pip)
            if hs:
                return ("sl", (sl - entry) / pip)
            if ht:
                return ("tp", (tp - entry) / pip)
        return ("open", (Cl[end - 1] - entry) / pip)
    for k in range(i0, end):
        o = O[k]
        if o >= sl:
            return ("sl", (entry - o) / pip)
        if o <= tp:
            return ("tp", (entry - o) / pip)
        hs, ht = H[k] >= sl, L[k] <= tp
        if hs and ht:
            return ("amb", (entry - sl) / pip)
        if hs:
            return ("sl", (entry - sl) / pip)
        if ht:
            return ("tp", (entry - tp) / pip)
    return ("open", (entry - Cl[end - 1]) / pip)


def follow_hand():
    """hand-made 5-minute bars (§8.106 段1の作り 7 followHand), for this file's own follow"""
    bad = []

    class F:
        pass

    def mk(rows, n=FOLLOW_BARS):
        # rows: (bid o, h, l, c) for the first bars, then flat bars at the last close; ask = bid + 0.002
        f = F()
        f.t = [S1_START + k * 5 * MIN for k in range(n)]
        last = rows[-1][3]
        full = rows + [(last, last, last, last)] * (n - len(rows))
        f.bid = tuple([r[k] for r in full] for k in range(4))
        f.ask = tuple([r[k] + 0.002 for r in full] for k in range(4))
        return f

    E, pip = 150.000, 0.01
    cases = [
        ("TP first (BUY)", mk([(150.00, 150.05, 149.99, 150.04), (150.04, 150.11, 150.03, 150.10)]), 1, 10, "tp", 10 - 0.2),
        ("SL first (BUY)", mk([(150.00, 150.01, 149.86, 149.90)]), 1, 10, "sl", -13 - 0.2),
        ("both in one bar (BUY)", mk([(150.00, 150.11, 149.86, 150.00)]), 1, 10, "amb", -13 - 0.2),
        ("open past SL (BUY)", mk([(150.00, 150.01, 149.99, 150.00), (149.80, 149.81, 149.70, 149.75)]), 1, 10, "sl", -20 - 0.2),
        ("open past TP (BUY)", mk([(150.00, 150.01, 149.99, 150.00), (150.20, 150.21, 150.19, 150.20)]), 1, 10, "tp", 20 - 0.2),
        ("undecided (BUY)", mk([(150.00, 150.05, 149.95, 150.03)]), 1, 10, "open", 3 - 0.2),
        ("TP4 (BUY)", mk([(150.00, 150.04, 149.99, 150.04)]), 1, 4, "tp", 4 - 0.2),
        ("TP16 (BUY)", mk([(150.00, 150.10, 149.99, 150.05), (150.05, 150.16, 150.04, 150.15)]), 1, 16, "tp", 16 - 0.2),
        ("1,439 bars (BUY)", mk([(150.00, 150.05, 149.95, 150.03)], FOLLOW_BARS - 1), 1, 10, None, None),
    ]
    for name, f, dirn, n, kind, pips in cases:
        # a BUY enters on the ask close 150.002
        r = follow(f, S1_START, dirn, E, 150.002, pip, n)
        if kind is None:
            if r is not None:
                bad.append(name)
        elif r is None or r[0] != kind or abs(r[1] - pips) > 1e-6:
            bad.append(name)
    # a BUY exits on the bid: the ask's high 150.101 is over TP10 150.10, the bid's 150.099 is not
    r = follow(mk([(150.00, 150.099, 149.99, 150.00)]), S1_START, 1, E, 150.002, pip, 10)
    if r is None or r[0] != "open":
        bad.append("BUY on the bid")
    # a SELL exits on the ask: the ask's high 150.131 reaches the stop 150.13, the bid's 150.129 does not
    r = follow(mk([(150.00, 150.129, 149.99, 150.00)]), S1_START, -1, E, 150.000, pip, 10)
    if r is None or r[0] != "sl":
        bad.append("SELL on the ask")
    # a SELL: TP first on the ask's low, at the level
    r = follow(mk([(150.00, 150.01, 149.895, 149.95)]), S1_START, -1, E, 150.000, pip, 10)
    if r is None or r[0] != "tp" or abs(r[1] - 10) > 1e-6:
        bad.append("SELL TP")
    # the dollar pair's stop that the double misses (§8.106 段1の作り 2): E 1.16427, the bid's low 1.16297 does not reach it
    r = follow(mk([(1.16427, 1.16430, 1.16297, 1.16400)]), S1_START, 1, 1.16427, 1.16430, 0.0001, 10)
    if 1.16427 - 1 * 13 * 0.0001 != 1.1629699999999998 or r is None or r[0] != "open":
        bad.append("the dollar pair's stop")
    return bad


# ---- δ, its error and t (§8.106 段1の作り 3) ----------------------------------------------------------

def _choose(d, se_w, se_4, cw, c4, n_out):
    if c4 < 10 or cw < 2:
        by = "week"
    else:
        by = "4w" if t975(c4 - 1) * se_4 > t975(cw - 1) * se_w else "week"
    se, c = (se_w, cw) if by == "week" else (se_4, c4)
    df = c - 1
    t = d / se if c >= 2 and n_out > 0 and se > 0 else None
    tq = t975(df) if df >= 1 else NAN
    return by, se, c, df, t, d - tq * se, d + tq * se


def _se(sums):
    c = len(sums)
    if c < 2:
        return NAN
    return math.sqrt(c / (c - 1) * sum(v * v for v in sums.values()))


def delta_of(items, w0, sign=1.0):
    """items: (stratum, week, kept, y) of the compared emails with this measure. sign -1 for B30 (out − kept)"""
    nk, sk, no, so = [0] * 10, [0.0] * 10, [0] * 10, [0.0] * 10
    for s, w, k, y in items:
        if k:
            nk[s] += 1
            sk[s] += y
        else:
            no[s] += 1
            so[s] += y
    inc = [s for s in range(10) if nk[s] > 0 and no[s] > 0]
    inset = set(inc)
    dropped = sum(no[s] for s in range(10) if s not in inset)
    n_out = sum(no[s] for s in inc)
    n_all = sum(nk[s] + no[s] for s in inc)
    out = {"nOut": n_out, "nAll": n_all, "outDropped": dropped, "strata": len(inc)}
    if n_out == 0:
        out.update(d=NAN, se=NAN, seWeek=NAN, se4=NAN, C=0, CWeek=0, C4=0, by="week", df=-1, lo=NAN, hi=NAN, t=None)
        return out
    mk = [sk[s] / nk[s] if nk[s] else NAN for s in range(10)]
    mo = [so[s] / no[s] if no[s] else NAN for s in range(10)]
    d = 0.0
    for s in inc:
        d += (no[s] / n_out) * (mk[s] - mo[s])
    d *= sign
    sw, s4 = {}, {}
    for s, w, k, y in items:
        if s not in inset:
            continue
        if k:
            v = sign * (no[s] / n_out) * (y - mk[s]) / nk[s]
        else:
            v = -sign * (y - mo[s]) / n_out
        sw[w] = sw.get(w, 0.0) + v
        b = (w - w0) // 4
        s4[b] = s4.get(b, 0.0) + v
    se_w, se_4 = _se(sw), _se(s4)
    by, se, c, df, t, lo, hi = _choose(d, se_w, se_4, len(sw), len(s4), n_out)
    out.update(d=d, se=se, seWeek=se_w, se4=se_4, C=c, CWeek=len(sw), C4=len(s4), by=by, df=df, lo=lo, hi=hi, t=t)
    return out


def measures_of(e):
    y = {}
    for n in TPS:
        r = e.res[n] if e.res else None
        y["W" + W_OF[n]] = None if r is None or r[0] == "open" else (1 if r[0] == "tp" else 0)
        y["PL" + W_OF[n]] = None if r is None else r[1]
    if e.v1d is not None:
        y["V1D"] = e.v1d
        y["B30"] = 1 if e.v1d <= -30 + 1e-9 else 0
    return y


def stats_of(c, emails, ver, w0, measures, yard=None, all_emails_n=None):
    """one candidate in one half, in the run's result.json shape"""
    st = {"cand": NAMES[c]}
    counts = {}
    for side in ("all",) + SIDES:
        sel = [v for e, v in zip(emails, ver) if side == "all" or e.side == side]
        counts[side] = {"all": len(sel), "kept": sel.count(1), "out": sel.count(-1), "unread": sel.count(0)}
    st["counts"] = counts
    raw = {}
    for m in measures:
        raw[m] = {}
        for col in ("all", "kept", "out"):
            for side in ("all",) + SIDES:
                ys = [e.y[m] for e, v in zip(emails, ver)
                      if (col == "all" or (v == 1 if col == "kept" else v == -1))
                      and (side == "all" or e.side == side) and e.y.get(m) is not None]
                raw[m][f"{col}.{side}"] = {"n": len(ys), "mean": (sum(ys) / len(ys)) if ys else NAN}
    st["raw"] = raw
    delta = {}
    for m in measures:
        items = [(e.s, e.w, v == 1, e.y[m]) for e, v in zip(emails, ver) if v != 0 and e.y.get(m) is not None]
        delta[m] = delta_of(items, w0, -1.0 if m == "B30" else 1.0)
    for side in SIDES:
        items = [(e.s, e.w, v == 1, e.y["W2"]) for e, v in zip(emails, ver)
                 if v != 0 and e.side == side and e.y.get("W2") is not None]
        delta[f"W2.{side}"] = delta_of(items, w0)
    st["delta"] = delta
    dw = delta["W2"]
    f = dw["nOut"] / dw["nAll"] if dw["nAll"] else NAN
    st["keptMinusAll"] = {"d": f * dw["d"], "lo": f * dw["lo"], "hi": f * dw["hi"], "factor": f}
    # δ_W2 with strata pair × side × week (described; the point only)
    cell = {}
    out_all = 0
    for e, v in zip(emails, ver):
        if v == 0 or e.y.get("W2") is None:
            continue
        k = cell.setdefault((e.s, e.w), [0, 0.0, 0, 0.0])
        if v == 1:
            k[0] += 1
            k[1] += e.y["W2"]
        else:
            k[2] += 1
            k[3] += e.y["W2"]
            out_all += 1
    used = [k for k in (cell[x] for x in sorted(cell)) if k[0] > 0 and k[2] > 0]
    n_used = sum(k[2] for k in used)
    wd = 0.0
    for k in used:
        wd += (k[2] / n_used) * (k[1] / k[0] - k[3] / k[2])
    st["weekAdj"] = {"d": wd if n_used else NAN, "share": n_used / out_all if out_all else NAN}
    if yard is not None:
        items = [(e.s, e.w, v == 1, e.y["W2"]) for e, v in zip(emails, yard) if v != 0 and e.y.get("W2") is not None]
        st["ahead"] = delta_of(items, w0)
        st["aheadChanged"] = sum(1 for v, a in zip(ver, yard) if v != a) / len(emails) if emails else NAN
    return st


def eligible_of(st, floors_ok):
    """§8.106 段1の作り 5: the conditions a candidate misses (empty: it can be chosen)"""
    dl = st["delta"]
    miss = []
    if not floors_ok:
        miss.append("floors")
    if not dl["W2"]["d"] > 0:
        miss.append("W2")
    if not dl["W2.BUY"]["d"] > 0:
        miss.append("BUY")
    if not dl["W2.SELL"]["d"] > 0:
        miss.append("SELL")
    if not dl["PL2"]["d"] >= 0:
        miss.append("PL2")
    if dl["W2"]["t"] is None:
        miss.append("noT")
    return miss


def miss_tags(xs):
    """the run's names of the missed conditions, as this file's tags (the names are the run's; the docs fix none)"""
    out = set()
    for x in xs:
        if "floors" in x:
            out.add("floors")
        elif "PL2" in x:
            out.add("PL2")
        elif "BUY" in x:
            out.add("BUY")
        elif "SELL" in x:
            out.add("SELL")
        elif "W2" in x:
            out.add("W2")
        else:
            out.add("noT")
    return out


def triggers_of(stats):
    """§8.106 段1の作り 6 調べる合図, one per (candidate, sign, cell). The yardstick's δ is not one."""
    out = []
    for st in stats:
        raw = st["raw"]
        name = st["cand"]
        if raw["W2"]["kept.all"]["n"] and raw["W2"]["kept.all"]["mean"] >= 0.8:
            out.append(f"{name} kept W2 >= 80%")
        if raw["W1"]["kept.all"]["n"] and raw["W1"]["kept.all"]["mean"] >= 0.9:
            out.append(f"{name} kept W1 >= 90%")
        if abs(st["delta"]["W2"]["d"]) >= 0.10:
            out.append(f"{name} |δW2| >= 10 points")
        for key, x in raw["PL2"].items():
            if x["n"] and x["mean"] >= 3:
                out.append(f"{name} PL2 {key} >= +3 pips")
        for m in ("W1", "W2", "W3", "B30"):
            for key, x in raw.get(m, {}).items():
                if x["n"] and x["mean"] == 1:
                    out.append(f"{name} {m} {key} 100%")
    return out


# ---- the random removals (§8.106 段1の作り 4) --------------------------------------------------------

def random_line(emails, ver, w0, seed_base):
    comp = [(e, v) for e, v in zip(emails, ver) if v != 0]
    out_n = [0] * 10
    for e, v in comp:
        if v == -1:
            out_n[e.s] += 1
    # the decided emails' W2 by stratum and week (the δ of a removal is on them)
    tot = [dict() for _ in range(10)]
    tn, ty = [0] * 10, [0] * 10
    for e, v in comp:
        y = e.y.get("W2")
        if y is None:
            continue
        k = tot[e.s].setdefault(e.w, [0, 0])
        k[0] += 1
        k[1] += y
        tn[e.s] += 1
        ty[e.s] += y
    tot_items = [sorted(t.items()) for t in tot]

    def t_of(rem):
        # rem: (s, w) -> [decided removed, wins removed]
        rn, ry = [0] * 10, [0] * 10
        for (s, w), (a, b) in rem.items():
            rn[s] += a
            ry[s] += b
        inc = [s for s in range(10) if tn[s] - rn[s] > 0 and rn[s] > 0]
        n_out = sum(rn[s] for s in inc)
        if n_out == 0:
            return None
        d = 0.0
        sw = {}
        for s in inc:
            nk, no = tn[s] - rn[s], rn[s]
            mk, mo = (ty[s] - ry[s]) / nk, ry[s] / no
            d += (no / n_out) * (mk - mo)
            a = (no / n_out) / nk
            for w, (n, y) in tot_items[s]:
                r = rem.get((s, w))
                rn_w, ry_w = (r[0], r[1]) if r else (0, 0)
                v = a * ((y - ry_w) - (n - rn_w) * mk) - ((ry_w - rn_w * mo) / n_out)
                sw[w] = sw.get(w, 0.0) + v
        s4 = {}
        for w, v in sw.items():
            b = (w - w0) // 4
            s4[b] = s4.get(b, 0.0) + v
        by, se, c, df, t, lo, hi = _choose(d, _se(sw), _se(s4), len(sw), len(s4), n_out)
        return t

    # this summed form against delta_of (one email at a time) on the candidate's own split
    own = {}
    for e, v in comp:
        if v == -1 and e.y.get("W2") is not None:
            x = own.setdefault((e.s, e.w), [0, 0])
            x[0] += 1
            x[1] += e.y["W2"]
    self_ok = close(t_of(own), delta_of([(e.s, e.w, v == 1, e.y["W2"]) for e, v in comp
                                         if e.y.get("W2") is not None], w0)["t"])

    kinds, ts_all = [], []
    no_se = missed = 0
    for kind in (1, 2, 3, 4):
        rnd = Mulberry32(seed_base + kind)
        by_day = kind in (1, 3)
        cells = {}
        for e, v in comp:
            cells.setdefault((e.s, e.day if by_day else e.w), []).append(e)
        agg = {}
        for key, lst in cells.items():
            lst.sort(key=lambda e: (e.T, e.late))
            a = {}
            for e in lst:
                y = e.y.get("W2")
                if y is not None:
                    x = a.setdefault(e.w, [0, 0])
                    x[0] += 1
                    x[1] += y
            agg[key] = a
        if kind in (1, 2):
            orders = [sorted({g for (s, g) in cells if s == s0}) for s0 in range(10)]
        else:
            orders = [sorted({g for (s, g) in cells if s % 2 == side}) for side in (0, 1)]
        ts = []
        for _ in range(N_RANDOM):
            rem = {}
            got = [0] * 10

            def take(s, order):
                left = out_n[s]
                for g in order:
                    if left == 0:
                        return
                    lst = cells.get((s, g))
                    if not lst:
                        continue
                    if len(lst) <= left:
                        for w, (a, b) in agg[(s, g)].items():
                            x = rem.setdefault((s, w), [0, 0])
                            x[0] += a
                            x[1] += b
                        left -= len(lst)
                        got[s] += len(lst)
                    else:
                        perm = lst[:]
                        shuffle(perm, rnd)
                        for e in perm[:left]:
                            y = e.y.get("W2")
                            if y is not None:
                                x = rem.setdefault((s, e.w), [0, 0])
                                x[0] += 1
                                x[1] += y
                        got[s] += left
                        return

            if kind in (1, 2):
                for s in range(10):
                    order = orders[s][:]
                    shuffle(order, rnd)
                    take(s, order)
            else:
                for side in (0, 1):
                    order = orders[side][:]
                    shuffle(order, rnd)
                    for p in range(5):
                        take(p * 2 + side, order)
            if got != out_n:
                missed += 1
            t = t_of(rem)
            if t is None:
                no_se += 1
                t = -math.inf
            ts.append(t)
        ts.sort()
        kinds.append(ts[RANDOM_AT - 1])
        ts_all.append(ts)
    return {"kinds": kinds, "line": max(kinds), "noSe": no_se, "missed": missed, "ts": ts_all, "selfOk": self_ok}


# ---- comparing ------------------------------------------------------------------------------------

def num_of(v):
    if v is None:
        return None
    if isinstance(v, bool):
        return float(v)
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, str):
        try:
            return float(v.replace("Infinity", "inf"))
        except ValueError:
            return v
    return v


def close(a, b):
    a, b = num_of(a), num_of(b)
    a_none = a is None or (isinstance(a, float) and math.isnan(a))
    b_none = b is None or (isinstance(b, float) and math.isnan(b))
    if a_none or b_none:
        return a_none and b_none
    if not isinstance(a, float) or not isinstance(b, float):
        return a == b
    if math.isinf(a) or math.isinf(b):
        return a == b
    return abs(a - b) <= 1e-9


class Cmp:
    """items compared; a differing value is printed only with --verbose (never in stage1)"""

    def __init__(self, verbose):
        self.verbose = verbose
        self.items = {}

    def rec(self, item, ok, where, mine=None, theirs=None):
        r = self.items.setdefault(item, [0, []])
        r[0] += 1
        if not ok:
            r[1].append(f"{where}: here {mine!r}, run {theirs!r}" if self.verbose else where)

    def num(self, item, where, mine, theirs):
        self.rec(item, close(mine, theirs), where, mine, theirs)

    def eq(self, item, where, mine, theirs):
        self.rec(item, mine == theirs, where, mine, theirs)

    def tree(self, item, where, mine, theirs):
        if isinstance(mine, dict):
            if not isinstance(theirs, dict):
                self.rec(item, False, f"{where} (not an object in the run)")
                return
            for k, v in mine.items():
                if k not in theirs:
                    self.rec(item, False, f"{where}.{k} (not in the run)")
                else:
                    self.tree(item, f"{where}.{k}", v, theirs[k])
            for k in theirs:
                if k not in mine:
                    self.rec(item, False, f"{where}.{k} (only in the run)")
        elif isinstance(mine, list):
            if not isinstance(theirs, list) or len(theirs) != len(mine):
                self.rec(item, False, f"{where} (length)")
                return
            for i, (a, b) in enumerate(zip(mine, theirs)):
                self.tree(item, f"{where}[{i}]", a, b)
        elif isinstance(mine, bool):
            self.eq(item, where, mine, theirs)
        elif isinstance(mine, str):
            self.eq(item, where, mine, theirs)
        else:
            self.num(item, where, mine, theirs)

    def report(self):
        ok = True
        for name, (n, bad) in self.items.items():
            if bad:
                ok = False
                print(f"DIFFER {name}: {len(bad)} of {n} differ")
                for b in bad[:8]:
                    print(f"         {b}")
            else:
                print(f"same   {name}: {n} compared")
        return ok


def read_ts_emails(path):
    with open(path) as f:
        lines = [l.rstrip("\n") for l in f if l.strip()]
    head = lines[0].split(",")
    return head, [dict(zip(head, l.split(","))) for l in lines[1:]]


def fmt_num(x):
    return "" if x is None else x


# ---- the run of stage 1 ------------------------------------------------------------------------

def main1(a):
    t_start = time.time()
    stage1 = a.mode == "stage1"
    verbose = a.verbose and not stage1
    seed = 0 if stage1 else a.seed

    def say(text):
        print(text, flush=True)

    # stop before reading anything else when a file is not the fixed one (§8.106 段1の作り, 走る前の止まり方)
    if stage1:
        if sha256_of(a.labels) != TREND_LABELS_SHA256:
            say("DIFFER labelsFile: the labels file's sha256 is not TREND_LABELS_SHA256; nothing computed")
            say("PYTHON CHECK FAILED")
            sys.exit(1)
        if not a.a_csv or sha256_of(a.a_csv) != A_CSV_SHA256:
            say("DIFFER aFile: (a)'s sha256 is not the fixed one; nothing computed")
            say("PYTHON CHECK FAILED")
            sys.exit(1)
        say("same   labelsFile, aFile (sha256)")
    C = Cmp(verbose)
    emails = read_emails(a.labels)
    if emails is None:
        say("DIFFER the labels file's header")
        say("PYTHON CHECK FAILED")
        sys.exit(1)
    with open(os.path.join(a.ts, "result.json")) as f:
        R = json.load(f)
    ts_head, ts_rows = read_ts_emails(os.path.join(a.ts, "emails.csv"))
    C.eq("result.mode", "mode", "stage1" if stage1 else "syn", R.get("mode"))
    if not stage1:
        C.eq("result.seed", "seed", seed, R.get("seed"))
    C.eq("result.labelsSha256", "labelsSha256", sha256_of(a.labels), R.get("labelsSha256"))
    C.eq("emails.csv header", "header", EMAIL_HEAD, ts_head)
    if R.get("plant"):
        say(f"note: the run planted an error ({R.get('plant')}); it should be found")
    for e in emails:
        C.eq("labels file: C", f"{e.Tiso} {e.pair} {e.side}", iso(e.C), e.Ciso)
    say(f"labels file: {len(emails)} rows; H1 {sum(1 for e in emails if e.half == 'H1')}"
        + ("" if stage1 else f", H2 {sum(1 for e in emails if e.half == 'H2')}"))

    # §8.106 6 again from the file
    floors = floors_from_file(emails)
    C.tree("floors", "floors", floors, R.get("floors"))
    floors_ok = [all(not floors[f"{h}|{n}"] for h in ("H1", "H2")) for n in NAMES]

    # (a)'s 1-day values (stage1): every H1 email joins exactly one row, whose P + 24 hours is by the split
    a_rows = {}
    if stage1:
        with open(a.a_csv) as f:
            alines = [l.rstrip("\n") for l in f if l.strip()]
        if alines[0].split(",") != A_HEADER:
            say("DIFFER aFile: header")
            say("PYTHON CHECK FAILED")
            sys.exit(1)
        for l in alines[1:]:
            c = l.split(",")
            a_rows.setdefault((ms_of(c[0]), c[1], c[2]), []).append((ms_of(c[3]), float(c[5])))

    problems, missing = [], []
    halves = ["H1"] if stage1 else ["H1", "H2"]
    mine_rows = []
    results = {}
    for h in halves:
        t0 = time.time()
        w0 = week_of(S1_START if h == "H1" else S1_SPLIT)
        end = S1_SPLIT if h == "H1" else S1_END
        em = [e for e in emails if e.half == h]
        bars, newest = load_half(a.gmo, h, problems, missing)
        C.rec(f"{h}: bars used closed by the half's end", newest <= end, f"{h} newest bar")
        say(f"{h}: {len(em)} emails; bars read ({time.time() - t0:.0f}s)")

        # labels again and one bar further (H1)
        if h == "H1":
            holes = {tf: closures([bars[p][tf] for p in PAIRS], STEP[tf]) for tf in TFS}
            gps = {p: {tf: gap_prefix(bars[p][tf], STEP[tf], holes[tf]) for tf in TFS} for p in PAIRS}
            for e in em:
                yl = {}
                for tf in TFS:
                    b, gp = bars[e.pair][tf], gps[e.pair][tf]
                    now = label(b, gp, tf, e.C, holes[tf])
                    C.eq("H1 labelsAgain", f"{e.Tiso} {e.pair} {e.side} {tf}", now, e.lab[tf])
                    yl[tf] = ahead_label(b, gp, tf, e.C, holes[tf], now)
                e.yardLab = yl
            say(f"{h}: labels again and one bar further ({time.time() - t0:.0f}s)")

        # E and the entry's bid and ask (the 15-minute bars), then the follow (5-minute bars)
        five = {p: Five(bars[p]["5min"]) for p in PAIRS}
        idx15 = {p: {t: k for k, t in enumerate(bars[p]["15min"].t)} for p in PAIRS}
        for e in em:
            b15 = bars[e.pair]["15min"]
            k = idx15[e.pair].get(e.T - 15 * MIN)
            ks = idx15[e.pair].get(e.T) if e.late else k
            C.rec(f"{h}: the signal bar in the 15-minute bars", k is not None and ks is not None, f"{e.Tiso} {e.pair}")
            if k is None or ks is None:
                e.res = None
                e.y = measures_of(e)
                continue
            dec = 3 if e.pair.endswith("JPY") else 5
            e.E = round_chart((b15.bid[k][4] + b15.ask[k][4]) / 2, dec)
            e.bidC, e.askC = b15.bid[ks][4], b15.ask[ks][4]
            entry = e.askC if e.dirn == 1 else e.bidC
            pip = pip_of(e.pair)
            e.res = {n: follow(five[e.pair], e.C, e.dirn, e.E, entry, pip, n) for n in TPS}
            if stage1:
                got = a_rows.get((e.T, e.pair, e.side), [])
                C.rec("aFile: one row per H1 email", len(got) == 1, f"{e.Tiso} {e.pair} {e.side}")
                if len(got) == 1:
                    C.rec("aFile: P + 24 hours by the split", got[0][0] + DAY <= S1_SPLIT, f"{e.Tiso} {e.pair} {e.side}")
                    e.v1d = got[0][1]
            e.y = measures_of(e)
        short = sum(1 for e in em if e.res is None or any(e.res[n] is None for n in TPS))
        C.rec(f"{h}: every email followed for 1,440 bars inside the bars read", short == 0,
              f"{h}: {short} not followed" if verbose else f"{h}: some not followed")
        say(f"{h}: followed ({time.time() - t0:.0f}s)")

        # the verdicts, the yardstick's, the statistics
        measures = ["W2", "PL2", "W1", "PL1", "W3", "PL3"] + (["V1D", "B30"] if stage1 else [])
        stats = []
        for e in em:
            e.ver = [verdict_of(c, e.dirn, e.lab) for c in range(4)]
            e.yard = [verdict_of(c, e.dirn, e.yardLab) for c in range(4)] if h == "H1" else None
        for c in range(4):
            ver = [e.ver[c] for e in em]
            yard = [e.yard[c] for e in em] if h == "H1" else None
            st = stats_of(c, em, ver, w0, measures, yard)
            miss = eligible_of(st, floors_ok[c])
            st["eligible"] = not miss
            st["misses"] = miss
            stats.append(st)
            # the counts' reconciliation (§8.106 11 数字の後)
            cn = st["counts"]
            for side in ("all",) + SIDES:
                x = cn[side]
                C.rec(f"{h}: counts reconcile", x["all"] == x["kept"] + x["out"] + x["unread"], f"{NAMES[c]} {side}")
            for n in TPS:
                dec_n = sum(1 for e in em if e.res and e.res[n] and e.res[n][0] != "open")
                und = sum(1 for e in em if e.res and e.res[n] and e.res[n][0] == "open")
                C.rec(f"{h}: counts reconcile", dec_n + und == len(em), f"TP{n} decided + undecided")
        chosen = -1
        if h == "H1":
            best = None
            for c, st in enumerate(stats):
                if not st["eligible"]:
                    continue
                key = (st["delta"]["W2"]["t"], st["counts"]["all"]["kept"], -c)
                if best is None or key > best[0]:
                    best = (key, c)
            chosen = best[1] if best else -1
        # the random lines: on a walk every candidate's, in stage1 the chosen one's
        lines = []
        for c in range(4):
            if stage1 and c != chosen:
                lines.append(None)
                continue
            base = 250_000 + 10_000 * seed + 1_000 * (1 if h == "H1" else 2) + 100 * (c + 1)
            ln = random_line(em, [e.ver[c] for e in em], w0, base)
            C.rec("this file's removal δ against its δ (the candidate's own split)", ln["selfOk"], f"{h} {NAMES[c]}")
            lines.append(ln)
        say(f"{h}: random lines ({time.time() - t0:.0f}s)")
        trig = triggers_of(stats)
        results[h] = {"stats": stats, "chosen": chosen, "lines": lines, "triggers": trig}

        # compare with the run
        RH = R.get(h) or {}
        for c, st in enumerate(stats):
            ts_st = (RH.get("stats") or [None] * 4)[c] or {}
            for key in ("cand", "counts", "raw", "delta", "keptMinusAll", "weekAdj") + (("ahead", "aheadChanged") if h == "H1" else ()):
                C.tree(f"{h}.stats.{key}", f"{st['cand']} {key}", st[key], ts_st.get(key))
            C.eq(f"{h}.stats.eligible", f"{st['cand']} eligible", st["eligible"], ts_st.get("eligible"))
            C.eq(f"{h}.stats.misses", f"{st['cand']} misses", set(st["misses"]), miss_tags(ts_st.get("misses") or []))
        if h == "H1":
            C.eq("H1.chosen", "chosen", chosen, RH.get("chosen"))
            C.num("H1.line", "line", lines[chosen]["line"] if chosen >= 0 else None, RH.get("line"))
        ts_lines = RH.get("lines") or [None] * 4
        for c, ln in enumerate(lines):
            tl = ts_lines[c] if c < len(ts_lines) else None
            if ln is None:
                C.rec(f"{h}.lines", tl is None, f"{NAMES[c]} (none here)")
                continue
            if tl is None:
                C.rec(f"{h}.lines", False, f"{NAMES[c]} (none in the run)")
                continue
            for key in ("kinds", "line", "noSe", "missed"):
                C.tree(f"{h}.lines", f"{NAMES[c]} {key}", ln[key], tl.get(key))
            C.tree(f"{h}.lines.ts (4 × 500 t's, ascending)", f"{NAMES[c]} ts", ln["ts"], tl.get("ts"))
        C.eq(f"{h}.triggers (count)", "triggers", len(trig), len(RH.get("triggers") or []))

        for e in em:
            row = {"T": e.Tiso, "pair": e.pair, "side": e.side, "late": "1" if e.late else "0", "C": iso(e.C),
                   "half": h, "E": e.E, "bidC": e.bidC, "askC": e.askC}
            for n in TPS:
                r = e.res[n] if e.res else None
                row[f"k{n}"] = r[0] if r else ""
                row[f"p{n}"] = r[1] if r else None
            row["v1d"] = e.v1d
            for c in range(4):
                row[f"v{c + 1}"] = e.ver[c]
                row[f"a{c + 1}"] = e.yard[c] if e.yard is not None else None
            mine_rows.append(row)
        say(f"{h}: compared ({time.time() - t0:.0f}s)")

    # emails.csv: the rows, in order, and every column
    keys_mine = [(r["T"], r["pair"], r["side"]) for r in mine_rows]
    keys_ts = [(r.get("T"), r.get("pair"), r.get("side")) for r in ts_rows]
    C.rec("emails.csv rows (the half's rows of the labels file, in order)", keys_mine == keys_ts,
          "the number of rows" if len(keys_mine) != len(keys_ts) else "the order or the keys")
    by_key = {k: r for k, r in zip(keys_ts, ts_rows)}
    for r in mine_rows:
        t = by_key.get((r["T"], r["pair"], r["side"]))
        where = f"{r['T']} {r['pair']} {r['side']}"
        if t is None:
            C.rec("emails.csv rows (the half's rows of the labels file, in order)", False, where + " (not in the run)")
            continue
        for col in ("late", "C", "half", "k4", "k10", "k16"):
            C.eq(f"emails.csv {col}", where, r[col], t.get(col))
        for col in ("E", "bidC", "askC", "p4", "p10", "p16", "v1d"):
            mine, theirs = r[col], t.get(col)
            if mine is None or theirs in (None, ""):
                C.rec(f"emails.csv {col}", mine is None and theirs in (None, ""), where, mine, theirs)
            else:
                C.num(f"emails.csv {col}", where, mine, theirs)
        for col in ("v1", "v2", "v3", "v4", "a1", "a2", "a3", "a4"):
            mine, theirs = r[col], t.get(col)
            C.eq(f"emails.csv {col}", where, "" if mine is None else str(mine), theirs)

    # a walk: stage 2's sentence for every candidate as if chosen (§8.106 8; summary.json)
    if not stage1 and os.path.exists(os.path.join(a.ts, "summary.json")):
        with open(os.path.join(a.ts, "summary.json")) as f:
            S = json.load(f)
        C.eq("summary.H1chosen", "H1chosen", results["H1"]["chosen"], S.get("H1chosen"))
        failed = bool(S.get("failed"))
        h1, h2 = results["H1"], results["H2"]
        for c in range(4):
            st, ln = h2["stats"][c], h2["lines"][c]
            dw, rw = st["delta"]["W2"], st["raw"]
            c1 = dw["t"] is not None and dw["t"] > ln["line"] and rw["W2"]["kept.all"]["mean"] > rw["W2"]["all.all"]["mean"]
            c2 = (st["delta"]["PL2"]["d"] >= 0 and rw["PL2"]["kept.all"]["mean"] >= rw["PL2"]["all.all"]["mean"]
                  and rw["W1"]["kept.all"]["mean"] >= rw["W1"]["all.all"]["mean"]
                  and rw["PL1"]["kept.all"]["mean"] >= rw["PL1"]["all.all"]["mean"])
            c3 = True   # a walk has no 1-day values: counted as met (§8.106 段1の作り 8)
            c4 = st["delta"]["W2.BUY"]["d"] > 0 and st["delta"]["W2.SELL"]["d"] > 0
            c5 = not failed and not [x for x in h2["triggers"] if x.startswith(NAMES[c] + " ")]
            if c1 and c2 and c3 and c4 and c5:
                sentence = "adopt"
            elif dw["hi"] < 0:
                sentence = "bad"
            elif c1 and not (c2 and c3 and c4):
                sentence = "partly"
            else:
                sentence = "cannot"
            h1_ok = h1["stats"][c]["eligible"]
            mine = {"cand": NAMES[c], "d": dw["d"], "lo": dw["lo"], "hi": dw["hi"], "t": dw["t"], "line": ln["line"],
                    "h1Eligible": h1_ok, "floors": floors_ok[c], "c1": c1, "c2": c2, "c3": c3, "c4": c4, "c5": c5,
                    "sentence": sentence, "adopt": floors_ok[c] and h1_ok and sentence == "adopt",
                    "rawBuy": {"kept": rw["W2"]["kept.BUY"]["mean"], "out": rw["W2"]["out.BUY"]["mean"]},
                    "rawSell": {"kept": rw["W2"]["kept.SELL"]["mean"], "out": rw["W2"]["out.SELL"]["mean"]}}
            theirs = (S.get("H2") or [None] * 4)[c] or {}
            C.tree("summary.H2 (stage 2 as if chosen)", NAMES[c], mine, theirs)

    # a missing day file whose whole span the weekend closes (a Sunday key: Saturday 21:00 to Sunday 21:00 UTC)
    # cannot hide a bar; any other missing file, or one that failed to read, fails the run
    lost = [m for m in missing if not (len(m.split()[-1]) == 8 and datetime.strptime(m.split()[-1], "%Y%m%d").weekday() == 6)]
    C.rec("GMO files read without a failure", not problems and not lost,
          f"problems {len(problems)}, files missing {len(lost)}" if verbose else "read failures or missing files")
    C.rec("this file's own follow on hand-made bars", not follow_hand(), ", ".join(follow_hand()))
    r = Mulberry32(251_101)
    first3 = [r(), r(), r()]
    C.rec("this file's mulberry32 (seed 251,101)", all(abs(x - y) < 1e-15 for x, y in zip(
        first3, (0.639131162315607, 0.965791508089751, 0.727509640622884))), "the first three")
    C.rec("this file's t(0.975)", all(abs(t975(df) - v) < 5e-8 for df, v in (
        (1, 12.7062047), (9, 2.2621572), (17, 2.1098156), (71, 1.9939434))), "1, 9, 17, 71")
    say("")
    ok = C.report()
    if verbose:
        for h in halves:
            st = results[h]
            say(f"{h}: chosen {st['chosen']}; triggers {st['triggers']}")
    say(f"time {time.time() - t_start:.0f}s")
    say("PYTHON CHECK " + ("OK" if ok else "FAILED"))
    sys.exit(0 if ok else 1)


# ---- the run ----------------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--gmo", required=True)
    ap.add_argument("--labels", required=True)
    ap.add_argument("--counts", help="stage0 / syn: the run's counts.json")
    ap.add_argument("--mode", choices=["stage0", "syn", "stage1", "syn1"], required=True)
    ap.add_argument("--label-end", default="2026-10-09T12:00:00Z")
    ap.add_argument("--ts", help="stage1 / syn1: the run's folder (result.json, emails.csv)")
    ap.add_argument("--a-csv", help="stage1: (a)'s research/ledger/ultra15-a.csv")
    ap.add_argument("--seed", type=int, default=0, help="syn1: the walk's seed")
    ap.add_argument("--verbose", action="store_true", help="syn1: print the differing values")
    a = ap.parse_args()
    if a.mode in ("stage1", "syn1"):
        if not a.ts:
            ap.error("--ts is required with --mode stage1 / syn1")
        if a.mode == "stage1" and not a.a_csv:
            ap.error("--a-csv is required with --mode stage1")
        main1(a)
        return
    if not a.counts:
        ap.error("--counts is required with --mode stage0 / syn")
    if a.mode == "syn":
        start, end, label_end = ms_of("2024-10-01T00:00:00Z"), ms_of("2025-07-26T00:00:00Z"), None
        label_end = end + 7 * DAY
    else:
        start, end, label_end = ms_of("2024-01-01T00:00:00Z"), ms_of("2026-10-03T00:00:00Z"), ms_of(a.label_end)
    split = ms_of("2025-05-19T00:00:00Z")
    y0 = utc(start).year
    frm = {
        "15min": start - 12 * DAY,
        "1h": start - 45 * DAY,
        "4h": start - 90 * DAY if a.mode == "syn" else int(datetime(y0 - 1, 1, 1, tzinfo=timezone.utc).timestamp() * 1000),
    }
    problems, missing = [], []
    bars = {p: {tf: load(a.gmo, p, tf, frm[tf], label_end, problems, missing) for tf in ("15min", "1h", "4h")} for p in PAIRS}
    holes = {tf: closures([bars[p][tf] for p in PAIRS], STEP[tf]) for tf in ("15min", "1h", "4h")}
    gps = {p: {tf: gap_prefix(bars[p][tf], STEP[tf], holes[tf]) for tf in ("15min", "1h", "4h")} for p in PAIRS}
    print(f"read: {', '.join(f'{p} ' + '/'.join(str(bars[p][tf].n) for tf in ('15min', '1h', '4h')) for p in PAIRS)}; files missing {len(missing)}; problems {len(problems)}")
    for m in missing[:5]:
        print(f"  missing {m}")
    print(f"GMO's own closures: {', '.join(f'{tf} {len(holes[tf])}' for tf in holes)}")

    with open(a.labels) as f:
        lines = [l.rstrip("\n") for l in f if l.strip()]
    head = lines[0].split(",")
    want_head = ["T", "pair", "side", "late", "C", "half", "s15", "x15", "s1h", "x1h", "s4h", "x4h"]
    bad = []
    if head != want_head:
        print(f"header {head}, not {want_head}")
        sys.exit(1)
    rows = []
    for l in lines[1:]:
        c = l.split(",")
        r = dict(zip(head, c))
        T = ms_of(r["T"])
        C = T + (15 * MIN if r["late"] == "1" else 0)
        if ms_of(r["C"]) != C:
            bad.append(f"{r['T']} {r['pair']} {r['side']}: C {r['C']}, not {iso(C)}")
        mine = {}
        for tf, s_col, x_col in (("15min", "s15", "x15"), ("1h", "s1h", "x1h"), ("4h", "s4h", "x4h")):
            st, x = label(bars[r["pair"]][tf], gps[r["pair"]][tf], tf, C, holes[tf])
            mine[tf] = (st, x)
            if st != r[s_col] or str(x) != r[x_col]:
                bad.append(f"{r['T']} {r['pair']} {r['side']} {tf}: run {r[s_col]}/{r[x_col]}, here {st}/{x}")
        rows.append((r, T, C, mine))
    print(f"labels: {len(rows)} rows x 3 timeframes, {len(bad)} different")
    for b in bad[:10]:
        print(f"  {b}")

    # the halves: the 1,440th 5-minute bar from C closed by the split (or END), near the edges
    edge = 21 * DAY
    half_bad = []
    my_half = {}
    longest = 0
    for p in PAIRS:
        t5 = []
        for lo_, hi_ in ((split - edge, split + 14 * DAY), (end - edge, end)):
            t5.extend(load(a.gmo, p, "5min", lo_, hi_, problems, missing).t)
        t5.sort()

        def end_of(T, limit):
            lo, hi = 0, len(t5)
            while lo < hi:
                m = (lo + hi) // 2
                if t5[m] < T:
                    lo = m + 1
                else:
                    hi = m
            j = lo + 1439
            if j >= len(t5) or t5[j] + 5 * MIN > limit:
                return None
            return t5[j] + 5 * MIN

        for r, T, C, _ in rows:
            if r["pair"] != p:
                continue
            if T < split:
                if T < split - edge:
                    h = "H1"
                else:
                    e = end_of(C, split)
                    if e:
                        longest = max(longest, e - T)
                    h = "H1" if e is not None and e <= split else "-"
            elif T < end - edge:
                h = "H2"
            else:
                e = end_of(C, end)
                if e:
                    longest = max(longest, e - T)
                h = "H2" if e is not None and e <= end else "-"
            my_half[id(r)] = h
            if h != r["half"]:
                half_bad.append(f"{r['T']} {p} {r['side']}: run {r['half']}, here {h}")
    print(f"halves: {len(half_bad)} different; the longest follow near an edge {longest / DAY:.2f} days; files missing {len(missing)} (with the 5-minute ones)")
    for b in half_bad[:10]:
        print(f"  {b}")

    # the four candidates (§8.106 2) and the counts (§8.106 6), from the labels computed here
    def verdict(c, side, mine):
        sd = 1 if side == "BUY" else -1

        def ok(tf):
            return mine[tf][0] != "-" and mine[tf][1] == 0

        def against(tf):
            return DIR[mine[tf][0]] == -sd

        if c == 0:
            return (-1 if against("1h") else 1) if ok("1h") else 0
        if c == 1:
            return (-1 if against("4h") else 1) if ok("4h") else 0
        if c == 2:
            return (-1 if against("1h") and against("4h") else 1) if ok("1h") and ok("4h") else 0
        return (-1 if against("15min") else 1) if ok("15min") else 0

    def week(ms):
        return (ms - (3 * DAY + 21 * HOUR)) // (7 * DAY)

    names = ["①1H", "②4H", "③1H+4H", "④15M"]
    mine_counts = {}
    for h in ("H1", "H2"):
        # the halves computed here, not the run's
        in_h = [(r, T, mine) for r, T, C, mine in rows if my_half[id(r)] == h]
        for c, name in enumerate(names):
            v = [verdict(c, r["side"], mine) for r, T, mine in in_h]
            for side in ("all", "BUY", "SELL"):
                sel = [(x, T) for (r, T, mine), x in zip(in_h, v) if side == "all" or r["side"] == side]
                mine_counts[(h, name, side)] = (
                    sum(1 for x, _ in sel if x == 1),
                    sum(1 for x, _ in sel if x == -1),
                    sum(1 for x, _ in sel if x == 0),
                    len({week(T) for x, T in sel if x == 1}),
                    len({week(T) for x, T in sel if x == -1}),
                )
    # (a count that differs is named, not printed: §8.106 11, no number leaves a run that failed)
    fields = ("kept", "out", "unread", "weeksKept", "weeksOut")
    with open(a.counts) as f:
        theirs = json.load(f)
    count_bad = []
    for c in theirs["counts"]:
        k = (c["half"], c["cand"], c["side"])
        got = mine_counts.get(k)
        want = tuple(c[x] for x in fields)
        if got is None:
            count_bad.append(f"{k}: not counted here")
        elif got != want:
            count_bad.append(f"{k}: {', '.join(x for x, g, w in zip(fields, got, want) if g != w)} differ")
    if len(theirs["counts"]) != len(mine_counts):
        count_bad.append("the number of counts differs")
    print(f"counts: {len(theirs['counts'])} compared, {len(count_bad)} different")
    for b in count_bad[:10]:
        print(f"  {b}")

    # the floors (§8.106 6), from the counts here: in a half, kept and left out 300 or more each, over 30
    # weeks or more each; BUY and SELL each kept 50 or more over 40 weeks or more; unreadable 2% or less.
    # First on hand-made counts (the walk never meets them: its second half is 10 weeks)
    floor_bad = floors_hand()
    for h in ("H1", "H2"):
        n_h = sum(1 for r, T, C, mine in rows if my_half[id(r)] == h)
        for name in names:
            k, o, u, wk, wo = mine_counts[(h, name, "all")]
            kb, _, _, wkb, _ = mine_counts[(h, name, "BUY")]
            ks, _, _, wks, _ = mine_counts[(h, name, "SELL")]
            miss = floor_miss(n_h, k, o, u, wk, wo, kb, ks, wkb, wks)
            if theirs["floors"].get(f"{h}|{name}") is not (not miss) or theirs.get("misses", {}).get(f"{h}|{name}") != miss:
                floor_bad.append(f"{h} {name}")
    if len(theirs["floors"]) != 2 * len(names) or len(theirs.get("misses", {})) != 2 * len(names):
        floor_bad.append("the number of floors differs")
    # the weeks the run divides by (§8.106 12 の2): each half's length, and the whole's
    my_weeks = {"all": (end - start) / (7 * DAY), "H1": (split - start) / (7 * DAY), "H2": (end - split) / (7 * DAY)}
    for k, w in my_weeks.items():
        got = theirs.get("weeks", {}).get(k)
        if not isinstance(got, (int, float)) or abs(got - w) > 1e-9:
            floor_bad.append(f"weeks {k}")
    print(f"floors: {2 * len(names)} compared, and the weeks; {len(floor_bad)} different{': ' + ', '.join(floor_bad) if floor_bad else ''}")

    # the whole of (a), both halves and the edges (§8.106 12 の2)
    whole_bad = []
    theirs_whole = {w["cand"]: (w["kept"], w["out"], w["unread"]) for w in theirs.get("whole", [])}
    for c, name in enumerate(names):
        v = [verdict(c, r["side"], mine) for r, T, C, mine in rows]
        if theirs_whole.get(name) != (v.count(1), v.count(-1), v.count(0)):
            whole_bad.append(name)
    print(f"whole period: {len(names)} compared, {len(whole_bad)} different{': ' + ', '.join(whole_bad) if whole_bad else ''}")
    ok = not bad and not half_bad and not count_bad and not floor_bad and not whole_bad and not problems and not missing
    print("PYTHON CHECK", "OK" if ok else "FAILED")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
