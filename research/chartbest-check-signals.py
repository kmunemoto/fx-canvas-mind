#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
chartbest-check-signals.py — the signals of the independent Python re-computation of docs/OPERATIONS.md §8.113
(#318, step 2): the items C1 (donchian-A20/A55) and K1 (breedon-1/2), the two current emails (ULTRA 5分足 from
§8.107 2, MACD の山・谷 from §8.109 合図の決まり 1-9), the event framework of §8.113 5, the window holes (6 ③)
and the reasons ①〜④ (6).

Written from the docs and the plan only; no research/chartbest*.ts was opened. Where the docs name shared code as
the definition (§8.107 2: anchoredStart; §8.109 3: _shared/macd.ts / pine.ts), the behaviour is re-written here
from that definition:
  * ULTRA: the 600 bars ending at i, RSI 14 by Pine's rma (the first value the simple mean of the 14 rises / falls,
    summed one at a time; 100 when the falls' average is 0, 0 when the rises' is 0), started at anchoredStart
    (the first bar at or after the first multiple of 200 x the bar length (ms from 1970) at or after the window's
    first bar, if that bar is at most 280 bars into the window, else the window's first bar); BUY when RSI > 30 and
    the bar before <= 30, SELL when RSI < 70 and the bar before >= 70. Late signals (§8.102, §8.107 2): a signal of
    bar i found in window i+1 and not in window i (outside 「全部の合図」, SQ-22).
  * MACD: per window of the 600 bars ending at i (§8.109 2: 「足 i の判断には、i で終わる確定足600本だけを使う」),
    Pine's EMA (simple mean seed, then alpha = 2/(n+1)); the cross, x, C0, C1 (288 TRs summed one at a time) and C2
    (the wave of m's sign, at most 288 bars back) exactly as §8.109 4-6.
"""
import importlib.util
import os
import sys

import numpy as np


def _mod(name):
    key = f'cbcheck_{name}'
    if key in sys.modules:
        return sys.modules[key]
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), f'chartbest-check-{name}.py')
    spec = importlib.util.spec_from_file_location(key, path)
    m = importlib.util.module_from_spec(spec)
    sys.modules[key] = m
    spec.loader.exec_module(m)
    return m


D = _mod('data')

BUY, SELL = 1, -1
DIR_NAME = {BUY: 'BUY', SELL: 'SELL'}
WINDOW = 600            # §8.107 2 / §8.109 2
ANCHOR_PERIOD = 200     # §8.107 2: 200 x the bar length
CHART_BARS = 120        # §8.107 2: the newest 120 bars give the bar length
TR_BARS = 288           # §8.109 6 C1
WAVE_BARS = 288         # §8.109 6 C2
HOLE_SLOTS = 6          # §8.113 6 ③: 6 open slots (30 minutes) or more
HOLE_LOOKBACK = 9       # 6 ③: from the start of the 10th newest bar to T

# SPEC-like constants of the Python (the resolutions it implements; see spec-questions.md)
DONCHIAN_TARGET_FROM_BAR0 = True     # SQ-01: s = 0 is a value from bar 0
ANSWER_KNOWING = 'newestBy+60m,equal=none'   # SQ-11 (set O)


# ---------------------------------------------------------------- vectorised time fields of bar arrays
def _year_bounds(years, which):
    out = {}
    for y in np.unique(years):
        (a, b), (c, d) = D._dst_bounds(int(y))
        out[int(y)] = (a, b) if which == 'ny' else (c, d)
    return out


def ny_summer_arr(t):
    years = t.astype('datetime64[ms]').astype('datetime64[Y]').astype(np.int64) + 1970
    out = np.zeros(t.size, dtype=bool)
    for y, (a, b) in _year_bounds(years, 'ny').items():
        m = years == y
        out[m] = (t[m] >= a) & (t[m] < b)
    return out


def london_summer_arr(t):
    years = t.astype('datetime64[ms]').astype('datetime64[Y]').astype(np.int64) + 1970
    out = np.zeros(t.size, dtype=bool)
    for y, (a, b) in _year_bounds(years, 'ldn').items():
        m = years == y
        out[m] = (t[m] >= a) & (t[m] < b)
    return out


def season_arr(T):
    ny, ld = ny_summer_arr(T), london_summer_arr(T)
    return np.where(ny & ld, D.SEASON_SS, np.where(ny, D.SEASON_SW, np.where(ld, D.SEASON_WS, D.SEASON_WW))).astype(np.int64)


def hour_arr(T):
    return (T % D.DAY) // D.HOUR


def wk_arr(T):
    return (T - D.WEEK_OFFSET) // D.WEEK


def possibly_closed_arr(t):
    wd = (t // D.DAY + 3) % 7
    tod = t % D.DAY
    return (wd == 5) | ((wd == 4) & (tod >= 21 * D.HOUR)) | ((wd == 6) & (tod < 22 * D.HOUR))


def sent_arr(T):
    ok = np.zeros(T.size, dtype=bool)
    for m in D.SENT_READS:
        ok |= ~possibly_closed_arr(T + m * D.MIN)
    return ok


# ---------------------------------------------------------------- items: C1 donchian-A20/A55 (18 C1)
def donchian_target(pb, n):
    """C1: s = 0 until a break; for i >= n with HH = max(high[i-n..i-1]), LL = min(low[i-n..i-1]):
    close > HH -> +1, close < LL -> -1 (strict; HH >= LL so never both); else s stays."""
    N = pb.n
    s = np.zeros(N, dtype=np.int8)
    if N <= n:
        return s
    from numpy.lib.stride_tricks import sliding_window_view as win
    hh = win(pb.mh[:-1], n).max(axis=1)        # windows ending at i-1, for i = n .. N-1
    ll = win(pb.ml[:-1], n).min(axis=1)
    c = pb.mc[n:]
    ev = np.zeros(N, dtype=np.int8)
    ev[n:] = np.where(c > hh, 1, np.where(c < ll, -1, 0))
    # forward fill of the last break: s[i] = the newest non-zero ev at or before i
    idx = np.where(ev != 0, np.arange(N), -1)
    np.maximum.accumulate(idx, out=idx)
    s = np.where(idx >= 0, ev[np.maximum(idx, 0)], 0).astype(np.int8)
    return s


def donchian_tri(pb, n, plant=''):
    s = donchian_target(pb, n) if plant != 'hhIncludesI' else _donchian_target_planted(pb, n)
    buy = (s == 1).astype(np.int8)
    sell = (s == -1).astype(np.int8)
    return buy, sell, s


def _donchian_target_planted(pb, n):
    """Planted error 'hhIncludesI' (20 (f)): HH/LL over i-n+1..i (bar i included) — never a break then."""
    N = pb.n
    s = np.zeros(N, dtype=np.int8)
    cur = 0
    for i in range(n, N):
        hh = float(np.max(pb.mh[i - n + 1:i + 1]))
        ll = float(np.min(pb.ml[i - n + 1:i + 1]))
        if pb.mc[i] > hh and cur != 1:
            cur = 1
        elif pb.mc[i] < ll and cur != -1:
            cur = -1
        s[i] = cur
    return s


# ---------------------------------------------------------------- items: K1 breedon-1/2 (18 K1)
BREEDON_MINUTE = {'breedon-1': 2 * 60 + 55, 'breedon-2': 10 * 60 + 55}     # the bar starting 02:55 / 10:55 NY
BREEDON_DIR = {'breedon-1': SELL, 'breedon-2': BUY}


def ny_local_arr(t):
    off = np.where(ny_summer_arr(t), -4 * D.HOUR, -5 * D.HOUR)
    x = t + off
    return (x // D.DAY + 3) % 7, (x % D.DAY) // D.MIN


def breedon_tri(pb, item, plant=''):
    """K1: the condition holds on a bar starting at 02:55 (breedon-1) / 10:55 (breedon-2) New York time on a New
    York weekday (Mon-Fri); every other bar 'does not hold' (a finite window of 2 bars). EUR/USD only."""
    t = pb.t
    if plant == 'londonDstAsNy':
        wd, mins = _local_with_london_rule(t)
    else:
        wd, mins = ny_local_arr(t)
    cond = ((wd <= 4) & (mins == BREEDON_MINUTE[item])).astype(np.int8)
    zero = np.zeros(pb.n, dtype=np.int8)
    return (cond, zero) if BREEDON_DIR[item] == BUY else (zero, cond)


def _local_with_london_rule(t):
    """Planted error 'londonDstAsNy' twin: New York summer decided by London's switch dates."""
    off = np.where(london_summer_arr(t), -4 * D.HOUR, -5 * D.HOUR)
    x = t + off
    return (x // D.DAY + 3) % 7, (x % D.DAY) // D.MIN


def breedon_marks(T):
    """K1 印: the shifted weeks (New York summer, London winter) at T."""
    return ['shiftedWeek'] if D.season_of(T) == D.SEASON_SW else []


# ---------------------------------------------------------------- the event framework (5)
def events_of(tri_buy, tri_sell, plant=''):
    """5: a candidate at i iff tri[i] = 1 (holds), tri[i-1] = 0 (does not hold; -1 is 'none' and skips it), and i
    is not the first bar whose tri is not -1 ('初めて決まった足'). Then (pair, i) with both directions: neither.
    Returns (cands [(i, dir)], counts)."""
    out = {}
    cnt = {'bothSuppressed': 0, 'firstSkipped': 0, 'nullPrevSkipped': 0, 'bothAt': []}
    for d, tri in ((BUY, tri_buy), (SELL, tri_sell)):
        defined = np.nonzero(tri != -1)[0]
        if defined.size == 0:
            continue
        first = int(defined[0])
        if tri[first] == 1:
            cnt['firstSkipped'] += 1
        prev = np.concatenate([[-1], tri[:-1]])
        if plant == 'noRiseEdge':
            hit = (tri == 1) & (prev != -1)
        else:
            hit = (tri == 1) & (prev == 0)
        hit[:first + 1] = False
        cnt['nullPrevSkipped'] += int(((tri == 1) & (prev == -1) & (np.arange(tri.size) > first)).sum())
        for i in np.nonzero(hit)[0].tolist():
            out.setdefault(i, []).append(d)
    cands = []
    for i in sorted(out):
        ds = out[i]
        if len(ds) > 1:
            cnt['bothSuppressed'] += 1
            cnt['bothAt'].append(i)
            continue
        cands.append((i, ds[0]))
    return cands, cnt


def events_named(named_buy, named_sell, plant=''):
    """5 for an item with names (no trial item has names; the 20 (g) hand example 名前ごと): per direction and per
    name, a name holding at i that does not hold at i-1 rises (a name absent at i-1 does not hold there: 「成り立た
    ない」, not 「無し」); several names rising at the same bar and direction give one candidate. 「初めて決まった
    足」 is the item's per direction, never per name: a name list is never 'none', so the first determined bar is
    bar 0 (counted in firstSkipped when a name holds there). Then (i) with both directions: neither.
    named_buy / named_sell: one collection of names per bar. Returns (cands [(i, dir)], counts) as events_of."""
    out = {}
    cnt = {'bothSuppressed': 0, 'firstSkipped': 0, 'nullPrevSkipped': 0, 'bothAt': []}
    for d, named in ((BUY, named_buy), (SELL, named_sell)):
        if not named:
            continue
        if named[0]:
            cnt['firstSkipped'] += 1
        for i in range(1, len(named)):
            prev = set(named[i - 1])
            if plant == 'noRiseEdge':
                rose = bool(named[i])
            else:
                rose = any(x not in prev for x in named[i])
            if rose:
                out.setdefault(i, []).append(d)
    cands = []
    for i in sorted(out):
        ds = out[i]
        if len(ds) > 1:
            cnt['bothSuppressed'] += 1
            cnt['bothAt'].append(i)
            continue
        cands.append((i, ds[0]))
    return cands, cnt


def answer_knowing(pb, cands):
    """Set O (SQ-11): each donchian-A20 candidate's direction re-set from mc of the newest bar closed by T + 60 min
    against mc[i]; equal (or no newer bar) -> removed."""
    out = []
    for i, _ in cands:
        T = int(pb.t[i]) + D.STEP
        j = int(np.searchsorted(pb.t, T + 60 * D.MIN - D.STEP, side='right')) - 1
        if j <= i or pb.mc[j] == pb.mc[i]:
            continue
        out.append((i, BUY if pb.mc[j] > pb.mc[i] else SELL))
    return out


# ---------------------------------------------------------------- measure 1: ULTRA 5分足 (§8.107 2)
RSI_LEN = 14


def _rsi(c):
    """Pine's ta.rsi (rma 14, seeded with the simple mean of the first 14 rises / falls) over the list c."""
    n = len(c)
    out = [None] * n
    alpha = 1 / RSI_LEN
    keep = 1 - alpha
    su = sd = 0.0
    U = Dn = None
    for k in range(1, n):
        diff = c[k] - c[k - 1]
        u = diff if diff > 0 else 0.0
        dd = -diff if diff < 0 else 0.0
        if k < RSI_LEN:
            su += u
            sd += dd
            continue
        if k == RSI_LEN:
            su += u
            sd += dd
            U, Dn = su / RSI_LEN, sd / RSI_LEN
        else:
            U = alpha * u + keep * U
            Dn = alpha * dd + keep * Dn
        out[k] = 100.0 if Dn == 0 else (0.0 if U == 0 else 100 - 100 / (1 + U / Dn))
    return out


def _ultra_side(r, p):
    if r is None or p is None:
        return 0
    if r > 30 and p <= 30:
        return BUY
    if r < 70 and p >= 70:
        return SELL
    return 0


def ultra_anchors(t):
    """anchoredStart for every bar i >= 599 (index into the whole series), and the bar length used."""
    n = t.size
    if n < WINDOW:
        return np.zeros(0, dtype=np.int64)
    from numpy.lib.stride_tricks import sliding_window_view as win
    diffs = np.diff(t).astype(np.int64)                   # diffs[k] = t[k+1] - t[k]
    diffs = np.where(diffs > 0, diffs, np.iinfo(np.int64).max)
    # the newest 120 bars of window i: bars i-119 .. i; their 119 gaps diffs[i-119 .. i-1]
    steps = win(diffs, CHART_BARS - 1).min(axis=1)       # steps[k] = min diffs[k .. k+118] -> window ending at i = k+119
    i = np.arange(WINDOW - 1, n)
    step = steps[i - CHART_BARS + 1]
    ws = i - (WINDOW - 1)
    grid = ANCHOR_PERIOD * step
    t0 = t[ws]
    at = -((-t0) // grid) * grid
    s = np.searchsorted(t, at, side='left')
    first_shown = (WINDOW - 1) - (CHART_BARS - 1)          # 480
    ok = (s <= i) & (s - ws <= first_shown - ANCHOR_PERIOD)
    return np.where(ok, s, ws).astype(np.int64)


def ultra_signals(pb):
    """On-time signals [(i, dir)] for i >= 599 and late ones [(i, dir)] (window i+1 only)."""
    t, c = pb.t, pb.mc.tolist()
    n = pb.n
    if n < WINDOW:
        return [], []
    anc = ultra_anchors(t)                   # anc[i - 599] = the anchor of the window ending at bar i
    # runs of consecutive bars i sharing an anchor (tf-winrate's segments): (anchor, first i, last i)
    runs = []
    k = 0
    while k < anc.size:
        k2 = k
        while k2 + 1 < anc.size and anc[k2 + 1] == anc[k]:
            k2 += 1
        runs.append((int(anc[k]), k + WINDOW - 1, k2 + WINDOW - 1))
        k = k2 + 1
    ontime, late = {}, []
    prev = None                               # (anchor, last i, rsi run) of the run before
    for a, lo, hi in runs:
        r = _rsi(c[a:hi + 1])                 # one RSI run from the anchor serves every bar of the run
        for i in range(lo, hi + 1):
            sd = _ultra_side(r[i - a], r[i - a - 1]) if i - a >= 1 else 0
            if sd:
                ontime[i] = sd
        if prev is not None:
            # the late check: the previous run's last bar i, read in window i+1 (this run's anchor)
            i = prev[1]
            sd2 = _ultra_side(r[i - a], r[i - a - 1]) if i - a >= 1 else 0
            if sd2 and sd2 != ontime.get(i, 0):
                late.append((i, sd2))
        prev = (a, hi)
    return sorted(ontime.items()), late


# ---------------------------------------------------------------- measure 2: MACD の山・谷 (§8.109 1-9)
MACD_FAST, MACD_SLOW, MACD_SIG = 12, 26, 9


def macdx_signals(pb):
    """[(i, dir)] for i >= 599: the decision on bar i from the 600 bars ending at i only, every window computed
    on its own (vectorised over windows, the same arithmetic in the same order as one window at a time)."""
    n = pb.n
    if n < WINDOW:
        return []
    Wn = n - WINDOW + 1                       # windows i = 599 .. n-1
    c, H, L = pb.mc, pb.mh, pb.ml
    af, as_, ag = 2 / (MACD_FAST + 1), 2 / (MACD_SLOW + 1), 2 / (MACD_SIG + 1)
    kf, ks, kg = 1 - af, 1 - as_, 1 - ag
    fsum = ssum = msum = None
    f = s = g = None
    side = np.zeros(Wn, dtype=np.int8)        # 0: no side yet
    side_prev = None
    sg = np.zeros(Wn, dtype=np.int8)          # the sign of m (0 keeps the previous; 0 = none yet)
    wave_start = np.zeros(Wn, dtype=np.int64)
    P = np.zeros(Wn)
    p_from = WINDOW - WAVE_BARS               # 312: r' >= i-287
    m = None
    for j in range(WINDOW):
        x = c[j:j + Wn]
        # fast EMA
        if j < MACD_FAST - 1:
            fsum = x.copy() if j == 0 else fsum + x
        elif j == MACD_FAST - 1:
            fsum = fsum + x
            f = fsum / MACD_FAST
        else:
            f = af * x + kf * f
        # slow EMA
        if j < MACD_SLOW - 1:
            ssum = x.copy() if j == 0 else ssum + x
            continue
        if j == MACD_SLOW - 1:
            ssum = ssum + x
            s = ssum / MACD_SLOW
        else:
            s = as_ * x + ks * s
        m = f - s
        # the wave of m's sign (0 keeps the previous sign; the wave starts where the sign changes)
        sgj = np.where(m > 0, 1, np.where(m < 0, -1, sg)).astype(np.int8)
        if j == MACD_SLOW - 1:
            wave_start[:] = j
        else:
            wave_start = np.where(sgj != sg, j, wave_start)
        sg = sgj
        am = np.abs(m)
        if j == p_from:
            P = am.copy()
        elif j > p_from:
            P = np.where(wave_start == j, am, np.maximum(P, am))
        # signal EMA of the MACD line (seeded at j = 33)
        if j < MACD_SLOW - 1 + MACD_SIG - 1:
            msum = m.copy() if j == MACD_SLOW - 1 else msum + m
            continue
        if j == MACD_SLOW - 1 + MACD_SIG - 1:
            msum = msum + m
            g = msum / MACD_SIG
        else:
            g = ag * m + kg * g
        h = m - g
        if j == WINDOW - 1:
            side_prev = side.copy()
        side = np.where(h > 0, 1, np.where(h < 0, -1, side)).astype(np.int8)
    # C1: 288 true ranges of the rounded mids, k = i-287 .. i, summed one at a time
    S = np.zeros(Wn)
    for q in range(TR_BARS):
        k0 = WINDOW - TR_BARS + q              # window index of k
        hk, lk, cp = H[k0:k0 + Wn], L[k0:k0 + Wn], c[k0 - 1:k0 - 1 + Wn]
        S = S + (np.maximum(hk, cp) - np.minimum(lk, cp))
    cross = (side_prev != 0) & (side != 0) & (side_prev != side)
    x = np.where(side == -1, m, -m)
    c0 = x > 0
    c1 = (S > 0) & ((4 * x) * 288 >= S)
    c2 = (2 * x) >= P
    fire = cross & c0 & c1 & c2
    idx = np.nonzero(fire)[0]
    return [(int(k) + WINDOW - 1, BUY if side[k] == 1 else SELL) for k in idx]


# ---------------------------------------------------------------- holes (6 ③) and the reasons (6)
def holes_of(bars, period):
    """6 ③ / §8.107 3: slots on the 5-minute grid in [S0, END); open = in the GMO week and >= 3 pairs have a bar
    starting there; per pair, runs of consecutive open slots without its bar (a slot not open, or one with its
    bar, ends a run); runs of >= 6 slots are holes [first, last + 5 min)."""
    slots = np.arange(period['s0'], period['end'], D.STEP, dtype=np.int64)
    week_open = ~possibly_closed_arr(slots)
    present = []
    for pb in bars:
        p = np.zeros(slots.size, dtype=bool)
        k = (pb.t - period['s0']) // D.STEP
        ok = (k >= 0) & (k < slots.size) & ((pb.t - period['s0']) % D.STEP == 0)
        p[k[ok]] = True
        present.append(p)
    count = np.zeros(slots.size, dtype=np.int64)
    for p in present:
        count += p
    open_slot = week_open & (count >= 3)
    holes = []
    for pb, p in zip(bars, present):
        miss = open_slot & ~p
        hs = []
        if miss.any():
            edges = np.diff(np.concatenate([[0], miss.astype(np.int8), [0]]))
            starts = np.nonzero(edges == 1)[0]
            ends = np.nonzero(edges == -1)[0]          # exclusive
            for a, b in zip(starts.tolist(), ends.tolist()):
                if b - a >= HOLE_SLOTS:
                    hs.append((int(slots[a]), int(slots[b - 1]) + D.STEP))
        holes.append(hs)
    return holes, int(open_slot.sum())


def in_hole(holes_pair, a, b):
    """A hole [x, y) overlapping [a, b)."""
    for x, y in holes_pair:
        if x < b and y > a:
            return True
    return False


def classify(pb, i, warmup, holes_pair, period, plant=''):
    """6 ①〜④ in this order (the first that hits): r1 period / warm-up, r2 not sent, r3 hole, r4 the 1,440th bar
    not closed by the half's end. Returns (reason, half or None)."""
    T = int(pb.t[i]) + D.STEP
    if T < period['start'] or T >= period['end'] or i < warmup:
        return 'r1', None
    if plant != 'countUnsent' and not D.sent(T):
        return 'r2', None
    if in_hole(holes_pair, int(pb.t[max(0, i - HOLE_LOOKBACK)]), T):
        return 'r3', None
    half = 'H1' if T < period['split'] else 'H2'
    half_end = period['split'] if half == 'H1' else period['end']
    if plant == 'allowCrossSplit' and half == 'H1':
        half_end = period['end']
    last = i + D.TRACK
    if last > pb.n - 1 or int(pb.t[last]) + D.STEP > half_end:
        return 'r4', None
    return 'counted', half


def blind_mask(pb, holes_pair, half, period):
    """8: the bars of the blind table of a half (①: the period only, ②, ③, ④ for that half)."""
    n = pb.n
    T = pb.t + D.STEP
    lo, hi = (period['start'], period['split']) if half == 'H1' else (period['split'], period['end'])
    m = (T >= lo) & (T < hi)
    m &= sent_arr(T)
    if holes_pair:
        a = pb.t[np.maximum(np.arange(n) - HOLE_LOOKBACK, 0)]
        for x, y in holes_pair:
            m &= ~((x < T) & (y > a))
    last = np.arange(n) + D.TRACK
    okl = last <= n - 1
    end_close = np.full(n, np.iinfo(np.int64).max)
    end_close[okl] = pb.t[last[okl]] + D.STEP
    m &= okl & (end_close <= hi)
    return m


# ---------------------------------------------------------------- every source's signals
ITEM_DEFS = {
    # id: (kind, warmup, pairs (None = all five), bothDirs, symmetric)
    'donchian-A20': dict(n=20, warmup=20, pairs=None),
    'donchian-A55': dict(n=55, warmup=55, pairs=None),
    'breedon-1': dict(warmup=0, pairs=('EUR/USD',)),
    'breedon-2': dict(warmup=0, pairs=('EUR/USD',)),
}


def item_pairs(src):
    if src in ITEM_DEFS:
        return ITEM_DEFS[src]['pairs'] or D.PAIRS
    return D.PAIRS


def item_warmup(src):
    return ITEM_DEFS[src]['warmup'] if src in ITEM_DEFS else 0


class Sig:
    __slots__ = ('src', 'pi', 'pair', 'i', 'T', 'dir', 'E', 'reason', 'half', 'marks')

    def __init__(self, src, pb, i, d, reason, half, marks):
        self.src, self.pi, self.pair, self.i = src, pb.pi, pb.pair, i
        self.T = int(pb.t[i]) + D.STEP
        self.dir = d
        self.E = float(pb.mc[i])
        self.reason, self.half, self.marks = reason, half, marks


def all_signals(bars, period, holes, o_mode=False, plant=''):
    """Every item's and measure's signals before ①〜④ with their reasons; the pre-filter counts; the late ULTRA."""
    sigs, pre, late, both = [], {}, {}, []
    for src in D.TRIAL_ITEMS + D.MEASURES:
        for pb in bars:
            if pb.pair not in item_pairs(src):
                continue
            cnt = {'bothSuppressed': 0, 'firstSkipped': 0, 'nullPrevSkipped': 0, 'late': 0}
            if src.startswith('donchian'):
                b, s, _ = donchian_tri(pb, ITEM_DEFS[src]['n'], plant)
                cands, c = events_of(b, s, plant)
                both.extend((src, pb.pair, int(pb.t[i]) + D.STEP) for i in c.pop('bothAt'))
                cnt.update(c)
                if o_mode and src == 'donchian-A20':
                    cands = answer_knowing(pb, cands)
            elif src.startswith('breedon'):
                b, s = breedon_tri(pb, src, plant)
                cands, c = events_of(b, s, plant)
                both.extend((src, pb.pair, int(pb.t[i]) + D.STEP) for i in c.pop('bothAt'))
                cnt.update(c)
            elif src == 'ultra5':
                cands, lt = ultra_signals(pb)
                cnt['late'] = len(lt)
                late[pb.pair] = lt
            else:
                cands = macdx_signals(pb)
            for i, d in cands:
                reason, half = classify(pb, i, item_warmup(src), holes[pb.pi], period, plant)
                marks = breedon_marks(int(pb.t[i]) + D.STEP) if src.startswith('breedon') else []
                sigs.append(Sig(src, pb, i, d, reason, half, marks))
            pre[(src, pb.pair)] = cnt
    sigs.sort(key=lambda x: (D.src_rank(x.src), x.pi, x.T, -x.dir))
    return sigs, pre, late, both
