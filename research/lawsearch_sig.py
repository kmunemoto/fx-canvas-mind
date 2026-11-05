"""法則探し (research/lawsearch-spec.md): the Python half of the signals for the small trial (spec 19 step 3).

PY2 of research/lawsearch-py-design.md: the indicators (spec 3.1, 3.2), the trial's items E04, E26 and B06
(spec 4.1, 4.4, §8.113 C1 and C17 with spec 17.3's substitutions), the filters F00 and F01 (spec 4.2), the state row
S01 (spec 4.3), the events of spec 5, and the higher-timeframe rule of spec 2.

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
    """

    def __init__(self, kind, cond, keep, warmup, columns, dump_columns=()):
        self.kind = kind
        self.cond = cond
        self.keep = keep
        self.warmup = int(warmup)
        self.columns = columns
        self.dump_columns = tuple(dump_columns)


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


# ---- the registry. Keys are the ids of research/ledger/lawsearch-candidates.json; None means "not written yet".
E_IDS = ["E%02d" % k for k in range(1, 45)]
B_IDS = ["B%02d" % k for k in range(1, 19)]
F_IDS = ["F00", "F01", "F01r", "F02", "F02r", "F03", "F03r", "F04", "F04r", "F05", "F05r", "F06", "F06b", "F07",
         "F07r"]
S_TABLE = {"S01": "F01", "S02": "F02", "S03": "F05", "S04": "F07"}   # spec 4.3

ITEMS = {k: None for k in E_IDS + B_IDS}
ITEMS["E04"] = _item_e04
ITEMS["E26"] = _item_e26
ITEMS["B06"] = _item_b06

FILTERS = {k: None for k in F_IDS}
FILTERS["F00"] = _filt_f00
FILTERS["F01"] = _filt_f01

S_BUILT = {"S01"}

# The ind/ column order (lawsearch-dump.md 5): the trial's items in this fixed order, later items appended in the
# table's order (E01..E44, then F, then B).
_IND_FIXED = ["E04", "E26", "F01", "B06"]
IND_ORDER = _IND_FIXED + [k for k in E_IDS + F_IDS + B_IDS if k not in _IND_FIXED]

# Column types for a writer (lawsearch-dump.md 3, 5): real | tri | int | bool.
IND_TYPES = {"RSI14": "real", "RSI14_U": "real", "RSI14_D": "real", "E04_buy": "tri", "E04_sell": "tri",
             "DON20_HH": "real", "DON20_LL": "real", "DON20_s": "int", "EMA200": "real", "F01_buy": "tri",
             "F01_sell": "tri", "BM_r": "real", "BM_ok": "bool", "BM_sigma": "real", "BM_z": "real",
             "B06_buy": "tri", "B06_sell": "tri", "B06_keep": "bool"}


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
    """The F of a state row (spec 4.3): "S01" -> "F01". NotBuilt otherwise."""
    if sid not in S_TABLE:
        raise NotBuilt("unknown state row %r (not an id of the candidates table)" % (sid,))
    if sid not in S_BUILT:
        raise NotBuilt("state row %s is not written yet" % sid)
    return S_TABLE[sid]


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
    if len(parts) == 2 and parts[1] in B_IDS:
        return {"id": trial, "tf": tf, "kind": "B", "e": None, "f": None, "s": None, "b": parts[1]}
    raise NotBuilt("unknown trial id %r" % (trial,))


def trial_built(trial):
    """True when every part of the trial is written (no NotBuilt would be raised)."""
    t = parse_trial(trial)
    try:
        if t["kind"] == "EF":
            return ITEMS[t["e"]] is not None and FILTERS[t["f"]] is not None
        if t["kind"] == "S":
            return FILTERS[s_filter(t["s"])] is not None
        if t["kind"] == "B":
            return ITEMS[t["b"]] is not None
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
               "B06": lambda pr: int(_p(pr, "sigma_window", 288))}     # §8.113 C17: 288 bars
FILTER_WARMUP = {"F00": lambda pr: 0,
                 "F01": lambda pr: int(_p(pr, "ema", 200))}             # EMA200: 200 bars


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


def raw_signals(kind, cond, plant=""):
    """Spec 5 ②, per direction: a bool (2, n) array of raw signals from ①'s condition.

    cross: cond == 1. condition and hold: cond[i] == 1, i >= 1, cond[i-1] == 0, and i is not the first bar where
    cond is not -1. state: cond == 1 (no rising edge, and neither "no signal" bar). Plant "noRisingEdge": condition
    and hold kinds emit every bar where cond is 1.
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
                if n > 1:
                    out[r, 1:] = (c[1:] == 1) & (c[:-1] == 0)
                k = _first_defined(c)
                if k < n:
                    out[r, k] = False
        else:
            raise ValueError("unknown kind %r" % (kind,))
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
    """(kind, cond, keep, item_warmup, FBuilt) of a parsed trial."""
    if t["kind"] == "EF":
        it = item(t["e"], bars, params, answer_knowing=answer_knowing, plant=plant)
        fb = filt(t["f"], bars, params, plant=plant)
        return it.kind, it.cond, it.keep, it.warmup, fb
    if t["kind"] == "S":
        fb = filt(s_filter(t["s"]), bars, params, plant=plant)
        # The S row's condition is F's f itself; ④ applies no further filter (F00).
        none_f = _filt_f00(bars, params)
        return "state", fb.f, None, fb.warmup, FBuilt(none_f.f, 0, fb.warm_ok, {})
    if t["kind"] == "B":
        it = item(t["b"], bars, params, answer_knowing=answer_knowing, plant=plant)
        return it.kind, it.cond, it.keep, it.warmup, _filt_f00(bars, params)
    raise NotBuilt("unknown trial kind %r" % (t["kind"],))


def candidates(trial, bars, params=None, plant="", answer_knowing=False):
    """Every candidate of spec 5 ①-⑤ of one trial on one bars dict.

    -> {"i": int64[], "d": int8[], "status": list of "emit" | "f_none" | "both", "warm": bool[]},
    every bar with a candidate, in bar order, buy before sell.
    ① the condition comes from the item, or from F's f for an S row; ② the raw signal (raw_signals);
    ③ keep == False drops the raw signal, uncounted (the condition is unchanged, so the next bar still compares
    with ①'s value); ④ f == -1 gives f_none, f == 0 drops the signal (not written, not counted), f == 1 keeps it;
    ⑤ two directions left at one bar: both get "both". warm is i >= max(item warm-up, filter warm-up) (an S row: its
    F's), and the filter's warm_ok where it has one.
    """
    t = parse_trial(trial)
    params = params or {}
    kind, cond, keep, iw, fb = _trial_parts(t, bars, params, plant, answer_knowing)
    raw = raw_signals(kind, cond, plant)
    if keep is not None:
        raw = raw & np.asarray(keep, dtype=bool)
    f = np.asarray(fb.f, dtype=np.int8)
    k_warm = max(int(iw), int(fb.warmup))
    rows = []
    for i in np.flatnonzero(raw[0] | raw[1]).tolist():
        for r, d in ((0, 1), (1, -1)):
            if not raw[r, i]:
                continue
            fv = int(f[r, i])
            if fv == 0:
                continue
            rows.append([i, d, "f_none" if fv == -1 else "emit"])
    emit_pos = [k for k, row in enumerate(rows) if row[2] == "emit"]
    drop = both_rule([("", rows[k][0], rows[k][1]) for k in emit_pos])
    for kk in drop:
        rows[emit_pos[kk]][2] = "both"
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
            need.add(t["f"])
        elif t["kind"] == "S":
            need.add(s_filter(t["s"]))
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
    """The bars of a hand example: "start" (bars every step) or explicit "s" (ISO strings)."""
    tf = _tf_norm(inp["tf"])
    mid = inp["mid"]
    if "s" in inp and isinstance(inp["s"], list):
        starts = [_iso_ms(x) for x in inp["s"]]
    else:
        start = inp.get("start", "2024-03-04T00:00:00Z")
        s0 = _iso_ms(start)
        starts = [s0 + k * STEP[tf] for k in range(len(mid))]
    return bars_from_mid(inp["pair"], tf, starts, mid)


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
    m = re.match(r"\s*(\d+)", str(text))
    if m:
        return int(m.group(1))
    if str(text).strip() in ("—", "-", "–"):
        return 0
    return None


def _h_a319(ex, plant):
    bars = _hand_bars(ex["input"])
    it = item("E04", bars)
    k_e04 = trial_warmup("m15.E04.F00")
    e_row = {"first_value_index": _first_finite(it.columns["RSI14"]),
             "first_signal_index": min(_first_defined(it.cond[0]), _first_defined(it.cond[1])),
             "keep_from_index": k_e04, "table": k_e04}
    f00 = filt("F00", bars)
    f01 = filt("F01", bars)
    rows = {"F00": {"first_value_index": min(_first_defined(f00.f[0]), _first_defined(f00.f[1])),
                    "keep_from_index": f00.warmup, "table": f00.warmup},
            "F01": {"first_value_index": min(_first_defined(f01.f[0]), _first_defined(f01.f[1])),
                    "keep_from_index": f01.warmup, "table": f01.warmup}}
    return {"_E04_row": e_row, "_F_rows": rows}


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
    f = ex["expect"]["first_index_shown"]
    C = bars["C"]
    E50 = ema(C, 50)
    E200 = ema(C, 200)
    A = atr(bars["H"], bars["L"], C, 14)
    S = sma(A, 100, plant=plant)
    return {"first_index_shown": f, "EMA50": _flist(E50, f), "EMA200": _flist(E200, f),
            "C_minus_EMA200": _flist(np.asarray(C) - E200, f), "ATR14": _flist(A, f), "SMA100_ATR14": _flist(S, f),
            "first_value_index": {"EMA50": _first_finite(E50), "EMA200": _first_finite(E200),
                                  "SMA100_ATR14": _first_finite(S)}}


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
    "A.3.14": (_h_emas((12, 26, 5, 35)), ["EMA12", "EMA26", "EMA5", "EMA35"]),
    "A.3.15": (_h_emas((12, 26)), ["?first_index_shown", "EMA12", "EMA26"]),
    "A.3.16": (_h_emas((12, 26)), ["?first_index_shown", "EMA12", "EMA26"]),
    "A.3.17": (_h_emas((12, 26)), ["?first_index_shown", "EMA12", "EMA26"]),
    "A.3.18": (_h_emas((5, 20, 50)), ["EMA5", "EMA20", "EMA50"]),
    "A.3.19": (_h_a319, "special"),
    "A.3.20": (_h_a320, ["EMA5", "C_minus_EMA", "F01_buy", "F01_sell", "warmup_k",
                         "F_value_used_signal_excluded_by_warmup_1_at"]),
    "A.3.24": (_h_a324, ["TR", "ATR14", "SMA5_ATR14"]),
    "A.3.25": (_h_a325, ["RSI14"]),
    "A.3.29": (_h_a329, "all"),
    "A.3.30": (_h_a330, ["first_index_shown", "EMA50", "EMA200", "C_minus_EMA200", "ATR14", "SMA100_ATR14",
                         "first_value_index.EMA50", "first_value_index.EMA200", "first_value_index.SMA100_ATR14"]),
    "A.3.31": (_h_sma20, ["first_index_shown", "SMA20"]),
    "A.3.34": (_h_a334, ["TR", "ATR14"]),
    "A.4.1": (_h_don(20, "m15.E26.F00"), "all"),
    "A.4.2": (_h_don(55, None), ["HH", "LL", "target_s"]),
    "A.4.3": (_h_a43, ["TR", "ATR10", "EMA20"]),
    "A.4.9": (_h_tr_atr14, ["TR", "ATR14"]),
    "A.4.10": (_h_a410, ["TR15", "ATR14_14"]),
    "A.4.26": (_h_s01, "all"),
    "A.4.27": (_h_s01, "all"),
    "A.4.29": (_h_rsi14_ud, ["U", "D", "RSI14"]),
    "A.4.30": (_h_rsi14_ud, ["U", "D", "RSI14"]),
    "A.4.32": (_h_b06, "all"),
    "A.4.33": (_h_b06, "all"),
    "A.4.34": (_h_b06, "all"),
    "A.4.36": (_h_b06, "all"),
    "A.4.40": (_h_b06, "all"),
    "A.4.41": (_h_s01, "all"),
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
    cur = obj
    for part in path.split("."):
        if not isinstance(cur, dict) or part not in cur:
            raise KeyError(path)
        cur = cur[part]
    return cur


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
    if req == "special":       # A.3.19: the E row of E04 and the F rows of F00 and F01
        rows = [("E", r) for r in exp["E"] if "E04" in str(r.get("item", ""))]
        rows += [("F", r) for r in exp["F"] if str(r.get("filter", "")).split("・")[0].split("（")[0] in ("F00", "F01")]
        for kind, r in rows:
            name = r["item"] if kind == "E" else r["filter"]
            mine = got["_E04_row"] if kind == "E" else got["_F_rows"][str(r["filter"]).split("・")[0].split("（")[0]]
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
            if k not in ("E", "F"):
                keys.append({"key": k, "status": "skip", "why": "not required in the trial"})
    else:
        if req == "all":
            req_paths = [k for k in exp if not _is_alt(k)]
        else:
            # "?path" is required where present (py-design 7: "first_index_shown (where present)")
            req_paths = [q[1:] for q in req if q.startswith("?") and q[1:].split(".")[0] in exp]
            req_paths += [q for q in req if not q.startswith("?")]
            order = [q.lstrip("?") for q in req]
            req_paths.sort(key=order.index)
        for path in req_paths:
            try:
                e = _get_path(exp, path)
            except KeyError:
                keys.append({"key": path, "status": "fail", "why": "not in the example's expect"})
                continue
            if path == "key_bars":
                g = _key_bars_view(got, e)
            else:
                try:
                    g = _get_path(got, path)
                except KeyError:
                    keys.append({"key": path, "status": "fail", "why": "not computed"})
                    continue
            why = _cmp(e, g, path.split(".")[-1], ln_keys, path)
            keys.append({"key": path, "status": "fail" if why else "pass", "why": why or ""})
        listed = set(p.split(".")[0] for p in req_paths)
        for k in exp:
            if k not in listed:
                keys.append({"key": k, "status": "skip", "why": "alternative answer" if _is_alt(k)
                             else "not required in the trial"})
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
    "lawsearch-spec.md": "df93c55b64d50235a603aede78f96da89f75d15dfe9aef6d8cd33157c6f1e221",
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
