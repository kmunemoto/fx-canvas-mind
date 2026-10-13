#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
chartbest-check-handjson.py — every hand example of research/chartbest/hand.json (docs/OPERATIONS.md §8.113 19 and
20 (g)) run through the independent Python's own functions: 20 (g)「手の例〔どの run でも走る。TS と Python の両方。
…〕」.

Written 2026-10-12 by the step-2b Python author from §8.113 (19, 20 (g) and the sections each case names), from
hand.json version 2 (its 'conventions' and 'fields') and from the Python modules' interfaces, without reading any TS
(20 (d); spec questions SQ-I1, SQ-I2; py-brief 1.1). It replaces the earlier version of this file, whose layout
values had been copied from the TS runner (SQ-I2).

The layout (SQ-I2). A case gives its inputs and its answer; whatever else lays it out (bar times, spreads, filler bars,
periods, the made-up rows of the sentences) is read from hand.json's 'conventions', never carried here. For a case
of kind K and a key: the subcase's field (follow.usdExact's subcases), else the case's own field of that name, else
the field of the conventions group whose 'usedBy' names K (a key found in two groups of one kind is an error). A value
found nowhere fails the case with a message naming the key and the groups looked in. The only values of this file
are the rule's (8's zero, 7's 1,440 bars through the modules' constants) and the comparison's tolerance (TOL).

main(path) -> 0 when every case passed, 1 when one failed, 2 when the file cannot be read. It prints
'sha256 <path> <hex>' (of the file's bytes), then one 'ok   handjson.<id>' or 'FAIL handjson.<id> (<what differed>)'
line per case in the file's order (a case that raises fails; its message is the problem), then
'hand.json: <passed> of <total> passed'. Called by chartbest-check.py --mode hand --hand FILE (no --plant).
"""
import calendar
import hashlib
import importlib.util
import json
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
CNT = _mod('count')
TX = _mod('text')

TOL = 1e-9                     # plan 4.4: reals within 1e-9 (a case's own 'tol' where it gives one: t.q)
# 6 ①「温めが足りない」 belongs to an item's warm-up (5「温め: 項目の表の温めがそろうまで、合図は出さない」); the
# signals of the cases hole and half belong to no item, so none is applied (a spec question asks hand.json to say so)
NO_ITEM_WARMUP = 0
DIRS = {'BUY': S.BUY, 'SELL': S.SELL}
KINDS = {'tp': ST.KIND_TP, 'sl': ST.KIND_SL, 'amb': ST.KIND_AMB, 'open': ST.KIND_OPEN}
KIND_NAMES = {v: k for k, v in KINDS.items()}


class CaseFail(Exception):
    pass


def need(cond, msg):
    if not cond:
        raise CaseFail(msg)


def close(x, y, tol=TOL):
    return x is not None and y is not None and abs(x - y) <= tol


def ms(text):
    """'YYYY-MM-DD' or 'YYYY-MM-DDTHH:MM:SSZ' (UTC) -> integer ms."""
    day, _, clock = text.rstrip('Z').partition('T')
    y, mo, d = (int(x) for x in day.split('-'))
    h, mi, sec = (int(x) for x in (clock or '00:00:00').split(':'))
    return calendar.timegm((y, mo, d, h, mi, sec)) * 1000


# ---------------------------------------------------------------- SQ-I2: the layout of a case
class Layout:
    def __init__(self, conv, case, sub=None):
        self.conv, self.case, self.sub = conv, case, sub
        self.kind = case['kind']
        self.groups = [g for g, v in conv.items() if isinstance(v, dict) and self.kind in (v.get('usedBy') or [])]

    def get(self, key):
        if self.sub is not None and key in self.sub:
            return self.sub[key]
        if key in self.case:
            return self.case[key]
        found = [g for g in self.groups if key in self.conv[g]]
        need(len(found) < 2, f"conventions: '{key}' is in the groups {', '.join(found)}, all used by kind {self.kind}")
        need(found, f"conventions: no '{key}' for kind {self.kind} (looked in the case and in the group(s) "
                    f"{', '.join(self.groups) or 'none'})")
        return self.conv[found[0]][key]


def period_of(L):
    """1's dates of the period the layout names (conventions.periods: S0, START, SPLIT, END and w0 of each half)."""
    name = L.get('period')
    periods = L.get('periods')
    need(name in periods, f"conventions.periods: no period '{name}'")
    p = periods[name]
    return {'name': name, 's0': ms(p['S0']), 'start': ms(p['START']), 'split': ms(p['SPLIT']), 'end': ms(p['END']),
            'w0': {h: int(w) for h, w in p['w0'].items()}}


def mid_bars(L, pair, opens, mids):
    """conventions.midBars: a bar given by its mids [O, H, L, C] has bid = mid − h and ask = mid + h on each of O, H, L
    and C (h = halfSpread of the pair), so that the chart's mid (2) is the given mid; checked here."""
    h = L.get('halfSpread')
    need(pair in h, f"conventions.midBars.halfSpread: no '{pair}'")
    h = h[pair]
    bid = [[m[k] - h for m in mids] for k in range(4)]
    ask = [[m[k] + h for m in mids] for k in range(4)]
    pb = D.PairBars(pair, D.PAIRS.index(pair), list(opens), bid, ask)
    for k, arr in enumerate((pb.mo, pb.mh, pb.ml, pb.mc)):
        for i, m in enumerate(mids):
            need(float(arr[i]) == m[k], f'layout: the chart mid of bar {i} is {arr[i]}, not the given {m[k]}')
    return pb


def flat(m):
    return (m, m, m, m)


def one_pair_bars(pair, opens, bid_rows, ask_rows):
    """A PairBars from explicit bid / ask [O, H, L, C] rows."""
    bid = [[r[k] for r in bid_rows] for k in range(4)]
    ask = [[r[k] for r in ask_rows] for k in range(4)]
    return D.PairBars(pair, D.PAIRS.index(pair), list(opens), bid, ask)


# ---------------------------------------------------------------- c1, k1, dst (19 C1 / K1, 5, 2, 8)
def run_c1(case, conv):
    L = Layout(conv, case)
    pair, n, bars = L.get('pair'), L.get('n'), case['bars']
    t0 = ms(L.get('start'))
    pb = mid_bars(L, pair, [t0 + k * D.STEP for k in range(len(bars))], bars)
    buy, sell, s = S.donchian_tri(pb, n)
    cands, _ = S.events_of(buy, sell)
    exp = case['expect']
    need(s.tolist() == exp['target'], f'target {s.tolist()}, expected {exp["target"]}')
    got = [[i, S.DIR_NAME[d]] for i, d in cands]
    need(got == exp['signals'], f'signals {got}, expected {exp["signals"]}')


def breedon_signals(pb, item):
    """K1 through the Python's functions: the condition per bar, 5's events, the mark of the shifted weeks."""
    b, s = S.breedon_tri(pb, item)
    cands, _ = S.events_of(b, s)
    return [[pb.T(i), S.DIR_NAME[d], S.breedon_marks(pb.T(i))] for i, d in cands]


def run_k1(case, conv):
    L = Layout(conv, case)
    pair, m = L.get('pair'), L.get('flatMid')
    opens = [ms(x) for x in case['bars']]
    need(opens == sorted(set(opens)), 'the bars are not in time order')
    pb = mid_bars(L, pair, opens, [flat(m)] * len(opens))
    for item, want in case['expect'].items():
        got = breedon_signals(pb, item)
        want = [[ms(T), d, list(marks)] for T, d, marks in want]
        need(got == want, f'{item}: {got}, expected {want}')


def run_dst(case, conv):
    L = Layout(conv, case)
    pair, times, m = L.get('pair'), L.get('barTimes'), L.get('flatMid')
    opens = [ms(case['context'])] + [ms(f'{day}T{hm}:00Z') for day, *_ in case['days'] for hm in times]
    need(opens == sorted(set(opens)), 'the bars are not in time order')
    pb = mid_bars(L, pair, opens, [flat(m)] * len(opens))
    got1, got2 = breedon_signals(pb, 'breedon-1'), breedon_signals(pb, 'breedon-2')
    want1, want2 = [], []
    for day, t1, t2, season in case['days']:
        marks = ['shiftedWeek'] if season == 'SW' else []          # 18 K1 印 (fields: the mark shiftedWeek)
        want1.append([ms(t1), 'SELL', marks])
        want2.append([ms(t2), 'BUY', marks])
        for T in (ms(t1), ms(t2)):
            got = D.SEASON_NAMES[D.season_of(T)]
            need(got == season, f'{day}: the season at {T} is {got}, expected {season}')
    need(got1 == want1, f'breedon-1 {got1}, expected {want1}')
    need(got2 == want2, f'breedon-2 {got2}, expected {want2}')


# ---------------------------------------------------------------- 2 the mid and the points
def run_round(case, conv):
    L = Layout(conv, case)
    pair, bid, ask = L.get('pair'), L.get('bid'), L.get('ask')
    at, read_at = ms(L.get('at')), ms(L.get('readAt'))
    need(read_at >= at + D.STEP, 'layout: the bar is not closed at readAt (2「確定した足だけを使う」)')
    pb = one_pair_bars(pair, [at], [flat(bid)], [flat(ask)])
    got = [D.price_str(float(x[0]), pb.digits) for x in (pb.mo, pb.mh, pb.ml, pb.mc)]
    need(got == [case['expect']] * 4, f'mid {got}, expected {case["expect"]}')


def run_points(case, conv):
    for pair, mid, want in case['items']:
        got = D.points_of(mid, pair)
        need(got == want, f'{pair} {mid}: {got}, expected {want}')


# ---------------------------------------------------------------- 7 the follow, 8 the mirror
def follow_bars(L, rows):
    """conventions.follow / .mirror: the signal bar (four bids signalBid, four asks signalAsk) at signalAt, then from
    followAt every 5 minutes the rows (bid O, H, L, C), the filler repeated until count − (tail bars) bars stand after
    the signal bar, the tail (its last bar is bar number count) and 'after'; ask = bid + spread after the signal bar."""
    pair = L.get('pair')
    t_sig, t_fol = ms(L.get('signalAt')), ms(L.get('followAt'))
    need(t_fol >= t_sig + D.STEP, 'layout: followAt is before the signal bar closes')
    sb, sa, spread = L.get('signalBid'), L.get('signalAsk'), L.get('spread')
    filler, count = L.get('filler'), L.get('count')
    tail = L.get('tail') if L.kind == 'follow' else []
    after = L.get('after') if L.kind == 'follow' else []
    n_fill = count - len(tail) - len(rows)
    need(n_fill >= 0, f'layout: {len(rows)} rows and {len(tail)} tail bars do not fit in count {count}')
    after_bars = list(rows) + [filler] * n_fill + list(tail) + list(after)
    opens = [t_sig] + [t_fol + k * D.STEP for k in range(len(after_bars))]
    bid_rows = [flat(sb)] + [list(r) for r in after_bars]
    ask_rows = [flat(sa)] + [[x + spread for x in r] for r in after_bars]
    return one_pair_bars(pair, opens, bid_rows, ask_rows)


def follow_trade(pb, d, n_tp):
    """6 / 7 for the signal at bar 0: E = its mid close; the levels (ST.levels); followed from bar 1 on the exit side
    (ST.follow_many) when the 1,440th follow bar exists (6 ④: i + 1,440 <= the last bar, as S.classify); the pips
    from the fill (BUY the ask close, SELL the bid close). Returns (kind, pips, bars) or None when not followed."""
    if 0 + D.TRACK > pb.n - 1:
        return None
    E = float(pb.mc[0])
    sl, tp = ST.levels(np.array([E]), d, n_tp, pb.pip)
    buy = d == S.BUY
    kind, ex, nb, _ = ST.follow_many(pb, np.array([1]), buy, sl, tp)
    fill = float(pb.ac[0]) if buy else float(pb.bc[0])
    pips = (float(ex[0]) - fill) / pb.pip if buy else (fill - float(ex[0])) / pb.pip
    return int(kind[0]), pips, int(nb[0])


def run_follow(case, conv):
    subs = case.get('subcases') or [None]
    for k, sub in enumerate(subs):
        L = Layout(conv, case, sub)
        where = f'subcase {k}: ' if sub is not None else ''
        exp = (sub if sub is not None else case)['expect']
        pb = follow_bars(L, L.get('rows'))
        got = follow_trade(pb, DIRS[L.get('dir')], L.get('tp'))
        if exp['kind'] is None:
            need(got is None, f'{where}followed ({got and KIND_NAMES[got[0]]}), expected not followed (6 ④)')
            continue
        need(got is not None, f'{where}not followed, expected {exp["kind"]}')
        kind, pips, bars = got
        need(KIND_NAMES[kind] == exp['kind'], f'{where}kind {KIND_NAMES[kind]}, expected {exp["kind"]}')
        need(close(pips, exp['pips']), f'{where}pips {pips}, expected {exp["pips"]}')
        need(bars == exp['bars'], f'{where}bars {bars}, expected {exp["bars"]}')


def run_mirror(case, conv):
    L = Layout(conv, case)
    period, half = period_of(L), L.get('half')
    for k, world in enumerate(case['worlds']):
        pb = follow_bars(L, world['rows'])
        holes, _ = S.holes_of([pb], period)
        need(holes == [[]], f'world {k}: holes {holes} (one pair has no open slot)')
        ks = np.nonzero(S.blind_mask(pb, holes[0], half, period))[0]
        need(ks.tolist() == [0], f'world {k}: blind rows {ks.tolist()}, the layout gives the signal bar only')
        bp = ST.BlindPair(pb, ks, half, period)
        got = (bp.e(0, S.BUY), bp.e(0, S.SELL))
        need(got == (world['e'], -world['e']), f'world {k}: e (BUY, SELL) {got}, expected ({world["e"]}, {-world["e"]})')


# ---------------------------------------------------------------- 6 ② sent, 5 events
def run_sent(case, conv):
    for T, want in case['items']:
        got = D.sent(ms(T))
        need(got == want, f'{T}: sent {got}, expected {want}')


def run_events(case, conv):
    for k, seq in enumerate(case['seqs']):
        typ = seq['type']
        if typ == 'always':
            # 5「常に持つ型…条件は「持ち高の目標が d」」; a target null is 無し for both directions
            tg = seq['target']
            buy = np.array([-1 if x is None else int(x == 1) for x in tg], dtype=np.int8)
            sell = np.array([-1 if x is None else int(x == -1) for x in tg], dtype=np.int8)
            cands, cnt = S.events_of(buy, sell)
        elif typ == 'condition':
            cands, cnt = S.events_of(np.array(seq['buy'], dtype=np.int8), np.array(seq['sell'], dtype=np.int8))
        elif typ == 'named':
            nb = seq['namedBuy']
            cands, cnt = S.events_named(nb, [[] for _ in nb])        # fields.events: no SELL name holds
        else:
            raise CaseFail(f'seq {k}: unknown type {typ}')
        exp = seq['expect']
        got = [[i, S.DIR_NAME[d]] for i, d in cands]
        need(got == exp['signals'], f'seq {k}: signals {got}, expected {exp["signals"]}')
        for key in ('firstSkipped', 'nullPrevSkipped', 'bothSuppressed'):
            need(cnt[key] == exp[key], f'seq {k}: {key} {cnt[key]}, expected {exp[key]}')


# ---------------------------------------------------------------- 6 ③ holes, 1 / 6 ④ halves
def run_hole(case, conv):
    L = Layout(conv, case)
    start, end = ms(case['start']), ms(case['end'])
    period = dict(period_of(L), s0=start, end=end)
    mids = L.get('flatMid')
    missing = {pair: {ms(x) for x in v} for pair, v in case['missing'].items()}
    bars = []
    for pair in D.PAIRS:
        need(pair in mids, f"conventions.hole.flatMid: no '{pair}'")
        opens = [t for t in range(start, end, D.STEP) if t not in missing.get(pair, set())]
        bars.append(mid_bars(L, pair, opens, [flat(mids[pair])] * len(opens)))
    holes, _ = S.holes_of(bars, period)
    for pair, want in case['expect']['holes'].items():
        got = [[a, b] for a, b in holes[D.PAIRS.index(pair)]]
        want = [[ms(a), ms(b)] for a, b in want]
        need(got == want, f'{pair}: holes {got}, expected {want}')
    pi = D.PAIRS.index('USD/JPY')                                   # fields.hole: a USD/JPY bar's open
    pb = bars[pi]
    for t_open, want in case['expect']['overlap']:
        i = pb.index_of.get(ms(t_open))
        need(i is not None, f'no USD/JPY bar opens at {t_open}')
        got = S.in_hole(holes[pi], int(pb.t[max(0, i - S.HOLE_LOOKBACK)]), pb.T(i))
        need(got == want, f'{t_open}: the window overlaps a hole {got}, expected {want}')
        reason, _ = S.classify(pb, i, NO_ITEM_WARMUP, holes[pi], period)
        need((reason == 'r3') == want, f'{t_open}: reason {reason}, expected {"r3" if want else "not r3"}')


def run_half(case, conv):
    L = Layout(conv, case)
    period, pair, m = period_of(L), L.get('pair'), L.get('flatMid')
    a, b = ms(case['from']), ms(case['to'])
    opens = list(range(a, b + D.STEP, D.STEP))                     # both ends included
    pb = mid_bars(L, pair, opens, [flat(m)] * len(opens))
    holes, _ = S.holes_of([pb], period)
    need(holes == [[]], f'holes {holes} (the layout has none)')
    for t_open, reason, half in case['expect']:
        i = pb.index_of.get(ms(t_open))
        need(i is not None, f'no bar opens at {t_open}')
        got = list(S.classify(pb, i, NO_ITEM_WARMUP, holes[0], period))
        need(got == [reason, half], f'{t_open}: {got}, expected {[reason, half]}')


# ---------------------------------------------------------------- 8 Δ, its SE candidates, the week shift
def bstr_of(blind_obs):
    """The blind strata in the stats module's layout (ST.BlindTable.strata): {stratum: (m, mean v, {week: (sum v,
    count)}, {block: (sum v, count)})}, the sums taken in the given order."""
    acc = {}
    for s, w, b, v in blind_obs:
        a = acc.setdefault(s, [0, 0.0, {}, {}])
        a[0] += 1
        a[1] += v
        x = a[2].get(w)
        a[2][w] = (v, 1) if x is None else (x[0] + v, x[1] + 1)
        x = a[3].get(b)
        a[3][b] = (v, 1) if x is None else (x[0] + v, x[1] + 1)
    return {s: (a[0], a[1] / a[0], a[2], a[3]) for s, a in acc.items()}


def check_delta(est, exp):
    """fields.delta: est, N, strata, dropped, use, se / C / df of the SE used, kinds (the candidates in order)."""
    used = next((c for c in est['cands'] if c['kind'] == est['use']), None)
    for key, want in exp.items():
        if key in ('blindPerStratum', 'seasons'):
            continue
        if key == 'est':
            need(close(est['est'], want), f'Δ {est["est"]}, expected {want}')
        elif key in ('N', 'strata', 'dropped', 'use'):
            need(est[key] == want, f'{key} {est[key]}, expected {want}')
        elif key == 'kinds':
            got = [c['kind'] for c in est['cands']]
            need(got == want, f'kinds {got}, expected {want}')
        elif key in ('se', 'C', 'df'):
            need(used is not None, f'no SE used, expected {key} {want}')
            ok = close(used[key], want) if key == 'se' else used[key] == want
            need(ok, f'{key} {used[key]}, expected {want}')
        else:
            raise CaseFail(f'expect.{key}: not a field of kind delta')


def run_delta(case, conv):
    sig = [tuple(o) for o in case['sig']]
    est = ST.delta_est(sig, bstr_of([tuple(o) for o in case['blind']]))
    check_delta(est, case['expect'])


def run_delta_t(case, conv):
    L = Layout(conv, case)
    period, half = period_of(L), L.get('half')
    pair, d, layer = L.get('pair'), DIRS[L.get('dir')], L.get('layer')
    pi = D.PAIRS.index(pair)

    def obs(T, v):          # 8: the stratum of the layer, pair, direction and T; 1: the week and the 4-week block
        return (ST.stratum_of(layer, pi, d, T), D.wk(T), D.block_of(T, half, period), v)
    sig = [obs(ms(T), v) for T, v in case['sig']]
    bstr = bstr_of([obs(ms(T), v) for T, v in case['blind']])
    est = ST.delta_est(sig, bstr)
    exp = case['expect']
    check_delta(est, exp)
    if 'blindPerStratum' in exp:
        got = [bstr[s][0] for s in sorted(est['_ns'])]
        need(got == exp['blindPerStratum'], f'blind rows per stratum {got}, expected {exp["blindPerStratum"]}')
    if 'seasons' in exp:
        got = [D.SEASON_NAMES[D.season_of(ms(T))] for T, _ in case['sig']]
        need(got == exp['seasons'], f'seasons {got}, expected {exp["seasons"]}')


def run_clusters(case, conv):
    L = Layout(conv, case)
    st, sv, bv = L.get('stratum'), L.get('sigVCycle'), L.get('blindVCycle')
    for k, cs in enumerate(case['sets']):
        wb = list(zip(cs['weeks'], cs['blocks']))
        sig = [(st, w, b, sv[j % len(sv)]) for j, (w, b) in enumerate(wb)]
        blind = [(st, w, b, bv[j % len(bv)]) for j, (w, b) in enumerate(wb)]
        est = ST.delta_est(sig, bstr_of(blind))
        kinds = [c['kind'] for c in est['cands']]
        Cs = [c['C'] for c in est['cands']]
        need(kinds == cs['kinds'] and Cs == cs['C'], f'set {k}: kinds {kinds} C {Cs}, expected {cs["kinds"]} {cs["C"]}')


def hand_table(L, rows):
    """conventions.table: a blind table of one pair written by hand, in the stats module's own classes. rows:
    [(bar open, {leg: (kind, pips)})] — a leg not given is conventions.table.legs. The pair's bars are flat at mid at
    those opens only (midBars), the other pairs have none; every row is a blind row (T = open + 5 min, E = mid) of
    half 'half' of period 'period'; e of a BUY row = y10(BUY) − y10(SELL) (8, ST.y_of). Returns (table, pb)."""
    pair, mid, legs = L.get('pair'), L.get('mid'), L.get('legs')
    period, half = period_of(L), L.get('half')
    rows = sorted(rows, key=lambda r: r[0])
    opens = [t for t, _ in rows]
    need(len(set(opens)) == len(opens), 'layout: two rows open at the same time')
    pb = mid_bars(L, pair, opens, [flat(mid)] * len(opens))
    ks = np.arange(pb.n, dtype=np.int64)
    bp = object.__new__(ST.BlindPair)
    bp.pi, bp.pair, bp.k = pb.pi, pair, ks
    bp.T = pb.t[ks] + D.STEP
    bp.E = pb.mc[ks]
    bp.hour, bp.season, bp.week = S.hour_arr(bp.T), S.season_arr(bp.T), S.wk_arr(bp.T)
    bp.block = (bp.week - period['w0'][half]) // 4
    default = (KINDS[legs['kind']], legs['pips'])
    bp.kind, bp.pips, bp.nbars, bp.exi = {}, {}, {}, {}
    for name, _, _ in ST.LEGS:
        vals = [given.get(name, default) for _, given in rows]
        bp.kind[name] = np.array([v[0] for v in vals], dtype=np.int8)
        bp.pips[name] = np.array([v[1] for v in vals], dtype=np.float64)
        bp.nbars[name] = np.full(ks.size, legs['bars'], dtype=np.int32)
        bp.exi[name] = ks + bp.nbars[name]
    e = []
    for kb, ks_ in zip(bp.kind['b10'].tolist(), bp.kind['s10'].tolist()):
        yb, ys = ST.y_of(kb), ST.y_of(ks_)
        e.append(ST.NO_E if yb is None or ys is None else yb - ys)
    bp.eBuy = np.array(e, dtype=np.int8)
    bp.row_of = {int(k): r for r, k in enumerate(ks.tolist())}
    bp.row_of_t = {int(pb.t[k]): r for r, k in enumerate(ks.tolist())}
    pairs = []
    for pi, p in enumerate(D.PAIRS):
        if pi == pb.pi:
            pairs.append(bp)
            continue
        z = object.__new__(ST.BlindPair)
        z.pi, z.pair = pi, p
        z.k = z.T = z.week = z.block = z.hour = z.season = np.zeros(0, dtype=np.int64)
        z.E = np.zeros(0)
        z.eBuy = np.zeros(0, dtype=np.int8)
        z.kind = {name: np.zeros(0, dtype=np.int8) for name, _, _ in ST.LEGS}
        z.pips = {name: np.zeros(0) for name, _, _ in ST.LEGS}
        z.nbars = {name: np.zeros(0, dtype=np.int32) for name, _, _ in ST.LEGS}
        z.exi = {name: np.zeros(0, dtype=np.int64) for name, _, _ in ST.LEGS}
        z.row_of, z.row_of_t = {}, {}
        pairs.append(z)
    table = object.__new__(ST.BlindTable)
    table.half, table.period, table.pairs = half, period, pairs
    table.weeks = sorted(set(bp.week.tolist()))
    table._strata = {}
    return table, pb


def legs_for_e(e):
    """The TP10 legs a BUY row's e gives (8: e = y10(BUY) − y10(SELL)): +1 the BUY takes its TP, −1 the SELL does;
    the others are conventions.table.legs. The pips of a TP leg are not laid out (NaN: nothing here reads them)."""
    if e == 1:
        return {'b10': (ST.KIND_TP, float('nan'))}
    if e == -1:
        return {'s10': (ST.KIND_TP, float('nan'))}
    return {}


def table_trades(L, table, pb, times, d, src):
    """The signals at the bars closing at the times given, as counted trades from the hand table (ST.Trade)."""
    half = L.get('half')
    out = []
    for T in times:
        i = pb.index_of.get(T - D.STEP)
        need(i is not None, f'no row of the table closes at {T}')
        sig = S.Sig(src, pb, i, d, 'counted', half, [])
        out.append(ST.Trade(sig, table.pairs[pb.pi], pb))
    return out


def run_shift(case, conv):
    L = Layout(conv, case)
    period, half, layer = period_of(L), L.get('half'), L.get('layer')
    rows = [(ms(t), legs_for_e(e)) for t, e in case['rows']]
    table, pb = hand_table(L, rows)
    bp = table.pairs[pb.pi]
    for t, e in case['rows']:
        r = bp.row_of_t[ms(t)]
        need(bp.e(r, S.BUY) == e, f'layout: the row {t} gives e {bp.e(r, S.BUY)}, not {e}')
    trades = []
    for T, dname in case['signals']:
        trades += table_trades(L, table, pb, [ms(T)], DIRS[dname], case['id'])
    real = ST.delta_est(ST.obs_of(trades, layer, period, half), table.strata(layer))['est']
    shifts = ST.shift_deltas(trades, table, layer)
    summ = ST.shift_summary(shifts, real)
    exp = case['expect']
    got = {'k': [x[0] for x in shifts], 'dropped': [x[2] for x in shifts]}
    for key in ('k', 'dropped'):
        need(got[key] == exp[key], f'{key} {got[key]}, expected {exp[key]}')
    dk = [x[1] for x in shifts]
    need(len(dk) == len(exp['delta']) and all(close(x, y) for x, y in zip(dk, exp['delta'])),
         f'Δ_k {dk}, expected {exp["delta"]}')
    need(close(real, exp['real']), f'real Δ {real}, expected {exp["real"]}')
    need(close(summ['sd'], exp['sd']), f'SD_shift {summ["sd"]}, expected {exp["sd"]}')
    need(close(summ['mean'], exp['mean']), f'mean {summ["mean"]}, expected {exp["mean"]}')
    need(summ['rank'] == exp['rank'], f'rank {summ["rank"]}, expected {exp["rank"]}')


def run_sepick(case, conv):
    L = Layout(conv, case)
    C, df, per = L.get('C'), L.get('df'), L.get('sePerHalf')
    for k, (cands, want) in enumerate(case['items']):
        cs = [{'kind': kind, 'half': h, 'se': h * per, 'C': C, 'df': df} for kind, h in cands]
        got = ST.pick(cs)['kind']
        need(got == want, f'item {k}: {got}, expected {want}')


def run_tq(case, conv):
    for df, want in case['items']:
        got = ST.tq(0.975, df)
        need(abs(got - want) <= case['tol'], f't(0.975, {df}) = {got}, expected {want}')


# ---------------------------------------------------------------- 10, 12 counts and the choice; 14 Holm; 11
def run_lbcount(case, conv):
    exp = case['expect']
    got = SEL.item_count(case['ids'])
    need(got == exp['items'], f'items {got}, expected {exp["items"]}')
    got = SEL.group_count(case['ids'], case['groups'])
    need(got == exp['groups'], f'groups {got}, expected {exp["groups"]}')
    for xs, want in case['p95']:
        got = SEL.p95_of(xs)
        need(got == want, f'95% point of {xs}: {got}, expected {want}')


def made_est(L, est, se, df, pattern, N):
    """conventions.rows: an estimate [Δ, SE] on df: C = df + 1 week clusters, cluster g carrying a × p[g mod len(p)]
    with a = SE × √(C − 1) ÷ C (the week SE of 8 is then SE), no 4-week block; SE null: no cluster, no t. Built with
    the stats module's own candidate, SE and Est functions."""
    if se is None:
        r = ST.finish(est, N, 1, 0, [])
        r['_if'] = ({}, {})
        r['_ns'] = {}
        return r
    patterns = L.get('patterns')
    need(pattern in patterns, f"conventions.rows.patterns: no '{pattern}'")
    p = patterns[pattern]
    C = df + 1
    amp = se * math.sqrt(C - 1) / C
    wk = {g: amp * p[g % len(p)] for g in range(C)}
    r = ST.finish(est, N, 1, 0, [ST._cand('week', ST._se(wk, C), C)])
    r['_if'] = (wk, {})
    r['_ns'] = {0: N}
    return r


def point_est(late, N):
    """conventions.rows: Δ_late [Δ_late, low end, high end] is a point with its interval and no SE."""
    est, lo, hi = late
    return {'est': est, 'N': N, 'strata': 1, 'dropped': 0, 'cands': [], 'use': None, 't': None, 'lo': lo, 'hi': hi,
            'lb': lo}


def made_winpl(w, resolved):
    """conventions.rows: [W of the resolved, PL]; n = resolved, tp = W × resolved to the nearest whole number, sl =
    resolved − tp, no amb, none open, W of all = W of the resolved, no interval."""
    W, pl = w
    tp = int(math.floor(W * resolved + 0.5))
    return {'n': resolved, 'resolved': resolved, 'tp': tp, 'sl': resolved - tp, 'amb': 0, 'open': 0,
            'wAll': W, 'wRes': W, 'pl': pl, 'wLo': None, 'wHi': None, 'plLo': None, 'plHi': None}


def made_row(L, delta, late, a, w4, w10, df, pattern, by_dir=None, n_e=None):
    """A made-up row of a half (conventions.rows): Δ on its pattern, a on itemPattern, Δ_late a point, W1 / PL1 /
    W2 / PL2 all resolved, N e-signals in one stratum, the blind's W1 / PL1, no pair row, a direction not given
    without e-signals; its suspicious lines from its own numbers (13, ST.suspicious)."""
    N = L.get('N') if n_e is None else n_e
    resolved = L.get('resolved')
    by = {}
    for dn in ('BUY', 'SELL'):
        x = (by_dir or {}).get(dn)
        by[dn] = ({'est': x[0], 'N': x[1], 'strata': 1, 'dropped': 0} if x is not None else
                  {'est': None, 'N': 0, 'strata': 0, 'dropped': 0})
    row = {'delta': made_est(L, delta[0], delta[1], df, pattern, N),
           'a': made_est(L, a[0], a[1], df, L.get('itemPattern'), N),
           'late': point_est(late, N), 'w4': made_winpl(w4, resolved), 'w10': made_winpl(w10, resolved),
           'blindW1': L.get('blindW1'), 'blindPl1': L.get('blindPl1'), 'byDir': by, 'byPair': dict(L.get('byPair')),
           'counted': L.get('counted') if n_e is None else n_e, 'nE': L.get('nE') if n_e is None else n_e,
           '_unresolved': L.get('unresolved'), '_lateExcluded': L.get('lateExcluded')}
    need(row['_unresolved'] == 0 and row['_lateExcluded'] == 0, 'conventions.rows: unresolved / lateExcluded other '
         'than 0 cannot be laid out on these rows')
    row['suspicious'] = ST.suspicious(row)
    return row


def run_select(case, conv):
    L = Layout(conv, case)
    t_lb, checks, counts_only = L.get('tWhenLb'), L.get('checksPass'), L.get('countsOnlySuspicion')
    hits, fill = L.get('yardstickHits'), L.get('fill')
    need(checks is True, 'conventions.select.checksPass false: SEL.stage1 takes the checks as passed (12「確かめ（20）'
         'がすべて通る」 is the run\'s)')
    for k, st in enumerate(case['sets']):
        rows = {}
        for item, delta, lb, n_e, lines in st['rows']:
            row = made_row(L, [delta, fill['deltaSe']], [delta] + list(fill['lateLoHi']), fill['a'], fill['w4'],
                           fill['w10'], fill['df'], L.get('itemPattern'), n_e=n_e)
            d = row['delta']
            d['t'] = t_lb if lb is not None else None              # select: an LB has t = tWhenLb; null: no t
            d['lb'] = d['lo'] = lb
            if lb is None:
                d['hi'] = None
            row['suspicious'] = list(lines)
            rows[item] = row
        sel = SEL.stage1(rows, st['groups'], counts_only=counts_only)
        SEL.stop_on_yardsticks(sel, hits, counts_only)
        exp = st['expect']
        for g in ('chart', 'cal'):
            need(sel['chosen'][g] == exp[g], f'set {k}: {g} {sel["chosen"][g]}, expected {exp[g]}')
        need(sel['notEligible'] == exp['notEligible'], f'set {k}: not eligible {sel["notEligible"]}, '
             f'expected {exp["notEligible"]}')


def run_holm(case, conv):
    for k, st in enumerate(case['sets']):
        got = SEL.holm_order([tuple(x) for x in st['items']])
        for item, (rank, ok) in st['expect'].items():
            g = got[item]
            need((g['holmRank'], g['holmPass']) == (rank, ok),
                 f'set {k}: {item} rank {g["holmRank"]} pass {g["holmPass"]}, expected {rank} {ok}')


def run_groups(case, conv):
    L = Layout(conv, case)
    missing = L.get('missingShare')
    for k, st in enumerate(case['sets']):
        items = st['items']
        share = {f'{a}>{b}': case['overlap'].get(f'{a}>{b}', missing) for a in items for b in items if a != b}
        ids = CNT.groups_of(items, share)
        need(set(ids) == set(items), f'set {k}: groups of {sorted(ids)}, expected {sorted(items)}')
        got = {s: min((x for x in items if ids[x] == ids[s]), key=D.ORDER.get) for s in items}
        need(got == st['expect'], f'set {k}: {got}, expected {st["expect"]}')


def run_floor(case, conv):
    for h1, h2, want in case['items']:
        got = CNT.floor_of(tuple(h1), tuple(h2))
        need(got == want, f'{h1} {h2}: {got}, expected {want}')


# ---------------------------------------------------------------- 13 suspicious lines
def run_suspect(case, conv):
    L = Layout(conv, case)
    wf, other, late_null, blind0 = L.get('wFields'), L.get('otherCounts'), L.get('lateWhenNull'), L.get('blind')

    def wp(arr):
        d = dict(zip(wf, arr))
        d['n'] = d['resolved']
        d.update(other)
        return d
    for k, (over, want) in enumerate(case['items']):
        f = dict(case['base'])
        f.update(over)
        blind = f.pop('blind', blind0)
        late = f['late'] if f['late'] is not None else f[late_null]
        row = {'delta': {'est': f['delta']}, 'a': {'est': f['a']}, 'late': {'est': late},
               'w4': wp(f['w4']), 'w10': wp(f['w10'])}
        got = ST.suspicious(row, blind=blind)
        need(got == want, f'item {k} {over}: {got}, expected {want}')


# ---------------------------------------------------------------- 21 numbers and sentences, 9 the win rates
def run_text_numbers(case, conv):
    fmt = {'pts': TX.pts, 'pct': TX.pct, 'pips': TX.pips, 'yen': TX.yen}
    for f, v, want in case['items']:
        need(f in fmt, f'unknown format {f}')
        got = fmt[f](v)
        need(got == want, f'{f}({v}) = {got}, expected {want}')


def run_win_denominator(case, conv):
    L = Layout(conv, case)
    t0, pips = ms(L.get('tradesFrom')), L.get('tradePips')
    w = ST.winpl([(t0 + k * D.STEP, KINDS[x], pips) for k, x in enumerate(case['trades'])])
    for key, want in case['expectW'].items():
        ok = close(w[key], want) if isinstance(want, float) else w[key] == want
        need(ok, f'{key} {w[key]}, expected {want}')
    period, half, layer = period_of(L), L.get('half'), L.get('layer')
    e = L.get('rowE')
    rows = []
    for t, kind, p in case['rows']:
        given = legs_for_e(e)
        given['b4'] = (KINDS[kind], p)
        rows.append((ms(t), given))
    table, pb = hand_table(L, rows)
    bp = table.pairs[pb.pi]
    need(all(bp.e(r, S.BUY) == e for r in range(bp.k.size)), f'layout: the rows do not give e {e}')
    trades = table_trades(L, table, pb, [ms(T) for T in case['signals']], DIRS[L.get('signalDir')], case['id'])
    delta = ST.delta_est(ST.obs_of(trades, layer, period, half), table.strata(layer))
    w1, pl1 = ST.blind_weighted(delta, table, layer)
    exp = case['expect']
    need(close(w1, exp['blindW1']), f'blind W1 {w1}, expected {exp["blindW1"]}')
    need(close(pl1, exp['blindPl1']), f'blind PL1 {pl1}, expected {exp["blindPl1"]}')


def email_rows(L, ultra, macd, se, pattern, df):
    """conventions.rows: an email's row takes Δ from its case's group (text, dab), Δ_late one point (low = high = Δ),
    a, w4 and w10 from rows.email; its chart and calendar layers are the same row."""
    em = L.get('email')
    out = {}
    for src, d in (('ultra5', ultra), ('macdx5', macd)):
        row = made_row(L, [d, se], [d, d, d], em['a'], em['w4'], em['w10'], df, pattern)
        out[src] = {'chart': row, 'cal': row}
    return out


def stage2_texts(st2, rows, mrows, m1, chosen):
    """21 段2: each item's sentence and the last sentence, as TX.stage2_sentences writes them (its いつも添える文
    needs the blind's rows, which no case lays out)."""
    K = len(chosen)
    out = {}
    for s in sorted(chosen, key=D.ORDER.get):
        g = D.GROUP_OF[s]
        out[f's2.item.{s}'] = TX.stage2_item(s, rows[s], st2['items'][s], K, mrows, st2['promote'][g], g)
    out['s2.final'] = TX.stage2_final(st2, m1, K)
    return out


def check_text(texts, want, where=''):
    for sid, cond in want.items():
        need(sid in texts, f'{where}no sentence {sid}')
        t = texts[sid]
        for frag in cond.get('contains', []):
            need(frag in t, f'{where}{sid} lacks 「{frag}」 (text: {t})')
        for frag in cond.get('absent', []):
            need(frag not in t, f'{where}{sid} holds 「{frag}」')
        if 'startsWith' in cond:
            need(t.startswith(cond['startsWith']), f'{where}{sid} does not start with 「{cond["startsWith"]}」 (text: {t})')


def run_text(case, conv):
    L = Layout(conv, case)
    df, m1 = L.get('df'), L.get('m1')
    item_pat = L.get('itemPattern')
    if 'scenarios' in case:
        base = L.get('scenarioItem')
        for k, sc in enumerate(case['scenarios']):
            item = sc['item']
            rows = {item: made_row(L, base['delta'], base['late'], base['a'], base['w4'], base['w10'], df,
                                   base.get('pattern', item_pat), base.get('byDir'))}
            mrows = email_rows(L, sc['ultra'], sc['macd'], L.get('emailSe'), L.get('emailPattern'), df)
            st2 = SEL.stage2([item], rows, mrows, {item: set(base.get('byDir') or {}) == {'BUY', 'SELL'}})
            texts = stage2_texts(st2, rows, mrows, m1, [item])
            check_text(texts, {f's2.item.{item}': {'contains': sc['contains']}}, f'scenario {k}: ')
        return
    rows, both = {}, {}
    for it in case['items']:
        rows[it['id']] = made_row(L, it['delta'], it['late'], it['a'], it['w4'], it['w10'], df,
                                  it.get('pattern', item_pat), it.get('byDir'))
        both[it['id']] = set(it.get('byDir') or {}) == {'BUY', 'SELL'}     # 14 C2: an item giving both directions
    chosen = [it['id'] for it in case['items']]
    e_delta, e_se, e_pat = L.get('emailDelta'), L.get('emailSe'), L.get('emailPattern')
    mrows = email_rows(L, e_delta, e_delta, e_se, e_pat, df)
    st2 = SEL.stage2(chosen, rows, mrows, both)
    exp = case['expect']
    for s, want in exp.get('judgments', {}).items():
        got = st2['items'][s]['judgment']
        need(got == want, f'{s}: judgment {got}, expected {want}')
    for s, want in exp.get('forms', {}).items():
        got = st2['items'][s]['form']
        need(got == want, f'{s}: form {got}, expected {want}')
    check_text(stage2_texts(st2, rows, mrows, m1, chosen), exp.get('text', {}))


def run_dab(case, conv):
    L = Layout(conv, case)
    df, m1, pats, it = L.get('df'), L.get('m1'), L.get('patternByIndex'), L.get('item')
    rows = {}
    chosen = []
    for k, (item, d, se) in enumerate(case['items']):
        need(k < len(pats), f'conventions.dab.patternByIndex has no entry {k}')
        rows[item] = made_row(L, [d, se], [d, it['lateLo'], d + it['lateHiAboveEst']], it['a'], it['w4'], it['w10'],
                              df, pats[k])
        chosen.append(item)
    e_delta, e_se, e_pat = L.get('emailDelta'), L.get('emailSe'), L.get('emailPattern')
    mrows = email_rows(L, e_delta, e_delta, e_se, e_pat, df)
    st2 = SEL.stage2(chosen, rows, mrows, {})
    exp = case['expect']
    g = D.GROUP_OF[chosen[0]]
    need(st2['promote'][g] == exp['promote'], f'promoted {st2["promote"][g]}, expected {exp["promote"]}')
    conf = [s for s in chosen if st2['items'][s]['judgment'] == 'confirmed']
    need(conf == exp['confirmed'], f'confirmed {conf}, expected {exp["confirmed"]}')
    dab = [x for x in st2['dAB'] if x['A'] == exp['promote']]
    need(len(dab) == 1, f'D_AB rows {[(x["A"], x["B"]) for x in st2["dAB"]]}')
    used = next((c for c in dab[0]['est']['cands'] if c['kind'] == dab[0]['est']['use']), None)
    need(used is not None and close(used['se'], exp['se']), f'D_AB SE {used and used["se"]}, expected {exp["se"]}')
    check_text(stage2_texts(st2, rows, mrows, m1, chosen), {'s2.final': {'contains': exp['contains']}})


# ---------------------------------------------------------------- holdText, holdRange (21 オーナーの持ち方の文; §8.102 書く文)
# Added 2026-10-13 by the step-2b Python fixer (python-issues.md PI-2), who has not read the TS: each case's facts
# (fields.holdText / fields.holdRange; times as ISO strings) go through the Python's own sentence builder
# (research/chartbest-check-holdtext.py, written from 21, §8.102 and SQ-08 / SQ-H1), and the sentence must equal
# expect.text character for character. The case's verdict must also be the one the facts give (§8.102 ①②③, 9).
HT = _mod('holdtext')


def hold_facts(f):
    """A copy of one account's facts with its times (lcAt, deadlineAt, cappedCalls[].tau) as integer ms."""
    g = json.loads(json.dumps(f))
    for r in (g.get('rows') or {}).values():
        r['lcAt'] = [ms(x) for x in r.get('lcAt') or []]
        r['deadlineAt'] = [ms(x) for x in r.get('deadlineAt') or []]
        for c in r.get('cappedCalls') or []:
            c['tau'] = ms(c['tau'])
    return g


def same_text(got, want):
    if got == want:
        return
    k = next((i for i, (a, b) in enumerate(zip(got, want)) if a != b), min(len(got), len(want)))
    need(False, f'text differs from expect.text at character {k} (expected 「{want[max(0, k - 20):k + 30]}」, '
                f'got 「{got[max(0, k - 20):k + 30]}」)')


def run_hold_text(case, conv):
    f = hold_facts(case['facts'])
    if not f.get('timedOut'):
        v = HT.verdict_of(f)
        need(v == f['verdict'], f"the facts give the verdict {v}, the case says {f['verdict']}")
    same_text(HT.hold_text(f), case['expect']['text'])


def run_hold_range(case, conv):
    same_text(HT.hold_range_text([hold_facts(a) for a in case['facts']]), case['expect']['text'])


RUNNERS = {
    'c1': run_c1, 'k1': run_k1, 'dst': run_dst, 'round': run_round, 'points': run_points, 'follow': run_follow,
    'mirror': run_mirror, 'sent': run_sent, 'events': run_events, 'hole': run_hole, 'half': run_half,
    'delta': run_delta, 'deltaT': run_delta_t, 'clusters': run_clusters, 'shift': run_shift, 'sepick': run_sepick,
    'tq': run_tq, 'lbcount': run_lbcount, 'select': run_select, 'holm': run_holm, 'groups': run_groups,
    'floor': run_floor, 'suspect': run_suspect, 'textNumbers': run_text_numbers,
    'winDenominator': run_win_denominator, 'text': run_text, 'dab': run_dab,
    'holdText': run_hold_text, 'holdRange': run_hold_range,
}


def main(path):
    try:
        with open(path, 'rb') as f:
            raw = f.read()
        hand = json.loads(raw)
        cases, conv = hand['cases'], hand['conventions']
        if not isinstance(cases, list) or not isinstance(conv, dict):
            raise ValueError('cases is not a list or conventions is not an object')
    except (OSError, ValueError, KeyError, TypeError) as e:
        print(f'ERROR: {path} cannot be read as hand.json ({e!r})', file=sys.stderr)
        return 2
    print(f'sha256 {path} {hashlib.sha256(raw).hexdigest()}')
    passed = 0
    for case in cases:
        cid = case.get('id', '?') if isinstance(case, dict) else '?'
        try:
            need(isinstance(case, dict), 'not an object')
            runner = RUNNERS.get(case.get('kind'))
            need(runner is not None, f'no runner for the kind {case.get("kind")!r}')
            runner(case, conv)
            passed += 1
            print(f'ok   handjson.{cid}')
        except CaseFail as e:
            print(f'FAIL handjson.{cid} ({e})')
        except Exception as e:  # noqa: BLE001 — a case that raises fails; its message is the problem
            print(f'FAIL handjson.{cid} (crash {e!r})')
    print(f'hand.json: {passed} of {len(cases)} passed')
    return 0 if passed == len(cases) else 1


if __name__ == '__main__':
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                                                     'chartbest', 'hand.json')))
