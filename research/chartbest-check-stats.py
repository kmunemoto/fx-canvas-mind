#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
chartbest-check-stats.py — the outcomes and the statistics of the independent Python re-computation of
docs/OPERATIONS.md §8.113 (7, 8, 9, 10, 13): the follow (tf-winrate's), the blind table, each signal's trade and
mirror, e, Δ with its influence function and the SE candidates (week, 4 weeks, week shift), the week shift itself,
Δ_late, the unaligned a, W1/PL1/W2/PL2 (tf-winrate's intervals), the blind-weighted W1/PL1, Δ by direction and by
pair, the non-overlapping Δ and the suspicious lines.

Written from the docs and the plan only. Where the docs name code as the definition it is re-written here:
  * t (8「money-stats.ts の tQuantile と同じ作り（不完全ベータ関数と2分法）」): Numerical Recipes' betacf (Lentz)
    and bisection to a width of 1e-12 (math.lgamma for the log-gamma).
  * the follow (7「tf-winrate の follow」): from the first bar starting at or after T, on the side it leaves on,
    each bar in turn: the open past the stop -> the stop at the open; else the open past the target -> the target at
    the open; else both reached -> the stop (amb); one -> that level; 1,440 bars without either -> the 1,440th
    close (open). Comparisons with equality, no rounding.
  * W/PL intervals (14「W1・PL1・W2・PL2 と幅（週の塊。tf-winrate と同じ）」, SQ-30): clusterRate over the resolved
    trades and meanCi over all, 1.96 x the week-clustered SE.
Sums run oldest first in plain loops or ordered cumulative sums; reals are compared with the TS within 1e-9.
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

KIND_TP, KIND_SL, KIND_AMB, KIND_OPEN = 0, 1, 2, 3
KIND_LETTER = 'tsao'
NO_E = 2                         # eBuy 'none'
FEW_BLOCKS = 10                  # 8「4週の塊が10に足りなければ週だけ」 (SQ-03: drops only the 4-week candidate)
Z_TF = 1.96                      # tf-winrate's intervals (SQ-30)
FEW_RESOLVED = 30                # 9「決着が30回未満の行は、勝率を書かない」
# Descriptive Est fields the plan names but does not define (SQ-P19): the unaligned a and a difference D have no
# strata of their own, and D no N of its own (null; both programs write null since the joint run of 2026-10-12).
A_STRATA = None
D_STRATA = None

# ---------------------------------------------------------------- Student's t
def _betacf(a, b, x):
    tiny = 1e-300
    qab, qap, qam = a + b, a + 1, a - 1
    c = 1.0
    d = 1 - qab * x / qap
    if abs(d) < tiny:
        d = tiny
    d = 1 / d
    h = d
    for m in range(1, 501):
        m2 = 2 * m
        aa = m * (b - m) * x / ((qam + m2) * (a + m2))
        d = 1 + aa * d
        if abs(d) < tiny:
            d = tiny
        c = 1 + aa / c
        if abs(c) < tiny:
            c = tiny
        d = 1 / d
        h *= d * c
        aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2))
        d = 1 + aa * d
        if abs(d) < tiny:
            d = tiny
        c = 1 + aa / c
        if abs(c) < tiny:
            c = tiny
        d = 1 / d
        de = d * c
        h *= de
        if abs(de - 1) < 1e-15:
            break
    return h


def _ibeta(a, b, x):
    if x <= 0:
        return 0.0
    if x >= 1:
        return 1.0
    bt = math.exp(math.lgamma(a + b) - math.lgamma(a) - math.lgamma(b) + a * math.log(x) + b * math.log(1 - x))
    if x < (a + 1) / (a + b + 2):
        return bt * _betacf(a, b, x) / a
    return 1 - bt * _betacf(b, a, 1 - x) / b


def tcdf(t, df):
    """Student's t cumulative distribution."""
    p = 0.5 * _ibeta(df / 2, 0.5, df / (df + t * t))
    return 1 - p if t >= 0 else p


_TQ = {}


def tq(p, df):
    """The p quantile (p > 0.5) of Student's t with df degrees of freedom: bisection to a width of 1e-12."""
    if not (df >= 1) or not (0.5 < p < 1):
        return float('nan')
    key = (p, df)
    if key in _TQ:
        return _TQ[key]
    lo, hi = 0.0, 1.0
    while tcdf(hi, df) < p:
        hi *= 2
    k = 0
    while k < 200 and hi - lo > 1e-12:
        mid = (lo + hi) / 2
        if tcdf(mid, df) < p:
            lo = mid
        else:
            hi = mid
        k += 1
    _TQ[key] = (lo + hi) / 2
    return _TQ[key]


def zero(x):
    """8「|x| < 1e-12 は0とする」."""
    return x is None or abs(x) < D.ZERO


def gt0(x):
    return x is not None and not zero(x) and x > 0


def lt0(x):
    return x is not None and not zero(x) and x < 0


# ---------------------------------------------------------------- the follow (7)
def follow_many(pb, frm, buy, sl, tp, plant=''):
    """Many trades at once: frm (first bar followed), sl, tp arrays. Returns kind, exit, bars, exit index."""
    m = frm.size
    kind = np.full(m, -1, dtype=np.int8)
    ex = np.full(m, np.nan)
    nb = np.zeros(m, dtype=np.int32)
    exi = np.full(m, -1, dtype=np.int64)
    if m == 0:
        return kind, ex, nb, exi
    if buy:
        o, h, lo, c = pb.bo, pb.bh, pb.bl, pb.bc
    else:
        o, h, lo, c = pb.ao, pb.ah, pb.al, pb.ac
    if plant == 'buyExitAsk' and buy:
        o, h, lo, c = pb.ao, pb.ah, pb.al, pb.ac
    act = np.arange(m)
    for off in range(D.TRACK):
        if act.size == 0:
            break
        j = frm[act] + off
        oj, hj, lj = o[j], h[j], lo[j]
        s, t = sl[act], tp[act]
        if buy:
            o_sl, o_tp, h_tp, h_sl = oj <= s, oj >= t, hj >= t, lj <= s
        else:
            o_sl, o_tp, h_tp, h_sl = oj >= s, oj <= t, lj <= t, hj >= s
        dec = o_sl | o_tp | h_tp | h_sl
        if not dec.any():
            continue
        k_ = np.where(o_sl, KIND_SL, np.where(o_tp, KIND_TP, np.where(h_tp & h_sl, KIND_AMB,
                      np.where(h_sl, KIND_SL, KIND_TP)))).astype(np.int8)
        if plant == 'ambAsTp':
            k_ = np.where(k_ == KIND_AMB, KIND_TP, k_).astype(np.int8)
        x_ = np.where(o_sl | o_tp, oj, np.where(h_tp & h_sl, s, np.where(h_sl, s, t)))
        if plant == 'ambAsTp':
            x_ = np.where(~(o_sl | o_tp) & h_tp & h_sl, t, x_)
        idx = act[dec]
        kind[idx] = k_[dec]
        ex[idx] = x_[dec]
        nb[idx] = off + 1
        exi[idx] = j[dec]
        act = act[~dec]
    if act.size:
        last = frm[act] + D.TRACK - 1
        kind[act] = KIND_OPEN
        ex[act] = c[last]
        nb[act] = D.TRACK
        exi[act] = last
    return kind, ex, nb, exi


def levels(E, d, n_tp, pip):
    """7: the stop E - d x 13 x pip and the target E + d x n x pip, multiplied in this order, never rounded."""
    sl = E - (d * D.SL_PIPS) * pip
    tp = E + (d * n_tp) * pip
    return sl, tp


def y_of(kind):
    return None if kind == KIND_OPEN else (1 if kind == KIND_TP else 0)


# ---------------------------------------------------------------- the blind table (8)
LEGS = (('b4', S.BUY, D.TP_MAIL), ('s4', S.SELL, D.TP_MAIL), ('b10', S.BUY, D.TP_MAIN), ('s10', S.SELL, D.TP_MAIN))


class BlindPair:
    def __init__(self, pb, ks, half, period, plant=''):
        self.pi, self.pair = pb.pi, pb.pair
        self.k = ks.astype(np.int64)
        self.T = pb.t[ks] + D.STEP
        self.E = pb.mc[ks]
        self.hour = S.hour_arr(self.T)
        self.season = S.season_arr(self.T)
        self.week = S.wk_arr(self.T)
        self.block = (self.week - period['w0'][half]) // 4
        self.kind, self.pips, self.nbars, self.exi = {}, {}, {}, {}
        frm = ks + 1
        if plant == 'followFromSignalBar':
            frm = ks.copy()
        if plant == 'followLate1':
            frm = ks + 2
        pip = pb.pip
        if plant == 'usdPip001':
            pip = 0.01
        for name, d, ntp in LEGS:
            buy = d == S.BUY
            dd = d
            if plant == 'mirrorSameDir' and not buy:
                buy, dd = True, S.BUY
            sl, tp = levels(self.E, dd, ntp, pip)
            kind, ex, nb, exi = follow_many(pb, frm, buy, sl, tp, plant)
            fill = pb.ac[ks] if buy else pb.bc[ks]
            if plant == 'entryMid':
                fill = pb.mc[ks]
            pips = (ex - fill) / pip if buy else (fill - ex) / pip
            self.kind[name], self.pips[name], self.nbars[name], self.exi[name] = kind, pips, nb, exi
        yb = np.where(self.kind['b10'] == KIND_OPEN, -9, np.where(self.kind['b10'] == KIND_TP, 1, 0))
        ys = np.where(self.kind['s10'] == KIND_OPEN, -9, np.where(self.kind['s10'] == KIND_TP, 1, 0))
        self.eBuy = np.where((yb == -9) | (ys == -9), NO_E, yb - ys).astype(np.int8)
        self.row_of = {int(x): r for r, x in enumerate(self.k.tolist())}
        self.row_of_t = {int(pb.t[x]): r for r, x in enumerate(self.k.tolist())}

    def e(self, r, d):
        """The e of row r for a trade in direction d (a SELL row's e is the BUY row's with its sign changed)."""
        v = int(self.eBuy[r])
        if v == NO_E:
            return None
        return v if d == S.BUY else -v


class BlindTable:
    def __init__(self, bars, blind_idx, half, period, plant=''):
        self.half = half
        self.period = period
        self.pairs = [BlindPair(pb, blind_idx[(half, pb.pi)], half, period, plant) for pb in bars]
        ws = set()
        for bp in self.pairs:
            ws.update(bp.week.tolist())
        self.weeks = sorted(ws)
        self._strata = {}

    def strata(self, layer):
        """{stratum: (m, mean v, {week: (sum v, count)}, {block: (sum v, count)}, rows)} over rows with e."""
        if layer in self._strata:
            return self._strata[layer]
        acc = {}
        for bp in self.pairs:
            ok = bp.eBuy != NO_E
            rows = np.nonzero(ok)[0]
            for d in (S.BUY, S.SELL):
                di = 0 if d == S.BUY else 1
                v = bp.eBuy[rows].astype(np.float64) * (1 if d == S.BUY else -1) / 2
                if layer == 'chart':
                    s = ((bp.pi * 2 + di) * 24 + bp.hour[rows]) * 4 + bp.season[rows]
                else:
                    s = np.full(rows.size, bp.pi * 2 + di)
                for r, ss, vv in zip(rows.tolist(), s.tolist(), v.tolist()):
                    a = acc.get(ss)
                    if a is None:
                        a = acc[ss] = [0, 0.0, {}, {}]
                    a[0] += 1
                    a[1] += vv
                    w, b = int(bp.week[r]), int(bp.block[r])
                    x = a[2].get(w)
                    a[2][w] = (vv, 1) if x is None else (x[0] + vv, x[1] + 1)
                    x = a[3].get(b)
                    a[3][b] = (vv, 1) if x is None else (x[0] + vv, x[1] + 1)
        out = {s: (a[0], a[1] / a[0], a[2], a[3]) for s, a in acc.items()}
        self._strata[layer] = out
        return out

    def win_strata(self, layer):
        """{stratum: (TP4 resolved rate or None, TP4 mean pips)} over every row of the stratum (9: the blind W1/PL1)."""
        key = 'w' + layer
        if key in self._strata:
            return self._strata[key]
        acc = {}
        for bp in self.pairs:
            for d, leg in ((S.BUY, 'b4'), (S.SELL, 's4')):
                di = 0 if d == S.BUY else 1
                if layer == 'chart':
                    s = ((bp.pi * 2 + di) * 24 + bp.hour) * 4 + bp.season
                else:
                    s = np.full(bp.k.size, bp.pi * 2 + di)
                for ss, kd, pp in zip(s.tolist(), bp.kind[leg].tolist(), bp.pips[leg].tolist()):
                    a = acc.get(ss)
                    if a is None:
                        a = acc[ss] = [0, 0, 0, 0.0]
                    a[0] += 1
                    if kd != KIND_OPEN:
                        a[1] += 1
                        if kd == KIND_TP:
                            a[2] += 1
                    a[3] += pp
        out = {s: ((a[2] / a[1]) if a[1] else None, a[3] / a[0]) for s, a in acc.items()}
        self._strata[key] = out
        return out


def stratum_of(layer, pi, d, T):
    di = 0 if d == S.BUY else 1
    if layer == 'cal':
        return pi * 2 + di
    return ((pi * 2 + di) * 24 + D.utc_hour(T)) * 4 + D.season_of(T)


# ---------------------------------------------------------------- the signals' trades
class Trade:
    """A counted signal with its trade, its mirror and its next bar (Δ_late) from the blind table of its half."""
    __slots__ = ('sig', 'row', 'e', 'y4', 'y10', 'k4', 'k10', 'p4', 'p10', 'mp4', 'mp10', 'next_row', 'next_T',
                 'e_late', 'exit10', 'n10')

    def __init__(self, sig, bp, pb):
        self.sig = sig
        r = bp.row_of.get(sig.i)
        if r is None:
            raise ValueError(f'{sig.src} {sig.pair} {sig.i}: a counted signal without its blind row')
        self.row = r
        mine, other = (('b4', 'b10'), ('s4', 's10')) if sig.dir == S.BUY else (('s4', 's10'), ('b4', 'b10'))
        self.k4, self.k10 = int(bp.kind[mine[0]][r]), int(bp.kind[mine[1]][r])
        self.y4, self.y10 = y_of(self.k4), y_of(self.k10)
        self.p4, self.p10 = float(bp.pips[mine[0]][r]), float(bp.pips[mine[1]][r])
        self.mp4, self.mp10 = float(bp.pips[other[0]][r]), float(bp.pips[other[1]][r])
        self.e = bp.e(r, sig.dir)
        self.exit10 = int(bp.exi[mine[1]][r])
        self.n10 = int(bp.nbars[mine[1]][r])
        # 8 Δ_late: the next bar (starting exactly at T) in the same half's table
        nr = bp.row_of_t.get(sig.T)
        self.next_row = nr
        self.next_T = (sig.T + D.STEP) if nr is not None else None
        self.e_late = bp.e(nr, sig.dir) if nr is not None else None


def trades_of(sigs, table, bars, half):
    out = []
    for s in sigs:
        if s.reason == 'counted' and s.half == half:
            out.append(Trade(s, table.pairs[s.pi], bars[s.pi]))
    return out


# ---------------------------------------------------------------- Δ, its influence function and the SE (8)
def _se(sums, C):
    """sqrt(C / (C - 1) x sum of S_g^2), the squares added in ascending cluster order."""
    acc = 0.0
    for g in sorted(sums):
        acc += sums[g] * sums[g]
    return math.sqrt(C / (C - 1) * acc)


def _cand(kind, se, C):
    df = C - 1
    return {'kind': kind, 'se': se, 'C': C, 'df': df, 'half': tq(0.975, df) * se}


def pick(cands):
    """8: the widest half t(0.975, df) x SE; ties week, 4w, shift (the list is in that order)."""
    best = None
    for c in cands:
        if best is None or c['half'] > best['half']:
            best = c
    return best


def finish(est, N, strata, dropped, cands, extra=None, has_n=None):
    """The Est of the plan (est, N, strata, dropped, cands, use, t, lo, hi, lb): t only when C >= 2, N > 0, SE > 0
    (8); without t there is no interval either."""
    use = pick(cands)
    t = lo = hi = None
    n_ok = (N or 0) > 0 if has_n is None else has_n
    if use is not None and n_ok and use['C'] >= 2 and use['se'] > 0:
        t = est / use['se']
        lo, hi = est - use['half'], est + use['half']
    out = {'est': est, 'N': N, 'strata': strata, 'dropped': dropped,
           'cands': [dict(c) for c in cands], 'use': use['kind'] if use else None,
           't': t, 'lo': lo, 'hi': hi, 'lb': lo}
    if extra:
        out.update(extra)
    return out


def delta_core(obs, bstr):
    """obs: [(stratum, week, block, v)] of the signals with e, in order. bstr: the blind strata of the layer.
    Returns (Δ, N, used strata, dropped, week IF sums, block IF sums, per-stratum n) or Δ None."""
    by = {}
    for o in obs:
        by.setdefault(o[0], []).append(o)
    used = [s for s in sorted(by) if s in bstr]
    dropped = 0
    for s in by:
        if s not in bstr:
            dropped += len(by[s])
    N = 0
    for s in used:
        N += len(by[s])
    if N == 0:
        return None, 0, 0, dropped, {}, {}, {}
    est = 0.0
    smean = {}
    for s in used:
        acc = 0.0
        for o in by[s]:
            acc += o[3]
        smean[s] = acc / len(by[s])
        est += (len(by[s]) / N) * (smean[s] - bstr[s][1])
    wk, bk = {}, {}
    for o in obs:
        s = o[0]
        if s not in bstr:
            continue
        x = ((o[3] - bstr[s][1]) - est) / N
        wk[o[1]] = wk.get(o[1], 0.0) + x
        bk[o[2]] = bk.get(o[2], 0.0) + x
    for s in used:
        m, mean, wsum, bsum = bstr[s]
        w = -(len(by[s]) / N) / m
        for g, (sv, cnt) in wsum.items():
            wk[g] = wk.get(g, 0.0) + w * (sv - mean * cnt)
        for g, (sv, cnt) in bsum.items():
            bk[g] = bk.get(g, 0.0) + w * (sv - mean * cnt)
    return est, N, len(used), dropped, wk, bk, {s: len(by[s]) for s in used}


def delta_est(obs, bstr, shift_sd=None, C_week_for_shift=None):
    """8: Δ and its interval (candidates week, 4w when C_4w >= 10, shift when given)."""
    est, N, nst, dropped, wk, bk, ns = delta_core(obs, bstr)
    if est is None:
        r = finish(None, 0, 0, dropped, [])
        r['_if'] = ({}, {})
        r['_ns'] = {}
        return r
    cands = []
    Cw, C4 = len(wk), len(bk)
    if Cw >= 2:
        cands.append(_cand('week', _se(wk, Cw), Cw))
    if C4 >= FEW_BLOCKS:
        cands.append(_cand('4w', _se(bk, C4), C4))
    if shift_sd is not None and Cw >= 2:
        cands.append(_cand('shift', shift_sd, Cw))
    r = finish(est, N, nst, dropped, cands)
    r['_if'] = (wk, bk)
    r['_ns'] = ns
    return r


def a_est(obs):
    """8: the unaligned a = mean of e/2 over the signals with e; IF (v - mean) / N; week and 4w, the wider half."""
    N = len(obs)
    if N == 0:
        return finish(None, 0, A_STRATA, 0, [])
    acc = 0.0
    for o in obs:
        acc += o[3]
    mean = acc / N
    wk, bk = {}, {}
    for o in obs:
        x = (o[3] - mean) / N
        wk[o[1]] = wk.get(o[1], 0.0) + x
        bk[o[2]] = bk.get(o[2], 0.0) + x
    cands = []
    if len(wk) >= 2:
        cands.append(_cand('week', _se(wk, len(wk)), len(wk)))
    if len(bk) >= FEW_BLOCKS:
        cands.append(_cand('4w', _se(bk, len(bk)), len(bk)))
    r = finish(mean, N, A_STRATA, 0, cands)
    r['_if'] = (wk, bk)
    return r


def diff_est(x, y):
    """14: D = x - y with the two influence functions subtracted cluster by cluster (week and 4w, the wider half).
    N and strata: none of its own (D_STRATA; SQ-P19)."""
    if x['est'] is None or y['est'] is None:
        return finish(None, 0, D_STRATA, 0, [])
    wx, bx = x['_if']
    wy, by = y['_if']
    wk, bk = dict(wx), dict(bx)
    for g, v in wy.items():
        wk[g] = wk.get(g, 0.0) - v
    for g, v in by.items():
        bk[g] = bk.get(g, 0.0) - v
    cands = []
    if len(wk) >= 2:
        cands.append(_cand('week', _se(wk, len(wk)), len(wk)))
    if len(bk) >= FEW_BLOCKS:
        cands.append(_cand('4w', _se(bk, len(bk)), len(bk)))
    return finish(x['est'] - y['est'], None, D_STRATA, 0, cands, has_n=True)


# ---------------------------------------------------------------- observations of the signals
def obs_of(trades, layer, period, half, late=False, keep=None):
    """[(stratum, week, block, v)] of the signals with e (or with a next-bar e for Δ_late), in order; keep: an
    optional test on the trade (a direction or a pair)."""
    w0 = period['w0'][half]
    out = []
    for tr in trades:
        if keep is not None and not keep(tr):
            continue
        s = tr.sig
        if late:
            if tr.e_late is None:
                continue
            T = tr.next_T
            v = tr.e_late / 2
        else:
            if tr.e is None:
                continue
            T = s.T
            v = tr.e / 2
        w = D.wk(T)
        out.append((stratum_of(layer, s.pi, s.dir, T), w, (w - w0) // 4, v))
    return out


# ---------------------------------------------------------------- the week shift (8, 10)
def shift_deltas(trades, table, layer, late=False, plant=''):
    """8: every signal moved k weeks (k = 1 .. W_h - 1) along the half's blind weeks, as a ring, keeping its place in
    the week; a moved bar absent from the table drops the signal for that k; strata from the moved T; the trade from
    the table. Returns [(k, Δ_k or None, dropped, season-crossing)]."""
    W = table.weeks
    Wn = len(W)
    pos = {w: j for j, w in enumerate(W)}
    bstr = table.strata(layer)
    out = []
    for k in range(1, Wn):
        obs = []
        dropped = cross = 0
        for tr in trades:
            s = tr.sig
            w = D.wk(s.T)
            j = pos.get(w)
            if j is None:
                dropped += 1
                continue
            jj = (j + k) % Wn if plant != 'shiftNoRing' else j + k
            if jj >= Wn:
                dropped += 1
                continue
            T2 = s.T + (W[jj] - w) * D.WEEK
            bp = table.pairs[s.pi]
            r = bp.row_of_t.get(T2 - D.STEP)
            if r is None:
                dropped += 1
                continue
            if late:
                r2 = bp.row_of_t.get(T2)
                if r2 is None:
                    dropped += 1
                    continue
                Tn = T2 + D.STEP
                e = bp.e(r2, s.dir)
            else:
                Tn = T2
                e = bp.e(r, s.dir)
            if D.season_of(T2) != D.season_of(s.T):
                cross += 1
            if e is None:
                continue
            obs.append((stratum_of(layer, s.pi, s.dir, Tn), 0, 0, e / 2))
        est, N, _, _, _, _, _ = delta_core(obs, bstr)
        out.append((k, est, dropped, cross))
    return out


def sd2(xs):
    """The sample standard deviation, two passes (the mean first)."""
    n = len(xs)
    if n < 2:
        return None
    acc = 0.0
    for x in xs:
        acc += x
    mean = acc / n
    ss = 0.0
    for x in xs:
        ss += (x - mean) * (x - mean)
    return math.sqrt(ss / (n - 1))


def quantile(xs, q):
    """money-stats.ts quantile: the sorted value at floor(q x (n - 1))."""
    if not xs:
        return None
    s = sorted(xs)
    return s[min(len(s) - 1, int(math.floor(q * (len(s) - 1))))]


def shift_summary(shifts, real):
    ds = [d for _, d, _, _ in shifts if d is not None]
    if not ds:
        return {'n': 0, 'mean': None, 'q025': None, 'q975': None, 'rank': None, 'sd': None}
    acc = 0.0
    for x in ds:
        acc += x
    return {'n': len(ds), 'mean': acc / len(ds), 'q025': quantile(ds, 0.025), 'q975': quantile(ds, 0.975),
            'rank': (1 + sum(1 for x in ds if x < real)) if real is not None else None, 'sd': sd2(ds)}


# ---------------------------------------------------------------- W1/PL1/W2/PL2 (9)
def winpl(items):
    """items: [(T, kind, pips)] of the counted signals in order. tf-winrate's summarize: the resolved rate with
    clusterRate (week clusters, 1.96 x SE), the mean pips with meanCi."""
    n = len(items)
    tp = sum(1 for _, k, _ in items if k == KIND_TP)
    sl = sum(1 for _, k, _ in items if k == KIND_SL)
    amb = sum(1 for _, k, _ in items if k == KIND_AMB)
    op = sum(1 for _, k, _ in items if k == KIND_OPEN)
    res = tp + sl + amb
    out = {'n': n, 'resolved': res, 'tp': tp, 'sl': sl, 'amb': amb, 'open': op,
           'wAll': (tp / n) if n else None, 'wRes': (tp / res) if res else None,
           'pl': None, 'wLo': None, 'wHi': None, 'plLo': None, 'plHi': None}
    if res:
        by = {}
        for T, k, _ in items:
            if k == KIND_OPEN:
                continue
            w = D.wk(T)
            c = by.get(w)
            by[w] = [c[0] + 1, c[1] + (1 if k == KIND_TP else 0)] if c else [1, 1 if k == KIND_TP else 0]
        p = tp / res
        C = len(by)
        if C >= 2:
            s = 0.0
            for c in by.values():
                s += (c[1] - p * c[0]) ** 2
            se = math.sqrt((C / (C - 1)) * s) / res
            out['wLo'], out['wHi'] = p - Z_TF * se, p + Z_TF * se
    if n:
        acc = 0.0
        for _, _, x in items:
            acc += x
        mean = acc / n
        by = {}
        for T, _, x in items:
            w = D.wk(T)
            c = by.get(w)
            by[w] = [c[0] + x, c[1] + 1] if c else [x, 1]
        Wc = len(by)
        v = 0.0
        for c in by.values():
            v += (c[0] - mean * c[1]) ** 2
        se = math.sqrt((v * Wc) / (Wc - 1)) / n if Wc > 1 else 0.0
        out['pl'], out['plLo'], out['plHi'] = mean, mean - Z_TF * se, mean + Z_TF * se
    return out


def blind_weighted(delta, table, layer):
    """9: Σ_s (n_s / N) x the blind stratum's W1 (resolved) and PL1, over the strata of Δ (points only)."""
    ns = delta.get('_ns') or {}
    N = delta['N']
    if not ns or not N:
        return None, None
    ws = table.win_strata(layer)
    w1 = pl1 = 0.0
    for s in sorted(ns):
        rate, pl = ws.get(s, (None, None))
        if rate is None or pl is None:
            return None, None
        w1 += (ns[s] / N) * rate
        pl1 += (ns[s] / N) * pl
    return w1, pl1


# ---------------------------------------------------------------- the non-overlapping Δ (SQ-19)
def non_overlap(trades, table, layer, period, half, bars):
    """SQ-19: per pair and direction in T order, a signal kept when no kept earlier signal's TP10 trade is still
    open at its T (open while its exit bar's close is later than T); Δ of the kept ones (the point)."""
    kept = []
    last_close = {}
    for tr in sorted(trades, key=lambda x: (x.sig.pi, x.sig.dir, x.sig.T)):
        key = (tr.sig.pi, tr.sig.dir)
        lc = last_close.get(key)
        if lc is not None and lc > tr.sig.T:
            continue
        kept.append(tr)
        pb = bars[tr.sig.pi]
        last_close[key] = int(pb.t[tr.exit10]) + D.STEP
    kept.sort(key=lambda x: (x.sig.pi, x.sig.T, -x.sig.dir))
    est, *_ = delta_core(obs_of(kept, layer, period, half), table.strata(layer))
    return est


# ---------------------------------------------------------------- the suspicious lines (13)
def pct1(p):
    return _mod('text').pct(p)


def suspicious(row, blind=False):
    """13: the names of the lines hit; nothing under 100 resolved (TP10). Blind rows: Δ's lines not applied (SQ-16)."""
    w2, w1 = row['w10'], row['w4']
    if w2['resolved'] < D.SUSPECT['minResolved']:
        return []
    hit = []
    if not blind and row['delta']['est'] is not None and abs(row['delta']['est']) >= D.SUSPECT['delta']:
        hit.append('delta')
    if row['a']['est'] is not None and abs(row['a']['est']) >= D.SUSPECT['a']:
        hit.append('a')
    if w2['wRes'] is not None and w2['wRes'] >= D.SUSPECT['w2']:
        hit.append('w2')
    if w1['wRes'] is not None and w1['wRes'] >= D.SUSPECT['w1']:
        hit.append('w1')
    if w1['pl'] is not None and w1['pl'] >= D.SUSPECT['pl1']:
        hit.append('pl1')
    if w2['pl'] is not None and w2['pl'] >= D.SUSPECT['pl2']:
        hit.append('pl2')
    printed = [pct1(x) for x in (w1['wRes'], w1['wAll'], w2['wRes'], w2['wAll']) if x is not None]
    if any(p in ('0.0%', '100.0%') for p in printed):
        hit.append('zeroHundred')
    if not blind and row['delta']['est'] is not None and row['late']['est'] is not None and \
            abs(row['delta']['est'] - row['late']['est']) >= D.SUSPECT['lateGap']:
        hit.append('lateGap')
    return hit


# ---------------------------------------------------------------- one source's row in a half and a layer
def strip(est):
    return {k: v for k, v in est.items() if not k.startswith('_')}


def source_row(trades, table, layer, period, half, bars, with_shift=True, plant=''):
    """Everything 8-10 and 13 give one source in one half and layer."""
    obs = obs_of(trades, layer, period, half)
    shifts, sl = [], []
    sd = sd_late = None
    if layer == 'chart' and with_shift:
        shifts = shift_deltas(trades, table, layer, plant=plant)
        sd = sd2([d for _, d, _, _ in shifts if d is not None])
        sl = shift_deltas(trades, table, layer, late=True, plant=plant)
        sd_late = sd2([d for _, d, _, _ in sl if d is not None])
    bstr = table.strata(layer)
    delta = delta_est(obs, bstr, sd)
    if plant == 'seNoBlindTerm':
        delta = _delta_no_blind_term(obs, bstr)
    late = delta_est(obs_of(trades, layer, period, half, late=True), bstr, sd_late)
    a = a_est(obs)
    w4 = winpl([(tr.sig.T, tr.k4, tr.p4) for tr in trades])
    w10 = winpl([(tr.sig.T, tr.k10, tr.p10) for tr in trades])
    bw1, bpl1 = blind_weighted(delta, table, layer)
    by_dir = {}
    for d in (S.BUY, S.SELL):
        sub = obs_of(trades, layer, period, half, keep=lambda tr, d=d: tr.sig.dir == d)
        est, N, nst, dropped, *_ = delta_core(sub, bstr)
        by_dir[S.DIR_NAME[d]] = {'est': est, 'N': N, 'strata': nst, 'dropped': dropped}
    by_pair = {}
    for pair in D.PAIRS:
        if not any(tr.sig.pair == pair for tr in trades):
            continue
        sub = obs_of(trades, layer, period, half, keep=lambda tr, p=pair: tr.sig.pair == p)
        est, N, nst, dropped, *_ = delta_core(sub, bstr)
        by_pair[pair] = {'est': est, 'N': N, 'strata': nst, 'dropped': dropped}
    row = {'delta': delta, 'a': a, 'late': late, 'w4': w4, 'w10': w10, 'blindW1': bw1, 'blindPl1': bpl1,
           'byDir': by_dir, 'byPair': by_pair,
           'nonOverlap': non_overlap(trades, table, layer, period, half, bars),
           'perWeek': (len(trades) / len(table.weeks)) if table.weeks else None,
           'counted': len(trades), 'nE': sum(1 for tr in trades if tr.e is not None),
           # beyond the plan, kept out of stats.json (SQ-P19): the Python's own definitions, logged
           '_unresolved': sum(1 for tr in trades if tr.k10 == KIND_OPEN),
           '_lateExcluded': sum(1 for tr in trades if tr.e_late is None)}
    if layer == 'chart' and with_shift:
        row['shift'] = shift_summary(shifts, delta['est'])
        row['_shift_late'] = shift_summary(sl, late['est'])
        row['_shifts'] = shifts
        row['_shifts_late'] = sl
    row['suspicious'] = suspicious(row)
    return row


def _delta_no_blind_term(obs, bstr):
    """Planted error 'seNoBlindTerm' twin: the SE without the blind rows' terms."""
    est, N, nst, dropped, wk, bk, ns = delta_core(obs, bstr)
    if est is None:
        return delta_est(obs, bstr)
    wk2, bk2 = {}, {}
    for o in obs:
        s = o[0]
        if s not in bstr:
            continue
        x = ((o[3] - bstr[s][1]) - est) / N
        wk2[o[1]] = wk2.get(o[1], 0.0) + x
        bk2[o[2]] = bk2.get(o[2], 0.0) + x
    cands = []
    if len(wk2) >= 2:
        cands.append(_cand('week', _se(wk2, len(wk2)), len(wk2)))
    r = finish(est, N, nst, dropped, cands)
    r['_if'] = (wk2, bk2)
    r['_ns'] = ns
    return r


# SQ-16 (SPEC.blindSuspectRows = "byDirection"): the blind's "半分全体の行" of 13 are BUY and SELL over all pairs,
# and only they stop anything (select.yardstick_hit). The 10 pair x direction rows' lists are written for
# information only (True; both programs do so since the joint run of 2026-10-12); False would leave them empty.
BLIND_PAIR_DIR_SUSPECT = True


def blind_rows(table, period, half):
    """10: the blind's unaligned a and W1/PL1/W2/PL2 per direction (all pairs) and per pair x direction; 13's
    lines on the two per-direction rows only (SQ-16)."""
    out = {}
    w0 = period['w0'][half]

    def build(pairs, d, whole):
        obs, i4, i10 = [], [], []
        for bp in pairs:
            leg4, leg10 = ('b4', 'b10') if d == S.BUY else ('s4', 's10')
            for r in range(bp.k.size):
                T = int(bp.T[r])
                e = bp.e(r, d)
                if e is not None:
                    w = int(bp.week[r])
                    obs.append((0, w, (w - w0) // 4, e / 2))
                i4.append((T, int(bp.kind[leg4][r]), float(bp.pips[leg4][r])))
                i10.append((T, int(bp.kind[leg10][r]), float(bp.pips[leg10][r])))
        row = {'a': a_est(obs), 'w4': winpl(i4), 'w10': winpl(i10)}
        row['suspicious'] = suspicious(row, blind=True) if whole else []
        return row
    for d in (S.BUY, S.SELL):
        out[S.DIR_NAME[d]] = build(table.pairs, d, True)
    pd = {}
    for bp in table.pairs:
        for d in (S.BUY, S.SELL):
            pd[f'{bp.pair} {S.DIR_NAME[d]}'] = build([bp], d, BLIND_PAIR_DIR_SUSPECT)
    out['pairDir'] = pd
    return out
