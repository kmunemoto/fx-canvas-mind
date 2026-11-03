#!/usr/bin/env python3
"""The similar-past forecast (似た相場の予測, #392, docs §8.135): an independent implementation
written only from research/analog-spec.md (sections "Input", "Constants", "The rule", "Output").

Two ways to compute the same thing:
- forecast(c, a=None): the rule, literally, in plain Python (one anchor; reads only c[s..a]).
- forecast_range(c, a_from, a_to): every anchor in [a_from, a_to] at once (numpy). The distance is
  summed in the spec's order over k with elementwise IEEE operations (no np.sum), the places are
  walked in the spec's order (d ascending, ties j descending). Anchors whose pool is not full
  (a < W - 1) are computed with forecast().
research/analog-check.py checks the two against each other on a sample of anchors.
"""
import math

import numpy as np
from numpy.lib.stride_tricks import sliding_window_view

PATTERN = 20   # L: the bars of the shape compared (21 closes)
HORIZON = 20   # H: the forecast reaches H bars past the anchor
MATCHES = 10   # K: the past places used
WINDOW = 1500  # W: the bars searched, the anchor's included
GAP = 20       # G: two places chosen are at least this many bars apart


def _centre(v, K):
    """the median of K sorted values"""
    if K % 2:
        return v[(K - 1) // 2]
    return (v[K // 2 - 1] + v[K // 2]) / 2


def forecast(c, a=None):
    """The rule, step by step. c: closes (oldest first); a: the anchor (default len(c) - 1).
    Returns {a, start, places: [{j, d}], mid, up, lo, dir} or None."""
    L, H, K, W, G = PATTERN, HORIZON, MATCHES, WINDOW, GAP
    if a is None:
        a = len(c) - 1
    if not 0 <= a < len(c):
        raise IndexError(f'anchor {a} outside 0..{len(c) - 1}')
    # 1. the pool
    s = max(0, a - W + 1)
    x = [float(c[i]) for i in range(s, a + 1)]   # c[s..a]: nothing else is read

    def C(i):
        if not s <= i <= a:
            raise IndexError(f'read c[{i}] outside the pool {s}..{a}')
        return x[i - s]

    for v in x:
        if not (math.isfinite(v) and v > 0):
            return None
    if a - L < s:
        return None
    # 2. the shape now
    ca = C(a)
    p = [C(a - L + k) / ca - 1 for k in range(L)]
    # 3. the candidates
    cands = []
    for j in range(s + L, a - H + 1):
        cj = C(j)
        d = 0.0
        for k in range(L):
            q = C(j - L + k) / cj - 1
            e = q - p[k]
            d = d + e * e
        cands.append((d, -j))
    # 4. the places: d ascending, ties j descending (the newer first)
    cands.sort()
    taken = []
    for d, mj in cands:
        j = -mj
        if any(abs(j - t) < G for t, _ in taken):
            continue
        taken.append((j, d))
        if len(taken) == K:
            break
    if len(taken) < K:
        return None
    # 5.-6. each place's path, the lines
    mid, up, lo = [ca], [ca], [ca]
    for h in range(1, H + 1):
        v = sorted(ca * (C(j + h) / C(j)) for j, _ in taken)
        mid.append(_centre(v, K))
        up.append(v[K - 1])
        lo.append(v[0])
    # 7. the direction
    dr = 1 if mid[H] > ca else (-1 if mid[H] < ca else 0)
    return {'a': a, 'start': s, 'places': [{'j': j, 'd': d} for j, d in taken],
            'mid': mid, 'up': up, 'lo': lo, 'dir': dr}


def forecast_range(c, a_from, a_to, block=256):
    """Every anchor a_from..a_to (inclusive). Returns a dict of arrays, row i for anchor a_from + i:
    ok (bool), start, j (K places in the order taken), d, mid/up/lo (H + 1), dir. Rows with ok False
    have no forecast (the other fields are meaningless there)."""
    L, H, K, W, G = PATTERN, HORIZON, MATCHES, WINDOW, GAP
    c = np.ascontiguousarray(c, dtype=np.float64)
    n = len(c)
    if not (0 <= a_from and a_to < n):
        raise IndexError('anchors outside the closes')
    N = max(0, a_to - a_from + 1)
    out = {
        'ok': np.zeros(N, dtype=bool),
        'start': np.zeros(N, dtype=np.int64),
        'j': np.zeros((N, K), dtype=np.int64),
        'd': np.zeros((N, K), dtype=np.float64),
        'mid': np.zeros((N, H + 1), dtype=np.float64),
        'up': np.zeros((N, H + 1), dtype=np.float64),
        'lo': np.zeros((N, H + 1), dtype=np.float64),
        'dir': np.zeros(N, dtype=np.int64),
    }
    if N == 0:
        return out

    def put(i, f):
        if f is None:
            return
        out['ok'][i] = True
        out['start'][i] = f['start']
        out['j'][i] = [x['j'] for x in f['places']]
        out['d'][i] = [x['d'] for x in f['places']]
        out['mid'][i] = f['mid']
        out['up'][i] = f['up']
        out['lo'][i] = f['lo']
        out['dir'][i] = f['dir']

    # anchors whose pool is not full: the literal rule
    full_from = max(a_from, W - 1)
    for a in range(a_from, min(a_to, full_from - 1) + 1):
        put(a - a_from, forecast(c, a))
    if full_from > a_to:
        return out

    M = W - L - H                                   # candidates of a full pool
    if M < 1:
        return out                                  # no candidate: fewer than K places
    good = np.isfinite(c) & (c > 0)
    bad_upto = np.concatenate(([0], np.cumsum(~good)))   # bad_upto[i]: bad closes in c[0..i-1]
    # Q[k, j] = c[j-L+k] / c[j] - 1 (the division, then the subtraction): the same doubles for the
    # candidates' q[k] and for the shape now p[k] = Q[k, a]
    Q = np.full((L, n), np.nan)
    with np.errstate(all='ignore'):
        for k in range(L):
            Q[k, L:] = c[k:n - L + k] / c[L:] - 1
    rr = np.arange(M)
    hh = np.arange(1, H + 1)
    blocked_ones = b'\x01' * (2 * G - 1)
    for b0 in range(full_from, a_to + 1, block):
        b1 = min(a_to + 1, b0 + block)
        B = b1 - b0
        A = np.arange(b0, b1)
        S = A - W + 1
        valid = (bad_upto[A + 1] - bad_upto[S]) == 0
        # 3. distances: D[b, i] for j = A[b] - W + 1 + L + i (ascending), summed k = 0..L-1 in order
        base = b0 - W + 1 + L
        D = np.zeros((B, M))
        with np.errstate(all='ignore'):
            for k in range(L):
                V = sliding_window_view(Q[k, base:base + B - 1 + M], M)
                E = V - Q[k, A][:, None]
                D = D + E * E
        # 4. order: d ascending, ties j descending -> reverse to j descending, then a stable sort
        Drev = D[:, ::-1]                           # column r: j = A[b] - H - r
        order = np.argsort(Drev, axis=1, kind='stable')
        J = np.zeros((B, K), dtype=np.int64)
        Dd = np.zeros((B, K))
        got = np.zeros(B, dtype=bool)
        for b in range(B):
            if not valid[b]:
                continue
            row = order[b]
            blocked = bytearray(M + 2 * G)          # index r + G
            taken = []
            pos = 0
            step = 128
            while len(taken) < K and pos < M:
                for r in row[pos:pos + step].tolist():
                    if blocked[r + G]:
                        continue
                    taken.append(r)
                    blocked[r + 1:r + 2 * G] = blocked_ones   # every r' with |r' - r| < G
                    if len(taken) == K:
                        break
                pos += step
                step *= 4
            if len(taken) < K:
                continue
            got[b] = True
            J[b] = [int(A[b]) - H - r for r in taken]
            Dd[b] = Drev[b, taken]
        # 5.-7. the paths, the lines, the direction (for every row; only rows with got are kept)
        ca = c[A]
        Cj = c[J]                                    # (B, K)
        Cjh = c[J[:, :, None] + hh[None, None, :]]   # (B, K, H)
        with np.errstate(all='ignore'):
            F = ca[:, None, None] * (Cjh / Cj[:, :, None])
        Vs = np.sort(F, axis=1)
        if K % 2:
            midh = Vs[:, (K - 1) // 2, :]
        else:
            midh = (Vs[:, K // 2 - 1, :] + Vs[:, K // 2, :]) / 2
        uph = Vs[:, K - 1, :]
        loh = Vs[:, 0, :]
        i0 = b0 - a_from
        sel = np.flatnonzero(got)
        rows = sel + i0
        out['ok'][rows] = True
        out['start'][rows] = S[sel]
        out['j'][rows] = J[sel]
        out['d'][rows] = Dd[sel]
        out['mid'][rows, 0] = ca[sel]
        out['up'][rows, 0] = ca[sel]
        out['lo'][rows, 0] = ca[sel]
        out['mid'][rows, 1:] = midh[sel]
        out['up'][rows, 1:] = uph[sel]
        out['lo'][rows, 1:] = loh[sel]
        mH = midh[sel, H - 1]
        out['dir'][rows] = np.where(mH > ca[sel], 1, np.where(mH < ca[sel], -1, 0))
    return out
