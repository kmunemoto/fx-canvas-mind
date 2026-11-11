#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
chartbest-check-hand.py — the Python's own hand examples for docs/OPERATIONS.md §8.113 (20 (g)), written from the
docs (19, 8, 2, 6, 7, 11, 12, 14, 21) and never from the TS or research/chartbest/hand.json (hand.json's own cases
run through the Python's functions in chartbest-check-handjson.py, `--mode hand --hand research/chartbest/hand.json`):
  * c1.docs / c1.exact            19 C1 (n = 3, the 12 bars; the line exactly touched: no break)
  * k1.docs / k1.exact            19 K1 (2025-01-15 / 07-16 / 03-12; a bar at 02:50 and 03:00 but none at 02:55)
  * time.dst                      20 (g) 時刻: the switch dates and the breedon T of the plan's list
  * t.q                           8「自由度 1・9・17・71 で t(0.975) ＝ 12.7062047・2.2621572・2.1098156・1.9939434」
                                  and money-stats.ts's printed-table checks
  * delta.one                     20 (g)「Δ（合図が1件だけの層）」: Δ = 5/12, SE = 5/24, never √(7/192)
  * round / points                2「150.0625 → 150.063、150.10249999… → 150.102」「1.08445 → 108445」
  * sent, follow.*, mirror, hole, half, se.pick, shift, holm, select, groups, floor, suspect, text.*
Each case prints "ok   hand.<id>" or "FAIL hand.<id> ..."; the exit code is 0 only when every case passed.
--plant NAME (the Python twins of 20 (f)'s hand plants) runs the same cases with the error planted; a plant run
passes (exit 0) when at least one of the cases the plant names failed, else it fails ("書いた確かめでは見つから
なかった").
"""
import importlib.util
import math
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
S = _mod('signals')
ST = _mod('stats')
SEL = _mod('select')
TX = _mod('text')
CNT = _mod('count')
U = D.utc

# the planted errors the Python twins (20 (f)) and the cases each must make fail
PLANT_EXPECT = {
    'midHalfEven': ['round.1'], 'midShortestRepr': ['round.2'], 'pointsTrunc': ['points'],
    'hhIncludesI': ['c1.docs'], 'noRiseEdge': ['events.condition', 'c1.docs'],
    'londonDstAsNy': ['time.dst'], 'countUnsent': ['sent'], 'ambAsTp': ['follow.amb'],
    'buyExitAsk': ['follow.askAlone'], 'usdPip001': ['follow.usdLevel'], 'entryMid': ['follow.up'],
    'mirrorSameDir': ['mirror'], 'signalTermStratumMean': ['delta.one'], 'seNoBlindTerm': ['delta.one'],
    'shiftNoRing': ['shift'], 'noHolm': ['holm'], 'selectByPoint': ['select'], 'ignoreGroups': ['select'],
    'floorH1Only': ['floor'], 'allowCrossSplit': ['half'],
}


class Fail(Exception):
    pass


def check(cond, msg):
    if not cond:
        raise Fail(msg)


def bars_of(pair, times, mids=None, bid=None, ask=None, pi=None):
    """A PairBars from explicit prices: mids (o, h, l, c) with Bid = Ask = mid, or bid/ask lists of (o, h, l, c)."""
    if mids is not None:
        cols = [[m[k] for m in mids] for k in range(4)]
        bid, ask = cols, cols
    else:
        bid = [[x[k] for x in bid] for k in range(4)]
        ask = [[x[k] for x in ask] for k in range(4)]
    return D.PairBars(pair, D.PAIRS.index(pair) if pi is None else pi, times, bid, ask)


# ---------------------------------------------------------------- 19 C1
C1_BARS = [
    (100.000, 100.100, 99.900, 100.000), (100.000, 100.200, 99.950, 100.100), (100.100, 100.150, 99.950, 100.050),
    (100.050, 100.300, 100.000, 100.250), (100.250, 100.400, 100.200, 100.350), (100.350, 100.360, 100.100, 100.120),
    (100.120, 100.150, 99.980, 100.050), (100.050, 100.450, 100.040, 100.420), (100.420, 100.430, 99.800, 99.850),
    (99.850, 99.900, 99.700, 99.750), (99.750, 99.950, 99.740, 99.930), (99.930, 100.000, 99.900, 99.980),
]


def case_c1_docs(plant):
    t0 = U(2025, 1, 6, 1, 0)
    pb = bars_of('USD/JPY', [t0 + k * D.STEP for k in range(12)], mids=C1_BARS)
    buy, sell, s = S.donchian_tri(pb, 3, plant)
    check(s.tolist() == [0, 0, 0, 1, 1, 1, 1, 1, -1, -1, -1, -1], f'target {s.tolist()}')
    cands, _ = S.events_of(buy, sell, plant)
    check(cands == [(3, S.BUY), (8, S.SELL)], f'signals {cands}')


def case_c1_exact(plant):
    """C = HH and later C = LL exactly: no break (the lines are strict), no signal."""
    rows = [(100.000, 100.100, 99.900, 100.000), (100.000, 100.200, 99.950, 100.100),
            (100.100, 100.150, 99.950, 100.050), (100.050, 100.200, 100.000, 100.200),     # C = HH 100.200
            (100.200, 100.200, 99.990, 100.000), (100.000, 100.100, 99.950, 99.950)]       # C = LL 99.950
    pb = bars_of('USD/JPY', [U(2025, 1, 6, 1, 0) + k * D.STEP for k in range(6)], mids=rows)
    buy, sell, s = S.donchian_tri(pb, 3, plant)
    check(s.tolist() == [0] * 6, f'target {s.tolist()}')
    cands, _ = S.events_of(buy, sell, plant)
    check(cands == [], f'signals {cands}')


# ---------------------------------------------------------------- 19 K1
# SQ-P01: one bar (07:50 UTC) is put before the first listed bar so that the listed 07:55 bar is not bar 0, which
# 5 can never make a signal (no bar i-1); the answers are the docs' (spec-questions.md).
K1_TIMES = [U(2025, 1, 15, 7, 50), U(2025, 1, 15, 7, 55), U(2025, 1, 15, 15, 55),
            U(2025, 3, 12, 6, 55), U(2025, 3, 12, 15, 0),
            U(2025, 7, 16, 6, 55), U(2025, 7, 16, 7, 55), U(2025, 7, 16, 14, 55), U(2025, 7, 16, 15, 55)]


def k1_signals(times, plant):
    mids = [(1.1, 1.1, 1.1, 1.1)] * len(times)
    pb = bars_of('EUR/USD', times, mids=mids)
    out = {}
    for item in ('breedon-1', 'breedon-2'):
        b, s = S.breedon_tri(pb, item, plant)
        cands, _ = S.events_of(b, s, plant)
        out[item] = [(int(pb.t[i]) + D.STEP, d, S.breedon_marks(int(pb.t[i]) + D.STEP)) for i, d in cands]
    return out


def case_k1_docs(plant):
    got = k1_signals(K1_TIMES, plant)
    want1 = [(U(2025, 1, 15, 8, 0), S.SELL, []), (U(2025, 3, 12, 7, 0), S.SELL, ['shiftedWeek']),
             (U(2025, 7, 16, 7, 0), S.SELL, [])]
    want2 = [(U(2025, 1, 15, 16, 0), S.BUY, []), (U(2025, 7, 16, 15, 0), S.BUY, [])]
    check(got['breedon-1'] == want1, f'breedon-1 {got["breedon-1"]}')
    check(got['breedon-2'] == want2, f'breedon-2 {got["breedon-2"]}')


def case_k1_exact(plant):
    """Bars at 02:50 and 03:00 New York (winter: 07:50, 08:00 UTC) but none at 02:55: nothing, and the signal is not
    moved to the next bar."""
    times = [U(2025, 1, 15, 7, 45), U(2025, 1, 15, 7, 50), U(2025, 1, 15, 8, 0), U(2025, 1, 15, 15, 50),
             U(2025, 1, 15, 16, 0)]
    got = k1_signals(times, plant)
    check(got['breedon-1'] == [] and got['breedon-2'] == [], f'{got}')


# ---------------------------------------------------------------- 20 (g) 時刻 (the plan's list, IANA-checked)
DST_DAYS = [  # (y, m, d, season, breedon-1 T hour, breedon-2 T hour)
    (2024, 3, 8, 'WW', 8, 16), (2024, 3, 11, 'SW', 7, 15), (2024, 3, 29, 'SW', 7, 15), (2024, 4, 1, 'SS', 7, 15),
    (2024, 10, 25, 'SS', 7, 15), (2024, 10, 28, 'SW', 7, 15), (2024, 11, 1, 'SW', 7, 15), (2024, 11, 4, 'WW', 8, 16),
    (2025, 3, 7, 'WW', 8, 16), (2025, 3, 10, 'SW', 7, 15), (2025, 3, 28, 'SW', 7, 15), (2025, 3, 31, 'SS', 7, 15),
    (2025, 10, 24, 'SS', 7, 15), (2025, 10, 27, 'SW', 7, 15), (2025, 10, 31, 'SW', 7, 15), (2025, 11, 3, 'WW', 8, 16),
]
SWITCHES = {  # 20 (g): the switch dates (London 01:00 UTC, New York 07:00 / 06:00 UTC)
    'ny': [(U(2024, 3, 10, 7), U(2024, 11, 3, 6)), (U(2025, 3, 9, 7), U(2025, 11, 2, 6))],
    'ldn': [(U(2024, 3, 31, 1), U(2024, 10, 27, 1)), (U(2025, 3, 30, 1), U(2025, 10, 26, 1))],
}


def case_time_dst(plant):
    for a, b in SWITCHES['ny']:
        check(not D.ny_summer(a - 1) and D.ny_summer(a) and D.ny_summer(b - 1) and not D.ny_summer(b), f'NY {a} {b}')
    for a, b in SWITCHES['ldn']:
        check(not D.london_summer(a - 1) and D.london_summer(a) and D.london_summer(b - 1) and not D.london_summer(b),
              f'London {a} {b}')
    for y, m, d, season, h1, h2 in DST_DAYS:
        times = [U(y, m, d, h, mi) for h, mi in ((6, 50), (6, 55), (7, 55), (14, 55), (15, 55))]
        got = k1_signals(times, plant)
        t1 = [T for T, _, _ in got['breedon-1']]
        t2 = [T for T, _, _ in got['breedon-2']]
        check(t1 == [U(y, m, d, h1)] and t2 == [U(y, m, d, h2)], f'{y}-{m}-{d}: {t1} {t2}')
        check(D.SEASON_NAMES[D.season_of(U(y, m, d, h1))] == season, f'{y}-{m}-{d} season')


# ---------------------------------------------------------------- 8 t / money-stats' table
def case_t_q(plant):
    for df, want in ((1, 12.7062047), (9, 2.2621572), (17, 2.1098156), (71, 1.9939434)):
        got = ST.tq(0.975, df)
        check(abs(got - want) < 5e-8, f't(0.975, {df}) = {got}')
    for p, df, want in ((0.975, 2, 4.303), (0.975, 10, 2.228), (0.995, 10, 3.169), (0.95, 5, 2.015),
                        (0.9975, 17, 3.222), (0.975, 1e6, 1.960)):
        check(abs(ST.tq(p, df) - want) < 1e-3, f't({p}, {df})')
    for df in (1, 9, 17, 71):
        q = ST.tq(0.975, df)
        check(abs(ST.tcdf(q, df) - 0.975) < 1e-12, f'tcdf(t(0.975, {df}))')
        check(abs(ST.tcdf(-q, df) - 0.025) < 1e-12, f'tcdf(-t, {df})')


# ---------------------------------------------------------------- 20 (g) Δ（合図が1件だけの層）
def case_delta_one(plant):
    sig = [(0, 1, 0, 0.5), (1, 2, 0, 0.5), (1, 3, 0, -0.5)]               # (stratum A=0/B=1, week, block, e/2)
    blind = {0: [(1, 0.0), (2, -0.5)], 1: [(2, 0.0), (3, -0.5)]}
    bstr = {}
    for s, rows in blind.items():
        m = len(rows)
        acc = 0.0
        for _, v in rows:
            acc += v
        mean = acc / m
        wk = {}
        for w, v in rows:
            x = wk.get(w)
            wk[w] = (v, 1) if x is None else (x[0] + v, x[1] + 1)
        bstr[s] = (m, mean, wk, {0: (acc, m)})
    if plant == 'signalTermStratumMean':
        est = _delta_stratum_mean_form(sig, bstr)
    elif plant == 'seNoBlindTerm':
        est = ST.strip(ST._delta_no_blind_term(sig, bstr))
    else:
        est = ST.strip(ST.delta_est(sig, bstr))
    check(abs(est['est'] - 5 / 12) < 1e-15, f'Δ {est["est"]}')
    week = next(c for c in est['cands'] if c['kind'] == 'week')
    check(week['C'] == 3 and week['df'] == 2, f'C {week}')
    check(abs(week['se'] - 5 / 24) < 1e-15, f'SE {week["se"]}')
    check(abs(week['se'] - math.sqrt(7 / 192)) > 1e-3, 'the stratum-mean form')
    check(all(c['kind'] != '4w' for c in est['cands']), '4w with fewer than 10 blocks')
    _, _, _, _, wk, _, _ = ST.delta_core(sig, bstr)
    for g, want in ((1, 5 / 72), (2, 5 / 72), (3, -5 / 36)):
        check(abs(wk[g] - want) < 1e-15, f'S_{g} {wk[g]}')


def _delta_stratum_mean_form(sig, bstr):
    """Planted error 'signalTermStratumMean' twin: the signal's influence (y_i - signal mean_s) / N (§8.107 7's)."""
    est, N, nst, dropped, wk, bk, ns = ST.delta_core(sig, bstr)
    by = {}
    for o in sig:
        by.setdefault(o[0], []).append(o[3])
    mean = {s: sum(v) / len(v) for s, v in by.items()}
    w2 = {}
    for o in sig:
        w2[o[1]] = w2.get(o[1], 0.0) + (o[3] - mean[o[0]]) / N
    for s in ns:
        m, bm, wsum, _ = bstr[s]
        w = -(ns[s] / N) / m
        for g, (sv, cnt) in wsum.items():
            w2[g] = w2.get(g, 0.0) + w * (sv - bm * cnt)
    cands = [ST._cand('week', ST._se(w2, len(w2)), len(w2))]
    return ST.strip(ST.finish(est, N, nst, dropped, cands))


# ---------------------------------------------------------------- 2 rounding and points
def _round_planted(v, plant):
    if plant == 'midHalfEven':
        return round(v, 3)
    if plant == 'midShortestRepr':
        from decimal import ROUND_HALF_UP, Decimal
        return float(Decimal(str(v)).quantize(Decimal('0.001'), rounding=ROUND_HALF_UP))
    return D.chart_round(v, 3)


def case_round_1(plant):
    v = (150.060 + 150.065) / 2
    check(v == 150.0625, 'the double')
    check(D.price_str(_round_planted(v, plant), 3) == '150.063', 'rounded')


def case_round_2(plant):
    v = (150.100 + 150.105) / 2
    check(D.price_str(_round_planted(v, plant), 3) == '150.102', 'rounded')


def case_points(plant):
    v = 1.08445
    got = int(v * 100000) if plant == 'pointsTrunc' else D.points_of(v, 'EUR/USD')
    check(got == 108445, f'{got}')


# ---------------------------------------------------------------- 6 ② sent
def case_sent(plant):
    def ok(T):
        return True if plant == 'countUnsent' else D.sent(T)
    # 2024-03-08 is a Friday, 03-09 Saturday, 03-10 Sunday
    check(ok(U(2024, 3, 8, 20, 55)), 'Fri 20:55')
    check(not ok(U(2024, 3, 8, 21, 0)), 'Fri 21:00')
    check(not ok(U(2024, 3, 10, 21, 55)), 'Sun 21:55')
    check(ok(U(2024, 3, 10, 22, 0)), 'Sun 22:00')
    check(not ok(U(2024, 3, 9, 12, 0)), 'Sat')


# ---------------------------------------------------------------- 7 follow / 8 mirror
def _follow_one(pair, entry_bar, bars_after, buy, tp_pips, plant=''):
    """One trade: bar 0 the signal bar (bid, ask OHLC), then the bars followed. Returns (kind, pips, bars)."""
    times = [U(2025, 1, 6, 1, 0) + k * D.STEP for k in range(1 + len(bars_after))]
    bid = [entry_bar[0]] + [b for b, _ in bars_after]
    ask = [entry_bar[1]] + [a for _, a in bars_after]
    pb = bars_of(pair, times, bid=bid, ask=ask)
    E = pb.mc[0]
    d = S.BUY if buy else S.SELL
    pip = pb.pip if plant != 'usdPip001' else 0.01
    sl, tp = ST.levels(np.array([E]), d, tp_pips, pip)
    kind, ex, nb, _ = ST.follow_many(pb, np.array([1]), buy, sl, tp, plant)
    fill = (pb.ac[0] if buy else pb.bc[0]) if plant != 'entryMid' else pb.mc[0]
    pips = (ex[0] - fill) / pip if buy else (fill - ex[0]) / pip
    return ST.KIND_LETTER[int(kind[0])], float(pips), int(nb[0])


def _flat(p):
    return (p, p, p, p)


def case_follow_up(plant):
    # USD/JPY: mid 150.000 (bid 149.995, ask 150.005); BUY TP10 at 150.100 on the bid
    k, p, n = _follow_one('USD/JPY', (_flat(149.995), _flat(150.005)),
                          [((149.995, 150.050, 149.990, 150.040), (150.005, 150.060, 150.000, 150.050)),
                           ((150.040, 150.110, 150.030, 150.100), (150.050, 150.120, 150.040, 150.110))], True, 10, plant)
    check((k, n) == ('t', 2) and abs(p - 9.5) < 1e-9, f'{k} {p} {n}')


def case_follow_down(plant):
    k, p, n = _follow_one('USD/JPY', (_flat(149.995), _flat(150.005)),
                          [((149.995, 150.000, 149.900, 149.910), (150.005, 150.010, 149.910, 149.920)),
                           ((149.910, 149.920, 149.860, 149.880), (149.920, 149.930, 149.870, 149.890))], True, 10, plant)
    check((k, n) == ('s', 2) and abs(p - (-13.5)) < 1e-9, f'{k} {p} {n}')


def case_follow_open_past(plant):
    # opening below the stop: out at the open (149.800 < 149.870)
    k, p, n = _follow_one('USD/JPY', (_flat(149.995), _flat(150.005)),
                          [((149.800, 149.900, 149.790, 149.850), (149.810, 149.910, 149.800, 149.860))], True, 10, plant)
    check((k, n) == ('s', 1) and abs(p - (-20.5)) < 1e-9, f'{k} {p} {n}')
    # opening above TP: out at the open (150.200 > 150.100)
    k, p, n = _follow_one('USD/JPY', (_flat(149.995), _flat(150.005)),
                          [((150.200, 150.250, 150.150, 150.180), (150.210, 150.260, 150.160, 150.190))], True, 10, plant)
    check((k, n) == ('t', 1) and abs(p - 19.5) < 1e-9, f'{k} {p} {n}')


def case_follow_amb(plant):
    k, p, n = _follow_one('USD/JPY', (_flat(149.995), _flat(150.005)),
                          [((150.000, 150.150, 149.850, 150.000), (150.010, 150.160, 149.860, 150.010))], True, 10, plant)
    check((k, n) == ('a', 1) and abs(p - (-13.5)) < 1e-9, f'{k} {p} {n}')


def case_follow_exact(plant):
    # the bid's high exactly at TP 150.100 (comparisons with equality)
    k, p, n = _follow_one('USD/JPY', (_flat(149.995), _flat(150.005)),
                          [((150.000, 150.100, 149.990, 150.050), (150.010, 150.110, 150.000, 150.060))], True, 10, plant)
    check((k, n) == ('t', 1) and abs(p - 9.5) < 1e-9, f'{k} {p} {n}')


def case_follow_ask_alone(plant):
    # only the ask reaches 150.100 on a BUY: the bid (the side it leaves on) does not, nothing happens
    k, p, n = _follow_one('USD/JPY', (_flat(149.995), _flat(150.005)),
                          [((150.000, 150.090, 149.990, 150.050), (150.010, 150.100, 150.000, 150.060))] +
                          [(_flat(150.000), _flat(150.010))] * 1439, True, 10, plant)
    check((k, n) == ('o', 1440), f'{k} {p} {n}')


def case_follow_open(plant):
    # 1,440 bars without either: out at the 1,440th close; a 1,441st bar (past TP) is never read
    after = [(_flat(150.000), _flat(150.010))] * 1439 + [((150.000, 150.020, 149.990, 150.020), (150.010, 150.030, 150.000, 150.030))]
    after.append((_flat(151.000), _flat(151.010)))
    k, p, n = _follow_one('USD/JPY', (_flat(149.995), _flat(150.005)), after, True, 10, plant)
    check((k, n) == ('o', 1440) and abs(p - 1.5) < 1e-9, f'{k} {p} {n}')


def case_follow_usd_level(plant):
    # EUR/USD mid 1.16427 (bid 1.16422, ask 1.16432): SELL TP4 at 1.16387 on the ask, reached exactly
    k, p, n = _follow_one('EUR/USD', (_flat(1.16422), _flat(1.16432)),
                          [((1.16420, 1.16425, 1.16380, 1.16390), (1.16430, 1.16435, 1.16387, 1.16400))], False, 4, plant)
    check((k, n) == ('t', 1) and abs(p - (1.16422 - 1.16387) / 0.0001) < 1e-9, f'{k} {p} {n}')


def case_follow_gap(plant):
    # after a weekend (a gap in the times): the next bar's open decides
    times = [U(2024, 3, 8, 20, 50), U(2024, 3, 10, 22, 0)]
    pb = bars_of('USD/JPY', times, bid=[_flat(149.995), (149.700, 149.800, 149.650, 149.700)],
                 ask=[_flat(150.005), (149.710, 149.810, 149.660, 149.710)])
    sl, tp = ST.levels(np.array([pb.mc[0]]), S.BUY, 10, pb.pip)
    pb2 = bars_of('USD/JPY', times + [times[-1] + k * D.STEP for k in range(1, 1440)],
                  bid=[_flat(149.995), (149.700, 149.800, 149.650, 149.700)] + [_flat(149.7)] * 1439,
                  ask=[_flat(150.005), (149.710, 149.810, 149.660, 149.710)] + [_flat(149.71)] * 1439)
    kind, ex, nb, _ = ST.follow_many(pb2, np.array([1]), True, sl, tp, plant)
    check(ST.KIND_LETTER[int(kind[0])] == 's' and ex[0] == 149.700 and nb[0] == 1, f'{kind} {ex} {nb}')


def case_mirror(plant):
    """8: e = y10(signal) - y10(mirror): +1, 0, -1 (a SELL row's e is the BUY row's with the sign changed)."""
    def table_e(after):
        after = after + [(_flat(150.000), _flat(150.010))] * D.TRACK          # the 1,440 bars ④ guarantees
        times = [U(2025, 1, 6, 1, 0) + k * D.STEP for k in range(1 + len(after))]
        bid = [_flat(149.995)] + [b for b, _ in after]
        ask = [_flat(150.005)] + [a for _, a in after]
        pb = bars_of('USD/JPY', times, bid=bid, ask=ask)
        period = dict(D.PERIODS['main'])
        bp = ST.BlindPair(pb, np.array([0]), 'H2', period, plant)
        return bp.e(0, S.BUY), bp.e(0, S.SELL)
    up = [((150.000, 150.120, 149.990, 150.110), (150.010, 150.130, 150.000, 150.120))]
    check(table_e(up) == (1, -1), f'up {table_e(up)}')
    dn = [((149.990, 150.000, 149.860, 149.890), (150.000, 150.010, 149.870, 149.900))]
    check(table_e(dn) == (-1, 1), f'down {table_e(dn)}')
    both = [((150.000, 150.200, 149.700, 150.000), (150.010, 150.210, 149.710, 150.010))]
    check(table_e(both) == (0, 0), f'both {table_e(both)}')


# ---------------------------------------------------------------- 6 ③ holes, 1 / 6 ④ halves
def _hole_world(missing):
    """Five pairs with a bar every 5 minutes of 2024-03-05 (a Tuesday) 00:00-02:00; the first pair misses the slots
    given."""
    period = dict(D.PERIODS['main'], s0=U(2024, 3, 5), end=U(2024, 3, 5, 2))
    slots = [U(2024, 3, 5) + k * D.STEP for k in range(24)]
    bars = []
    for pi, pair in enumerate(D.PAIRS):
        ts = [t for k, t in enumerate(slots) if not (pi == 0 and k in missing)]
        bars.append(bars_of(pair, ts, mids=[(1.1, 1.1, 1.1, 1.1)] * len(ts)))
    return bars, period


def case_hole(plant):
    bars, period = _hole_world(set(range(5, 11)))          # 6 slots
    holes, _ = S.holes_of(bars, period)
    check(holes[0] == [(U(2024, 3, 5, 0, 25), U(2024, 3, 5, 0, 55))], f'6: {holes[0]}')
    bars, period = _hole_world(set(range(5, 10)))          # 5 slots
    holes, _ = S.holes_of(bars, period)
    check(holes[0] == [], f'5: {holes[0]}')
    # 3 + a slot not open (fewer than 3 pairs have a bar there) + 3
    bars, period = _hole_world({5, 6, 7, 9, 10, 11})
    for pi in (1, 2, 3):
        pb = bars[pi]
        keep = [k for k in range(pb.n) if int(pb.t[k]) != U(2024, 3, 5, 0, 40)]
        bars[pi] = bars_of(pb.pair, [int(pb.t[k]) for k in keep], mids=[(1.1, 1.1, 1.1, 1.1)] * len(keep))
    holes, _ = S.holes_of(bars, period)
    check(holes[0] == [], f'3+3: {holes[0]}')
    # a signal whose 10 newest bars' span [t[i-9], T) meets the hole is r3; one starting after it is not
    hs = [(U(2024, 3, 5, 0, 25), U(2024, 3, 5, 0, 55))]
    check(S.in_hole(hs, U(2024, 3, 5, 0, 50), U(2024, 3, 5, 1, 45)), 'overlap at the start')
    check(not S.in_hole(hs, U(2024, 3, 5, 0, 55), U(2024, 3, 5, 1, 50)), 'starting at the hole end')


def case_half(plant):
    """T = SPLIT - 5 min with its window crossing SPLIT: r4; T = SPLIT: H2; a window whose 1,440th bar closes exactly
    at SPLIT: H1."""
    period = D.PERIODS['main']
    sp = period['split']
    n = 4000
    t0 = sp - 2000 * D.STEP
    times = [t0 + k * D.STEP for k in range(n)]                # continuous bars (the clock only)
    pb = bars_of('USD/JPY', times, mids=[(150.0, 150.0, 150.0, 150.0)] * n)
    i = 2000 - 2                                                # T = SPLIT - 5 min
    r, h = S.classify(pb, i, 0, [], period, plant)
    check((r, h) == ('r4', None), f'crossing: {r} {h}')
    i = 2000 - 1                                                # T = SPLIT
    r, h = S.classify(pb, i, 0, [], period, plant)
    check((r, h) == ('counted', 'H2'), f'at SPLIT: {r} {h}')
    i = 2000 - 1 - 1440                                         # the 1,440th bar closes at SPLIT
    r, h = S.classify(pb, i, 0, [], period, plant)
    check((r, h) == ('counted', 'H1'), f'closing at SPLIT: {r} {h}')


# ---------------------------------------------------------------- 8 the SE's choice, the week shift
def case_se_pick(plant):
    c = [{'kind': 'week', 'half': 1.0}, {'kind': '4w', 'half': 1.0}, {'kind': 'shift', 'half': 0.9}]
    check(ST.pick(c)['kind'] == 'week', 'tie: week first')
    c = [{'kind': 'week', 'half': 1.0}, {'kind': '4w', 'half': 1.2}, {'kind': 'shift', 'half': 1.2}]
    check(ST.pick(c)['kind'] == '4w', 'tie: 4w before shift')


def case_shift(plant):
    """8: a ring over the half's weeks; a moved bar absent from the table drops the signal; SD two-pass."""
    W = [10, 11, 12, 13]
    j = W.index(13)
    moved = [(j + k) % len(W) if plant != 'shiftNoRing' else j + k for k in (1, 2, 3)]
    check(all(0 <= m < len(W) for m in moved) and [W[m] for m in moved] == [10, 11, 12], f'ring {moved}')
    check(abs(ST.sd2([1.0, 2.0, 4.0]) - math.sqrt(7 / 3)) < 1e-15, 'sd')
    check(ST.quantile([5, 1, 3, 2, 4], 0.975) == 4, 'quantile floor(q(n-1))')


# ---------------------------------------------------------------- 14 Holm, 12 the choice, 11 groups and floor
def _row(est, se, df, nE=100, susp=()):
    half = ST.tq(0.975, df) * se
    return {'delta': {'est': est, 't': est / se if se else None, 'lb': est - half, 'lo': est - half, 'hi': est + half,
                      'cands': [{'kind': 'week', 'se': se, 'C': df + 1, 'df': df, 'half': half}], 'use': 'week', 'N': nE},
            'nE': nE, 'suspicious': list(susp)}


def case_holm(plant):
    rows = {'donchian-A20': _row(0.05, 0.01, 71), 'donchian-A55': _row(0.03, 0.01, 71),
            'breedon-1': _row(0.02, 0.01, 71), 'breedon-2': _row(0.01, 0.01, 71)}
    h = SEL.holm(list(rows), rows, plant)
    check([h[s]['holmRank'] for s in ('donchian-A20', 'donchian-A55', 'breedon-1', 'breedon-2')] == [1, 2, 3, 4], 'order')
    # p: 5.0 sigma, 3.0, 2.0, 1.0: limits 0.025/4, /3, /2, /1 -> pass, pass, fail (p 0.0247 > 0.0125), stop
    check([h[s]['holmPass'] for s in ('donchian-A20', 'donchian-A55', 'breedon-1', 'breedon-2')] == [True, True, False, False],
          f'{[(s, h[s]) for s in h]}')
    rows['breedon-2'] = {'delta': {'est': 0.01, 't': None, 'lb': None, 'lo': None, 'hi': None, 'cands': [], 'use': None},
                         'nE': 10, 'suspicious': []}
    h = SEL.holm(list(rows), rows, plant)
    check(h['breedon-2']['p'] == 1.0 and h['breedon-2']['holmRank'] == 4, 'no t: p = 1, last')


def case_select(plant):
    rows = {'donchian-A20': _row(0.08, 0.03, 71, 300), 'donchian-A55': _row(0.06, 0.01, 71, 200),
            'breedon-1': _row(0.02, 0.005, 71, 300), 'breedon-2': _row(0.04, 0.005, 71, 300, susp=('w1',))}
    groups = {'donchian-A20': 0, 'donchian-A55': 0, 'breedon-1': 52, 'breedon-2': 52}
    if plant == 'ignoreGroups':
        groups = {k: D.ORDER[k] for k in groups}
    if plant == 'selectByPoint':
        for r in rows.values():
            r['delta']['lb'] = r['delta']['est']
    s1 = SEL.stage1(rows, groups)
    # A55: LB 0.06 - 1.99 x 0.01 = 0.040 > A20: 0.08 - 1.99 x 0.03 = 0.020 (the point would pick A20); one per
    # group (A20 and A55 share one); breedon-2 is suspicious
    check(s1['chosen'] == {'chart': ['donchian-A55'], 'cal': ['breedon-1']}, f'{s1["chosen"]}')
    check(s1['notEligible'] == {'breedon-2': 'suspicious'}, f'{s1["notEligible"]}')


def case_groups(plant):
    """11: A-C and C-B >= 0.5, A-B < 0.5, C below the floor: A and B apart (C is not passed through)."""
    class Sg:
        def __init__(self, src, T):
            self.src, self.pi, self.dir, self.T, self.reason, self.half = src, 0, S.BUY, T, 'counted', 'H1'
    t = U(2024, 3, 5)
    by = {'donchian-A20': [Sg('donchian-A20', t), Sg('donchian-A20', t + 2 * D.HOUR)],
          'breedon-1': [Sg('breedon-1', t + 4 * D.HOUR), Sg('breedon-1', t + 6 * D.HOUR)],
          'breedon-2': [Sg('breedon-2', t + 10 * D.MIN), Sg('breedon-2', t + 4 * D.HOUR + 10 * D.MIN)]}
    share, groups = CNT.overlap_groups(['donchian-A20', 'breedon-1'], by)
    check(share['donchian-A20>breedon-1'] == 0.0 and groups['donchian-A20'] != groups['breedon-1'], f'{share} {groups}')


def case_floor(plant):
    def ok(h1, h2):
        if plant == 'floorH1Only':
            return h1[0] >= D.FLOOR_N and h1[1] >= D.FLOOR_WEEKS
        return all(n >= D.FLOOR_N and w >= D.FLOOR_WEEKS for n, w in (h1, h2))
    check(ok((300, 30), (300, 30)), '300/30 passes')
    check(not ok((299, 30), (300, 30)) and not ok((300, 29), (300, 30)), 'one short in H1 fails')
    check(not ok((300, 30), (299, 30)), 'one short in H2 fails')


def case_suspect(plant):
    def row(**k):
        base = {'delta': {'est': 0.0}, 'a': {'est': 0.0}, 'late': {'est': 0.0},
                'w4': {'resolved': 100, 'wRes': 0.75, 'wAll': 0.74, 'pl': 0.0},
                'w10': {'resolved': 100, 'wRes': 0.55, 'wAll': 0.54, 'pl': 0.0}}
        for key, v in k.items():
            part, name = key.split('_')
            base[part][name] = v
        return base
    check(ST.suspicious(row()) == [], 'nothing')
    check(ST.suspicious(row(delta_est=0.10, late_est=0.10)) == ['delta'], 'Δ exactly 10 points')
    check(ST.suspicious(row(delta_est=0.0999, late_est=0.0999)) == [], 'just below')
    check(ST.suspicious(row(w10_wRes=0.80)) == ['w2'], 'W2 80%')
    check(ST.suspicious(row(w4_wRes=0.90)) == ['w1'], 'W1 90%')
    check(ST.suspicious(row(w4_pl=1.0)) == ['pl1'] and ST.suspicious(row(w10_pl=3.0)) == ['pl2'], 'PL lines')
    check(ST.suspicious(row(late_est=-0.05)) == ['lateGap'], '|Δ - Δ_late| 5 points')
    few = row(delta_est=0.5)
    few['w10']['resolved'] = 99
    check(ST.suspicious(few) == [], 'under 100 resolved')


# ---------------------------------------------------------------- 21 numbers and sentences
def case_text_numbers(plant):
    m = TX.TEXT_MINUS
    check(TX.pts(0.0525) == '+5.3' and TX.pts(-0.0004) == '+0.0' and TX.pts(-0.0005) == m + '0.1', 'points')
    check(TX.pips(-0.004) == '+0.00' and TX.pips(1.005) == '+1.00' and TX.pips(-1.235) == m + '1.24', 'pips')
    check(TX.pct(0.7650) == '76.5%' and TX.pct(0.12345) == '12.3%', 'percent')
    check(TX.yen(-966892, sign=True) == m + '966,892' and TX.yen(1000000) == '1,000,000', 'yen')


def _dab_case(dA, seA, dB, seB):
    K = 4
    df = 100000
    q1 = ST.tq(1 - D.ALPHA / K, df)
    lbA, lbB = dA - q1 * seA, dB - q1 * seB
    se = math.sqrt(seA ** 2 + seB ** 2)
    half = ST.tq(0.975, df) * se
    est = {'est': dA - dB, 'lo': dA - dB - half, 'hi': dA - dB + half}
    st2 = {'promote': {'chart': 'donchian-A20'}, 'dAB': [{'A': 'donchian-A20', 'B': 'donchian-A55', 'est': est}]}
    return lbA, lbB, se, est, TX._dab_text(st2, 'chart')


def case_text_dab(plant):
    lbA, lbB, se, est, text = _dab_case(0.030, 0.005, 0.060, 0.018)
    check(abs(lbA - 0.0175) < 5e-5 and abs(lbB - 0.0150) < 5e-5 and lbA > lbB, f'LB {lbA} {lbB}')
    check(abs(se - 0.0186815) < 5e-8, f'SE {se}')
    check(TX.pts(est['lo']) == TX.TEXT_MINUS + '6.7' and TX.pts(est['hi']) == '+0.7', 'interval')
    check('この数では決められません' in text, text)
    lbA, lbB, se, est, text = _dab_case(0.015, 0.003, 0.057, 0.020)
    check(abs(lbA - 0.0075) < 5e-5 and abs(lbB - 0.0070) < 5e-5 and lbA > lbB, f'LB {lbA} {lbB}')
    check(abs(se - 0.0202237) < 5e-8, f'SE {se}')
    check(TX.pts(est['lo']) == TX.TEXT_MINUS + '8.2' and TX.pts(est['hi']) == TX.TEXT_MINUS + '0.2', 'interval')
    check('donchian-A55の方がdonchian-A20より当たると言えます' in text, text)


def case_events_condition(plant):
    """5: consecutive trues -> the first only; 'none' then true -> no signal; 'does not hold' then true -> signal;
    the first determined bar never signals."""
    tri = np.array([-1, -1, 1, 0, 1, 1, 1, 0, 1, -1, 1], dtype=np.int8)
    cands, c = S.events_of(tri, np.zeros(tri.size, dtype=np.int8) - 1, plant)
    check([i for i, _ in cands] == [4, 8], f'{cands}')
    check(c['firstSkipped'] == 1 and c['nullPrevSkipped'] == 1, f'{c}')


def case_events_always(plant):
    """5 常に持つ型: 0 -> +1, +1 -> -1, +1 -> 0 -> +1 are signals; d -> 0 is not."""
    s = np.array([0, 0, 1, 1, -1, -1, 0, 1, 1], dtype=np.int8)
    buy, sell = (s == 1).astype(np.int8), (s == -1).astype(np.int8)
    cands, _ = S.events_of(buy, sell, plant)
    check(cands == [(2, S.BUY), (4, S.SELL), (7, S.BUY)], f'{cands}')


def case_events_both(plant):
    buy = np.array([0, 1, 0, 1], dtype=np.int8)
    sell = np.array([0, 1, 0, 0], dtype=np.int8)
    cands, c = S.events_of(buy, sell, plant)
    check(cands == [(3, S.BUY)] and c['bothSuppressed'] == 1, f'{cands} {c}')


CASES = [
    ('c1.docs', case_c1_docs), ('c1.exact', case_c1_exact), ('k1.docs', case_k1_docs), ('k1.exact', case_k1_exact),
    ('time.dst', case_time_dst), ('t.q', case_t_q), ('delta.one', case_delta_one),
    ('round.1', case_round_1), ('round.2', case_round_2), ('points', case_points), ('sent', case_sent),
    ('follow.up', case_follow_up), ('follow.down', case_follow_down), ('follow.openPast', case_follow_open_past),
    ('follow.amb', case_follow_amb), ('follow.exact', case_follow_exact), ('follow.askAlone', case_follow_ask_alone),
    ('follow.open', case_follow_open), ('follow.usdLevel', case_follow_usd_level), ('follow.gap', case_follow_gap),
    ('mirror', case_mirror), ('hole', case_hole), ('half', case_half), ('se.pick', case_se_pick), ('shift', case_shift),
    ('holm', case_holm), ('select', case_select), ('groups', case_groups), ('floor', case_floor),
    ('suspect', case_suspect), ('text.numbers', case_text_numbers), ('text.dab', case_text_dab),
    ('events.condition', case_events_condition), ('events.always', case_events_always), ('events.both', case_events_both),
]


def main(plant=''):
    failed = []
    for name, fn in CASES:
        try:
            fn(plant)
            print(f'ok   hand.{name}')
        except Fail as e:
            failed.append(name)
            print(f'FAIL hand.{name} ({e})')
        except Exception as e:  # noqa: BLE001 — a crash of a case is its failure
            failed.append(name)
            print(f'FAIL hand.{name} (crash {e!r})')
    if plant:
        want = PLANT_EXPECT.get(plant)
        if want is None:
            print(f'unknown plant {plant}')
            return 2
        hit = [x for x in want if x in failed]
        print(f'plant {plant}: failed {failed}; expected one of {want}: {"caught" if hit else "書いた確かめでは見つからなかった"}')
        return 0 if hit else 1
    print(f'hand: {len(CASES) - len(failed)} of {len(CASES)} passed')
    return 0 if not failed else 1
