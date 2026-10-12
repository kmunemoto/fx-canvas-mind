#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
chartbest-check-handjson.py — the hand examples of research/chartbest/hand.json (docs/OPERATIONS.md §8.113 19 C1 and
K1, 20 (g)) run through the independent Python's own functions, so that every hand example is checked on both sides
(20 (g)「TS と Python の両方」). hand.json holds made-up inputs and answers derived by hand from the rule; this file
only lays out each case's inputs as the case describes them and compares the Python's results with the written
answers. It reads no TS file. The Python's own docs-derived cases (chartbest-check-hand.py) run as well.

How a case's inputs are laid out (hand.json's conventions, stated in its "why" texts):
  * mids: a bar whose bid and ask are the mid (the chart's mid is the mid itself);
  * follow: the signal bar's bid / ask closes 149.995 / 150.005 (E 150.000) unless the case gives signalBid /
    signalAsk; the bars after it from the case's bid rows, the ask a fixed spread above (0.005 for a yen pair,
    0.00004 otherwise, or the case's spread); 1,441 bars after the signal bar unless the case gives a count, padded
    with a filler bar (150.000 / 150.020 / 149.980 / 150.000 for a yen pair, 1.16430 / 1.16450 / 1.16400 / 1.16430
    otherwise, or the case's filler), then the case's tail and after; the signal bar opens 2025-01-06 01:00 UTC
    (or signalAt), the next one 5 minutes later (or followAt);
  * the made-up rows of the selection, Holm and the sentences: an estimate with standard error se on df + 1 week
    clusters (influence sums ± se·√(C−1)/C in the "alt" pattern +,−,+,−… or the "pairs" pattern +,+,−,−…, which
    are uncorrelated), N = 100 e-signals, 200 resolved trades, the blind's W1 70% and PL1 −1.00 pips.
"""
import calendar
import importlib.util
import math
import os
import sys
import time
import types

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

MINI = D.PERIODS['mini']
DEFAULT_START = '2025-01-06T01:00:00Z'
SIGNAL_BID, SIGNAL_ASK = 149.995, 150.005
SPREAD = {True: 0.005, False: 0.00004}
FILLER = {True: [150.0, 150.02, 149.98, 150.0], False: [1.1643, 1.1645, 1.164, 1.1643]}
FOLLOW_COUNT = 1441
KIND_OF = {'tp': ST.KIND_TP, 'sl': ST.KIND_SL, 'amb': ST.KIND_AMB, 'open': ST.KIND_OPEN}
NAME_OF_KIND = {v: k for k, v in KIND_OF.items()}
DIRS = {'BUY': S.BUY, 'SELL': S.SELL}


# ---------------------------------------------------------------- helpers
def ms(iso):
    return calendar.timegm(time.strptime(iso, '%Y-%m-%dT%H:%M:%SZ')) * 1000


def iso(t):
    return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(int(t) // 1000))


def near(a, b, tol=1e-9):
    return a is not None and b is not None and abs(a - b) <= tol


def bars_mids(pair, times, mids):
    cols = [[m[k] for m in mids] for k in range(4)]
    return D.PairBars(pair, D.PAIRS.index(pair), times, cols, cols)


def bars_bids(pair, times, bids, spreads):
    bid = [[b[k] for b in bids] for k in range(4)]
    ask = [[b[k] + s for b, s in zip(bids, spreads)] for k in range(4)]
    return D.PairBars(pair, D.PAIRS.index(pair), times, bid, ask)


def flat(pair, times, mid):
    return bars_mids(pair, times, [(mid, mid, mid, mid)] * len(times))


def dname(d):
    return S.DIR_NAME[d]


# ---------------------------------------------------------------- 19 C1 / K1, 20 (g) 時刻
def run_c1(c, bad):
    t0 = ms(c['start'])
    pb = bars_mids(c['pair'], [t0 + k * D.STEP for k in range(len(c['bars']))], c['bars'])
    buy, sell, s = S.donchian_tri(pb, c['n'])
    ex = c['expect']
    if s.tolist() != ex['target']:
        bad.append(f'target {s.tolist()} (want {ex["target"]})')
    cands, _ = S.events_of(buy, sell)
    got = [[i, dname(d)] for i, d in cands]
    if got != ex['signals']:
        bad.append(f'signals {got} (want {ex["signals"]})')


def _breedon(pb, item):
    b, s = S.breedon_tri(pb, item)
    cands, _ = S.events_of(b, s)
    return [(int(pb.t[i]) + D.STEP, d, S.breedon_marks(int(pb.t[i]) + D.STEP)) for i, d in cands]


def run_k1(c, bad):
    times = [ms(x) for x in c['bars']]
    pb = flat('EUR/USD', times, 1.03)
    for item in ('breedon-1', 'breedon-2'):
        got = [[iso(T), dname(d), m] for T, d, m in _breedon(pb, item)]
        want = c['expect'].get(item, [])
        if got != want:
            bad.append(f'{item}: {got} (want {want})')


def run_dst(c, bad):
    days = c['days']
    times = [ms(c['context'])]
    for d, *_ in days:
        for hm in ('06:55', '07:55', '14:55', '15:55'):
            times.append(ms(f'{d}T{hm}:00Z'))
    pb = flat('EUR/USD', times, 1.08)
    s1, s2 = _breedon(pb, 'breedon-1'), _breedon(pb, 'breedon-2')
    if len(s1) != len(days) or len(s2) != len(days):
        bad.append(f'signals {len(s1)}/{len(s2)} (want {len(days)} each)')
        return
    for (d, T1, T2, season), a, b in zip(days, s1, s2):
        if iso(a[0]) != T1 or a[1] != S.SELL:
            bad.append(f'{d} breedon-1 {iso(a[0])} {dname(a[1])} (want {T1} SELL)')
        if iso(b[0]) != T2 or b[1] != S.BUY:
            bad.append(f'{d} breedon-2 {iso(b[0])} {dname(b[1])} (want {T2} BUY)')
        for x, T in ((a, T1), (b, T2)):
            got = D.SEASON_NAMES[D.season_of(ms(T))]
            if got != season:
                bad.append(f'{d} season at {T}: {got} (want {season})')
            if ('shiftedWeek' in x[2]) != (season == 'SW'):
                bad.append(f'{d} mark at {T}: {x[2]}')


# ---------------------------------------------------------------- 2 rounding and points
def run_round(c, bad):
    d = D.digits_of(c['pair'])
    got = D.price_str(D.chart_round((c['bid'] + c['ask']) / 2.0, d), d)
    if got != c['expect']:
        bad.append(f'mid {got} (want {c["expect"]})')
    pb = D.PairBars(c['pair'], D.PAIRS.index(c['pair']), [ms(DEFAULT_START)], [[c['bid']]] * 4, [[c['ask']]] * 4)
    got2 = D.price_str(float(pb.mc[0]), d)
    if got2 != c['expect']:
        bad.append(f'bars mid {got2} (want {c["expect"]})')


def run_points(c, bad):
    for pair, v, want in c['items']:
        got = D.points_of(v, pair)
        if got != want:
            bad.append(f'{pair} {v}: {got} (want {want})')


# ---------------------------------------------------------------- 7 follow, 8 mirror, 6 ② sent
def _follow_one(c, spec):
    pair = c['pair']
    jpy = D.is_jpy(pair)
    t0 = ms(c.get('signalAt', DEFAULT_START))
    tf = ms(c['followAt']) if 'followAt' in c else t0 + D.STEP
    sb, sa = c.get('signalBid', SIGNAL_BID), c.get('signalAsk', SIGNAL_ASK)
    spread = c.get('spread', SPREAD[jpy])
    filler = c.get('filler', FILLER[jpy])
    count = spec.get('count') or FOLLOW_COUNT
    tail = spec.get('tail') or []
    rows = list(spec['rows'])
    while len(rows) < count - len(tail):
        rows.append(filler)
    rows += tail + (spec.get('after') or [])
    times = [t0] + [tf + k * D.STEP for k in range(len(rows))]
    pb = bars_bids(pair, times, [[sb] * 4] + rows, [sa - sb] + [spread] * len(rows))
    # 6 ④ / 7: a trade is followed only when its 1,440 bars after the signal bar are there
    if D.TRACK > pb.n - 1:
        return None
    d = DIRS[c['dir']]
    buy = d == S.BUY
    sl, tp = ST.levels(np.array([pb.mc[0]]), d, 4 if c['tp'] == 4 else 10, pb.pip)
    kind, ex, nb, _ = ST.follow_many(pb, np.array([1]), buy, sl, tp)
    fill = pb.ac[0] if buy else pb.bc[0]
    pips = (ex[0] - fill) / pb.pip if buy else (fill - ex[0]) / pb.pip
    return NAME_OF_KIND[int(kind[0])], float(pips), int(nb[0])


def run_follow(c, bad):
    subs = c.get('subcases') or [{'rows': c['rows'], 'count': c.get('count'), 'tail': c.get('tail'),
                                  'after': c.get('after'), 'expect': c['expect']}]
    for j, sp in enumerate(subs):
        tag = f'#{j + 1} ' if len(subs) > 1 else ''
        got = _follow_one(c, sp)
        want = sp['expect']
        if want['kind'] is None:
            if got is not None:
                bad.append(f'{tag}followed ({got[0]}), want not followed')
            continue
        if got is None:
            bad.append(f'{tag}not followed (want {want["kind"]})')
            continue
        k, p, n = got
        if k != want['kind']:
            bad.append(f'{tag}kind {k} (want {want["kind"]})')
        if 'pips' in want and not near(p, want['pips'], 1e-6):
            bad.append(f'{tag}pips {p} (want {want["pips"]})')
        if 'bars' in want and n != want['bars']:
            bad.append(f'{tag}bars {n} (want {want["bars"]})')


def run_mirror(c, bad):
    """8: e of a blind-table row (the mirror) on a one-row world of the mini period's first half."""
    t0 = D.utc(2024, 1, 8)
    for j, w in enumerate(c['worlds']):
        rows = list(w['rows'])
        while len(rows) < D.TRACK:
            rows.append([150.0, 150.02, 149.98, 150.0])
        times = [t0] + [t0 + (k + 1) * D.STEP for k in range(len(rows))]
        pb = bars_bids('USD/JPY', times, [[149.995] * 4] + rows, [0.01] + [0.005] * len(rows))
        ks = np.nonzero(S.blind_mask(pb, [], 'H1', MINI))[0]
        if ks.tolist() != [0]:
            bad.append(f'world {j + 1}: blind rows {ks.tolist()} (want [0])')
            continue
        bp = ST.BlindPair(pb, ks, 'H1', MINI)
        e = bp.e(0, S.BUY)
        if e != w['e']:
            bad.append(f'world {j + 1}: e {e} (want {w["e"]})')


def run_sent(c, bad):
    for T, want in c['items']:
        if D.sent(ms(T)) != want:
            bad.append(f'{T}: {not want} (want {want})')


# ---------------------------------------------------------------- 5 the event framework
def run_events(c, bad):
    seqs = c['seqs']
    for j, sq in enumerate(seqs):
        tag = f'#{j + 1} ' if len(seqs) > 1 else ''
        if sq['type'] == 'named':
            n = len(sq['namedBuy'])
            cands, cnt = S.events_named(sq['namedBuy'], [[] for _ in range(n)])
        else:
            if sq['type'] == 'always':
                tg = sq['target']
                buy = [-1 if x is None else (1 if x == 1 else 0) for x in tg]
                sell = [-1 if x is None else (1 if x == -1 else 0) for x in tg]
            else:
                buy, sell = sq['buy'], sq['sell']
            cands, cnt = S.events_of(np.array(buy, dtype=np.int8), np.array(sell, dtype=np.int8))
        ex = sq['expect']
        got = [[i, dname(d)] for i, d in cands]
        if got != ex['signals']:
            bad.append(f'{tag}signals {got} (want {ex["signals"]})')
        for k in ('firstSkipped', 'nullPrevSkipped', 'bothSuppressed'):
            if cnt[k] != ex[k]:
                bad.append(f'{tag}{k} {cnt[k]} (want {ex[k]})')


# ---------------------------------------------------------------- 6 ③ holes, 1 / 6 ④ halves
def run_hole(c, bad):
    a, b = ms(c['start']), ms(c['end'])
    period = dict(MINI, s0=a, end=b)
    bars = []
    for pair in D.PAIRS:
        miss = {ms(x) for x in c['missing'].get(pair, [])}
        times = [t for t in range(a, b, D.STEP) if t not in miss]
        bars.append(flat(pair, times, 150.0 if D.is_jpy(pair) else 1.1))
    holes, _ = S.holes_of(bars, period)
    ex = c['expect']
    for pi, pair in enumerate(D.PAIRS):
        got = [[iso(x), iso(y)] for x, y in holes[pi]]
        want = ex['holes'].get(pair, [])
        if got != want:
            bad.append(f'{pair} holes {got} (want {want})')
    uj = bars[0]
    for open_, want in ex['overlap']:
        i = uj.index_of.get(ms(open_))
        if i is None:
            bad.append(f'no USD/JPY bar at {open_}')
            continue
        got = S.in_hole(holes[0], int(uj.t[max(0, i - S.HOLE_LOOKBACK)]), int(uj.t[i]) + D.STEP)
        if got != want:
            bad.append(f'overlap at {open_}: {got} (want {want})')
        reason, _ = S.classify(uj, i, 0, holes[0], period)
        if (reason == 'r3') != want:
            bad.append(f'reason at {open_}: {reason}')


def run_half(c, bad):
    times = list(range(ms(c['from']), ms(c['to']) + D.STEP, D.STEP))
    pb = flat('USD/JPY', times, 150.0)
    for open_, reason, half in c['expect']:
        r, h = S.classify(pb, pb.index_of[ms(open_)], 0, [], MINI)
        if r != reason or h != half:
            bad.append(f'{open_}: {r} {h} (want {reason} {half})')


# ---------------------------------------------------------------- 8 Δ, its SE, the clusters, the shift
def bstr_of(blind_obs):
    """The blind strata of the stats module's layout: {stratum: (m, mean, {week: (sum, n)}, {block: (sum, n)})},
    the sums oldest first."""
    by = {}
    for s, w, b, v in blind_obs:
        by.setdefault(s, []).append((w, b, v))
    out = {}
    for s, rows in by.items():
        acc = 0.0
        wk, bk = {}, {}
        for w, b, v in rows:
            acc += v
            x = wk.get(w)
            wk[w] = (v, 1) if x is None else (x[0] + v, x[1] + 1)
            x = bk.get(b)
            bk[b] = (v, 1) if x is None else (x[0] + v, x[1] + 1)
        out[s] = (len(rows), acc / len(rows), wk, bk)
    return out


def est_check(e, ex, bad, tag=''):
    if not near(e['est'], ex['est'], 1e-12):
        bad.append(f'{tag}Δ {e["est"]} (want {ex["est"]})')
    for k in ('N', 'strata', 'dropped', 'use'):
        if k in ex and e[k] != ex[k]:
            bad.append(f'{tag}{k} {e[k]} (want {ex[k]})')
    if 'kinds' in ex and [x['kind'] for x in e['cands']] != ex['kinds']:
        bad.append(f'{tag}candidates {[x["kind"] for x in e["cands"]]} (want {ex["kinds"]})')
    used = next((x for x in e['cands'] if x['kind'] == e['use']), None)
    if 'se' in ex and not near(used['se'] if used else None, ex['se'], 1e-12):
        bad.append(f'{tag}SE {used["se"] if used else None} (want {ex["se"]})')
    for k in ('C', 'df'):
        if k in ex and (used or {}).get(k) != ex[k]:
            bad.append(f'{tag}{k} {(used or {}).get(k)} (want {ex[k]})')


def run_delta(c, bad):
    sig = [tuple(x) for x in c['sig']]
    est_check(ST.delta_est(sig, bstr_of([tuple(x) for x in c['blind']])), c['expect'], bad)


def _obs_t(pair, d, layer, T, v):
    w = D.wk(T)
    return (ST.stratum_of(layer, D.PAIRS.index(pair), d, T), w, (w - MINI['w0']['H1']) // 4, v)


def run_delta_t(c, bad):
    d = DIRS[c['dir']]
    sig = [_obs_t(c['pair'], d, c['layer'], ms(T), v) for T, v in c['sig']]
    bl = [_obs_t(c['pair'], d, c['layer'], ms(T), v) for T, v in c['blind']]
    est_check(ST.delta_est(sig, bstr_of(bl)), c['expect'], bad)
    ex = c['expect']
    if 'blindPerStratum' in ex:
        used = sorted({o[0] for o in sig if any(b[0] == o[0] for b in bl)})
        got = [sum(1 for b in bl if b[0] == s) for s in used]
        if got != ex['blindPerStratum']:
            bad.append(f'blind rows per stratum {got} (want {ex["blindPerStratum"]})')
    if 'seasons' in ex:
        got = [D.SEASON_NAMES[D.season_of(ms(T))] for T, _ in c['sig']]
        if got != ex['seasons']:
            bad.append(f'seasons {got} (want {ex["seasons"]})')


def run_clusters(c, bad):
    for j, st in enumerate(c['sets']):
        sig = [(0, w, st['blocks'][k], 0.5 if k % 2 == 0 else 0.0) for k, w in enumerate(st['weeks'])]
        bl = [(0, w, st['blocks'][k], -0.5 if k % 3 == 0 else 0.0) for k, w in enumerate(st['weeks'])]
        e = ST.delta_est(sig, bstr_of(bl))
        kinds = [x['kind'] for x in e['cands']]
        Cs = [x['C'] for x in e['cands']]
        if kinds != st['kinds'] or Cs != st['C']:
            bad.append(f'#{j + 1}: {kinds} C {Cs} (want {st["kinds"]} C {st["C"]})')


def manual_table(rows, half, period):
    """A blind table of one pair (USD/JPY) from rows (bar open, e of BUY, TP4 kind and pips of BUY); the other legs
    are stops at −13.5 pips. Built as the stats module's own BlindPair / BlindTable objects."""
    rows = sorted(rows, key=lambda r: r[0])
    n = len(rows)
    t = np.array([r[0] for r in rows], dtype=np.int64)
    bp = object.__new__(ST.BlindPair)
    bp.pi, bp.pair = 0, 'USD/JPY'
    bp.k = np.arange(n, dtype=np.int64)
    bp.T = t + D.STEP
    bp.E = np.full(n, 150.0)
    bp.hour, bp.season, bp.week = S.hour_arr(bp.T), S.season_arr(bp.T), S.wk_arr(bp.T)
    bp.block = (bp.week - period['w0'][half]) // 4
    stop = np.full(n, ST.KIND_SL, dtype=np.int8)
    bp.kind = {'b4': np.array([KIND_OF[r[2]] for r in rows], dtype=np.int8), 's4': stop.copy(), 'b10': stop.copy(),
               's10': stop.copy()}
    bp.pips = {'b4': np.array([r[3] for r in rows], dtype=np.float64), 's4': np.full(n, -13.5),
               'b10': np.full(n, -13.5), 's10': np.full(n, -13.5)}
    bp.nbars = {k: np.ones(n, dtype=np.int32) for k in ('b4', 's4', 'b10', 's10')}
    bp.exi = {k: np.arange(n, dtype=np.int64) for k in ('b4', 's4', 'b10', 's10')}
    bp.eBuy = np.array([r[1] for r in rows], dtype=np.int8)
    bp.row_of = {k: k for k in range(n)}
    bp.row_of_t = {int(t[k]): k for k in range(n)}
    tb = object.__new__(ST.BlindTable)
    tb.half, tb.period, tb.pairs = half, period, [bp]
    tb.weeks = sorted(set(bp.week.tolist()))
    tb._strata = {}
    return tb


def _trade(tb, T, d):
    bp = tb.pairs[0]
    r = bp.row_of_t[T - D.STEP]
    sig = types.SimpleNamespace(T=T, pi=0, dir=d, pair='USD/JPY', src='hand', i=r)
    return types.SimpleNamespace(sig=sig, e=bp.e(r, d), e_late=None, next_T=None)


def run_shift(c, bad):
    tb = manual_table([(ms(o), e, 'sl', -13.5) for o, e in c['rows']], 'H1', MINI)
    trades = [_trade(tb, ms(T), DIRS[d]) for T, d in c['signals']]
    ex = c['expect']
    real = ST.delta_est(ST.obs_of(trades, 'chart', MINI, 'H1'), tb.strata('chart'))['est']
    if not near(real, ex['real'], 1e-12):
        bad.append(f'real Δ {real} (want {ex["real"]})')
    sh = ST.shift_deltas(trades, tb, 'chart')
    ks, ds, dr = [k for k, _, _, _ in sh], [x for _, x, _, _ in sh], [x for _, _, x, _ in sh]
    if ks != ex['k']:
        bad.append(f'k {ks} (want {ex["k"]})')
    if len(ds) != len(ex['delta']) or any(not near(x, y, 1e-12) for x, y in zip(ds, ex['delta'])):
        bad.append(f'Δ_k {ds} (want {ex["delta"]})')
    if dr != ex['dropped']:
        bad.append(f'dropped {dr} (want {ex["dropped"]})')
    sm = ST.shift_summary(sh, real)
    if not near(sm['sd'], ex['sd'], 1e-12):
        bad.append(f'SD {sm["sd"]} (want {ex["sd"]})')
    if not near(sm['mean'], ex['mean'], 1e-12):
        bad.append(f'mean {sm["mean"]} (want {ex["mean"]})')
    if sm['rank'] != ex['rank']:
        bad.append(f'rank {sm["rank"]} (want {ex["rank"]})')


def run_sepick(c, bad):
    for cands, want in c['items']:
        got = ST.pick([{'kind': k, 'se': h, 'C': 20, 'df': 19, 'half': h} for k, h in cands])['kind']
        if got != want:
            bad.append(f'{cands}: {got} (want {want})')


def run_tq(c, bad):
    for df, want in c['items']:
        got = ST.tq(0.975, df)
        if not near(got, want, c['tol']):
            bad.append(f'df {df}: {got} (want {want})')


# ---------------------------------------------------------------- 10-14 counting, selection, Holm, groups, floor
def run_lbcount(c, bad):
    ni, ng = SEL.item_count(c['ids']), SEL.group_count(c['ids'], c['groups'])
    if (ni, ng) != (c['expect']['items'], c['expect']['groups']):
        bad.append(f'items {ni}, groups {ng} (want {c["expect"]["items"]}, {c["expect"]["groups"]})')
    for xs, want in c['p95']:
        if SEL.p95_of(xs) != want:
            bad.append(f'95% point of {len(xs)} values: {SEL.p95_of(xs)} (want {want})')


def run_select(c, bad):
    for j, st in enumerate(c['sets']):
        rows = {}
        for src, est, lb, ne, sus in st['rows']:
            rows[src] = {'delta': {'est': est, 'lb': lb, 'lo': lb, 'hi': None, 't': None if lb is None else 3.0,
                                   'N': ne, 'cands': [], 'use': None},
                         'nE': ne, 'suspicious': list(sus)}
        s1 = SEL.stage1(rows, st['groups'])
        ex = st['expect']
        if s1['chosen'] != {'chart': ex['chart'], 'cal': ex['cal']}:
            bad.append(f'#{j + 1}: {s1["chosen"]} (want chart {ex["chart"]}, cal {ex["cal"]})')
        if s1['notEligible'] != ex['notEligible']:
            bad.append(f'#{j + 1}: not eligible {s1["notEligible"]} (want {ex["notEligible"]})')


def run_holm(c, bad):
    for j, st in enumerate(c['sets']):
        h = SEL.holm_order([tuple(x) for x in st['items']])
        for src, (rank, ok) in st['expect'].items():
            g = h.get(src)
            if g is None or g['holmRank'] != rank or g['holmPass'] != ok:
                bad.append(f'#{j + 1} {src}: {g} (want {rank} {ok})')


def run_groups(c, bad):
    ov = c['overlap']
    for j, st in enumerate(c['sets']):
        share = {f'{a}>{b}': ov.get(f'{a}>{b}') for a in st['items'] for b in st['items'] if a != b}
        g = CNT.groups_of(st['items'], share)
        got = {x: D.ITEM_ORDER[k] for x, k in g.items()}
        if got != st['expect']:
            bad.append(f'#{j + 1}: {got} (want {st["expect"]})')


def run_floor(c, bad):
    for h1, h2, want in c['items']:
        got = CNT.floor_of(tuple(h1), tuple(h2))
        if got != want:
            bad.append(f'{h1}, {h2}: {got} (want {want})')


def run_suspect(c, bad):
    base = c['base']

    def wp(x):
        return {'n': x[0], 'resolved': x[0], 'wRes': x[1], 'wAll': x[2], 'pl': x[3]}
    for over, want in c['items']:
        x = dict(base, **over)
        late = x['late'] if x.get('late') is not None else x['delta']
        row = {'delta': {'est': x['delta']}, 'a': {'est': x['a']}, 'late': {'est': late}, 'w4': wp(x['w4']),
               'w10': wp(x['w10'])}
        got = ST.suspicious(row, blind=bool(x.get('blind')))
        if got != want:
            bad.append(f'{over}: {got} (want {want})')


# ---------------------------------------------------------------- 9, 21 numbers, win rates and sentences
def run_text_numbers(c, bad):
    f = {'pts': TX.pts, 'pct': TX.pct, 'pips': TX.pips, 'yen': TX.yen}
    for name, v, want in c['items']:
        got = f[name](v)
        if got != want:
            bad.append(f'{name}({v}): {got} (want {want})')


def run_win_denominator(c, bad):
    w = ST.winpl([(D.utc(2024, 1, 9) + k * D.STEP, KIND_OF[k_], 0.0) for k, k_ in enumerate(c['trades'])])
    ew = c['expectW']
    if w['n'] != ew['n'] or w['resolved'] != ew['resolved'] or not near(w['wRes'], ew['wRes']) or \
            not near(w['wAll'], ew['wAll']):
        bad.append(f'W n {w["n"]} resolved {w["resolved"]} wRes {w["wRes"]} wAll {w["wAll"]}')
    tb = manual_table([(ms(o), 0, k4, p4) for o, k4, p4 in c['rows']], 'H1', MINI)
    trades = [_trade(tb, ms(T), S.BUY) for T in c['signals']]
    delta = ST.delta_est(ST.obs_of(trades, 'chart', MINI, 'H1'), tb.strata('chart'))
    w1, pl1 = ST.blind_weighted(delta, tb, 'chart')
    ex = c['expect']
    if not near(w1, ex['blindW1'], 1e-12) or not near(pl1, ex['blindPl1'], 1e-12):
        bad.append(f'blind W1 {w1}, PL1 {pl1} (want {ex["blindW1"]}, {ex["blindPl1"]})')


C_PATTERN = {'alt': lambda g: 1 if g % 2 == 0 else -1, 'pairs': lambda g: 1 if (g >> 1) % 2 == 0 else -1}


def est_of(est, se, df, pattern='alt', N=100):
    """A made-up estimate: week influence sums a·f(g) on C = df + 1 clusters, a = se·√(C−1)/C, so that the week SE
    √(C/(C−1)·Σ S_g²) is se (no 4-week blocks)."""
    wk = {}
    cands = []
    if se is not None:
        C = df + 1
        a = se * math.sqrt(C - 1) / C
        f = C_PATTERN[pattern]
        for g in range(C):
            wk[g] = a * f(g)
        cands.append(ST._cand('week', ST._se(wk, C), C))
    r = ST.finish(est, N, 1, 0, cands)
    r['_if'] = (wk, {})
    return r


def win_of(w_res, pl, resolved=200):
    tp = int(round(w_res * resolved))
    return {'n': resolved, 'resolved': resolved, 'tp': tp, 'sl': resolved - tp, 'amb': 0, 'open': 0, 'wAll': w_res,
            'wRes': w_res, 'pl': pl, 'wLo': None, 'wHi': None, 'plLo': None, 'plHi': None}


def row_from(sp, df):
    late = sp['late']
    bd = sp.get('byDir') or {}
    row = {'delta': est_of(sp['delta'][0], sp['delta'][1], df, sp.get('pattern', 'alt')),
           'a': est_of(sp['a'][0], sp['a'][1], df),
           'late': {'est': late[0], 'N': 100, 'strata': 1, 'dropped': 0, 'cands': [], 'use': None, 't': None,
                    'lo': late[1], 'hi': late[2], 'lb': None},
           'w4': win_of(*sp['w4']), 'w10': win_of(*sp['w10']), 'blindW1': 0.7, 'blindPl1': -1.0,
           'byDir': {k: {'est': bd[k][0] if k in bd else None, 'N': bd[k][1] if k in bd else 0, 'strata': 1,
                         'dropped': 0} for k in ('BUY', 'SELL')},
           'byPair': {}, 'nonOverlap': None, 'perWeek': None, 'counted': 100, 'nE': 100}
    row['suspicious'] = ST.suspicious(row)
    return row


def email_rows(est, se, df, pattern):
    r = row_from({'delta': [est, 0], 'late': [est, est, est], 'a': [0, 0.01], 'w4': [0.7, -1.0],
                  'w10': [0.55, -0.5]}, df)
    r['delta'] = est_of(est, se, df, pattern)
    return {'chart': r, 'cal': r}


def stage2_world(specs, df, ultra, macd, m1):
    rows = {sp['id']: row_from(sp, df) for sp in specs}
    chosen = [sp['id'] for sp in specs]
    mrows = {'ultra5': ultra, 'macdx5': macd}
    st2 = SEL.stage2(chosen, rows, mrows, {s: s.startswith('donchian') for s in chosen})
    blind = {d: {'w4': win_of(0.7, -1.0, 0), 'w10': win_of(0.55, -0.5, 0)} for d in ('BUY', 'SELL')}
    sentences = dict(TX.stage2_sentences(st2, rows, mrows, blind, {'M1': {'chart': m1, 'cal': 0}}, chosen))
    return rows, st2, sentences


def check_text(sentences, ex, bad):
    for sid, e in (ex or {}).items():
        s = sentences.get(sid)
        if s is None:
            bad.append(f'{sid}: no sentence')
            continue
        for frag in e.get('contains', []):
            if frag not in s:
                bad.append(f'{sid}: missing「{frag[:40]}…」')
        for frag in e.get('absent', []):
            if frag in s:
                bad.append(f'{sid}: has「{frag[:40]}…」')
        if 'startsWith' in e and not s.startswith(e['startsWith']):
            bad.append(f'{sid}: does not start「{e["startsWith"][:40]}…」')


def run_text(c, bad):
    df, m1 = c['df'], c['m1']
    if 'scenarios' in c:
        for sc in c['scenarios']:
            sp = {'id': sc['item'], 'delta': [0.08, 0.01], 'late': [0.08, 0.06, 0.1], 'a': [0.02, 0.01],
                  'w4': [0.7, -1.0], 'w10': [0.55, -0.5]}
            _, st2, sent = stage2_world([sp], df, email_rows(sc['ultra'], 0.01, df, 'pairs'),
                                        email_rows(sc['macd'], 0.01, df, 'pairs'), m1)
            if st2['items'][sc['item']]['judgment'] != 'confirmed':
                bad.append(f'{sc["item"]}: {st2["items"][sc["item"]]["judgment"]} (want confirmed)')
            check_text(sent, {f's2.item.{sc["item"]}': {'contains': sc['contains']}}, bad)
        return
    _, st2, sent = stage2_world(c['items'], df, email_rows(0, 0.01, df, 'pairs'), email_rows(0, 0.01, df, 'pairs'),
                                m1)
    ex = c['expect']
    for src, j in (ex.get('judgments') or {}).items():
        got = st2['items'].get(src, {}).get('judgment')
        if got != j:
            bad.append(f'{src}: {got} (want {j})')
    for src, f in (ex.get('forms') or {}).items():
        got = st2['items'].get(src, {}).get('form')
        if got != f:
            bad.append(f'{src}: form {got} (want {f})')
    check_text(sent, ex.get('text'), bad)


def run_dab(c, bad):
    df = c['df']
    specs = [{'id': src, 'delta': [est, se], 'late': [est, 0.0005, est + 0.01], 'a': [0.01, 0.01],
              'w4': [0.7, -1.0], 'w10': [0.55, -0.5], 'pattern': 'pairs' if k == 1 else 'alt'}
             for k, (src, est, se) in enumerate(c['items'])]
    _, st2, sent = stage2_world(specs, df, email_rows(0, None, df, 'alt'), email_rows(0, None, df, 'alt'), 10)
    ex = c['expect']
    conf = [s for s, _, _ in c['items'] if st2['items'][s]['judgment'] == 'confirmed']
    if conf != ex['confirmed']:
        bad.append(f'confirmed {conf} (want {ex["confirmed"]})')
    if st2['promote']['chart'] != ex['promote']:
        bad.append(f'promoted {st2["promote"]["chart"]} (want {ex["promote"]})')
    d = st2['dAB'][0] if st2['dAB'] else None
    used = next((x for x in d['est']['cands'] if x['kind'] == d['est']['use']), None) if d else None
    if used is None or not near(used['se'], ex['se'], 1e-9):
        bad.append(f'D_AB SE {used["se"] if used else None} (want {ex["se"]})')
    check_text(sent, {'s2.final': {'contains': ex['contains']}}, bad)


RUNNERS = {
    'c1': run_c1, 'k1': run_k1, 'dst': run_dst, 'round': run_round, 'points': run_points, 'follow': run_follow,
    'mirror': run_mirror, 'sent': run_sent, 'events': run_events, 'hole': run_hole, 'half': run_half,
    'delta': run_delta, 'deltaT': run_delta_t, 'clusters': run_clusters, 'shift': run_shift, 'sepick': run_sepick,
    'tq': run_tq, 'lbcount': run_lbcount, 'select': run_select, 'holm': run_holm, 'groups': run_groups,
    'floor': run_floor, 'suspect': run_suspect, 'textNumbers': run_text_numbers,
    'winDenominator': run_win_denominator, 'text': run_text, 'dab': run_dab,
}


def run_cases(cases):
    """Every case of hand.json: {id: [problems]} (an empty list when the case passed)."""
    out = {}
    for c in cases:
        bad = []
        fn = RUNNERS.get(c['kind'])
        try:
            if fn is None:
                raise ValueError(f'no runner for kind {c["kind"]}')
            fn(c, bad)
        except Exception as e:  # noqa: BLE001 — a crash of a case is its failure
            bad.append(f'crash {e!r}')
        out[c['id']] = bad
    return out


def main(path):
    """Run every case of hand.json; prints "ok   handjson.<id>" or "FAIL handjson.<id> (…)"; 0 when all passed,
    1 when one failed, 2 when the file cannot be read."""
    import hashlib
    import json
    try:
        with open(path, 'rb') as f:
            raw = f.read()
        cases = json.loads(raw)['cases']
    except (OSError, ValueError, KeyError, TypeError) as e:
        print(f'hand.json: cannot read {path} ({e!r})')
        return 2
    print(f'sha256 {path} {hashlib.sha256(raw).hexdigest()}')
    res = run_cases(cases)
    for cid, bad in res.items():
        print(f'ok   handjson.{cid}' if not bad else f'FAIL handjson.{cid} ({"; ".join(bad[:4])})')
    failed = [k for k, v in res.items() if v]
    print(f'hand.json: {len(res) - len(failed)} of {len(res)} passed')
    return 0 if not failed else 1
