#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
chartbest-check-data.py — the data part of the independent Python re-computation of docs/OPERATIONS.md §8.113
(#318, step 2 "試し"): constants, time helpers, the GMO day files -> 5-minute bars, the chart's mid rounding and
points.

Written from §8.113 (1, 2, 6), §8.107 2-3 and the plan's dump formats only; no research/chartbest*.ts is read.
The rule's definitions it follows (quoted where they decide a number):
  * 2「中値: 四本値ごとに (Bid＋Ask)÷2 を double で出し、その double の正確な値を、ちょうど半分なら上へ丸める」:
    Decimal(v) of the float itself, ROUND_HALF_UP (never round(), never Decimal(str(v))).
  * 2「点: ... TS は Math.round、Python は round」.
  * 2「休みの中の足は捨てる（... 足の始まりが UTC の金曜 22:00 から日曜 21:00 の前まで〈土曜は終日〉）」.
  * 6 ②「T・T＋1分・T＋3分が、すべて isPossiblyClosed の中（金曜 21:00 UTC 以後・土曜・日曜 22:00 UTC より前）」.
  * 2「NY の夏時間は nyOffsetMs と同じ（3月第2日曜 07:00 UTC〜11月第1日曜 06:00 UTC）... ロンドンの夏時間は
    3月最終日曜 01:00 UTC〜10月最終日曜 01:00 UTC」.
  * 1「wk(t) ＝ floor((t − WEEK_OFFSET) ÷ 1週)（WEEK_OFFSET は3日21時間）」; 4週の塊 floor((wk(T) − w0) ÷ 4).

Loaded by path (importlib) from research/chartbest-check.py; standard library and numpy only.
"""
import calendar
import json
import os
from decimal import ROUND_HALF_UP, Decimal

import numpy as np

# ---------------------------------------------------------------- units of time (ms)
MIN = 60_000
HOUR = 60 * MIN
DAY = 24 * HOUR
WEEK = 7 * DAY
WEEK_OFFSET = 3 * DAY + 21 * HOUR          # weeks start on Sunday 21:00 UTC (lib.ts)
STEP = 5 * MIN                             # the 5-minute bar


def utc(y, m, d, h=0, mi=0):
    """UTC calendar fields -> integer ms."""
    return calendar.timegm((y, m, d, h, mi, 0)) * 1000


# ---------------------------------------------------------------- the fixed numbers of §8.113 1-17
PAIRS = ('USD/JPY', 'EUR/JPY', 'AUD/JPY', 'EUR/USD', 'AUD/USD')    # the strata's / tables' order
PERIODS = {
    # §8.113 1 (fixed). w0: the first week of each half, for the 4-week blocks
    'main': dict(name='main', s0=utc(2023, 10, 27), start=utc(2024, 1, 1), split=utc(2025, 5, 19),
                 end=utc(2026, 10, 10), w0={'H1': 2817, 'H2': 2889}),
    # development only (the plan's MINI_PERIOD; made-up data)
    'mini': dict(name='mini', s0=utc(2023, 10, 27), start=utc(2024, 1, 1), split=utc(2024, 2, 26),
                 end=utc(2024, 4, 20), w0={'H1': 2817, 'H2': 2825}),
}
R_CB = utc(2026, 10, 13)
SL_PIPS = 13            # 7
TP_MAIL = 4             # 7: the email's exit
TP_MAIN = 10            # 7/8: the main exit
TRACK = 1440            # 7: bars followed
FLOOR_N, FLOOR_WEEKS = 300, 30      # 11
K_CHART, K_CAL = 3, 1               # 12
ALPHA = 0.025                       # 14 (one-sided, the whole family)
ZERO = 1e-12                        # 8「|x| < 1e-12 は0とする」
SUSPECT = dict(minResolved=100, delta=0.10, a=0.10, w2=0.80, w1=0.90, pl1=1.0, pl2=3.0, lateGap=0.05)  # 13
CANDIDATES_PATH = 'research/ledger/chartbest-candidates.json'
CANDIDATES_SHA256 = '710814487a58f0228e70b2f7f15eae9d878b52701cf7f72d3a5ceb3bfffc5436'
SPREAD_HOURS_PATH = 'research/ledger/spread-hours.csv'
SPREAD_HOURS_SHA256 = '2b325574297a9891bc4760717ab3f6e3891d073725b01b46b0faa7b89605bb93'
# §8.113 12「記録: 選んだ項目と前半の表を docs に書く。research/ledger/chartbest-choice.json と、その sha256 の定数を
# commit する。段2は、この定数が無いと走らない。選ばなかった項目は、後半で何も計算しない（プログラムが断る）。」
# The constant stays empty until the real stage 1 has run; it is then written by hand, beside the TS program's own.
# On real data, chartbest-check.py opens the second half only for the items of that file, read against this constant
# (choice_from_ledger). The path is the one the real stage-2 job passes with --choice-ledger.
# (Rewritten 2026-10-12 by the step-2b Python author, who has not read the TS: py-brief 1.10.)
CHOICE_LEDGER_PATH = 'research/ledger/chartbest-choice.json'
CHOICE_LEDGER_SHA256 = ''
# §8.113 1「GMO はこの開発環境から届かないので、すべて GitHub Actions で取る。日のファイルは actions/cache に置き」: the
# real jobs restore that cache under this folder and pass a --gmo inside it, so a --gmo there is real data (the made-up
# generator writes its day files under research/out/).
REAL_CACHE = 'research/.cache'

# §8.113 3: the 59 items in the table's order ("表の順"); group chart (0-51) or cal (52-58), and the candidate
# each belongs to (11: "同じ候補の項目" are always one overlap group)
ITEM_ORDER = (
    'donchian-A20', 'donchian-A55', 'round-A', 'round-B', 'hs', 'pivot-A', 'pivot-B', 'heikin-A', 'heikin-B',
    'asia', 'orb-lon', 'orb-ny', 'orb-tok', 'noise', 'td9', 'td13', 'star', 'fib618', 'flag', 'nr7', 'idnr4',
    'double7', 'cci', 'ibs', 'bigmove', 'outside3', 'rsi2', 'linreg', 'vortex', 'crsi', 'ttm', 'kama-A', 'kama-B',
    'pinbar', 'vr', 'hurst', 'pnf', 'dualthrust', 'cam-A', 'cam-B', 'renko', 'tlb', 'kagi', 'soldiers', 'fisher',
    'demarker', 'psych', 'knn', 'logit', 'kairi', 'ob', 'wyckoff',
    'breedon-1', 'breedon-2', 'fix-A1', 'fix-A2', 'fix-B1', 'fix-B2', 'gap',
)
ORDER = {x: k for k, x in enumerate(ITEM_ORDER)}
GROUP_OF = {x: ('chart' if ORDER[x] <= 51 else 'cal') for x in ITEM_ORDER}
# 11「同じ候補の項目」
SAME_CANDIDATE = (
    ('donchian-A20', 'donchian-A55'), ('round-A', 'round-B'), ('pivot-A', 'pivot-B'), ('heikin-A', 'heikin-B'),
    ('orb-lon', 'orb-ny', 'orb-tok'), ('td9', 'td13'), ('nr7', 'idnr4'), ('kama-A', 'kama-B'), ('cam-A', 'cam-B'),
    ('knn', 'logit'), ('breedon-1', 'breedon-2'), ('fix-A1', 'fix-A2', 'fix-B1', 'fix-B2'),
)
# 11「ledger の⑨のまとまり」
LEDGER_GROUPS = (
    ('rsi2', 'crsi', 'double7'), ('vr', 'hurst'), ('pinbar', 'wyckoff', 'round-A'),
    ('donchian-A20', 'donchian-A55', 'dualthrust', 'orb-lon', 'orb-ny', 'orb-tok', 'noise', 'asia', 'tlb', 'kagi',
     'pnf', 'flag'),
    ('heikin-A', 'heikin-B', 'renko'), ('fix-A2', 'breedon-2'),
)
# the yardsticks (10): the two current emails, written after the items in every table
MEASURES = ('ultra5', 'macdx5')
MEASURE_NAMES = {'ultra5': 'ULTRA 5分足', 'macdx5': 'MACD の山・谷'}
# the items built in step 2 (22 の 2); the other 55 are not part of this job
TRIAL_ITEMS = ('donchian-A20', 'donchian-A55', 'breedon-1', 'breedon-2')


def src_rank(src):
    """The order of the sources in every dump: the table's order, then ULTRA, then MACD."""
    if src in ORDER:
        return ORDER[src]
    return len(ITEM_ORDER) + MEASURES.index(src)


def is_jpy(pair):
    return pair.endswith('/JPY')


def digits_of(pair):
    """2: d is 3 on a yen pair, 5 otherwise."""
    return 3 if is_jpy(pair) else 5


def pip_of(pair):
    """2: a pip is 0.01 on a yen pair, 0.0001 otherwise."""
    return 0.01 if is_jpy(pair) else 0.0001


def sym_of(pair):
    return pair.replace('/', '_')


# ---------------------------------------------------------------- time
def wk(t):
    """1: the week of t (integer ms)."""
    return (int(t) - WEEK_OFFSET) // WEEK


def weekday(t):
    """Monday 0 .. Sunday 6 (1970-01-01 was a Thursday)."""
    return (int(t) // DAY + 3) % 7


def _nth_sunday(y, month, nth):
    """Day of month of the nth Sunday (nth = -1: the last one)."""
    if nth > 0:
        first = calendar.weekday(y, month, 1)          # Monday 0
        return 1 + (6 - first) % 7 + 7 * (nth - 1)
    last_day = calendar.monthrange(y, month)[1]
    return last_day - (calendar.weekday(y, month, last_day) + 1) % 7


_DST = {}


def _dst_bounds(y):
    if y not in _DST:
        ny = (utc(y, 3, _nth_sunday(y, 3, 2), 7), utc(y, 11, _nth_sunday(y, 11, 1), 6))
        ldn = (utc(y, 3, _nth_sunday(y, 3, -1), 1), utc(y, 10, _nth_sunday(y, 10, -1), 1))
        _DST[y] = (ny, ldn)
    return _DST[y]


def year_of(t):
    return int(np.datetime64(int(t), 'ms').astype('datetime64[Y]').astype(int)) + 1970


def ny_summer(t):
    """2: nyOffsetMs is -4h (second Sunday of March 07:00 UTC .. first Sunday of November 06:00 UTC)."""
    (a, b), _ = _dst_bounds(year_of(t))
    return a <= t < b


def london_summer(t):
    """2: last Sunday of March 01:00 UTC .. last Sunday of October 01:00 UTC."""
    _, (a, b) = _dst_bounds(year_of(t))
    return a <= t < b


# 8: the season groups (both winter, both summer, NY only summer = the shifted weeks, London only = the 4th)
SEASON_WW, SEASON_SS, SEASON_SW, SEASON_WS = 0, 1, 2, 3
SEASON_NAMES = ('WW', 'SS', 'SW', 'WS')


def season_of(t):
    ny, ld = ny_summer(t), london_summer(t)
    if ny and ld:
        return SEASON_SS
    if ny:
        return SEASON_SW
    if ld:
        return SEASON_WS
    return SEASON_WW


def ny_offset(t):
    return -4 * HOUR if ny_summer(t) else -5 * HOUR


def ny_local(t):
    """The New York wall clock of t: (weekday Mon 0..Sun 6, minutes of the day)."""
    x = int(t) + ny_offset(t)
    return weekday(x), (x % DAY) // MIN


def utc_hour(t):
    return (int(t) % DAY) // HOUR


def possibly_closed(t):
    """isPossiblyClosed: Friday from 21:00 UTC, all Saturday, Sunday before 22:00 UTC (fixed UTC)."""
    d, tod = weekday(t), int(t) % DAY
    return d == 5 or (d == 4 and tod >= 21 * HOUR) or (d == 6 and tod < 22 * HOUR)


def market_closed(t):
    """isMarketClosed: Friday from 22:00 UTC, all Saturday, Sunday before 21:00 UTC."""
    d, tod = weekday(t), int(t) % DAY
    return d == 5 or (d == 4 and tod >= 22 * HOUR) or (d == 6 and tod < 21 * HOUR)


def bar_inside_closure(t, step=STEP):
    """barInsideClosure: the bar's start and its last millisecond both inside isMarketClosed."""
    return market_closed(t) and market_closed(t + step - 1)


SENT_READS = (0, 1, 3)      # 6 ②: the sweep reads 0, 1 and 3 minutes after the close


def sent(T):
    """6 ②: the signal is sent when one of T, T+1 min, T+3 min is outside isPossiblyClosed."""
    return any(not possibly_closed(T + m * MIN) for m in SENT_READS)


def gmo_week_open(s):
    """§8.107 3: the GMO week (Sunday 22:00 UTC .. Friday 21:00 UTC), as isPossiblyClosed's complement."""
    return not possibly_closed(s)


def half_of_T(T, period):
    """1: the half a time belongs to by T alone (H1 before SPLIT)."""
    return 'H1' if T < period['split'] else 'H2'


def block_of(T, half, period):
    """1: the 4-week block of T in a half."""
    return (wk(T) - period['w0'][half]) // 4


def iso_date(t):
    return str(np.datetime64(int(t), 'ms').astype('datetime64[D]'))


def iso_minute(t):
    return str(np.datetime64(int(t), 'ms').astype('datetime64[m]')).replace('T', ' ')


def gmo_day_key(t):
    """gmoDayKey: the GMO day starts at 21:00 UTC the day before (JST date of t - 6h)."""
    return str(np.datetime64(int(t) + 3 * HOUR, 'ms').astype('datetime64[D]')).replace('-', '')


# ---------------------------------------------------------------- rounding
_Q = {3: Decimal('0.001'), 5: Decimal('0.00001')}
_ROUND_CACHE = {}


def chart_round(v, d):
    """2: the chart's Number(v.toFixed(d)) — the double's exact value, ties up (Decimal(v) of the float itself)."""
    key = (v, d)
    r = _ROUND_CACHE.get(key)
    if r is None:
        r = float(Decimal(v).quantize(_Q[d], rounding=ROUND_HALF_UP))
        if len(_ROUND_CACHE) < 4_000_000:
            _ROUND_CACHE[key] = r
    return r


def points_of(v, pair):
    """2: the rounded mid times 1,000 (yen) or 100,000, to the nearest integer (round, never int())."""
    return round(v * (1000 if is_jpy(pair) else 100000))


def price_str(v, d):
    """4.2 of the plan: a price written as toFixed(d) (exact for a chart-rounded double)."""
    return f'{v:.{d}f}'


# ---------------------------------------------------------------- the GMO day files
# SQ-B1 (malformed rows inside a readable day file; never met on made-up data): 'nan' — a day file is a read
# failure (20 (a)「GMO の読み込みの失敗0」) only when it is not GMO's shape (not JSON, status ≠ 0, no data list); a row
# inside it that is not an object, or whose openTime is not a finite whole number of ms, is not a bar: it is removed
# and counted under nan; a price that is not a finite number (NaN, ±inf, a string that is not a number, missing)
# makes that time's mid not a number (18 C1「中値が NaN の足は、番号を付ける前に取り除いて数を出す」), counted under
# nan by load_pair. 'readFailure' (the alternative): any malformed row makes its whole file a read failure.
MALFORMED_ROW = 'nan'


class LoadDiag:
    """What reading one pair's files found (counted, never fatal by itself).
    nan (18 C1, SQ-B1): the rows removed as not a bar (not an object, openTime not a finite whole number; per row and
    side, counted by read_side) plus the times whose eight prices (O, H, L, C of both sides) are not all finite
    numbers although both sides have a row there (per time, counted by load_pair after the one-side test and before
    the crossed test, so a time is counted under at most one of oneSide, nan and crossed)."""

    def __init__(self):
        self.files = 0
        self.failed = []          # (path, reason)
        self.rows = {'bid': 0, 'ask': 0}
        self.dup = 0
        self.one_side = 0
        self.crossed = 0
        self.ohlc = 0
        self.closure = 0
        self.outside = 0
        self.nan = 0


def _number(x):
    """A JSON number, or a string that parses as one, as a float; NaN for anything else (a bool, null, a missing
    field, a string that is not a number)."""
    if isinstance(x, bool):
        return float('nan')
    if isinstance(x, (int, float)):
        return float(x)
    if isinstance(x, str):
        try:
            return float(x)
        except ValueError:
            return float('nan')
    return float('nan')


def _open_time(r):
    """The row's openTime in integer ms, or None when it is not a finite whole number (SQ-B1: not a bar)."""
    x = r.get('openTime')
    if isinstance(x, int) and not isinstance(x, bool):
        return x
    if isinstance(x, str):
        try:
            return int(x)
        except ValueError:
            pass
    v = _number(x)
    if not np.isfinite(v) or v != int(v):
        return None
    return int(v)


def read_side(dirpath, diag, side):
    """Every row of one side's day files: {openTime: (o, h, l, c)} (the first row of a repeated time kept).
    A file is a read failure when it is not GMO's shape (not JSON, status ≠ 0, no data list; 20 (a)); a malformed row
    inside a readable file is handled as MALFORMED_ROW says (SQ-B1): a row that is not a bar is counted under nan, a
    price that is not a number is kept as NaN (load_pair removes and counts that time)."""
    rows = {}
    if not os.path.isdir(dirpath):
        return rows
    for fn in sorted(os.listdir(dirpath)):
        if not fn.endswith('.json'):
            continue
        path = os.path.join(dirpath, fn)
        diag.files += 1
        try:
            with open(path, 'rb') as f:
                j = json.loads(f.read())
        except (OSError, ValueError) as e:
            diag.failed.append((path, repr(e)))
            continue
        if not isinstance(j, dict) or j.get('status') != 0 or not isinstance(j.get('data'), list):
            diag.failed.append((path, 'status/shape'))
            continue
        for r in j['data']:
            diag.rows[side] += 1
            t = _open_time(r) if isinstance(r, dict) else None
            v = tuple(_number(r.get(k)) for k in ('open', 'high', 'low', 'close')) if t is not None else None
            if MALFORMED_ROW == 'readFailure' and (t is None or not all(np.isfinite(x) for x in v)):
                diag.failed.append((path, 'malformed row'))
                break
            if t is None:
                diag.nan += 1                      # not a bar (SQ-B1)
                continue
            if t in rows:
                diag.dup += 1
                continue
            rows[t] = v
    return rows


class PairBars:
    """One pair's usable 5-minute bars from S0 to END (index 0 = the first usable bar at or after S0)."""

    def __init__(self, pair, pi, t, bid, ask):
        self.pair = pair
        self.pi = pi
        self.sym = sym_of(pair)
        self.digits = digits_of(pair)
        self.pip = pip_of(pair)
        self.t = np.asarray(t, dtype=np.int64)
        self.n = int(self.t.size)
        self.bo, self.bh, self.bl, self.bc = (np.asarray(x, dtype=np.float64) for x in bid)
        self.ao, self.ah, self.al, self.ac = (np.asarray(x, dtype=np.float64) for x in ask)
        d = self.digits
        self.mo, self.mh, self.ml, self.mc = (
            np.array([chart_round((b + a) / 2.0, d) for b, a in zip(bs.tolist(), as_.tolist())], dtype=np.float64)
            for bs, as_ in ((self.bo, self.ao), (self.bh, self.ah), (self.bl, self.al), (self.bc, self.ac)))
        self.index_of = {int(x): k for k, x in enumerate(self.t.tolist())}

    def T(self, i):
        """5: the close of bar i."""
        return int(self.t[i]) + STEP


def load_pair(gmo_dir, pair, pi, period, diag, interval='5min'):
    """2: both sides paired by time; one-sided rows and rows whose ask close is below the bid close dropped and
    counted; bars inside the closure dropped; open >= S0 and open + 5 min <= END; numbered in time order."""
    base = os.path.join(gmo_dir, sym_of(pair), interval)
    bid = read_side(os.path.join(base, 'bid'), diag, 'bid')
    ask = read_side(os.path.join(base, 'ask'), diag, 'ask')
    step = STEP if interval == '5min' else MIN
    times = sorted(set(bid) | set(ask))
    keep_t, B, A = [], [[], [], [], []], [[], [], [], []]
    for t in times:
        if t not in bid or t not in ask:
            diag.one_side += 1
            continue
        b, a = bid[t], ask[t]
        # 18 C1「中値が NaN の足は、番号を付ける前に取り除いて数を出す」: a price that is not a finite number makes the
        # time's mid not a number (SQ-B1: after the one-side test, before the crossed test)
        if not all(np.isfinite(x) for x in b + a):
            diag.nan += 1
            continue
        if a[3] < b[3]:
            diag.crossed += 1
            continue
        for o, h, lo, c in (b, a):
            if not (h >= max(o, c) and lo <= min(o, c) and h >= lo):
                diag.ohlc += 1
                break
        if bar_inside_closure(t, step):
            diag.closure += 1
            continue
        if t < period['s0'] or t + step > period['end']:
            diag.outside += 1
            continue
        keep_t.append(t)
        for k in range(4):
            B[k].append(b[k])
            A[k].append(a[k])
    return PairBars(pair, pi, keep_t, B, A)


def load_all(gmo_dir, period):
    diags, bars = [], []
    for pi, pair in enumerate(PAIRS):
        d = LoadDiag()
        bars.append(load_pair(gmo_dir, pair, pi, period, d))
        diags.append(d)
    return bars, diags


# ---------------------------------------------------------------- spread-hours.csv (11: the wide-spread slots)
def load_wide_slots(path):
    """{(pair, 'summer'|'winter', slot 0..95): avoid} from research/ledger/spread-hours.csv."""
    out = {}
    with open(path, encoding='utf-8') as f:
        header = f.readline().strip().split(',')
        ix = {h: k for k, h in enumerate(header)}
        for line in f:
            c = line.strip().split(',')
            if len(c) < len(header):
                continue
            out[(c[ix['pair']], c[ix['season']], int(c[ix['slot']]))] = c[ix['avoid']] == 'yes'
    return out


def wide_slot(wide, pair, T):
    """SQ-21: the 15-minute slot holding the instant T, with the season of T (nyOffsetMs)."""
    season = 'summer' if ny_summer(T) else 'winter'
    return wide.get((pair, season, (int(T) % DAY) // (15 * MIN)), False)
