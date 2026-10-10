#!/usr/bin/env python3
# #272 (docs §8.109 確かめ 3): an independent re-computation, in Python, of the study's main rule (the
# MACD extreme cross: C0, C1, C2) and of each mailed fire's trade at TP1, compared with the TS outputs.
#
# Written from docs/OPERATIONS.md §8.109 (and §8.98 for the levels) and from the shared code the docs name,
# never from research/macdx.ts, macdx-lib.ts or macdx-hand.ts (not opened while writing this):
#   * the bars: GMO's 5-minute bid and ask paired by timestamp (track-outcomes/quotes.ts parseKlines,
#     mergeSides: a bar needs both sides, a row whose ask close is below the bid close is dropped, one
#     timestamp one bar); from START minus 5 days; closed by END (open + 5 min <= END); a bar wholly inside
#     the market closure dropped (_shared/market-hours.ts barInsideClosure, 5-minute step);
#   * the chart bars: the mid of each price, (bid + ask) / 2 (analyze/price-source.ts midCandle), rounded
#     as live-chart historyRead rounds, Number(v.toFixed(d)) with d 3 on a yen pair and 5 otherwise
#     (here Decimal ROUND_HALF_UP on the double's exact value, never round());
#   * the decision on bar i from the 600 closed bars ending at i only (§8.109 合図の決まり 2); fewer than
#     600: not judged ("short");
#   * MACD(12, 26, 9) as _shared/macd.ts and _shared/pine.ts compute it (Pine's EMA, seeded with the simple
#     mean summed one value at a time, then alpha = 2 / (n + 1)), on the window's rounded mid closes;
#     m the MACD line, g its signal, h = m - g;
#   * the cross (4): side(k) +1 when h[k] > 0, -1 when h[k] < 0, the previous bar's side when h[k] == 0;
#     a cross where side(i-1) and side(i) both exist and differ; UP when it becomes +1, DOWN when -1;
#   * x (5): m[i] on a DOWN cross, -m[i] on an UP one;
#   * C0: x > 0. C1: S summed one TR at a time from k = i-287 to i (TR[k] = max(high[k], close[k-1]) -
#     min(low[k], close[k-1]) on the rounded mids, k-1 by index), S > 0 and (4 * x) * 288 >= S.
#     C2: the wave of the sign of m (0 keeps the previous sign, a null m cuts it), its first bar r,
#     r' = max(r, i-287), P the largest |m| from r' to i, 2 * x >= P;
#   * mailed (9): one of the reads at the close + 0, 1 and 3 minutes outside isPossiblyClosed;
#   * the trade (測り方, research/tf-winrate.ts follow and its entry): the levels from the signal bar's
#     rounded mid close (_shared/ultra.ts ultraLevels, ULTRA_PAIRS: the stop 13, TP 4/10/16; a pip 0.01
#     on a yen pair, else 0.0001); entered at the signal bar's close, BUY at the ask, SELL at the bid;
#     followed from the next 5-minute bar on the side it leaves on (BUY the bid, SELL the ask); a bar
#     opening past a level fills at its open; a bar reaching both counts as the stop at the stop price
#     ("amb"); still open after 1440 bars, closed at that bar's close ("open"); a trade whose 1440 bars run
#     past the data is dropped.
#
# Compared with the TS run's bars.csv (bars per pair), decisions.csv (pair, closeUtc, dir, mailed, c0, c1,
# c2, fire exactly; x and S to 1e-9 relative, P to 1e-6 relative) and trades.csv's rows with rule=macd, entry=close, k=1
# (side, kind and bars exactly, pips to 1e-6). Prints the match counts and up to 20 mismatches a file;
# ends with "PYTHON CHECK OK" (exit 0) only on a full match, else "PYTHON CHECK FAILED" (exit 1).
# Short windows are counted (bars, and the crosses among them), never written as decisions.
#
# Not the rule, printed only to read a P that differs: P over MACD computed once on the whole series
# (from the first bar read). §8.109 確かめ 1 compares the TS's whole-period computation with the 600-bar
# window on a sample; a window's P can differ from the whole series' by a few 1e-11 (the slow EMA's seed
# at the window's start, some 290 bars before a long wave's peak), so where P (or C2) differs the
# mismatch line also shows the whole series' P and C2.
#
# --selftest runs the hand cases of §8.109 確かめ 4 that real or random prices never reach (h or m exactly
# 0, (4x)*288 == S, 2x == P, S == 0, a wave over 288 bars or starting at i, a TR across a gap, toFixed's
# ties); they also run before every comparison.
#
# Standard library only. The data files are untrusted input, parsed as data only; run with python3 -I:
#   python3 -I research/macdx-check.py --bars research/.cache --ts research/out/macdx
#   python3 -I research/macdx-check.py --walk --bars research/.cache-walk/seed1 --ts research/out/macdx \
#       --start 2025-12-01 --split 2026-01-15 --end 2026-03-01T00:00:00Z

import argparse
import bisect
import csv
import json
import math
import multiprocessing
import os
import re
import sys
from datetime import datetime, timedelta, timezone
from decimal import ROUND_HALF_UP, Decimal

MINUTE = 60_000
HOUR = 3_600_000
DAY = 86_400_000
STEP = 5 * MINUTE
WINDOW = 600          # §8.109 2
TR_BARS = 288         # C1: the last 288 bars (24 hours)
WAVE_BARS = 288       # C2: the wave counted back at most 288 bars
MAX_HOLD = 1440       # five trading days of 5-minute bars
LEAD_DAYS = 5         # the bars are read from START minus 5 days
READS_AFTER = (0, 1, 3)  # §8.109 9: the 5-minute chart read 0, 1 and 3 minutes after its close
SL, TP1 = 13, 4       # ULTRA_PAIRS (§8.98): the stop 13, TP1 4 (TP2 10, TP3 16 not compared here)
DEFAULT_PAIRS = "USD/JPY,EUR/JPY,AUD/JPY,EUR/USD,AUD/USD"
MAX_SHOW = 20
REL_TOL = 1e-9
# P alone to 1e-6: the TS takes P from MACD computed once on the whole series, the rule (and this) from the
# 600-bar window, and the two differ where the slow EMA's seed is near a long wave's start (a weekend gap
# makes the seed's error larger); the decision (c2, fire) is still compared exactly
P_TOL = 1e-6
PIPS_TOL = 1e-6
EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)


# ---- JavaScript's Number(), as parseKlines's num() uses it ------------------------------------------

# ECMAScript WhiteSpace and LineTerminator (what Number() trims)
_JS_WS = "".join(chr(c) for c in (0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x20, 0xA0, 0x1680, *range(0x2000, 0x200B),
                                  0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF))
_JS_DEC = re.compile(r"[+-]?(?:Infinity|(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?)\Z")
_JS_RADIX = re.compile(r"0([xXoObB])([0-9a-fA-F]+)\Z")


def js_number(v):
    """num() in quotes.ts: a number as it is, a string through Number(), anything else NaN"""
    if isinstance(v, bool) or v is None:
        return math.nan
    if isinstance(v, int):
        try:
            return float(v)
        except OverflowError:
            return math.inf if v > 0 else -math.inf
    if isinstance(v, float):
        return v
    if isinstance(v, str):
        s = v.strip(_JS_WS)
        if s == "":
            return 0.0
        if _JS_DEC.match(s):
            return float(s)
        m = _JS_RADIX.match(s)
        if m:
            base = {"x": 16, "o": 8, "b": 2}[m.group(1).lower()]
            try:
                return float(int(m.group(2), base))
            except ValueError:
                return math.nan
            except OverflowError:
                return math.inf
        return math.nan
    return math.nan


class DataError(Exception):
    """input the TS could not have read either: the check stops and fails"""


def _no_constants(name):
    # JSON.parse refuses NaN / Infinity; so does this
    raise ValueError(f"not JSON: {name}")


def parse_klines(path, problems):
    """parseKlines on one file: rows (t_raw, ms, open, high, low, close), sorted by t (stable)"""
    try:
        with open(path, encoding="utf-8") as f:
            body = json.loads(f.read(), parse_constant=_no_constants)
    except FileNotFoundError:
        return None
    except Exception as e:  # noqa: BLE001 — a file that does not parse is reported, not trusted
        problems.append(f"{path}: {type(e).__name__}")
        return None
    if not isinstance(body, dict):
        return []
    data = body.get("data")
    if not isinstance(data, list):
        return []
    out = []
    for r in data:
        if not isinstance(r, dict):
            continue
        t = js_number(r.get("openTime"))
        o = js_number(r.get("open"))
        h = js_number(r.get("high"))
        lo = js_number(r.get("low"))
        c = js_number(r.get("close"))
        if not all(math.isfinite(x) for x in (t, o, h, lo, c)):
            continue
        if abs(t) > 8.64e15:
            # new Date(t).toISOString() throws on it: the TS cannot have read this file
            raise DataError(f"{path}: openTime {t} is outside the Date range")
        out.append((t, int(t), o, h, lo, c))
    out.sort(key=lambda x: x[0])
    return out


def merge_sides(bid, ask):
    """mergeSides: by timestamp, both sides, the ask's close not below the bid's, one timestamp one bar"""
    asks = {}
    for a in ask:
        asks[a[0]] = a
    out = []
    emitted = set()
    for b in bid:
        if b[0] in emitted:
            continue
        a = asks.get(b[0])
        if a is None:
            continue
        if a[5] < b[5]:
            continue
        emitted.add(b[0])
        out.append((b[1], b, a))
    return out


# ---- the week (_shared/market-hours.ts) --------------------------------------------------------------

def _day_hour(ms):
    # getUTCDay (0 Sunday .. 6 Saturday; 1970-01-01 was a Thursday) and getUTCHours
    return (ms // DAY + 4) % 7, (ms // HOUR) % 24


def is_market_closed(ms):
    day, hour = _day_hour(ms)
    if day == 6:
        return True
    if day == 5 and hour >= 22:
        return True
    if day == 0 and hour < 21:
        return True
    return False


def is_possibly_closed(ms):
    day, hour = _day_hour(ms)
    if day == 6:
        return True
    if day == 5 and hour >= 21:
        return True
    if day == 0 and hour < 22:
        return True
    return False


CLOSED_WINDOW_MS = 47 * HOUR


def bar_inside_closure(open_ms, interval_ms):
    if not (interval_ms > 0):
        return is_market_closed(open_ms)
    if interval_ms > CLOSED_WINDOW_MS:
        return False
    return is_market_closed(open_ms) and is_market_closed(open_ms + interval_ms - 1)


# ---- the bars -----------------------------------------------------------------------------------------

def symbol_of(pair):
    return pair.replace("/", "_")


def is_yen(pair):
    return "JPY" in pair.upper()


def decimals_of(pair):
    return 3 if is_yen(pair) else 5


def unit_of(pair):
    return 0.01 if is_yen(pair) else 0.0001


_QUANT = {3: Decimal("0.001"), 5: Decimal("0.00001")}


def to_fixed(v, d):
    """Number(v.toFixed(d)) for a finite v: the double's exact value, ties away from zero"""
    return float(Decimal(v).quantize(_QUANT[d], rounding=ROUND_HALF_UP))


def utc_day(ms):
    return (EPOCH + timedelta(milliseconds=ms)).strftime("%Y%m%d")


def fmt(ms):
    return (EPOCH + timedelta(milliseconds=ms)).strftime("%Y-%m-%d %H:%M:%S")


def load_bars(root, walk, pair, from_ms, end_ms, problems, notes):
    sym = symbol_of(pair)
    sides = {}
    for side in ("bid", "ask"):
        d = os.path.join(root, sym, "5min", side)
        rows = []
        if walk:
            got = parse_klines(os.path.join(d, "all.json"), problems)
            if got is None:
                notes.append(f"{pair} {side}: no all.json")
            else:
                rows = got
        else:
            # the day files near the range (padded by three days each way; the bars' own times decide)
            lo, hi = utc_day(from_ms - 3 * DAY), utc_day(end_ms + 3 * DAY)
            try:
                names = sorted(n for n in os.listdir(d) if re.fullmatch(r"[0-9]{8}\.json", n))
            except FileNotFoundError:
                names = []
                notes.append(f"{pair} {side}: no folder {d}")
            names = [n for n in names if lo <= n[:8] <= hi]
            for n in names:
                got = parse_klines(os.path.join(d, n), problems)
                if got:
                    rows.extend(got)
        sides[side] = rows
    merged = merge_sides(sides["bid"], sides["ask"])
    kept = [x for x in merged
            if x[0] >= from_ms and x[0] + STEP <= end_ms and not bar_inside_closure(x[0], STEP)]
    kept.sort(key=lambda x: x[0])
    return kept


# ---- MACD (pine.ts pineEma, macd.ts) ------------------------------------------------------------------

def pine_ema_full(xs, n):
    """pineEma over values with no nulls: nothing before n-1, the simple mean (summed one at a time) at n-1"""
    out = [None] * len(xs)
    if len(xs) < n:
        return out
    s = 0
    for k in range(n):
        s += xs[k]
    prev = s / n
    out[n - 1] = prev
    alpha = 2 / (n + 1)
    for i in range(n, len(xs)):
        prev = alpha * xs[i] + (1 - alpha) * prev
        out[i] = prev
    return out


def pine_ema_series(xs, n):
    """pineEma over a series that may hold nulls (the general form of pineSmoothed)"""
    out = [None] * len(xs)
    alpha = 2 / (n + 1)
    prev = None
    for i in range(len(xs)):
        v = xs[i]
        if prev is None:
            if i < n - 1:
                continue
            s = 0
            ok = True
            for k in range(i - n + 1, i + 1):
                w = xs[k]
                if w is None or not math.isfinite(w):
                    ok = False
                    break
                s += w
            if not ok:
                continue
            prev = s / n
        elif v is None or not math.isfinite(v):
            prev = None
            continue
        else:
            prev = alpha * v + (1 - alpha) * prev
        out[i] = prev
    return out


def macd(closes):
    fast = pine_ema_full(closes, 12)
    slow = pine_ema_full(closes, 26)
    line = [None if (f is None or s is None) else f - s for f, s in zip(fast, slow)]
    signal = pine_ema_series(line, 9)
    hist = [None if (v is None or g is None) else v - g for v, g in zip(line, signal)]
    return line, signal, hist


def side_at(h, k):
    """+1 / -1 by the sign of h[k]; 0 takes the previous bar's; None where h is null"""
    while k >= 0:
        v = h[k]
        if v is None:
            return None
        if v > 0:
            return 1
        if v < 0:
            return -1
        k -= 1
    return None


def signs_of(m):
    """the sign of m bar by bar, 0 keeping the previous sign, None where m is null (the wave cut)"""
    sgn = [None] * len(m)
    cur = None
    for k in range(len(m)):
        v = m[k]
        if v is None:
            cur = None
        elif v > 0:
            cur = 1
        elif v < 0:
            cur = -1
        sgn[k] = cur
    return sgn


def wave_peak(m, i, sgn=None):
    """P: the largest |m| from r' = max(r, i-287) to i, r the first bar of the current wave of m's sign"""
    if sgn is None:
        sgn = signs_of(m[:i + 1])
    lo = max(0, i - (WAVE_BARS - 1))
    r = i
    if sgn[i] is not None:
        while r - 1 >= lo and sgn[r - 1] == sgn[i]:
            r -= 1
    p = None
    for k in range(r, i + 1):
        a = abs(m[k])
        if p is None or a > p:
            p = a
    return p, r


def true_range(high, low, prev_close):
    """TR[k] = max(high[k], close[k-1]) - min(low[k], close[k-1]) (§8.109 C1)"""
    return max(high, prev_close) - min(low, prev_close)


def judge(m, h, li, trs):
    """the decision at window index li: None when no cross, else (up, x, S, P, c0, c1, c2).
    trs: the TRs of the 288 bars ending at li, oldest first"""
    s_prev = side_at(h, li - 1)
    s_cur = side_at(h, li)
    if s_prev is None or s_cur is None or s_prev == s_cur:
        return None
    up = s_cur == 1
    x = -m[li] if up else m[li]
    c0 = x > 0
    S = 0
    for tr in trs:
        S += tr
    c1 = S > 0 and (4 * x) * 288 >= S
    P, _r = wave_peak(m, li)
    c2 = 2 * x >= P
    return up, x, S, P, c0, c1, c2


# ---- follow (tf-winrate.ts) ---------------------------------------------------------------------------

def follow(bo, bh, bl, bc, ao, ah, al, ac, start, side, sl, tp):
    last = start + MAX_HOLD - 1
    n = len(bo)
    if start < 0 or last > n - 1:
        return None
    buy = side == "BUY"
    o, h, lo = (bo, bh, bl) if buy else (ao, ah, al)
    for j in range(start, last + 1):
        if (o[j] <= sl) if buy else (o[j] >= sl):
            return "sl", o[j], j - start + 1
        if (o[j] >= tp) if buy else (o[j] <= tp):
            return "tp", o[j], j - start + 1
        hit_tp = h[j] >= tp if buy else lo[j] <= tp
        hit_sl = lo[j] <= sl if buy else h[j] >= sl
        if hit_tp and hit_sl:
            return "amb", sl, j - start + 1
        if hit_sl:
            return "sl", sl, j - start + 1
        if hit_tp:
            return "tp", tp, j - start + 1
    return "open", (bc[last] if buy else ac[last]), MAX_HOLD


# ---- one pair -----------------------------------------------------------------------------------------

def run_pair(job):
    pair, root, walk, start_ms, end_ms = job
    problems, notes = [], []
    from_ms = start_ms - LEAD_DAYS * DAY
    bars = load_bars(root, walk, pair, from_ms, end_ms, problems, notes)
    n = len(bars)
    d = decimals_of(pair)
    unit = unit_of(pair)
    T = [x[0] for x in bars]
    bo = [x[1][2] for x in bars]
    bh = [x[1][3] for x in bars]
    bl = [x[1][4] for x in bars]
    bc = [x[1][5] for x in bars]
    ao = [x[2][2] for x in bars]
    ah = [x[2][3] for x in bars]
    al = [x[2][4] for x in bars]
    ac = [x[2][5] for x in bars]
    # the chart's bars: midCandle, rounded as historyRead
    H = [to_fixed((bh[k] + ah[k]) / 2, d) for k in range(n)]
    L = [to_fixed((bl[k] + al[k]) / 2, d) for k in range(n)]
    C = [to_fixed((bc[k] + ac[k]) / 2, d) for k in range(n)]

    decisions, trades = [], []
    count = {"judged": 0, "short": 0, "shortCrosses": 0, "dropped": 0}
    # not the rule (the rule is the 600-bar window, §8.109 2): m over the whole series from its first bar,
    # only to say, beside a P that differs, whether the TS's P is the whole series' one (§8.109 確かめ 1)
    mW = macd(C)[0]
    sW = signs_of(mW)
    for i in range(n):
        close = T[i] + STEP
        if close < start_ms:
            continue
        count["judged"] += 1
        if i < WINDOW - 1:
            # not judged (§8.109 2); counted, and whether the bars there are would cross (reported only)
            count["short"] += 1
            _m, _g, hs = macd(C[:i + 1])
            a, b = side_at(hs, i - 1), side_at(hs, i)
            if a is not None and b is not None and a != b:
                count["shortCrosses"] += 1
            continue
        w0 = i - (WINDOW - 1)
        m, _g, h = macd(C[w0:i + 1])
        trs = [true_range(H[k], L[k], C[k - 1]) for k in range(i - (TR_BARS - 1), i + 1)]
        got = judge(m, h, WINDOW - 1, trs)
        if got is None:
            continue
        up, x, S, P, c0, c1, c2 = got
        P_whole = wave_peak(mW, i, sW)[0]
        fire = c0 and c1 and c2
        mailed = any(not is_possibly_closed(close + a * MINUTE) for a in READS_AFTER)
        decisions.append({
            "pair": pair, "closeUtc": fmt(close), "dir": "UP" if up else "DOWN", "mailed": int(mailed),
            "x": x, "S": S, "P": P, "c0": int(c0), "c1": int(c1), "c2": int(c2), "fire": int(fire),
            "t": close, "P_whole": P_whole, "c2_whole": int(2 * x >= P_whole),
        })
        if not (mailed and fire):
            continue
        side = "BUY" if up else "SELL"
        dirn = 1 if up else -1
        entry = C[i]
        sl = entry - dirn * SL * unit
        tp = entry + dirn * TP1 * unit
        fill = ac[i] if up else bc[i]
        e = bisect.bisect_left(T, close)
        res = follow(bo, bh, bl, bc, ao, ah, al, ac, e, side, sl, tp)
        if res is None:
            count["dropped"] += 1
            continue
        kind, exit_px, held = res
        pnl = exit_px - fill if up else fill - exit_px
        trades.append({"pair": pair, "closeUtc": fmt(close), "side": side, "entry": "close", "k": "1",
                       "kind": kind, "pips": pnl / unit, "bars": held, "t": close,
                       "spread": (ac[i] - bc[i]) / unit})
    return {
        "pair": pair, "bars": n, "first": fmt(T[0]) if n else "", "last": fmt(T[-1]) if n else "",
        "decisions": decisions, "trades": trades, "count": count, "problems": problems, "notes": notes,
    }


# ---- hand cases (§8.109 確かめ 4: what real or random prices never reach) ------------------------------

def selftest():
    flat = [1.0] * 288                                   # S = 288
    # h[i-1] == 0 keeps the side before it: -1, 0, +1 is an UP cross at the +1
    got = judge([None, -0.5, -0.4, -0.3], [None, -1.0, 0.0, 1.0], 3, flat)
    assert got is not None and got[0] is True, got
    # h[i] == 0 keeps the previous side: -1, 0 is no cross; +1, 0 is no cross
    assert judge([None, -0.5, -0.4], [None, -1.0, 0.0], 2, flat) is None
    assert judge([None, 0.5, 0.4], [None, 1.0, 0.0], 2, flat) is None
    # a null h before: no side, no cross
    assert judge([None, None, 0.4], [None, None, 1.0], 2, flat) is None
    # m[i] == 0 on a cross: x is 0, C0 fails (and C1, C2 with it)
    up, x, S, P, c0, c1, c2 = judge([None, 0.1, 0.0], [None, 1.0, -1.0], 2, flat)
    assert (up, x, c0, c1) == (False, 0.0, False, False), (up, x, c0, c1)
    # (4x) * 288 == S passes C1; a hair less fails; S == 0 fails whatever x is
    up, x, S, P, c0, c1, c2 = judge([None, 0.3, 0.25], [None, 1.0, -1.0], 2, flat)
    assert (up, x, S, c0, c1) == (False, 0.25, 288.0, True, True), (x, S, c1)
    assert judge([None, 0.3, 0.2499999], [None, 1.0, -1.0], 2, flat)[5] is False
    assert judge([None, 0.3, 0.25], [None, 1.0, -1.0], 2, [0.0] * 288)[5] is False
    # 2x == P passes C2: the wave's peak 0.5, x 0.25; a peak above it fails
    assert judge([None, 0.5, 0.25], [None, 1.0, -1.0], 2, flat)[6] is True
    assert judge([None, 0.5000001, 0.25], [None, 1.0, -1.0], 2, flat)[6] is False
    # a 0 inside the wave keeps its sign: the peak before the 0 counts
    assert wave_peak([None, 0.9, 0.0, 0.3], 3)[0] == 0.9
    # a sign change ends the wave: the peak before it does not count; a wave starting at i is m[i] alone
    assert wave_peak([None, 0.9, -0.1, 0.3], 3)[0] == 0.3
    assert wave_peak([0.2, 0.5, -0.4], 2)[0] == 0.4
    # a null m cuts the wave
    assert wave_peak([0.9, None, 0.3], 2)[0] == 0.3
    # a wave longer than 288 bars: only the last 288 (i-287 .. i) count
    m = [5.0] + [1.0] * 287 + [0.5]                        # 289 bars, the 5.0 is i-288
    assert wave_peak(m, 288) == (1.0, 1), wave_peak(m, 288)
    m = [1.0] + [5.0] + [1.0] * 286 + [0.5]                # the 5.0 is i-287: counted
    assert wave_peak(m, 288)[0] == 5.0
    # TR across a gap: the previous close by index
    assert true_range(101.0, 100.5, 99.0) == 2.0 and true_range(100.5, 100.0, 102.0) == 2.0
    assert true_range(101.0, 100.0, 100.5) == 1.0
    # the chart's rounding: ties away from zero on the double's exact value (toFixed)
    assert to_fixed(150.0625, 3) == 150.063 and to_fixed(0.640625, 5) == 0.64063
    assert to_fixed(1.0005, 3) == 1.0       # 1.0005 is 1.000499999... as a double
    assert to_fixed(150.1235, 3) == 150.124  # 150.12350000000000704... as a double
    assert to_fixed(151.2225, 3) == 151.222  # 151.22249999999999659... as a double
    # Number() on GMO's strings
    assert js_number(" 150.5 ") == 150.5 and js_number("") == 0.0 and math.isnan(js_number("1_0"))
    assert math.isnan(js_number(None)) and js_number("0x10") == 16.0 and js_number(7) == 7.0
    # the week
    assert is_possibly_closed(ms_of_iso("2026-01-02T21:00:00Z")) and not is_possibly_closed(ms_of_iso("2026-01-02T20:59:00Z"))
    assert bar_inside_closure(ms_of_iso("2026-01-03T12:00:00Z"), STEP)
    assert not bar_inside_closure(ms_of_iso("2026-01-02T21:55:00Z"), STEP)
    assert not bar_inside_closure(ms_of_iso("2026-01-04T21:00:00Z"), STEP)
    assert bar_inside_closure(ms_of_iso("2026-01-04T20:55:00Z"), STEP)
    print("self-test: all hand cases pass")


# ---- the TS outputs -----------------------------------------------------------------------------------

def read_csv(path):
    with open(path, encoding="utf-8", newline="") as f:
        return list(csv.DictReader(f))


def fnum(s):
    if s is None or s == "":
        return None
    try:
        return float(s)
    except ValueError:
        return math.nan


def rel_close(a, b, tol=REL_TOL):
    if a is None or b is None:
        return a is None and b is None
    if not (math.isfinite(a) and math.isfinite(b)):
        return a == b
    if a == b:
        return True
    return abs(a - b) <= tol * max(abs(a), abs(b))


def ms_of(day):
    return int((datetime.strptime(day, "%Y-%m-%d").replace(tzinfo=timezone.utc) - EPOCH).total_seconds() * 1000)


def ms_of_iso(s):
    t = s.strip()
    if re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", t):
        return ms_of(t)
    if t.endswith("Z") or t.endswith("z"):
        t = t[:-1] + "+00:00"
    dt = datetime.fromisoformat(t)
    if dt.tzinfo is None:
        raise SystemExit(f"--end {s}: give the time zone (e.g. a trailing Z)")
    delta = dt - EPOCH
    return (delta.days * 86400 + delta.seconds) * 1000 + delta.microseconds // 1000


def summarize(trs):
    n = len(trs)
    k = {"tp": 0, "sl": 0, "amb": 0, "open": 0}
    for t in trs:
        k[t["kind"]] += 1
    settled = k["tp"] + k["sl"] + k["amb"]
    rate = k["tp"] / settled if settled else float("nan")
    pips = 0
    for t in trs:
        pips += t["pips"]
    mean = pips / n if n else float("nan")
    return (f"n={n:6d}  TP1 first {100 * rate:5.1f}%  (tp {k['tp']} sl {k['sl']} amb {k['amb']} open {k['open']})"
            f"  pips/trade {mean:.2f}")


def main():
    ap = argparse.ArgumentParser(description="#272 §8.109 確かめ 3: the MACD rule re-computed in Python")
    ap.add_argument("--bars", help="GMO cache root (<SYM>/5min/<bid|ask>/<YYYYMMDD>.json), "
                                   "or with --walk a walk root (<SYM>/5min/<bid|ask>/all.json)")
    ap.add_argument("--walk", action="store_true")
    ap.add_argument("--ts", help="the TS outputs: bars.csv, decisions.csv, trades.csv")
    ap.add_argument("--start", default="2024-01-01")
    ap.add_argument("--split", default="2025-05-19")
    ap.add_argument("--end", default="2026-10-09T00:00:00Z")
    ap.add_argument("--pairs", default=DEFAULT_PAIRS)
    ap.add_argument("--jobs", type=int, default=0, help="processes (default: one a pair, at most the CPUs)")
    ap.add_argument("--selftest", action="store_true", help="the hand cases only")
    a = ap.parse_args()
    if a.selftest:
        selftest()
        return 0
    if not a.bars or not a.ts:
        ap.error("--bars and --ts are required")
    selftest()

    start_ms = ms_of(a.start)
    split_ms = ms_of(a.split)
    end_ms = ms_of_iso(a.end)
    pairs = [p.strip() for p in a.pairs.split(",") if p.strip()]
    print(f"#272 §8.109 Python check: {', '.join(pairs)}; {a.start} .. {fmt(end_ms)} (split {a.split}); "
          f"{'walk' if a.walk else 'GMO'} bars {a.bars}")

    jobs = [(p, a.bars, a.walk, start_ms, end_ms) for p in pairs]
    procs = a.jobs if a.jobs > 0 else max(1, min(len(pairs), os.cpu_count() or 1))
    ctx = None
    if procs > 1:
        try:
            ctx = multiprocessing.get_context("fork")
        except ValueError:
            ctx = None  # no fork here: one pair after another
    if ctx is not None:
        with ctx.Pool(procs) as pool:
            results = pool.map(run_pair, jobs)
    else:
        results = [run_pair(j) for j in jobs]

    ok = True
    for r in results:
        for p in r["problems"]:
            print(f"  problem: {p}")
            ok = False
        for p in r["notes"]:
            print(f"  note: {p}")

    # ---- bars.csv
    ts_bars = {row["pair"]: row for row in read_csv(os.path.join(a.ts, "bars.csv"))}
    mism = []
    match = 0
    for r in results:
        t = ts_bars.get(r["pair"])
        mine = (str(r["bars"]), r["first"], r["last"])
        theirs = (t.get("bars"), t.get("first"), t.get("last")) if t else None
        if theirs == mine:
            match += 1
        else:
            mism.append(f"{r['pair']}: python {mine} ts {theirs}")
    for p in ts_bars:
        if p not in pairs:
            mism.append(f"{p}: in the TS bars.csv, not asked here")
    print(f"\nbars.csv: {match} of {len(results)} pairs match")
    for x in mism[:MAX_SHOW]:
        print(f"  {x}")
    ok = ok and not mism

    # ---- decisions.csv
    mine_d = {}
    for r in results:
        for dd in r["decisions"]:
            mine_d[(dd["pair"], dd["closeUtc"])] = dd
    ts_d = {}
    dup = 0
    for row in read_csv(os.path.join(a.ts, "decisions.csv")):
        key = (row.get("pair"), row.get("closeUtc"))
        if key in ts_d:
            dup += 1
        ts_d[key] = row
    mism = []
    match = 0
    exact = ("dir", "mailed", "c0", "c1", "c2", "fire")
    for key in sorted(set(mine_d) | set(ts_d), key=lambda k: (pairs.index(k[0]) if k[0] in pairs else 99, k[1])):
        m, t = mine_d.get(key), ts_d.get(key)
        if m is None:
            mism.append(f"{key[0]} {key[1]}: only in the TS ({t.get('dir')} fire {t.get('fire')})")
            continue
        if t is None:
            mism.append(f"{key[0]} {key[1]}: only here ({m['dir']} fire {m['fire']} x {m['x']!r})")
            continue
        bad = [f"{c} py {m[c]} ts {t.get(c)}" for c in exact if str(m[c]) != (t.get(c) or "").strip()]
        bad += [f"{c} py {m[c]!r} ts {t.get(c)}" for c in ("x", "S", "P")
                if not rel_close(m[c], fnum(t.get(c)), P_TOL if c == "P" else REL_TOL)]
        if bad and (str(m["c2"]) != (t.get("c2") or "").strip() or not rel_close(m["P"], fnum(t.get("P")), P_TOL)):
            same = fnum(t.get("P")) == m["P_whole"]
            bad.append(f"(not the rule: on the whole series' m, P {m['P_whole']!r} c2 {m['c2_whole']}"
                       f"{'; the TS P equals it' if same else ''})")
        if bad:
            mism.append(f"{key[0]} {key[1]}: " + "; ".join(bad))
        else:
            match += 1
    if dup:
        mism.append(f"decisions.csv repeats {dup} (pair, closeUtc)")
    print(f"decisions.csv: {match} of {len(mine_d)} here / {len(ts_d)} in the TS match; {len(mism)} mismatches")
    for x in mism[:MAX_SHOW]:
        print(f"  {x}")
    ok = ok and not mism and len(mine_d) == len(ts_d) == match

    # ---- trades.csv (rule=macd)
    mine_t = {}
    for r in results:
        for tt in r["trades"]:
            mine_t[(tt["pair"], tt["closeUtc"], "close", "1")] = tt
    ts_t = {}
    other = 0
    dup = 0
    for row in read_csv(os.path.join(a.ts, "trades.csv")):
        if row.get("rule") != "macd":
            continue
        key = (row.get("pair"), row.get("closeUtc"), row.get("entry"), row.get("k"))
        if key[2:] != ("close", "1"):
            other += 1
            continue
        if key in ts_t:
            dup += 1
        ts_t[key] = row
    mism = []
    match = 0
    for key in sorted(set(mine_t) | set(ts_t), key=lambda k: (pairs.index(k[0]) if k[0] in pairs else 99, k[1])):
        m, t = mine_t.get(key), ts_t.get(key)
        if m is None:
            mism.append(f"{key[0]} {key[1]}: only in the TS ({t.get('side')} {t.get('kind')} {t.get('pips')})")
            continue
        if t is None:
            mism.append(f"{key[0]} {key[1]}: only here ({m['side']} {m['kind']} {m['pips']:.6f})")
            continue
        bad = [f"{c} py {m[c]} ts {t.get(c)}" for c in ("side", "kind") if m[c] != t.get(c)]
        if str(m["bars"]) != t.get("bars"):
            bad.append(f"bars py {m['bars']} ts {t.get('bars')}")
        tp = fnum(t.get("pips"))
        if tp is None or not (abs(m["pips"] - tp) <= PIPS_TOL):
            bad.append(f"pips py {m['pips']:.9f} ts {t.get('pips')}")
        if bad:
            mism.append(f"{key[0]} {key[1]}: " + "; ".join(bad))
        else:
            match += 1
    if dup:
        mism.append(f"trades.csv repeats {dup} macd (pair, closeUtc) rows")
    print(f"trades.csv (rule=macd, entry=close, k=1): {match} of {len(mine_t)} here / {len(ts_t)} in the TS match; "
          f"{len(mism)} mismatches" + (f" ({other} other macd rows not compared)" if other else ""))
    for x in mism[:MAX_SHOW]:
        print(f"  {x}")
    ok = ok and not mism and len(mine_t) == len(ts_t) == match

    # ---- the counts, to read beside the TS's printed report (not compared)
    dec = [dd for r in results for dd in r["decisions"]]
    mailed = [dd for dd in dec if dd["mailed"]]
    judged = sum(r["count"]["judged"] for r in results)
    short = sum(r["count"]["short"] for r in results)
    short_x = sum(r["count"]["shortCrosses"] for r in results)
    dropped = sum(r["count"]["dropped"] for r in results)
    fires = sum(1 for dd in mailed if dd["fire"])
    c0 = sum(1 for dd in mailed if not dd["c0"])
    c1o = sum(1 for dd in mailed if dd["c0"] and not dd["c1"] and dd["c2"])
    c2o = sum(1 for dd in mailed if dd["c0"] and dd["c1"] and not dd["c2"])
    c12 = sum(1 for dd in mailed if dd["c0"] and not dd["c1"] and not dd["c2"])
    trs = [tt for r in results for tt in r["trades"]]
    pdiff = [dd for dd in dec if dd["P"] != dd["P_whole"]]
    worst = max((abs(dd["P"] - dd["P_whole"]) / max(abs(dd["P"]), abs(dd["P_whole"])) for dd in pdiff), default=0.0)
    flips = sum(1 for dd in dec if dd["c2"] != dd["c2_whole"])
    print(f"\nnot the rule, for reading a P that differs: P on the whole series' m differs from the window's in "
          f"{len(pdiff)} of {len(dec)} crosses (largest relative {worst:.1e}); C2 would change in {flips}")
    print(f"here: bars judged {judged} (short windows {short} bars, {short_x} of them crosses, not in decisions);"
          f" crosses {len(dec)} (not mailed {len(dec) - len(mailed)});"
          f" fires {fires}; not fired by C0 {c0}, C1 only {c1o}, C2 only {c2o}, C1 and C2 {c12};"
          f" dropped at the data's end {dropped}")
    print(f"main, whole        {summarize(trs)}")
    print(f"main, first half   {summarize([t for t in trs if t['t'] < split_ms])}")
    print(f"main, second half  {summarize([t for t in trs if t['t'] >= split_ms])}")

    print("\nPYTHON CHECK OK" if ok else "\nPYTHON CHECK FAILED")
    return 0 if ok else 1


if __name__ == "__main__":
    try:
        code = main()
    except (DataError, OSError, KeyError, ValueError, AssertionError) as e:
        print(f"  stopped: {type(e).__name__}: {e}")
        print("\nPYTHON CHECK FAILED")
        code = 1
    sys.exit(code)
