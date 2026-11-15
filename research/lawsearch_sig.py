"""法則探し (research/lawsearch-spec.md): the Python half of the signals for the small trial (spec 19 step 3).

PY2 of research/lawsearch-py-design.md: the indicators (spec 3.1, 3.2), the trial's items E04, E26 and B06
(spec 4.1, 4.4, §8.113 C1 and C17 with spec 17.3's substitutions), the filters F00 and F01 (spec 4.2), the state row
S01 (spec 4.3), the events of spec 5, and the higher-timeframe rule of spec 2.

Step 4's pilot (spec 19 step 4; the lead, 2026-11-15) adds exactly: E13 macd_sig (12, 26, 9), E29 inside_brk, E30
pday_brk (spec 4.1 and its notes), F02 / F02r (the higher bar's EMA50 slope, spec 4.2 and spec 2's higher-timeframe
rule) with S02 (spec 4.3) and the reversed state row of spec 8.6 that F02r's D_F needs, and B07 rsi2 (spec 4.4,
§8.113 C19 with spec 17.3). Their ind/ columns are lawsearch-dump.md 5's table after B06_keep.

Written from the spec, the hand examples, research/lawsearch-dump.md and research/lawsearch-py-design.md only. No
TypeScript was read. This module imports nothing of research/lawsearch-check.py (PY1).

Conventions (py-design 3.2):
- 無し is nan in a float64 array.
- A tri-state truth is an int8 array: 1 true, 0 false, -1 無し.
- Directions: 1 buy, -1 sell. Row 0 of a (2, n) array is buy, row 1 sell.

Floating point (spec 3.1, 17.2, 21.5): every sum runs oldest first, one value at a time, in a Python loop; a square is
x*x; expressions are evaluated in the order the spec writes them. sum, math.fsum, np.sum, np.mean, np.std,
np.convolve, np.cumsum and pandas are not used anywhere in this file.

The registry (ITEMS, FILTERS, S_TABLE) is keyed by the ids of research/ledger/lawsearch-candidates.json. Every id of
the ledger has an entry; the ones not written yet raise NotBuilt, so a trial that uses them fails loudly.

Run alone: python3 -I research/lawsearch_sig.py --hand [--plant NAME]   (groups 3 and 4 of the hand examples)
"""

import datetime
import hashlib
import json
import math
import pathlib
import re
import sys

import numpy as np

NAN = float("nan")
_HERE = pathlib.Path(__file__).resolve().parent

PAIRS = ["USD/JPY", "EUR/JPY", "AUD/JPY", "EUR/USD", "AUD/USD"]
STEP = {"m15": 900000, "h1": 3600000, "h4": 14400000}
_TF_ALIASES = {"m15": "m15", "15min": "m15", "h1": "h1", "1hour": "h1", "h4": "h4", "4hour": "h4"}
DAY_MS = 86400000
HOUR_MS = 3600000
MIN_MS = 60000

PY2_PLANTS = ("smaNewestFirst", "htfOpen", "noRisingEdge")


class NotBuilt(Exception):
    """Raised for any item, filter, state row or trial that is not written yet."""


# =====================================================================================================================
# 4.1 indicators (spec 3.1, 3.2). Every function returns a new float64 array of len(x); nan = 無し.
# =====================================================================================================================

def _fl(x):
    """A Python list of floats (fast element access for the oldest-first loops)."""
    return np.asarray(x, dtype=np.float64).tolist()


def _isnan(v):
    return v != v


def sma(x, p, plant=""):
    """Spec 3.2 SMA_p: (x[i-p+1] + ... + x[i]) / p, summed oldest first; nan unless x[i-p+1..i] are all finite.

    Plant "smaNewestFirst" (spec 16): sums newest first instead.
    """
    xs = _fl(x)
    n = len(xs)
    out = [NAN] * n
    newest_first = plant == "smaNewestFirst"
    run = 0
    for i in range(n):
        if not math.isfinite(xs[i]):
            run = 0
            continue
        run += 1
        if run >= p:
            acc = 0.0
            if newest_first:
                for j in range(i, i - p, -1):
                    acc += xs[j]
            else:
                for j in range(i - p + 1, i + 1):
                    acc += xs[j]
            out[i] = acc / p
    return np.array(out, dtype=np.float64)


def _seed_sum(xs, i, p):
    """The oldest-first sum of xs[i-p+1..i] (the seed of EMA and RMA)."""
    acc = 0.0
    for j in range(i - p + 1, i + 1):
        acc += xs[j]
    return acc


def _recursive_ma(x, p, alpha):
    """Spec 3.2 EMA_p / RMA_p (pine.ts pineEma / pineRma).

    Seed at the first i >= p-1 where x[i-p+1..i] are all finite: prev = (oldest-first sum) / p, out[i] = prev.
    Then prev = alpha*x[i] + (1-alpha)*prev, with 1-alpha the double alpha subtracted from 1. A non-finite input makes
    prev and out nan; the next full window seeds again.
    """
    xs = _fl(x)
    n = len(xs)
    one_minus = 1.0 - alpha
    out = [NAN] * n
    have = False
    prev = NAN
    run = 0
    for i in range(n):
        v = xs[i]
        if not math.isfinite(v):
            have = False
            prev = NAN
            run = 0
            continue
        run += 1
        if have:
            prev = alpha * v + one_minus * prev
            out[i] = prev
        elif run >= p:
            prev = _seed_sum(xs, i, p) / p
            have = True
            out[i] = prev
    return np.array(out, dtype=np.float64)


def ema(x, p):
    """Spec 3.2 EMA_p, alpha = 2/(p+1) as one division."""
    return _recursive_ma(x, p, 2 / (p + 1))


def rma(x, p):
    """Spec 3.2 RMA_p, alpha = 1/p as one division."""
    return _recursive_ma(x, p, 1 / p)


def macd(C, f, s, m):
    """Spec 3.2 MACD(f, s, m) (_shared/macd.ts macd) -> {"fast", "slow", "line", "signal"}.

    line = EMA_f(C) - EMA_s(C) per bar (nan when either is nan); signal = EMA_m(line), whose seed is the first bar
    where the line has m values in a row (i = s + m - 2 on bars without a gap in values): (line[i-m+1] + ... +
    line[i]) / m summed oldest first, then alpha*line + (1-alpha)*prev (EMA_p of spec 3.2).
    """
    ef = ema(C, f)
    es = ema(C, s)
    a = ef.tolist()
    b = es.tolist()
    line = [NAN] * len(a)
    for i in range(len(a)):
        if not (_isnan(a[i]) or _isnan(b[i])):
            line[i] = a[i] - b[i]
    line = np.array(line, dtype=np.float64)
    return {"fast": ef, "slow": es, "line": line, "signal": ema(line, m)}


def tr(H, L, C):
    """Spec 3.2 TR: TR[0] = H[0] - L[0]; then max(H-L, |H-C[i-1]|, |L-C[i-1]|) (C[i-1] by index, across gaps)."""
    hs, ls, cs = _fl(H), _fl(L), _fl(C)
    n = len(hs)
    out = [NAN] * n
    if n:
        out[0] = hs[0] - ls[0]
    for i in range(1, n):
        a = hs[i] - ls[i]
        b = abs(hs[i] - cs[i - 1])
        c = abs(ls[i] - cs[i - 1])
        m = a
        if b > m:
            m = b
        if c > m:
            m = c
        if _isnan(a) or _isnan(b) or _isnan(c):
            m = NAN
        out[i] = m
    return np.array(out, dtype=np.float64)


def atr(H, L, C, p):
    """Spec 3.2 ATR_p (pine.ts pineAtr): nan for i < p-1; ATR[p-1] = (TR[0]+...+TR[p-1]) / p;
    then ATR[i] = (TR[i] + (p-1)*ATR[i-1]) / p (not RMA's form)."""
    trs = tr(H, L, C).tolist()
    n = len(trs)
    out = [NAN] * n
    if n >= p:
        prev = _seed_sum(trs, p - 1, p) / p
        out[p - 1] = prev
        for i in range(p, n):
            prev = (trs[i] + (p - 1) * prev) / p
            out[i] = prev
    return np.array(out, dtype=np.float64)


def rsi(C, p):
    """Spec 3.2 RSI_p (ultra.ts pineRsi) -> {"up", "dn", "U", "D", "rsi"}.

    up[0], dn[0] are nan; up = max(C[i]-C[i-1], 0), dn = max(C[i-1]-C[i], 0); U = RMA_p(up), D = RMA_p(dn) (first
    value at i = p). RSI: nan when either is nan; 100 when D == 0; else 0 when U == 0; else 100 - 100 / (1 + U/D).
    """
    cs = _fl(C)
    n = len(cs)
    up = [NAN] * n
    dn = [NAN] * n
    for i in range(1, n):
        d = cs[i] - cs[i - 1]
        e = cs[i - 1] - cs[i]
        up[i] = d if d > 0 else 0.0
        dn[i] = e if e > 0 else 0.0
        if _isnan(d):
            up[i] = NAN
            dn[i] = NAN
    U = rma(up, p)
    D = rma(dn, p)
    ul, dl = U.tolist(), D.tolist()
    out = [NAN] * n
    for i in range(n):
        u, dd = ul[i], dl[i]
        if _isnan(u) or _isnan(dd):
            continue
        if dd == 0:
            out[i] = 100.0
        elif u == 0:
            out[i] = 0.0
        else:
            out[i] = 100 - 100 / (1 + u / dd)
    return {"up": np.array(up, dtype=np.float64), "dn": np.array(dn, dtype=np.float64), "U": U, "D": D,
            "rsi": np.array(out, dtype=np.float64)}


def donchian(H, L, C, n):
    """§8.113 C1 (spec 4.1 E26/E27) -> {"HH", "LL", "s"}.

    HH_n(i) = max H[i-n..i-1], LL_n(i) = min L[i-n..i-1] (bar i not included), nan for i < n.
    s (int8) starts at 0 from bar 0 and is never 無し. For i >= n: C[i] > HH and s != 1 sets s = 1; C[i] < LL and
    s != -1 sets s = -1; otherwise s is unchanged. Equal values do not break out.
    """
    hs, ls, cs = _fl(H), _fl(L), _fl(C)
    N = len(cs)
    HH = [NAN] * N
    LL = [NAN] * N
    s = [0] * N
    cur = 0
    for i in range(N):
        if i >= n:
            hh = hs[i - n]
            ll = ls[i - n]
            for j in range(i - n + 1, i):
                if hs[j] > hh:
                    hh = hs[j]
                if ls[j] < ll:
                    ll = ls[j]
            HH[i] = hh
            LL[i] = ll
            c = cs[i]
            if c > hh and cur != 1:
                cur = 1
            elif c < ll and cur != -1:
                cur = -1
        s[i] = cur
    return {"HH": np.array(HH, dtype=np.float64), "LL": np.array(LL, dtype=np.float64),
            "s": np.array(s, dtype=np.int8)}


def _bigmove_full(C, s, step, sigma_window=288, sigma_min_usable=250, move_bars=6, gap_ms=None):
    """bigmove with the count of usable r in each sigma window (count is -1 for i < sigma_window)."""
    cs = _fl(C)
    ss = np.asarray(s, dtype=np.int64).tolist()
    n = len(cs)
    gap = 12 * int(step) if gap_ms is None else int(gap_ms)
    r = [NAN] * n
    ok = [False] * n
    for t in range(1, n):
        if ss[t] - ss[t - 1] <= gap:
            ok[t] = True
            r[t] = math.log(cs[t] / cs[t - 1])
    W = int(sigma_window)
    sigma = [NAN] * n
    count = [-1] * n
    for i in range(W, n):
        cnt = 0
        acc = 0.0
        for j in range(i - W, i):
            if ok[j]:
                acc += r[j]
                cnt += 1
        count[i] = cnt
        if cnt < sigma_min_usable or cnt < 2:
            continue
        mean = acc / cnt
        acc2 = 0.0
        for j in range(i - W, i):
            if ok[j]:
                dv = r[j] - mean
                acc2 += dv * dv
        var = acc2 / (cnt - 1)
        sg = math.sqrt(var)
        if sg > 0:
            sigma[i] = sg
    m = int(move_bars)
    sqm = math.sqrt(m)
    z = [NAN] * n
    for i in range(m, n):
        sg = sigma[i]
        if _isnan(sg):
            continue
        good = True
        for j in range(i - m + 1, i + 1):
            if not ok[j]:
                good = False
                break
        if good:
            z[i] = math.log(cs[i] / cs[i - m]) / (sg * sqm)
    return {"r": np.array(r, dtype=np.float64), "usable": np.array(ok, dtype=bool),
            "sigma": np.array(sigma, dtype=np.float64), "z": np.array(z, dtype=np.float64),
            "count": np.array(count, dtype=np.int64)}


def bigmove(C, s, step, sigma_window=288, sigma_min_usable=250, move_bars=6, threshold=2.0, gap_ms=None):
    """§8.113 C17 with spec 17.3's substitutions -> {"r", "usable" (bool), "sigma", "z"}.

    r[t] = ln(C[t] / C[t-1]), usable when t >= 1 and s[t] - s[t-1] <= gap_ms (gap_ms = 12 * step by default: a gap of
    exactly 12 * step is usable); r is nan where it is not usable (as the hand examples write it).
    sigma[i] for i >= sigma_window: the sample standard deviation (two passes, n-1) of the usable r of
    r[i-W..i-1], when at least sigma_min_usable are usable; used only when > 0.
    z[i] = ln(C[i] / C[i-move_bars]) / (sigma[i] * sqrt(move_bars)), only when r[i-move_bars+1..i] are all usable and
    sigma[i] exists. threshold is not used here (item B06 applies it).
    """
    f = _bigmove_full(C, s, step, sigma_window, sigma_min_usable, move_bars, gap_ms)
    return {"r": f["r"], "usable": f["usable"], "sigma": f["sigma"], "z": f["z"]}


def _as_b(a, b):
    n = len(a)
    if np.ndim(b) == 0:
        return [float(b)] * n
    return _fl(b)


def x_up(a, b):
    """Spec 3.1 X-up(a, b) as an int8 tri: a[i-1] <= b[i-1] and a[i] > b[i]; -1 when any of the four values is nan,
    and at i = 0. b is an array or a float. Compared as doubles; equal values have not crossed."""
    al = _fl(a)
    bl = _as_b(al, b)
    n = len(al)
    out = [-1] * n
    for i in range(1, n):
        a0, b0, a1, b1 = al[i - 1], bl[i - 1], al[i], bl[i]
        if _isnan(a0) or _isnan(b0) or _isnan(a1) or _isnan(b1):
            continue
        out[i] = 1 if (a0 <= b0 and a1 > b1) else 0
    return np.array(out, dtype=np.int8)


def x_dn(a, b):
    """Spec 3.1 X-down(a, b): a[i-1] >= b[i-1] and a[i] < b[i]; int8 tri as x_up."""
    al = _fl(a)
    bl = _as_b(al, b)
    n = len(al)
    out = [-1] * n
    for i in range(1, n):
        a0, b0, a1, b1 = al[i - 1], bl[i - 1], al[i], bl[i]
        if _isnan(a0) or _isnan(b0) or _isnan(a1) or _isnan(b1):
            continue
        out[i] = 1 if (a0 >= b0 and a1 < b1) else 0
    return np.array(out, dtype=np.int8)


# =====================================================================================================================
# 4.2 the higher timeframe (spec 2 上位足)
# =====================================================================================================================

def htf_index(T, htf_s, htf_step, plant=""):
    """g(i) = the last k with htf_s[k] + htf_step <= T[i], else -1 (int64). htf_s ascending.

    The higher bar k may be used at bar i only when its grid end is at or before T_i: the clock decides, even when
    base bars are missing.
    Plant "htfOpen" (spec 16): the last k with htf_s[k] <= s_i, a bar still forming. With base bars and higher bars
    on the UTC grid (htf_s and s_i multiples of the base step), htf_s[k] <= s_i is the same as htf_s[k] < T_i, which
    is what is computed (T alone does not carry the base step).
    """
    Tv = np.asarray(T, dtype=np.int64)
    hs = np.asarray(htf_s, dtype=np.int64)
    if hs.size == 0:
        return np.full(Tv.shape, -1, dtype=np.int64)
    if plant == "htfOpen":
        g = np.searchsorted(hs, Tv, side="left") - 1
    else:
        g = np.searchsorted(hs + np.int64(htf_step), Tv, side="right") - 1
    return g.astype(np.int64)


# =====================================================================================================================
# 4.3 items, filters and state rows (spec 4.1-4.4, 17.3), and the registry keyed by the candidates ledger's ids
# =====================================================================================================================

class Built:
    """An item built on one bars dict.

    kind: "cross" | "condition" | "hold" | "state"; cond: int8 (2, n) tri (row 0 buy, row 1 sell);
    keep: bool (2, n) or None (spec 5 ③); warmup: int (bars); columns: dict name -> array (the ind/ columns of
    lawsearch-dump.md 5, in their order, then private extras).
    prev: int8 (2, n) tri or None. When given, spec 5 ②'s rising edge at bar i compares with prev[d][i] instead of
    cond[d][i-1] (E30: the first bar of a day reads "not true", spec 4.1's notes).
    once_per_day: int64 (n,) day keys or None. When given, spec 5 ③ keeps only the first raw signal of each day and
    direction (E30: 向きごとに1日1回).
    """

    def __init__(self, kind, cond, keep, warmup, columns, dump_columns=(), prev=None, once_per_day=None):
        self.kind = kind
        self.cond = cond
        self.keep = keep
        self.warmup = int(warmup)
        self.columns = columns
        self.dump_columns = tuple(dump_columns)
        self.prev = prev
        self.once_per_day = once_per_day


class FBuilt:
    """A filter built on one bars dict.

    f: int8 (2, n) tri; warmup: int (bars); warm_ok: bool (n,) or None (a warm-up that is not a bar index, as the
    higher bar's 51 of F02); columns: dict name -> array.
    """

    def __init__(self, f, warmup, warm_ok, columns, dump_columns=()):
        self.f = f
        self.warmup = int(warmup)
        self.warm_ok = warm_ok
        self.columns = columns
        self.dump_columns = tuple(dump_columns)


def _p(params, key, default):
    if params and key in params and params[key] is not None:
        return params[key]
    return default


def _tri(mask_true, mask_nan):
    out = np.where(mask_true, 1, 0).astype(np.int8)
    out[mask_nan] = -1
    return out


def _item_e04(bars, params, answer_knowing=False, plant=""):
    """E04 rsi_back (14, 30): buy X-up(RSI_p, 30), sell X-down(RSI_p, 100 - 30). Cross kind. Warm-up p + 1."""
    p = int(_p(params, "rsi", 14))
    L = 30
    R = rsi(bars["C"], p)
    buy = x_up(R["rsi"], L)
    sell = x_dn(R["rsi"], 100 - L)
    cond = np.vstack([buy, sell]).astype(np.int8)
    name = "RSI%d" % p
    cols = {name: R["rsi"], name + "_U": R["U"], name + "_D": R["D"], "E04_buy": buy, "E04_sell": sell}
    return Built("cross", cond, None, _item_warmup("E04", params), cols,
                 (name, name + "_U", name + "_D", "E04_buy", "E04_sell"))


def _target_answer_knowing(C):
    """Set O (spec 14.2, py-design 4.3): the target is +1 when C[i+1] > C[i], -1 when C[i+1] < C[i], otherwise the
    previous target (0 at the start; the last bar has no next bar and keeps the previous). Reads the next bar on
    purpose: spec 15's checks must catch it."""
    cs = _fl(C)
    n = len(cs)
    s = [0] * n
    cur = 0
    for i in range(n):
        if i + 1 < n:
            if cs[i + 1] > cs[i]:
                cur = 1
            elif cs[i + 1] < cs[i]:
                cur = -1
        s[i] = cur
    return np.array(s, dtype=np.int8)


def _item_e26(bars, params, answer_knowing=False, plant=""):
    """E26 donchian-A20 (§8.113 C1): hold kind; buy s == 1, sell s == -1. Warm-up n."""
    n = int(_p(params, "donchian", 20))
    D = donchian(bars["H"], bars["L"], bars["C"], n)
    s = _target_answer_knowing(bars["C"]) if answer_knowing else D["s"]
    buy = (s == 1).astype(np.int8)
    sell = (s == -1).astype(np.int8)
    cond = np.vstack([buy, sell]).astype(np.int8)
    pre = "DON%d" % n
    cols = {pre + "_HH": D["HH"], pre + "_LL": D["LL"], pre + "_s": s.astype(np.int8)}
    return Built("hold", cond, None, _item_warmup("E26", params), cols, (pre + "_HH", pre + "_LL", pre + "_s"))


# B06's time exclusion (spec 17.3): T's UTC time of day in [19:35, 24:00).
_B06_EXCL_FROM = 19 * HOUR_MS + 35 * MIN_MS


def _item_b06(bars, params, answer_knowing=False, plant=""):
    """B06 bigmove (§8.113 C17): condition kind; buy z <= -threshold, sell z >= threshold (-1 where z is nan).
    keep is 0 where T's UTC time of day is in [19:35, 24:00) (spec 5 ③). Warm-up sigma_window (288)."""
    W = int(_p(params, "sigma_window", 288))
    nmin = int(_p(params, "sigma_min_usable", 250))
    m = int(_p(params, "move_bars", 6))
    thr = float(_p(params, "threshold", 2.0))
    gap = _p(params, "gap_ms", None)
    B = _bigmove_full(bars["C"], bars["s"], bars["step"], W, nmin, m, gap)
    z = B["z"]
    zn = np.isnan(z)
    with np.errstate(invalid="ignore"):
        buy = _tri(z <= -thr, zn)
        sell = _tri(z >= thr, zn)
    tod = np.asarray(bars["T"], dtype=np.int64) % DAY_MS
    keep1 = tod < _B06_EXCL_FROM
    cond = np.vstack([buy, sell]).astype(np.int8)
    keep = np.vstack([keep1, keep1])
    cols = {"BM_r": B["r"], "BM_ok": B["usable"], "BM_sigma": B["sigma"], "BM_z": z, "B06_buy": buy,
            "B06_sell": sell, "B06_keep": keep1, "_BM_count": B["count"]}
    return Built("condition", cond, keep, _item_warmup("B06", params), cols,
                 ("BM_r", "BM_ok", "BM_sigma", "BM_z", "B06_buy", "B06_sell", "B06_keep"))


def _filt_f00(bars, params, plant=""):
    """F00: true everywhere, no warm-up, no columns."""
    n = int(bars["n"])
    return FBuilt(np.ones((2, n), dtype=np.int8), _filter_warmup("F00", params), None, {}, ())


def _filt_f01(bars, params, plant=""):
    """F01: x = C - EMA_e(C) (e = 200): buy x > 0, sell -x > 0; -1 where x is nan. Warm-up e."""
    e = int(_p(params, "ema", 200))
    C = np.asarray(bars["C"], dtype=np.float64)
    E = ema(C, e)
    x = C - E
    xn = np.isnan(x)
    with np.errstate(invalid="ignore"):
        buy = _tri(x > 0, xn)
        sell = _tri(-x > 0, xn)
    name = "EMA%d" % e
    cols = {name: E, "F01_buy": buy, "F01_sell": sell, "_F01_x": x}
    return FBuilt(np.vstack([buy, sell]).astype(np.int8), _filter_warmup("F01", params), None, cols,
                  (name, "F01_buy", "F01_sell"))


# ---- step 4's pilot (spec 19 step 4, the lead 2026-11-15): E13, E29, E30, F02 / F02r (S02 through F02), B07

def _macd_params(params):
    f, s, m = _p(params, "macd", (12, 26, 9))
    return int(f), int(s), int(m)


def _item_e13(bars, params, answer_knowing=False, plant=""):
    """E13 macd_sig (12, 26, 9): buy X-up(MACD line, signal), sell X-down(MACD line, signal) (spec 4.1, 3.2). Cross
    kind. Warm-up s + m - 1 (34)."""
    f, s, m = _macd_params(params)
    M = macd(bars["C"], f, s, m)
    buy = x_up(M["line"], M["signal"])
    sell = x_dn(M["line"], M["signal"])
    cond = np.vstack([buy, sell]).astype(np.int8)
    ln = "MACD%d_%d" % (f, s)
    cols = {ln: M["line"], ln + "_SIG": M["signal"], "E13_buy": buy, "E13_sell": sell,
            "_EMA_fast": M["fast"], "_EMA_slow": M["slow"]}
    return Built("cross", cond, None, _item_warmup("E13", params), cols, (ln, ln + "_SIG", "E13_buy", "E13_sell"))


def _item_e29(bars, params, answer_knowing=False, plant=""):
    """E29 inside_brk (spec 4.1, points): when H[i-1] <= H[i-2] and L[i-1] >= L[i-2], buy C[i] > H[i-2], sell
    C[i] < L[i-2]. Condition kind (spec 5: the state's rising edge). The condition is 無し for i < 2 and false (not
    無し) when bar i-1 is not inside bar i-2. Warm-up 3."""
    Ph = np.asarray(bars["Ph"], dtype=np.int64).tolist()
    Pl = np.asarray(bars["Pl"], dtype=np.int64).tolist()
    Pc = np.asarray(bars["Pc"], dtype=np.int64).tolist()
    n = len(Pc)
    inside = [-1] * n
    buy = [-1] * n
    sell = [-1] * n
    for i in range(2, n):
        ins = Ph[i - 1] <= Ph[i - 2] and Pl[i - 1] >= Pl[i - 2]
        inside[i] = 1 if ins else 0
        buy[i] = 1 if (ins and Pc[i] > Ph[i - 2]) else 0
        sell[i] = 1 if (ins and Pc[i] < Pl[i - 2]) else 0
    buy = np.array(buy, dtype=np.int8)
    sell = np.array(sell, dtype=np.int8)
    cols = {"E29_buy": buy, "E29_sell": sell, "_E29_inside": np.array(inside, dtype=np.int8)}
    return Built("condition", np.vstack([buy, sell]).astype(np.int8), None, _item_warmup("E29", params), cols,
                 ("E29_buy", "E29_sell"))


# E30's rule of the previous day's bars (spec 4.1's notes): 無し below 58 bars (15 minutes) or 15 bars (1 hour).
E30_MIN_BARS = {"m15": 58, "h1": 15}


def e30_days(bars, min_bars=None):
    """Spec 4.1 E30's day parts on a bars dict -> {"prev_day", "PDH", "PDL", "first_of_day", "count"}.

    The day of bar i is D(s_i) (bars["day"], spec 2). The previous day is the latest day before bar i's day that has
    at least one bar; its high and low are the max of H and the min of L over its bars (the rounded mid, doubles).
    PDH and PDL are nan when there is no previous day or it has fewer than min_bars bars (58 on m15, 15 on h1).
    first_of_day[i] is True when no earlier bar has bar i's day. count: day -> number of bars.
    """
    day = [int(x) for x in np.asarray(bars["day"], dtype=np.int64).tolist()]
    hs, ls = _fl(bars["H"]), _fl(bars["L"])
    n = len(day)
    if min_bars is None:
        min_bars = E30_MIN_BARS[_tf_norm(bars["tf"])]
    count = {}
    hi = {}
    lo = {}
    for i in range(n):
        d = day[i]
        if d not in count:
            count[d] = 0
            hi[d] = hs[i]
            lo[d] = ls[i]
        count[d] += 1
        if hs[i] > hi[d]:
            hi[d] = hs[i]
        if ls[i] < lo[d]:
            lo[d] = ls[i]
    days = sorted(count)
    before = {}
    for k, d in enumerate(days):
        before[d] = days[k - 1] if k > 0 else None
    prev_day = [None] * n
    PDH = [NAN] * n
    PDL = [NAN] * n
    first = [False] * n
    seen = set()
    for i in range(n):
        d = day[i]
        first[i] = d not in seen
        seen.add(d)
        p = before[d]
        prev_day[i] = p
        if p is not None and count[p] >= min_bars:
            PDH[i] = hi[p]
            PDL[i] = lo[p]
    return {"prev_day": prev_day, "PDH": np.array(PDH, dtype=np.float64), "PDL": np.array(PDL, dtype=np.float64),
            "first_of_day": np.array(first, dtype=bool), "count": count}


def _item_e30(bars, params, answer_knowing=False, plant=""):
    """E30 pday_brk (spec 4.1 and its notes): buy C > the previous day's high, sell C < its low, as the day-wise
    condition. Condition kind with E30's own rising edge and keep rule:
    - the condition is a separate condition per day: at a day's first bar, bar i-1's condition reads "not true" (not
      the previous day's last bar, and not 無し);
    - spec 5's "first bar where the condition is not 無し" applies once for the whole item (raw_signals does this);
    - ③ once per day per direction (向きごとに1日1回).
    無し when the previous day has too few bars (E30_MIN_BARS). Warm-up: 前の日がそろうこと, which is the 無し rule
    itself, so the bar-index warm-up is 0."""
    min_bars = _p(params, "pday_min_bars", None)
    P = e30_days(bars, None if min_bars is None else int(min_bars))
    cs = _fl(bars["C"])
    PDH = P["PDH"].tolist()
    PDL = P["PDL"].tolist()
    n = len(cs)
    buy = [-1] * n
    sell = [-1] * n
    for i in range(n):
        if not _isnan(PDH[i]):
            buy[i] = 1 if cs[i] > PDH[i] else 0
        if not _isnan(PDL[i]):
            sell[i] = 1 if cs[i] < PDL[i] else 0
    buy = np.array(buy, dtype=np.int8)
    sell = np.array(sell, dtype=np.int8)
    cond = np.vstack([buy, sell]).astype(np.int8)
    prev = np.full((2, n), -1, dtype=np.int8)
    if n > 1:
        prev[:, 1:] = cond[:, :-1]
    first = P["first_of_day"]
    prev[:, first] = 0
    cols = {"PD_H": P["PDH"], "PD_L": P["PDL"], "E30_buy": buy, "E30_sell": sell, "_E30_prev_day": P["prev_day"],
            "_E30_count": P["count"]}
    return Built("condition", cond, None, _item_warmup("E30", params), cols, ("PD_H", "PD_L", "E30_buy", "E30_sell"),
                 prev=prev, once_per_day=np.asarray(bars["day"], dtype=np.int64))


def _f02_period(params):
    return int(_p(params, "htf_ema", 50))


def _f02_parts(bars, params, plant=""):
    """Spec 4.2 F02's parts: g (the last higher bar whose grid end is at or before T_i, spec 2), EMA_p of the higher
    bars' mid close at g and g - 1 (p = 50), and x = EMA[g] - EMA[g-1] (nan when g < 1 or either is nan).

    bars["htf"] must hold the higher bars (keys s, C, step) made from this series (PY1's attach_htf in a run,
    attach_mid_htf in a hand example). Plant "htfOpen" (spec 16) reads g with htf_index's plant (a bar still forming).
    """
    h = bars.get("htf")
    if h is None:
        raise ValueError("F02 needs the higher bars of the series (bars['htf'])")
    p = _f02_period(params)
    hstep = int(h["step"])
    hp = "htfOpen" if plant == "htfOpen" else ""
    g = htf_index(bars["T"], h["s"], hstep, plant=hp)
    if not hp and bars.get("g") is not None:
        g0 = np.asarray(bars["g"], dtype=np.int64)
        if g0.shape != g.shape or not bool(np.all(g0 == g)):
            raise ValueError("F02: bars['g'] differs from htf_index on the series' own higher bars")
    E = ema(h["C"], p).tolist()
    gl = g.tolist()
    n = len(gl)
    cur = [NAN] * n
    prv = [NAN] * n
    x = [NAN] * n
    for i in range(n):
        k = gl[i]
        if k >= 0:
            cur[i] = E[k]
        if k >= 1:
            prv[i] = E[k - 1]
        if not (_isnan(cur[i]) or _isnan(prv[i])):
            x[i] = cur[i] - prv[i]
    return {"g": g, "EMA": np.array(cur, dtype=np.float64), "EMA_prev": np.array(prv, dtype=np.float64),
            "x": np.array(x, dtype=np.float64), "EMA_htf": np.array(E, dtype=np.float64), "p": p}


def _filt_f02(bars, params, plant=""):
    """F02 (spec 4.2): with x = EMA50[g] - EMA50[g-1] on the higher bars, buy x > 0, sell -x > 0; -1 where x is nan.
    Warm-up (spec 5, 21.5): 51 higher bars, i.e. a signal is kept only when the higher bar g it uses is >= 51
    (warm_ok); the bar-index warm-up is 0."""
    P = _f02_parts(bars, params, plant)
    x = P["x"]
    xn = np.isnan(x)
    with np.errstate(invalid="ignore"):
        buy = _tri(x > 0, xn)
        sell = _tri(-x > 0, xn)
    p = P["p"]
    warm_ok = P["g"] >= (p + 1)
    en = "HTF_EMA%d" % p
    cols = {"HTF_G": np.asarray(P["g"], dtype=np.int64), en: P["EMA"], en + "_PREV": P["EMA_prev"], "F02_buy": buy,
            "F02_sell": sell, "_F02_x": x, "_F02_EMA_htf": P["EMA_htf"]}
    return FBuilt(np.vstack([buy, sell]).astype(np.int8), _filter_warmup("F02", params), warm_ok, cols,
                  ("HTF_G", en, en + "_PREV", "F02_buy", "F02_sell"))


def _filt_f02r(bars, params, plant=""):
    """F02r (spec 4.2): d x (EMA50[g] - EMA50[g-1]) < 0: buy x < 0, sell -x < 0; -1 where x is nan. The same warm-up
    as F02. No ind/ columns of its own (lawsearch-dump.md 5: its truth is the other side's F02 column)."""
    P = _f02_parts(bars, params, plant)
    x = P["x"]
    xn = np.isnan(x)
    with np.errstate(invalid="ignore"):
        buy = _tri(x < 0, xn)
        sell = _tri(-x < 0, xn)
    warm_ok = P["g"] >= (P["p"] + 1)
    cols = {"F02r_buy": buy, "F02r_sell": sell, "_F02_x": x}
    return FBuilt(np.vstack([buy, sell]).astype(np.int8), _filter_warmup("F02r", params), warm_ok, cols, ())


def _item_b07(bars, params, answer_knowing=False, plant=""):
    """B07 rsi2 (spec 4.4, §8.113 C19 with spec 17.3's substitutions; nothing of C19 is a clock or a 5-minute count, so
    the numbers stay): condition kind on the point close c (Pc).
    - u[k] = max(c[k] - c[k-1], 0), v[k] = max(c[k-1] - c[k], 0). At bar 2 AG = (u[1] + u[2]) / 2 and AL = (v[1] +
      v[2]) / 2; from bar 3 AG = (AG*1 + u[k]) / 2, AL = (AL*1 + v[k]) / 2 (doubles, in this order). 無し before bar 2.
    - RSI2 < 10 is 9*AG < AL; RSI2 > 90 is AG > 9*AL.
    - The 200-bar mean: up = 200*c > Σ200, dn = 200*c < Σ200, where Σ200 = c[i-199] + ... + c[i] (integers, so exact
      in any order; the window includes bar i, as C19's hand example reads: bar 199 is already above the mean).
      無し before bar 199.
    - B = up and RSI2 < 10; S = dn and RSI2 > 90; 無し when either part is 無し. Warm-up 200 (§8.113 C19)."""
    c = [int(v) for v in np.asarray(bars["Pc"], dtype=np.int64).tolist()]
    n = len(c)
    W = int(_p(params, "rsi2_mean", 200))
    AG = [NAN] * n
    AL = [NAN] * n
    if n >= 3:
        u1 = max(c[1] - c[0], 0)
        u2 = max(c[2] - c[1], 0)
        v1 = max(c[0] - c[1], 0)
        v2 = max(c[1] - c[2], 0)
        ag = float(u1 + u2) / 2
        al = float(v1 + v2) / 2
        AG[2] = ag
        AL[2] = al
        for k in range(3, n):
            uk = float(max(c[k] - c[k - 1], 0))
            vk = float(max(c[k - 1] - c[k], 0))
            ag = (ag * 1 + uk) / 2
            al = (al * 1 + vk) / 2
            AG[k] = ag
            AL[k] = al
    up = [-1] * n
    dn = [-1] * n
    run = 0
    for i in range(n):
        run += c[i]
        if i >= W:
            run -= c[i - W]
        if i >= W - 1:
            up[i] = 1 if W * c[i] > run else 0
            dn[i] = 1 if W * c[i] < run else 0
    buy = [-1] * n
    sell = [-1] * n
    for i in range(n):
        if up[i] == -1 or _isnan(AG[i]) or _isnan(AL[i]):
            continue
        buy[i] = 1 if (up[i] == 1 and 9 * AG[i] < AL[i]) else 0
        sell[i] = 1 if (dn[i] == 1 and AG[i] > 9 * AL[i]) else 0
    buy = np.array(buy, dtype=np.int8)
    sell = np.array(sell, dtype=np.int8)
    cols = {"RSI2_AG": np.array(AG, dtype=np.float64), "RSI2_AL": np.array(AL, dtype=np.float64),
            "B07_up": np.array(up, dtype=np.int8), "B07_dn": np.array(dn, dtype=np.int8), "B07_buy": buy,
            "B07_sell": sell}
    return Built("condition", np.vstack([buy, sell]).astype(np.int8), None, _item_warmup("B07", params), cols,
                 ("RSI2_AG", "RSI2_AL", "B07_up", "B07_dn", "B07_buy", "B07_sell"))


# ---- the registry. Keys are the ids of research/ledger/lawsearch-candidates.json; None means "not written yet".
E_IDS = ["E%02d" % k for k in range(1, 45)]
B_IDS = ["B%02d" % k for k in range(1, 19)]
F_IDS = ["F00", "F01", "F01r", "F02", "F02r", "F03", "F03r", "F04", "F04r", "F05", "F05r", "F06", "F06b", "F07",
         "F07r"]
S_TABLE = {"S01": "F01", "S02": "F02", "S03": "F05", "S04": "F07"}   # spec 4.3
# Spec 8.6: the D_F of an (E, F01r)-like trial is made against the reversed state of its F, built the same way as an
# S row ("F01r などには、その F の逆向きの状態を同じ作りで作る"). These are not trials of the ledger; PY1 names them
# "<tf>.S02r" and so on (lawsearch-dump.md does not fix that name: reported to the lead, step 4's pilot).
S_REVERSED = {"S01r": "F01r", "S02r": "F02r", "S03r": "F05r", "S04r": "F07r"}

ITEMS = {k: None for k in E_IDS + B_IDS}
ITEMS["E04"] = _item_e04
ITEMS["E26"] = _item_e26
ITEMS["B06"] = _item_b06
ITEMS["E13"] = _item_e13          # step 4's pilot
ITEMS["E29"] = _item_e29
ITEMS["E30"] = _item_e30
ITEMS["B07"] = _item_b07

FILTERS = {k: None for k in F_IDS}
FILTERS["F00"] = _filt_f00
FILTERS["F01"] = _filt_f01
FILTERS["F02"] = _filt_f02        # step 4's pilot
FILTERS["F02r"] = _filt_f02r

S_BUILT = {"S01", "S02", "S02r"}

# A filter whose ind/ columns are another filter's (lawsearch-dump.md 5: F02r's truth is the other side's F02 column).
IND_COLUMNS_OF = {"F02r": "F02"}

# The ind/ column order (lawsearch-dump.md 5): the trial's items in this fixed order, later items appended in the
# table's order (E01..E44, then F, then B).
_IND_FIXED = ["E04", "E26", "F01", "B06"]
IND_ORDER = _IND_FIXED + [k for k in E_IDS + F_IDS + B_IDS if k not in _IND_FIXED]

# Column types for a writer (lawsearch-dump.md 3, 5): real | tri | int | bool.
IND_TYPES = {"RSI14": "real", "RSI14_U": "real", "RSI14_D": "real", "E04_buy": "tri", "E04_sell": "tri",
             "DON20_HH": "real", "DON20_LL": "real", "DON20_s": "int", "EMA200": "real", "F01_buy": "tri",
             "F01_sell": "tri", "BM_r": "real", "BM_ok": "bool", "BM_sigma": "real", "BM_z": "real",
             "B06_buy": "tri", "B06_sell": "tri", "B06_keep": "bool",
             # step 4's pilot (lawsearch-dump.md 5, the table after B06_keep). HTF_G is an int that is empty when there
             # is no usable higher bar: it is held as int64 with -1 for none (written as empty, as a tri's -1 is).
             "MACD12_26": "real", "MACD12_26_SIG": "real", "E13_buy": "tri", "E13_sell": "tri", "E29_buy": "tri",
             "E29_sell": "tri", "PD_H": "real", "PD_L": "real", "E30_buy": "tri", "E30_sell": "tri", "HTF_G": "int",
             "HTF_EMA50": "real", "HTF_EMA50_PREV": "real", "F02_buy": "tri", "F02_sell": "tri", "RSI2_AG": "real",
             "RSI2_AL": "real", "B07_up": "tri", "B07_dn": "tri", "B07_buy": "tri", "B07_sell": "tri"}


def item(eid, bars, params=None, answer_knowing=False, plant=""):
    """Build item eid ("E04", "E26", "B06") on a bars dict. NotBuilt for any other id of the table."""
    if eid not in ITEMS:
        raise NotBuilt("unknown item %r (not an id of the candidates table)" % (eid,))
    fn = ITEMS[eid]
    if fn is None:
        raise NotBuilt("item %s is not written yet" % eid)
    return fn(bars, params or {}, answer_knowing=answer_knowing, plant=plant)


def filt(fid, bars, params=None, plant=""):
    """Build filter fid ("F00", "F01") on a bars dict. NotBuilt for any other id of the table."""
    if fid not in FILTERS:
        raise NotBuilt("unknown filter %r (not an id of the candidates table)" % (fid,))
    fn = FILTERS[fid]
    if fn is None:
        raise NotBuilt("filter %s is not written yet" % fid)
    return fn(bars, params or {}, plant=plant)


def s_filter(sid):
    """The F of a state row (spec 4.3): "S01" -> "F01"; a reversed state row of spec 8.6: "S02r" -> "F02r". NotBuilt
    otherwise."""
    if sid not in S_TABLE and sid not in S_REVERSED:
        raise NotBuilt("unknown state row %r (not an id of the candidates table)" % (sid,))
    if sid not in S_BUILT:
        raise NotBuilt("state row %s is not written yet" % sid)
    return S_TABLE[sid] if sid in S_TABLE else S_REVERSED[sid]


def _tf_norm(tf):
    if tf not in _TF_ALIASES:
        raise ValueError("unknown timeframe %r" % (tf,))
    return _TF_ALIASES[tf]


def parse_trial(trial):
    """A trial dict of py-design 3.1 from a dict or from an id such as "m15.E04.F01", "h1.S01", "m15.B06"."""
    if isinstance(trial, dict):
        t = dict(trial)
        t["tf"] = _tf_norm(t["tf"])
        for k in ("e", "f", "s", "b"):
            t.setdefault(k, None)
        if t["kind"] == "S" and not t.get("f"):
            t["f"] = S_TABLE.get(t["s"])
        return t
    parts = str(trial).split(".")
    tf = _tf_norm(parts[0])
    if len(parts) == 3 and parts[1] in E_IDS and parts[2] in F_IDS:
        return {"id": trial, "tf": tf, "kind": "EF", "e": parts[1], "f": parts[2], "s": None, "b": None}
    if len(parts) == 2 and parts[1] in S_TABLE:
        return {"id": trial, "tf": tf, "kind": "S", "e": None, "f": S_TABLE[parts[1]], "s": parts[1], "b": None}
    if len(parts) == 2 and parts[1] in S_REVERSED:
        return {"id": trial, "tf": tf, "kind": "S", "e": None, "f": S_REVERSED[parts[1]], "s": parts[1], "b": None}
    if len(parts) == 2 and parts[1] in B_IDS:
        return {"id": trial, "tf": tf, "kind": "B", "e": None, "f": None, "s": None, "b": parts[1]}
    raise NotBuilt("unknown trial id %r" % (trial,))


def trial_built(trial):
    """True when every part of the trial is written (no NotBuilt would be raised)."""
    t = parse_trial(trial)
    try:
        if t["kind"] == "EF":
            return ITEMS.get(t["e"]) is not None and FILTERS.get(t["f"]) is not None
        if t["kind"] == "S":
            return FILTERS.get(s_filter(t["s"])) is not None
        if t["kind"] == "B":
            return ITEMS.get(t["b"]) is not None
    except NotBuilt:
        return False
    return False


def ledger_trials(path=None):
    """The 1,364 trials of research/ledger/lawsearch-candidates.json as py-design 3.1 dicts, in table order."""
    p = pathlib.Path(path) if path else _HERE / "ledger" / "lawsearch-candidates.json"
    d = json.loads(p.read_text(encoding="utf-8"))
    out = []
    for row in d["trials"]:
        t = {"id": row["id"], "order": row["order"], "tf": _tf_norm(row["tf"]), "kind": row["kind"],
             "e": row.get("e"), "f": row.get("f"), "s": row.get("s"), "b": row.get("b")}
        if t["kind"] == "B":
            t["f"] = None
        out.append(t)
    return out


# Warm-ups (spec 5's table, F's warm-ups, §8.113 for B; 21.5: keep bars with index >= k). The one source for the
# builders and for trial_warmup. params "warmup" / "f_warmup" (hand examples only) override them.
ITEM_WARMUP = {"E04": lambda pr: int(_p(pr, "rsi", 14)) + 1,           # RSI_p: p + 1
               "E26": lambda pr: int(_p(pr, "donchian", 20)),          # §8.113 C1: 20 bars
               "B06": lambda pr: int(_p(pr, "sigma_window", 288)),     # §8.113 C17: 288 bars
               # step 4's pilot
               "E13": lambda pr: _macd_params(pr)[1] + _macd_params(pr)[2] - 1,   # MACD (line and signal): s + m - 1
               "E29": lambda pr: 3,                                    # E29: 3 bars
               "E30": lambda pr: 0,                                    # 前の日がそろうこと: the 無し rule itself
               "B07": lambda pr: 200}                                  # §8.113 C19: 200 bars
FILTER_WARMUP = {"F00": lambda pr: 0,
                 "F01": lambda pr: int(_p(pr, "ema", 200)),             # EMA200: 200 bars
                 # F02, F02r: 51 higher bars, kept by warm_ok (the higher bar g >= 51), not by a bar index
                 "F02": lambda pr: 0,
                 "F02r": lambda pr: 0}
# The higher-bar warm-up of F02 / F02r (spec 5: 上位足の EMA50 は上位足の51本; 21.5: g >= 51).
HTF_WARMUP = {"F02": lambda pr: _f02_period(pr) + 1, "F02r": lambda pr: _f02_period(pr) + 1}


def _item_warmup(eid, params):
    params = params or {}
    if eid not in ITEMS:
        raise NotBuilt("unknown item %r" % (eid,))
    if eid not in ITEM_WARMUP:
        raise NotBuilt("item %s is not written yet" % eid)
    if "warmup" in params and params["warmup"] is not None:
        return int(params["warmup"])
    return ITEM_WARMUP[eid](params)


def _filter_warmup(fid, params):
    params = params or {}
    if fid not in FILTERS:
        raise NotBuilt("unknown filter %r" % (fid,))
    if fid not in FILTER_WARMUP:
        raise NotBuilt("filter %s is not written yet" % fid)
    if "f_warmup" in params and params["f_warmup"] is not None:
        return int(params["f_warmup"])
    return FILTER_WARMUP[fid](params)


def trial_warmup(trial, params=None):
    """The trial's warm-up k (spec 5, 21.5): max(E's, F's) for (E, F); the S's F's; the B's."""
    t = parse_trial(trial)
    if t["kind"] == "EF":
        return max(_item_warmup(t["e"], params), _filter_warmup(t["f"], params))
    if t["kind"] == "S":
        return _filter_warmup(s_filter(t["s"]), params)
    if t["kind"] == "B":
        return _item_warmup(t["b"], params)
    raise NotBuilt("unknown trial kind %r" % (t["kind"],))


# =====================================================================================================================
# 4.4 events (spec 5, with §8.113 5 for B06)
# =====================================================================================================================

def _first_defined(c):
    """The first index where tri row c is not -1, or len(c) when none."""
    idx = np.flatnonzero(c != -1)
    return int(idx[0]) if idx.size else len(c)


def raw_signals(kind, cond, plant="", prev=None):
    """Spec 5 ②, per direction: a bool (2, n) array of raw signals from ①'s condition.

    cross: cond == 1. condition and hold: cond[i] == 1, i >= 1, cond[i-1] == 0, and i is not the first bar where
    cond is not -1. state: cond == 1 (no rising edge, and neither "no signal" bar). Plant "noRisingEdge": condition
    and hold kinds emit every bar where cond is 1.
    prev (int8 (2, n) tri, condition kind only): the value that bar i's rising edge compares with, in place of
    cond[i-1] (E30's day-wise condition); a bar whose prev is -1 is not a signal, as with cond[i-1] == -1.
    """
    cond = np.asarray(cond, dtype=np.int8)
    n = cond.shape[1]
    out = np.zeros((2, n), dtype=bool)
    for r in range(2):
        c = cond[r]
        if kind in ("cross", "state"):
            out[r] = c == 1
        elif kind in ("condition", "hold"):
            if plant == "noRisingEdge":
                out[r] = c == 1
            else:
                if prev is not None:
                    pv = np.asarray(prev, dtype=np.int8)[r]
                    out[r] = (c == 1) & (pv == 0)
                elif n > 1:
                    out[r, 1:] = (c[1:] == 1) & (c[:-1] == 0)
                k = _first_defined(c)
                if k < n:
                    out[r, k] = False
        else:
            raise ValueError("unknown kind %r" % (kind,))
    return out


def once_per_day(raw, day):
    """Spec 5 ③ for E30 (向きごとに1日1回): per direction, only the first raw signal of each day is kept."""
    raw = np.array(raw, dtype=bool)
    dl = np.asarray(day, dtype=np.int64).tolist()
    for r in range(2):
        seen = set()
        for i in np.flatnonzero(raw[r]).tolist():
            if dl[i] in seen:
                raw[r, i] = False
            else:
                seen.add(dl[i])
    return raw


def apply_filter(rows, f):
    """Spec 5 ④ and ⑤ on raw signals left after ③. rows: [(i, d)] in bar order, buy before sell; f: int8 (2, n).
    -> [[i, d, status]] with status "emit" or "f_none" (f == -1); rows whose f is 0 are dropped (not written, not
    counted); two directions left emitted at one bar both get "both"."""
    f = np.asarray(f, dtype=np.int8)
    out = []
    for i, d in rows:
        fv = int(f[0 if d == 1 else 1, i])
        if fv == 0:
            continue
        out.append([int(i), int(d), "f_none" if fv == -1 else "emit"])
    emit_pos = [k for k, row in enumerate(out) if row[2] == "emit"]
    drop = both_rule([("", out[k][0], out[k][1]) for k in emit_pos])
    for kk in drop:
        out[emit_pos[kk]][2] = "both"
    return out


def both_rule(rows):
    """Spec 5 ⑤ on rows left after ④: rows is a list of (pair, i, d). Returns the set of row positions dropped
    because the same pair and bar has both a buy and a sell left."""
    seen = {}
    for k, (pair, i, d) in enumerate(rows):
        seen.setdefault((pair, int(i)), {}).setdefault(int(d), []).append(k)
    drop = set()
    for _key, by_d in seen.items():
        if 1 in by_d and -1 in by_d:
            for ks in by_d.values():
                drop.update(ks)
    return drop


def _trial_parts(t, bars, params, plant, answer_knowing):
    """(Built-like item part, FBuilt) of a parsed trial. The item part has kind, cond, keep, warmup, prev and
    once_per_day."""
    if t["kind"] == "EF":
        it = item(t["e"], bars, params, answer_knowing=answer_knowing, plant=plant)
        fb = filt(t["f"], bars, params, plant=plant)
        return it, fb
    if t["kind"] == "S":
        fb = filt(s_filter(t["s"]), bars, params, plant=plant)
        # The S row's condition is F's f itself; ④ applies no further filter (F00).
        none_f = _filt_f00(bars, params)
        return Built("state", fb.f, None, fb.warmup, {}), FBuilt(none_f.f, 0, fb.warm_ok, {})
    if t["kind"] == "B":
        it = item(t["b"], bars, params, answer_knowing=answer_knowing, plant=plant)
        return it, _filt_f00(bars, params)
    raise NotBuilt("unknown trial kind %r" % (t["kind"],))


def candidates(trial, bars, params=None, plant="", answer_knowing=False):
    """Every candidate of spec 5 ①-⑤ of one trial on one bars dict.

    -> {"i": int64[], "d": int8[], "status": list of "emit" | "f_none" | "both", "warm": bool[]},
    every bar with a candidate, in bar order, buy before sell.
    ① the condition comes from the item, or from F's f for an S row; ② the raw signal (raw_signals, with the item's
    prev where it has one); ③ keep == False drops the raw signal, uncounted (the condition is unchanged, so the next
    bar still compares with ①'s value), then the item's once-per-day rule (E30); ④ f == -1 gives f_none, f == 0 drops
    the signal (not written, not counted), f == 1 keeps it; ⑤ two directions left at one bar: both get "both". warm
    is i >= max(item warm-up, filter warm-up) (an S row: its F's), and the filter's warm_ok where it has one.
    """
    t = parse_trial(trial)
    params = params or {}
    if not trial_built(t):     # fail loudly before computing anything (an item or filter not written yet)
        raise NotBuilt("trial %s uses an item, filter or state row that is not written yet" % t["id"])
    it, fb = _trial_parts(t, bars, params, plant, answer_knowing)
    raw = raw_signals(it.kind, it.cond, plant, it.prev)
    if it.keep is not None:
        raw = raw & np.asarray(it.keep, dtype=bool)
    if it.once_per_day is not None:
        raw = once_per_day(raw, it.once_per_day)
    k_warm = max(int(it.warmup), int(fb.warmup))
    pairs = []
    for i in np.flatnonzero(raw[0] | raw[1]).tolist():
        for r, d in ((0, 1), (1, -1)):
            if raw[r, i]:
                pairs.append((i, d))
    rows = apply_filter(pairs, fb.f)
    wo = fb.warm_ok
    warm = []
    for i, _d, _s in rows:
        w = i >= k_warm
        if wo is not None:
            w = w and bool(wo[i])
        warm.append(w)
    return {"i": np.array([r[0] for r in rows], dtype=np.int64), "d": np.array([r[1] for r in rows], dtype=np.int8),
            "status": [r[2] for r in rows], "warm": np.array(warm, dtype=bool)}


def ind_columns(trials, bars, params=None, answer_knowing=False):
    """The ind/ columns of lawsearch-dump.md 5 (name -> array) for the built items of these trials, in the dump's
    order. Raises NotBuilt when a trial uses an item that is not written. Types: IND_TYPES (tri is int8 with -1 for
    無し; DON20_s is int64 and never empty; bool columns are bool)."""
    need = set()
    for tr_ in trials:
        t = parse_trial(tr_)
        if t["kind"] == "EF":
            item_ok = ITEMS.get(t["e"])
            if item_ok is None:
                raise NotBuilt("item %s is not written yet" % t["e"])
            if FILTERS.get(t["f"]) is None:
                raise NotBuilt("filter %s is not written yet" % t["f"])
            need.add(t["e"])
            need.add(IND_COLUMNS_OF.get(t["f"], t["f"]))
        elif t["kind"] == "S":
            f = s_filter(t["s"])
            need.add(IND_COLUMNS_OF.get(f, f))
        elif t["kind"] == "B":
            if ITEMS.get(t["b"]) is None:
                raise NotBuilt("item %s is not written yet" % t["b"])
            need.add(t["b"])
    out = {}
    for key in IND_ORDER:
        if key not in need:
            continue
        if key in FILTERS:
            b = filt(key, bars, params)
        else:
            b = item(key, bars, params, answer_knowing=answer_knowing)
        for name in b.dump_columns:
            col = b.columns[name]
            if name.endswith("_s") and name.startswith("DON"):
                col = np.asarray(col, dtype=np.int64)
            out[name] = col
    return out


# =====================================================================================================================
# 4.5 hand examples of groups 3 and 4
# =====================================================================================================================

def _day_key(t_ms):
    """Spec 2 D(t): the UTC date of t + 3 hours, Saturday -> Friday, as YYYYMMDD."""
    days = (int(t_ms) + 3 * HOUR_MS) // DAY_MS
    if (days + 3) % 7 == 5:          # 1970-01-01 was a Thursday (weekday 3); 5 is Saturday
        days -= 1
    d = datetime.date(1970, 1, 1) + datetime.timedelta(days=days)
    return d.year * 10000 + d.month * 100 + d.day


def _mult(pair):
    return 1000 if pair.endswith("JPY") else 100000


def bars_from_mid(pair, tf, starts_ms, mid_rows):
    """A bars dict (py-design 3.2) from decimal mid strings: O..C = float(str), points = round(v * mult), day by
    spec 2. htf and g are None (PY1 builds the higher bars)."""
    tfn = _tf_norm(tf)
    step = STEP[tfn]
    n = len(mid_rows)
    s = np.array([int(x) for x in starts_ms], dtype=np.int64)
    if len(s) != n:
        raise ValueError("starts and rows differ in length")
    vals = [[float(str(r[k])) for r in mid_rows] for k in range(4)]
    mult = _mult(pair)
    pts = [[round(v * mult) for v in vals[k]] for k in range(4)]
    return {"pair": pair, "pi": PAIRS.index(pair) if pair in PAIRS else -1, "tf": tfn, "step": step, "n": n,
            "s": s, "T": s + np.int64(step),
            "O": np.array(vals[0], dtype=np.float64), "H": np.array(vals[1], dtype=np.float64),
            "L": np.array(vals[2], dtype=np.float64), "C": np.array(vals[3], dtype=np.float64),
            "Po": np.array(pts[0], dtype=np.int64), "Ph": np.array(pts[1], dtype=np.int64),
            "Pl": np.array(pts[2], dtype=np.int64), "Pc": np.array(pts[3], dtype=np.int64),
            "day": np.array([_day_key(t) for t in s.tolist()], dtype=np.int64), "htf": None, "g": None}


def _iso_ms(text):
    dt = datetime.datetime.fromisoformat(str(text).replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=datetime.timezone.utc)
    return int(round(dt.timestamp() * 1000))


def _ms_iso(ms):
    dt = datetime.datetime.fromtimestamp(int(ms) / 1000, tz=datetime.timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def _hand_bars(inp):
    """The bars of a hand example: "start" (bars every step), explicit "s" (ISO strings), or a "bars" list of
    {"s", "mid"} (A.3.21, A.3.22)."""
    tf = _tf_norm(inp["tf"])
    if "mid" not in inp and isinstance(inp.get("bars"), list):
        starts = [_iso_ms(b["s"]) for b in inp["bars"]]
        return bars_from_mid(inp["pair"], tf, starts, [b["mid"] for b in inp["bars"]])
    mid = inp["mid"]
    if "s" in inp and isinstance(inp["s"], list):
        starts = [_iso_ms(x) for x in inp["s"]]
    else:
        start = inp.get("start", "2024-03-04T00:00:00Z")
        s0 = _iso_ms(start)
        starts = [s0 + k * STEP[tf] for k in range(len(mid))]
    return bars_from_mid(inp["pair"], tf, starts, mid)


_HTF_TF = {"m15": "h1", "h1": "h4"}


def attach_mid_htf(bars, plant=""):
    """Hand examples only (their bars are mid strings): the higher bars of spec 2 made from the mid on the UTC grid
    of the higher step (start = floor(t / step) * step): open of the first bar, close of the last, max high, min low;
    the index runs from 0. The close is the same double as from Bid and Ask coarsened first (the last bar's mid
    close), which is all F02 reads. PY1 builds a run's higher bars from Bid and Ask (attach_htf). Sets bars["htf"]
    and bars["g"] (htf_index; plant "htfOpen" reads a bar still forming)."""
    tf = bars["tf"]
    htf_tf = _HTF_TF[tf]
    hstep = STEP[htf_tf]
    groups = []
    for i in range(bars["n"]):
        s = int(bars["s"][i])
        g = s // hstep * hstep
        o, h, l, c = float(bars["O"][i]), float(bars["H"][i]), float(bars["L"][i]), float(bars["C"][i])
        if not groups or groups[-1][0] != g:
            groups.append([g, o, h, l, c])
        else:
            cur = groups[-1]
            if h > cur[2]:
                cur[2] = h
            if l < cur[3]:
                cur[3] = l
            cur[4] = c
    hs = np.array([x[0] for x in groups], dtype=np.int64)
    bars["htf"] = {"tf": htf_tf, "step": hstep, "n": len(groups), "s": hs, "T": hs + np.int64(hstep),
                   "O": np.array([x[1] for x in groups], dtype=np.float64),
                   "H": np.array([x[2] for x in groups], dtype=np.float64),
                   "L": np.array([x[3] for x in groups], dtype=np.float64),
                   "C": np.array([x[4] for x in groups], dtype=np.float64)}
    bars["g"] = htf_index(bars["T"], hs, hstep, plant="htfOpen" if plant == "htfOpen" else "")
    return bars


def _pyv(v):
    """numpy scalar / nan -> Python value (nan -> None)."""
    if isinstance(v, (np.floating, float)):
        f = float(v)
        return None if f != f else f
    if isinstance(v, (np.bool_, bool)):
        return bool(v)
    if isinstance(v, (np.integer, int)):
        return int(v)
    return v


def _flist(a, start=0):
    return [_pyv(v) for v in np.asarray(a, dtype=np.float64).tolist()[start:]]


def _tlist(a):
    """int8 tri -> list of True / False / None."""
    return [None if v == -1 else bool(v == 1) for v in np.asarray(a).tolist()]


def _first_finite(a):
    a = np.asarray(a, dtype=np.float64)
    idx = np.flatnonzero(~np.isnan(a))
    return int(idx[0]) if idx.size else None


def _sig_records(cand, bars, with_T=False, statuses=("emit",)):
    out = []
    for i, d, st in zip(cand["i"].tolist(), cand["d"].tolist(), cand["status"]):
        if st not in statuses:
            continue
        rec = {"i": int(i), "d": "BUY" if d == 1 else "SELL"}
        if with_T:
            rec["T"] = _ms_iso(bars["T"][i])
        out.append(rec)
    return out


def _sig_buy_sell(cand, statuses=("emit",)):
    out = {"buy": [], "sell": []}
    for i, d, st in zip(cand["i"].tolist(), cand["d"].tolist(), cand["status"]):
        if st in statuses:
            out["buy" if d == 1 else "sell"].append(int(i))
    return out


def _b06_params(ex):
    pr = ex.get("params") or {}
    out = {}
    for k in ("sigma_window", "sigma_min_usable", "move_bars", "threshold"):
        if k in pr:
            out[k] = pr[k]
    if "gap_minutes" in pr:
        out["gap_ms"] = int(pr["gap_minutes"]) * MIN_MS
    return out


# ---- handlers: each returns the computed values of the expect keys it knows (paths as in the expect object)

def _h_a31(ex, plant):
    inp = ex["input"]
    a = [NAN if v is None else float(v) for v in inp["a"]]
    b = [NAN if v is None else float(v) for v in inp["b"]]
    L = float(inp["L"])
    return {"xup_a_b": _tlist(x_up(a, b)), "xdn_a_b": _tlist(x_dn(a, b)), "xup_a_L": _tlist(x_up(a, L)),
            "xdn_a_L": _tlist(x_dn(a, L))}


def _h_sma20(ex, plant):
    bars = _hand_bars(ex["input"])
    f = ex["expect"]["first_index_shown"]
    S = sma(bars["C"], 20, plant=plant)
    return {"first_index_shown": _first_finite(S), "SMA20": _flist(S, f),
            "SMA20_newest_first_MISREADING": _flist(sma(bars["C"], 20, plant="smaNewestFirst"), f)}


def _h_a35(ex, plant):
    p = int(ex["params"]["p"])
    x = [NAN if v is None else float(v) for v in ex["input"]["x"]]
    return {"EMA5": _flist(ema(x, p)), "RMA5": _flist(rma(x, p))}


def _h_tr_atr14(ex, plant):
    bars = _hand_bars(ex["input"])
    return {"TR": _flist(tr(bars["H"], bars["L"], bars["C"])), "ATR14": _flist(atr(bars["H"], bars["L"], bars["C"], 14))}


def _h_a37(ex, plant):
    bars = _hand_bars(ex["input"])
    R = rsi(bars["C"], 7)
    return {"up": _flist(R["up"]), "dn": _flist(R["dn"]), "U": _flist(R["U"]), "D": _flist(R["D"]),
            "RSI7": _flist(R["rsi"])}


def _h_a38(ex, plant):
    bars = _hand_bars(ex["input"])
    out = {"RSI7": _flist(rsi(bars["C"], 7)["rsi"]), "RSI14": _flist(rsi(bars["C"], 14)["rsi"]),
           "RSI21": _flist(rsi(bars["C"], 21)["rsi"])}
    c = candidates("m15.E04.F00", bars, plant=plant)
    out["signals"] = {"E04": _sig_buy_sell(c)}
    return out


def _h_a39(ex, plant):
    bars = _hand_bars(ex["input"])
    R14 = rsi(bars["C"], 14)
    eq = []
    for u, d in zip(R14["U"].tolist(), R14["D"].tolist()):
        eq.append(None if (u != u or d != d) else bool(u == d))
    return {"up": _flist(R14["up"]), "dn": _flist(R14["dn"]), "U14": _flist(R14["U"]), "D14": _flist(R14["D"]),
            "RSI14": _flist(R14["rsi"]), "RSI7": _flist(rsi(bars["C"], 7)["rsi"]), "U14_eq_D14": eq}


def _h_emas(periods):
    def h(ex, plant):
        bars = _hand_bars(ex["input"])
        f = ex["expect"].get("first_index_shown", 0)
        out = {}
        for p in periods:
            out["EMA%d" % p] = _flist(ema(bars["C"], p), f)
        if "first_index_shown" in ex["expect"]:
            out["first_index_shown"] = _first_finite(ema(bars["C"], 12))
        return out
    return h


def _table_k(text):
    """The k of A.3.19's "table" column: its leading number ("34（s＋m−1）" -> 34; F02's "上位足51本" -> 51, counted
    in higher bars), or 0 for "—"."""
    m = re.match(r"\s*(?:上位足)?(\d+)", str(text))
    if m:
        return int(m.group(1))
    if str(text).strip() in ("—", "-", "–"):
        return 0
    return None


# The value whose first index is A.3.19's "first_value_index" of an E row (値が最初にある番号).
_E_FIRST_VALUE = {"E04": "RSI14", "E13": "MACD12_26_SIG"}


def _first_keep(fb, n):
    """The first bar index whose signals a filter keeps (spec 5's F warm-up, 21.5): i >= warmup and warm_ok[i]."""
    for i in range(n):
        if i >= fb.warmup and (fb.warm_ok is None or bool(fb.warm_ok[i])):
            return i
    return None


def _h_a319(ex, plant):
    bars = _hand_bars(ex["input"])
    attach_mid_htf(bars, plant)
    tf = bars["tf"]
    e_rows = {}
    for eid, col in _E_FIRST_VALUE.items():
        it = item(eid, bars, plant=plant)
        k = trial_warmup("%s.%s.F00" % (tf, eid))
        e_rows[eid] = {"first_value_index": _first_finite(it.columns[col]),
                       "first_signal_index": min(_first_defined(it.cond[0]), _first_defined(it.cond[1])),
                       "keep_from_index": k, "table": k}
    f_rows = {}
    for fid in ("F00", "F01", "F02"):
        fb = filt(fid, bars, plant=plant)
        table = HTF_WARMUP[fid]({}) if fid in HTF_WARMUP else fb.warmup
        f_rows[fid] = {"first_value_index": min(_first_defined(fb.f[0]), _first_defined(fb.f[1])),
                       "keep_from_index": _first_keep(fb, bars["n"]), "table": table}
    g = filt("F02", bars, plant=plant).columns["HTF_G"]
    used = {k: int(g[int(k)]) for k in ex["expect"].get("F02_used_higher_bar_g_at", {})}
    return {"_E_rows": e_rows, "_F_rows": f_rows, "F02_used_higher_bar_g_at": used}


def _h_macd(ex, plant):
    """A.3.14-A.3.16: MACD(12, 26, 9) and E13 (spec 3.2, 4.1). Lists start at first_index_shown where the example has
    one."""
    bars = _hand_bars(ex["input"])
    exp = ex["expect"]
    f0 = exp.get("first_index_shown", 0)
    C = bars["C"]
    M = macd(C, 12, 26, 9)
    out = {"EMA12": _flist(M["fast"], f0), "EMA26": _flist(M["slow"], f0), "line_12_26": _flist(M["line"], f0),
           "signal_9": _flist(M["signal"], f0), "signal_9_seed_index": _first_finite(M["signal"])}
    for p in (5, 35):
        out["EMA%d" % p] = _flist(ema(C, p), f0)
    if "first_index_shown" in exp:
        out["first_index_shown"] = _first_finite(M["fast"])
    trial = "%s.E13.F00" % bars["tf"]
    c = candidates(trial, bars, plant=plant)
    out["signals"] = {"E13": _sig_buy_sell(c)}
    out["warmup_k"] = {"E13": trial_warmup(trial)}
    excl = {"buy": [], "sell": []}
    for i, d, st, w in zip(c["i"].tolist(), c["d"].tolist(), c["status"], c["warm"].tolist()):
        if st == "emit" and not w:
            excl["buy" if d == 1 else "sell"].append(int(i))
    out["excluded_by_warmup_1"] = {"E13": excl}
    return out


def _tri1(v):
    v = int(v)
    return None if v == -1 else bool(v == 1)


def _f02_bar_view(bars, fb, fr, with_r=True):
    """Per base bar: g's start, the slope EMA[g] - EMA[g-1], F02 (and F02r) buy and sell."""
    h = bars["htf"]
    g = fb.columns["HTF_G"].tolist()
    x = fb.columns["_F02_x"]
    out = []
    for i in range(bars["n"]):
        row = {"i": i, "s": _ms_iso(bars["s"][i]), "T": _ms_iso(bars["T"][i]),
               "g_start": _ms_iso(h["s"][g[i]]) if g[i] >= 0 else None, "slope": _pyv(x[i]),
               "F02_buy": _tri1(fb.f[0, i]), "F02_sell": _tri1(fb.f[1, i])}
        if with_r:
            row["F02r_buy"] = _tri1(fr.f[0, i])
            row["F02r_sell"] = _tri1(fr.f[1, i])
        out.append(row)
    return out


def _htf_rows(bars, fb, p, k_from=0, with_k=False):
    h = bars["htf"]
    E = fb.columns["_F02_EMA_htf"]
    out = []
    for k in range(k_from, h["n"]):
        row = {"start": _ms_iso(h["s"][k]), "close": _pyv(h["C"][k]), "EMA%d" % p: _pyv(E[k])}
        if with_k:
            row["k"] = k
        out.append(row)
    return out


def _h_f02(ex, plant):
    """A.3.21, A.3.22: F02 and F02r on the higher bars (spec 2's rule, the example's shrunk EMA)."""
    bars = _hand_bars(ex["input"])
    attach_mid_htf(bars, plant)
    p = int(ex["params"]["F02_EMA"])
    pr = {"htf_ema": p}
    fb = filt("F02", bars, pr, plant=plant)
    fr = filt("F02r", bars, pr, plant=plant)
    return {"higher_bars": _htf_rows(bars, fb, p), "per_bar": _f02_bar_view(bars, fb, fr)}


def _h_s02(htf_key):
    """A.4.28, A.4.37: S02 (spec 4.3, F02's state row; the example's shrunk higher-bar EMA)."""
    def h(ex, plant):
        bars = _hand_bars(ex["input"])
        attach_mid_htf(bars, plant)
        p = int(ex["params"]["htf_ema_period"])
        pr = {"htf_ema": p}
        fb = filt("F02", bars, pr, plant=plant)
        c = candidates("%s.S02" % bars["tf"], bars, pr, plant=plant)
        g = fb.columns["HTF_G"].tolist()
        return {htf_key: _htf_rows(bars, fb, p), "g_index": [k if k >= 0 else None for k in g],
                "F_buy": _tlist(fb.f[0]), "F_sell": _tlist(fb.f[1]), "signals": _sig_records(c, bars, with_T=True)}
    return h


def _h_a328_f02(ex, plant):
    """A.3.28's F02 / F02r keys. E02 is not built: its two signals are read from the example's own
    E02_signals_after_rising_edge (bars 9 and 13), and spec 5's ④ and ⑤ (apply_filter) are applied to them with
    F02 / F02r (the example's EMA3)."""
    bars = _hand_bars(ex["input"])
    attach_mid_htf(bars, plant)
    pr = {"htf_ema": int(ex["params"]["F02_EMA"])}
    e02 = [(int(r["i"]), int(r["d"])) for r in ex["expect"]["E02_signals_after_rising_edge"]]
    e02.sort(key=lambda r: (r[0], 0 if r[1] == 1 else 1))
    fb = filt("F02", bars, pr, plant=plant)
    x = fb.columns["_F02_x"]
    out = {"filters_at_signals": {"F02_slope": [_pyv(x[i]) for i, _d in e02]}, "trials": {}}
    for fid in ("F02", "F02r"):
        f = filt(fid, bars, pr, plant=plant).f
        rows = apply_filter(e02, f)
        out["trials"]["E02." + fid] = {
            "F_values_at_signals": [_tri1(f[0 if d == 1 else 1, i]) for i, d in e02],
            "emitted": [{"i": i, "T": _ms_iso(bars["T"][i]), "d": d} for i, d, st in rows if st == "emit"],
            "F_null_count": len([r for r in rows if r[2] == "f_none"]),
            "both_sides_dropped_signals": len([r for r in rows if r[2] == "both"])}
    return out


def _h_a44(ex, plant):
    """A.4.4: E29 inside_brk (points)."""
    bars = _hand_bars(ex["input"])
    it = item("E29", bars, plant=plant)
    c = candidates("%s.E29.F00" % bars["tf"], bars, plant=plant)
    return {"Ph": [int(v) for v in bars["Ph"].tolist()], "Pl": [int(v) for v in bars["Pl"].tolist()],
            "Pc": [int(v) for v in bars["Pc"].tolist()], "inside_i_minus_1": _tlist(it.columns["_E29_inside"]),
            "cond_buy": _tlist(it.cond[0]), "cond_sell": _tlist(it.cond[1]), "signals": _sig_records(c, bars)}


def _iso_day(ymd):
    ymd = int(ymd)
    return "%04d-%02d-%02d" % (ymd // 10000, ymd // 100 % 100, ymd % 100)


def _h_e30(ex, plant):
    """A.4.5-A.4.7: E30 pday_brk (spec 4.1's notes)."""
    bars = _hand_bars(ex["input"])
    it = item("E30", bars, plant=plant)
    c = candidates("%s.E30.F00" % bars["tf"], bars, plant=plant)
    pd = it.columns["_E30_prev_day"]
    cnt = it.columns["_E30_count"]
    return {"day": [_iso_day(d) for d in bars["day"].tolist()],
            "prev_day": [None if d is None else _iso_day(d) for d in pd],
            "bars_per_day": {_iso_day(d): int(k) for d, k in sorted(cnt.items())},
            "PDH": _flist(it.columns["PD_H"]), "PDL": _flist(it.columns["PD_L"]),
            "cond_buy": _tlist(it.cond[0]), "cond_sell": _tlist(it.cond[1]),
            "signals": _sig_records(c, bars, with_T=True)}


def _h_a320(ex, plant):
    bars = _hand_bars(ex["input"])
    e = int(ex["params"]["F01_EMA"])
    fb = filt("F01", bars, {"ema": e})
    k = trial_warmup("m15.S01", {"ema": e})
    used = [i for i in range(bars["n"]) if fb.f[0, i] != -1 and i < k]
    return {"EMA5": _flist(fb.columns["EMA%d" % e]), "C_minus_EMA": _flist(fb.columns["_F01_x"]),
            "F01_buy": _tlist(fb.f[0]), "F01_sell": _tlist(fb.f[1]), "warmup_k": k,
            "F_value_used_signal_excluded_by_warmup_1_at": used}


def _h_a324(ex, plant):
    bars = _hand_bars(ex["input"])
    p = int(ex["params"]["F04_SMA"])
    A = atr(bars["H"], bars["L"], bars["C"], 14)
    return {"TR": _flist(tr(bars["H"], bars["L"], bars["C"])), "ATR14": _flist(A),
            "SMA%d_ATR14" % p: _flist(sma(A, p, plant=plant))}


def _h_a325(ex, plant):
    bars = _hand_bars(ex["input"])
    return {"RSI14": _flist(rsi(bars["C"], 14)["rsi"])}


def _h_a329(ex, plant):
    rows = ex["input"]["after_step4"]
    keyed = [(r["pair"], r["i"], r["d"]) for r in rows]
    drop = both_rule(keyed)
    emitted = [dict(r) for k, r in enumerate(rows) if k not in drop]
    dropped = []
    for k, r in enumerate(rows):
        if k in drop and {"pair": r["pair"], "i": r["i"]} not in dropped:
            dropped.append({"pair": r["pair"], "i": r["i"]})
    return {"emitted": emitted, "both_sides_dropped_signals": len(drop), "dropped": dropped,
            "signals_after_step5_in_15_identity": len(emitted)}


def _h_a330(ex, plant):
    bars = _hand_bars(ex["input"])
    attach_mid_htf(bars, plant)
    f = ex["expect"]["first_index_shown"]
    C = bars["C"]
    E50 = ema(C, 50)
    E200 = ema(C, 200)
    A = atr(bars["H"], bars["L"], C, 14)
    S = sma(A, 100, plant=plant)
    # F02 on the 1-hour bars with the spec's EMA50 (step 4's pilot)
    fb = filt("F02", bars, plant=plant)
    g = fb.columns["HTF_G"].tolist()
    x = fb.columns["_F02_x"]
    return {"first_index_shown": f, "EMA50": _flist(E50, f), "EMA200": _flist(E200, f),
            "C_minus_EMA200": _flist(np.asarray(C) - E200, f), "ATR14": _flist(A, f), "SMA100_ATR14": _flist(S, f),
            "first_value_index": {"EMA50": _first_finite(E50), "EMA200": _first_finite(E200),
                                  "SMA100_ATR14": _first_finite(S), "F02_slope": _first_finite(x)},
            "F02_g": [k if k >= 0 else None for k in g[f:]], "F02_slope": _flist(x, f),
            "hourly_from_k48": _htf_rows(bars, fb, 50, k_from=48, with_k=True),
            "F02_keep_from_index": _first_keep(fb, bars["n"])}


def _h_a334(ex, plant):
    return _h_tr_atr14(ex, plant)


def _h_don(n, trial):
    def h(ex, plant):
        bars = _hand_bars(ex["input"])
        D = donchian(bars["H"], bars["L"], bars["C"], n)
        out = {"HH": _flist(D["HH"]), "LL": _flist(D["LL"]), "target_s": [int(v) for v in D["s"].tolist()]}
        if trial:
            out["signals"] = _sig_records(candidates(trial, bars, plant=plant), bars)
        return out
    return h


def _h_a43(ex, plant):
    bars = _hand_bars(ex["input"])
    return {"TR": _flist(tr(bars["H"], bars["L"], bars["C"])), "ATR10": _flist(atr(bars["H"], bars["L"], bars["C"], 10)),
            "EMA20": _flist(ema(bars["C"], 20))}


def _h_a410(ex, plant):
    bars = _hand_bars(ex["input"])
    T = tr(bars["H"], bars["L"], bars["C"])
    A = atr(bars["H"], bars["L"], bars["C"], 14)
    return {"TR15": _pyv(T[15]), "ATR14_14": _pyv(A[14])}


def _h_rsi14_ud(ex, plant):
    bars = _hand_bars(ex["input"])
    R = rsi(bars["C"], 14)
    return {"U": _flist(R["U"]), "D": _flist(R["D"]), "RSI14": _flist(R["rsi"])}


def _h_s01(ex, plant):
    bars = _hand_bars(ex["input"])
    pr = ex.get("params") or {}
    params = {"ema": int(pr["ema_period"])} if "ema_period" in pr else {}
    e = int(params.get("ema", 200))
    fb = filt("F01", bars, params)
    c = candidates("m15.S01", bars, params, plant=plant)
    out = {"EMA": _flist(fb.columns["EMA%d" % e]), "C_minus_EMA": _flist(fb.columns["_F01_x"]),
           "F_buy": _tlist(fb.f[0]), "F_sell": _tlist(fb.f[1]), "signals": _sig_records(c, bars)}
    kept = []
    for rec, w, st in zip(_sig_records(c, bars, statuses=("emit", "f_none", "both")), c["warm"].tolist(),
                          c["status"]):
        if st == "emit" and w:
            kept.append(rec)
    out["kept_after_warmup"] = kept
    xs = _fl(bars["C"])
    if len(xs) >= e:
        out["seed_sum"] = _seed_sum(xs, e - 1, e)
    out["alpha"] = 2 / (e + 1)
    out["one_minus_alpha"] = 1.0 - out["alpha"]
    return out


def _h_b06(ex, plant):
    bars = _hand_bars(ex["input"])
    params = _b06_params(ex)
    it = item("B06", bars, params)
    c = candidates("%s.B06" % bars["tf"], bars, params, plant=plant)
    keep = it.keep[0]
    out = {"r": _flist(it.columns["BM_r"]), "sigma": _flist(it.columns["BM_sigma"]), "z": _flist(it.columns["BM_z"]),
           "cond_buy": _tlist(it.cond[0]), "cond_sell": _tlist(it.cond[1]),
           "T_excluded": [not bool(v) for v in keep.tolist()], "signals": _sig_records(c, bars, with_T=True)}
    # A.4.40's extras
    s = bars["s"].tolist()
    gap = params.get("gap_ms", 12 * bars["step"])
    out["gap_bars"] = [t for t in range(1, len(s)) if s[t] - s[t - 1] > gap]
    out["sigma_first_index"] = _first_finite(it.columns["BM_sigma"])
    cnt = it.columns["_BM_count"].tolist()
    kb = []
    for i in range(bars["n"]):
        kb.append({"i": i, "s": _ms_iso(s[i]), "C": _pyv(bars["C"][i]), "r": _pyv(it.columns["BM_r"][i]),
                   "usable_r": None if cnt[i] < 0 else int(cnt[i]), "sigma": _pyv(it.columns["BM_sigma"][i]),
                   "z": _pyv(it.columns["BM_z"][i]), "cond_buy": out["cond_buy"][i], "cond_sell": out["cond_sell"][i],
                   "T_excluded": out["T_excluded"][i]})
    out["_key_bars_by_i"] = kb
    return out


_LN_KEYS = ("r", "sigma", "z")

# The coverage table of py-design 7 for PY2: id -> (handler, required paths or "all").
HAND_TABLE = {
    "A.3.1": (_h_a31, "all"),
    "A.3.2": (_h_sma20, ["first_index_shown", "SMA20"]),
    "A.3.5": (_h_a35, "all"),
    "A.3.6": (_h_tr_atr14, ["TR", "ATR14"]),
    "A.3.7": (_h_a37, ["up", "dn", "U", "D", "RSI7"]),
    "A.3.8": (_h_a38, ["RSI7", "RSI14", "RSI21", "signals.E04"]),
    "A.3.9": (_h_a39, ["up", "dn", "U14", "D14", "RSI14", "RSI7", "U14_eq_D14"]),
    # A.3.14-A.3.16: E13 (step 4's pilot) unlocks its MACD line, signal and signals; E14's and E15's keys stay skipped
    "A.3.14": (_h_macd, ["EMA12", "EMA26", "EMA5", "EMA35", "line_12_26", "signal_9", "signal_9_seed_index",
                         ("signals", "E13")]),
    "A.3.15": (_h_macd, ["?first_index_shown", "EMA12", "EMA26", "line_12_26", "signal_9", ("signals", "E13"),
                         ("warmup_k", "E13"), ("excluded_by_warmup_1", "E13")]),
    "A.3.16": (_h_macd, ["?first_index_shown", "EMA12", "EMA26", "line_12_26", "signal_9", ("signals", "E13"),
                         ("warmup_k", "E13"), ("excluded_by_warmup_1", "E13")]),
    "A.3.17": (_h_emas((12, 26)), ["?first_index_shown", "EMA12", "EMA26"]),
    "A.3.18": (_h_emas((5, 20, 50)), ["EMA5", "EMA20", "EMA50"]),
    "A.3.19": (_h_a319, "special"),
    "A.3.20": (_h_a320, ["EMA5", "C_minus_EMA", "F01_buy", "F01_sell", "warmup_k",
                         "F_value_used_signal_excluded_by_warmup_1_at"]),
    "A.3.21": (_h_f02, "all"),
    "A.3.22": (_h_f02, "all"),
    "A.3.24": (_h_a324, ["TR", "ATR14", "SMA5_ATR14"]),
    "A.3.25": (_h_a325, ["RSI14"]),
    "A.3.28": (_h_a328_f02, [("filters_at_signals", "F02_slope"), ("trials", "E02.F02"), ("trials", "E02.F02r")]),
    "A.3.29": (_h_a329, "all"),
    "A.3.30": (_h_a330, ["first_index_shown", "EMA50", "EMA200", "C_minus_EMA200", "ATR14", "SMA100_ATR14",
                         "first_value_index.EMA50", "first_value_index.EMA200", "first_value_index.SMA100_ATR14",
                         "first_value_index.F02_slope", "F02_g", "F02_slope", "hourly_from_k48",
                         "F02_keep_from_index"]),
    "A.3.31": (_h_sma20, ["first_index_shown", "SMA20"]),
    "A.3.34": (_h_a334, ["TR", "ATR14"]),
    "A.4.1": (_h_don(20, "m15.E26.F00"), "all"),
    "A.4.2": (_h_don(55, None), ["HH", "LL", "target_s"]),
    "A.4.3": (_h_a43, ["TR", "ATR10", "EMA20"]),
    "A.4.4": (_h_a44, "all"),
    "A.4.5": (_h_e30, "all"),
    "A.4.6": (_h_e30, "all"),
    "A.4.7": (_h_e30, "all"),
    "A.4.9": (_h_tr_atr14, ["TR", "ATR14"]),
    "A.4.10": (_h_a410, ["TR15", "ATR14_14"]),
    "A.4.26": (_h_s01, "all"),
    "A.4.27": (_h_s01, "all"),
    "A.4.28": (_h_s02("hour_bars"), "all"),
    "A.4.29": (_h_rsi14_ud, ["U", "D", "RSI14"]),
    "A.4.30": (_h_rsi14_ud, ["U", "D", "RSI14"]),
    "A.4.32": (_h_b06, "all"),
    "A.4.33": (_h_b06, "all"),
    "A.4.34": (_h_b06, "all"),
    "A.4.36": (_h_b06, "all"),
    "A.4.37": (_h_s02("four_hour_bars"), "all"),
    "A.4.40": (_h_b06, "all"),
    "A.4.41": (_h_s01, "all"),
}

# Why a key that is not required is skipped (design 9: "skip (not built: E07)"). id -> {path tuple: reason}; "*" is
# the example's default reason. Keys not listed say "not required in the trial".
HAND_SKIP_WHY = {
    "A.3.14": {("line_5_35",): "not built: E14", ("signal_5",): "not built: E14",
               ("signal_5_seed_index",): "not built: E14", ("signals", "E14"): "not built: E14",
               ("signals", "E15"): "not built: E15"},
    "A.3.15": {("signals", "E15"): "not built: E15"},
    "A.3.16": {("signals", "E15"): "not built: E15"},
    "A.3.28": {"*": "not built: E02 (A.3.28's F02 / F02r keys only are required)"},
    "A.3.30": {("signals",): "not built: E18, E21", ("filters_at_signal_bars",): "not built: E18, E21",
               ("trials",): "not built: E18, E21", ("first_value_index", "ADX14"): "not built: F03"},
}

# Alternative answers compared under a plant, for information only (py-design 7): plant -> {id: [(expect key,
# computed key)]}.
_PLANT_INFO = {
    "smaNewestFirst": {"A.3.2": [("SMA20_newest_first_MISREADING", "SMA20")],
                       "A.3.31": [("SMA20_newest_first_MISREADING", "SMA20")]},
}


def _is_alt(key):
    k = str(key)
    return ("MISREADING" in k or "misreading" in k or k.startswith("variant_") or k.endswith("_note")
            or k in ("note", "tolerance_rel"))


def _num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _cmp(exp, got, leaf, ln_keys, where):
    """None when equal (spec 17.2 / py-design 7 rules), else a short reason."""
    if exp is None:
        if got is None or (isinstance(got, float) and got != got):
            return None
        return "%s: expected null, got %r" % (where, got)
    if isinstance(exp, bool):
        if isinstance(got, bool) and got == exp:
            return None
        return "%s: expected %r, got %r" % (where, exp, got)
    if _num(exp):
        if not _num(got) or (isinstance(got, float) and got != got):
            return "%s: expected %r, got %r" % (where, exp, got)
        if leaf in ln_keys:
            if exp == got or abs(exp - got) <= 1e-9 * max(abs(exp), abs(got)):
                return None
            return "%s: expected %r, got %r (relative 1e-9)" % (where, exp, got)
        if exp == got:
            return None
        return "%s: expected %r, got %r" % (where, exp, got)
    if isinstance(exp, str):
        return None if got == exp else "%s: expected %r, got %r" % (where, exp, got)
    if isinstance(exp, list):
        if not isinstance(got, (list, tuple)):
            return "%s: expected a list, got %r" % (where, type(got).__name__)
        if len(exp) != len(got):
            return "%s: expected %d items, got %d" % (where, len(exp), len(got))
        for k, (e, g) in enumerate(zip(exp, got)):
            why = _cmp(e, g, leaf, ln_keys, "%s[%d]" % (where, k))
            if why:
                return why
        return None
    if isinstance(exp, dict):
        if not isinstance(got, dict):
            return "%s: expected an object, got %r" % (where, type(got).__name__)
        for k, e in exp.items():
            if _is_alt(k):
                continue
            if k not in got:
                return "%s.%s: not computed" % (where, k)
            why = _cmp(e, got[k], k, ln_keys, "%s.%s" % (where, k))
            if why:
                return why
        return None
    return "%s: unsupported expected value %r" % (where, exp)


def _get_path(obj, path):
    """path: a dotted string or a tuple of keys (a tuple for keys that hold a dot, as A.3.28's "E02.F02")."""
    cur = obj
    parts = path.split(".") if isinstance(path, str) else list(path)
    for part in parts:
        if not isinstance(cur, dict) or part not in cur:
            raise KeyError(path)
        cur = cur[part]
    return cur


def _norm_req(q):
    """A required entry -> (optional, path tuple). "?a.b" is required where present (py-design 7)."""
    if isinstance(q, tuple):
        return False, q
    opt = q.startswith("?")
    return opt, tuple((q[1:] if opt else q).split("."))


def _skip_why(hid, path):
    w = HAND_SKIP_WHY.get(hid, {})
    return w.get(path, w.get("*", "not required in the trial"))


# A.3.19's rows: the E row of a built item is required (the E row names its item ids, e.g. "E03・E04（RSI14）"), and
# the F row of a built filter (its id is the label's first token, e.g. "F02・F02r（…）").
def _a319_e_id(label):
    for eid in re.findall(r"E\d\d", str(label)):
        if eid in _E_FIRST_VALUE and ITEMS.get(eid) is not None:
            return eid
    return None


def _a319_f_id(label):
    fid = str(label).split("・")[0].split("（")[0]
    return fid if FILTERS.get(fid) is not None and fid in ("F00", "F01", "F02") else None


def _key_bars_view(got, exp_list):
    """A.4.40's key_bars: the computed rows of the expected bars, in the expected order."""
    by_i = got["_key_bars_by_i"]
    return [by_i[e["i"]] if 0 <= e["i"] < len(by_i) else None for e in exp_list]


def _run_one(ex, plant):
    hid = ex["id"]
    fn, req = HAND_TABLE[hid]
    keys = []
    try:
        got = fn(ex, plant)
    except Exception as err:  # a required key that cannot be computed is a failure
        return {"id": hid, "status": "fail", "keys": [{"key": "*", "status": "fail",
                                                        "why": "%s: %s" % (type(err).__name__, err)}]}
    exp = ex["expect"]
    if hid in ("A.4.32", "A.4.33", "A.4.34", "A.4.36", "A.4.40"):
        ln_keys = _LN_KEYS
    else:
        ln_keys = ()
    if req == "special":       # A.3.19: the E rows of built items (E04, E13), the F rows of F00, F01, F02, and F02's g
        for kind, rows in (("E", exp["E"]), ("F", exp["F"])):
            for r in rows:
                name = r["item"] if kind == "E" else r["filter"]
                rid = _a319_e_id(name) if kind == "E" else _a319_f_id(name)
                if rid is None:
                    keys.append({"key": "%s %s" % (kind, name), "status": "skip", "why": "not built: %s" % name})
                    continue
                mine = got["_E_rows"][rid] if kind == "E" else got["_F_rows"][rid]
                for k, v in r.items():
                    if k in ("item", "filter") or _is_alt(k):
                        continue
                    if k == "table":
                        ev = _table_k(v)
                        why = None if ev == mine["table"] else "expected k %r from %r, got %r" % (ev, v, mine["table"])
                    else:
                        why = _cmp(v, mine.get(k), k, (), k) if k in mine else "not computed"
                    keys.append({"key": "%s %s.%s" % (kind, name, k), "status": "fail" if why else "pass",
                                 "why": why or ""})
        for k in exp:
            if k in ("E", "F"):
                continue
            if k == "F02_used_higher_bar_g_at":
                why = _cmp(exp[k], got.get(k), k, (), k)
                keys.append({"key": k, "status": "fail" if why else "pass", "why": why or ""})
            else:
                keys.append({"key": k, "status": "skip", "why": _skip_why(hid, (k,))})
    else:
        if req == "all":
            req_paths = [(k,) for k in exp if not _is_alt(k)]
        else:
            # "?path" is required where present (py-design 7: "first_index_shown (where present)")
            req_paths = []
            for q in req:
                opt, p = _norm_req(q)
                if opt and p[0] not in exp:
                    continue
                req_paths.append(p)
        for path in req_paths:
            label = ".".join(path)
            try:
                e = _get_path(exp, path)
            except KeyError:
                keys.append({"key": label, "status": "fail", "why": "not in the example's expect"})
                continue
            if path == ("key_bars",):
                g = _key_bars_view(got, e)
            else:
                try:
                    g = _get_path(got, path)
                except KeyError:
                    keys.append({"key": label, "status": "fail", "why": "not computed"})
                    continue
            why = _cmp(e, g, path[-1], ln_keys, label)
            keys.append({"key": label, "status": "fail" if why else "pass", "why": why or ""})
        listed = set(p[0] for p in req_paths)
        for k in exp:
            if k not in listed:
                keys.append({"key": k, "status": "skip", "why": "alternative answer" if _is_alt(k)
                             else _skip_why(hid, (k,))})
                continue
            # a key required only in part (signals.E13 of signals): its other parts are skipped, with their reason
            sub = [p for p in req_paths if p[0] == k]
            if all(len(p) > 1 for p in sub) and isinstance(exp[k], dict):
                covered = set(p[1] for p in sub)
                for c in exp[k]:
                    if c not in covered:
                        keys.append({"key": "%s.%s" % (k, c), "status": "skip",
                                     "why": "alternative answer" if _is_alt(c) else _skip_why(hid, (k, c))})
    for ek, gk in _PLANT_INFO.get(plant, {}).get(hid, []):
        if ek in exp and gk in got:
            why = _cmp(exp[ek], got[gk], gk, ln_keys, ek)
            keys.append({"key": "info %s" % ek, "status": "info",
                         "why": "matches the plant's answer" if not why else "differs: " + why})
    status = "fail" if any(k["status"] == "fail" for k in keys) else "pass"
    return {"id": hid, "status": status, "keys": keys}


def run_hand(examples, plant=""):
    """Groups 3 and 4 of the hand examples, per py-design 7's coverage table.

    -> list of {"id", "status": "pass" | "fail" | "skip", "keys": [{"key", "status", "why"}]}, one per example of
    groups 3 and 4 (ids "A.3.*", "A.4.*"); examples of other groups are not returned (PY1 runs them).
    """
    out = []   # a PY1 plant changes nothing here
    for ex in examples:
        hid = ex["id"]
        if not (hid.startswith("A.3.") or hid.startswith("A.4.")):
            continue
        if hid not in HAND_TABLE:
            out.append({"id": hid, "status": "skip", "keys": [{"key": "*", "status": "skip",
                                                                "why": "no required key in the trial"}]})
            continue
        out.append(_run_one(ex, plant))
    return out


# ---- the rules files' sha256 (py-design 2)
RULES_SHA256 = {
    "lawsearch-spec.md": "9c9b5dc08c7fc224c4cf41cea49cef509e0409116a0263cea373451db3f00ff9",
    "lawsearch-hand.json": "41d4788084630bb4dbc7f6c0a3a46cce40dd604a76b29358f84bf461f53a1d9a",
    "lawsearch-hand.md": "f51112b57eb3d62df4afadcf3e838bbf51cb54b62942ca095c881d701840bae7",
}

# Which examples a PY2 plant must make fail (py-design 6).
PLANT_MUST_FAIL = {"smaNewestFirst": ["A.3.2", "A.3.31"],
                   "noRisingEdge": ["A.4.1", "A.4.32", "A.4.33", "A.4.34"],
                   "htfOpen": ["A.1.12", "A.1.13"]}


def _main(argv):
    args = list(argv)
    if "--hand" not in args:
        print("usage: python3 -I research/lawsearch_sig.py --hand [--plant NAME]")
        return 2
    plant = ""
    if "--plant" in args:
        k = args.index("--plant")
        if k + 1 >= len(args):
            print("--plant needs a name")
            return 2
        plant = args[k + 1]
        if plant not in PY2_PLANTS:
            print("REFUSED unknown PY2 plant %r (PY2's plants: %s)" % (plant, ", ".join(PY2_PLANTS)))
            return 2
    for name, want in RULES_SHA256.items():
        got = hashlib.sha256((_HERE / name).read_bytes()).hexdigest()
        if got != want:
            print("STOP sha256 of research/%s is %s, not %s" % (name, got, want))
            return 3
    d = json.loads((_HERE / "lawsearch-hand.json").read_text(encoding="utf-8"))
    res = run_hand(d["examples"], plant=plant)
    n = {"pass": 0, "fail": 0, "skip": 0}
    for r in res:
        n[r["status"]] += 1
        line = "%s %s" % (r["status"].upper(), r["id"])
        if r["status"] == "fail":
            bad = [k for k in r["keys"] if k["status"] == "fail"]
            line += "  " + " | ".join("%s: %s" % (k["key"], k["why"]) for k in bad[:3])
        elif r["status"] == "pass":
            line += "  (%d keys)" % len([k for k in r["keys"] if k["status"] == "pass"])
        print(line)
        for k in r["keys"]:
            if k["status"] == "info":
                print("  INFO %s %s" % (k["key"], k["why"]))
    print("SUMMARY groups 3-4 pass=%d fail=%d skip=%d plant=%s" % (n["pass"], n["fail"], n["skip"], plant or "-"))
    if plant:
        must = PLANT_MUST_FAIL.get(plant, [])
        failed = [r["id"] for r in res if r["status"] == "fail"]
        hit = [x for x in must if x in failed]
        if must and all(x.startswith("A.1.") for x in must):
            print("PLANT %s: its examples (%s) are PY1's; run them with lawsearch-check.py --hand --plant %s"
                  % (plant, ", ".join(must), plant))
        else:
            print("PLANT %s: failed %s; must fail one of %s: %s"
                  % (plant, ", ".join(failed) or "none", ", ".join(must), "yes" if hit else "NO"))
    return 4 if n["fail"] else 0


if __name__ == "__main__":
    sys.exit(_main(sys.argv[1:]))
