#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
chartbest-check-count.py — stage 0 of the independent Python re-computation of docs/OPERATIONS.md §8.113 (11):
the counts per item / measure and half, the floor, M_1, the overlap groups, W_h and the detectable-size
projections. No outcome is read here (11「段0のプログラムは、追い方のコードを読み込まない」): only bars, signals,
holes and the blind table's bars (①〜④, no follow).

Interpretations (spec-questions.md; each is a constant here):
  * REASON_HALF_BY_T: an excluded signal is counted in the half of its T (T < SPLIT -> H1), so that per half
    all signals = r1 + r2 + r3 + r4 + counted (20 (h)) holds.
  * SQ-05 (stage0NoBlindByRows): "層にブラインドが無い合図" = counted signals whose stratum holds no blind-table bar.
  * SQ-20 (weeksOfHalf = blindBars): W_h = the weeks holding >= 1 blind-table bar of the half, any pair.
  * SQ-21 (wideSlotOf = T): the 15-minute slot holding T, the season of T.
  * SQ-18 (projectionDf = modeKindRealH2C): df = C - 1 with the kind most chosen in N's first halves
    (n-summary.json; week when absent) and C counted on the real second half's blind bars.
"""
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

REASON_HALF_BY_T = True
G_DEFAULT = 2.0                 # 11: g = 2 where N's output gives none (and said so)
SE_ONE = 0.47                   # 11: a's one-signal standard deviation (§8.107)
N2_WEEKS_STAGE3 = 26 / 72       # 11: n2 x 26 / 72
STAGE3_MIN = 100
MARK_LINE = 0.10                # 11/13: the suspicious line (10 points)
MARK_PASS_MIN, MARK_SIZE = 'passMin', 'size'      # 11/16: the marks' names (names only)
OVERLAP_MS = 30 * D.MIN         # 11: |T_A - T_B| <= 30 minutes
OVERLAP_JOIN = 0.5


class Blind:
    """The blind table's bars of each half per pair (no outcomes): bar indices, T, strata keys."""

    def __init__(self, bars, holes, period):
        self.idx = {}
        for h in ('H1', 'H2'):
            for pb in bars:
                m = S.blind_mask(pb, holes[pb.pi], h, period)
                self.idx[(h, pb.pi)] = np.nonzero(m)[0]
        self.period = period
        self.bars = bars
        self._weeks = {}
        self._hs = {}

    def weeks(self, h):
        """W_h: the weeks holding >= 1 blind-table bar of the half (any pair), ascending."""
        if h not in self._weeks:
            ws = set()
            for pb in self.bars:
                T = pb.t[self.idx[(h, pb.pi)]] + D.STEP
                ws.update(S.wk_arr(T).tolist())
            self._weeks[h] = sorted(ws)
        return self._weeks[h]

    def blocks(self, h):
        w0 = self.period['w0'][h]
        return sorted({(w - w0) // 4 for w in self.weeks(h)})

    def hour_seasons(self, h, pi):
        """The (hour, season) pairs of the pair's blind bars in a half (for 'no blind bar in the stratum')."""
        key = (h, pi)
        if key not in self._hs:
            pb = self.bars[pi]
            T = pb.t[self.idx[key]] + D.STEP
            self._hs[key] = set(zip(S.hour_arr(T).tolist(), S.season_arr(T).tolist()))
        return self._hs[key]


def layers_of(src):
    """The layers a source is evaluated in: an item its group's, a measure both (10)."""
    if src in D.MEASURES:
        return ('chart', 'cal')
    return (D.GROUP_OF[src],)


def breedon_missing(pb, item, period):
    """K1「足が無ければ、その日は合図なし（数と日付を出す）」: New York weekdays whose expected bar (02:55 / 10:55
    New York) is absent, by the half of that bar's T; each as its New York date."""
    out = {'H1': [], 'H2': []}
    if pb.pair != 'EUR/USD':
        return out
    have = set(pb.t.tolist())
    minute = S.BREEDON_MINUTE[item]
    day = (period['start'] - 2 * D.DAY) // D.DAY
    last = period['end'] // D.DAY + 1
    for dn in range(day, last + 1):
        if (dn + 3) % 7 > 4:
            continue                                   # the New York date is a weekend
        local = dn * D.DAY + minute * D.MIN            # the wall clock as if UTC
        t = local + 5 * D.HOUR                         # try winter first
        if D.ny_offset(t) != -5 * D.HOUR:
            t = local + 4 * D.HOUR
        T = t + D.STEP
        if T < period['start'] or T >= period['end']:
            continue
        if t not in have:
            out[D.half_of_T(T, period)].append(D.iso_date(local))
    return out


def stage0(bars, sigs, both, holes, period, blind, wide, n_summary=None):
    """counts.json of the plan's 4.3 (the Python's own layout; see build-py.md)."""
    out = {}
    floor_ok = {}
    W = {h: len(blind.weeks(h)) for h in ('H1', 'H2')}
    by_src = {}
    for s in sigs:
        by_src.setdefault(s.src, []).append(s)
    for src in D.TRIAL_ITEMS + D.MEASURES:
        rec = {}
        mine = by_src.get(src, [])
        pairs = S.item_pairs(src)
        for h in ('H1', 'H2'):
            counted = [s for s in mine if s.reason == 'counted' and s.half == h]
            excl = [s for s in mine if s.reason != 'counted' and D.half_of_T(s.T, period) == h]
            r = {k: sum(1 for s in excl if s.reason == k) for k in ('r1', 'r2', 'r3', 'r4')}
            by_pd = {}
            for pair in pairs:
                for d in (S.BUY, S.SELL):
                    by_pd[f'{pair} {S.DIR_NAME[d]}'] = sum(1 for s in counted if s.pair == pair and s.dir == d)
            no_blind = {}
            for layer in layers_of(src):
                k = 0
                for s in counted:
                    if layer == 'cal':
                        has = blind.idx[(h, s.pi)].size > 0
                    else:
                        has = (D.utc_hour(s.T), D.season_of(s.T)) in blind.hour_seasons(h, s.pi)
                    k += 0 if has else 1
                no_blind[layer] = k
            warm = S.item_warmup(src) if src in S.ITEM_DEFS else S.WINDOW - 1
            warm_date = {pb.pair: int(pb.t[warm]) + D.STEP for pb in bars if pb.pair in pairs and pb.n > warm}
            wide_n = sum(1 for s in counted if D.wide_slot(wide, s.pair, s.T))
            extra = {}
            if src.startswith('breedon'):
                miss = breedon_missing(bars[D.PAIRS.index('EUR/USD')], src, period)[h]
                extra = {'missingDays': len(miss), 'missingDates': miss,
                         'shiftedWeek': sum(1 for s in counted if 'shiftedWeek' in s.marks)}
            rec[h] = {
                'counted': len(counted),
                'weeks': len({D.wk(s.T) for s in counted}),
                'byPairDir': by_pd,
                'reasons': r,
                'bothSuppressed': sum(1 for (sr, _, T) in both if sr == src and D.half_of_T(T, period) == h),
                'noBlindRows': no_blind,
                'warmDate': warm_date,
                'wideShare': (wide_n / len(counted)) if counted else None,
                'perWeek': (len(counted) / W[h]) if W[h] else None,
                'extra': extra,
            }
        if src in D.MEASURES:
            rec['floor'] = None                           # 11: the floor is the items' (build-py.md)
        else:
            ok = floor_of(*((rec[h]['counted'], rec[h]['weeks']) for h in ('H1', 'H2')))
            rec['floor'] = ok
            floor_ok[src] = ok
        out[src] = rec
    passing = [x for x in D.TRIAL_ITEMS if floor_ok.get(x)]
    out['M1'] = {'chart': sum(1 for x in passing if D.GROUP_OF[x] == 'chart'),
                 'cal': sum(1 for x in passing if D.GROUP_OF[x] == 'cal')}
    overlap, groups = overlap_groups(passing, by_src)
    out['groups'] = groups
    out['overlap'] = overlap
    out['Wh'] = W
    out['projections'] = projections(passing, out, blind, n_summary)
    return out


def overlap_groups(passing, by_src):
    """11: share(A->B) over A's first-half counted signals; join when max(A->B, B->A) >= 0.5; links only between
    floor-passing items; the forced joins (same candidate, ledger ⑨) among floor-passing items; union-find.
    Group id = the smallest table order of its members."""
    h1 = {}
    for src in passing:
        lst = [s for s in by_src.get(src, []) if s.reason == 'counted' and s.half == 'H1']
        by = {}
        for s in lst:
            by.setdefault((s.pi, s.dir), []).append(s.T)
        h1[src] = (lst, {k: np.array(sorted(v), dtype=np.int64) for k, v in by.items()})
    share = {}
    for a in passing:
        for b in passing:
            if a == b:
                continue
            lst, _ = h1[a]
            _, idx_b = h1[b]
            hit = 0
            for s in lst:
                arr = idx_b.get((s.pi, s.dir))
                if arr is None or arr.size == 0:
                    continue
                j = int(np.searchsorted(arr, s.T - OVERLAP_MS, side='left'))
                if j < arr.size and arr[j] <= s.T + OVERLAP_MS:
                    hit += 1
            share[f'{a}>{b}'] = (hit / len(lst)) if lst else None
    return share, groups_of(passing, share)


def groups_of(passing, share):
    """11: the overlap groups of the floor-passing items from the shares {'A>B': share or None}: joined when
    max(A->B, B->A) >= 0.5 (links only between the items given; an item outside them is never passed through),
    plus the forced joins (same candidate, ledger ⑨) among them; union-find. Group id = the smallest table order."""
    parent = {x: x for x in passing}

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def join(x, y):
        rx, ry = find(x), find(y)
        if rx != ry:
            parent[max(rx, ry, key=D.ORDER.get)] = min(rx, ry, key=D.ORDER.get)

    for a in passing:
        for b in passing:
            if D.ORDER[a] < D.ORDER[b]:
                ab, ba = share.get(f'{a}>{b}'), share.get(f'{b}>{a}')
                m = max(x for x in (ab, ba, 0.0) if x is not None)
                if m >= OVERLAP_JOIN:
                    join(a, b)
    for grp in D.SAME_CANDIDATE + D.LEDGER_GROUPS:
        mem = [x for x in grp if x in parent]
        for x in mem[1:]:
            join(mem[0], x)
    groups = {}
    for x in passing:
        r = find(x)
        members = [y for y in passing if find(y) == r]
        groups[x] = min(D.ORDER[y] for y in members)
    return groups


def floor_of(h1, h2):
    """11 床: counted >= 300 and signal weeks >= 30 in both halves; h1 / h2 = (counted, weeks)."""
    return all(n >= D.FLOOR_N and w >= D.FLOOR_WEEKS for n, w in (h1, h2))


def projections(passing, counts, blind, n_summary):
    """11: g, SE-proj = 0.47 sqrt(g / n2), pass-min = t(1 - 0.025/4, df) SE, size = (that + t(0.80, df)) SE,
    the marks at >= 10 points, n2 x 26 / 72 (< 100 named)."""
    st = _mod('stats')
    out = {}
    for src in passing:
        n2 = counts[src]['H2']['counted']
        info = (n_summary or {}).get(src) or {}
        g = info.get('g')
        given = g is not None
        g = float(g) if given else G_DEFAULT
        kind = info.get('kind') or 'week'
        C = len(blind.blocks('H2')) if kind == '4w' else len(blind.weeks('H2'))
        df = C - 1
        se = SE_ONE * math.sqrt(g / n2) if n2 > 0 else None
        q1 = st.tq(1 - D.ALPHA / 4, df) if df >= 1 else None
        q8 = st.tq(0.80, df) if df >= 1 else None
        pass_min = q1 * se if (q1 is not None and se is not None) else None
        size = (q1 + q8) * se if (q1 is not None and q8 is not None and se is not None) else None
        marks = []
        if pass_min is not None and pass_min >= MARK_LINE:
            marks.append(MARK_PASS_MIN)
        if size is not None and size >= MARK_LINE:
            marks.append(MARK_SIZE)
        n26 = n2 * 26 / 72
        if n26 < STAGE3_MIN:
            marks.append('n26')
        out[src] = {'g': g, 'gGiven': given, 'kind': kind, 'df': df, 'passMin': pass_min, 'size': size,
                    'marks': marks, 'n26': n26}
    return out


def load_n_summary(path):
    if not path:
        return None
    with open(path, encoding='utf-8') as f:
        return json.load(f)
