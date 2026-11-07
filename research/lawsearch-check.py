#!/usr/bin/env python3
"""lawsearch-check.py: the independent Python of research/lawsearch-spec.md (spec 17.2), PY1's part.

Small trial (spec 19 step 3): synthetic prices only.

Written only from research/lawsearch-spec.md (with appendix A), research/lawsearch-hand.json/.md,
research/lawsearch-dump.md and research/lawsearch-py-design.md. No TypeScript file was read.

PY1 owns: the bars (spec 2), the exclusions (spec 1, 6), the trades and the blind tables (spec 7, 8.1, 8.8),
every measure and decision (spec 8 to 11, 13), the dump files (lawsearch-dump.md) and the comparator.
PY2 (research/lawsearch_sig.py) owns the indicators, the items, the filters and the events (spec 3 to 5).

Floating point (spec 3.1, 17.2, 21.5): every sum runs oldest first in a Python loop, in the row order of 21.5.
No sum/fsum/np.sum/np.mean/np.std/np.convolve/np.cumsum/pandas on doubles.

Usage:
  python3 -I research/lawsearch-check.py --hand [--plant NAME]
  python3 -I research/lawsearch-check.py --run RUN
  python3 -I research/lawsearch-check.py --compare RUN
Exit codes: 0 ok, 2 refused, 3 spec 2/15 check or STOP, 4 hand example failed, 5 TS-Python difference,
6 a stop of spec 8.5. A compared run with a spec 13 blind-row stop exits 3 unless the comparison gives 6 or 5
(lawsearch-dump.md 10, C3). --run refuses (2) a run whose ts/config.json cut_max is not null or missing (C3);
--compare refuses the same runs with the same message (C4b, E14).
When a failed TS check before stage 2 kept stage 2 closed, report.txt has a `stage 2 not opened: …` line just
before RESULT; it changes neither RESULT nor the exit (C4a, E6).
stage2.csv verdict, failed and label are derived keys: each side's are checked against its own inputs, then the
differing inputs are judged (C4b, E10; lawsearch-dump.md 11.12).
"""

import bisect
import csv
import datetime as _dt
import hashlib
import importlib.util
import json
import math
import os
import pathlib
import re
import statistics
import sys
from decimal import Decimal, ROUND_HALF_EVEN, ROUND_HALF_UP, localcontext

import numpy as np

_HERE = pathlib.Path(__file__).resolve().parent
ROOT = _HERE.parent

# ----------------------------------------------------------------------------------------------------------------
# 0. Rules files (py-design 2): checked by sha256 before any data file is read.
# ----------------------------------------------------------------------------------------------------------------

RULES_SHA256 = {
    "research/lawsearch-spec.md": "9c9b5dc08c7fc224c4cf41cea49cef509e0409116a0263cea373451db3f00ff9",
    "research/lawsearch-hand.json": "41d4788084630bb4dbc7f6c0a3a46cce40dd604a76b29358f84bf461f53a1d9a",
    "research/lawsearch-hand.md": "f51112b57eb3d62df4afadcf3e838bbf51cb54b62942ca095c881d701840bae7",
    "research/ledger/lawsearch-candidates.json": "92adb97481cf5a7cc7b17a4a31d06da638c2d30246951a6c51b564e7018fdeab",
    "research/ledger/spread-hours-h1.csv": "2e5a8892d306bc9a9b183f32bddf1a3d7473f741b07e96b332b91e365ea6ce3a",
}


class Stop(Exception):
    """A stop: a spec 2 or 15 check failed, or a program error the spec says must stop (exit 3)."""


class Refused(Exception):
    """A refused run (exit 2): no manifest.json, a folder under research/.cache, or a plant given to --run."""


class NotBuilt(Exception):
    """An item, filter or trial of the registry that is not written yet (fails loudly)."""


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            b = f.read(1 << 20)
            if not b:
                break
            h.update(b)
    return h.hexdigest()


def check_rules_files():
    bad = []
    for rel, want in RULES_SHA256.items():
        p = ROOT / rel
        try:
            got = sha256_file(p)
        except OSError as e:
            bad.append(f"{rel}: cannot read ({e})")
            continue
        if got != want:
            bad.append(f"{rel}: sha256 {got} != {want}")
    if bad:
        raise Stop("rules files differ: " + "; ".join(bad))


# ----------------------------------------------------------------------------------------------------------------
# 1. PY2 (loaded by its path, python3 -I does not put this folder on sys.path)
# ----------------------------------------------------------------------------------------------------------------

_SIG = None


def load_sig():
    global _SIG
    if _SIG is None:
        path = _HERE / "lawsearch_sig.py"
        if not path.exists():
            raise NotBuilt(f"PY2 not found: {path}")
        spec = importlib.util.spec_from_file_location("lawsearch_sig", path)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        _SIG = mod
    return _SIG


# ----------------------------------------------------------------------------------------------------------------
# 2. Constants (spec 1, 2)
# ----------------------------------------------------------------------------------------------------------------

PAIRS = ["USD/JPY", "EUR/JPY", "AUD/JPY", "EUR/USD", "AUD/USD"]
SYMS = ["USD_JPY", "EUR_JPY", "AUD_JPY", "EUR_USD", "AUD_USD"]
PAIR_INDEX = {p: k for k, p in enumerate(PAIRS)}
SYM_OF = dict(zip(PAIRS, SYMS))
PAIR_OF_SYM = dict(zip(SYMS, PAIRS))
DIGITS = {"USD/JPY": 3, "EUR/JPY": 3, "AUD/JPY": 3, "EUR/USD": 5, "AUD/USD": 5}
MULT = {p: (1000 if DIGITS[p] == 3 else 100000) for p in PAIRS}
QUANT = {3: Decimal("0.001"), 5: Decimal("0.00001")}
# synthetic walk starts (spec 14.1) for the 0.25-2.5 band of spec 15
WALK_START = {"USD/JPY": 110.0, "EUR/JPY": 125.0, "AUD/JPY": 80.0, "EUR/USD": 1.1, "AUD/USD": 0.7}
# real-data bands of spec 15 (not used by the small trial)
REAL_BAND = {"USD/JPY": (100.0, 200.0), "EUR/JPY": (100.0, 220.0), "AUD/JPY": (60.0, 140.0),
             "EUR/USD": (0.85, 1.45), "AUD/USD": (0.50, 0.90)}

MIN = 60000
HOUR = 3600000
DAY = 86400000
WEEK = 7 * DAY
WEEK_OFFSET = 3 * DAY + 21 * HOUR  # 334800000: weeks start Sunday 21:00 UTC (spec 1)

TFS = ["m15", "h1"]
STEP = {"m15": 900000, "h1": 3600000, "h4": 14400000}
HTF_OF = {"m15": "h1", "h1": "h4"}
INTERVAL = {"m15": "15min", "h1": "1hour"}
TF_OF_LEDGER = {"15min": "m15", "1hour": "h1"}
N_HOLD = 8  # spec 7, question 1 (a)


def _utc_ms(y, mo, d, h=0, mi=0):
    return int((_dt.datetime(y, mo, d, h, mi, tzinfo=_dt.timezone.utc)
                - _dt.datetime(1970, 1, 1, tzinfo=_dt.timezone.utc)).total_seconds()) * 1000


S0 = _utc_ms(2023, 10, 27)
START = _utc_ms(2024, 1, 1)
SPLIT = _utc_ms(2025, 5, 19)
END = _utc_ms(2026, 10, 31)
W0_FIRST = 2817
W0_SECOND = 2889
FIRST_LAST_WEEK = 2888
C6_A = (2889, 2926)
C6_B = (2927, 2964)
HALF_WEEKS = {"first": 72, "second": 76}

REASON_CODES = ["counted", "f_none", "both", "r1", "r1w", "r1b", "r2", "r3", "r4", "r5", "r6"]

# ----------------------------------------------------------------------------------------------------------------
# 3. Clock and calendar (spec 1, 2, 6)
# ----------------------------------------------------------------------------------------------------------------

_EPOCH_DATE = _dt.date(1970, 1, 1)


def ms_of(iso):
    """'2024-03-06T10:00:00Z' or '...:59.999Z' -> UTC ms."""
    s = iso.strip()
    if s.endswith("Z"):
        s = s[:-1]
    if "." in s:
        main, frac = s.split(".")
        frac = (frac + "000")[:3]
    else:
        main, frac = s, "000"
    dt = _dt.datetime.strptime(main, "%Y-%m-%dT%H:%M:%S").replace(tzinfo=_dt.timezone.utc)
    return int(dt.timestamp()) * 1000 + int(frac)


def iso_of(t):
    dt = _dt.datetime(1970, 1, 1, tzinfo=_dt.timezone.utc) + _dt.timedelta(milliseconds=int(t))
    if t % 1000:
        return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{t % 1000:03d}Z"
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def date_of(t):
    return _EPOCH_DATE + _dt.timedelta(days=t // DAY)


def ymd(date):
    return date.year * 10000 + date.month * 100 + date.day


def ymd_str(n):
    return f"{n // 10000:04d}-{n // 100 % 100:02d}-{n % 100:02d}"


def day_start(t):
    return t - t % DAY


def dow(t):
    """UTC weekday, 0 = Sunday ... 6 = Saturday."""
    return (t // DAY + 4) % 7


def tod(t):
    return t % DAY


def wk(t):
    return (t - WEEK_OFFSET) // WEEK


def is_market_closed(t):
    """isMarketClosed (spec 2): Saturday; Friday from 22:00; Sunday before 21:00 (UTC)."""
    d = dow(t)
    x = tod(t)
    return d == 6 or (d == 5 and x >= 22 * HOUR) or (d == 0 and x < 21 * HOUR)


def is_possibly_closed(t):
    """isPossiblyClosed (spec 6 (2)): Friday from 21:00; Saturday; Sunday before 22:00 (UTC)."""
    d = dow(t)
    x = tod(t)
    return d == 6 or (d == 5 and x >= 21 * HOUR) or (d == 0 and x < 22 * HOUR)


def bar_inside_closure(s, step):
    return is_market_closed(s) and is_market_closed(s + step - 1)


def is_holiday(t):
    """GMO holiday (spec 2): the UTC date of t + 3 h is 12-25 or 01-01 (no Saturday rule)."""
    d = date_of(t + 3 * HOUR)
    return (d.month == 12 and d.day == 25) or (d.month == 1 and d.day == 1)


def day_D(t, plant=""):
    """D(t) (spec 2): the UTC date of t + 3 h; a Saturday becomes the Friday before. YYYYMMDD."""
    d = date_of(t + 3 * HOUR)
    if plant != "daySatSplit" and d.weekday() == 5:
        d = d - _dt.timedelta(days=1)
    return ymd(d)


def _nth_sunday(year, month, n):
    d = _dt.date(year, month, 1)
    first = d + _dt.timedelta(days=(6 - d.weekday()) % 7)
    return first + _dt.timedelta(days=7 * (n - 1))


def _last_sunday(year, month):
    if month == 12:
        nxt = _dt.date(year + 1, 1, 1)
    else:
        nxt = _dt.date(year, month + 1, 1)
    last = nxt - _dt.timedelta(days=1)
    return last - _dt.timedelta(days=(last.weekday() + 1) % 7)


_DST_CACHE = {}


def _dst_bounds(year):
    b = _DST_CACHE.get(year)
    if b is None:
        def at(d, h):
            return _utc_ms(d.year, d.month, d.day, h)
        ny = (at(_nth_sunday(year, 3, 2), 7), at(_nth_sunday(year, 11, 1), 6))
        lon = (at(_last_sunday(year, 3), 1), at(_last_sunday(year, 10), 1))
        b = (ny, lon)
        _DST_CACHE[year] = b
    return b


def ny_summer(t):
    ny, _ = _dst_bounds(date_of(t).year)
    return ny[0] <= t < ny[1]


def london_summer(t):
    _, lon = _dst_bounds(date_of(t).year)
    return lon[0] <= t < lon[1]


def season_group(t):
    """0 both winter, 1 both summer, 2 New York only summer, 3 London only summer (spec 2, 8.2)."""
    ny = ny_summer(t)
    lo = london_summer(t)
    if ny and lo:
        return 1
    if ny:
        return 2
    if lo:
        return 3
    return 0


SEASON_JP = {0: "両方冬", 1: "両方夏", 2: "NYだけ夏", 3: "ロンドンだけ夏"}


def ny_season_name(t):
    return "summer" if ny_summer(t) else "winter"


def slot_of(t):
    return tod(t) // (15 * MIN)


def utc_hour(t):
    return tod(t) // HOUR


def first_friday_2100(t):
    """The first Friday 21:00 UTC at or after t (spec 6 (4))."""
    ds = day_start(t)
    c = ds + ((5 - dow(t)) % 7) * DAY + 21 * HOUR
    if c < t:
        c += WEEK
    return c


def _holiday_windows(lo_t, hi_t):
    """GMO holiday windows [day before 21:00, day 21:00) that may meet [lo_t, hi_t)."""
    out = []
    for y in range(date_of(lo_t).year - 1, date_of(hi_t).year + 2):
        for (mo, dd) in ((1, 1), (12, 25)):
            h_end = _utc_ms(y, mo, dd, 21)
            out.append((h_end - DAY, h_end))
    return out


def meets_r4(T, X):
    """(4): [T, X) holds a Friday 21:00 UTC, or meets a GMO holiday [day before 21:00, day 21:00)."""
    if X > first_friday_2100(T):
        return True
    for (a, b) in _holiday_windows(T, X):
        if T < b and X > a:
            return True
    return False


def meets_r2(T):
    return is_possibly_closed(T) and is_possibly_closed(T + MIN) and is_possibly_closed(T + 3 * MIN)


def meets_r5(T):
    """(5): T in (Sunday 21:00, Monday 00:00], or in (a holiday's day 21:00, the next 00:00]."""
    d = dow(T)
    x = tod(T)
    if (d == 0 and x > 21 * HOUR) or (d == 1 and x == 0):
        return True
    dt = date_of(T)
    if x > 21 * HOUR and ((dt.month == 12 and dt.day == 25) or (dt.month == 1 and dt.day == 1)):
        return True
    if x == 0:
        pv = dt - _dt.timedelta(days=1)
        if (pv.month == 12 and pv.day == 25) or (pv.month == 1 and pv.day == 1):
            return True
    return False


def half_of(T, X, plant=""):
    """spec 1 half: 'first', 'second', '1b' (①b) or '1' (①)."""
    split = SPLIT + WEEK if plant == "splitShift" else SPLIT
    last_first_week = FIRST_LAST_WEEK + 1 if plant == "splitShift" else FIRST_LAST_WEEK
    if START <= T and wk(T) <= last_first_week and X <= split:
        return "first"
    if T >= split and X <= END:
        return "second"
    if START <= T < split:
        return "1b"
    return "1"


# ----------------------------------------------------------------------------------------------------------------
# 4. t distribution (spec 8.5): U(x, nu) = 1/2 I_{nu/(nu+x^2)}(nu/2, 1/2), closed forms for integer nu in Decimal
# ----------------------------------------------------------------------------------------------------------------

_PI_CACHE = {}


def _dec_atan_small(y, prec):
    # Taylor series for |y| <= 0.25
    with localcontext() as ctx:
        ctx.prec = prec + 10
        y2 = y * y
        term = y
        s = y
        k = 1
        eps = Decimal(10) ** (-(prec + 8))
        while True:
            term = -term * y2
            add = term / (2 * k + 1)
            if abs(add) < eps:
                break
            s += add
            k += 1
        return s


def _dec_pi(prec):
    p = _PI_CACHE.get(prec)
    if p is None:
        with localcontext() as ctx:
            ctx.prec = prec + 10
            p = 16 * _dec_atan_small(Decimal(1) / 5, prec + 5) - 4 * _dec_atan_small(Decimal(1) / 239, prec + 5)
        _PI_CACHE[prec] = p
    return p


def _dec_atan(y, prec):
    """atan(y) for y >= 0 in Decimal."""
    with localcontext() as ctx:
        ctx.prec = prec + 10
        if y > 1:
            return _dec_pi(prec) / 2 - _dec_atan(1 / y, prec)
        # halve the angle twice: atan(y) = 2 atan(y / (1 + sqrt(1 + y^2)))
        mult = 1
        while y > Decimal("0.25"):
            y = y / (1 + (1 + y * y).sqrt())
            mult *= 2
        return mult * _dec_atan_small(y, prec)


def _U_dec_at(x, nu, prec):
    """Upper tail P(T > x), x >= 0, as a Decimal computed with prec digits."""
    with localcontext() as ctx:
        ctx.prec = prec
        X = Decimal(x)
        V = Decimal(nu)
        r = V + X * X
        c2 = V / r                      # cos^2 theta
        sin_t = X / r.sqrt()            # sin theta
        if nu % 2 == 0:
            term = Decimal(1)
            s = term
            for j in range(1, nu // 2):
                term = term * c2 * (2 * j - 1) / (2 * j)
                s += term
            A = sin_t * s
        else:
            pi = _dec_pi(prec)
            theta = _dec_atan(X / V.sqrt(), prec)
            if nu == 1:
                A = 2 * theta / pi
            else:
                cos_t = V.sqrt() / r.sqrt()
                term = Decimal(1)
                s = term
                for j in range(1, (nu - 3) // 2 + 1):
                    term = term * c2 * (2 * j) / (2 * j + 1)
                    s += term
                A = 2 * (theta + sin_t * cos_t * s) / pi
        return (1 - A) / 2


_U_CACHE = {}


def U_dec(x, nu):
    """U(x, nu) for x >= 0 with relative error far below 1e-12 (adaptive Decimal precision)."""
    key = (x, nu)
    v = _U_CACHE.get(key)
    if v is not None:
        return v
    prec = 80
    while True:
        v = _U_dec_at(x, nu, prec)
        if v > 0 and v.adjusted() > -(prec - 30):
            break
        if prec >= 4000:
            break
        prec *= 2
    _U_CACHE[key] = v
    return v


def t_pvalue(x, nu):
    """One-sided p = 1 - T(x, nu): x >= 0 gives U(x, nu) directly; x < 0 gives 1 - U(-x, nu) (spec 8.5)."""
    if x >= 0:
        return float(U_dec(x, nu))
    with localcontext() as ctx:
        ctx.prec = 80
        return float(1 - U_dec(-x, nu))


def t_cdf_dec(x, nu):
    """T(x, nu) as a Decimal: 1 - U(x, nu) for x >= 0, U(-x, nu) for x < 0."""
    with localcontext() as ctx:
        ctx.prec = 100
        if x >= 0:
            return 1 - U_dec(x, nu)
        return +U_dec(-x, nu)


_Q_CACHE = {}


def t_quantile(q, nu):
    """t(q, nu) by the bisection of spec 8.5 (lo 0, hi 1, double hi while T(hi) < q; halve while hi - lo > 1e-12)."""
    key = (q, nu)
    v = _Q_CACHE.get(key)
    if v is not None:
        return v
    dq = Decimal(q)
    lo = 0.0
    hi = 1.0
    while t_cdf_dec(hi, nu) < dq:
        hi = hi * 2
    it = 0
    while hi - lo > 1e-12 and it < 200:
        m = (lo + hi) / 2
        if t_cdf_dec(m, nu) < dq:
            lo = m
        else:
            hi = m
        it += 1
    v = (lo + hi) / 2
    _Q_CACHE[key] = v
    return v


def sd_two_pass(vals):
    """Two-pass standard deviation divided by (n - 1), sums oldest first (spec 3.1, 8.5)."""
    n = len(vals)
    s = 0.0
    for v in vals:
        s = s + v
    mean = s / n
    ss = 0.0
    for v in vals:
        dv = v - mean
        ss = ss + dv * dv
    return math.sqrt(ss / (n - 1))


def is_zero(x):
    """spec 8.5: |x| < 1e-12 counts as 0 for the numbers of spec 8."""
    return abs(x) < 1e-12


def gt0(x):
    return x is not None and not (isinstance(x, float) and math.isnan(x)) and not is_zero(x) and x > 0


def le0(x):
    return x is not None and not (isinstance(x, float) and math.isnan(x)) and (is_zero(x) or x < 0)


def lt0(x):
    return x is not None and not (isinstance(x, float) and math.isnan(x)) and not is_zero(x) and x < 0


def isnum(x):
    return x is not None and not (isinstance(x, float) and math.isnan(x))


# ----------------------------------------------------------------------------------------------------------------
# 5. GMO day files (spec 2 "ファイルの形と値の読み方", 21.5)
# ----------------------------------------------------------------------------------------------------------------

_TIME_RE = re.compile(r"[0-9]+")
_PRICE_RE = re.compile(r"[0-9]*\.?[0-9]*")
_JS_WS = ("\u0009\u000a\u000b\u000c\u000d   "
          + "".join(chr(c) for c in range(0x2000, 0x200B))
          + "    　﻿")
_JS_DEC_RE = re.compile(r"[+-]?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][+-]?[0-9]+)?")
_JS_RADIX = [(re.compile(r"0[xX]([0-9a-fA-F]+)"), 16), (re.compile(r"0[oO]([0-7]+)"), 8),
             (re.compile(r"0[bB]([01]+)"), 2)]


def _int_to_float(n):
    try:
        return float(n)
    except OverflowError:
        return math.inf if n > 0 else -math.inf


def js_number(s):
    """JavaScript's Number(string) (py-design 5.1)."""
    t = s.strip(_JS_WS)
    if t == "":
        return 0.0
    if t in ("Infinity", "+Infinity"):
        return math.inf
    if t == "-Infinity":
        return -math.inf
    for rx, base in _JS_RADIX:
        m = rx.fullmatch(t)
        if m:
            return _int_to_float(int(m.group(1), base))
    if _JS_DEC_RE.fullmatch(t):
        return float(t)
    return math.nan


def parse_klines_value(v):
    """How parseKlines reads a JSON value: a JSON number as is, a string by Number(), anything else NaN."""
    if isinstance(v, bool) or v is None or isinstance(v, (list, dict)):
        return math.nan
    if isinstance(v, int):
        return _int_to_float(v)
    if isinstance(v, float):
        return v
    if isinstance(v, str):
        return js_number(v)
    return math.nan


def read_field(v, is_time):
    """-> ('ok', value) | ('drop', None) | ('stop', value): spec 2's value forms, checked one value at a time."""
    if isinstance(v, str):
        if is_time:
            right = _TIME_RE.fullmatch(v) is not None
        else:
            right = _PRICE_RE.fullmatch(v) is not None and any("0" <= ch <= "9" for ch in v)
        if right:
            x = float(v)
            if math.isfinite(x):
                return ("ok", x)
            return ("drop", None)
    num = parse_klines_value(v)
    if math.isfinite(num):
        return ("stop", num)
    return ("drop", None)


_FIELDS = ("openTime", "open", "high", "low", "close")
_MISSING = object()


def parse_day_rows(data):
    """data list of one day file -> (rows, unparseable, stop_values). rows: (s, o, h, l, c) in data order."""
    rows = []
    bad = 0
    stops = 0
    for el in data:
        if not isinstance(el, dict):
            bad += 1
            continue
        vals = []
        row_ok = True
        for k, name in enumerate(_FIELDS):
            v = el.get(name, _MISSING)
            if v is _MISSING:
                kind, x = ("drop", None)
            else:
                kind, x = read_field(v, k == 0)
            if kind == "stop":
                stops += 1
                row_ok = False
            elif kind == "drop":
                row_ok = False
            vals.append(x)
        if not row_ok:
            bad += 1
            continue
        rows.append((int(vals[0]), vals[1], vals[2], vals[3], vals[4]))
    return rows, bad, stops


def _reject_constant(name):
    raise ValueError(f"JSON constant {name} is not JSON")


def parse_day_text(raw_bytes):
    """-> (ok, data list). Not JSON, or not {status 0|404, data list}: a read failure."""
    try:
        text = raw_bytes.decode("utf-8")
        obj = json.loads(text, parse_constant=_reject_constant)
    except (ValueError, UnicodeDecodeError):
        return False, None
    return check_day_obj(obj)


def check_day_obj(obj):
    if not isinstance(obj, dict):
        return False, None
    st = obj.get("status", _MISSING)
    if isinstance(st, bool) or not isinstance(st, (int, float)) or st not in (0, 404):
        return False, None
    data = obj.get("data", _MISSING)
    if not isinstance(data, list):
        return False, None
    return True, data


def jst_day_key(t):
    return ymd(date_of(t + 9 * HOUR))


def day_keys(from_ms, to_ms):
    """Every date from jstDayKey(fromMs - 1 day) to jstDayKey(toMs), oldest first."""
    a = jst_day_key(from_ms - DAY)
    b = jst_day_key(to_ms)
    d = _dt.date(a // 10000, a // 100 % 100, a % 100)
    e = _dt.date(b // 10000, b // 100 % 100, b % 100)
    out = []
    while d <= e:
        out.append(ymd(d))
        d = d + _dt.timedelta(days=1)
    return out


def merge_sides(bid_rows, ask_rows):
    """spec 2 mergeSides with loadTf's counts. Rows are (s, o, h, l, c) in file order then row order.

    Returns (merged list of (s, bid_row, ask_row) in start order, dropped, same_start, askbid {year: [num, den]}).
    """
    bids = sorted(bid_rows, key=lambda r: r[0])   # stable
    asks = sorted(ask_rows, key=lambda r: r[0])
    ask_last = {}
    for r in asks:
        ask_last[r[0]] = r
    seen = set()
    made = {}
    order = []
    dropped = 0
    same = 0
    askbid = {}
    for r in bids:
        s = r[0]
        if s in seen:
            same += 1
        seen.add(s)
        a = ask_last.get(s)
        if a is not None:
            y = date_of(s).year
            nd = askbid.setdefault(y, [0, 0])
            nd[1] += 1
            if a[4] < r[4]:
                dropped += 1
                nd[0] += 1
        if s in made:
            continue
        if a is None or a[4] < r[4]:
            continue
        made[s] = (s, r, a)
        order.append(s)
    return [made[s] for s in order], dropped, same, askbid


_MID_CACHE = {}


def mid_of(b, a, d, plant=""):
    """spec 2 mid: v = (bid + ask) / 2 as a double; its exact value rounded to d decimals, half up."""
    key = (b, a, d, plant)
    r = _MID_CACHE.get(key)
    if r is None:
        v = (b + a) / 2
        dv = Decimal(str(v)) if plant == "midDecimalStr" else Decimal(v)
        rnd = ROUND_HALF_EVEN if plant == "midHalfEven" else ROUND_HALF_UP
        r = float(dv.quantize(QUANT[d], rounding=rnd))
        if len(_MID_CACHE) > 2000000:
            _MID_CACHE.clear()
        _MID_CACHE[key] = r
    return r


def to_points(x, mult, plant=""):
    if plant == "pointsTrunc":
        return int(x * mult)
    return int(round(x * mult))


def raw_points(x, mult, plant=""):
    """Raw side value -> points; farther than 1e-6 from its whole number of points: a stop (spec 2)."""
    y = x * mult
    p = int(y) if plant == "pointsTrunc" else int(round(y))
    if abs(y - round(y)) > 1e-6:
        raise Stop(f"raw value {x!r} is {y!r} points, not a whole number of points")
    return p


_SIDE_KEYS = ("bo", "bh", "bl", "bc", "ao", "ah", "al", "ac")
_MID_KEYS = ("O", "H", "L", "C")
_PT_KEYS = ("Po", "Ph", "Pl", "Pc")
_BPT_KEYS = ("Bo", "Bh", "Bl", "Bc", "Ao", "Ah", "Al", "Ac")


def build_bars(pair, tf, rows, plant="", with_day=True):
    """rows: list of (s, (bo, bh, bl, bc), (ao, ah, al, ac)) in start order -> a bars dict (py-design 3.2)."""
    n = len(rows)
    d = DIGITS[pair]
    mult = MULT[pair]
    step = STEP[tf]
    s = np.array([r[0] for r in rows], dtype=np.int64)
    out = {"pair": pair, "pi": PAIR_INDEX[pair], "tf": tf, "step": step, "n": n, "s": s, "T": s + step}
    side = [[0.0] * n for _ in range(8)]
    mid = [[0.0] * n for _ in range(4)]
    pts = [[0] * n for _ in range(4)]
    bpts = [[0] * n for _ in range(8)]
    for i, (_, b, a) in enumerate(rows):
        for k in range(4):
            side[k][i] = b[k]
            side[4 + k][i] = a[k]
            m = mid_of(b[k], a[k], d, plant)
            mid[k][i] = m
            pts[k][i] = to_points(m, mult, plant)
            bpts[k][i] = raw_points(b[k], mult, plant)
            bpts[4 + k][i] = raw_points(a[k], mult, plant)
    for k, name in enumerate(_SIDE_KEYS):
        out[name] = np.array(side[k], dtype=np.float64)
    for k, name in enumerate(_MID_KEYS):
        out[name] = np.array(mid[k], dtype=np.float64)
    for k, name in enumerate(_PT_KEYS):
        out[name] = np.array(pts[k], dtype=np.int64)
    for k, name in enumerate(_BPT_KEYS):
        out[name] = np.array(bpts[k], dtype=np.int64)
    if with_day:
        out["day"] = np.array([day_D(int(x), plant) for x in s], dtype=np.int64)
    out["htf"] = None
    out["g"] = None
    out["slist"] = [int(x) for x in s]
    return out


def coarsen_rows(bars, hstep):
    """spec 2 上位足: group the base bars on the UTC grid of hstep; each side: first open, last close, max, min."""
    groups = []
    cur = None
    for i in range(bars["n"]):
        s = int(bars["s"][i])
        g = s // hstep * hstep
        b = (bars["bo"][i], bars["bh"][i], bars["bl"][i], bars["bc"][i])
        a = (bars["ao"][i], bars["ah"][i], bars["al"][i], bars["ac"][i])
        if cur is None or cur[0] != g:
            cur = [g, list(b), list(a), 1]
            groups.append(cur)
        else:
            cb, ca = cur[1], cur[2]
            cb[1] = max(cb[1], b[1])
            cb[2] = min(cb[2], b[2])
            cb[3] = b[3]
            ca[1] = max(ca[1], a[1])
            ca[2] = min(ca[2], a[2])
            ca[3] = a[3]
            cur[3] += 1
    return [(g, tuple(b), tuple(a)) for (g, b, a, _) in groups], [c[3] for c in groups]


def attach_htf(bars, plant="", htf_plant=""):
    tf = bars["tf"]
    htf_tf = HTF_OF[tf]
    hstep = STEP[htf_tf]
    rows, nbase = coarsen_rows(bars, hstep)
    h = build_bars(bars["pair"], htf_tf, rows, plant, with_day=True)
    h["n_base"] = nbase
    bars["htf"] = h
    sig = load_sig()
    bars["g"] = np.asarray(sig.htf_index(bars["T"], h["s"], hstep, plant=htf_plant), dtype=np.int64)
    return bars


def side_ohlc_bad(o, h, l, c):
    return not (l <= min(o, c) <= max(o, c) <= h)


def load_tf(gmo_dir, pair, tf, from_ms, to_ms, mode="syn", plant="", fail_hook=None):
    """loadTf of spec 2 over a run's gmo folder. Returns (bars, counts, askbid, stops).

    counts: the columns of load.csv. stops: messages of value stops / raw point stops / spec 15 failures.
    """
    sym = SYM_OF[pair]
    step = STEP[tf]
    keys = day_keys(from_ms, to_ms)
    bid_rows, ask_rows = [], []
    failures = 0
    bad = 0
    stops = 0
    for key in keys:
        for side, sink in (("bid", bid_rows), ("ask", ask_rows)):
            p = os.path.join(gmo_dir, sym, INTERVAL[tf], side, f"{key}.json")
            try:
                with open(p, "rb") as f:
                    raw = f.read()
            except OSError:
                failures += 1
                continue
            ok, data = parse_day_text(raw)
            if not ok:
                failures += 1
                continue
            rows, b, st = parse_day_rows(data)
            bad += b
            stops += st
            sink.extend(rows)
    merged, dropped, same, askbid = merge_sides(bid_rows, ask_rows)
    kept = []
    for (s, b, a) in merged:
        if s < from_ms or s + step > to_ms:
            continue
        if bar_inside_closure(s, step):
            continue
        kept.append((s, b[1:], a[1:]))
    msgs = []
    if failures:
        msgs.append(f"{pair} {tf}: {failures} read failures")
    if stops:
        msgs.append(f"{pair} {tf}: {stops} values of the wrong form that read as finite")
    try:
        bars = build_bars(pair, tf, kept, plant)
    except Stop as e:
        msgs.append(f"{pair} {tf}: {e}")
        bars = None
    ohlc_bad = 0
    band_bad = 0
    lo_band, hi_band = (0.25 * WALK_START[pair], 2.5 * WALK_START[pair]) if mode == "syn" else REAL_BAND[pair]
    for (s, b, a) in kept:
        if side_ohlc_bad(*b) or side_ohlc_bad(*a):
            ohlc_bad += 1
        if any(not (lo_band <= x <= hi_band) for x in b + a):
            band_bad += 1
    dup = len(kept) - len(set(r[0] for r in kept))
    if ohlc_bad:
        msgs.append(f"{pair} {tf}: {ohlc_bad} bars with OHLC out of order")
    if band_bad:
        msgs.append(f"{pair} {tf}: {band_bad} bars outside the price band")
    if dup:
        msgs.append(f"{pair} {tf}: {dup} duplicate starts")
    counts = {
        "from_ms": from_ms, "to_ms": to_ms, "keys_first": str(keys[0]), "keys_last": str(keys[-1]),
        "keys": len(keys), "files_read": 2 * len(keys), "read_failures": failures, "unparseable_rows": bad,
        "value_stops": stops, "dropped_ask_lt_bid": dropped, "same_start_bid_rows": same, "bars": len(kept),
        "first_s": kept[0][0] if kept else None, "last_s": kept[-1][0] if kept else None,
        "ohlc_bad": ohlc_bad, "dup_starts": dup, "band_bad": band_bad,
    }
    for y, (num, den) in sorted(askbid.items()):
        if den and num * 1000 > den:   # share > 0.1%
            msgs.append(f"{pair} {tf} {y}: Ask < Bid share {num}/{den} > 0.1%")
    return bars, counts, askbid, msgs


# ----------------------------------------------------------------------------------------------------------------
# 6. Exclusions (spec 1, 6)
# ----------------------------------------------------------------------------------------------------------------

AVOID_HEADER = ["pair", "season", "slot", "utc", "bars", "median", "mean", "p90", "base", "threshold", "avoid"]


def load_avoid_table(path):
    """research/ledger/spread-hours-h1.csv read strictly (spec 6 (6)): 5 pairs x 2 seasons x 96 slots, once each."""
    with open(path, "r", encoding="utf-8", newline="") as f:
        rows = list(csv.reader(f))
    if not rows or rows[0] != AVOID_HEADER:
        raise Stop("spread-hours-h1.csv: header differs")
    table = {}
    for r in rows[1:]:
        if len(r) != len(AVOID_HEADER):
            raise Stop(f"spread-hours-h1.csv: bad row {r}")
        pair, season, slot, avoid = r[0], r[1], r[2], r[10]
        if pair not in PAIR_INDEX or season not in ("summer", "winter") or avoid not in ("yes", "no"):
            raise Stop(f"spread-hours-h1.csv: bad row {r}")
        if not re.fullmatch(r"[0-9]+", slot) or not (0 <= int(slot) < 96):
            raise Stop(f"spread-hours-h1.csv: bad slot {r}")
        key = (pair, season, int(slot))
        if key in table:
            raise Stop(f"spread-hours-h1.csv: duplicate row {key}")
        table[key] = avoid == "yes"
    if len(table) != 960:
        raise Stop(f"spread-hours-h1.csv: {len(table)} rows, not 960")
    return table


def avoid_table_from_yes(yes_rows):
    """A full 960-row table with avoid = no except the given (pair, season, 'HH:MM') rows (hand examples)."""
    t = {(p, se, k): False for p in PAIRS for se in ("summer", "winter") for k in range(96)}
    for r in yes_rows:
        hh, mm = r["slot"].split(":")
        t[(r["pair"], r["season"], (int(hh) * 60 + int(mm)) // 15)] = r["avoid"] == "yes"
    return t


def meets_r6(pair, T, X, avoid):
    e = (pair, ny_season_name(T), slot_of(T))
    x = (pair, ny_season_name(X - MIN), slot_of(X - MIN))
    return avoid[e] or avoid[x]


def slot_open(a, count_present):
    """spec 6 (3): a slot is open when it is not a (2) time at its start, not a GMO holiday, and >= 3 pairs have a bar."""
    if meets_r2(a):
        return False
    if is_holiday(a):
        return False
    return count_present >= 3


def find_holes(tf, slot_starts, present):
    """present: {pair: set of bar starts}. -> ({pair: sorted hole slot starts}, {slot: open}, holes per pair as runs)."""
    min_len = 2 if tf == "m15" else 1
    opened = {}
    for a in slot_starts:
        c = 0
        for p in PAIRS:
            if a in present.get(p, ()):
                c += 1
        opened[a] = slot_open(a, c)
    holes = {}
    runs = {}
    for p in PAIRS:
        pres = present.get(p, set())
        hs = []
        rs = []
        run = []
        for a in slot_starts:
            if opened[a] and a not in pres:
                run.append(a)
                continue
            if len(run) >= min_len:
                hs.extend(run)
                rs.append((run[0], len(run)))
            run = []
        if len(run) >= min_len:
            hs.extend(run)
            rs.append((run[0], len(run)))
        holes[p] = hs
        runs[p] = rs
    return holes, opened, runs


def r3_hit(hole_list, s_im9, T, step):
    """A hole slot a with a < T and a + step > s_{i-9} (overlap with length; touching does not count)."""
    k = bisect.bisect_right(hole_list, s_im9 - step)
    return k < len(hole_list) and hole_list[k] < T


R_NAME = {"r1": "①", "r1w": "①", "r1b": "①b", "r2": "②", "r3": "③", "r4": "④", "r5": "⑤", "r6": "⑥",
          "counted": "数えた"}


def bar_reasons(T, X, pair, s_im9, hole_list, step, avoid):
    """All of (2)-(6) that hit (for the hand examples' 'hits'), in order."""
    hits = []
    if meets_r2(T):
        hits.append("r2")
    if r3_hit(hole_list, s_im9, T, step):
        hits.append("r3")
    if meets_r4(T, X):
        hits.append("r4")
    if meets_r5(T):
        hits.append("r5")
    if meets_r6(pair, T, X, avoid):
        hits.append("r6")
    return hits


def reason_of(half, warm, bar_hit):
    """First match of spec 6: (1)/(1b) by the half, (1) warm-up, then the first of (2)-(6), else counted."""
    if half == "1":
        return "r1"
    if half == "1b":
        return "r1b"
    if not warm:
        return "r1w"
    if bar_hit:
        return bar_hit
    return "counted"


# ----------------------------------------------------------------------------------------------------------------
# 7. Trades (spec 7) and the blind tables (spec 8.1, 8.8)
# ----------------------------------------------------------------------------------------------------------------

def trade_at(bars, i, T, X, d, plant=""):
    """The trade of a signal at bar i (T, X) in direction d -> dict or None (no entry bar)."""
    s = bars["slist"]
    n = len(s)
    step = bars["step"]
    j = bisect.bisect_left(s, T)
    if j >= n or s[j] >= X:
        return None
    e = bisect.bisect_left(s, X - step)
    if e < n and s[e] == X - step:
        x = e
        subst = 0
    else:
        if plant == "noSubstituteExit":
            return None
        x = bisect.bisect_right(s, X - step) - 1
        subst = 1
    if x < j:
        return None
    if plant == "entryEarly":
        j = j - 1
        if j < 0:
            return None
    if plant == "exitLate":
        x = x + 1
        if x >= n:
            return None
    Po, Pc = bars["Po"], bars["Pc"]
    if plant == "entryAtSignalClose":
        m = d * (int(Pc[x]) - int(Pc[i]))
        if d == 1:
            pl = int(bars["Bc"][x]) - int(bars["Ac"][i])
        else:
            pl = int(bars["Bc"][i]) - int(bars["Ac"][x])
    else:
        m = d * (int(Pc[x]) - int(Po[j]))
        if d == 1:
            pl = int(bars["Bc"][x]) - int(bars["Ao"][j])
        else:
            pl = int(bars["Bo"][j]) - int(bars["Ac"][x])
    h = (m > 0) - (m < 0)
    return {"j": j, "x": x, "subst": subst, "m": m, "h": h, "pl": pl}


def late_trade_at(b15, T, X, d):
    """spec 8.8: on the 15-minute bars, entry the first start in [T + 15 min, X + 15 min); exit the close at
    X + 15 min, else the last bar with start >= s_j and close <= X + 15 min."""
    s = b15["slist"]
    n = len(s)
    step = b15["step"]
    a = T + 15 * MIN
    z = X + 15 * MIN
    j = bisect.bisect_left(s, a)
    if j >= n or s[j] >= z:
        return None
    e = bisect.bisect_left(s, z - step)
    if e < n and s[e] == z - step:
        x = e
        subst = 0
    else:
        x = bisect.bisect_right(s, z - step) - 1
        subst = 1
    if x < j:
        return None
    m = d * (int(b15["Pc"][x]) - int(b15["Po"][j]))
    if d == 1:
        pl = int(b15["Bc"][x]) - int(b15["Ao"][j])
    else:
        pl = int(b15["Bo"][j]) - int(b15["Ac"][x])
    h = (m > 0) - (m < 0)
    return {"j": j, "x": x, "subst": subst, "m": m, "h": h, "pl": pl}


def stratum_id(pi, d, hour, season, plant=""):
    if plant == "blindNoHour":
        hour = 0
    return ((pi * 2 + (0 if d == 1 else 1)) * 24 + hour) * 4 + season


class Table:
    """A blind table (spec 8.1) or a late blind table (spec 8.8): rows in the 21.5 order.

    Each row: pi, pair, i, T, d, j, x, subst, m, h, pl, absm, hour, season, stratum, week (+ base_row for late).
    """

    def __init__(self, rows, w0, plant=""):
        self.rows = rows
        self.n = len(rows)
        self.w0 = w0
        self.plant = plant
        self.key = {}
        for r, row in enumerate(rows):
            self.key[(row["pi"], row["T"], row["d"])] = r
        self.h = [row["h"] for row in rows]
        self.pl = [row["pl"] for row in rows]
        self.absm = [row["absm"] for row in rows]
        self.stratum = [row["stratum"] for row in rows]
        self.week = [row["week"] for row in rows]
        self.T = [row["T"] for row in rows]
        self.pi = [row["pi"] for row in rows]
        self.d = [row["d"] for row in rows]
        self.blk = [(w - w0) // 4 for w in self.week]
        # per-stratum blind statistics, each value halved / divided by 10 first, summed in row order
        sh, sp, sa, cnt = {}, {}, {}, {}
        for r in range(self.n):
            s = self.stratum[r]
            if s not in cnt:
                cnt[s] = 0
                sh[s] = 0.0
                sp[s] = 0.0
                sa[s] = 0.0
            cnt[s] += 1
            sh[s] = sh[s] + self.h[r] / 2
            sp[s] = sp[s] + self.pl[r] / 10
            sa[s] = sa[s] + self.absm[r] / 10
        self.m_s = cnt
        self.B_s = {s: sh[s] / cnt[s] for s in cnt}
        if plant == "noBlind":
            self.B_s = {s: 0.0 for s in cnt}
        self.pl_s = {s: sp[s] / cnt[s] for s in cnt}
        self.absm_s = {s: sa[s] / cnt[s] for s in cnt}
        self.weeks = sorted(set(self.week))
        self.blocks = sorted(set(self.blk))
        self.week_pos = {w: k for k, w in enumerate(self.weeks)}


def make_row(pi, pair, i, T, d, tr, hour_t, week, plant=""):
    hour = utc_hour(hour_t)
    season = season_group(hour_t)
    return {"pi": pi, "pair": pair, "i": i, "T": T, "d": d, "j": tr["j"], "x": tr["x"], "subst": tr["subst"],
            "m": tr["m"], "h": tr["h"], "pl": tr["pl"], "absm": abs(tr["m"]), "hour": hour, "season": season,
            "stratum": stratum_id(pi, d, hour, season, plant), "week": week}


def sort_rows(rows):
    """21.5 row order: T, then pair (table order), then buy before sell (stable)."""
    rows.sort(key=lambda r: (r["T"], r["pi"], 0 if r["d"] == 1 else 1))
    return rows


# ----------------------------------------------------------------------------------------------------------------
# 8. Measures (spec 8, 21.5)
# ----------------------------------------------------------------------------------------------------------------

CAND_ORDER = ("week", "4w", "shift")


def core(tab, sig, plant=""):
    """Strata, Δ, a, PL, W and the explanation numbers of 8.4 for the signal rows sig (sorted table rows)."""
    N = len(sig)
    n_s, sh = {}, {}
    for r in sig:
        s = tab.stratum[r]
        if s not in n_s:
            n_s[s] = 0
            sh[s] = 0.0
        n_s[s] += 1
        sh[s] = sh[s] + tab.h[r] / 2
    mean_s = {s: sh[s] / n_s[s] for s in n_s}
    out = {"N": N, "n_s": n_s, "mean_s": mean_s}
    if N == 0:
        for k in ("delta", "a", "pl", "W", "blind_pl_w", "M", "w_rate", "pl_minus_blind"):
            out[k] = math.nan
        out["w_count"] = 0
        return out
    acc = 0.0
    for s in sorted(n_s):
        acc = acc + (n_s[s] / N) * (mean_s[s] - tab.B_s[s])
    out["delta"] = 100 * acc
    sum_h = 0
    for r in sig:
        sum_h += tab.h[r]
    out["a"] = (100 * (sum_h / N)) / 2
    acc = 0.0
    wc = 0
    for r in sig:
        acc = acc + tab.pl[r] / 10
        if tab.pl[r] > 0:
            wc += 1
    out["pl"] = acc / N
    out["w_count"] = wc
    out["W"] = wc / N
    out["w_rate"] = wc / N
    acc = 0.0
    for s in sorted(n_s):
        acc = acc + (n_s[s] / N) * tab.pl_s[s]
    out["blind_pl_w"] = acc
    out["pl_minus_blind"] = out["pl"] - acc
    acc = 0.0
    for s in sorted(n_s):
        acc = acc + (n_s[s] / N) * tab.absm_s[s]
    out["M"] = acc
    return out


def delta_only(tab, sig):
    """Δ alone (used by the shifts, the extras and C6). nan when N = 0."""
    N = len(sig)
    if N == 0:
        return math.nan
    n_s, sh = {}, {}
    for r in sig:
        s = tab.stratum[r]
        if s not in n_s:
            n_s[s] = 0
            sh[s] = 0.0
        n_s[s] += 1
        sh[s] = sh[s] + tab.h[r] / 2
    acc = 0.0
    for s in sorted(n_s):
        acc = acc + (n_s[s] / N) * (sh[s] / n_s[s] - tab.B_s[s])
    return 100 * acc


def pl_mean(tab, sig):
    if not sig:
        return math.nan
    acc = 0.0
    for r in sig:
        acc = acc + tab.pl[r] / 10
    return acc / len(sig)


def pl_ex1w(tab, sig, plant=""):
    """spec 8.4: weekly sums of PL in points; drop the largest (tie: the oldest); mean of the rest (pips)."""
    if not sig:
        return math.nan, None, 0
    if plant == "noEx1Week":
        return pl_mean(tab, sig), None, len(sig)
    ws = {}
    for r in sig:
        w = tab.week[r]
        ws[w] = ws.get(w, 0) + tab.pl[r]
    best = None
    for w in sorted(ws):
        if best is None or ws[w] > ws[best]:
            best = w
    rest = [r for r in sig if tab.week[r] != best]
    return pl_mean(tab, rest), best, len(rest)


def influences(tab, sig, kind, c=None, plant=""):
    """Influence functions of spec 8.5 -> (sig_psi {row: psi}, blind_psi list or None).

    kind: 'delta' | 'pl' | 'a'. c: the core() of (tab, sig).
    """
    if c is None:
        c = core(tab, sig, plant)
    N = c["N"]
    sig_psi = {}
    if N == 0:
        return sig_psi, None
    if kind == "delta":
        dprime = c["delta"] / 100
        n_s = c["n_s"]
        if plant == "inflStratumMean":
            sd, cnt = {}, {}
            for r in sig:
                s = tab.stratum[r]
                sd[s] = sd.get(s, 0.0) + (tab.h[r] / 2 - tab.B_s[s])
                cnt[s] = cnt.get(s, 0) + 1
            smean = {s: sd[s] / cnt[s] for s in sd}
        for r in sig:
            s = tab.stratum[r]
            di = tab.h[r] / 2 - tab.B_s[s]
            if plant == "inflStratumMean":
                sig_psi[r] = (di - smean[s]) / N
            else:
                sig_psi[r] = (di - dprime) / N
        blind = [0.0] * tab.n
        for r in range(tab.n):
            s = tab.stratum[r]
            ns = n_s.get(s)
            if ns:
                blind[r] = -(ns / N) * (tab.h[r] / 2 - tab.B_s[s]) / tab.m_s[s]
        return sig_psi, blind
    if kind == "pl":
        m = c["pl"]
        for r in sig:
            sig_psi[r] = (tab.pl[r] / 10 - m) / N
        return sig_psi, None
    if kind == "a":
        ap = c["a"] / 100
        for r in sig:
            sig_psi[r] = (tab.h[r] / 2 - ap) / N
        return sig_psi, None
    raise ValueError(kind)


def cluster_sums(tab, sig_psi, blind_psi, kind):
    """S_g in the 21.5 row order (a signal row just before the blind row of the same (T, pair, d))."""
    cl = tab.week if kind == "week" else tab.blk
    S = {}
    for r in range(tab.n):
        g = cl[r]
        acc = S.get(g, 0.0)
        v = sig_psi.get(r)
        if v is not None:
            acc = acc + v
        if blind_psi is not None:
            acc = acc + blind_psi[r]
        S[g] = acc
    return S


def se_of(S, scale):
    C = len(S)
    if C < 2:
        return None, C
    ss = 0.0
    for g in sorted(S):
        ss = ss + S[g] * S[g]
    se = math.sqrt((C / (C - 1)) * ss)
    if scale != 1:
        se = scale * se
    return se, C


def make_cand(value, se, C, df, N, K=None, need_K=False, kappa=1.0):
    """One SE candidate (spec 8.5). No t when C < 2, N = 0, |se| < 1e-12, or (shift) K < 2."""
    c = {"se": se, "C": C, "df": df, "K": K}
    if se is not None and kappa != 1.0:
        se = se * kappa
        c["se"] = se
    ok = (C is not None and C >= 2 and N > 0 and se is not None and not is_zero(se) and isnum(value)
          and df is not None and df >= 1)
    if need_K and (K is None or K < 2):
        ok = False
    c["has_t"] = ok
    if ok:
        t = value / se
        c["t"] = t
        c["p"] = t_pvalue(t, df)
        q = t_quantile(0.975, df)
        c["q975"] = q
        c["half_width"] = q * se
    else:
        c["t"] = None
        c["p"] = 1.0
        c["q975"] = None
        c["half_width"] = None
    return c


def choose(value, cands):
    """cands: ordered dict name -> cand (week, 4w, shift order). spec 8.5's choice."""
    out = {"has_t": all(c["has_t"] for c in cands.values()) and len(cands) > 0,
           "use_lb": None, "use_p": None, "t": None, "p": 1.0, "lb": None, "ub": None}
    if not out["has_t"]:
        return out
    best_w = None
    best_p = None
    for name, c in cands.items():
        if best_w is None or c["half_width"] > cands[best_w]["half_width"]:
            best_w = name
        if best_p is None or c["p"] > cands[best_p]["p"]:
            best_p = name
    out["use_lb"] = best_w
    out["use_p"] = best_p
    hw = cands[best_w]["half_width"]
    out["lb"] = value - hw
    out["ub"] = value + hw
    out["t"] = cands[best_p]["t"]
    out["p"] = cands[best_p]["p"]
    return out


def widest_at(value, cands, q):
    """Interval end at another level (11's simultaneous lower end): the widest t(q, df) x se of the candidates."""
    best = None
    for name, c in cands.items():
        if not c["has_t"]:
            return None, None
        w = t_quantile(q, c["df"]) * c["se"]
        if best is None or w > best[1]:
            best = (name, w)
    if best is None:
        return None, None
    return best[0], best[1]


def shift_runs(tab, sig, kinds, plant=""):
    """spec 8.5 week shift: for k = 1 .. W_h - 1, move each signal to the k-th next week of the table (wrapping).

    Returns a list of (k, n, dropped, {kind: value}) in k order.
    """
    W = tab.weeks
    Wn = len(W)
    pos = tab.week_pos
    out = []
    if Wn < 2 or not sig:
        for k in range(1, Wn):
            out.append((k, 0, len(sig), {kk: None for kk in kinds}))
        return out
    # numpy lookup of (pi, d, T') -> row
    codes = np.array([(tab.T[r] // MIN) * 16 + tab.pi[r] * 2 + (0 if tab.d[r] == 1 else 1) for r in range(tab.n)],
                     dtype=np.int64)
    order = np.argsort(codes, kind="stable")
    codes_sorted = codes[order]
    sig_arr = np.array(sig, dtype=np.int64)
    sw = np.array([tab.week[r] for r in sig], dtype=np.int64)
    spos = np.array([pos[tab.week[r]] for r in sig], dtype=np.int64)
    sbase = np.array([(tab.T[r] // MIN) * 16 + tab.pi[r] * 2 + (0 if tab.d[r] == 1 else 1) for r in sig],
                     dtype=np.int64)
    Warr = np.array(W, dtype=np.int64)
    strata = np.array(tab.stratum, dtype=np.int64)
    harr = np.array(tab.h, dtype=np.int64)
    plv = [x / 10 for x in tab.pl]
    for k in range(1, Wn):
        p = spos + k
        if plant == "shiftNoWrap":
            keep = p < Wn
            p2 = np.where(keep, p, 0)
        else:
            keep = np.ones(len(p), dtype=bool)
            p2 = p % Wn
        w2 = Warr[p2]
        code2 = sbase + (w2 - sw) * (WEEK // MIN) * 16
        idx = np.searchsorted(codes_sorted, code2)
        idx_c = np.minimum(idx, len(codes_sorted) - 1)
        found = keep & (idx < len(codes_sorted)) & (codes_sorted[idx_c] == code2)
        targets = np.sort(order[idx_c[found]])
        n = int(targets.size)
        dropped = len(sig) - n
        vals = {}
        if n == 0:
            for kk in kinds:
                vals[kk] = None
            out.append((k, 0, dropped, vals))
            continue
        tl = targets.tolist()
        if "delta" in kinds:
            st = strata[targets]
            hs = harr[targets]
            uniq, inv = np.unique(st, return_inverse=True)
            ns = np.bincount(inv)
            hsum = np.bincount(inv, weights=hs.astype(np.float64))
            acc = 0.0
            for q in range(len(uniq)):
                s = int(uniq[q])
                nq = int(ns[q])
                mean = (float(hsum[q]) / 2) / nq
                acc = acc + (nq / n) * (mean - tab.B_s[s])
            vals["delta"] = 100 * acc
        if "pl" in kinds:
            acc = 0.0
            for r in tl:
                acc = acc + plv[r]
            vals["pl"] = acc / n
        if "a" in kinds:
            sh = int(harr[targets].sum())   # integer sum: exact in any order
            vals["a"] = (100 * (sh / n)) / 2
        out.append((k, n, dropped, vals))
    return out


def value_block(name, value, N, tab, sig_psi, blind_psi, scale, shift_list, kappa=1.0, with_shift=True,
                four_ok=True):
    """Everything of one value V of measures.csv: clusters, candidates, choice."""
    S_w = cluster_sums(tab, sig_psi, blind_psi, "week")
    S_4 = cluster_sums(tab, sig_psi, blind_psi, "4w")
    se_w, C_w = se_of(S_w, scale)
    se_4, C_4 = se_of(S_4, scale)
    four = four_ok and C_4 >= 10
    cands = {}
    cands["week"] = make_cand(value, se_w, C_w, C_w - 1, N, kappa=kappa)
    if four:
        cands["4w"] = make_cand(value, se_4, C_4, C_4 - 1, N, kappa=kappa)
    sh = None
    if with_shift:
        vals = [v[3][name] for v in shift_list if v[3].get(name) is not None]
        K = len(vals)
        sd = sd_two_pass(vals) if K >= 2 else None
        cands["shift"] = make_cand(value, sd, C_w, C_w - 1, N, K=K, need_K=True, kappa=kappa)
        sh = {"used": K, "skipped": sum(1 for v in shift_list if v[3].get(name) is None), "sd": sd,
              "ks": [(v[0], v[1], v[2], v[3].get(name)) for v in shift_list]}
    ch = choose(value, cands)
    return {"name": name, "value": value, "N": N, "C_week": C_w, "C_4w": C_4, "four": four, "cands": cands,
            "choice": ch, "shift": sh, "kappa": kappa, "S_week": S_w, "S_4w": S_4}


def diff_value_block(value, N, tab, psi_a, psi_b, scale):
    """D_F (spec 8.6): per row the difference of two influence functions, summed per cluster in row order;
    week and 4w (C_4w >= 10); the wider t(0.975) x se wins (ties: week)."""
    sa, ba = psi_a
    sb, bb = psi_b
    rows = set(sa) | set(sb)
    dsig = {r: sa.get(r, 0.0) - sb.get(r, 0.0) for r in rows}
    if ba is None and bb is None:
        dbl = None
    else:
        za = ba if ba is not None else [0.0] * tab.n
        zb = bb if bb is not None else [0.0] * tab.n
        dbl = [za[r] - zb[r] for r in range(tab.n)]
    return value_block("dF", value, N, tab, dsig, dbl, scale, [], with_shift=False)


def nonoverlap(tab, sig, step):
    """21.5: per pair and direction, in T order, drop a signal whose T is before the X of the last kept one."""
    last_x = {}
    kept = []
    for r in sig:
        key = (tab.pi[r], tab.d[r])
        T = tab.T[r]
        lx = last_x.get(key)
        if lx is not None and T < lx:
            continue
        kept.append(r)
        last_x[key] = T + N_HOLD * step
    return kept


def sub_table(tab, keep_row):
    """A table of the rows with keep_row(row) true (stats recomputed), and the old -> new row map."""
    rows = []
    mp = {}
    for r, row in enumerate(tab.rows):
        if keep_row(row):
            mp[r] = len(rows)
            rows.append(row)
    return Table(rows, tab.w0, tab.plant), mp


# ----------------------------------------------------------------------------------------------------------------
# 9. Hand examples, group 1 (A.1.*): dates, bars, exclusions, trades
# ----------------------------------------------------------------------------------------------------------------

HALF_JP = {"first": "前半", "second": "後半", "1": "①", "1b": "①b"}
HANDLERS = {}
HAND_TOL = {}


def hand(eid, tol=None):
    def deco(fn):
        HANDLERS[eid] = fn
        HAND_TOL[eid] = tol or {}
        return fn
    return deco


def tf_of_hand(s):
    return {"15min": "m15", "1hour": "h1", "m15": "m15", "h1": "h1"}[s]


def dec(x, pair):
    return f"{x:.{DIGITS[pair]}f}"


def hand_bars(pair, tf, bars_in, plant=""):
    rows = []
    for b in bars_in:
        rows.append((ms_of(b["s"]), tuple(float(v) for v in b["bid"]), tuple(float(v) for v in b["ask"])))
    rows.sort(key=lambda r: r[0])
    return build_bars(pair, tf, rows, plant)


def bar_view(bars, i, with_sides=True):
    p = bars["pair"]
    out = {"i": i, "s": iso_of(int(bars["s"][i]))}
    if with_sides:
        out["bid"] = [dec(bars[k][i], p) for k in ("bo", "bh", "bl", "bc")]
        out["ask"] = [dec(bars[k][i], p) for k in ("ao", "ah", "al", "ac")]
        out["mid"] = [float(bars[k][i]) for k in _MID_KEYS]
    out["P"] = [int(bars[k][i]) for k in _PT_KEYS]
    out["B"] = [int(bars[k][i]) for k in ("Bo", "Bh", "Bl", "Bc")]
    out["A"] = [int(bars[k][i]) for k in ("Ao", "Ah", "Al", "Ac")]
    return out


@hand("A.1.1")
def _h_a11(ex, plant):
    inp = ex["input"]
    out = {"wk": [wk(ms_of(t)) for t in inp["times"]]}
    out["block4_first"] = [(w - W0_FIRST) // 4 for w in inp["block4_first_wk"]]
    out["block4_second"] = [(w - W0_SECOND) // 4 for w in inp["block4_second_wk"]]
    out["second_half_part"] = [1 if C6_A[0] <= w <= C6_A[1] else (2 if C6_B[0] <= w <= C6_B[1] else None)
                               for w in inp["block4_second_wk"]]
    return out


def _halves(inp, plant):
    X, W, H = [], [], []
    for s in inp["signals"]:
        T = ms_of(s["T"])
        x = T + inp["N"] * STEP[tf_of_hand(s["tf"])]
        X.append(iso_of(x))
        W.append(wk(T))
        H.append(HALF_JP[half_of(T, x, plant)])
    return X, W, H


@hand("A.1.2")
def _h_a12(ex, plant):
    X, W, H = _halves(ex["input"], plant)
    return {"X": X, "wkT": W, "half": H}


@hand("A.1.3")
def _h_a13(ex, plant):
    X, W, H = _halves(ex["input"], plant)
    return {"X": X, "wkT": W, "half": H, "counts": {"①b": H.count("①b"), "①": H.count("①")}}


def _side_rows(rows_in):
    return [(ms_of(r["s"]),) + tuple(float(v) for v in r["p"]) for r in rows_in]


def _merge_example(ex, plant):
    inp = ex["input"]
    pair = inp["pair"]
    tf = tf_of_hand(inp["tf"])
    merged, dropped, same, askbid = merge_sides(_side_rows(inp["bid_rows"]), _side_rows(inp["ask_rows"]))
    rows = [(s, b[1:], a[1:]) for (s, b, a) in merged if not bar_inside_closure(s, STEP[tf])]
    bars = build_bars(pair, tf, rows, plant)
    return {"bars": [bar_view(bars, i) for i in range(bars["n"])], "dropped_ask_close_lt_bid_close": dropped,
            "same_start_bid_rows": same,
            "ask_lt_bid_by_year_reference": {str(y): {"num": v[0], "den": v[1]} for y, v in sorted(askbid.items())}}


@hand("A.1.4")
def _h_a14(ex, plant):
    return _merge_example(ex, plant)


@hand("A.1.34")
def _h_a134(ex, plant):
    return _merge_example(ex, plant)


@hand("A.1.5")
def _h_a15(ex, plant):
    sc, ec, dr = [], [], []
    for b in ex["input"]["bars"]:
        s = ms_of(b["s"])
        step = STEP[tf_of_hand(b["len"])]
        sc.append(is_market_closed(s))
        ec.append(is_market_closed(s + step - 1))
        dr.append(bar_inside_closure(s, step))
    return {"s_closed": sc, "end_closed": ec, "drop": dr}


@hand("A.1.6")
def _h_a16(ex, plant):
    inp = ex["input"]
    f, t = ms_of(inp["fromMs"]), ms_of(inp["toMs"])
    out = {}
    for tf, key in (("m15", "15min"), ("h1", "1hour")):
        st, used = [], []
        step = STEP[tf]
        prev = None
        for x in inp["starts_" + key]:
            s = ms_of(x)
            if s < f:
                st.append("範囲の前")
            elif s + step > t:
                st.append("範囲の後")
            elif bar_inside_closure(s, step):
                st.append("週末")
            else:
                st.append("使う")
                used.append({"i": len(used), "s": iso_of(s), "prev": iso_of(prev) if prev is not None else None})
                prev = s
        out["status_" + key] = st
        out["used_" + key] = used
    return out


@hand("A.1.7")
def _h_a17(ex, plant):
    v, mids = [], []
    for r in ex["input"]["rows"]:
        b, a = float(r["bid"]), float(r["ask"])
        v.append(str(Decimal((b + a) / 2)))
        mids.append(mid_of(b, a, DIGITS[r["pair"]], plant))
    return {"v_exact": v, "mid": mids}


@hand("A.1.8")
def _h_a18(ex, plant):
    inp = ex["input"]
    mids, mm, P = [], [], []
    for r in inp["mid_rows"]:
        p = r["pair"]
        m = mid_of(float(r["bid"]), float(r["ask"]), DIGITS[p], plant)
        mids.append(m)
        mm.append(repr(m * MULT[p]))
        P.append(to_points(m, MULT[p], plant))
    raw = [raw_points(float(r["price"]), MULT[r["pair"]], plant) for r in inp["raw"]]
    bt = inp["buy_trade"]
    pl = raw_points(float(bt["Bc_x"]), MULT[bt["pair"]], plant) - raw_points(float(bt["Ao_j"]), MULT[bt["pair"]], plant)
    try:
        raw_points(float(inp["off_tick"]["price"]), MULT[inp["off_tick"]["pair"]], plant)
        off = "no stop"
    except Stop:
        off = "stop"
    return {"mid": mids, "mid_times_mult": mm, "P": P, "raw_points": raw, "buy_trade_PL": pl, "off_tick": off}


@hand("A.1.9")
def _h_a19(ex, plant):
    inp = ex["input"]
    bars = hand_bars(inp["pair"], tf_of_hand(inp["tf"]), inp["bars"], plant)
    n = bars["n"]
    first = {}
    for i in range(n):
        dd = int(bars["day"][i])
        if dd not in first:
            first[dd] = i
    t3 = [ymd_str(ymd(date_of(int(bars["s"][i]) + 3 * HOUR))) for i in range(n)]
    D = [ymd_str(int(bars["day"][i])) for i in range(n)]
    po = [int(bars["Po"][first[int(bars["day"][i])]]) for i in range(n)]
    o = [float(bars["O"][first[int(bars["day"][i])]]) for i in range(n)]
    mids = [[float(bars[k][i]) for k in _MID_KEYS] for i in range(n)]
    return {"t_plus_3h_date": t3, "D": D, "day_open_Po": po, "day_open_O": o, "mid": mids}


@hand("A.1.10")
def _h_a110(ex, plant):
    ny, lo, g = [], [], []
    for t in ex["input"]["times"]:
        x = ms_of(t)
        ny.append("summer" if ny_summer(x) else "winter")
        lo.append("summer" if london_summer(x) else "winter")
        g.append(SEASON_JP[season_group(x)])
    return {"ny": ny, "london": lo, "group": g}


@hand("A.1.11")
def _h_a111(ex, plant):
    D, H, P = [], [], []
    want = ex["expect"].get("in_isPossiblyClosed") or []
    for k, t in enumerate(ex["input"]["times"]):
        x = ms_of(t)
        D.append(ymd_str(day_D(x, plant)))
        H.append(is_holiday(x))
        P.append(None if (k < len(want) and want[k] is None) else is_possibly_closed(x))
    return {"D": D, "holiday": H, "in_isPossiblyClosed": P}


def _htf_example(ex, plant):
    inp = ex["input"]
    bars = hand_bars(inp["pair"], tf_of_hand(inp["tf"]), inp["bars"], plant)
    attach_htf(bars, plant, htf_plant="htfOpen" if plant == "htfOpen" else "")
    h = bars["htf"]
    out = {"htf": []}
    for k in range(h["n"]):
        v = bar_view(h, k)
        out["htf"].append({"k": k, "s": v["s"], "n_base": h["n_base"][k], "bid": v["bid"], "ask": v["ask"],
                           "mid": v["mid"], "P": v["P"]})
    use = []
    for i in range(bars["n"]):
        g = int(bars["g"][i])
        use.append({"s": iso_of(int(bars["s"][i])), "T": iso_of(int(bars["T"][i])), "k": g if g >= 0 else None,
                    "htf_s": iso_of(int(h["s"][g])) if g >= 0 else None})
    out["usable_htf_for_base_bar"] = use
    return out


@hand("A.1.12")
def _h_a112(ex, plant):
    return _htf_example(ex, plant)


@hand("A.1.13")
def _h_a113(ex, plant):
    return _htf_example(ex, plant)


@hand("A.1.14")
def _h_a114(ex, plant):
    return {"r2": [meets_r2(ms_of(t)) for t in ex["input"]["T"]]}


class SlotWorld:
    """The slot examples of A.1.15-A.1.19, A.1.24, A.1.25, A.1.33: five pairs with bars on every slot of the grid
    except the missing ones; USD/JPY's index counts its bars from slot 0 (gaps closed up)."""

    def __init__(self, tf, slots, missing, pre_bars=()):
        self.tf = tf
        self.step = STEP[tf]
        self.t0 = ms_of(slots["from"])
        self.count = slots["count"]
        self.slot_starts = [self.t0 + k * self.step for k in range(self.count)]
        self.present = {}
        for p in PAIRS:
            miss = set(missing.get(p, []))
            self.present[p] = set(list(pre_bars) + [a for k, a in enumerate(self.slot_starts) if k not in miss])
        self.holes, self.opened, self.runs = find_holes(tf, self.slot_starts, self.present)
        self.uj = sorted(self.present["USD/JPY"])
        self.uj_index = {s: i for i, s in enumerate(self.uj)}

    def k_of(self, s):
        return (s - self.t0) // self.step

    def signal(self, s, pair="USD/JPY"):
        i = self.uj_index[s]
        s9 = self.uj[i - 9] if i >= 9 else self.uj[0]
        T = s + self.step
        return i, s9, T, r3_hit(self.holes[pair], s9, T, self.step)

    def open_slot_view(self, missing_uj):
        return {str(k): self.opened[self.slot_starts[k]] for k in missing_uj}

    def holes_view(self):
        return [{"from": iso_of(a), "k": self.k_of(a), "slots": n} for (a, n) in self.runs["USD/JPY"]]


def _slot_signals(world, ks):
    out = []
    for k in ks:
        s = world.slot_starts[k]
        i, s9, T, hit = world.signal(s)
        out.append({"k": k, "s": iso_of(s), "T": iso_of(T), "i": i, "s_i_minus_9": iso_of(s9),
                    "k_i_minus_9": world.k_of(s9), "r3": hit})
    return out


def _hole_example(ex, plant):
    inp = ex["input"]
    w = SlotWorld(tf_of_hand(inp["tf"]), inp["slots"], inp["missing"])
    return {"open_slot": w.open_slot_view(inp["missing"].get("USD/JPY", [])), "holes_usdjpy": w.holes_view(),
            "signals": _slot_signals(w, inp["signal_bars_k"])}


for _eid in ("A.1.15", "A.1.16", "A.1.18", "A.1.19"):
    hand(_eid)(_hole_example)


@hand("A.1.17")
def _h_a117(ex, plant):
    inp = ex["input"]
    w15 = SlotWorld("m15", inp["slots_15min"], inp["missing_15min"])
    w60 = SlotWorld("h1", inp["slots_1hour"], inp["missing_1hour"])
    return {"signals_15min": _slot_signals(w15, inp["tf_15min_signal_bars_k"]),
            "signals_1hour": _slot_signals(w60, inp["tf_1hour_signal_bars_k"])}


@hand("A.1.20")
def _h_a120(ex, plant):
    inp = ex["input"]
    X, F, R = [], [], []
    for s in inp["signals"]:
        T = ms_of(s["T"])
        x = T + inp["N"] * STEP[tf_of_hand(s["tf"])]
        X.append(iso_of(x))
        F.append(iso_of(first_friday_2100(T)))
        R.append(meets_r4(T, x))
    return {"X": X, "first_friday_2100": F, "r4": R}


@hand("A.1.21")
def _h_a121(ex, plant):
    inp = ex["input"]
    X, R = [], []
    for s in inp["signals"]:
        T = ms_of(s["T"])
        x = T + inp["N"] * STEP[tf_of_hand(s["tf"])]
        X.append(iso_of(x))
        R.append(meets_r4(T, x))
    return {"X": X, "r4": R}


@hand("A.1.22")
def _h_a122(ex, plant):
    return {"r5": [meets_r5(ms_of(t)) for t in ex["input"]["T"]]}


def _slot_hhmm(t):
    x = slot_of(t) * 15
    return f"{x // 60:02d}:{x % 60:02d}"


@hand("A.1.23")
def _h_a123(ex, plant):
    inp = ex["input"]
    avoid = avoid_table_from_yes(inp["avoid_table"])
    es, xs, r6 = [], [], []
    for s in inp["signals"]:
        T = ms_of(s["T"])
        X = T + inp["N"] * STEP[tf_of_hand(s["tf"])]
        es.append({"season": ny_season_name(T), "slot": _slot_hhmm(T)})
        xs.append({"season": ny_season_name(X - MIN), "slot": _slot_hhmm(X - MIN)})
        r6.append(meets_r6(s["pair"], T, X, avoid))
    return {"entry_slot": es, "exit_slot": xs, "r6": r6}


def _count_view(sigs):
    counts = {k: 0 for k in ("①", "①b", "②", "③", "④", "⑤", "⑥", "数えた")}
    for s in sigs:
        counts[s["counted_as"]] += 1
    return counts


def _order_example(ex, plant, pre_bars=()):
    inp = ex["input"]
    tf = tf_of_hand(inp["tf"])
    avoid = avoid_table_from_yes(inp["avoid_table"])
    w = SlotWorld(tf, inp["slots"], inp["missing"], pre_bars)
    pair = inp["pair"]
    out_s = []
    if "signal_bars" in inp:
        starts = [ms_of(x) for x in inp["signal_bars"]]
    else:
        starts = [w.slot_starts[k] for k in inp["signal_bars_k"]]
    for s in starts:
        i, s9, T, _ = w.signal(s, pair)
        X = T + N_HOLD * w.step
        half = half_of(T, X, plant)
        hits = []
        if half in ("1", "1b"):
            hits.append("r1b" if half == "1b" else "r1")
        bh = bar_reasons(T, X, pair, s9, w.holes[pair], w.step, avoid)
        hits += bh
        reason = reason_of(half, True, bh[0] if bh else None)
        row = {"s": iso_of(s), "T": iso_of(T), "X": iso_of(X), "hits": [R_NAME[h] for h in hits],
               "counted_as": R_NAME[reason]}
        if "signal_bars_k" in inp:
            row = {"k": w.k_of(s), "s": iso_of(s), "T": iso_of(T), "X": iso_of(X), "i": i,
                   "s_i_minus_9": iso_of(s9), "k_i_minus_9": w.k_of(s9), "r3": "r3" in bh,
                   "hits": row["hits"], "counted_as": row["counted_as"]}
        out_s.append(row)
    out = {"signals": out_s, "counts": _count_view(out_s), "total": len(out_s)}
    if "signal_bars_k" in inp:
        out = {"open_slot": w.open_slot_view(inp["missing"].get("USD/JPY", [])), "holes_usdjpy": w.holes_view(),
               **out}
    return out


@hand("A.1.24")
def _h_a124(ex, plant):
    return _order_example(ex, plant)


@hand("A.1.25")
def _h_a125(ex, plant):
    # the bars before Sunday 21:00: every 15-minute slot of Friday up to 21:45 (input note)
    fri_end = ms_of("2025-05-16T21:45:00Z")
    pre = [fri_end - k * STEP["m15"] for k in range(40)]
    return _order_example(ex, plant, pre)


@hand("A.1.33")
def _h_a133(ex, plant):
    return _order_example(ex, plant)


@hand("A.1.32")
def _h_a132(ex, plant):
    inp = ex["input"]
    avoid = avoid_table_from_yes(inp["avoid_table"])
    pair = inp["pair"]
    out_s = []
    for sg in inp["signals"]:
        tf = tf_of_hand(sg["tf"])
        s = ms_of(sg["s"])
        T = s + STEP[tf]
        X = T + inp["N"] * STEP[tf]
        half = half_of(T, X, plant)
        hits = []
        if half in ("1", "1b"):
            hits.append("r1b" if half == "1b" else "r1")
        bh = bar_reasons(T, X, pair, s, [], STEP[tf], avoid)   # every open slot has its bars: no hole
        hits += bh
        reason = reason_of(half, True, bh[0] if bh else None)
        out_s.append({"tf": sg["tf"], "s": iso_of(s), "T": iso_of(T), "X": iso_of(X), "wkT": wk(T),
                      "half": HALF_JP[half], "hits": [R_NAME[h] for h in hits], "counted_as": R_NAME[reason]})
    return {"signals": out_s, "counts": _count_view(out_s), "total": len(out_s)}


def _trade_view(bars, i, T, X, d, plant):
    tr = trade_at(bars, i, T, X, d, plant)
    if tr is None:
        return {"made": False, "X": iso_of(X)}
    j, x = tr["j"], tr["x"]
    if plant == "entryAtSignalClose":
        entry = int(bars["Ac"][i]) if d == 1 else int(bars["Bc"][i])
        po = int(bars["Pc"][i])
    else:
        entry = int(bars["Ao"][j]) if d == 1 else int(bars["Bo"][j])
        po = int(bars["Po"][j])
    exitp = int(bars["Bc"][x]) if d == 1 else int(bars["Ac"][x])
    return {"made": True, "X": iso_of(X), "j": j, "j_s": iso_of(int(bars["s"][j])), "x": x,
            "x_s": iso_of(int(bars["s"][x])), "substitute_exit": bool(tr["subst"]), "entry_pts": entry,
            "exit_pts": exitp, "Po_j": po, "Pc_x": int(bars["Pc"][x]), "m": tr["m"], "h": tr["h"], "PL": tr["pl"],
            "pips": tr["pl"] / 10, "W": 1 if tr["pl"] > 0 else 0}


def _trade_example(ex, plant):
    inp = ex["input"]
    tf = tf_of_hand(inp["tf"])
    bars = hand_bars(inp["pair"], tf, inp["bars"], plant)
    sb = ms_of(inp["signal_bar"])
    i = bars["slist"].index(sb)
    T = ms_of(inp["T"])
    X = T + inp["N"] * STEP[tf]
    out = {}
    if "bars_points" in ex["expect"]:
        out["bars_points"] = [{"i": k, "s": iso_of(int(bars["s"][k])), "P": [int(bars[c][k]) for c in _PT_KEYS],
                               "B": [int(bars[c][k]) for c in ("Bo", "Bh", "Bl", "Bc")],
                               "A": [int(bars[c][k]) for c in ("Ao", "Ah", "Al", "Ac")]} for k in range(bars["n"])]
    out["buy"] = _trade_view(bars, i, T, X, 1, plant)
    out["sell"] = _trade_view(bars, i, T, X, -1, plant)
    return out


for _eid in ("A.1.26", "A.1.27", "A.1.28", "A.1.29", "A.1.30", "A.1.31"):
    hand(_eid)(_trade_example)


@hand("A.1.35")
def _h_a135(ex, plant):
    inp = ex["input"]
    prm = ex["params"]
    k = prm["k"]
    f_from = inp["F"]["value_from_i"]
    step = STEP[tf_of_hand(inp["tf"])]
    out_s = []
    counts = {"①": 0, "①b": 0, "①を通る": 0}
    warm_only = 0
    fnone = {"前半": 0, "後半": 0, "数えない": 0}
    emitted = 0
    for pr in inp["pairs"]:
        starts = []
        t = ms_of(pr["first_bar"])
        while len(starts) <= max(pr["signal_bars_i"]):
            if not bar_inside_closure(t, step):
                starts.append(t)
            t += step
        for i in pr["signal_bars_i"]:
            s = starts[i]
            T = s + step
            X = T + inp["N"] * step
            half = half_of(T, X, plant)
            row = {"pair": pr["pair"], "i": i, "s": iso_of(s), "T": iso_of(T), "X": iso_of(X), "wkT": wk(T),
                   "half": HALF_JP[half]}
            if i < f_from:
                row.update({"F": "無し", "step5_4": "F が無し", "r1": None, "warmup_only": None})
                where = HALF_JP[half] if half in ("first", "second") else "数えない"
                row["f_none_counted_in"] = where
                fnone[where] += 1
            else:
                emitted += 1
                row.update({"F": "真", "step5_4": "通る"})
                r = reason_of(half, i >= k, None)
                if r == "r1b":
                    row["r1"] = "①b"
                    row["warmup_only"] = None
                    counts["①b"] += 1
                elif r == "r1":
                    row["r1"] = "①"
                    row["warmup_only"] = False
                    counts["①"] += 1
                elif r == "r1w":
                    row["r1"] = "①"
                    row["warmup_only"] = True
                    counts["①"] += 1
                    warm_only += 1
                else:
                    row["r1"] = "通る"
                    row["warmup_only"] = None
                    counts["①を通る"] += 1
                row["f_none_counted_in"] = None
            out_s.append(row)
    return {"signals": out_s, "counts": counts, "warmup_only_in_①": warm_only, "f_none": fnone,
            "all_signals": emitted}


def _a136_load(files, pair, tf, f, t, variant=None):
    """A.1.36: loadTf over in-memory day files. variant: (field or None, value) applied to row b9."""
    step = STEP[tf]
    bid_rows, ask_rows = [], []
    names = {}
    bad_names = []
    bad = 0
    stops = 0
    failures = 0
    for fl in files:
        for side, sink in (("bid", bid_rows), ("ask", ask_rows)):
            body = json.loads(json.dumps(fl[side + "_body"]))
            if variant is not None and side == "bid":
                for k, row in enumerate(fl["bid_rows"]):
                    if row.get("row") == "b9":
                        fld, val = variant
                        if fld is None:
                            body["data"][k] = val
                        elif val is _MISSING:
                            body["data"][k].pop(fld, None)
                        else:
                            body["data"][k][fld] = val
            ok, data = check_day_obj(body)
            if not ok:
                failures += 1
                continue
            for k, el in enumerate(data):
                rows, b, st = parse_day_rows([el])
                bad += b
                stops += st
                if side == "bid":
                    nm = fl["bid_rows"][k].get("row")
                    if b:
                        bad_names.append(nm)
                    if rows:
                        names[id(rows[0])] = (nm, fl["key"])
                        rows[0] = rows[0]
                sink.extend(rows)
    return bid_rows, ask_rows, names, bad, bad_names, stops, failures


@hand("A.1.36")
def _h_a136(ex, plant):
    inp = ex["input"]
    pair = inp["pair"]
    tf = tf_of_hand(inp["tf"])
    step = STEP[tf]
    f, t = ms_of(inp["fromMs"]), ms_of(inp["toMs"])
    files = inp["files"]
    keys = day_keys(f, t)
    out = {"files_read": [ymd_str(k) for k in keys]}
    have = [fl["key"] for fl in files]
    bid_rows, ask_rows, names, bad, bad_names, stops, failures = _a136_load(files, pair, tf, f, t)
    out["read_failures"] = failures + sum(1 for k in keys if ymd_str(k) not in have) * 2
    out["unparseable_rows"] = bad
    out["unparseable_rows_list"] = bad_names
    out["stop_by_value_reading"] = stops > 0
    merged, dropped, same, askbid = merge_sides(bid_rows, ask_rows)
    kept = [(s, b[1:], a[1:]) for (s, b, a) in merged
            if f <= s and s + step <= t and not bar_inside_closure(s, step)]
    kept_index = {r[0]: k for k, r in enumerate(kept)}
    # per Bid row (loadTf order): the counts and what happened
    bids_sorted = sorted(bid_rows, key=lambda r: r[0])
    ask_last = {}
    for r in sorted(ask_rows, key=lambda r: r[0]):
        ask_last[r[0]] = r
    made = set()
    seen = set()
    per = {}
    for r in bids_sorted:
        s = r[0]
        nm, key = names[id(r)]
        a = ask_last.get(s)
        rng = "前" if s < f else ("後" if s + step > t else "中")
        item = {"row": nm, "file": key, "s": iso_of(s), "parsed": True, "year": date_of(s).year, "range": rng,
                "ask_close": dec(a[4], pair) if a else None, "bid_close": dec(r[4], pair),
                "den": 1 if a else 0, "num": 1 if (a and a[4] < r[4]) else 0, "same_start": 1 if s in seen else 0}
        seen.add(s)
        if a is None:
            item["bar"] = "作らない（Ask が無い）"
        elif s in made:
            item["bar"] = "足ができた後（使わない）"
        elif a[4] < r[4]:
            item["bar"] = "作らない（捨てた）"
        else:
            made.add(s)
            if s in kept_index:
                item["bar"] = f"作る（番号{kept_index[s]}）"
            else:
                item["bar"] = "作る（範囲の外。使わない）"
        per[nm] = item
    rows_out = []
    for fl in files:
        for k, row in enumerate(fl["bid_rows"]):
            nm = row.get("row")
            if nm in per:
                rows_out.append(per[nm])
            else:
                rows_out.append({"row": nm, "file": fl["key"], "s": row["s"], "parsed": False, "unparseable": True})
    out["bid_rows"] = rows_out
    bars = build_bars(pair, tf, kept, plant)
    out["bars"] = [bar_view(bars, i) for i in range(bars["n"])]
    out["dropped_ask_close_lt_bid_close"] = dropped
    out["same_start_bid_rows"] = same
    out["ask_lt_bid_by_year"] = {str(y): {"num": v[0], "den": v[1], "stop": v[0] * 1000 > v[1]}
                                 for y, v in sorted(askbid.items())}
    # value variants of b9 (each replaces one value of b9, or the whole element)
    base = (dropped, same, sorted(askbid.items()), [r[0] for r in kept])
    vv = []
    for want in ex["expect"].get("value_variants", []):
        name = want["name"]
        val = want["value"]
        if name.startswith("<"):
            fld = None
        else:
            fld = name
        if val == "<名前が無い>":
            val = _MISSING
        b_rows, a_rows, _, b2, _, st2, fl2 = _a136_load(files, pair, tf, f, t, (fld, val))
        m2, dr2, sa2, ab2 = merge_sides(b_rows, a_rows)
        kept2 = [r[0] for r in m2 if f <= r[0] and r[0] + step <= t and not bar_inside_closure(r[0], step)]
        item = {"name": name, "value": want["value"], "value_json": want["value_json"]}
        if fld is None:
            item["decimal_form"] = None
            item["js_number"] = None
            item["parseKlines_keeps"] = False
        else:
            if isinstance(val, str):
                if fld == "openTime":
                    form = _TIME_RE.fullmatch(val) is not None
                else:
                    form = _PRICE_RE.fullmatch(val) is not None and any("0" <= ch <= "9" for ch in val)
            else:
                form = False
            item["decimal_form"] = form
            num = math.nan if val is _MISSING else parse_klines_value(val)
            item["js_number"] = (int(num) if float(num).is_integer() and abs(num) < 2 ** 53 else num) \
                if math.isfinite(num) else None
            if fld == "openTime":
                item["parseKlines_keeps"] = None if math.isfinite(num) else False
            else:
                item["parseKlines_keeps"] = math.isfinite(num)
        if st2 > 0:
            item["result"] = "止まる"
        elif b2 == 1 and (dr2, sa2, sorted(ab2.items()), kept2) == base:
            item["result"] = "落として数える（数にできない行 1）"
        else:
            item["result"] = f"other: bad {b2}"
        if isinstance(val, str):
            try:
                item["python_float"] = repr(float(val))
            except ValueError:
                pass
        vv.append(item)
    out["value_variants"] = vv
    return out


# ----------------------------------------------------------------------------------------------------------------
# 10. Comparing a hand example's answer (py-design 7)
# ----------------------------------------------------------------------------------------------------------------

def skip_key(k):
    return ("MISREADING" in k or "misreading" in k or k.startswith("variant_") or k.endswith("_note")
            or k == "note" or k == "tolerance_rel")


TEXT_KEYS = {"why"}   # explanatory prose inside an answer: not a value (reported as skip)


def _num_equal(e, g, cls):
    if isinstance(e, bool) or isinstance(g, bool):
        return isinstance(e, bool) and isinstance(g, bool) and e == g
    try:
        ef = float(e)
        gf = float(g)
    except (TypeError, ValueError):
        return False
    if math.isnan(ef) or math.isnan(gf):
        return math.isnan(ef) and math.isnan(gf)
    if cls == "q":
        return abs(ef - gf) <= 1e-9
    if cls in ("p", "ln"):
        return abs(ef - gf) <= 1e-9 * max(abs(ef), abs(gf))
    return ef == gf


def compare_answer(exp, got, key, tol, path, fails, skips, inherited=None):
    own = tol.get(key)
    if own is not None:
        inherited = own
    if isinstance(exp, dict):
        if not isinstance(got, dict):
            fails.append(f"{path}: expected an object, got {got!r}"[:300])
            return
        for k, v in exp.items():
            if skip_key(k):
                continue
            p = f"{path}.{k}" if path else k
            if k in TEXT_KEYS:
                skips.append(p)
                continue
            if k not in got:
                fails.append(f"{p}: not computed")
                continue
            compare_answer(v, got[k], k, tol, p, fails, skips, inherited)
        return
    if isinstance(exp, list):
        if not isinstance(got, list):
            fails.append(f"{path}: expected a list, got {got!r}"[:300])
            return
        if len(exp) != len(got):
            fails.append(f"{path}: {len(got)} items, expected {len(exp)}")
            return
        for k, (e, g) in enumerate(zip(exp, got)):
            compare_answer(e, g, key, tol, f"{path}[{k}]", fails, skips, inherited)
        return
    cls = inherited or "exact"
    if exp is None:
        if not (got is None or (isinstance(got, float) and math.isnan(got))):
            fails.append(f"{path}: expected null, got {got!r}")
        return
    if isinstance(exp, str):
        if got != exp:
            fails.append(f"{path}: expected {exp!r}, got {got!r}")
        return
    if isinstance(exp, (int, float)):
        if got is None or isinstance(got, str) or not _num_equal(exp, got, cls):
            fails.append(f"{path}: expected {exp!r}, got {got!r} (class {cls})")
        return
    fails.append(f"{path}: cannot compare {exp!r}")


def run_hand_examples(examples, plant=""):
    """Groups 1 and 2 (PY1). -> list of {id, status, keys: [{key, status, why}]}."""
    out = []
    for ex in examples:
        eid = ex["id"]
        fn = HANDLERS.get(eid)
        if fn is None:
            out.append({"id": eid, "status": "skip", "keys": [{"key": "*", "status": "skip", "why": "no handler"}]})
            continue
        try:
            got = fn(ex, plant)
        except NotBuilt as e:
            out.append({"id": eid, "status": "fail", "keys": [{"key": "*", "status": "fail", "why": f"NotBuilt: {e}"}]})
            continue
        except Exception as e:  # a handler error is a failure of the example
            out.append({"id": eid, "status": "fail",
                        "keys": [{"key": "*", "status": "fail", "why": f"{type(e).__name__}: {e}"}]})
            continue
        keys = []
        for k, v in ex["expect"].items():
            if skip_key(k):
                continue
            if k in TEXT_KEYS:
                keys.append({"key": k, "status": "skip", "why": "explanatory text"})
                continue
            fails, skips = [], []
            if k not in got:
                fails.append(f"{k}: not computed")
            else:
                compare_answer(v, got[k], k, HAND_TOL.get(eid, {}), k, fails, skips)
            if fails:
                keys.append({"key": k, "status": "fail", "why": "; ".join(fails[:5])})
            else:
                keys.append({"key": k, "status": "pass", "why": ("text keys skipped: " + ", ".join(skips)) if skips else ""})
        st = "fail" if any(x["status"] == "fail" for x in keys) else "pass"
        out.append({"id": eid, "status": st, "keys": keys})
    return out


# ----------------------------------------------------------------------------------------------------------------
# 11. Decisions of stages 0-2 (spec 9, 10, 11), as pure functions shared by the runs and the hand examples
# ----------------------------------------------------------------------------------------------------------------

DIRECTIONAL_F = {"F01", "F01r", "F02", "F02r", "F05", "F05r", "F07", "F07r"}
E_FAMILIES = [(1, 6), (7, 9), (10, 11), (13, 15), (16, 18), (19, 21), (22, 23), (26, 27), (38, 39)]
B_FAMILY = {"B03": "B03", "B07": "B03", "B10": "B03", "B13": "B13", "B14": "B13", "B01": "B01", "B02": "B01"}

L_VERDICT = {1: "後半で確かめられた（問2 は (b) なので「法則の候補」。段3を待つ）", 2: "悪い", 4: "向きだけ", 5: "言えない"}
L_NO_UPLIFT = "合図 E を足した分の上積みは言えない（F だけの行と区別できない）"


def label_partial(failed):
    return "一部（満たさなかった条件: " + "・".join(failed) + "）"


def label_same_group(chosen):
    return f"同じ重なりの組（{chosen}）"


def label_ef_after_s(s_name):
    return f"選んだ {s_name} と同じ F の (E, F)"


def label_s_after_ef(ef_name):
    return f"選んだ {ef_name} と同じ F の S"


def floor_pass(n1, w1, n2, w2):
    return n1 >= 300 and w1 >= 30 and n2 >= 300 and w2 >= 30


def e_family(e):
    k = int(e[1:])
    for lo, hi in E_FAMILIES:
        if lo <= k <= hi:
            return f"E{lo:02d}"
    if k in (24, 25, 31):
        return "E24"
    return e


def same_as_map(trials):
    """spec 4.6: trials in table order, each {id, tf, keys}. Equal first-half counted sets within one tf;
    0-count trials are not compared. The name is the earliest such trial."""
    seen = {}
    out = {}
    for t in trials:
        if not t["keys"]:
            out[t["id"]] = None
            continue
        k = (t["tf"], frozenset(t["keys"]))
        if k in seen:
            out[t["id"]] = seen[k]
        else:
            seen[k] = t["id"]
            out[t["id"]] = None
    return out


def overlap_share(A, B, step):
    """A -> B: the number of A's signals with a B signal of the same pair and direction within one bar's length."""
    idx = {}
    for (p, T, d) in B:
        idx.setdefault((p, d), []).append(T)
    for v in idx.values():
        v.sort()
    num = 0
    for (p, T, d) in A:
        L = idx.get((p, d))
        if not L:
            continue
        k = bisect.bisect_left(L, T - step)
        if k < len(L) and L[k] <= T + step:
            num += 1
    return num, len(A)


def share_value(nd):
    return nd[0] / nd[1] if nd[1] else 0.0


def group_map(trials, step):
    """spec 9 groups of one tf: trials in table order, each {id, kind ('EF'|'S'|'B'), e, b, floor, sigs}.
    Fixed links and >= 0.5 overlap links among floor-passing E x F and B trials; S rows are their own groups;
    trials that do not pass the floor are not grouped (None). The group's name is its first trial."""
    parent = {}

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[rb] = ra

    order = {t["id"]: k for k, t in enumerate(trials)}
    live = [t for t in trials if t["floor"]]
    for t in live:
        parent[t["id"]] = t["id"]
    fixed = {}
    for t in live:
        if t["kind"] == "EF":
            key = ("E", e_family(t["e"]))
        elif t["kind"] == "B" and t["b"] in B_FAMILY:
            key = ("B", B_FAMILY[t["b"]])
        else:
            continue
        if key in fixed:
            union(fixed[key], t["id"])
        else:
            fixed[key] = t["id"]
    linkable = [t for t in live if t["kind"] in ("EF", "B")]
    for x in range(len(linkable)):
        for y in range(x + 1, len(linkable)):
            A, B = linkable[x], linkable[y]
            ab = share_value(overlap_share(A["sigs"], B["sigs"], step))
            ba = share_value(overlap_share(B["sigs"], A["sigs"], step))
            if max(ab, ba) >= 0.5:
                union(A["id"], B["id"])
    comp = {}
    for t in live:
        comp.setdefault(find(t["id"]), []).append(t["id"])
    out = {t["id"]: None for t in trials}
    for members in comp.values():
        first = min(members, key=lambda i: order[i])
        for m in members:
            out[m] = first
    return out


def fail_rule_of(t, q4="a", plant=""):
    """spec 10 rules 1-6 -> 0 (eligible) or the first failed rule. t: pass_floor, same, checks_ok, has_t, delta,
    pl, pl_ex1w, directional, dF, suspicious, sus_checks_passed."""
    if not t["pass_floor"] or t["same"]:
        return 1
    if not t["checks_ok"]:
        return 2
    if not (t["has_t"] and gt0(t["delta"])):
        return 3
    plx = t["pl"] if plant == "noEx1Week" else t["pl_ex1w"]
    if not (gt0(t["pl"]) and gt0(plx)):
        return 4
    if t["directional"] and plant != "noDF" and not gt0(t["dF"]):
        return 5
    if t["suspicious"] and not (q4 == "a" and t["sus_checks_passed"]):
        return 6
    return 0


def choose_tf(rows, per_tf=3):
    """spec 10 choice within one tf. rows: {name, order, kind, f, group, fail_rule, lb, n}.
    -> (ordered names, chosen names, skipped [(name, label, by)], rank {name: k})."""
    elig = [r for r in rows if r["fail_rule"] == 0]
    elig.sort(key=lambda r: (-r["lb"], -r["n"], r["order"]))
    rank = {r["name"]: k + 1 for k, r in enumerate(elig)}
    chosen = []
    skipped = []
    for r in elig:
        if len(chosen) >= per_tf:
            break
        why = None
        for c in chosen:
            if r["kind"] != "S" and c["kind"] != "S" and r["group"] is not None and r["group"] == c["group"]:
                why = (label_same_group(c["name"]), c["name"])
                break
        if why is None:
            for c in chosen:
                if c["kind"] == "S" and r["kind"] == "EF" and r["f"] == c["f"]:
                    why = (label_ef_after_s(c["name"]), c["name"])
                    break
        if why is None:
            for c in chosen:
                if c["kind"] == "EF" and r["kind"] == "S" and c["f"] == r["f"]:
                    why = (label_s_after_ef(c["name"]), c["name"])
                    break
        if why is not None:
            skipped.append((r["name"], why[0], why[1]))
            continue
        chosen.append(r)
    return [r["name"] for r in elig], [c["name"] for c in chosen], skipped, rank


def bh_count(ps, q=0.10):
    """21.5 reference BH: the largest k with p_(k) <= k x 0.10 / m."""
    s = sorted(ps)
    m = len(s)
    best = 0
    rows = []
    for k, p in enumerate(s, start=1):
        thr = (k * q) / m
        ok = p <= thr
        rows.append((k, p, thr, ok))
        if ok:
            best = k
    return best, rows


def holm(rows, K, plant=""):
    """spec 11 Holm (one-sided 2.5%). rows: {name, p, tmin, n, order}. -> list of (rank, row, threshold, passes)."""
    def key(r):
        if r["p"] >= 1.0:
            return (1.0, 0.0, -r["n"], r["order"])
        return (r["p"], -r["tmin"], -r["n"], r["order"])
    srt = sorted(rows, key=key)
    out = []
    alive = True
    for k, r in enumerate(srt, start=1):
        thr = 0.025 / (K - k + 1)
        if plant == "noHolm":
            ok = r["p"] <= 0.025
        else:
            ok = alive and r["p"] <= thr
            if not ok:
                alive = False
        out.append((k, r, thr, ok))
    return out


def conditions(t, q4="a", plant=""):
    """spec 11 C2-C7 for one trial (C1 from Holm). t: dirs {d: (n, delta)}, pairs {p: (n, delta)}, late_lb,
    pl_late, suspicious, sus_checks_passed, c6 (a, b), pl_ex1w, pl."""
    C = {}
    C["C2"] = all(gt0(dl) for (n, dl) in t["dirs"].values() if n >= 30)
    big = [(n, dl) for (n, dl) in t["pairs"].values() if n >= 30]
    if len(big) >= 3:
        C["C3"] = sum(1 for (n, dl) in big if gt0(dl)) * 2 > len(big)
    else:
        C["C3"] = True
    if plant == "c4PointOnly":
        C["C4"] = gt0(t["delta_late"])
    else:
        C["C4"] = gt0(t["late_lb"]) and gt0(t["pl_late"])
    C["C5"] = (not t["suspicious"]) or (q4 == "a" and bool(t["sus_checks_passed"]))
    C["C6"] = gt0(t["c6"][0]) and gt0(t["c6"][1])
    plx = t["pl"] if plant == "noEx1Week" else t["pl_ex1w"]
    C["C7"] = gt0(plx)
    return C


def below0_test(delta_ub):
    """spec 11's verdict-2 test, delta_ub < 0, under spec 8.5's zero band (lt0: |x| < 1e-12 counts as 0). No
    delta_ub (None) is not below 0. One function for stage 2 (verdict_of) and the comparator (C4b, the lead's E11)."""
    return delta_ub is not None and lt0(delta_ub)


def read_number(s):
    """A number as a dump file writes it, read back (the comparator's E10 inputs): a float, or None when s is not a
    number (also NaN, surrounding blanks and '_', which float() would accept)."""
    if s != s.strip() or "_" in s:
        return None
    try:
        x = float(s)
    except ValueError:
        return None
    return None if math.isnan(x) else x


def verdict_of(C1, C, delta_ub, delta_only_pass):
    allc = dict(C)
    allc["C1"] = C1
    order = ["C1", "C2", "C3", "C4", "C5", "C6", "C7"]
    failed = [k for k in order if not allc[k]]
    if not failed:
        return 1, L_VERDICT[1], failed
    if below0_test(delta_ub):
        return 2, L_VERDICT[2], failed
    if C1:
        return 3, label_partial([k for k in failed if k != "C1"]), failed
    if delta_only_pass:
        return 4, L_VERDICT[4], failed
    return 5, L_VERDICT[5], failed


def failed_list(verdict, failed):
    """The failed conditions written with a verdict: for 1 (none) and 3 (C2-C7 that failed); else none."""
    if verdict == 1:
        return []
    if verdict == 3:
        return [k for k in failed if k != "C1"]
    return None


def verdict_texts(C1, C, delta_ub, delta_only_pass):
    """stage2.csv's verdict, label and failed as written (lawsearch-dump.md 11.8): verdict_of, then failed_list,
    the list joined by '・'. Used by stage 2 to write the Python's own row and by the comparator to recompute each
    side's row from that side's own inputs (C4b, the lead's E10), so both use one derivation.
    -> {"verdict": str, "label": str, "failed": str}"""
    v, label, failed = verdict_of(C1, C, delta_ub, delta_only_pass)
    fl = failed_list(v, failed)
    return {"verdict": str(v), "label": label, "failed": "・".join(fl) if fl else ""}


def p95_of(vals):
    s = sorted(vals)
    k = (95 * len(s) + 99) // 100
    return k, s[k - 1]


def median_of(vals):
    s = sorted(vals)
    n = len(s)
    if n % 2:
        return s[n // 2]
    return (s[n // 2 - 1] + s[n // 2]) / 2


# ----------------------------------------------------------------------------------------------------------------
# 12. Hand examples, group 2 (A.2.*): measures, widths, choices, verdicts
# ----------------------------------------------------------------------------------------------------------------

CAND_JP = {"week": "週", "4w": "4週", "shift": "週ずらし"}
TEXT_KEYS.update({"shifted_signals"})
TOL_STATS = {"t975": "q", "half_width": "q", "lb": "q", "ub": "q", "lower": "q", "upper": "q", "p": "p",
             "p_delta": "p", "p_pl": "p", "p_iut": "p", "late_lower": "q", "delta_upper": "q", "MDE": "q",
             "bonferroni_lower": "q", "week_half_width": "q", "four_week_half_width": "q",
             "t_975_df75": "q", "t_1_minus_0_025_over_6_df75": "q", "t_080_df75": "q",
             "t_1_minus_0_025_over_6": "q", "t_080": "q", "pass_min_df75": "q", "pass_min_df18": "q",
             "mde_df75": "q", "mde_df18": "q", "pl_top_holm_pips": "q", "z_double": "q", "L_double": "q",
             "L_M1364_double": "q"}


def h_half_w0(inp):
    if "w0" in inp:
        return inp["w0"]
    return W0_SECOND if inp.get("half") == "後半" else W0_FIRST


def h_table(blind, w0, late=False, plant=""):
    rows = []
    for b in blind:
        T = ms_of(b["T"])
        pi = PAIR_INDEX[b["pair"]]
        src = b["late"] if late else b
        if src is None:
            continue
        for dd, pl in ((1, src["pl_buy"]), (-1, src["pl_sell"])):
            m = dd * src["m"]
            tr = {"j": 0, "x": 0, "subst": 0, "m": m, "h": (m > 0) - (m < 0), "pl": pl}
            rows.append(make_row(pi, b["pair"], 0, T, dd, tr, T + (15 * MIN if late else 0), wk(T), plant))
    sort_rows(rows)
    return Table(rows, w0, plant)


def h_sig(tab, sigs):
    got, missing = [], []
    for s in sigs:
        r = tab.key.get((PAIR_INDEX[s["pair"]], ms_of(s["T"]), s["d"]))
        if r is None:
            missing.append(s)
        else:
            got.append(r)
    return sorted(got), missing


def stratum_parts(sid):
    season = sid % 4
    hour = (sid // 4) % 24
    dd = (sid // 96) % 2
    pi = sid // 192
    return {"pair": PAIRS[pi], "d": 1 if dd == 0 else -1, "hour": hour, "season": SEASON_JP[season]}


def strata_view(tab, c):
    return [{"stratum": stratum_parts(s), "n_s": c["n_s"][s], "m_s": tab.m_s[s], "B_s": tab.B_s[s],
             "signal_mean_h_half": c["mean_s"][s]} for s in sorted(c["n_s"])]


def cand_view(name, c):
    return {"label": CAND_JP[name], "se": c["se"], "df": c["df"], "t": c["t"], "p": c["p"], "t975": c["q975"],
            "half_width": c["half_width"]}


def choice_view(vb):
    ch = vb["choice"]
    return {"candidates": [cand_view(n, c) for n, c in vb["cands"].items()],
            "interval_from": CAND_JP[ch["use_lb"]] if ch["use_lb"] else None,
            "p_from": CAND_JP[ch["use_p"]] if ch["use_p"] else None,
            "p": ch["p"], "t": ch["t"], "lb": ch["lb"], "ub": ch["ub"], "lower": ch["lb"], "upper": ch["ub"],
            "has_t": ch["has_t"],
            "no_t_candidates": [CAND_JP[n] for n, c in vb["cands"].items() if not c["has_t"]]}


def Sg_view(S):
    return {str(g): S[g] for g in sorted(S)}


def shift_detail(tab, sig_in_order, plant=""):
    """Small-data twin of shift_runs that also lists the moved and dropped signals (input order)."""
    W = tab.weeks
    Wn = len(W)
    out = []
    for k in range(1, Wn):
        moved, dropped = [], []
        for r in sig_in_order:
            w = tab.week[r]
            p = tab.week_pos[w] + k
            if p >= Wn:
                if plant == "shiftNoWrap":
                    dropped.append((r, None))
                    continue
                p -= Wn
            T2 = tab.T[r] + (W[p] - w) * WEEK
            t = tab.key.get((tab.pi[r], T2, tab.d[r]))
            if t is None:
                dropped.append((r, T2))
            else:
                moved.append((r, T2, t))
        out.append((k, moved, dropped))
    return out


def shifts_view(tab, sig, sig_in_order, sh, kinds, plant="", late=False):
    det = {k: (mv, dr) for (k, mv, dr) in shift_detail(tab, sig_in_order, plant)}
    out = []
    for (k, n, dropped, vals) in sh:
        mv, dr = det[k]
        item = {"k": k, "N_k": n, "dropped_n": dropped}
        item["dropped_list"] = [{"pair": PAIRS[tab.pi[r]], "T": iso_of(tab.T[r]), "d": tab.d[r],
                                 "shifted_T": iso_of(T2) if T2 is not None else None} for (r, T2) in dr]
        item["dropped_rows"] = [{"T": iso_of(tab.T[r]), "d": tab.d[r], "T_shifted": iso_of(T2) if T2 else None}
                                for (r, T2) in dr]
        item["moved"] = [{"T": iso_of(tab.T[r]), "d": tab.d[r], "T_shifted": iso_of(T2), "h": tab.h[t],
                          "late_hour": utc_hour(T2 + 15 * MIN) if late else utc_hour(T2)} for (r, T2, t) in mv]
        item["delta_k"] = vals.get("delta")
        item["pl_k_pips"] = vals.get("pl")
        item["a_k"] = vals.get("a")
        out.append(item)
    return out


def finish_shifts(items, dropped_as_list):
    for it in items:
        if dropped_as_list:
            it["dropped"] = it["dropped_rows"]
        else:
            it["dropped"] = it["dropped_n"]
    return items


def measure_set(tab, sig, kinds=("delta", "pl", "a"), plant="", kappa=None, with_shift=True):
    """All value blocks of a trial on a table (spec 8.5)."""
    kappa = kappa or {}
    c = core(tab, sig, plant)
    sh = shift_runs(tab, sig, kinds, plant) if with_shift else []
    out = {"core": c, "shift": sh}
    for kd in kinds:
        sp, bp = influences(tab, sig, kd, c, plant)
        scale = 100 if kd in ("delta", "a") else 1
        val = c["delta"] if kd == "delta" else (c["pl"] if kd == "pl" else c["a"])
        out[kd] = value_block(kd, val, c["N"], tab, sp, bp, scale, sh, kappa=kappa.get(kd, 1.0),
                              with_shift=with_shift)
        out[kd + "_psi"] = (sp, bp)
    return out


@hand("A.2.1", TOL_STATS)
def _h_a21(ex, plant):
    inp = ex["input"]
    tab = h_table(inp["blind"], h_half_w0(inp), plant=plant)
    sig, miss = h_sig(tab, inp["signals"])
    c = core(tab, sig, plant)
    out = {"strata": strata_view(tab, c), "N": c["N"], "delta": c["delta"], "a": c["a"],
           "signals_dropped_no_blind": len(miss), "pl_mean_pips": c["pl"], "W_count": c["w_count"],
           "W_rate": c["W"], "blind_pl_weighted_pips": c["blind_pl_w"], "pl_minus_blind_pips": c["pl_minus_blind"]}
    byp = {}
    for p in PAIRS:
        rs = [r for r in sig if tab.pi[r] == PAIR_INDEX[p]]
        if rs:
            byp[p] = pl_mean(tab, rs)
    out["pl_by_pair_pips"] = byp
    out["pl_by_direction_pips"] = {"buy": pl_mean(tab, [r for r in sig if tab.d[r] == 1]),
                                   "sell": pl_mean(tab, [r for r in sig if tab.d[r] == -1])}
    return out


@hand("A.2.2", TOL_STATS)
def _h_a22(ex, plant):
    inp = ex["input"]
    tab = h_table(inp["blind"], h_half_w0(inp), plant=plant)
    no_trade_bars = {(PAIR_INDEX[b["pair"]], ms_of(b["T"])) for b in inp["blind_no_trade_bars"]}
    nt, keep = [], []
    for s in inp["signals"]:
        if (PAIR_INDEX[s["pair"]], ms_of(s["T"])) in no_trade_bars:
            nt.append({"pair": s["pair"], "T": s["T"], "d": s["d"]})
        else:
            keep.append(s)
    sig, miss = h_sig(tab, keep)
    c = core(tab, sig, plant)
    out = {"no_trade_signals": len(nt), "no_trade_signals_list": nt, "blind_no_trade_bars": len(no_trade_bars),
           "signals_dropped_no_blind": len(miss), "strata": strata_view(tab, c), "N": c["N"], "delta": c["delta"],
           "a": c["a"], "pl_mean_pips": c["pl"], "W_count": c["w_count"], "W_rate": c["W"]}
    # the stop case: one more signal with a trade but no blind row in its stratum
    xs = inp["stop_case"]["extra_signal"]
    sig2, miss2 = h_sig(tab, keep + [xs])
    out["stop_case"] = {"stops": len(miss2) > 0, "signals_no_blind": len(miss2)}
    return out


@hand("A.2.3", TOL_STATS)
def _h_a23(ex, plant):
    inp = ex["input"]
    rows = []
    for s in inp["signals"]:
        T = ms_of(s["T"])
        tr = {"j": 0, "x": 0, "subst": 0, "m": 0, "h": 0, "pl": s["pl"]}
        rows.append(make_row(PAIR_INDEX[s["pair"]], s["pair"], 0, T, s["d"], tr, T, wk(T)))
    sort_rows(rows)
    tab = Table(rows, W0_FIRST)
    sig = list(range(tab.n))
    ws = {}
    for r in sig:
        ws[tab.week[r]] = ws.get(tab.week[r], 0) + tab.pl[r]
    v, w, n = pl_ex1w(tab, sig, plant)
    return {"pl_mean_pips": pl_mean(tab, sig), "week_pl_sum_points": {str(k): ws[k] for k in sorted(ws)},
            "excluded_week": w, "pl_ex1week_pips": v, "n_after": n}


def _infl_rows(tab, sig, psd, psp):
    """Rows of A.2.4's influence table in the 21.5 order."""
    sset = set(sig)
    out = []
    for r in range(tab.n):
        if r in sset:
            out.append({"kind": "signal", "pair": PAIRS[tab.pi[r]], "T": iso_of(tab.T[r]), "d": tab.d[r],
                        "week": tab.week[r], "infl_delta": psd[0][r], "infl_pl": psp[0][r],
                        "d_i": tab.h[r] / 2 - tab.B_s[tab.stratum[r]]})
        out.append({"kind": "blind", "pair": PAIRS[tab.pi[r]], "T": iso_of(tab.T[r]), "d": tab.d[r],
                    "week": tab.week[r], "infl_delta": psd[1][r], "infl_pl": 0.0})
    return out


def _std_measure_view(tab, sig, sig_in, plant, dropped_as_list=False, kinds=("delta", "pl", "a")):
    ms = measure_set(tab, sig, kinds, plant)
    c = ms["core"]
    d, p = ms["delta"], ms["pl"]
    out = {"N": c["N"], "delta": c["delta"], "a": c["a"], "pl_mean_pips": c["pl"], "strata": strata_view(tab, c),
           "week_S_g_delta": Sg_view(d["S_week"]), "week_S_g_pl": Sg_view(p["S_week"]),
           "C_week": d["C_week"], "C_4week": d["C_4w"], "use_4week": d["four"],
           "se_week_delta": d["cands"]["week"]["se"], "se_week_pl": p["cands"]["week"]["se"],
           "blocks_4week": Sg_view(d["S_4w"]), "weeks_with_blind": tab.weeks, "W_h": len(tab.weeks),
           "sd_shift_delta": d["shift"]["sd"], "sd_shift_pl": p["shift"]["sd"], "K": d["shift"]["used"],
           "delta_choice": choice_view(d), "pl_choice": choice_view(p), "df_week": d["C_week"] - 1,
           "k_unused_N0": [k for (k, n, _, _) in ms["shift"] if n == 0]}
    if d["four"]:
        out["se_4week_delta"] = d["cands"]["4w"]["se"]
        out["se_4week_pl"] = p["cands"]["4w"]["se"]
    out["shifts"] = finish_shifts(shifts_view(tab, sig, sig_in, ms["shift"], kinds, plant), dropped_as_list)
    out["_ms"] = ms
    return out


@hand("A.2.4", TOL_STATS)
def _h_a24(ex, plant):
    inp = ex["input"]
    tab = h_table(inp["blind"], h_half_w0(inp), plant=plant)
    sig, _ = h_sig(tab, inp["signals"])
    sig_in = [tab.key[(PAIR_INDEX[s["pair"]], ms_of(s["T"]), s["d"])] for s in inp["signals"]]
    out = _std_measure_view(tab, sig, sig_in, plant)
    ms = out["_ms"]
    out["influence"] = _infl_rows(tab, sig, ms["delta_psi"], ms["pl_psi"])
    return out


@hand("A.2.5", TOL_STATS)
def _h_a25(ex, plant):
    inp = ex["input"]
    tab = h_table(inp["blind"], h_half_w0(inp), plant=plant)
    sig, _ = h_sig(tab, inp["signals"])
    sig_in = [tab.key[(PAIR_INDEX[s["pair"]], ms_of(s["T"]), s["d"])] for s in inp["signals"]]
    out = _std_measure_view(tab, sig, sig_in, plant)
    rs = []
    det = shift_detail(tab, sig_in, plant)
    for (k, mv, dr) in det:
        if k != 1:
            continue
        for (r, T2, t) in mv:
            a, b = season_group(tab.T[r]), season_group(T2)
            if a != b:
                rs.append({"T": iso_of(tab.T[r]), "shifted_T": iso_of(T2), "d": tab.d[r], "season_from": SEASON_JP[a],
                           "season_to": SEASON_JP[b]})
    out["restratified_at_k1"] = rs
    return out


@hand("A.2.6", TOL_STATS)
def _h_a26(ex, plant):
    inp = ex["input"]
    tab = h_table(inp["blind"], h_half_w0(inp), plant=plant)
    sig, _ = h_sig(tab, inp["signals"])
    return _std_measure_view(tab, sig, sig, plant)


@hand("A.2.7", TOL_STATS)
def _h_a27(ex, plant):
    out = []
    names = {"週": "week", "4週": "4w", "週ずらし": "shift"}
    for case in ex["input"]["cases"]:
        v = case["estimate"]
        cands = {}
        for c in case["candidates"]:
            nm = names[c["label"]]
            cands[nm] = make_cand(v, c["se"], c["df"] + 1, c["df"], 1, K=2, need_K=False)
        vb = {"cands": cands, "choice": choose(v, cands)}
        cv = choice_view(vb)
        cv["case"] = case["case"]
        out.append(cv)
    return {"cases": out}


@hand("A.2.8", TOL_STATS)
def _h_a28(ex, plant):
    inp = ex["input"]
    tab = h_table(inp["blind"], h_half_w0(inp), plant=plant)
    sig, _ = h_sig(tab, inp["signals"])
    ms = measure_set(tab, sig, ("delta", "pl", "a"), plant)
    c = ms["core"]
    d = ms["delta"]
    return {"N": c["N"], "delta": c["delta"], "a": c["a"], "pl_mean_pips": c["pl"], "C_week": d["C_week"],
            "C_4week": d["C_4w"], "W_h": len(tab.weeks), "shifts": [s for s in ms["shift"]],
            "se_week": d["cands"]["week"]["se"], "sd_shift": d["shift"]["sd"], "t": d["choice"]["t"],
            "p": d["choice"]["p"], "lb": d["choice"]["lb"], "ub": d["choice"]["ub"],
            "p_pl": ms["pl"]["choice"]["p"], "selectable_rule3": d["choice"]["has_t"] and gt0(c["delta"])}


@hand("A.2.9", TOL_STATS)
def _h_a29(ex, plant):
    inp = ex["input"]
    tab = h_table(inp["blind"], h_half_w0(inp), plant=plant)
    sig, _ = h_sig(tab, inp["signals"])
    ms = measure_set(tab, sig, ("delta", "pl", "a"), plant)
    c = ms["core"]
    return {"N": c["N"], "delta": c["delta"], "a": c["a"], "pl_mean_pips": c["pl"], "t": ms["delta"]["choice"]["t"],
            "p": ms["delta"]["choice"]["p"], "lb": ms["delta"]["choice"]["lb"], "p_pl": ms["pl"]["choice"]["p"]}


@hand("A.2.10", TOL_STATS)
def _h_a210(ex, plant):
    inp = ex["input"]
    tab = h_table(inp["blind"], h_half_w0(inp), plant=plant)
    sig, _ = h_sig(tab, inp["signals"])
    c = core(tab, sig, plant)
    return {"strata": strata_view(tab, c), "N": c["N"], "delta_double": c["delta"],
            "delta_treated_as_zero": is_zero(c["delta"]), "delta_gt_0": gt0(c["delta"]),
            "eligible_rule3": gt0(c["delta"])}


@hand("A.2.11", TOL_STATS)
def _h_a211(ex, plant):
    inp = ex["input"]
    tab = h_table(inp["blind"], h_half_w0(inp), plant=plant)
    sig, _ = h_sig(tab, inp["signals"])
    out = _std_measure_view(tab, sig, sig, plant)
    ms = out["_ms"]
    d = ms["delta"]
    out["se_week_double"] = d["cands"]["week"]["se"]
    out["se_week_treated_as_zero"] = is_zero(d["cands"]["week"]["se"])
    out["selectable_rule3"] = d["choice"]["has_t"] and gt0(ms["core"]["delta"])
    w = 2819
    rows = []
    sset = set(sig)
    for r in range(tab.n):
        if tab.week[r] != w:
            continue
        if r in sset:
            rows.append({"kind": "signal", "T": iso_of(tab.T[r]), "d": tab.d[r], "infl_delta": ms["delta_psi"][0][r]})
        rows.append({"kind": "blind", "T": iso_of(tab.T[r]), "d": tab.d[r], "infl_delta": ms["delta_psi"][1][r]})
    want = ex["expect"].get("week_2819_rows_delta", [])
    # the example lists the rows of the buy stratum only (the sell rows have influence 0)
    rows = [x for x in rows if x["d"] == 1]
    out["week_2819_rows_delta"] = rows
    return out


@hand("A.2.12", dict(TOL_STATS, double="q"))
def _h_a212(ex, plant):
    q = []
    for row in ex["expect"]["quantiles"]:
        qs = row["q"]
        qv = (1 - 0.025 / 6) if qs == "1-0.025/6" else float(qs)
        v = t_quantile(qv, row["df"])
        q.append({"q": qs, "df": row["df"], "value_12sig": _sig12(v), "double": v})
    c = []
    for row in ex["expect"]["cdf"]:
        x, nu = row["x"], row["df"]
        T = float(t_cdf_dec(x, nu))
        p = t_pvalue(x, nu)
        item = {"x": x, "df": nu, "T_12sig": _sig12(t_cdf_dec(x, nu)), "T_double": T, "p_double": p}
        item["p_12sig"] = _sig12(U_dec(x, nu)) if x >= 0 else None
        c.append(item)
    return {"quantiles": q, "cdf": c}


def _sig12(d):
    """12 significant digits as the hand examples write them (Python's 'g': trailing zeros removed)."""
    return format(float(d), ".12g")


def _df_view(tab, sig_a, sig_b, plant):
    ma = measure_set(tab, sig_a, ("delta",), plant, with_shift=False)
    mb = measure_set(tab, sig_b, ("delta",), plant, with_shift=False)
    da, db = ma["core"]["delta"], mb["core"]["delta"]
    D = da - db
    vb = diff_value_block(D, ma["core"]["N"], tab, ma["delta_psi"], mb["delta_psi"], 100)
    ch = vb["choice"]
    out = {"delta_EF": da, "delta_SF": db, "N_EF": ma["core"]["N"], "N_SF": mb["core"]["N"],
           "strata_EF": strata_view(tab, ma["core"]), "strata_SF": strata_view(tab, mb["core"]), "D_F": D}
    for nm, key in (("week", "week"), ("4w", "four_week")):
        c = vb["cands"].get(nm)
        S = vb["S_week"] if nm == "week" else vb["S_4w"]
        out[key] = {"C": vb["C_week"] if nm == "week" else vb["C_4w"], "S_g": Sg_view(S),
                    "se": c["se"] if c else None, "df": c["df"] if c else None,
                    "t975": c["q975"] if c else None, "half_width": c["half_width"] if c else None}
    out["used"] = CAND_JP[ch["use_lb"]] if ch["use_lb"] else None
    out["lower"] = ch["lb"]
    out["upper"] = ch["ub"]
    out["lower_gt_0"] = gt0(ch["lb"])
    return out


@hand("A.2.13", TOL_STATS)
def _h_a213(ex, plant):
    inp = ex["input"]
    tab = h_table(inp["blind"], h_half_w0(inp), plant=plant)
    a, _ = h_sig(tab, inp["trial_EF_signals"])
    b, _ = h_sig(tab, inp["S_F_signals"])
    return _df_view(tab, a, b, plant)


@hand("A.2.25", TOL_STATS)
def _h_a225(ex, plant):
    inp = ex["input"]
    tab = h_table(inp["blind"], h_half_w0(inp), plant=plant)
    a, _ = h_sig(tab, inp["trial_EF_signals"])
    b, _ = h_sig(tab, inp["S_F_signals"])
    out = _df_view(tab, a, b, plant)
    s01 = [{"pair": s["pair"], "T": s["T"], "d": -s["d"]} for s in inp["S_F_signals"]]
    c, _ = h_sig(tab, s01)
    d01 = core(tab, c, plant)["delta"]
    out["delta_S01_for_reference"] = d01
    out["delta_SF_equals_minus_delta_S01_exactly"] = out["delta_SF"] == -d01
    return out


def _late_trade_view(b15, T, X, d):
    tr = late_trade_at(b15, T, X, d)
    if tr is None:
        return None
    j, x = tr["j"], tr["x"]
    return {"entry_bar_start": iso_of(int(b15["s"][j])), "exit_bar_start": iso_of(int(b15["s"][x])),
            "exit_is_substitute": bool(tr["subst"]), "Po": int(b15["Po"][j]), "Pc": int(b15["Pc"][x]), "m": tr["m"],
            "h": tr["h"], "entry_price_pts": int(b15["Ao"][j]) if d == 1 else int(b15["Bo"][j]),
            "exit_price_pts": int(b15["Bc"][x]) if d == 1 else int(b15["Ac"][x]), "pl": tr["pl"]}


def _normal_trade_view(bars, T, X, d):
    tr = trade_at(bars, 0, T, X, d)
    if tr is None:
        return None
    j, x = tr["j"], tr["x"]
    return {"entry_bar_start": iso_of(int(bars["s"][j])), "exit_bar_start": iso_of(int(bars["s"][x])),
            "exit_is_substitute": bool(tr["subst"]), "Po": int(bars["Po"][j]), "Pc": int(bars["Pc"][x]), "m": tr["m"],
            "h": tr["h"], "entry_price_pts": int(bars["Ao"][j]) if d == 1 else int(bars["Bo"][j]),
            "exit_price_pts": int(bars["Bc"][x]) if d == 1 else int(bars["Ac"][x]), "pl": tr["pl"]}


def _skey(T, d):
    return f"{iso_of(T)} {'+1' if d == 1 else '-1'}"


def late_excluded(T, X, b15, period_end):
    """spec 8.8 exclusions, in order: no late entry, (4) on [T, X + 15 min), X + 15 min past the period's end."""
    a = T + 15 * MIN
    z = X + 15 * MIN
    s = b15["slist"]
    j = bisect.bisect_left(s, a)
    if j >= len(s) or s[j] >= z:
        return "no_entry"
    if meets_r4(T, z):
        return "r4"
    if z > period_end:
        return "end"
    return None


@hand("A.2.14", TOL_STATS)
def _h_a214(ex, plant):
    inp = ex["input"]
    pair = inp["pair"]
    b15 = hand_bars(pair, "m15", inp["bars"], plant)
    step = STEP["m15"]
    N = inp["N"]
    end = SPLIT if inp["half"] == "前半" else END
    rows = []
    lat_sig = {}
    lat_blind = {}
    ex_list = []
    n_ex_sig = {"r4": 0, "no_entry": 0}
    n_ex_bl = {"r4": 0, "no_entry": 0}
    for Ts in inp["blind_bars_T"]:
        T = ms_of(Ts)
        X = T + N * step
        for d in (1, -1):
            why = late_excluded(T, X, b15, end)
            if why:
                lat_blind[_skey(T, d)] = "excluded"
                continue
            v = _late_trade_view(b15, T, X, d)
            lat_blind[_skey(T, d)] = v
            tr = late_trade_at(b15, T, X, d)
            rows.append(make_row(PAIR_INDEX[pair], pair, 0, T, d, tr, T + 15 * MIN, wk(T), plant))
        why = late_excluded(T, X, b15, end)
        if why in n_ex_bl:
            n_ex_bl[why] += 1
    sort_rows(rows)
    tab = Table(rows, W0_FIRST, plant)
    sigs = []
    normal = {}
    for s in inp["signals"]:
        T = ms_of(s["T"])
        X = T + N * step
        d = s["d"]
        normal[_skey(T, d)] = _normal_trade_view(b15, T, X, d)
        why = late_excluded(T, X, b15, end)
        if why:
            lat_sig[_skey(T, d)] = "excluded"
            n_ex_sig[why] += 1
            ex_list.append({"pair": s["pair"], "T": s["T"], "d": d, "X_plus_15": iso_of(X + 15 * MIN),
                            "friday_21": iso_of(first_friday_2100(T))})
            continue
        lat_sig[_skey(T, d)] = _late_trade_view(b15, T, X, d)
        sigs.append(s)
    sig, _ = h_sig(tab, sigs)
    c = core(tab, sig, plant)
    return {"late_trades_signals": lat_sig, "late_trades_blind": lat_blind, "excluded_from_delta_late": ex_list,
            "n_excluded": len(ex_list), "strata": strata_view(tab, c), "N": c["N"], "delta_late": c["delta"],
            "pl_late_mean_pips": c["pl"], "normal_trades": normal,
            "late_excluded_by_4": {"signals": n_ex_sig["r4"], "blind_bars": n_ex_bl["r4"]},
            "late_excluded_no_late_entry": {"signals": n_ex_sig["no_entry"], "blind_bars": n_ex_bl["no_entry"]}}


@hand("A.2.15", TOL_STATS)
def _h_a215(ex, plant):
    inp = ex["input"]
    pair = inp["pair"]
    N = ex["params"]["N"]
    b15 = hand_bars(pair, "m15", inp["bars_15min"], plant)
    b60 = hand_bars(pair, "h1", inp["bars_1hour"], plant)
    s = inp["signal"]
    T = ms_of(s["T"])
    X = T + N * STEP["h1"]
    return {"X": iso_of(X), "X_plus_15": iso_of(X + 15 * MIN), "late_stratum_hour": utc_hour(T + 15 * MIN),
            "late_trade": _late_trade_view(b15, T, X, s["d"]), "normal_trade_1hour": _normal_trade_view(b60, T, X, s["d"])}


@hand("A.2.16", TOL_STATS)
def _h_a216(ex, plant):
    res = []
    for t in ex["input"]["trials"]:
        res.append({"name": t["name"], "pass_floor": floor_pass(t["n_first"], t["weeks_first"], t["n_second"],
                                                                 t["weeks_second"])})
    return {"results": res, "M_1": sum(1 for r in res if r["pass_floor"])}


@hand("A.2.17", TOL_STATS)
def _h_a217(ex, plant):
    trials = []
    for t in sorted(ex["input"]["trials"], key=lambda t: t["table_order"]):
        keys = {(s["pair"], ms_of(s["T"]), s["d"]) for s in t["first_half_signals"]}
        trials.append({"id": t["name"], "tf": tf_of_hand(t["tf"]), "keys": keys})
    mp = same_as_map(trials)
    res = [{"name": t["name"], "same_trial": mp[t["name"]] is not None, "same_as": mp[t["name"]]}
           for t in ex["input"]["trials"]]
    return {"results": res}


def _kind_of_name(name):
    base = name.split(".")[-1]
    if base.startswith("S"):
        return "S", None, None, None
    if base.startswith("B"):
        return "B", None, None, base
    e, f = base.split("×")
    return "EF", e, f, None


@hand("A.2.18", TOL_STATS)
def _h_a218(ex, plant):
    inp = ex["input"]
    step = inp["bar_length_minutes"] * MIN
    trials = []
    for t in sorted(inp["trials"], key=lambda t: t["table_order"]):
        kind, e, f, b = _kind_of_name(t["name"])
        sigs = [(s["pair"], ms_of(s["T"]), s["d"]) for s in t["first_half_signals"]]
        trials.append({"id": t["name"], "kind": kind, "e": e, "b": b, "floor": t["pass_floor"], "sigs": sigs})
    shares = []
    for x in range(len(trials)):
        for y in range(x + 1, len(trials)):
            A, B = trials[x], trials[y]
            ab = overlap_share(A["sigs"], B["sigs"], step)
            ba = overlap_share(B["sigs"], A["sigs"], step)
            lg = max(share_value(ab), share_value(ba))
            shares.append({"A": A["id"], "B": B["id"], "A_to_B": f"{ab[0]}/{ab[1]}", "B_to_A": f"{ba[0]}/{ba[1]}",
                           "larger": lg, "linked": lg >= 0.5})
    gm = group_map(trials, step)
    groups = {}
    for t in trials:
        g = gm[t["id"]]
        if g is not None:
            groups.setdefault(g, []).append(t["id"])
    order = [t["id"] for t in trials]
    gl = sorted(groups.values(), key=lambda m: order.index(m[0]))
    return {"pair_shares": shares, "groups": gl, "n_groups": len(gl),
            "not_grouped": [t["id"] for t in trials if gm[t["id"]] is None]}


SPEC9_TABLE = {300: ("4.08", "11.1", "12.1", "14.5", "15.6"), 1000: ("2.24", "6.1", "6.6", "8.0", "8.6"),
               3000: ("1.29", "3.5", "3.8", "4.6", "4.9"), 10000: ("0.71", "1.9", "2.1", "2.5", "2.7"),
               30000: ("0.41", "1.1", "1.2", "1.5", "1.6")}
SPEC9_G3 = {300: ("13.6", "17.8"), 1000: ("7.4", "9.7")}


def _round_half_up(x, nd):
    return str(Decimal(repr(x)).quantize(Decimal(1).scaleb(-nd), rounding=ROUND_HALF_UP))


@hand("A.2.19", TOL_STATS)
def _h_a219(ex, plant):
    inp = ex["input"]
    q1 = 1 - 0.025 / 6
    tq = {str(df): t_quantile(q1, df) for df in (75, 18)}
    t8 = {str(df): t_quantile(0.80, df) for df in (75, 18)}
    rows2, rows3 = [], []
    for n2 in inp["n2_values"]:
        se = 50 * math.sqrt(2 / n2)
        pm75, pm18 = tq["75"] * se, tq["18"] * se
        md75, md18 = (tq["75"] + t8["75"]) * se, (tq["18"] + t8["18"]) * se
        sp = SPEC9_TABLE[n2]
        ok = (_round_half_up(se, 2) == sp[0] and _round_half_up(pm75, 1) == sp[1] and _round_half_up(pm18, 1) == sp[2]
              and _round_half_up(md75, 1) == sp[3] and _round_half_up(md18, 1) == sp[4])
        rows2.append({"n2": n2, "g": 2, "se": se, "pass_min_df75": pm75, "pass_min_df18": pm18, "mde_df75": md75,
                      "mde_df18": md18, "mark_df75": pm75 >= 8, "mark_df18": pm18 >= 8, "matches_spec_rounding": ok})
    for n2 in (300, 1000):
        se = 50 * math.sqrt(3 / n2)
        pm75 = tq["75"] * se
        md75 = (tq["75"] + t8["75"]) * se
        ok = _round_half_up(pm75, 1) == SPEC9_G3[n2][0] and _round_half_up(md75, 1) == SPEC9_G3[n2][1]
        rows3.append({"n2": n2, "g": 3, "se": se, "pass_min_df75": pm75, "mde_df75": md75,
                      "matches_spec_rounding": ok})
    ge = inp["g_example"]
    x = ge["mean_used_se_100runs"] / (50 / math.sqrt(ge["n1"]))
    g = x * x
    pe = inp["pl_example"]
    plse = pe["sd_pips"] * math.sqrt(pe["g"] / pe["n2"])
    return {"t_1_minus_0_025_over_6": tq, "t_080": t8, "rows_g2": rows2, "rows_g3": rows3, "g_example": g,
            "se_estimate_n2_500": 50 * math.sqrt(g / ge["n2"]), "pl_se_pips": plse,
            "pl_top_holm_pips": tq["75"] * plse,
            "stage3_count_estimate": (inp["stage3_example"]["n2"] * 52) / 76}


def _elig_from_hand(t, q4):
    kind, e, f, b = _kind_of_name(t["name"])
    return fail_rule_of({"pass_floor": t["pass_floor"], "same": t["same_trial"], "checks_ok": t["checks_ok"],
                         "has_t": t["t_exists"], "delta": t["delta"], "pl": t["pl_pips"],
                         "pl_ex1w": t["pl_ex1week_pips"], "directional": kind == "EF" and f in DIRECTIONAL_F,
                         "dF": t["D_F"], "suspicious": t["suspicious_hit"],
                         "sus_checks_passed": t.get("suspicious_checks_all_passed")}, q4)


def _choose_hand(trials, q4, plant=""):
    rows = []
    elig = []
    for t in trials:
        kind, e, f, b = _kind_of_name(t["name"])
        fr = _elig_from_hand(t, q4) if plant != "noDF" else fail_rule_of(
            {"pass_floor": t["pass_floor"], "same": t["same_trial"], "checks_ok": t["checks_ok"],
             "has_t": t["t_exists"], "delta": t["delta"], "pl": t["pl_pips"], "pl_ex1w": t["pl_ex1week_pips"],
             "directional": kind == "EF" and f in DIRECTIONAL_F, "dF": t["D_F"], "suspicious": t["suspicious_hit"],
             "sus_checks_passed": t.get("suspicious_checks_all_passed")}, q4, plant)
        if plant == "noEx1Week":
            fr = fail_rule_of({"pass_floor": t["pass_floor"], "same": t["same_trial"], "checks_ok": t["checks_ok"],
                               "has_t": t["t_exists"], "delta": t["delta"], "pl": t["pl_pips"],
                               "pl_ex1w": t["pl_ex1week_pips"], "directional": kind == "EF" and f in DIRECTIONAL_F,
                               "dF": t["D_F"], "suspicious": t["suspicious_hit"],
                               "sus_checks_passed": t.get("suspicious_checks_all_passed")}, q4, plant)
        if kind == "S":
            f = {"S01": "F01", "S02": "F02", "S03": "F05", "S04": "F07"}[t["name"].split(".")[-1]]
        elig.append({"name": t["name"], "fail_rule": fr})
        rows.append({"name": t["name"], "order": t["table_order"], "kind": kind, "f": f,
                     "group": t.get("overlap_group"), "fail_rule": fr,
                     "lb": t["lb"] if t["lb"] is not None else -math.inf, "n": t["n"]})
    order, chosen, skipped, _ = choose_tf(rows)
    return elig, order, chosen, skipped


@hand("A.2.20", TOL_STATS)
def _h_a220(ex, plant):
    q4 = "a" if ex["params"].get("question4", "(a)") == "(a)" else "b"
    out = {}
    K = 0
    for tf, key in (("m15", "15min"), ("h1", "1hour")):
        elig, order, chosen, skipped = _choose_hand(ex["input"]["trials_" + key], q4, plant)
        out["eligibility_" + key] = elig
        out["order_" + key] = order
        out["chosen_" + key] = chosen
        out["skipped_" + key] = [{"name": n, "reason": why, "by": by} for (n, why, by) in skipped]
        K += len(chosen)
    out["K_total"] = K
    return out


@hand("A.2.21", TOL_STATS)
def _h_a221(ex, plant):
    inp = ex["input"]
    names = {"週": "week", "4週": "4w", "週ずらし": "shift"}
    out = {}
    ps = {}
    for v, cl, kk, key in (("delta", "delta_candidates", "kappa_delta", "delta_scaled"),
                           ("pl_pips", "pl_candidates", "kappa_pl", "pl_scaled")):
        val = inp[v]
        kap = max(1.0, inp[kk])
        cands = {}
        for c in inp[cl]:
            cands[names[c["label"]]] = make_cand(val, c["se"], c["df"] + 1, c["df"], 1, K=2, kappa=kap)
        vb = {"cands": cands, "choice": choose(val, cands)}
        out[key] = choice_view(vb)
        ps[v] = vb["choice"]["p"]
    out["p_delta"] = ps["delta"]
    out["p_pl"] = ps["pl_pips"]
    out["p_iut"] = max(ps["delta"], ps["pl_pips"])
    ka = {}
    for v, sev in (("delta", "se_delta_p"), ("pl", "se_pl_p")):
        runs = inp["kappa_arith"]["runs"]
        vals = [r[v] for r in runs if r.get(v) is not None]
        ses = [r[sev] for r in runs if r.get(sev) is not None]
        sd = sd_two_pass(vals)
        acc = 0.0
        for x in ses:
            acc = acc + x
        mse = acc / len(ses)
        kap = sd / mse
        ka[v] = {"sd": sd, "mean_se": mse, "runs_for_sd": len(vals), "runs_for_mean_se": len(ses),
                 "runs_without_t": len(runs) - len(ses), "kappa": kap, "kappa_used": max(1.0, kap)}
    out["kappa_arith"] = ka
    return out


@hand("A.2.22", TOL_STATS)
def _h_a222(ex, plant):
    inp = ex["input"]
    K = ex["params"]["K_total"]
    rows = []
    piut = {}
    for t in inp["trials"]:
        p = t["p_delta"] if plant == "iutOneLeg" else max(t["p_delta"], t["p_pl"])
        piut[t["name"]] = max(t["p_delta"], t["p_pl"])
        rows.append({"name": t["name"], "p": p, "tmin": min(t["t_delta"], t["t_pl"]), "n": t["n"],
                     "order": t["table_order"]})
    H = holm(rows, K, plant)
    holm_v = [{"rank": k, "name": r["name"], "p": r["p"], "threshold": thr, "passes": ok} for (k, r, thr, ok) in H]
    q = []
    for t in inp["order_only_case"]:
        q.append({"name": t["name"], "p": t["p"], "tmin": t["tmin"] if t.get("tmin") is not None else 0.0,
                  "n": t["n"], "order": t["order"]})
    Q = holm(q, len(q))
    return {"p_iut": piut, "holm": holm_v, "passed": [r["name"] for (k, r, thr, ok) in H if ok],
            "order_only_case": [r["name"] for (k, r, thr, ok) in Q]}


@hand("A.2.23", TOL_STATS)
def _h_a223(ex, plant):
    inp = ex["input"]
    K = ex["params"]["K_total"]
    q4 = "a"
    trials = inp["trials"]
    rows = []
    rows_d = []
    for t in trials:
        p = t["p_delta"] if plant == "iutOneLeg" else max(t["p_delta"], t["p_pl"])
        rows.append({"name": t["name"], "p": p, "tmin": 0.0, "n": 0, "order": t["order"]})
        rows_d.append({"name": t["name"], "p": t["p_delta"], "tmin": 0.0, "n": 0, "order": t["order"]})
    H = holm(rows, K, plant)
    HD = holm(rows_d, K, plant)
    passed = {r["name"]: ok for (k, r, thr, ok) in H}
    passed_d = {r["name"]: ok for (k, r, thr, ok) in HD}
    t975 = t_quantile(0.975, 75)
    tq = t_quantile(1 - 0.025 / K, 75)
    t80 = t_quantile(0.80, 75)
    res = []
    for t in trials:
        df = t["df"]
        q975 = t_quantile(0.975, df)
        lt = t["late"]
        late_lb = lt["delta"] - t_quantile(0.975, lt["df"]) * lt["se"]
        ub = t["delta"] + q975 * t["se"]
        dirs = {k: (v["n"], v["delta"]) for k, v in t["dirs"].items()}
        pairs = {k: (v["n"], v["delta"]) for k, v in t["pairs"].items()}
        C = conditions({"dirs": dirs, "pairs": pairs, "late_lb": late_lb, "pl_late": lt["pl"],
                        "delta_late": lt["delta"], "suspicious": t["susp"]["hit"],
                        "sus_checks_passed": t["susp"].get("checks_all_passed"), "c6": tuple(t["halves"]),
                        "pl_ex1w": t["pl_ex1week"], "pl": t.get("pl", t["pl_ex1week"])}, q4, plant)
        C1 = passed[t["name"]]
        v, label, failed = verdict_of(C1, C, ub, passed_d[t["name"]])
        tqd = t_quantile(1 - 0.025 / K, df)
        item = {"name": t["name"], "p_iut": max(t["p_delta"], t["p_pl"]),
                "conditions": dict(C1=C1, **C), "late_lower": late_lb, "delta_upper": ub,
                "delta_only_holm_pass": passed_d[t["name"]], "verdict": v, "label": label,
                "failed": failed_list(v, failed),
                "MDE": (tqd + t_quantile(0.80, df)) * t["se"], "bonferroni_lower": t["delta"] - tqd * t["se"]}
        df_in = t.get("D_F")
        if df_in:
            ww = t_quantile(0.975, df_in["df_week"]) * df_in["se_week"]
            w4 = t_quantile(0.975, df_in["df_4week"]) * df_in["se_4week"] if df_in.get("C_4week", 0) >= 10 else None
            use4 = w4 is not None and w4 > ww
            hw = w4 if use4 else ww
            item["D_F"] = {"week_half_width": ww, "four_week_half_width": w4, "used": "4週" if use4 else "週",
                           "lower": df_in["value"] - hw, "upper": df_in["value"] + hw,
                           "no_uplift_sentence": le0(df_in["value"] - hw)}
        else:
            item["D_F"] = None
        res.append(item)
    return {"holm_iut": [{"rank": k, "name": r["name"], "p": r["p"], "threshold": thr, "passes": ok}
                         for (k, r, thr, ok) in H],
            "holm_delta_only": [{"rank": k, "name": r["name"], "p": r["p"], "threshold": thr, "passes": ok}
                                for (k, r, thr, ok) in HD],
            "t_975_df75": t975, "t_1_minus_0_025_over_6_df75": tq, "t_080_df75": t80, "results": res,
            "no_uplift_sentence_text": L_NO_UPLIFT}


@hand("A.2.24", TOL_STATS)
def _h_a224(ex, plant):
    inp = ex["input"]
    N = inp["N"]
    out = []
    for tr in inp["trials"]:
        step = STEP[tf_of_hand(tr["tf"])]
        sg = []
        nex = 0
        for s in tr["signals"]:
            T = ms_of(s["T"])
            X = T + N * step
            r4 = meets_r4(T, X)
            late = "excluded" if meets_r4(T, X + 15 * MIN) else "in"
            if not r4 and late == "excluded":
                nex += 1
            sg.append({"pair": s["pair"], "T": s["T"], "d": s["d"], "X": iso_of(X), "X_plus_15": iso_of(X + 15 * MIN),
                       "counted": not r4, "reason_4": "④" if r4 else None, "late": late})
        out.append({"tf": tr["tf"], "signals": sg, "n_excluded_from_delta_late": nex})
    return {"trials": out}


def _late_measure_view(tab, sig, sig_in, plant):
    ms = measure_set(tab, sig, ("delta", "pl"), plant)
    c = ms["core"]
    d = ms["delta"]
    out = {"strata": strata_view(tab, c), "N": c["N"], "delta_late": c["delta"], "pl_late_pips": c["pl"],
           "week_S_g_delta_late": Sg_view(d["S_week"]), "C_week": d["C_week"],
           "se_week": d["cands"]["week"]["se"], "C_4week": d["C_4w"], "use_4week": d["four"],
           "weeks_with_blind": tab.weeks, "weeks_with_late_blind": tab.weeks, "W_h": len(tab.weeks),
           "K": d["shift"]["used"], "sd_shift": d["shift"]["sd"], "choice": choice_view(d),
           "C4_lower_gt_0": gt0(d["choice"]["lb"]), "pl_late_gt_0": gt0(c["pl"]),
           "k_unused_N0": [k for (k, n, _, _) in ms["shift"] if n == 0]}
    out["shifts"] = finish_shifts(shifts_view(tab, sig, sig_in, ms["shift"], ("delta",), plant, late=True), True)
    return out


@hand("A.2.26", TOL_STATS)
def _h_a226(ex, plant):
    inp = ex["input"]
    w0 = h_half_w0(inp)
    bars = inp["blind_bars"]
    in81 = [b for b in bars if b["ordinary_trade"]]
    not81 = [b["T"] for b in bars if not b["ordinary_trade"]]
    no_late = [b["T"] for b in in81 if b.get("late") is None]
    tab = h_table(in81, w0, late=True, plant=plant)
    excl, keep = [], []
    no_late_set = {(b["pair"], ms_of(b["T"])) for b in in81 if b.get("late") is None}
    for s in inp["signals"]:
        if (s["pair"], ms_of(s["T"])) in no_late_set:
            excl.append({"pair": s["pair"], "T": s["T"], "d": s["d"]})
        else:
            keep.append(s)
    sig, _ = h_sig(tab, keep)
    sig_in = [tab.key[(PAIR_INDEX[s["pair"]], ms_of(s["T"]), s["d"])] for s in keep]
    out = _late_measure_view(tab, sig, sig_in, plant)
    out["late_excluded_no_late_entry"] = {"signals": len(excl), "signals_list": excl, "blind_bars": len(no_late),
                                          "blind_bars_list": no_late}
    out["not_in_8_1_table"] = not81
    out["late_blind_bars"] = tab.n // 2
    return out


@hand("A.2.27", TOL_STATS)
def _h_a227(ex, plant):
    inp = ex["input"]
    vals = inp["part1_values"]
    k, v = p95_of(vals)
    p1 = {"n": len(vals), "rank_1based": k, "p95": v}
    piut = {t["name"]: max(t["p_delta"], t["p_pl"]) for t in inp["part2_trials"]}
    best, rows = bh_count(list(piut.values()))
    p2 = {"m": len(piut), "p_iut": piut,
          "sorted": [{"k": k, "p": p, "threshold": thr, "le": ok} for (k, p, thr, ok) in rows], "bh_pass_count": best}
    trials = inp["part3_trials"]
    m15 = [t for t in trials if not t["name"].startswith("h1.")]
    h1 = [t for t in trials if t["name"].startswith("h1.")]
    fr = {}
    K = 0
    for grp in (m15, h1):
        elig, order, chosen, skipped = _choose_hand(grp, "a", plant)
        for e in elig:
            fr[e["name"]] = e["fail_rule"]
        K += len(chosen)
    lbp = [t for t in trials if t["lb"] is not None and gt0(t["lb"]) and t["pass_floor"] and not t["same_trial"]]
    p3 = {"fail_rule": fr, "K_total": K, "open_second_half": K > 0, "lb_gt_0_trials": len(lbp),
          "lb_gt_0_groups": len({t["overlap_group"] for t in lbp}),
          "lb_and_pl_gt_0_trials": sum(1 for t in lbp if gt0(t["pl_pips"]))}
    return {"part1": p1, "part2": p2, "part3": p3}


@hand("A.2.28", TOL_STATS)
def _h_a228(ex, plant):
    inp = ex["input"]
    step = STEP[tf_of_hand(inp["tf"])]
    rows = []
    no_trade = []
    for s in inp["signals"]:
        T = ms_of(s["T"])
        if not s["trade"]:
            no_trade.append(s["T"])
            continue
        tr = {"j": 0, "x": 0, "subst": 0, "m": s["h"], "h": s["h"], "pl": s["pl"]}
        rows.append(make_row(PAIR_INDEX[s["pair"]], s["pair"], 0, T, s["d"], tr, T, wk(T)))
    sort_rows(rows)
    tab = Table(rows, W0_FIRST)
    sig = list(range(tab.n))
    kept = nonoverlap(tab, sig, step)
    return {"kept": [iso_of(tab.T[r]) for r in kept], "removed": [iso_of(tab.T[r]) for r in sig if r not in kept],
            "no_trade_neither": no_trade, "pl_mean_pips_counted_with_trade": pl_mean(tab, sig),
            "pl_mean_pips_non_overlapping": pl_mean(tab, kept)}


@hand("A.2.29", TOL_STATS)
def _h_a229(ex, plant):
    inp = ex["input"]
    w0 = h_half_w0(inp)
    out = {}
    for part in ("part1", "part2"):
        tab = h_table(inp[part + "_blind"], w0, plant=plant)
        sig, _ = h_sig(tab, inp[part + "_signals"])
        sig_in = [tab.key[(PAIR_INDEX[s["pair"]], ms_of(s["T"]), s["d"])] for s in inp[part + "_signals"]]
        v = _std_measure_view(tab, sig, sig_in, plant)
        ms = v["_ms"]
        v["delta_has_t"] = ms["delta"]["choice"]["has_t"]
        v["p_delta"] = ms["delta"]["choice"]["p"]
        v["lb"] = ms["delta"]["choice"]["lb"]
        v["ub"] = ms["delta"]["choice"]["ub"]
        v["pl_has_t"] = ms["pl"]["choice"]["has_t"]
        v["p_pl"] = ms["pl"]["choice"]["p"]
        v["selectable_rule3"] = ms["delta"]["choice"]["has_t"] and gt0(ms["core"]["delta"])
        out[part] = v
    return out


@hand("A.2.30", TOL_STATS)
def _h_a230(ex, plant):
    base = None
    for e in _HAND_ALL:
        if e["id"] == "A.2.5":
            base = e
    inp = base["input"]
    tab = h_table(inp["blind"], h_half_w0(inp), plant=plant)
    sig, _ = h_sig(tab, inp["signals"])
    ms = measure_set(tab, sig, ("delta", "a"), plant)
    c = ms["core"]
    a = ms["a"]
    sp = ms["a_psi"][0]
    infl = [{"T": iso_of(tab.T[r]), "d": tab.d[r], "week": tab.week[r], "block": tab.blk[r], "infl_a": sp[r]}
            for r in sig]
    out = {"a": c["a"], "a_prime": c["a"] / 100, "N": c["N"], "influence_a": infl, "week_S_g_a": Sg_view(a["S_week"]),
           "C_week": a["C_week"], "se_week_a": a["cands"]["week"]["se"], "four_week_S_g_a": Sg_view(a["S_4w"]),
           "C_4week": a["C_4w"], "se_4week_a": a["cands"]["4w"]["se"] if a["four"] else None,
           "shifts": [{"k": k, "N_k": n, "a_k": vals.get("a")} for (k, n, _, vals) in ms["shift"]],
           "K": a["shift"]["used"], "sd_shift_a": a["shift"]["sd"], "a_choice": choice_view(a)}
    return out


@hand("A.2.31", TOL_STATS)
def _h_a231(ex, plant):
    inp = ex["input"]
    trials = inp["trials"]

    def part(ts, M):
        ru = [float(t["sd_delta_100runs"]) / float(t["mean_se_used"]) for t in ts]
        rc = [float(t["sd_delta_100runs"]) / float(t["mean_se_wider_week_4week"]) for t in ts]
        q = 1 - 0.01 / M
        z = statistics.NormalDist().inv_cdf(q)
        L = 1 + z / math.sqrt(2 * 99)
        mu, mc = median_of(ru), median_of(rc)
        gate = {"r_used_median_in_range": 0.70 <= mu <= 1.10, "r_cl_median_le_115": mc <= 1.15,
                "all_le_L": all(x <= L for x in ru + rc)}
        gate["pass"] = all(gate.values())
        return {"M": M, "r_used": ru, "r_cl": rc, "r_used_sorted": sorted(ru), "r_cl_sorted": sorted(rc),
                "r_used_median": mu, "r_cl_median": mc, "z_q": f"1-0.01/{M}", "z_12sig": f"{z:.11f}",
                "z_double": z, "L_12sig": f"{L:.11f}", "L_double": L, "gate": gate}
    even = part(trials, len(trials))
    odd = part([t for t in trials if t["name"] != "h1.S01"], len(trials) - 1)
    zM = statistics.NormalDist().inv_cdf(1 - 0.01 / 1364)
    return {"even": even, "odd": odd, "L_M1364_double": 1 + zM / math.sqrt(2 * 99)}


@hand("A.2.32", TOL_STATS)
def _h_a232(ex, plant):
    inp = ex["input"]
    w0 = h_half_w0(inp)
    # (1) the ordinary Δ
    tab = h_table(inp["part1_blind"], w0, plant=plant)
    nt = [s for s in inp["part1_signals"] if not s["trade"]]
    keep = [s for s in inp["part1_signals"] if s["trade"]]
    sig, _ = h_sig(tab, keep)
    sig_in = [tab.key[(PAIR_INDEX[s["pair"]], ms_of(s["T"]), s["d"])] for s in keep]
    p1 = _std_measure_view(tab, sig, sig_in, plant, dropped_as_list=True)
    p1["no_trade_signals"] = len(nt)
    p1["no_trade_signals_list"] = [{"pair": s["pair"], "T": s["T"], "d": s["d"]} for s in nt]
    # (2) Δ_late
    bars = inp["part2_ordinary_bars"]
    tab2 = h_table([b for b in bars if b["ordinary_trade"]], w0, late=True, plant=plant)
    lex = [b for b in bars if b["ordinary_trade"] and b.get("late") is None]
    lex_set = {(b["pair"], ms_of(b["T"])) for b in lex}
    ex_s, keep2 = [], []
    for s in inp["part2_signals"]:
        T = ms_of(s["T"])
        if (s["pair"], T) in lex_set:
            why = "④（X＋15分）" if meets_r4(T, T + N_HOLD * STEP["m15"] + 15 * MIN) else "遅れた入りの足が無い"
            ex_s.append({"pair": s["pair"], "T": s["T"], "d": s["d"], "reason": why})
        else:
            keep2.append(s)
    sig2, _ = h_sig(tab2, keep2)
    sig2_in = [tab2.key[(PAIR_INDEX[s["pair"]], ms_of(s["T"]), s["d"])] for s in keep2]
    p2 = _late_measure_view(tab2, sig2, sig2_in, plant)
    p2["late_excluded"] = {"signals": len(ex_s), "signals_list": ex_s, "blind_bars": len(lex),
                           "blind_bars_list": [b["T"] for b in lex]}
    p2["late_blind_bars"] = tab2.n // 2
    return {"part1": p1, "part2": p2}


_HAND_ALL = []


# ----------------------------------------------------------------------------------------------------------------
# 13. The registry of trials (research/ledger/lawsearch-candidates.json)
# ----------------------------------------------------------------------------------------------------------------

BUILT_E = {"E04", "E26"}
BUILT_F = {"F00", "F01"}
BUILT_S = {"S01"}
BUILT_B = {"B06"}
S_OF_F = {"F01": "S01", "F02": "S02", "F05": "S03", "F07": "S04"}


def load_registry():
    with open(ROOT / "research/ledger/lawsearch-candidates.json", "r", encoding="utf-8") as f:
        led = json.load(f)
    reg = {}
    for t in led["trials"]:
        tf = TF_OF_LEDGER[t["tf"]]
        d = {"id": t["id"], "order": t["order"], "tf": tf, "kind": t["kind"], "e": t.get("e"), "f": t.get("f"),
             "s": t.get("s"), "b": t.get("b"), "name": t.get("name")}
        reg[t["id"]] = d
    return reg


def check_built(trial):
    k = trial["kind"]
    if k == "EF" and (trial["e"] not in BUILT_E or trial["f"] not in BUILT_F):
        raise NotBuilt(f"trial {trial['id']} not written yet")
    if k == "S" and trial["s"] not in BUILT_S:
        raise NotBuilt(f"trial {trial['id']} not written yet")
    if k == "B" and trial["b"] not in BUILT_B:
        raise NotBuilt(f"trial {trial['id']} not written yet")


def sig_trial(trial):
    """The trial dict handed to PY2 (py-design 3.1)."""
    return {"id": trial["id"], "order": trial["order"], "tf": trial["tf"], "kind": trial["kind"], "e": trial["e"],
            "f": trial["f"] if trial["kind"] != "B" else None, "s": trial["s"], "b": trial["b"]}


# ----------------------------------------------------------------------------------------------------------------
# 14. CSV writing (lawsearch-dump.md 3)
# ----------------------------------------------------------------------------------------------------------------

def f_int(x):
    if x is None:
        return ""
    return str(int(x))


def f_real(x):
    if x is None:
        return ""
    x = float(x)
    if math.isnan(x):
        return ""
    return repr(x)


def f_bool(x):
    if x is None:
        return ""
    return "1" if x else "0"


def f_tri(x):
    if x is None:
        return ""
    x = int(x)
    if x < 0:
        return ""
    return str(x)


def f_text(x):
    return "" if x is None else str(x)


class CsvOut:
    def __init__(self, path, header):
        self.path = path
        self.header = header
        self.lines = [",".join(header)]

    def row(self, vals):
        if len(vals) != len(self.header):
            raise ValueError(f"{self.path}: {len(vals)} fields, header {len(self.header)}")
        for v in vals:
            if "," in v or "\n" in v:
                raise ValueError(f"{self.path}: field with a comma or newline: {v!r}")
        self.lines.append(",".join(vals))

    def write(self):
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        with open(self.path, "w", encoding="utf-8", newline="\n") as f:
            f.write("\n".join(self.lines) + "\n")


# ----------------------------------------------------------------------------------------------------------------
# 15. One stage's load: bars, per-bar exclusions, trades, blind and late tables, signals
# ----------------------------------------------------------------------------------------------------------------

class StageLoad:
    def __init__(self, gmo_dir, stage, from_ms, to_ms, avoid, plant="", mode="syn", log=print):
        self.stage = stage
        self.from_ms = from_ms
        self.to_ms = to_ms
        self.avoid = avoid
        self.plant = plant
        self.bars = {}
        self.counts = {}
        self.askbid = {}
        self.stops = []
        for pair in PAIRS:
            for tf in TFS:
                b, c, ab, msgs = load_tf(gmo_dir, pair, tf, from_ms, to_ms, mode, plant)
                self.counts[(pair, tf)] = c
                self.askbid[(pair, tf)] = ab
                self.stops.extend(msgs)
                if b is not None:
                    attach_htf(b, plant)
                    if len(set(b["htf"]["slist"])) != b["htf"]["n"]:
                        self.stops.append(f"{pair} {tf}: duplicate higher bar starts")
                self.bars[(tf, pair)] = b
        if self.stops:
            return
        self.holes = {}
        self.hole_summary = {}
        for tf in TFS:
            step = STEP[tf]
            g0 = S0 // step * step
            slots = list(range(g0, END, step))
            present = {p: set(self.bars[(tf, p)]["slist"]) for p in PAIRS}
            holes, opened, runs = find_holes(tf, slots, present)
            self.holes[tf] = holes
            n_open = sum(1 for a in slots if opened[a])
            self.hole_summary[tf] = {p: (g0, len(slots), n_open, sum(1 for a in slots if a in present[p]),
                                         len(holes[p])) for p in PAIRS}
        self.per_bar = {}
        for tf in TFS:
            for pair in PAIRS:
                self._per_bar(tf, pair)

    def _per_bar(self, tf, pair):
        b = self.bars[(tf, pair)]
        step = STEP[tf]
        n = b["n"]
        s = b["slist"]
        hl = self.holes[tf][pair]
        half = [None] * n
        hit = [None] * n
        trade = [None] * n
        for i in range(n):
            T = s[i] + step
            X = T + N_HOLD * step
            half[i] = half_of(T, X, self.plant)
            s9 = s[i - 9] if i >= 9 else s[0]
            h = None
            if meets_r2(T):
                h = "r2"
            elif r3_hit(hl, s9, T, step):
                h = "r3"
            elif meets_r4(T, X):
                h = "r4"
            elif meets_r5(T):
                h = "r5"
            elif meets_r6(pair, T, X, self.avoid):
                h = "r6"
            hit[i] = h
        self.per_bar[(tf, pair)] = {"half": half, "hit": hit}

    def trade(self, tf, pair, i, d):
        b = self.bars[(tf, pair)]
        T = b["slist"][i] + b["step"]
        X = T + N_HOLD * b["step"]
        return trade_at(b, i, T, X, d, self.plant)

    def blind(self, tf, half):
        """spec 8.1 blind table of (tf, half) and its late table (8.8). -> (Table, LateTable, counts dict)."""
        rows = []
        passed = 0
        no_trade = 0
        step = STEP[tf]
        for pair in PAIRS:
            b = self.bars[(tf, pair)]
            pb = self.per_bar[(tf, pair)]
            pi = PAIR_INDEX[pair]
            for i in range(b["n"]):
                if pb["half"][i] != half or pb["hit"][i] is not None:
                    continue
                passed += 1
                T = b["slist"][i] + step
                trb = self.trade(tf, pair, i, 1)
                trs = self.trade(tf, pair, i, -1)
                if trb is None or trs is None:
                    no_trade += 1
                    continue
                for d, tr in ((1, trb), (-1, trs)):
                    rows.append(make_row(pi, pair, i, T, d, tr, T, wk(T), self.plant))
        sort_rows(rows)
        w0 = W0_FIRST if half == "first" else W0_SECOND
        tab = Table(rows, w0, self.plant)
        end = SPLIT if half == "first" else END
        lrows = []
        why_of = {}
        late_of = {}
        nx = {"no_entry": 0, "r4": 0, "end": 0}
        for r, row in enumerate(rows):
            b15 = self.bars[("m15", row["pair"])]
            T = row["T"]
            X = T + N_HOLD * step
            why = late_excluded(T, X, b15, end)
            if why:
                nx[why] += 1
                why_of[r] = why
                continue
            tr = late_trade_at(b15, T, X, row["d"])
            lr = make_row(row["pi"], row["pair"], row["i"], T, row["d"], tr, T + 15 * MIN, row["week"], self.plant)
            lr["base_row"] = r
            late_of[r] = len(lrows)
            lrows.append(lr)
        late = Table(lrows, w0, self.plant)
        cnt = {"rows": tab.n, "passed_bars": passed, "no_trade_bars": no_trade, "weeks": len(tab.weeks),
               "late_rows": late.n, "late_no_entry": nx["no_entry"], "late_r4": nx["r4"], "late_end": nx["end"]}
        if nx["end"]:
            raise Stop(f"late table {tf} {half}: {nx['end']} rows with X + 15 min past the period's end")
        return {"tab": tab, "late": late, "late_of": late_of, "why_of": why_of, "counts": cnt}


def signal_rows(load, trial, answer_knowing=False, adopt=None):
    """spec 5 candidates (PY2) with the reasons of spec 6 -> rows sorted by T, pair, buy before sell.

    Row: (T, pi, dsort, pair, i, d, X, reason, half, warm, status)."""
    sig = load_sig()
    tf = trial["tf"]
    step = STEP[tf]
    out = []
    for pair in PAIRS:
        b = load.bars[(tf, pair)]
        pb = load.per_bar[(tf, pair)]
        c = sig.candidates(sig_trial(trial), b, answer_knowing=answer_knowing)
        rows = []
        for k in range(len(c["i"])):
            i = int(c["i"][k])
            d = int(c["d"][k])
            st = c["status"][k]
            warm = bool(c["warm"][k])
            T = b["slist"][i] + step
            X = T + N_HOLD * step
            half = pb["half"][i]
            if st == "f_none":
                reason = "f_none"
            elif st == "both":
                reason = "both"
            else:
                reason = reason_of(half, warm, pb["hit"][i])
            rows.append([T, PAIR_INDEX[pair], 0 if d == 1 else 1, pair, i, d, X, reason,
                         half if half in ("first", "second") else "", warm, st])
        if adopt is not None:
            rows = adopt(trial, pair, rows)
        out.extend(rows)
    out.sort(key=lambda r: (r[0], r[1], r[2]))
    return out


def counted_of(rows, half):
    return [r for r in rows if r[7] == "counted" and r[8] == half]


class TrialHalf:
    """A trial's counted signals of one half on that half's blind table (spec 8.2-8.8)."""

    def __init__(self, load, trial, rows, bl, half, plant=""):
        self.trial = trial
        self.half = half
        tf = trial["tf"]
        tab = bl["tab"]
        self.counted = counted_of(rows, half)
        self.no_trade = 0
        self.no_blind = 0
        sig = []
        self.trades = []
        for r in self.counted:
            T, pi, _, pair, i, d = r[0], r[1], r[2], r[3], r[4], r[5]
            tr = load.trade(tf, pair, i, d)
            if tr is None:
                self.no_trade += 1
                continue
            row = tab.key.get((pi, T, d))
            if row is None:
                self.no_blind += 1
                continue
            sig.append(row)
        if self.no_blind:
            raise Stop(f"{trial['id']} {half}: {self.no_blind} signals with a trade but no blind row")
        self.sig = sorted(sig)
        self.weeks = len({wk(r[0]) for r in self.counted})
        late_sig = []
        self.late_ex = {"no_entry": 0, "r4": 0, "end": 0}
        for r in self.sig:
            lr = bl["late_of"].get(r)
            if lr is None:
                self.late_ex[bl["why_of"][r]] += 1
            else:
                late_sig.append(lr)
        self.late_sig = sorted(late_sig)


def measure_trial(th, bl, s_th=None, kappa=None, stage2=False, plant=""):
    """Every measure of a trial half (measures.csv, strata.csv, shift.csv, clusters.csv)."""
    tab = bl["tab"]
    late = bl["late"]
    kappa = kappa or {}
    ms = measure_set(tab, th.sig, ("delta", "pl", "a"), plant, kappa=kappa)
    lm = measure_set(late, th.late_sig, ("delta", "pl"), plant)
    res = {"ms": ms, "lm": lm, "tab": tab, "late": late}
    c = ms["core"]
    res["values"] = {"delta": ms["delta"], "a": ms["a"], "pl": ms["pl"], "delta_late": lm["delta"]}
    res["values"]["delta_late"] = dict(lm["delta"], name="delta_late")
    if s_th is not None:
        sm = measure_set(tab, s_th.sig, ("delta",), plant, with_shift=False)
        D = c["delta"] - sm["core"]["delta"]
        res["values"]["dF"] = diff_value_block(D, c["N"], tab, ms["delta_psi"], sm["delta_psi"], 100)
    v, w, n = pl_ex1w(tab, th.sig, plant)
    res["pl_ex1w"] = (v, w, n)
    step = STEP[th.trial["tf"]]
    kept = nonoverlap(tab, th.sig, step)
    res["nov"] = (len(kept), delta_only(tab, kept), pl_mean(tab, kept))
    if stage2:
        ex = {}
        for d, nm in ((1, "buy"), (-1, "sell")):
            ex["delta_dir." + nm] = delta_only(tab, [r for r in th.sig if tab.d[r] == d])
            ex["counted_dir." + nm] = sum(1 for r in th.counted if r[5] == d)
        for p in PAIRS:
            pi = PAIR_INDEX[p]
            ex["delta_pair." + SYM_OF[p]] = delta_only(tab, [r for r in th.sig if tab.pi[r] == pi])
            ex["counted_pair." + SYM_OF[p]] = sum(1 for r in th.counted if r[1] == pi)
        for nm, (lo, hi) in (("c6.a", C6_A), ("c6.b", C6_B)):
            sub, mp = sub_table(tab, lambda row, lo=lo, hi=hi: lo <= row["week"] <= hi)
            ex[nm] = delta_only(sub, sorted(mp[r] for r in th.sig if r in mp))
        res["extras2"] = ex
    return res


def blind_measure(bl, tf, pair, d, plant=""):
    """spec 8.7 blind rows: all blind rows of a pair and direction as the signals."""
    tab = bl["tab"]
    pi = PAIR_INDEX[pair]
    sig = [r for r in range(tab.n) if tab.pi[r] == pi and tab.d[r] == d]
    ms = measure_set(tab, sig, ("pl", "a"), plant)
    return sig, ms


# ----------------------------------------------------------------------------------------------------------------
# 16. A run (py-design 5.6, lawsearch-dump.md 4-8)
# ----------------------------------------------------------------------------------------------------------------

def tree_sha256(gmo_dir):
    paths = []
    for dp, dn, fn in os.walk(gmo_dir):
        for f in fn:
            full = os.path.join(dp, f)
            rel = os.path.relpath(full, gmo_dir).replace(os.sep, "/")
            paths.append(rel)
    paths.sort(key=lambda p: p.encode("utf-8"))
    h = hashlib.sha256()
    for rel in paths:
        h.update(f"{rel}\t{sha256_file(os.path.join(gmo_dir, rel))}\n".encode("utf-8"))
    return h.hexdigest()


def v_keys(prefix, vb):
    ch = vb["choice"]
    out = [(f"{prefix}.value", f_real(vb["value"])), (f"{prefix}.N", f_int(vb["N"])),
           (f"{prefix}.C_week", f_int(vb["C_week"])), (f"{prefix}.C_4w", f_int(vb["C_4w"])),
           (f"{prefix}.four", f_bool(vb["four"])), (f"{prefix}.has_t", f_bool(ch["has_t"])),
           (f"{prefix}.use_lb", f_text(ch["use_lb"])), (f"{prefix}.use_p", f_text(ch["use_p"])),
           (f"{prefix}.t", f_real(ch["t"])), (f"{prefix}.p", f_real(ch["p"])), (f"{prefix}.lb", f_real(ch["lb"])),
           (f"{prefix}.ub", f_real(ch["ub"])), (f"{prefix}.kappa", f_real(vb["kappa"]))]
    for cn in CAND_ORDER:
        c = vb["cands"].get(cn)
        if c is None:
            continue
        out += [(f"{prefix}.{cn}.se", f_real(c["se"])), (f"{prefix}.{cn}.C", f_int(c["C"])),
                (f"{prefix}.{cn}.df", f_int(c["df"])), (f"{prefix}.{cn}.K", f_int(c["K"])),
                (f"{prefix}.{cn}.t", f_real(c["t"])), (f"{prefix}.{cn}.p", f_real(c["p"])),
                (f"{prefix}.{cn}.q975", f_real(c["q975"])), (f"{prefix}.{cn}.half_width", f_real(c["half_width"]))]
    if vb["shift"] is not None:
        out += [(f"{prefix}.shift.used", f_int(vb["shift"]["used"])),
                (f"{prefix}.shift.skipped", f_int(vb["shift"]["skipped"])),
                (f"{prefix}.shift.sd", f_real(vb["shift"]["sd"]))]
    return out


def sus_checks_passed_of(tsr):
    """spec 13 調べ (i)-(v) of a hit row, read from the TS's suspect.csv row: "1", "0", or "" when the row did not hit.

    The Python reads the TS's checks and does not recompute them (dump 8), but it also requires (v), the other agent's
    hand check: on synthetic runs it is not run (`hand` = not-run), so a hit row is never selectable (spec 23.5)."""
    raw = tsr.get("checks_passed", "")
    if raw not in ("0", "1"):
        return ""
    return "1" if raw == "1" and tsr.get("hand", "") == "1" else "0"


def suspicion(counted, delta, a, pl, M, delta_late, W, is_blind=False):
    looked = counted >= 100
    hd = looked and not is_blind and isnum(delta) and abs(delta) >= 8
    ha = looked and isnum(a) and abs(a) >= 10
    hp = looked and isnum(pl) and isnum(M) and pl >= 0.15 * M
    hl = looked and not is_blind and isnum(delta) and isnum(delta_late) and abs(delta - delta_late) >= 4
    hw = looked and isnum(W) and (W == 0 or W == 1)
    return {"looked": looked, "hit_delta": hd, "hit_a": ha, "hit_pl": hp, "hit_late": hl, "hit_W": hw,
            "hit": hd or ha or hp or hl or hw}


def refuse_capped(config):
    """dump.md 2 / py-design 2 (C3, the lead's D5; C4b, the lead's E14): cut_max is the TS's development cap on its
    cut checks. A capped run's checks pass under their normal names and checks.csv carries no cap marker, so neither
    --run nor --compare compares one; a config.json without the key (written before C3) cannot say whether it was
    capped. One function for both commands, so the condition and the message are the same. Raises Refused (exit 2)."""
    if "cut_max" not in config:
        raise Refused("config.json has no cut_max key: a run written before C3 cannot say whether its cut "
                      "checks were capped, so it is not compared")
    if config["cut_max"] is not None:
        raise Refused(f"config.json cut_max {json.dumps(config['cut_max'])}: a capped development run "
                      f"is not compared")


class Run:
    def __init__(self, run_dir, log=print):
        self.run = run_dir
        self.log = log
        self.py = os.path.join(run_dir, "py")
        self.ts = os.path.join(run_dir, "ts")
        self.gmo = os.path.join(run_dir, "gmo")
        self.files = {}
        self.allowed = []
        self.blind_hits = {}     # stage -> the blind row ids whose spec 13 suspicion hit (C3, D10)
        self.stage2_closed = []  # why stage 2 was not opened (C3, D8 / D10)

    # -------------------------------------------------------------------------------------------- setup
    def setup(self, refuse_plant=True, refuse_cut_max=False):
        mpath = os.path.join(self.run, "manifest.json")
        if not os.path.exists(mpath):
            raise Refused(f"{mpath}: no manifest.json")
        if os.path.abspath(self.run).startswith(os.path.abspath(str(ROOT / "research/.cache"))):
            raise Refused("a run folder under research/.cache")
        with open(mpath, "r", encoding="utf-8") as f:
            self.manifest = json.load(f)
        th = tree_sha256(self.gmo)
        if th != self.manifest.get("treeSha256"):
            raise Stop(f"treeSha256 {th} != manifest {self.manifest.get('treeSha256')}")
        cpath = os.path.join(self.ts, "config.json")
        if not os.path.exists(cpath):
            raise Stop(f"{cpath}: no config.json (the TS writes it first)")
        with open(cpath, "r", encoding="utf-8") as f:
            self.config = json.load(f)
        if self.config.get("plant"):
            if refuse_plant:
                raise Refused(f"config.json has a plant ({self.config['plant']}): nothing is compared")
        if refuse_cut_max:
            refuse_capped(self.config)
        want = self.config.get("spreadH1Sha256")
        got = sha256_file(ROOT / "research/ledger/spread-hours-h1.csv")
        if want is not None and want != got:
            raise Stop(f"config spreadH1Sha256 {want} != {got}")
        self.group = self.manifest.get("spec", {}).get("group")
        self.answer_knowing = self.group == "O"
        reg = load_registry()
        self.trials = []
        for tid in self.config["trials"]:
            if tid not in reg:
                raise Stop(f"config trial {tid} not in the candidates ledger")
            t = reg[tid]
            check_built(t)
            self.trials.append(t)
        self.trials.sort(key=lambda t: t["order"])
        self.reg = reg
        self.kappa = {"delta": max(1.0, float(self.config.get("kappaDelta", 1))),
                      "pl": max(1.0, float(self.config.get("kappaPl", 1)))}
        self.avoid = load_avoid_table(ROOT / "research/ledger/spread-hours-h1.csv")
        # dump.md 2 (round C2): `mode` is "syn" (the TS generated the run) or "walkfiles" (the TS read an existing
        # run's gmo folder). Both read a synthetic run with a generator manifest, so the data checks of spec 15 use
        # the synthetic price band (0.25-2.5 x the walk's start) for both; any other mode is not a synthetic run.
        mode = self.config.get("mode", "syn")
        if mode not in ("syn", "walkfiles"):
            raise Stop(f"config.json mode {mode!r}: the Python compares synthetic runs only (syn or walkfiles)")
        self.mode = "syn"
        self.checks = self._read_checks()
        self.ts_suspect = self._read_ts_suspect()
        self.adopt_map = {}

    def _read_checks(self):
        p = os.path.join(self.ts, "checks.csv")
        if not os.path.exists(p):
            self.log("WARN ts/checks.csv missing: checks_ok taken as false")
            return None
        with open(p, "r", encoding="utf-8", newline="") as f:
            return list(csv.DictReader(f))

    # dump.md 8 (TS only, checks.csv): the stage that made a check. Rule 2 is decided at the choice, so it reads only
    # the checks made before it; spec 23.2's cut of the chosen trials (stage1end) and stage 2's come after.
    CHECK_STAGES = ("gate", "stage0", "stage1", "stage1end", "stage2", "end")
    RULE2_STAGES = ("gate", "stage0", "stage1")

    def _check_rows(self, stages):
        out = []
        for r in self.checks:
            st = r.get("stage")
            if st is None:       # a checks.csv without the stage column (before round C2): every row counts
                out.append(r)
                continue
            if st not in self.CHECK_STAGES:
                raise Stop(f"ts/checks.csv: unknown stage {st!r} ({r.get('trial')} {r.get('name')})")
            if st in stages:
                out.append(r)
        return out

    def checks_ok(self, tid):
        """spec 10 rule 2: every `*` row and every row of the trial passed, among the rows of gate, stage0, stage1."""
        if self.checks is None:
            return False
        for r in self._check_rows(self.RULE2_STAGES):
            if r["trial"] in ("*", tid) and r["passed"] != "1":
                return False
        return True

    def stage1end_failed(self):
        """spec 23.2: the cut of the chosen trials at the end of stage 1 (checks.csv stage `stage1end`). Any failed
        row keeps the second half closed. -> the failed rows as text (empty when none, or with no stage column)."""
        if self.checks is None or not self.checks or "stage" not in self.checks[0]:
            return []
        return [f"{r['trial']} {r['name']}: {r.get('detail', '')}" for r in self._check_rows(("stage1end",))
                if r["passed"] != "1"]

    # dump.md 11.14 (a) / py-design 5.6 (C3, the lead's D8): a failed check of these stages keeps stage 2 closed
    # (spec 11 opens the second half once, and a run with a known failure must not use it).
    PRE_STAGE2_STAGES = ("gate", "stage0", "stage1", "stage1end")

    def pre_stage2_failed(self):
        """The failed rows of ts/checks.csv among the stages gate, stage0, stage1 and stage1end, as text (empty
        when none). A checks.csv without the stage column (before round C2) gives none, as stage1end_failed."""
        if self.checks is None or not self.checks or "stage" not in self.checks[0]:
            return []
        return [f"{r['stage']} {r['trial']} {r['name']}" for r in self._check_rows(self.PRE_STAGE2_STAGES)
                if r["passed"] != "1"]

    def cut_chosen_second_failed(self):
        """dump.md 11.14 (b) (C3, the lead's D9): the failed `cut.chosen.second` rows (stage stage2) of
        ts/checks.csv, as text. The cut is the TS's; the Python only reports it in its log."""
        if self.checks is None or not self.checks or "stage" not in self.checks[0]:
            return []
        return [f"{r['trial']} {r['name']}: {r.get('detail', '')}" for r in self._check_rows(("stage2",))
                if r["name"] == "cut.chosen.second" and r["passed"] != "1"]

    def stage2_closed_why(self):
        """dump.md 11.14 / py-design 5.6 (C3): the reasons stage 2 is not opened, as text; empty when it is opened.
        Opened only when K_total > 0, no blind row of the Python's own stage 1 hit (spec 13, the lead's D10), and no
        row of ts/checks.csv of the stages gate, stage0, stage1 or stage1end failed (the lead's D8)."""
        why = []
        if self.K_total == 0:
            why.append("no chosen trial (K_total 0)")
        hits = self.blind_hits.get("stage1", [])
        if hits:
            why.append("spec 13: a blind row hit at stage 1 (" + ", ".join(hits) + ")")
        bad = self.pre_stage2_failed()
        if bad:
            more = f" and {len(bad) - 20} more" if len(bad) > 20 else ""
            why.append("a TS check failed before stage 2 (" + "; ".join(bad[:20]) + more + ")")
        return why

    def _read_ts_suspect(self):
        p = os.path.join(self.ts, "suspect.csv")
        out = {}
        if not os.path.exists(p):
            return out
        with open(p, "r", encoding="utf-8", newline="") as f:
            for r in csv.DictReader(f):
                out[(r["stage"], r["half"], r["id"])] = r
        return out

    def out(self, name, header):
        c = CsvOut(os.path.join(self.py, name), header)
        self.files[name] = c
        return c

    # -------------------------------------------------------------------------------------------- loads
    def write_load(self, load, stage_name, load_csv, askbid_csv):
        for pair in PAIRS:
            for tf in TFS:
                c = load.counts[(pair, tf)]
                load_csv.row([stage_name, pair, tf, f_int(c["from_ms"]), f_int(c["to_ms"]), c["keys_first"],
                              c["keys_last"], f_int(c["keys"]), f_int(c["files_read"]), f_int(c["read_failures"]),
                              f_int(c["unparseable_rows"]), f_int(c["value_stops"]), f_int(c["dropped_ask_lt_bid"]),
                              f_int(c["same_start_bid_rows"]), f_int(c["bars"]), f_int(c["first_s"]),
                              f_int(c["last_s"]), f_int(c["ohlc_bad"]), f_int(c["dup_starts"]), f_int(c["band_bad"])])
                for y, (num, den) in sorted(load.askbid[(pair, tf)].items()):
                    if den:
                        askbid_csv.row([stage_name, pair, tf, f_int(y), f_int(num), f_int(den)])

    # -------------------------------------------------------------------------------------------- z-border adoption
    def build_adoption(self, load):
        """lawsearch-dump.md 9.2: at a B06 z-border bar, adopt the TS's rows of that bar and of the next bar."""
        sig = load_sig()
        border = {}
        for tf in TFS:
            if not any(t["kind"] == "B" and t["b"] == "B06" for t in self.trials if t["tf"] == tf):
                continue
            for pair in PAIRS:
                b = load.bars[(tf, pair)]
                bm = sig.bigmove(b["C"], b["s"], b["step"])
                z = np.asarray(bm["z"], dtype=np.float64)
                bs = set()
                for i in range(len(z)):
                    if not math.isnan(z[i]) and (abs(z[i] - 2) <= 2e-9 or abs(z[i] + 2) <= 2e-9):
                        bs.add(i)
                tsz = self._ts_ind_z(tf, pair)
                for i, zt in tsz.items():
                    if abs(zt - 2) <= 2e-9 or abs(zt + 2) <= 2e-9:
                        bs.add(i)
                if bs:
                    border[(tf, pair)] = bs
        self.border = border
        self.ts_sig = {}
        for t in self.trials:
            if t["kind"] == "B" and t["b"] == "B06":
                self.ts_sig[t["id"]] = self._read_ts_signals(t["id"])

    def _ts_ind_z(self, tf, pair):
        p = os.path.join(self.ts, "ind", f"{tf}_{SYM_OF[pair]}.csv")
        out = {}
        if not os.path.exists(p):
            return out
        with open(p, "r", encoding="utf-8", newline="") as f:
            for r in csv.DictReader(f):
                if r.get("BM_z"):
                    out[int(r["i"])] = float(r["BM_z"])
        return out

    def _read_ts_signals(self, tid):
        p = os.path.join(self.ts, "signals", f"{tid}.csv")
        if not os.path.exists(p):
            return None
        out = []
        with open(p, "r", encoding="utf-8", newline="") as f:
            for r in csv.DictReader(f):
                out.append(r)
        return out

    def adopt(self, trial, pair, rows):
        if trial["kind"] != "B" or trial["b"] != "B06":
            return rows
        bs = self.border.get((trial["tf"], pair))
        tsr = self.ts_sig.get(trial["id"])
        if not bs or tsr is None:
            return rows
        bars_at = set()
        for i in bs:
            bars_at.add(i)
            bars_at.add(i + 1)
        keep = [r for r in rows if r[4] not in bars_at]
        step = STEP[trial["tf"]]
        for r in tsr:
            if r["pair"] != pair:
                continue
            i = int(r["i"])
            if i not in bars_at:
                continue
            d = int(r["d"])
            T = int(r["T"])
            keep.append([T, PAIR_INDEX[pair], 0 if d == 1 else 1, pair, i, d, int(r["X"]), r["reason"], r["half"],
                         r["warm"] == "1", "emit" if r["reason"] not in ("f_none", "both") else r["reason"]])
        for i in sorted(bars_at):
            self.allowed.append(f"ALLOWED z-border {trial['tf']} {pair} i={i}")
        return keep

    # -------------------------------------------------------------------------------------------- stage 0
    def stage0(self):
        log = self.log
        log("stage 0: load [S0, END)")
        load = StageLoad(self.gmo, "syn0", S0, END, self.avoid, "", self.mode)
        self.write_load(load, "syn0", self.load_csv, self.askbid_csv)
        if load.stops:
            raise Stop("stage 0 load: " + "; ".join(load.stops[:10]))
        self.build_adoption(load)
        # bars, htf, holes
        for tf in TFS:
            for pair in PAIRS:
                b = load.bars[(tf, pair)]
                p = pair
                bo = self.out(f"bars/{tf}_{SYM_OF[pair]}.csv",
                              ["i", "s", "bo", "bh", "bl", "bc", "ao", "ah", "al", "ac", "O", "H", "L", "C", "Po", "Ph",
                               "Pl", "Pc", "Bo", "Bh", "Bl", "Bc", "Ao", "Ah", "Al", "Ac", "day", "g"])
                for i in range(b["n"]):
                    bo.row([str(i), str(b["slist"][i])] + [dec(b[k][i], p) for k in _SIDE_KEYS]
                           + [f_real(b[k][i]) for k in _MID_KEYS] + [f_int(b[k][i]) for k in _PT_KEYS]
                           + [f_int(b[k][i]) for k in _BPT_KEYS] + [f_int(b["day"][i]), f_int(b["g"][i])])
                h = b["htf"]
                ho = self.out(f"htf/{tf}_{SYM_OF[pair]}.csv",
                              ["i", "s", "bo", "bh", "bl", "bc", "ao", "ah", "al", "ac", "O", "H", "L", "C", "Po", "Ph",
                               "Pl", "Pc"])
                for k in range(h["n"]):
                    ho.row([str(k), str(h["slist"][k])] + [dec(h[c][k], p) for c in _SIDE_KEYS]
                           + [f_real(h[c][k]) for c in _MID_KEYS] + [f_int(h[c][k]) for c in _PT_KEYS])
        hs = self.out("holes/summary.csv", ["tf", "pair", "from_ms", "n_slots", "open_slots", "present_slots",
                                            "hole_slots"])
        for tf in TFS:
            hl = self.out(f"holes/{tf}.csv", ["pair", "slot"])
            for pair in PAIRS:
                g0, ns, no, npres, nh = load.hole_summary[tf][pair]
                hs.row([tf, pair, str(g0), str(ns), str(no), str(npres), str(nh)])
                for a in load.holes[tf][pair]:
                    hl.row([pair, str(a)])
        # signals
        self.sig0 = {}
        for t in self.trials:
            log(f"  signals {t['id']}")
            rows = signal_rows(load, t, self.answer_knowing, self.adopt)
            self.sig0[t["id"]] = rows
            so = self.out(f"signals/{t['id']}.csv", ["pair", "i", "d", "T", "X", "reason", "half", "warm"])
            for r in rows:
                so.row([r[3], str(r[4]), str(r[5]), str(r[0]), str(r[6]), r[7], r[8], f_bool(r[9])])
        self.write_ind(load)
        # stage0.csv
        s0 = self.out("stage0.csv", ["trial", "key", "value"])
        tot = {"first": {}, "second": {}}
        info = {}
        for t in self.trials:
            rows = self.sig0[t["id"]]
            info[t["id"]] = self.stage0_counts(load, t, rows)
        # same trial, groups
        same = {}
        groups = {}
        for tf in TFS:
            ts_ = [t for t in self.trials if t["tf"] == tf]
            same.update(same_as_map([{"id": t["id"], "tf": tf, "keys": info[t["id"]]["keys"]} for t in ts_]))
            groups.update(group_map([{"id": t["id"], "kind": t["kind"], "e": t["e"], "b": t["b"],
                                      "floor": info[t["id"]]["floor"], "sigs": info[t["id"]]["keys_list"]}
                                     for t in ts_], STEP[tf]))
        self.info0 = info
        self.same = same
        self.groups = groups
        for t in self.trials:
            I = info[t["id"]]
            for k, v in I["half"]["first"]:
                s0.row([t["id"], f"first.{k}", v])
            # spec 9 後半 / 23.3: per trial, the second half has only its counted signals and weeks (the breakdown by
            # pair, direction and reason goes to stage0_totals.csv only)
            n2, w2 = I["second"]
            s0.row([t["id"], "second.counted", str(n2)])
            s0.row([t["id"], "second.weeks", str(w2)])
            # dump.md 7 (C3, D1): of the whole-range counts, only the trial's adds-up 1/0 is written per trial
            s0.row([t["id"], "all.adds_up", f_bool(I["adds_up"])])
            s0.row([t["id"], "floor", f_bool(I["floor"])])
            s0.row([t["id"], "same_as", f_text(same[t["id"]])])
            s0.row([t["id"], "group", f_text(groups[t["id"]])])
            # spec 9 見分けられる大きさ: no g in the trial (config "g": {}), so g .. mark are empty
            for k in ("g", "df", "pass_min", "mde", "mark"):
                s0.row([t["id"], k, ""])
            # spec 9 段3の数の見込み / 23.3: n2 x 52 / 76, written with or without g (dump 7: left to right)
            s0.row([t["id"], "stage3_estimate", f_real((n2 * 52) / 76)])
            for half in ("first", "second"):
                for k, v in I["tot"][half].items():
                    tot[half][k] = tot[half].get(k, 0) + v
        st = self.out("stage0_totals.csv", ["half", "key", "value"])
        for half in ("first", "second"):
            for k, v in tot[half].items():
                st.row([half, k, str(v)])
        for tf in TFS:
            gs = {groups[t["id"]] for t in self.trials if t["tf"] == tf and groups[t["id"]] is not None}
            st.row(["", f"groups.{tf}", str(len(gs))])
        for tf in TFS:
            st.row(["", f"floor.{tf}", str(sum(1 for t in self.trials if t["tf"] == tf and info[t["id"]]["floor"]))])
        # dump.md 7 (C3, the lead's D1): the whole-range counts, summed over each timeframe's trials (table order,
        # int addition), after floor.h1: all.emitted.m15, all.emitted.h1, all.r1.m15, ... all.r1b.h1
        for k in ("all.emitted", "all.r1", "all.r1w", "all.r1b"):
            for tf in TFS:
                n = 0
                for t in self.trials:
                    if t["tf"] == tf:
                        n += info[t["id"]]["all_counts"][k]
                st.row(["", f"{k}.{tf}", str(n)])
        self.load0 = load

    def stage0_counts(self, load, t, rows):
        tf = t["tf"]
        out = {"half": {}, "tot": {"first": {}, "second": {}}}
        for half in ("first", "second"):
            cnt = [r for r in rows if r[7] == "counted" and r[8] == half]
            weeks = len({wk(r[0]) for r in cnt})
            kv = [("counted", str(len(cnt))), ("weeks", str(weeks))]
            tot = out["tot"][half]
            for p in PAIRS:
                for d, nm in ((1, "buy"), (-1, "sell")):
                    n = sum(1 for r in cnt if r[3] == p and r[5] == d)
                    kv.append((f"pd.{SYM_OF[p]}.{nm}", str(n)))
                    tot[f"pd.{SYM_OF[p]}.{nm}"] = n
            for code in REASON_CODES:
                if code in ("r1", "r1w", "r1b"):
                    n = sum(1 for r in rows if r[7] == code and ((r[0] < SPLIT) == (half == "first")))
                else:
                    n = sum(1 for r in rows if r[7] == code and r[8] == half)
                kv.append((f"reason.{code}", str(n)))
                tot[f"reason.{code}"] = n
            nt = 0
            nb = 0
            for r in cnt:
                tr = load.trade(tf, r[3], r[4], r[5])
                if tr is None:
                    nt += 1
                    continue
                pb = load.per_bar[(tf, r[3])]
                if not (pb["half"][r[4]] == half and pb["hit"][r[4]] is None):
                    nb += 1
            if nb:
                # spec 6 外す理由の後で数えるもの: 0 by construction; otherwise a program error that stops. The second
                # half's count is no longer written (23.3), so the check is made here for both halves.
                # (C3) the message names the trial and the half; the second half's count is not shown (spec 9 後半,
                # 23.3: a trial's second-half numbers wait for stage 2), as the TS's stop (the lead's D4)
                n_txt = f"{nb} " if half == "first" else ""
                raise Stop(f"stage 0 {t['id']} {half}: {n_txt}counted signals with a trade but no blind bar "
                           f"(spec 6: a program error)")
            kv.append(("no_trade", str(nt)))
            kv.append(("no_blind", str(nb)))
            kv.append(("per_week", f_real(len(cnt) / HALF_WEEKS[half])))
            out["half"][half] = kv
            out[half] = (len(cnt), weeks)
        em = [r for r in rows if r[10] == "emit"]
        n1 = sum(1 for r in rows if r[7] == "r1")
        n1w = sum(1 for r in rows if r[7] == "r1w")
        n1b = sum(1 for r in rows if r[7] == "r1b")
        rest = sum(1 for r in rows if r[7] in ("r2", "r3", "r4", "r5", "r6", "counted") and r[8] in ("first", "second"))
        # dump.md 7 / 11.7 (C3, the lead's D1): the four whole-range counts span both halves, so with the first-half
        # keys they would give the trial's second-half numbers (spec 9 後半, 23.3). They are kept here for the
        # trial's own adds-up rule and summed per timeframe into stage0_totals.csv; per trial only the 1/0 is written.
        out["all_counts"] = {"all.emitted": len(em), "all.r1": n1, "all.r1w": n1w, "all.r1b": n1b}
        out["adds_up"] = len(em) == n1 + n1w + n1b + rest
        out["floor"] = floor_pass(out["first"][0], out["first"][1], out["second"][0], out["second"][1])
        fc = [r for r in rows if r[7] == "counted" and r[8] == "first"]
        out["keys"] = {(r[3], r[0], r[5]) for r in fc}
        out["keys_list"] = [(r[3], r[0], r[5]) for r in fc]
        return out

    def write_ind(self, load):
        sig = load_sig()
        order = ["RSI14", "RSI14_U", "RSI14_D", "E04_buy", "E04_sell", "DON20_HH", "DON20_LL", "DON20_s", "EMA200",
                 "F01_buy", "F01_sell", "BM_r", "BM_ok", "BM_sigma", "BM_z", "B06_buy", "B06_sell", "B06_keep"]
        for tf in TFS:
            trials = [sig_trial(t) for t in self.trials if t["tf"] == tf]
            for pair in PAIRS:
                b = load.bars[(tf, pair)]
                # dump.md 11.11: in a group O run, DON20_s is the planted target the trial used
                cols = sig.ind_columns(trials, b, answer_knowing=self.answer_knowing)
                names = [c for c in order if c in cols] + [c for c in cols if c not in order]
                want = set(range(0, b["n"], 97))
                for t in self.trials:
                    if t["tf"] != tf:
                        continue
                    for r in self.sig0[t["id"]]:
                        if r[3] == pair:
                            want.add(r[4])
                ind_out = self.out(f"ind/{tf}_{SYM_OF[pair]}.csv", ["i"] + names)
                arrs = [np.asarray(cols[c]) for c in names]
                for i in sorted(want):
                    vals = [str(i)]
                    for c, a in zip(names, arrs):
                        v = a[i]
                        if c == "DON20_s":
                            vals.append(str(int(v)))
                        elif a.dtype == np.bool_:
                            vals.append(f_bool(bool(v)))
                        elif a.dtype.kind in "iu":
                            vals.append(f_tri(int(v)))
                        else:
                            vals.append(f_real(float(v)))
                    ind_out.row(vals)

    # -------------------------------------------------------------------------------------------- tables
    def write_tables(self, bl, tf, half):
        tab = bl["tab"]
        bo = self.out(f"blind/{tf}_{half}.csv", ["row", "pair", "i", "T", "d", "j", "x", "subst", "m", "h", "pl", "absm",
                                                 "hour", "season", "stratum", "week"])
        for r, row in enumerate(tab.rows):
            bo.row([str(r), row["pair"], str(row["i"]), str(row["T"]), str(row["d"]), str(row["j"]), str(row["x"]),
                    f_bool(row["subst"]), str(row["m"]), str(row["h"]), str(row["pl"]), str(row["absm"]),
                    str(row["hour"]), str(row["season"]), str(row["stratum"]), str(row["week"])])
        lo = self.out(f"late/{tf}_{half}.csv", ["row", "base_row", "pair", "i", "T", "d", "j", "x", "subst", "m", "h",
                                                "pl", "absm", "hour", "season", "stratum", "week"])
        for r, row in enumerate(bl["late"].rows):
            lo.row([str(r), str(row["base_row"]), row["pair"], str(row["i"]), str(row["T"]), str(row["d"]),
                    str(row["j"]), str(row["x"]), f_bool(row["subst"]), str(row["m"]), str(row["h"]), str(row["pl"]),
                    str(row["absm"]), str(row["hour"]), str(row["season"]), str(row["stratum"]), str(row["week"])])
        c = bl["counts"]
        self.blind_counts.row([tf, half, str(c["rows"]), str(c["passed_bars"]), str(c["no_trade_bars"]),
                               str(c["weeks"]), str(c["late_rows"]), str(c["late_no_entry"]), str(c["late_r4"]),
                               str(c["late_end"])])

    def write_trades(self, th, bl):
        tab = bl["tab"]
        late = bl["late"]
        to = self.out(f"trades/{th.trial['id']}_{th.half}.csv",
                      ["pair", "i", "T", "d", "row", "j", "x", "subst", "m", "h", "pl", "stratum", "week", "late_row",
                       "late_why", "late_m", "late_h", "late_pl"])
        for r in th.sig:
            row = tab.rows[r]
            lr = bl["late_of"].get(r)
            if lr is None:
                late_part = ["-1", bl["why_of"][r], "", "", ""]
            else:
                L = late.rows[lr]
                late_part = [str(lr), "", str(L["m"]), str(L["h"]), str(L["pl"])]
            to.row([row["pair"], str(row["i"]), str(row["T"]), str(row["d"]), str(r), str(row["j"]), str(row["x"]),
                    f_bool(row["subst"]), str(row["m"]), str(row["h"]), str(row["pl"]), str(row["stratum"]),
                    str(row["week"])] + late_part)

    def write_measures(self, stage, half, tid, th, res, stage2=False):
        tab = res["tab"]
        ms = res["ms"]
        c = ms["core"]
        for s in sorted(c["n_s"]):
            self.strata.row([stage, half, tid, str(s), str(c["n_s"][s]), str(tab.m_s[s]), f_real(c["mean_s"][s]),
                             f_real(tab.B_s[s]), f_real(tab.pl_s[s]), f_real(tab.absm_s[s])])
        kv = [("counted", f_int(len(th.counted))), ("no_trade", f_int(th.no_trade)), ("no_blind", f_int(th.no_blind)),
              ("N", f_int(c["N"])), ("weeks", f_int(th.weeks)), ("strata", f_int(len(c["n_s"])))]
        for vn in ("delta", "a", "pl", "delta_late", "dF"):
            vb = res["values"].get(vn)
            if vb is None:
                continue
            kv += v_keys(vn, vb)
        v, w, n = res["pl_ex1w"]
        kv += [("pl_ex1w", f_real(v)), ("ex1w_week", f_int(w)), ("w_count", f_int(c["w_count"])),
               ("w_rate", f_real(c["w_rate"])), ("blind_pl_w", f_real(c["blind_pl_w"])),
               ("pl_minus_blind", f_real(c["pl_minus_blind"])), ("M", f_real(c["M"]))]
        kv += self._pair_dir_keys(tab, th.sig)
        lm = res["lm"]["core"]
        kv += [("pl_late", f_real(lm["pl"])), ("late_N", f_int(lm["N"])),
               ("late_excl.no_entry", f_int(th.late_ex["no_entry"])), ("late_excl.r4", f_int(th.late_ex["r4"])),
               ("late_excl.end", f_int(th.late_ex["end"]))]
        kv.append(("dF.against", f_text(res.get("against"))))
        nN, nd, npl = res["nov"]
        kv += [("nov.N", f_int(nN)), ("nov.delta", f_real(nd)), ("nov.pl", f_real(npl))]
        if stage2:
            ex = res["extras2"]
            for k in ("delta_dir.buy", "delta_dir.sell"):
                kv.append((k, f_real(ex[k])))
            for k in ("counted_dir.buy", "counted_dir.sell"):
                kv.append((k, f_int(ex[k])))
            for p in PAIRS:
                kv.append((f"delta_pair.{SYM_OF[p]}", f_real(ex[f"delta_pair.{SYM_OF[p]}"])))
            for p in PAIRS:
                kv.append((f"counted_pair.{SYM_OF[p]}", f_int(ex[f"counted_pair.{SYM_OF[p]}"])))
            kv += [("c6.a", f_real(ex["c6.a"])), ("c6.b", f_real(ex["c6.b"]))]
        for k, v in kv:
            self.measures.row([stage, half, tid, k, v])
        # shift.csv: delta, pl, a, delta_late
        for vn, sh, kind in (("delta", ms["shift"], "delta"), ("pl", ms["shift"], "pl"), ("a", ms["shift"], "a"),
                             ("delta_late", res["lm"]["shift"], "delta")):
            for (k, n, dropped, vals) in sh:
                self.shift.row([stage, half, tid, vn, str(k), str(n), str(dropped), f_real(vals.get(kind))])
        # clusters.csv: delta, a, pl, delta_late, dF
        for vn in ("delta", "a", "pl", "delta_late", "dF"):
            vb = res["values"].get(vn)
            if vb is None:
                continue
            for kind, S in (("week", vb["S_week"]), ("4w", vb["S_4w"])):
                if kind == "4w" and not vb["four"]:
                    continue
                for g in sorted(S):
                    self.clusters.row([stage, half, tid, vn, kind, str(g), f_real(S[g])])

    def _pair_dir_keys(self, tab, sig):
        kv = []
        for p in PAIRS:
            rs = [r for r in sig if tab.pi[r] == PAIR_INDEX[p]]
            kv.append((f"pl_pair.{SYM_OF[p]}", f_real(pl_mean(tab, rs))))
        for p in PAIRS:
            kv.append((f"n_pair.{SYM_OF[p]}", f_int(sum(1 for r in sig if tab.pi[r] == PAIR_INDEX[p]))))
        b = [r for r in sig if tab.d[r] == 1]
        s = [r for r in sig if tab.d[r] == -1]
        kv += [("pl_buy", f_real(pl_mean(tab, b))), ("pl_sell", f_real(pl_mean(tab, s))), ("n_buy", f_int(len(b))),
               ("n_sell", f_int(len(s)))]
        return kv

    def write_blind_measures(self, stage, half, bls):
        for tf in TFS:
            bl = bls[tf]
            tab = bl["tab"]
            for pair in PAIRS:
                for d, nm in ((1, "buy"), (-1, "sell")):
                    rid = f"blind.{tf}.{SYM_OF[pair]}.{nm}"
                    sig, ms = blind_measure(bl, tf, pair, d)
                    c = ms["core"]
                    no_trade = 0
                    kv = [("counted", f_int(len(sig))), ("no_trade", f_int(no_trade)), ("no_blind", "0"),
                          ("N", f_int(c["N"])), ("weeks", f_int(len({tab.week[r] for r in sig}))),
                          ("strata", f_int(len(c["n_s"])))]
                    kv += v_keys("a", ms["a"])
                    kv += v_keys("pl", ms["pl"])
                    v, w, n = pl_ex1w(tab, sig)
                    kv += [("pl_ex1w", f_real(v)), ("ex1w_week", f_int(w)), ("w_count", f_int(c["w_count"])),
                           ("w_rate", f_real(c["w_rate"])), ("blind_pl_w", f_real(c["blind_pl_w"])),
                           ("pl_minus_blind", f_real(c["pl_minus_blind"])), ("M", f_real(c["M"]))]
                    kv += self._pair_dir_keys(tab, sig)
                    for k, v in kv:
                        self.measures.row([stage, half, rid, k, v])
                    su = suspicion(len(sig), None, c["a"], c["pl"], c["M"], None, c["W"], is_blind=True)
                    self.write_suspect(stage, half, rid, su)
                    self.note_blind(stage, rid, su)

    def note_blind(self, stage, rid, su):
        """spec 13 物差しが当たったら、すべて止めて調べる (C3, the lead's D10): a blind row whose suspicion hits stops the
        run at the end of this stage (dump.md 11.14 (c)). The stage's files are still written in full."""
        if su["hit"]:
            self.blind_hits.setdefault(stage, []).append(rid)

    def write_suspect(self, stage, half, rid, su):
        tsr = self.ts_suspect.get((stage, half, rid), {})
        self.suspect.row([stage, half, rid, f_bool(su["looked"]), f_bool(su["hit_delta"]), f_bool(su["hit_a"]),
                          f_bool(su["hit_pl"]), f_bool(su["hit_late"]), f_bool(su["hit_W"]), f_bool(su["hit"])]
                         + [tsr.get(k, "") for k in ("cut", "poison1000", "presence", "retrace", "hand",
                                                     "checks_passed")])

    def trial_halves(self, load, sigs, bls, half, ids):
        """TrialHalf objects for ids, plus the S rows their D_F needs."""
        need = list(ids)
        for tid in ids:
            t = self.reg[tid]
            if t["kind"] == "EF" and t["f"] in DIRECTIONAL_F:
                sid = f"{t['tf']}.{S_OF_F.get(t['f'], '?')}"
                if t["f"] not in S_OF_F or sid not in self.reg:
                    raise NotBuilt(f"D_F of {tid}: its S row for {t['f']} is not written yet")
                if sid not in need:
                    need.append(sid)
        out = {}
        for tid in need:
            t = self.reg[tid]
            if tid not in sigs:
                check_built(t)
                sigs[tid] = signal_rows(load, t, self.answer_knowing, self.adopt)
            out[tid] = TrialHalf(load, t, sigs[tid], bls[t["tf"]], half)
        return out

    # -------------------------------------------------------------------------------------------- stage 1
    def stage1(self):
        log = self.log
        log("stage 1: load [S0, SPLIT)")
        load = StageLoad(self.gmo, "syn1", S0, SPLIT, self.avoid, "", self.mode)
        self.write_load(load, "syn1", self.load_csv, self.askbid_csv)
        if load.stops:
            raise Stop("stage 1 load: " + "; ".join(load.stops[:10]))
        for tf in TFS:
            for pair in PAIRS:
                b = load.bars[(tf, pair)]
                if b["n"] and b["slist"][-1] + b["step"] > SPLIT:
                    raise Stop("h1Only: a stage 1 bar closes after SPLIT")
        bls = {tf: load.blind(tf, "first") for tf in TFS}
        for tf in TFS:
            self.write_tables(bls[tf], tf, "first")
        measured = [t["id"] for t in self.trials if self.info0[t["id"]]["floor"] and self.same[t["id"]] is None]
        sigs = {}
        for t in self.trials:
            sigs[t["id"]] = signal_rows(load, t, self.answer_knowing, self.adopt)
        ths = self.trial_halves(load, sigs, bls, "first", measured)
        res = {}
        rows1 = []
        for tid in measured:
            t = self.reg[tid]
            th = ths[tid]
            s_th = None
            against = None
            if t["kind"] == "EF" and t["f"] in DIRECTIONAL_F:
                against = f"{t['tf']}.{S_OF_F[t['f']]}"
                s_th = ths[against]
            log(f"  measures {tid}")
            r = measure_trial(th, bls[t["tf"]], s_th)
            r["against"] = against
            res[tid] = r
            self.write_trades(th, bls[t["tf"]])
            self.write_measures("stage1", "first", tid, th, r)
            c = r["ms"]["core"]
            su = suspicion(len(th.counted), c["delta"], c["a"], c["pl"], c["M"], r["lm"]["core"]["delta"], c["W"])
            self.write_suspect("stage1", "first", tid, su)
            tsr = self.ts_suspect.get(("stage1", "first", tid), {})
            scp = sus_checks_passed_of(tsr)
            dch = r["values"]["delta"]["choice"]
            dF = r["values"]["dF"]["value"] if "dF" in r["values"] else None
            info = {"pass_floor": True, "same": False, "checks_ok": self.checks_ok(tid), "has_t": dch["has_t"],
                    "delta": c["delta"], "pl": c["pl"], "pl_ex1w": r["pl_ex1w"][0],
                    "directional": against is not None, "dF": dF, "suspicious": su["hit"],
                    "sus_checks_passed": scp == "1"}
            fr = fail_rule_of(info, "a")
            p_iut = max(dch["p"], r["values"]["pl"]["choice"]["p"])
            rows1.append({"id": tid, "t": t, "info": info, "fr": fr, "lb": dch["lb"], "n": len(th.counted),
                          "p_iut": p_iut, "scp": scp, "dF": dF})
        self.write_blind_measures("stage1", "first", bls)
        # choice per tf
        chosen_all = {}
        ranks = {}
        skipped = {}
        for tf in TFS:
            rr = [{"name": x["id"], "order": x["t"]["order"], "kind": x["t"]["kind"],
                   "f": x["t"]["f"] if x["t"]["kind"] != "B" else None, "group": self.groups[x["id"]],
                   "fail_rule": x["fr"], "lb": x["lb"] if x["lb"] is not None else -math.inf, "n": x["n"]}
                  for x in rows1 if x["t"]["tf"] == tf]
            order, chosen, sk, rank = choose_tf(rr)
            chosen_all[tf] = chosen
            ranks.update(rank)
            for (n, why, by) in sk:
                skipped[n] = (why, by)
        s1 = self.out("stage1.csv", ["trial", "key", "value"])
        for x in rows1:
            tid = x["id"]
            I = x["info"]
            kv = [("pass_floor", f_bool(True)), ("same", f_bool(False)), ("checks_ok", f_bool(I["checks_ok"])),
                  ("has_t", f_bool(I["has_t"])), ("delta", f_real(I["delta"])), ("lb", f_real(x["lb"])),
                  ("pl", f_real(I["pl"])), ("pl_ex1w", f_real(I["pl_ex1w"])), ("dF", f_real(x["dF"])),
                  ("suspicious", f_bool(I["suspicious"])),
                  ("sus_checks_passed", x["scp"] if x["scp"] in ("0", "1") else ""), ("n", f_int(x["n"])),
                  ("group", f_text(self.groups[tid])), ("fail_rule", f_int(x["fr"])), ("rank", f_int(ranks.get(tid))),
                  ("chosen", f_bool(tid in chosen_all[x["t"]["tf"]])),
                  ("skipped_reason", f_text(skipped.get(tid, (None, None))[0])),
                  ("skipped_by", f_text(skipped.get(tid, (None, None))[1])), ("p_iut", f_real(x["p_iut"]))]
            for k, v in kv:
                s1.row([tid, k, v])
        K = len(chosen_all["m15"]) + len(chosen_all["h1"])
        lbp = [x for x in rows1 if gt0(x["lb"])]
        gset = {self.groups[x["id"]] or x["id"] for x in lbp}
        bh, _ = bh_count([x["p_iut"] for x in rows1]) if rows1 else (0, [])
        ss = self.out("stage1_summary.csv", ["key", "value"])
        for k, v in (("K_total", str(K)), ("chosen.m15", "|".join(chosen_all["m15"])),
                     ("chosen.h1", "|".join(chosen_all["h1"])), ("lb_pos", str(len(lbp))),
                     ("lb_pos_groups", str(len(gset))),
                     ("lb_and_pl_pos", str(sum(1 for x in lbp if gt0(x["info"]["pl"])))),
                     ("bh_m", str(len(rows1))), ("bh_pass", str(bh))):
            ss.row([k, v])
        self.chosen = chosen_all
        self.K_total = K
        self.rows1 = {x["id"]: x for x in rows1}

    # -------------------------------------------------------------------------------------------- stage 2
    def stage2(self):
        """Stage 2. compute() opens it only when stage2_closed_why() is empty (C3: K_total > 0, no own stage-1
        blind hit, no failed TS check before stage 2; spec 23.2's failed cut of the chosen trials is one of them)."""
        log = self.log
        cut2 = self.cut_chosen_second_failed()
        if cut2:
            # dump.md 11.14 (b) (the lead's D9): the TS withholds stage 2's numbers in print.txt; its dumps are
            # written, and the Python computes, writes and compares stage 2's files as usual
            log("stage 2: the TS's cut.chosen.second failed (the TS withholds stage 2's numbers in print.txt; "
                "stage 2's files are written and compared as usual): " + "; ".join(cut2[:10]))
        log("stage 2: load [S0, END)")
        load = StageLoad(self.gmo, "syn2", S0, END, self.avoid, "", self.mode)
        self.write_load(load, "syn2", self.load_csv, self.askbid_csv)
        if load.stops:
            raise Stop("stage 2 load: " + "; ".join(load.stops[:10]))
        bls = {tf: load.blind(tf, "second") for tf in TFS}
        for tf in TFS:
            self.write_tables(bls[tf], tf, "second")
        chosen = [t["id"] for t in self.trials if t["id"] in self.chosen["m15"] + self.chosen["h1"]]
        sigs = {}
        ths = self.trial_halves(load, sigs, bls, "second", chosen)
        res = {}
        for tid in chosen:
            t = self.reg[tid]
            th = ths[tid]
            s_th = None
            against = None
            if t["kind"] == "EF" and t["f"] in DIRECTIONAL_F:
                against = f"{t['tf']}.{S_OF_F[t['f']]}"
                s_th = ths[against]
            log(f"  measures {tid}")
            r = measure_trial(th, bls[t["tf"]], s_th, kappa=self.kappa, stage2=True)
            r["against"] = against
            r["th"] = th
            res[tid] = r
            self.write_trades(th, bls[t["tf"]])
            self.write_measures("stage2", "second", tid, th, r, stage2=True)
            c = r["ms"]["core"]
            r["su"] = suspicion(len(th.counted), c["delta"], c["a"], c["pl"], c["M"], r["lm"]["core"]["delta"], c["W"])
            self.write_suspect("stage2", "second", tid, r["su"])
        self.write_blind_measures("stage2", "second", bls)
        K = self.K_total
        hr, hd = [], []
        for tid in chosen:
            r = res[tid]
            dch = r["values"]["delta"]["choice"]
            pch = r["values"]["pl"]["choice"]
            tmin = min(dch["t"], pch["t"]) if (dch["t"] is not None and pch["t"] is not None) else 0.0
            r["p_iut"] = max(dch["p"], pch["p"])
            n = len(r["th"].counted)
            hr.append({"name": tid, "p": r["p_iut"], "tmin": tmin, "n": n, "order": self.reg[tid]["order"]})
            hd.append({"name": tid, "p": dch["p"], "tmin": dch["t"] if dch["t"] is not None else 0.0, "n": n,
                       "order": self.reg[tid]["order"]})
        H = {r["name"]: (k, ok) for (k, r, thr, ok) in holm(hr, K)}
        HD = {r["name"]: (k, ok) for (k, r, thr, ok) in holm(hd, K)}
        s2 = self.out("stage2.csv", ["trial", "key", "value"])
        q = 1 - 0.025 / K
        for tid in chosen:
            r = res[tid]
            th = r["th"]
            vd = r["values"]["delta"]
            dch = vd["choice"]
            pch = r["values"]["pl"]["choice"]
            lch = r["values"]["delta_late"]["choice"]
            ex = r["extras2"]
            dirs = {d: (ex[f"counted_dir.{nm}"], ex[f"delta_dir.{nm}"]) for d, nm in ((1, "buy"), (-1, "sell"))}
            pairs = {p: (ex[f"counted_pair.{SYM_OF[p]}"], ex[f"delta_pair.{SYM_OF[p]}"]) for p in PAIRS}
            tsr = self.ts_suspect.get(("stage2", "second", tid), {})
            C = conditions({"dirs": dirs, "pairs": pairs, "late_lb": lch["lb"], "pl_late": r["lm"]["core"]["pl"],
                            "delta_late": r["lm"]["core"]["delta"], "suspicious": r["su"]["hit"],
                            "sus_checks_passed": sus_checks_passed_of(tsr) == "1", "c6": (ex["c6.a"], ex["c6.b"]),
                            "pl_ex1w": r["pl_ex1w"][0], "pl": r["ms"]["core"]["pl"]}, "a")
            C1 = H[tid][1]
            vt = verdict_texts(C1, C, dch["ub"], HD[tid][1])
            mde = None
            if dch["has_t"]:
                pc = vd["cands"][dch["use_p"]]
                mde = (t_quantile(q, pc["df"]) + t_quantile(0.80, pc["df"])) * pc["se"]
            _, w = widest_at(r["ms"]["core"]["delta"], vd["cands"], q) if dch["has_t"] else (None, None)
            sim_lb = r["ms"]["core"]["delta"] - w if w is not None else None
            dfb = r["values"].get("dF")
            dlo = dfb["choice"]["lb"] if dfb else None
            dhi = dfb["choice"]["ub"] if dfb else None
            kv = [("kappa_delta", f_real(self.kappa["delta"])), ("kappa_pl", f_real(self.kappa["pl"])),
                  ("p_delta", f_real(dch["p"])), ("p_pl", f_real(pch["p"])), ("p_iut", f_real(r["p_iut"])),
                  ("t_delta", f_real(dch["t"])), ("t_pl", f_real(pch["t"])),
                  ("holm_rank", str(H[tid][0])), ("holm_pass", f_bool(H[tid][1])),
                  ("holm_delta_rank", str(HD[tid][0])), ("holm_delta_pass", f_bool(HD[tid][1]))]
            kv.append(("C1", f_bool(C1)))
            for k in ("C2", "C3", "C4", "C5", "C6", "C7"):
                kv.append((k, f_bool(C[k])))
            kv += [("verdict", vt["verdict"]), ("label", vt["label"]), ("failed", vt["failed"]),
                   ("mde", f_real(mde)), ("sim_lb", f_real(sim_lb)), ("delta_ub", f_real(dch["ub"])),
                   ("late_lb", f_real(lch["lb"])), ("dF_lo", f_real(dlo)), ("dF_hi", f_real(dhi)),
                   ("no_uplift", f_bool(le0(dlo)) if dfb else "")]
            for k, val in kv:
                s2.row([tid, k, val])

    # -------------------------------------------------------------------------------------------- all
    def compute(self):
        if os.path.isdir(self.py):
            import shutil
            shutil.rmtree(self.py)
        os.makedirs(self.py)
        self.load_csv = self.out("load.csv", ["stage", "pair", "tf", "from_ms", "to_ms", "keys_first", "keys_last",
                                              "keys", "files_read", "read_failures", "unparseable_rows", "value_stops",
                                              "dropped_ask_lt_bid", "same_start_bid_rows", "bars", "first_s", "last_s",
                                              "ohlc_bad", "dup_starts", "band_bad"])
        self.askbid_csv = self.out("askbid.csv", ["stage", "pair", "tf", "year", "num", "den"])
        self.blind_counts = self.out("blind_counts.csv", ["tf", "half", "rows", "passed_bars", "no_trade_bars", "weeks",
                                                          "late_rows", "late_no_entry", "late_r4", "late_end"])
        self.strata = self.out("strata.csv", ["stage", "half", "trial", "stratum", "n", "m", "sig_mean", "B",
                                              "blind_pl_mean", "absm_mean"])
        self.measures = self.out("measures.csv", ["stage", "half", "trial", "key", "value"])
        self.shift = self.out("shift.csv", ["stage", "half", "trial", "value", "k", "n", "dropped", "v"])
        self.clusters = self.out("clusters.csv", ["stage", "half", "trial", "value", "kind", "g", "S_g"])
        self.suspect = self.out("suspect.csv", ["stage", "half", "id", "looked", "hit_delta", "hit_a", "hit_pl",
                                                "hit_late", "hit_W", "hit", "cut", "poison1000", "presence", "retrace",
                                                "hand", "checks_passed"])
        self.blind_hits = {}
        self.stage2_closed = []
        try:
            self.stage0()
            self.stage1()
            why = self.stage2_closed_why()
            if why:
                # dump.md 11.14 (a), (c): no stage-2 file or row is written; the comparison is still made
                self.log("stage 2: not opened: " + " | ".join(why))
                self.stage2_closed = why
            else:
                self.stage2()
            for st in ("stage1", "stage2"):
                for rid in self.blind_hits.get(st, []):
                    self.log(f"STOP 13 {st} {rid}: a blind row hit spec 13's lines (the run stops at the end of "
                             f"{st})")
        finally:
            for c in self.files.values():
                c.write()


# ----------------------------------------------------------------------------------------------------------------
# 17. The comparator (lawsearch-dump.md 9, 10)
# ----------------------------------------------------------------------------------------------------------------

# dump.md 10 (C3): cut_fail.csv is TS only too (the Python does not run the cut, lawsearch-dump.md 8)
TS_ONLY = {"checks.csv", "choice.json", "print.txt", "config.json", "cut_fail.csv"}
SUSPECT_TS_COLS = {"cut", "poison1000", "presence", "retrace", "hand", "checks_passed"}
VALUE_NAMES = ("delta", "a", "pl", "delta_late", "dF")   # measures.csv V (dump 8)
DEC_COLS = set(_SIDE_KEYS)


def file_keys(name):
    base = name.split("/")[0]
    fixed = {"load.csv": ["stage", "pair", "tf"], "askbid.csv": ["stage", "pair", "tf", "year"],
             "stage0.csv": ["trial", "key"], "stage0_totals.csv": ["half", "key"],
             "blind_counts.csv": ["tf", "half"], "strata.csv": ["stage", "half", "trial", "stratum"],
             "measures.csv": ["stage", "half", "trial", "key"], "shift.csv": ["stage", "half", "trial", "value", "k"],
             "clusters.csv": ["stage", "half", "trial", "value", "kind", "g"], "stage1.csv": ["trial", "key"],
             "stage1_summary.csv": ["key"], "stage2.csv": ["trial", "key"], "suspect.csv": ["stage", "half", "id"]}
    if name in fixed:
        return fixed[name]
    if name == "holes/summary.csv":
        return ["tf", "pair"]
    if base == "holes":
        return ["pair", "slot"]
    if base in ("bars", "htf", "ind"):
        return ["i"]
    if base == "signals":
        return ["pair", "i", "d"]
    if base in ("blind", "late"):
        return ["row"]
    if base == "trades":
        return ["pair", "i", "d"]
    return None


def value_class(name, row, col):
    base = name.split("/")[0]
    if base == "ind" and col in ("BM_r", "BM_sigma", "BM_z"):
        return "ln"
    if col != "value":
        return "exact"
    key = row.get("key", "")
    if name == "measures.csv":
        if key.endswith(".p"):
            return "p"
        if key.endswith((".lb", ".ub", ".q975", ".half_width")):
            return "q"
    if name == "stage1.csv":
        if key == "lb":
            return "q"
        if key == "p_iut":
            return "p"
    if name == "stage2.csv":
        if key in ("p_delta", "p_pl", "p_iut"):
            return "p"
        if key in ("mde", "sim_lb", "delta_ub", "late_lb", "dF_lo", "dF_hi"):
            return "q"
    if name == "stage0.csv" and key in ("pass_min", "mde"):
        return "q"
    return "exact"


def values_equal(a, b, cls, dec=False):
    if a == b:
        return True
    if dec or a == "" or b == "":
        return False
    try:
        x, y = float(a), float(b)
    except ValueError:
        return False
    if math.isnan(x) or math.isnan(y):
        return False
    if cls == "q":
        return abs(x - y) <= 1e-9
    if cls in ("p", "ln"):
        return abs(x - y) <= 1e-9 * max(abs(x), abs(y))
    if cls == "real":
        return abs(x - y) <= 1e-9
    return x == y


def read_lines(path):
    with open(path, "r", encoding="utf-8", newline="") as f:
        text = f.read()
    lines = text.split("\n")
    if lines and lines[-1] == "":
        lines.pop()
    return lines[0].split(","), lines[1:]


def list_files(folder):
    out = []
    for dp, dn, fn in os.walk(folder):
        for f in fn:
            rel = os.path.relpath(os.path.join(dp, f), folder).replace(os.sep, "/")
            out.append(rel)
    return sorted(out)


class Comparator:
    def __init__(self, run_dir, allowed_lines=None):
        self.run = run_dir
        self.ts = os.path.join(run_dir, "ts")
        self.py = os.path.join(run_dir, "py")
        self.allowed = list(allowed_lines or [])
        self.stops = []
        self.order = []       # the files in report order
        self.rows_of = {}     # file -> (ts rows, py rows) as written in the FILE line
        self._diffs_of = {}   # file -> [(key, column, ts, py, class)], after the allowances of 9.2 and 9.3
        self.border = set()   # (tf, pair, i) z-border bars and their next bars
        self.ts_tab = {}
        self.py_tab = {}
        # dump.md 9.3 (spec 23.5): (stage, half, trial, V, "lb" | "p") -> the TS's candidate, adopted where the
        # choice of 8.5 split on two candidates within 1e-9
        self.adopted = {}

    def compare(self):
        tsf = [f for f in list_files(self.ts) if f not in TS_ONLY]
        pyf = list_files(self.py)
        names = sorted(set(tsf) | set(pyf))
        for a in self.allowed:
            m = re.match(r"ALLOWED z-border (\S+) (\S+) i=(\d+)", a)
            if m:
                self.border.add((m.group(1), m.group(2), int(m.group(3))))
        # z-border bars read from either side's BM_z (lawsearch-dump.md 9.2), and the bar after each
        for n in names:
            if not n.startswith("ind/"):
                continue
            tf, sym = n[4:-4].split("_", 1)
            pair = PAIR_OF_SYM.get(sym)
            for folder in (self.ts, self.py):
                path = os.path.join(folder, n)
                if not os.path.exists(path):
                    continue
                hd, lines = read_lines(path)
                if "BM_z" not in hd:
                    continue
                zi = hd.index("BM_z")
                for ln in lines:
                    f = ln.split(",")
                    if zi < len(f) and f[zi] != "":
                        z = float(f[zi])
                        if abs(z - 2) <= 2e-9 or abs(z + 2) <= 2e-9:
                            i = int(f[0])
                            self.border.add((tf, pair, i))
                            self.border.add((tf, pair, i + 1))
        for n in names:
            if n not in tsf or n not in pyf:
                self.order.append(n)
                self.rows_of[n] = ("-" if n not in tsf else "?", "-" if n not in pyf else "?")
                self._diffs_of[n] = [("*", "*", "present" if n in tsf else "missing",
                                      "present" if n in pyf else "missing", "file")]
                continue
            if not n.endswith(".csv"):
                continue
            self.compare_file(n)
        self.candidate_checks()
        self.derived_checks()   # dump.md 11.12 (C4b, the lead's E10) step 1, before the decisions are judged
        self.decision_checks()
        return self.report()

    def compare_file(self, name):
        th, tr = read_lines(os.path.join(self.ts, name))
        ph, pr = read_lines(os.path.join(self.py, name))
        keys = file_keys(name)
        diffs = []
        cols = [c for c in th if c not in SUSPECT_TS_COLS] if name == "suspect.csv" else th
        if [c for c in th if c in cols] != [c for c in ph if c in cols]:
            diffs.append(("*", "header", "|".join(th), "|".join(ph), "exact"))
        tmap = self._rows_by_key(th, tr, keys)
        pmap = self._rows_by_key(ph, pr, keys)
        if name in ("measures.csv", "stage1.csv", "stage1_summary.csv", "stage2.csv"):
            self.ts_tab[name] = {k: dict(zip(th, v[1])) for k, v in tmap.items()}
            self.py_tab[name] = {k: dict(zip(ph, v[1])) for k, v in pmap.items()}
        for k in tmap:
            if k not in pmap:
                diffs.append(("|".join(k), "*", "row", "missing", "row"))
        for k in pmap:
            if k not in tmap:
                diffs.append(("|".join(k), "*", "missing", "row", "row"))
        common = [k for k in tmap if k in pmap]
        if [k for k in pmap if k in tmap] != common:
            diffs.append(("*", "order", "ts order", "py order", "order"))
        base = name.split("/")[0]
        same_header = th == ph and name != "suspect.csv"
        tix = {c: i for i, c in enumerate(th)}
        pix = {c: i for i, c in enumerate(ph)}
        cmp_cols = [c for c in cols if c not in (keys or []) and c in pix]
        for k in common:
            (la, fa), (lb, fb) = tmap[k], pmap[k]
            if same_header and la == lb:
                continue
            rowd = dict(zip(th, fa))
            for c in cmp_cols:
                va = fa[tix[c]] if tix[c] < len(fa) else ""
                vb = fb[pix[c]] if pix[c] < len(fb) else ""
                if va == vb:
                    continue
                cls = value_class(name, rowd, c)
                if values_equal(va, vb, cls, dec=(base in ("bars", "htf") and c in DEC_COLS)):
                    continue
                if self._z_allowed(name, k, c):
                    self.allowed.append(f"ALLOWED z-border {name} {'|'.join(k)} {c} ts={va} py={vb}")
                    continue
                diffs.append(("|".join(k), c, va, vb, cls))
        if base == "signals":
            diffs += self._signal_sha(tr, pr)
        self.order.append(name)
        self.rows_of[name] = (len(tr), len(pr))
        self._diffs_of[name] = diffs

    def _rows_by_key(self, header, lines, keys):
        out = {}
        idx = [header.index(c) for c in keys] if keys else None
        for ln in lines:
            f = ln.split(",")
            k = tuple(f[i] if i < len(f) else "" for i in idx) if idx else (ln,)
            if k in out:
                k = k + (f"#dup{len(out)}",)
            out[k] = (ln, f)
        return out

    def _z_allowed(self, name, key, col):
        if name.startswith("ind/") and col in ("B06_buy", "B06_sell"):
            tf, sym = name[4:-4].split("_", 1)
            pair = PAIR_OF_SYM.get(sym)
            return (tf, pair, int(key[0])) in self.border
        return False

    def _signal_sha(self, tl, pl):
        out = []
        for pair in PAIRS:
            a = [x for x in tl if x.startswith(pair + ",")]
            b = [x for x in pl if x.startswith(pair + ",")]
            ha = hashlib.sha256("\n".join(a).encode()).hexdigest()
            hb = hashlib.sha256("\n".join(b).encode()).hexdigest()
            if ha != hb:
                first = next((k for k in range(min(len(a), len(b))) if a[k] != b[k]), min(len(a), len(b)))
                out.append((pair, "sha256", a[first] if first < len(a) else "<end>",
                            b[first] if first < len(b) else "<end>", "sha256"))
        return out

    def decision_checks(self):
        """lawsearch-dump.md 9.3: decisions on quantiles and p that may differ within 1e-9 -> ALLOWED or STOP.

        A difference is excused only when the decision it shows rests on two compared values that are within 1e-9
        in either implementation: the decision's own values, not any near value elsewhere in the file. A difference
        in any other key (or in a decision whose values are not near) stays a difference.
        """
        diffs = self._diffs_of
        for name in ("stage1.csv", "stage1_summary.csv", "stage2.csv"):
            if name not in diffs:
                continue
            keep = []
            for d in diffs[name]:
                key = d[0].split("|")
                k = key[-1]
                if name == "stage2.csv" and d[1] == "value" and len(key) == 2 and k in self.DERIVED_KEYS:
                    # dump.md 11.12 (C4b, the lead's E10): a derived key, judged by consistency
                    how, why = self._derived_judge(key[0], k)
                    if how == "derived":
                        keep.append((d[0], d[1], d[2], d[3], f"derived ({why})"))
                    elif how == "diff":
                        keep.append(d)
                    elif how == "stop":
                        self.stops.append(f"STOP 8.5 {name} {d[0]} ts={d[2]} py={d[3]} ({why})")
                    else:
                        self.allowed.append(f"ALLOWED 8.5 {name} {d[0]} ts={d[2]} py={d[3]} ({why})")
                    continue
                near = self._near(name, key) if d[1] == "value" else None
                if near:
                    if k in self._STOP_KEYS.get(name, ()) or (name == "stage1_summary.csv" and k.startswith("chosen.")):
                        self.stops.append(f"STOP 8.5 {name} {d[0]} ts={d[2]} py={d[3]} ({near})")
                    else:
                        self.allowed.append(f"ALLOWED 8.5 {name} {d[0]} ts={d[2]} py={d[3]} ({near})")
                else:
                    keep.append(d)
            if name == "stage2.csv":
                keep = self._with_derived_only(keep)
            diffs[name] = keep

    # ------------------------------------------------------------------ 9.3: the choice of the candidate (spec 23.5)
    def candidate_checks(self):
        """lawsearch-dump.md 9.3 (spec 23.5, 2026-11-05): the choice of the candidate in spec 8.5.

        V.use_lb (the widest t(0.975) x SE) and V.use_p (the largest p) may differ when the two candidates' values
        (V.<c>.half_width, V.<c>.p) are within 1e-9 of each other in either implementation. Two values exactly equal
        in both implementations are a tie (week, then 4w, then shift decide it), not a near pair (dump 11.12).
        Such a split is listed as ALLOWED and the TS's candidate is adopted: the values that follow from the choice
        are then compared under the TS's candidate, from the Python's own per-candidate values in py/measures.csv
        (dump 11.13): measures.csv V.t, V.p, V.lb, V.ub; stage1.csv lb, p_iut; stage2.csv p_delta, p_pl, p_iut,
        t_delta, t_pl, delta_ub, late_lb, dF_lo, dF_hi and mde. The py/ files keep the Python's own choice.
        """
        tm = self.ts_tab.get("measures.csv")
        pm = self.py_tab.get("measures.csv")
        if not tm or not pm:
            return
        md = self._diffs_of.get("measures.csv", [])
        keep = []
        for d in md:
            key = d[0].split("|")
            parts = key[-1].split(".") if len(key) == 4 else []
            if (d[1] != "value" or len(parts) != 2 or parts[0] not in VALUE_NAMES
                    or parts[1] not in ("use_lb", "use_p") or d[2] == "" or d[3] == ""):
                keep.append(d)
                continue
            stage, half, tid = key[0], key[1], key[2]
            V = parts[0]
            which = "lb" if parts[1] == "use_lb" else "p"
            near = self._cand_near(stage, half, tid, V, d[2], d[3], "half_width" if which == "lb" else "p")
            if near is None:
                keep.append(d)
                continue
            self.allowed.append(f"ALLOWED 8.5 measures.csv {d[0]} ts={d[2]} py={d[3]} ({near}; the TS's "
                                f"candidate is adopted)")
            self.adopted[(stage, half, tid, V, which)] = d[2]
        self._diffs_of["measures.csv"] = keep
        if not self.adopted:
            return
        # the values that follow from the choice, compared under the TS's candidate
        deps = []
        for (stage, half, tid, V, which) in list(self.adopted):
            for what in (("lb", "ub") if which == "lb" else ("t", "p")):
                deps.append(("measures.csv", (stage, half, tid, f"{V}.{what}"), (stage, half, tid, V, what)))
        for (stage, half, tid, V, which) in list(self.adopted):
            if stage == "stage1" and half == "first":
                if V == "delta" and which == "lb":
                    deps.append(("stage1.csv", (tid, "lb"), (stage, half, tid, "delta", "lb")))
                if V in ("delta", "pl") and which == "p":
                    deps.append(("stage1.csv", (tid, "p_iut"), (stage, half, tid, "iut", "p")))
            if stage == "stage2" and half == "second":
                if which == "p" and V in ("delta", "pl"):
                    nm = "delta" if V == "delta" else "pl"
                    deps.append(("stage2.csv", (tid, f"p_{nm}"), (stage, half, tid, V, "p")))
                    deps.append(("stage2.csv", (tid, f"t_{nm}"), (stage, half, tid, V, "t")))
                    deps.append(("stage2.csv", (tid, "p_iut"), (stage, half, tid, "iut", "p")))
                    if V == "delta":
                        deps.append(("stage2.csv", (tid, "mde"), (stage, half, tid, "delta", "mde")))
                if which == "lb":
                    for vv, what, k in (("delta", "ub", "delta_ub"), ("delta_late", "lb", "late_lb"),
                                        ("dF", "lb", "dF_lo"), ("dF", "ub", "dF_hi")):
                        if V == vv:
                            deps.append(("stage2.csv", (tid, k), (stage, half, tid, vv, what)))
        seen = set()
        for fname, key, src in deps:
            if (fname, key) in seen:
                continue
            seen.add((fname, key))
            self._recompare(fname, key, src)

    def _cand_value(self, tab, stage, half, tid, V, c, col):
        r = tab.get((stage, half, tid, f"{V}.{c}.{col}"))
        if r is None or r.get("value", "") == "":
            return None
        try:
            return float(r["value"])
        except ValueError:
            return None

    def _cand_near(self, stage, half, tid, V, a, b, col):
        """The two candidates a (the TS's) and b (the Python's) of V, compared by col, within 1e-9 in either
        implementation, but not exactly tied in both. -> the reason, or None."""
        vals = {}
        for side, tab in (("ts", self.ts_tab["measures.csv"]), ("py", self.py_tab["measures.csv"])):
            x = self._cand_value(tab, stage, half, tid, V, a, col)
            y = self._cand_value(tab, stage, half, tid, V, b, col)
            if x is not None and y is not None:
                vals[side] = (x, y)
        if len(vals) == 2 and all(x == y for (x, y) in vals.values()):
            return None
        for side, (x, y) in vals.items():
            if abs(x - y) < 1e-9:
                return f"{V}.{a}.{col} and {V}.{b}.{col} within 1e-9 ({side})"
        return None

    def _py_under_ts(self, stage, half, tid, V, what):
        """The Python's value of V.what (t, p, lb, ub; V "iut" for max(p_delta, p_pl); what "mde") under the TS's
        candidate, from py/measures.csv, as the Python's own code would make it (choose(), stage 2's mde)."""
        pm = self.py_tab["measures.csv"]

        def own(v, w):
            r = pm.get((stage, half, tid, f"{v}.{w}"))
            if r is None or r.get("value", "") == "":
                return None
            try:
                return float(r["value"])
            except ValueError:
                return None

        def under(v, w):
            which = "lb" if w in ("lb", "ub") else "p"
            c = self.adopted.get((stage, half, tid, v, which))
            if c is None:
                return own(v, w), None
            if w in ("t", "p"):
                return self._cand_value(pm, stage, half, tid, v, c, w), c
            value = own(v, "value")
            hw = self._cand_value(pm, stage, half, tid, v, c, "half_width")
            if value is None or hw is None:
                return None, c
            return (value - hw if w == "lb" else value + hw), c

        if V == "iut":
            pd, cd = under("delta", "p")
            pp, cp = under("pl", "p")
            if pd is None or pp is None:
                return None, f"delta {cd}, pl {cp}"
            return max(pd, pp), f"delta {cd or 'own'}, pl {cp or 'own'}"
        if what == "mde":
            c = self.adopted.get((stage, half, tid, "delta", "p"))
            K = self._one("stage1_summary.csv", "K_total").get("py")
            se = self._cand_value(pm, stage, half, tid, "delta", c, "se")
            df = self._cand_value(pm, stage, half, tid, "delta", c, "df")
            if K is None or K < 1 or se is None or df is None:
                return None, c
            q = 1 - 0.025 / int(K)
            return (t_quantile(q, int(df)) + t_quantile(0.80, int(df))) * se, c
        return under(V, what)

    def _recompare(self, fname, key, src):
        """Compare one value that follows from an adopted candidate under the TS's candidate (replacing its
        ordinary comparison)."""
        tr = self.ts_tab.get(fname, {}).get(key)
        pr = self.py_tab.get(fname, {}).get(key)
        if tr is None or pr is None:
            return   # a missing row stays the difference compare_file found
        jk = "|".join(key)
        ds = self._diffs_of.get(fname, [])
        had = [d for d in ds if d[0] == jk and d[1] == "value"]
        x, c = self._py_under_ts(*src)
        if x is None:
            return   # not computable: the ordinary comparison stands
        cls = value_class(fname, tr, "value")
        tv, pv = tr.get("value", ""), pr.get("value", "")
        self._diffs_of[fname] = [d for d in ds if not (d[0] == jk and d[1] == "value")]
        if values_equal(tv, repr(x), cls):
            if had:
                self.allowed.append(f"ALLOWED 8.5 {fname} {jk} ts={tv} py={pv} (compared under the TS's candidate "
                                    f"{c}: py={x!r})")
        else:
            self._diffs_of[fname].append((jk, "value", tv, f"{pv}(under the TS's candidate {c}: {x!r})", cls))

    # dump.md 9.3 / spec 8.5: a split of these stops (stage 1's chosen trials, a stage 2 Holm pass, a verdict);
    # a split of any other decision listed in _near is allowed, and the TS's decision is taken. A difference that
    # _near does not excuse stays a DIFF. stage2.csv verdict, failed and label are derived keys (C4b, the lead's
    # E10): _derived_judge decides them (an excused verdict is a STOP 8.5; failed and label are STOP 8.5 lines only
    # when they are listed under the stop of a differing input, C1 or holm_delta_pass).
    _STOP_KEYS = {"stage1.csv": ("chosen",), "stage1_summary.csv": ("K_total",),
                  "stage2.csv": ("holm_pass", "holm_delta_pass", "C1", "verdict")}

    def _vals(self, fname, kname):
        """[(side, trial, value)] of key kname in fname (long files), both implementations."""
        out = []
        for side, tab in (("ts", self.ts_tab.get(fname, {})), ("py", self.py_tab.get(fname, {}))):
            for kk, r in tab.items():
                if kk[-1] == kname and r.get("value", "") != "":
                    try:
                        out.append((side, kk[0], float(r["value"])))
                    except ValueError:
                        pass
        return out

    def _one(self, fname, kname):
        """The value of a key of a key,value file (stage1_summary.csv) on each side: {side: float}."""
        out = {}
        for side, tab in (("ts", self.ts_tab.get(fname, {})), ("py", self.py_tab.get(fname, {}))):
            r = tab.get((kname,))
            if r is not None and r.get("value", "") != "":
                try:
                    out[side] = float(r["value"])
                except ValueError:
                    pass
        return out

    @staticmethod
    def _pair_near(vals, label):
        """Two values within 1e-9 of each other in either implementation (the order of two lb or two p).

        Two values that are exactly equal in both implementations are a tie, not a near pair: the order then
        follows the next keys (counted, table order), which must agree exactly.
        """
        by = {}
        for (s, t, x) in vals:
            by.setdefault(t, {})[s] = x
        ids = list(by)
        for i in range(len(ids)):
            for j in range(i + 1, len(ids)):
                a, b = by[ids[i]], by[ids[j]]
                sides = [sd for sd in ("ts", "py") if sd in a and sd in b]
                if all(a[sd] == b[sd] for sd in sides) and len(sides) == 2:
                    continue
                for sd in sides:
                    if abs(a[sd] - b[sd]) < 1e-9:
                        return f"{label} of {ids[i]} and {ids[j]} within 1e-9 ({sd})"
        return None

    @staticmethod
    def _pair_near_with(vals, tid, label):
        """As _pair_near, but only the pairs that include trial tid (dump.md 11.12, C4a, the lead's E2)."""
        by = {}
        for (s, t, x) in vals:
            by.setdefault(t, {})[s] = x
        a = by.get(tid)
        if not a:
            return None
        for other, b in by.items():
            if other == tid:
                continue
            sides = [sd for sd in ("ts", "py") if sd in a and sd in b]
            if len(sides) == 2 and all(a[sd] == b[sd] for sd in sides):
                continue
            for sd in sides:
                if abs(a[sd] - b[sd]) < 1e-9:
                    return f"{label} of {tid} and {other} within 1e-9 ({sd})"
        return None

    @staticmethod
    def _zero_near(vals, label, tid=None):
        for (side, t, x) in vals:
            if (tid is None or t == tid) and abs(x) < 1e-9:
                return f"{label} of {t} within 1e-9 of 0 ({side})"
        return None

    @staticmethod
    def _thr_near(vals, thresholds, label):
        for (side, t, x) in vals:
            for thr in thresholds:
                if abs(x - thr) < 1e-9:
                    return f"{label} of {t} within 1e-9 of the threshold {thr!r} ({side})"
        return None

    # ---------------------------------------------------------------- stage2.csv: X's own Holm decisions (C3, D2)
    def _s2_value(self, side, tid, key):
        """The float of stage2.csv (tid, key) on one side, or None."""
        tab = self.ts_tab.get("stage2.csv", {}) if side == "ts" else self.py_tab.get("stage2.csv", {})
        r = tab.get((tid, key))
        if r is None or r.get("value", "") == "":
            return None
        try:
            return float(r["value"])
        except ValueError:
            return None

    def _holm_pair(self, pkey, tid):
        """dump.md 11.12 / 11.13 (C3, the lead's D2): trial tid is one of the two trials of a near pair of pkey
        (p_iut or p_delta: within 1e-9 of each other in either implementation, and not exactly equal in both), or
        of an exact tie of pkey (equal in both, p < 1) broken by a t that follows an adopted 8.5 split. Only pairs
        that include tid count: a near or tied pair of two other trials never excuses a key of tid."""
        by = {}
        for (s_, t, x) in self._vals("stage2.csv", pkey):
            by.setdefault(t, {})[s_] = x
        a = by.get(tid)
        if not a:
            return None
        for other, b in by.items():
            if other == tid:
                continue
            sides = [sd for sd in ("ts", "py") if sd in a and sd in b]
            if len(sides) == 2 and all(a[sd] == b[sd] for sd in sides):
                r = self._tie_split_t(pkey, tid, other, a)
                if r:
                    return r
                continue
            for sd in sides:
                if abs(a[sd] - b[sd]) < 1e-9:
                    return f"{pkey} of {tid} and {other} within 1e-9 ({sd})"
        return None

    def _tie_split_t(self, pkey, tid, other, a):
        """dump.md 11.13 (C3, the lead's D2): two p < 1 exactly tied in both implementations are ordered by
        min(t_delta, t_pl) (t_delta for the delta-only Holm; spec 11). The tie may be broken differently only when
        one of the two trials has an adopted split on a t the order uses: an adopted delta.use_p or pl.use_p split
        whose t (t_delta or t_pl) is min(t_delta, t_pl) of that trial in either implementation; for the delta-only
        Holm, an adopted delta.use_p split. A use_lb split changes no t; two p = 1 are never ordered by t."""
        if not (a["ts"] < 1.0 and a["py"] < 1.0):
            return None
        vs = ("delta",) if pkey == "p_delta" else ("delta", "pl")
        for z in (tid, other):
            for v in vs:
                if ("stage2", "second", z, v, "p") not in self.adopted:
                    continue
                if pkey == "p_delta":
                    return (f"{pkey} of {tid} and {other} tied; the t_delta of {z} follows the TS's candidate of "
                            f"delta, adopted")
                for side in ("ts", "py"):
                    td = self._s2_value(side, z, "t_delta")
                    tp = self._s2_value(side, z, "t_pl")
                    if td is None or tp is None:
                        continue
                    tv = td if v == "delta" else tp
                    if tv == min(td, tp):
                        return (f"{pkey} of {tid} and {other} tied; the t of {z} follows the TS's candidate of {v}, "
                                f"adopted, and t_{v} is min(t_delta, t_pl) of {z} ({side})")
        return None

    def _side_K(self, side):
        """K of one implementation's Holm thresholds: its own stage1_summary.csv K_total (dump.md 11.12, C4a: 'taken
        per implementation'); without that row, the number of trials in its own stage2.csv."""
        tab = self.ts_tab if side == "ts" else self.py_tab
        r = tab.get("stage1_summary.csv", {}).get(("K_total",))
        if r is not None and r.get("value", "") != "":
            try:
                return int(float(r["value"]))
            except ValueError:
                pass
        return len({kk[0] for kk in tab.get("stage2.csv", {})})

    def _own_thr_hit(self, pkey, rkey, tid):
        """tid's own pkey vs its own Holm threshold 0.025 / (K - k + 1), with k = tid's rkey and K that side's
        K_total, within 1e-9 in either implementation (each side's p against that side's rank and K).
        -> (side, threshold, k) of the first side that is near, or None."""
        for side in ("ts", "py"):
            K = self._side_K(side)
            p = self._s2_value(side, tid, pkey)
            k = self._s2_value(side, tid, rkey)
            if p is None or k is None or not (1 <= k <= K) or k != int(k):
                continue
            thr = 0.025 / (K - int(k) + 1)
            if abs(p - thr) < 1e-9:
                return side, thr, int(k)
        return None

    def _holm_own_thr(self, pkey, rkey, tid):
        """dump.md 11.12 (C3, D2): tid's own pkey vs its own Holm threshold within 1e-9 (_own_thr_hit), as text."""
        h = self._own_thr_hit(pkey, rkey, tid)
        if h is None:
            return None
        side, thr, k = h
        return f"{pkey} of {tid} within 1e-9 of its Holm threshold {thr!r} (rank {k}, {side})"

    def _holm_x(self, pkey, rkey, tid):
        """The excuse of tid's Holm pass (holm_pass and C1 with p_iut, holm_delta_pass with p_delta): the pair rule
        on tid's own pairs, or tid's own p vs its own threshold."""
        return self._holm_pair(pkey, tid) or self._holm_own_thr(pkey, rkey, tid)

    # ------------------------------------- stage2.csv verdict / failed / label of X (C4b, the lead's E10 and E11)
    # dump.md 11.12 / py-design 5.7: spec 11's 判定 makes verdict, failed and label from X's other stage-2 values, so
    # they are derived keys, judged by consistency (E10, replacing C4a's E1 for these three keys):
    #   step 1: each side's written verdict, failed and label of X are recomputed from that side's own written inputs
    #           (C1 ... C7, holm_delta_pass, the verdict-2 test on delta_ub) with verdict_texts, the same derivation
    #           the Python's stage 2 writes with. A written key that does not follow is a DIFF of class derived (a
    #           program error of that side), for every trial, also when ts/ and py/ write the same value;
    #   step 2: when both sides follow their own inputs, a difference can only come from inputs that differ; each
    #           differing input is judged by its own rule (C1 and holm_delta_pass: a STOP 8.5 or a DIFF; C4 and the
    #           verdict-2 test: excused or a DIFF; C2, C3, C5, C6, C7: a DIFF). The derived difference is then a DIFF
    #           when an input is a DIFF; else a STOP 8.5 for verdict, and for failed and label a STOP 8.5 line ("listed
    #           under the stop") when an input is a STOP 8.5, otherwise ALLOWED 8.5.
    # E11: the verdict-2 test is spec 8.5's band test below0_test (|x| < 1e-12 is 0), never a plain < 0.
    DERIVED_KEYS = ("verdict", "label", "failed")
    _DERIVED_BOOLS = ("C1", "C2", "C3", "C4", "C5", "C6", "C7", "holm_delta_pass")

    def _s2_text(self, side, tid, key):
        """The text of stage2.csv (tid, key) on one side, or None when the row is missing."""
        tab = self.ts_tab.get("stage2.csv", {}) if side == "ts" else self.py_tab.get("stage2.csv", {})
        r = tab.get((tid, key))
        return None if r is None else r.get("value", "")

    def _own_zero_side(self, tid, key):
        """The first side ("ts", "py") whose stage2.csv (tid, key) is within 1e-9 of 0, or None."""
        for side in ("ts", "py"):
            x = self._s2_value(side, tid, key)
            if x is not None and abs(x) < 1e-9:
                return side
        return None

    def _side_inputs(self, side, tid):
        """E10 step 1: the inputs of spec 11's 判定 of X as one side wrote them: C1 ... C7 and holm_delta_pass (each
        '1' or '0'), delta_ub (empty, or a number) and the verdict-2 test on it (below0_test: spec 8.5's band, E11;
        an empty delta_ub is not below 0). -> (inputs, None), or (None, why they cannot be read): a missing row, a
        bool that is not 0 or 1, a delta_ub that is neither empty nor a number (the docs writer's reading, C4b)."""
        tab = self.ts_tab.get("stage2.csv", {}) if side == "ts" else self.py_tab.get("stage2.csv", {})
        inp = {}
        for k in self._DERIVED_BOOLS:
            r = tab.get((tid, k))
            if r is None:
                return None, f"no {k} row"
            v = r.get("value", "")
            if v not in ("0", "1"):
                return None, f"{k}={v} is not 0 or 1"
            inp[k] = v == "1"
        r = tab.get((tid, "delta_ub"))
        if r is None:
            return None, "no delta_ub row"
        v = r.get("value", "")
        x = None
        if v != "":
            x = read_number(v)
            if x is None:
                return None, f"delta_ub={v} is neither empty nor a number"
        inp["delta_ub"] = x
        inp["v2"] = below0_test(x)
        return inp, None

    @staticmethod
    def _derive(inp):
        """X's verdict, label and failed from one side's inputs, with the Python's own derivation (verdict_texts)."""
        return verdict_texts(inp["C1"], {f"C{i}": inp[f"C{i}"] for i in range(2, 8)}, inp["delta_ub"],
                             inp["holm_delta_pass"])

    def derived_checks(self):
        """E10 step 1, for every trial of stage2.csv and each side on its own: a written verdict, failed or label
        that differs from what that side's own inputs give (or whose inputs cannot be read) is recorded in
        self.derived_bad[(trial, key)][side] with the text of the DIFF line's class. A key whose row is missing on a
        side is not checked on that side (the missing row is compare_file's own DIFF)."""
        self.derived_bad = {}
        if "stage2.csv" not in self.ts_tab or "stage2.csv" not in self.py_tab:
            return
        for side, tab in (("ts", self.ts_tab["stage2.csv"]), ("py", self.py_tab["stage2.csv"])):
            tids = {}
            for kk in tab:
                if len(kk) == 2:
                    tids.setdefault(kk[0], None)
            for tid in tids:
                present = [k for k in self.DERIVED_KEYS if (tid, k) in tab]
                if not present:
                    continue
                inp, why = self._side_inputs(side, tid)
                want = self._derive(inp) if inp is not None else None
                for k in present:
                    got = tab[(tid, k)].get("value", "")
                    if want is None:
                        self.derived_bad.setdefault((tid, k), {})[side] = f"{side} inputs cannot be read: {why}"
                    elif got != want[k]:
                        w = want[k] if want[k] != "" else '""'
                        self.derived_bad.setdefault((tid, k), {})[side] = f"{side} inputs give {w}"

    def _holm_input(self, name, pkey, rkey, tid, thr_name):
        """E10 step 2: X's C1 (p_iut, holm_rank) or holm_delta_pass (p_delta, holm_delta_rank) differs. Its own rule
        (the rule of its own key's line, _holm_x): X in a near or adopted-tie pair of pkey, or X's own pkey within
        1e-9 of its own Holm threshold per implementation. -> the reason (a STOP 8.5), or None (a DIFF)."""
        pair = self._holm_pair(pkey, tid)
        if pair:
            return f"{name} of {tid} differs: {pair}"
        h = self._own_thr_hit(pkey, rkey, tid)
        if h:
            return (f"{name} of {tid} differs: its {pkey} within 1e-9 of its {thr_name} {h[1]!r} (rank {h[2]}, "
                    f"{h[0]})")
        return None

    def _differing_inputs(self, tid):
        """E10 step 2: the inputs of X that differ between ts/ and py/, each judged by its own rule.
        -> [(input, "stop" | "allowed" | "diff", reason or None)], in the order C1 ... C7, the verdict-2 test,
        holm_delta_pass."""
        t_in, _ = self._side_inputs("ts", tid)
        p_in, _ = self._side_inputs("py", tid)
        if t_in is None or p_in is None:
            return []
        out = []
        for c in ("C1", "C2", "C3", "C4", "C5", "C6", "C7"):
            if t_in[c] == p_in[c]:
                continue
            if c == "C1":
                r = self._holm_input("C1", "p_iut", "holm_rank", tid, "Holm threshold")
                out.append(("C1", "stop", r) if r else ("C1", "diff", None))
            elif c == "C4":
                side = self._own_zero_side(tid, "late_lb")
                out.append(("C4", "allowed", f"C4 of {tid} differs: its late_lb within 1e-9 of 0 ({side})")
                           if side else ("C4", "diff", None))
            else:
                # C2, C3, C5, C6, C7 rest on exact values (9.1): nothing excuses them
                out.append((c, "diff", None))
        if t_in["v2"] != p_in["v2"]:
            side = self._own_zero_side(tid, "delta_ub")
            out.append(("verdict2", "allowed", f"the verdict-2 test (delta_ub < 0) of {tid} differs: its delta_ub "
                                               f"within 1e-9 of 0 ({side})") if side else ("verdict2", "diff", None))
        if t_in["holm_delta_pass"] != p_in["holm_delta_pass"]:
            r = self._holm_input("holm_delta_pass", "p_delta", "holm_delta_rank", tid, "delta-only Holm threshold")
            out.append(("holm_delta_pass", "stop", r) if r else ("holm_delta_pass", "diff", None))
        return out

    def _derived_judge(self, tid, key):
        """E10: how a difference in X's derived key (verdict, failed, label) is written.
        -> ("derived", class text) a side does not follow its own inputs (step 1);
           ("diff", None) a differing input is a DIFF (or, defensively, no input differs);
           ("stop", reason) verdict with every differing input excused, or failed / label with a STOP 8.5 input and
                            every other one excused (listed under the stop);
           ("allowed", reason) failed / label with every differing input excused and none a STOP 8.5."""
        bad = self.derived_bad.get((tid, key))
        if bad:
            return "derived", "; ".join(bad[s] for s in ("ts", "py") if s in bad)
        ins = self._differing_inputs(tid)
        if not ins or any(st == "diff" for _, st, _ in ins):
            return "diff", None
        why = "; ".join(r for _, _, r in ins)
        if key == "verdict" or any(st == "stop" for _, st, _ in ins):
            return "stop", why
        return "allowed", why

    def _with_derived_only(self, keep):
        """E10 step 1 (the docs writer's reading, C4b): a derived key that does not follow its side's inputs is a
        DIFF also when ts/ and py/ write the same value (or the other side has no such row). Adds those DIFFs, that
        the plain comparison did not give, to stage2.csv's list in the file's row order; the rest keeps its order."""
        done = {(d[0], d[1]) for d in keep}
        extra = []
        pos = {}
        for tab in (self.ts_tab.get("stage2.csv", {}), self.py_tab.get("stage2.csv", {})):
            for kk in tab:
                pos.setdefault(kk, len(pos))
        for (tid, k), bad in self.derived_bad.items():
            jk = f"{tid}|{k}"
            if (jk, "value") in done:
                continue
            tv, pv = self._s2_text("ts", tid, k), self._s2_text("py", tid, k)
            why = "; ".join(bad[s] for s in ("ts", "py") if s in bad)
            extra.append((pos.get((tid, k), len(pos)), (jk, "value", "missing" if tv is None else tv,
                                                         "missing" if pv is None else pv, f"derived ({why})")))
        if not extra:
            return keep
        extra.sort(key=lambda e: e[0])
        out = []
        j = 0
        for d in keep:
            p = pos.get(tuple(d[0].split("|"))) if d[1] == "value" else None
            if p is not None:
                while j < len(extra) and extra[j][0] < p:
                    out.append(extra[j][1])
                    j += 1
            out.append(d)
        out += [e[1] for e in extra[j:]]
        return out

    def _near(self, name, key):
        """The pair of compared values within 1e-9 that this decision rests on, or None (dump.md 9.3)."""
        k = key[-1]
        tid = key[0] if len(key) > 1 else None
        if name == "stage1.csv":
            if k in ("rank", "chosen", "skipped_reason", "skipped_by"):
                # the order of two lb of one timeframe (spec 10 並べ方)
                tf = tid.split(".")[0]
                lbs = [v for v in self._vals("stage1.csv", "lb") if v[1].split(".")[0] == tf]
                if k == "rank":
                    # dump.md 11.12 (C4a, the lead's E2): a swap of two near lb changes only those two trials'
                    # ranks, so only a near pair that includes X excuses X's rank (as stage2.csv holm_rank)
                    return self._pair_near_with(lbs, tid, "lb")
                # chosen, skipped_reason, skipped_by: any near pair of the tf (the skip rules can carry one swap to
                # later trials of the tf; unchanged in C4a)
                return self._pair_near(lbs, "lb")
            return None
        if name == "stage1_summary.csv":
            lbs = self._vals("stage1.csv", "lb")
            if k.startswith("chosen.") or k == "K_total":
                for tf in (TFS if k == "K_total" else [k.split(".", 1)[1]]):
                    r = self._pair_near([v for v in lbs if v[1].split(".")[0] == tf], "lb")
                    if r:
                        return r
                return None
            if k in ("lb_pos", "lb_pos_groups", "lb_and_pl_pos"):
                return self._zero_near(lbs, "lb")
            if k == "bh_pass":
                m = self._one("stage1_summary.csv", "bh_m")
                thr = sorted({j * 0.10 / int(mv) for mv in m.values() if mv >= 1 for j in range(1, int(mv) + 1)})
                return self._thr_near(self._vals("stage1.csv", "p_iut"), thr, "p_iut")
            return None
        if name == "stage2.csv":
            # dump.md 11.12 (C3, the lead's D2): each key of a trial X is excused only by X's own decisions
            if k == "holm_rank":
                return self._holm_pair("p_iut", tid)
            if k in ("holm_pass", "C1"):
                return self._holm_x("p_iut", "holm_rank", tid)
            if k == "holm_delta_rank":
                return self._holm_pair("p_delta", tid)
            if k == "holm_delta_pass":
                return self._holm_x("p_delta", "holm_delta_rank", tid)
            if k == "C4":
                return self._zero_near(self._vals("stage2.csv", "late_lb"), "late_lb", tid)
            if k == "no_uplift":
                return self._zero_near(self._vals("stage2.csv", "dF_lo"), "dF_lo", tid)
            # verdict, label and failed are derived keys (C4b, the lead's E10): decision_checks judges them through
            # _derived_judge, never here
            return None
        return None

    def report(self):
        """dump.md 10. The FILE lines count the differences left after the allowances of 9.2 and 9.3."""
        out = []
        ndiff = 0
        for n in self.order:
            ds = self._diffs_of.get(n, [])
            a, b = self.rows_of[n]
            out.append(f"FILE {n} rows ts={a} py={b} diff={len(ds)}")
            for d in ds[:20]:
                out.append(f"DIFF {n} {d[0]} {d[1]} ts={d[2]} py={d[3]} class={d[4]}")
            ndiff += len(ds)
        self.ndiff = ndiff
        out += self.allowed
        out += self.stops
        # dump.md 10 / 11.14 (c) (C3, the lead's D10): the Python's own blind rows that hit stop the run at the end
        # of their stage. Not a 9.3 stop: the lines go before RESULT, which stays the comparison's.
        self.stop13 = self.blind_stops()
        out += self.stop13
        # dump.md 10 / 11.14 (a) (C4a, the lead's E6): when a failed TS check kept stage 2 closed, one line just
        # before RESULT. Not a difference and not a stop: RESULT and the exit stay the comparison's.
        self.not_opened = self.stage2_not_opened()
        out += self.not_opened
        out.append("RESULT agree" if ndiff == 0 and not self.stops else f"RESULT differ {ndiff}")
        os.makedirs(os.path.join(self.run, "cmp"), exist_ok=True)
        with open(os.path.join(self.run, "cmp", "report.txt"), "w", encoding="utf-8", newline="\n") as f:
            f.write("\n".join(out) + "\n")
        # dump.md 10 (C3): the first of 6, 5, 3, 0 wins
        if self.stops:
            return 6
        if ndiff:
            return 5
        return 3 if self.stop13 else 0

    def blind_stops(self):
        """`STOP 13 <stage> <id>: …` for each blind row (blind.<tf>.<SYM>.<buy|sell>) of py/suspect.csv whose `hit`
        is 1, in file order (dump.md 11.14 (c)). The Python decides the hit itself: only its own rows are read."""
        p = os.path.join(self.py, "suspect.csv")
        out = []
        if not os.path.exists(p):
            return out
        with open(p, "r", encoding="utf-8", newline="") as f:
            for r in csv.DictReader(f):
                if r.get("id", "").startswith("blind.") and r.get("hit") == "1":
                    out.append(f"STOP 13 {r.get('stage', '')} {r['id']}: a blind row hit spec 13's lines")
        return out

    def stage2_not_opened(self):
        """dump.md 10 / 11.14 (a), py-design 5.7 (C4a, the lead's E6): `stage 2 not opened: failed TS checks before
        stage 2: <name> <trial> <stage>; …` when ts/checks.csv has a row of stage gate, stage0, stage1 or stage1end
        whose passed is not 1 (the rows that keep stage 2 closed, Run.pre_stage2_failed), every such row in the file's
        row order. No line without such a row (K_total 0 with every check passed: the docs writer's reading, C4a), and
        none for a checks.csv without the stage column (before round C2), as Run.pre_stage2_failed. Read by --run and
        --compare alike. -> [the line] or []."""
        p = os.path.join(self.ts, "checks.csv")
        if not os.path.exists(p):
            return []
        with open(p, "r", encoding="utf-8", newline="") as f:
            rows = list(csv.DictReader(f))
        bad = [f"{r.get('name', '')} {r.get('trial', '')} {r['stage']}" for r in rows
               if r.get("stage") in Run.PRE_STAGE2_STAGES and r.get("passed") != "1"]
        if not bad:
            return []
        return ["stage 2 not opened: failed TS checks before stage 2: " + "; ".join(bad)]


# ----------------------------------------------------------------------------------------------------------------
# 18. The command line (py-design 2)
# ----------------------------------------------------------------------------------------------------------------

PLANT_MUST_FAIL = {
    "midHalfEven": ["A.1.7"], "midDecimalStr": ["A.1.7"], "pointsTrunc": ["A.1.8"], "daySatSplit": ["A.1.9"],
    "splitShift": ["A.1.2"], "entryAtSignalClose": ["A.1.26"], "entryEarly": ["A.1.26"],
    "exitLate": ["A.1.26", "A.1.31"], "noSubstituteExit": ["A.1.27", "A.1.29"], "blindNoHour": ["A.2.1"],
    "noBlind": ["A.2.1"], "inflStratumMean": ["A.2.4"], "shiftNoWrap": ["A.2.4"], "noHolm": ["A.2.22"],
    "iutOneLeg": ["A.2.22"], "c4PointOnly": ["A.2.23"], "noEx1Week": ["A.2.20", "A.2.23"], "noDF": ["A.2.20"],
    "htfOpen": ["A.1.12", "A.1.13"], "smaNewestFirst": ["A.3.2", "A.3.31"],
    "noRisingEdge": ["A.4.1", "A.4.32", "A.4.33", "A.4.34"],
}


def cmd_hand(plant=""):
    with open(ROOT / "research/lawsearch-hand.json", "r", encoding="utf-8") as f:
        doc = json.load(f)
    exs = doc["examples"]
    _HAND_ALL[:] = exs
    g12 = [e for e in exs if e["group"] in ("G1", "G2")]
    g34 = [e for e in exs if e["group"] in ("G3", "G4")]
    res = run_hand_examples(g12, plant)
    try:
        sig = load_sig()
        res += sig.run_hand(g34, plant=plant)
    except NotBuilt as e:
        res += [{"id": x["id"], "status": "fail", "keys": [{"key": "*", "status": "fail", "why": f"NotBuilt: {e}"}]}
                for x in g34]
    by = {r["id"]: r for r in res}
    for r in res:
        bad = [k for k in r.get("keys", []) if k["status"] == "fail"]
        why = "; ".join(f"{k['key']}: {k['why']}" for k in bad)[:400]
        print(f"{r['id']} {r['status']}" + (f" {why}" if why else ""))
    npass = sum(1 for r in res if r["status"] == "pass")
    nfail = sum(1 for r in res if r["status"] == "fail")
    nskip = sum(1 for r in res if r["status"] == "skip")
    print(f"HAND pass={npass} fail={nfail} skip={nskip} plant={plant or '-'}")
    if plant:
        want = PLANT_MUST_FAIL.get(plant)
        if want is None:
            print(f"PLANT {plant}: unknown")
            return 2
        caught = [w for w in want if by.get(w, {}).get("status") == "fail"]
        print(f"PLANT {plant}: must fail one of {','.join(want)}; failed: {','.join(caught) or 'none'}")
        return 0 if caught else 4
    return 4 if nfail else 0


def run_and_compare(r):
    """--run after setup(): compute the Python's files, then compare (dump.md 10). A Stop inside a stage propagates
    (exit 3, no comparison). The exit is the comparison's: 6, 5, then 3 for a spec 13 blind-row stop (11.14 (c)),
    then 0."""
    r.compute()
    if not os.path.isdir(r.ts) or not [f for f in list_files(r.ts) if f not in TS_ONLY]:
        print("no TS files to compare yet")
        return 5
    code = Comparator(r.run, r.allowed).compare()
    print_report_tail(r.run)
    return code


def print_report_tail(run_dir):
    """Print report.txt's STOP 13 lines, its `stage 2 not opened` line (C4a, E6) and its RESULT line."""
    rep = open(os.path.join(run_dir, "cmp", "report.txt"), encoding="utf-8").read().splitlines()
    for ln in rep:
        if ln.startswith(("STOP 13 ", "stage 2 not opened: ")):
            print(ln)
    print(rep[-1])


def main(argv):
    args = argv[1:]
    plant = ""
    if "--plant" in args:
        k = args.index("--plant")
        plant = args[k + 1]
        del args[k:k + 2]
    try:
        check_rules_files()
        if args[:1] == ["--hand"]:
            return cmd_hand(plant)
        if plant:
            print("--plant is for --hand only")
            return 2
        if len(args) == 2 and args[0] == "--run":
            r = Run(args[1])
            # dump.md 2 (C3, the lead's D5): --run refuses a run whose config.json cut_max is not null (or missing)
            r.setup(refuse_cut_max=True)
            return run_and_compare(r)
        if len(args) == 2 and args[0] == "--compare":
            r = Run(args[1])
            # dump.md 2 / py-design 2 (C4b, the lead's E14): --compare refuses a capped ts/ as --run does (the same
            # function and message), before anything is compared or written into cmp/
            r.setup(refuse_cut_max=True)
            code = Comparator(args[1], []).compare()
            print_report_tail(args[1])
            return code
        print(__doc__)
        return 2
    except Refused as e:
        print(f"REFUSED {e}")
        return 2
    except Stop as e:
        print(f"STOP {e}")
        return 3
    except NotBuilt as e:
        print(f"STOP NotBuilt: {e}")
        return 3


if __name__ == "__main__":
    sys.exit(main(sys.argv))
