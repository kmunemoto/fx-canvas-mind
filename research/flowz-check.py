#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
flowz-check.py — docs/OPERATIONS.md §8.124 の独立した計算し直し（Python。標準ライブラリだけ）。

research/flowz.ts・research/flowz-lib.ts・.github/workflows/flowz.yml は読まずに、§8.124 と、そこが指す
§8.102（オーナーの持ち方）・§8.119／§8.122（メールの決まり）・§8.106（足の読み方）と、決まりとして名前の出る
本番のコード（_shared/macd-level.ts の decideZoneOnWindow、_shared/macd.ts の macd と _shared/pine.ts の
pineEma、_shared/market-hours.ts、live-chart/logic.ts の historyRead の丸め、analyze/indicators.ts の
emaSeries、track-outcomes/quotes.ts の parseKlines・mergeSides、signal-alerts/indicators.ts の
gmoIntervalsDue）と、読み込みの決まり（research/ownerhold-data.ts の loadM1・keysOf、research/trend-data.ts
の loadTf、research/money-trades.ts の nyClosesBetween。ファイルの置き方と、残す足の決まりだけを読んだ）から
書いた。§8.102 の1本の注文の追い方は、research/ownerhold-check.py の compute_path を読んで、numpy なしで
書き直した。

同じ GMO の形のファイルから、メール（v6: 確定した600本の窓・新しい120本の枠の95%）、流れ A（1時間足の
EMA200）と B（T までに確定した一番新しい4時間足の EMA200）、オーナーの持ち方（P＝T＋2分の指値・すでに良ければ
成行・利確 E±10 pips・損切りなし・楽天の止まる時間は判定しない）、メールの目安（損切り13・利確4）を
1通ずつ計算し直し、TypeScript の rows.csv と summary.json（stage1・stage2・tables・other・pairs・load）を
全部比べる。

使い方:
  python3 research/flowz-check.py --cache DIR --rows rows.csv --summary summary.json
    DIR: <DIR>/<USD_JPY など>/<1min|1hour|4hour>/<bid|ask>/<鍵>.json（GMO の形）
    期間（start・end・split・loadFrom）は summary.json の meta から読む。
終了コード: 0 = 全部一致（最後の行 FLOWZ-CHECK PASSED）、1 = 食い違いあり、または入力の誤り
（最後の行 FLOWZ-CHECK FAILED: n differences）。
"""
import argparse
import bisect
import csv
import datetime
import json
import math
import os
import sys
import time
from decimal import ROUND_HALF_UP, Decimal

MIN = 60_000
HOUR = 3_600_000
DAY = 86_400_000
PAIRS = ['USD/JPY', 'EUR/JPY', 'AUD/JPY', 'EUR/USD', 'AUD/USD']   # 行の順（同じ T はこの順）
WINDOW = 600                     # macd-level.ts LEVEL_WINDOW
ZONE_BARS = 120                  # macd-level.ts ZONE_BARS
ZONE_SHARE = 95 / 100            # macd-level.ts ZONE_PCT / 100（v6、§8.122）
EMA_N = 200                      # 流れ A・B の EMA200
TP_PIPS = 10                     # オーナーの利確（E ± 10 pips）
G_SL, G_TP = 13, 4               # メールの目安（損切り E ∓ 13、利確 E ± 4）
P_AFTER = 2 * MIN                # P ＝ T ＋ 2分
STOP_LEN = 15 * MIN              # 楽天が止まる時間 [τ, τ＋15分)
READ_AFTER = (0, 3, 5)           # gmoIntervalsDue: 1時間足は確定の0・3・5分後に読む
DRAWS = 10_000
BOOT_SEED, DROP_SEED = 371, 3710
REL = 1e-9
BLK = 256
INF = float('inf')
_EPOCH = datetime.datetime(1970, 1, 1, tzinfo=datetime.timezone.utc)


def die(msg):
    """入力の誤り: 理由を出し、食い違い1つとして失敗で終える"""
    print('ERROR: ' + msg)
    print('FLOWZ-CHECK FAILED: 1 differences')
    sys.exit(1)


# ---------------------------------------------------------------- 時刻（JS の Date の UTC と同じ）
def ms_of(text):
    d = datetime.datetime.fromisoformat(str(text).strip().replace('Z', '+00:00'))
    if d.tzinfo is None:
        raise ValueError(f'no time zone: {text}')
    return (d - _EPOCH) // datetime.timedelta(milliseconds=1)


def iso(ms):
    d = _EPOCH + datetime.timedelta(milliseconds=ms)
    s = d.strftime('%Y-%m-%dT%H:%M:%S')
    return s + ('Z' if ms % 1000 == 0 else '.%03dZ' % (ms % 1000))


def js_day(ms):
    """getUTCDay(): 0 = 日曜 … 6 = 土曜（1970-01-01 は木曜）"""
    return (ms // DAY + 4) % 7


def utc_hour(ms):
    return (ms % DAY) // HOUR


def ymd(ms):
    d = datetime.date(1970, 1, 1) + datetime.timedelta(days=ms // DAY)
    return d.year, d.month, d.day


def jst_day_key(ms):
    """track-outcomes/quotes.ts jstDayKey"""
    y, m, d = ymd(ms + 9 * HOUR)
    return '%04d%02d%02d' % (y, m, d)


def gmo_day_key(t):
    """ownerhold-data.ts gmoDayKey: GMO の日（21:00 UTC 区切り）"""
    return jst_day_key(t - 6 * HOUR)


def is_market_closed(ms):
    d, h = js_day(ms), utc_hour(ms)
    return d == 6 or (d == 5 and h >= 22) or (d == 0 and h < 21)


def is_possibly_closed(ms):
    d, h = js_day(ms), utc_hour(ms)
    return d == 6 or (d == 5 and h >= 21) or (d == 0 and h < 22)


CLOSED_WINDOW_MS = 47 * HOUR


def bar_inside_closure(open_ms, step):
    """market-hours.ts barInsideClosure（週末は inside、§8.106）"""
    if not step > 0:
        return is_market_closed(open_ms)
    if step > CLOSED_WINDOW_MS:
        return False
    return is_market_closed(open_ms) and is_market_closed(open_ms + step - 1)


def mailed(T):
    """送られる足: 確定の0・3・5分後（の1秒後）のどれかが isPossiblyClosed でない"""
    return any(not is_possibly_closed(T + m * MIN + 1000) for m in READ_AFTER)


_NY = {}


def ny_summer(ms):
    """market-hours.ts nyOffsetMs が −4時間（3月の第2日曜 07:00 UTC 〜 11月の第1日曜 06:00 UTC）"""
    y = ymd(ms)[0]
    if y not in _NY:
        def nth_sunday(month, nth):
            first = (datetime.date(y, month, 1).weekday() + 1) % 7
            return 1 + ((7 - first) % 7) + 7 * (nth - 1)
        a = datetime.datetime(y, 3, nth_sunday(3, 2), 7, tzinfo=datetime.timezone.utc)
        b = datetime.datetime(y, 11, nth_sunday(11, 1), 6, tzinfo=datetime.timezone.utc)
        _NY[y] = ((a - _EPOCH) // datetime.timedelta(milliseconds=1), (b - _EPOCH) // datetime.timedelta(milliseconds=1))
    s, e = _NY[y]
    return s <= ms < e


_TAU = {}


def stop_start(t):
    """楽天が止まる時間（money-trades.ts nyClosesBetween の τ から15分。平日ごと、夏 20:55・ほか 21:55 UTC）に
    t が入れば、その τ。入らなければ None。"""
    d = (t // DAY) * DAY
    tau = _TAU.get(d, 0)
    if tau == 0:
        tau = None if js_day(d) in (0, 6) else d + (20 if ny_summer(d + 21 * HOUR) else 21) * HOUR + 55 * MIN
        _TAU[d] = tau
    return tau if tau is not None and tau <= t < tau + STOP_LEN else None


# ---------------------------------------------------------------- 数（JS と同じ）
def js_round(x):
    """Math.round（ちょうど半分は上へ）"""
    f = math.floor(x)
    return f + 1 if x - f >= 0.5 else f


def round_chart(x, dec):
    """チャートの丸め Number(v.toFixed(d))（live-chart historyRead）: double の正確な値を、半分は大きい方へ"""
    return float(Decimal(x).quantize(Decimal(1).scaleb(-dec), ROUND_HALF_UP))


def mulberry32(seed):
    s = seed & 0xFFFFFFFF

    def r():
        nonlocal s
        s = (s + 0x6D2B79F5) & 0xFFFFFFFF
        t = s
        t = ((t ^ (t >> 15)) * (t | 1)) & 0xFFFFFFFF
        t = (t ^ ((t + (((t ^ (t >> 7)) * (t | 61)) & 0xFFFFFFFF)) & 0xFFFFFFFF)) & 0xFFFFFFFF
        return ((t ^ (t >> 14)) & 0xFFFFFFFF) / 4294967296
    return r


def add_in_order(xs):
    """前から1つずつ足す（Python 3.12 の sum() は補正つきの足し方なので使わない）"""
    s = 0.0
    for x in xs:
        s += x
    return s


def mean_in_order(xs):
    return add_in_order(xs) / len(xs) if xs else None


def median(xs):
    if not xs:
        return None
    s = sorted(xs)
    n = len(s)
    return s[n // 2] if n % 2 else (s[n // 2 - 1] + s[n // 2]) / 2


# ---------------------------------------------------------------- GMO のファイル
class LoadStats:
    def __init__(self):
        self.files = 0
        self.failed = 0
        self.failed_ex = []
        self.one_side = 0
        self.crossed = 0
        self.closure = 0
        self.repeated = 0


def _num(v):
    """quotes.ts num(): 数か数の文字列だけ。数でない・有限でないものは None"""
    if type(v) is bool or not isinstance(v, (int, float, str)):
        return None
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    if x != x or x in (INF, -INF):
        return None
    return x


def parse_klines(body):
    """quotes.ts parseKlines: (t, open, high, low, close) を t の順に（同じ t は元の順のまま）"""
    out = []
    for r in body.get('data') or []:
        if not isinstance(r, dict):
            continue
        try:
            t = float(r['openTime'])
            o, h, l, c = float(r['open']), float(r['high']), float(r['low']), float(r['close'])
            ok = True
        except (KeyError, TypeError, ValueError):
            ok = False
        if not ok or type(r.get('openTime')) is bool:
            vals = [_num(r.get(k)) for k in ('openTime', 'open', 'high', 'low', 'close')]
            if any(v is None for v in vals):
                continue
            t, o, h, l, c = vals
        if not (math.isfinite(t) and math.isfinite(o) and math.isfinite(h) and math.isfinite(l) and math.isfinite(c)):
            continue
        out.append((int(t) if t.is_integer() else t, o, h, l, c))
    out.sort(key=lambda x: x[0])
    return out


def sound(body):
    """ownerhold-data.ts sound: status 0 か 404 で data が並び"""
    if not isinstance(body, dict):
        return False
    st = body.get('status')
    return type(st) in (int, float) and type(st) is not bool and st in (0, 404) and isinstance(body.get('data'), list)


def read_side(cache, sym, interval, side, key, ld):
    path = os.path.join(cache, sym, interval, side, key + '.json')
    try:
        with open(path, 'rb') as f:
            body = json.loads(f.read())
    except Exception as e:  # noqa: BLE001
        ld.failed += 1
        if len(ld.failed_ex) < 5:
            ld.failed_ex.append(f'{sym} {interval} {side} {key}: {type(e).__name__}')
        return None
    if not sound(body):
        ld.failed += 1
        if len(ld.failed_ex) < 5:
            ld.failed_ex.append(f'{sym} {interval} {side} {key}: not GMO bars')
        return None
    ld.files += 1
    return parse_klines(body)


def date_keys_day(from_ms, to_ms):
    """quotes.ts dateKeys(…, "day"): 両端を1日ずつ広げた日本時間の日の鍵"""
    if to_ms < from_ms:
        return []
    out, seen = [], set()
    f, t = from_ms - DAY, to_ms + DAY
    x = f
    while x <= t:
        k = jst_day_key(x)
        if k not in seen:
            seen.add(k)
            out.append(k)
        x += DAY
    last = jst_day_key(t)
    if last not in seen:
        out.append(last)
    return out


def keys_of(from_ms, to_ms):
    """ownerhold-data.ts keysOf: END の日より後の鍵は読まない"""
    last = jst_day_key(to_ms)
    return [k for k in date_keys_day(from_ms, to_ms) if k <= last]


def year_keys(from_ms, to_ms):
    """trend-data.ts keysFor（年のファイル）: 最初の足の GMO の年から最後の足の年まで"""
    return [str(y) for y in range(int(gmo_day_key(from_ms)[:4]), int(gmo_day_key(to_ms - 1)[:4]) + 1)]


def load_tf(cache, sym, interval, step, keys, from_ms, to_ms, ld):
    """trend-data.ts loadTf（週末は inside）: 両側がそろい、Ask の終値が Bid の終値より下でなく、from 以後に始まり
    to までに確定し、閉まりの中に全部が入らない足。mergeSides と同じく、同じ時刻は最初の Bid（古い鍵）と
    最後の Ask。返すのは (t, bid, ask) の並び。"""
    bid, ask = [], []
    for key in keys:
        b = read_side(cache, sym, interval, 'bid', key, ld)
        a = read_side(cache, sym, interval, 'ask', key, ld)
        if b is None or a is None:
            continue
        bid.extend(b)
        ask.extend(a)
    bid.sort(key=lambda x: x[0])
    ask.sort(key=lambda x: x[0])
    asks = {}
    for x in ask:
        asks[x[0]] = x
    out, emitted = [], set()
    for x in bid:
        t = x[0]
        if t in emitted:
            continue
        a = asks.get(t)
        if a is None or a[4] < x[4]:
            continue
        emitted.add(t)
        if t >= from_ms and t + step <= to_ms and not bar_inside_closure(t, step):
            out.append((t, x, a))
    return out


class M1:
    """1分足（ownerhold-data.ts loadM1）と、探すための塊ごとの最小・最大"""

    def __init__(self, pair, cache, from_ms, to_ms, ld):
        self.pair = pair
        self.usd = pair.endswith('/USD')
        self.unit = 0.0001 if self.usd else 0.01
        sym = pair.replace('/', '_')
        t, bo, bh, bl, bc, ao, ah, al, ac = ([] for _ in range(9))
        last = -INF
        # loadM1: 鍵ごとに Bid と Ask を時刻で合わせ（片側だけ・Ask の終値が下は落とす）、鍵の順に、期間の外・
        # 閉まりの中・前の足と同じか前の時刻を落とす（鍵ごとに続けて行っても、鍵の順に行うのと同じ）
        for key in keys_of(from_ms, to_ms):
            b = read_side(cache, sym, '1min', 'bid', key, ld)
            a = read_side(cache, sym, '1min', 'ask', key, ld)
            if b is None or a is None:
                continue
            asks = {}
            for y in a:
                asks[y[0]] = y
            rows = []
            for x in b:
                y = asks.pop(x[0], None)
                if y is None:
                    ld.one_side += 1
                    continue
                if y[4] < x[4]:
                    ld.crossed += 1
                    continue
                rows.append((x, y))
            ld.one_side += len(asks)
            for x, y in rows:
                tt = x[0]
                if tt < from_ms or tt + MIN > to_ms:
                    continue
                if bar_inside_closure(tt, MIN):
                    ld.closure += 1
                    continue
                if tt <= last:
                    ld.repeated += 1
                    continue
                last = tt
                t.append(tt)
                bo.append(x[1]); bh.append(x[2]); bl.append(x[3]); bc.append(x[4])
                ao.append(y[1]); ah.append(y[2]); al.append(y[3]); ac.append(y[4])
        self.t, self.bo, self.bh, self.bl, self.bc = t, bo, bh, bl, bc
        self.ao, self.ah, self.al, self.ac = ao, ah, al, ac
        self.n = len(t)
        stop = [stop_start(x) is not None for x in t]
        self.stops = sum(1 for s in stop if s)
        # 楽天が止まる間の足は、約定・利確・目安の判定をしない（届かない値に置き換える）。最大の逆行は止まる足も入れる。
        self.s_al = Seek([INF if s else v for s, v in zip(stop, al)], True)     # 買いの指値・売りの利確・売りの目安の利確
        self.s_bh = Seek([-INF if s else v for s, v in zip(stop, bh)], False)   # 売りの指値・買いの利確・買いの目安の利確
        self.s_bl = Seek([INF if s else v for s, v in zip(stop, bl)], True)     # 買いの目安の損切り
        self.s_ah = Seek([-INF if s else v for s, v in zip(stop, ah)], False)   # 売りの目安の損切り
        self.m_bl = Seek(bl, True)      # 買いの最大の逆行（止まる足も）
        self.m_ah = Seek(ah, False)     # 売りの最大の逆行
        self.u_al = Seek(al, True)      # 数えるだけ: 止まる足も判定したら、もっと前に届いていたか
        self.u_bh = Seek(bh, False)


class Seek:
    """k 以後の最初の「≦x」（min）／「≧x」（max）と、区間の最小・最大を、塊ごとの最小・最大で引く"""

    def __init__(self, a, is_min):
        self.a = a
        self.n = len(a)
        f = min if is_min else max
        self.b = [f(a[i:i + BLK]) for i in range(0, self.n, BLK)]
        self.is_min = is_min

    def first(self, k, x):
        a, n, b = self.a, self.n, self.b
        if k < 0:
            k = 0
        if k >= n:
            return -1
        bi = k // BLK
        end = min((bi + 1) * BLK, n)
        if self.is_min:
            for i in range(k, end):
                if a[i] <= x:
                    return i
            for j in range(bi + 1, len(b)):
                if b[j] <= x:
                    for i in range(j * BLK, min((j + 1) * BLK, n)):
                        if a[i] <= x:
                            return i
            return -1
        for i in range(k, end):
            if a[i] >= x:
                return i
        for j in range(bi + 1, len(b)):
            if b[j] >= x:
                for i in range(j * BLK, min((j + 1) * BLK, n)):
                    if a[i] >= x:
                        return i
        return -1

    def ext(self, lo, hi):
        """a[lo..hi]（両端を含む）の最小（min）か最大（max）"""
        a, b = self.a, self.b
        f = min if self.is_min else max
        blo, bhi = lo // BLK, hi // BLK
        if blo == bhi:
            return f(a[lo:hi + 1])
        m = f(f(a[lo:(blo + 1) * BLK]), f(a[bhi * BLK:hi + 1]))
        if bhi > blo + 1:
            m = f(m, f(b[blo + 1:bhi]))
        return m


# ---------------------------------------------------------------- メールの決まり（v6）と EMA
def zone_entry(w):
    """macd-level.ts decideZoneOnWindow: 窓の終値（600本）の MACD（macd.ts。EMA は pine.ts pineEma）で、
    一番新しい足 k＝599 の帯への入り。(side, m, top, bottom) か None。"""
    n = len(w)
    a12 = 2 / 13
    b12 = 1 - a12
    a26 = 2 / 27
    b26 = 1 - a26
    a9 = 2 / 10
    b9 = 1 - a9
    s = 0.0
    for k in range(12):
        s += w[k]
    fast = s / 12
    for k in range(12, 26):
        fast = a12 * w[k] + b12 * fast
    s = 0.0
    for k in range(26):
        s += w[k]
    slow = s / 26
    line = [fast - slow]                       # 窓の 25 番から
    for k in range(26, n):
        v = w[k]
        fast = a12 * v + b12 * fast
        slow = a26 * v + b26 * slow
        line.append(fast - slow)
    s = 0.0
    for k in range(9):
        s += line[k]
    sig = s / 9                                # 窓の 33 番から
    sigs = [sig]
    for k in range(9, len(line)):
        sig = a9 * line[k] + b9 * sig
        sigs.append(sig)
    off_l, off_s = 25, 33

    def zone(k):
        lo = k - ZONE_BARS + 1
        ls = line[lo - off_l:k - off_l + 1]
        ss = sigs[lo - off_s:k - off_s + 1]
        hs = [ls[j] - ss[j] for j in range(ZONE_BARS)]
        top = 0.0
        bottom = 0.0
        for xs in (ls, ss, hs):
            mx, mn = max(xs), min(xs)
            if mx > top:
                top = mx
            if mn < bottom:
                bottom = mn
        m = line[k - off_l]
        in_top = top > 0 and m >= ZONE_SHARE * top
        in_bottom = bottom < 0 and m <= ZONE_SHARE * bottom
        return m, top, bottom, in_top, in_bottom

    k = n - 1
    now = zone(k)
    before = zone(k - 1)
    if now[3] and not before[3]:
        return 'SELL', now[0], now[1], now[2]
    if now[4] and not before[4]:
        return 'BUY', now[0], now[1], now[2]
    return None


def ema_series(values, period):
    """analyze/indicators.ts emaSeries: 最初の period 本の単純平均から、以後は 2/(period+1)"""
    out = [None] * len(values)
    if period <= 0 or len(values) < period:
        return out
    seed = 0.0
    for i in range(period):
        seed += values[i]
    prev = seed / period
    out[period - 1] = prev
    k = 2 / (period + 1)
    om = 1 - k
    for i in range(period, len(values)):
        prev = values[i] * k + prev * om
        out[i] = prev
    return out


def trend_of(close, ema):
    if ema is None or close == ema:
        return 0
    return 1 if close > ema else -1


def relation(dirn, lab):
    if lab == 0:
        return 'none'
    return 'with' if lab == dirn else 'against'


# ---------------------------------------------------------------- 1通の持ち方（§8.102 の本線）と目安
def follow(pr, P0, dirn, E, end):
    """§8.102 の本線の追い方（ownerhold-check.py compute_path と同じ作り）: P が楽天の止まる時間に入れば、
    その終わりに動かす。P に始まる足があればその始値で、無ければ P 以前に終わる最後の足の終値で、すでに E より
    良ければ成行。そうでなければ E の指値（触れたら約定。始値が E より良ければ始値）。利確は約定の次の足から
    （利確の値と始値の良い方）。止まる時間の足では約定・利確を判定しない。目安（損切り13・利確4）は同じ約定から、
    次の足以後で先に届いた方。"""
    r = dict(none=False, filled=False, market=0, t0=None, fill=None, tp=0, tpK=-1, tpT=None, exit=None, endPx=None,
             pips=None, mae=None, hold=None, g_result=None, g_pips=None, g_both=None, shifted=0, noBar=0, gap=0,
             stopMoved=0)
    P = P0
    tau = stop_start(P)
    if tau is not None:
        P = tau + STOP_LEN
        r['shifted'] = 1
    r['P'] = P
    t, n, unit = pr.t, pr.n, pr.unit
    if P >= end or n == 0:
        r['none'] = True
        return r
    kk = bisect.bisect_left(t, P)
    k0 = kk if kk < n and t[kk] == P else -1
    first_after = bisect.bisect_right(t, P)
    if k0 >= 0:
        now = pr.ao[k0] if dirn > 0 else pr.bo[k0]
    else:
        r['noBar'] = 1
        kp = bisect.bisect_right(t, P - MIN) - 1
        if kp < 0:
            r['none'] = True
            return r
        now = pr.ac[kp] if dirn > 0 else pr.bc[kp]
    ks0 = k0 if k0 >= 0 else first_after
    if (now <= E) if dirn > 0 else (now >= E):
        fk, t0, fill = k0, P, now
        r['market'] = 1
    else:
        k = pr.s_al.first(ks0, E) if dirn > 0 else pr.s_bh.first(ks0, E)
        if k < 0:
            u = pr.u_al.first(ks0, E) if dirn > 0 else pr.u_bh.first(ks0, E)
            r['stopMoved'] = int(u >= 0)               # 数えるだけ
            return r                                   # 入らなかった指値
        o = pr.ao[k] if dirn > 0 else pr.bo[k]
        if (o < E) if dirn > 0 else (o > E):
            fill = o
            r['gap'] = 1
        else:
            fill = E
        fk, t0 = k, t[k]
    r.update(filled=True, t0=t0, fill=fill)
    ts = fk + 1 if fk >= 0 else first_after
    tp = E + dirn * TP_PIPS * unit
    k = pr.s_bh.first(ts, tp) if dirn > 0 else pr.s_al.first(ts, tp)
    end_px = pr.bc[n - 1] if dirn > 0 else pr.ac[n - 1]
    if k >= 0:
        o = pr.bo[k] if dirn > 0 else pr.ao[k]
        ex = (o if o > tp else tp) if dirn > 0 else (o if o < tp else tp)
        r.update(tp=1, tpK=k, tpT=t[k], exit=ex, pips=dirn * (ex - fill) / unit, hold=(t[k] + MIN - t0) / HOUR)
        hi = k
    else:
        r.update(endPx=end_px, pips=dirn * (end_px - fill) / unit, hold=(end - t0) / HOUR)
        hi = n - 1
    lo = fk if fk >= 0 else first_after
    if lo <= hi:
        mae = (fill - pr.m_bl.ext(lo, hi)) / unit if dirn > 0 else (pr.m_ah.ext(lo, hi) - fill) / unit
        r['mae'] = max(0.0, mae)
    else:
        r['mae'] = 0.0
    # メールの目安
    sl = E - dirn * G_SL * unit
    gt = E + dirn * G_TP * unit
    def guide(k1, k2):
        """k1: 損切りに届いた最初の足、k2: 利確（4）に届いた最初の足（無ければ −1）から、先に届いた方"""
        hits = [x for x in (k1, k2) if x >= 0]
        if not hits:
            return 'held', end_px, 0, -1
        k = min(hits)
        o = pr.bo[k] if dirn > 0 else pr.ao[k]
        if (o <= sl) if dirn > 0 else (o >= sl):
            return 'sl', o, 0, k                       # 始まりですでに越えていた: その始値
        if (o >= gt) if dirn > 0 else (o <= gt):
            return 'tp', o, 0, k
        if k1 == k and k2 == k:
            return 'sl', sl, 1, k                      # 同じ1分足で両方: 損切りとして数える
        if k1 == k:
            return 'sl', sl, 0, k
        return 'tp', gt, 0, k

    if dirn > 0:
        g = guide(pr.s_bl.first(ts, sl), pr.s_bh.first(ts, gt))
    else:
        g = guide(pr.s_ah.first(ts, sl), pr.s_al.first(ts, gt))
    r.update(g_result=g[0], g_pips=dirn * (g[1] - fill) / unit, g_both=g[2])
    # 数えるだけ（結果は変えない）: 止まる時間の足も判定していたら、約定・利確・目安の決済が変わっていたか
    moved = False
    if not r['market']:
        moved = (pr.u_al.first(ks0, E) if dirn > 0 else pr.u_bh.first(ks0, E)) != fk
    moved = moved or (pr.u_bh.first(ts, tp) if dirn > 0 else pr.u_al.first(ts, tp)) != r['tpK']
    if dirn > 0:
        moved = moved or guide(pr.m_bl.first(ts, sl), pr.u_bh.first(ts, gt)) != g
    else:
        moved = moved or guide(pr.m_ah.first(ts, sl), pr.u_al.first(ts, gt)) != g
    r['stopMoved'] = int(moved)
    return r


# ---------------------------------------------------------------- 全体
class Email:
    __slots__ = ('pair', 'pi', 'open', 'T', 'side', 'dir', 'E', 'm', 'top', 'bottom', 'half', 'month', 'A', 'B', 'path')


def compute(cache, start, end, split, load_from, log):
    ld = LoadStats()
    emails = []
    pair_info = []
    extra = dict(short=0, shifted=0, noBar=0, none=0, gapFill=0, stopBars=0, stopMoved=0, monthEdge=0)
    for pi, pair in enumerate(PAIRS):
        t_pair = time.time()
        sym = pair.replace('/', '_')
        dec = 5 if pair.endswith('/USD') else 3
        h1 = load_tf(cache, sym, '1hour', HOUR, keys_of(load_from, end), load_from, end, ld)
        h4 = load_tf(cache, sym, '4hour', 4 * HOUR, year_keys(load_from, end), load_from, end, ld)
        t1 = [x[0] for x in h1]
        c1 = [round_chart((x[1][4] + x[2][4]) / 2, dec) for x in h1]
        t4 = [x[0] for x in h4]
        c4 = [round_chart((x[1][4] + x[2][4]) / 2, dec) for x in h4]
        e1 = ema_series(c1, EMA_N)
        e4 = ema_series(c4, EMA_N)
        judged = not_mailed = short = 0
        mine = []
        for i in range(len(t1)):
            T = t1[i] + HOUR
            if T < start or T >= end:
                continue
            if i + 1 < WINDOW:
                short += 1
                continue
            judged += 1
            d = zone_entry(c1[i - WINDOW + 1:i + 1])
            if d is None:
                continue
            if not mailed(T):
                not_mailed += 1
                continue
            em = Email()
            em.pair, em.pi, em.open, em.T = pair, pi, t1[i], T
            em.side, em.m, em.top, em.bottom = d
            em.dir = 1 if em.side == 'BUY' else -1
            em.E = c1[i]
            em.half = 1 if T < split else 2
            y, mo, _ = ymd(T)
            em.month = '%04d-%02d' % (y, mo)
            em.A = relation(em.dir, trend_of(c1[i], e1[i]))
            j = bisect.bisect_right(t4, T - 4 * HOUR) - 1
            em.B = relation(em.dir, trend_of(c4[j], e4[j]) if j >= 0 else 0)
            mine.append(em)
        extra['short'] += short
        m1 = M1(pair, cache, start, end, ld)
        extra['stopBars'] += m1.stops
        for em in mine:
            em.path = follow(m1, em.T + P_AFTER, em.dir, em.E, end)
            for k in ('shifted', 'noBar', 'stopMoved'):
                extra[k] += em.path[k]
            extra['none'] += int(em.path['none'])
            extra['gapFill'] += em.path['gap']
            extra['monthEdge'] += int(ymd(em.open)[:2] != ymd(em.T)[:2])
        del m1
        emails.extend(mine)
        pair_info.append(dict(pair=pair, judged=judged, notMailed=not_mailed,
                              first1h=iso(t1[0]) if t1 else None, first4h=iso(t4[0]) if t4 else None,
                              bars1h=len(t1), bars4h=len(t4), emails=len(mine)))
        log(f'  {pair}: 1h {len(t1)} bars, 4h {len(t4)}, judged {judged} (short {short}), emails {len(mine)}, '
            f'not mailed {not_mailed} ({time.time() - t_pair:.1f}s)')
    emails.sort(key=lambda e: (e.T, e.pi))
    return emails, pair_info, ld, extra


def row_of(e):
    p = e.path
    f = p['filled']
    return dict(pair=e.pair, open=iso(e.open), T=iso(e.T), side=e.side, E=e.E, m=e.m, top=e.top, bottom=e.bottom,
                half=e.half, month=e.month, A=e.A, B=e.B, filled=int(f), market=p['market'] if f else 0,
                fillT=iso(p['t0']) if f else None, fill=p['fill'] if f else None, tp=p['tp'] if f else 0,
                tpT=iso(p['tpT']) if f and p['tp'] else None, exit=p['exit'] if f and p['tp'] else None,
                endPx=p['endPx'] if f and not p['tp'] else None, pips=p['pips'] if f else None,
                mae=p['mae'] if f else None, hold=p['hold'] if f else None, g_result=p['g_result'] if f else None,
                g_pips=p['g_pips'] if f else None, g_both=p['g_both'] if f else None)


# ---------------------------------------------------------------- 表と比べ方
def stats_of(rows):
    fl = [r for r in rows if r['filled']]
    nf = len(fl)
    tp = sum(1 for r in fl if r['tp'])
    pips = [r['pips'] for r in fl]
    held = [r['pips'] for r in fl if not r['tp']]
    g = [r['g_result'] for r in fl]
    maes = [r['mae'] for r in fl]
    holds = [r['hold'] for r in fl]
    return dict(mails=len(rows), filled=nf, unfilled=len(rows) - nf, tp=tp, held=nf - tp,
                win=100 * tp / nf if nf else None,
                pipsMean=mean_in_order(pips), pipsMedian=median(pips),
                maeMedian=median(maes), maeMax=max(maes) if maes else None,
                holdMedian=median(holds), holdMax=max(holds) if holds else None,
                heldPipsSum=add_in_order(held), heldPipsMin=min(held) if held else None,
                guideTp=g.count('tp'), guideSl=g.count('sl'), guideHeld=g.count('held'),
                guideBoth=sum(1 for r in fl if r['g_both']),
                guideWin=100 * g.count('tp') / nf if nf else None,
                guidePipsMean=mean_in_order([r['g_pips'] for r in fl]))


def groups_of(rows, cand):
    return dict(with_=[r for r in rows if r[cand] == 'with'], against=[r for r in rows if r[cand] == 'against'],
                none=[r for r in rows if r[cand] == 'none'], decided=[r for r in rows if r[cand] != 'none'], all=rows)


def table_of(rows, cand):
    g = groups_of(rows, cand)
    return {'with': stats_of(g['with_']), 'against': stats_of(g['against']), 'none': stats_of(g['none']),
            'decided': stats_of(g['decided']), 'all': stats_of(g['all'])}


def filled_mean(rows):
    return mean_in_order([r['pips'] for r in rows if r['filled']])


def gap_of(rows, cand):
    """差 ＝ 順向きの平均 − 決まったものの平均（主の1回あたり、入った取引、行の順に足して数で割る）"""
    w = filled_mean([r for r in rows if r[cand] == 'with'])
    d = filled_mean([r for r in rows if r[cand] != 'none'])
    return None if w is None or d is None else w - d


def stage2_of(rows2, cand):
    dec = [r for r in rows2 if r[cand] != 'none']
    out = dict(cand=cand, gap=gap_of(rows2, cand), withMean=filled_mean([r for r in dec if r[cand] == 'with']))
    # 差の95%の幅: 月を引き直す bootstrap（種 371）
    months = sorted(set(r['month'] for r in dec))
    M = len(months)
    by = {mo: [r for r in dec if r['month'] == mo] for mo in months}
    rnd = mulberry32(BOOT_SEED)
    diffs, empty = [], 0
    for _ in range(DRAWS):
        sw = sd = 0.0
        nw = nd = 0
        for _ in range(M):
            for r in by[months[math.floor(rnd() * M)]]:
                if r['filled']:
                    sd += r['pips']
                    nd += 1
                    if r[cand] == 'with':
                        sw += r['pips']
                        nw += 1
        if nw == 0 or nd == 0:
            empty += 1
            continue
        diffs.append(sw / nw - sd / nd)
    diffs.sort()
    c = len(diffs)
    out['boot'] = dict(lo=diffs[js_round(0.025 * c) - 1] if c else None, hi=diffs[js_round(0.975 * c) - 1] if c else None,
                       empty=empty, months=M)
    # ランダムに外した場合（種 3710）
    N = len(dec)
    k = sum(1 for r in dec if r[cand] == 'against')
    rnd = mulberry32(DROP_SEED)
    means, no_trade = [], 0
    for _ in range(DRAWS):
        perm = list(range(N))
        for j in range(k):
            s = j + math.floor(rnd() * (N - j))
            perm[j], perm[s] = perm[s], perm[j]
        out_set = set(perm[:k])
        s = 0.0
        cnt = 0
        for i in range(N):
            if i in out_set:
                continue
            r = dec[i]
            if r['filled']:
                s += r['pips']
                cnt += 1
        if cnt == 0:
            no_trade += 1
            continue
        means.append(s / cnt)
    means.sort()
    c = len(means)
    line = means[js_round(0.95 * c) - 1] if c else None
    wm = out['withMean']
    out['drop'] = dict(line=line, above=sum(1 for x in means if wm is not None and x > wm), k=k, n=N)
    out['_dropAlt'] = dict(aboveOrEqual=sum(1 for x in means if wm is not None and x >= wm),
                           aboveDecided=sum(1 for x in means if x > filled_mean(dec)), noTrade=no_trade)
    b = out['boot']
    if b['lo'] is not None and b['lo'] > 0 and wm is not None and line is not None and wm > line:
        out['verdict'] = 'better'
    elif b['hi'] is not None and b['hi'] < 0:
        out['verdict'] = 'worse'
    else:
        out['verdict'] = 'indistinguishable'
    return out


def summary_of(rows, pair_info, ld):
    h1 = [r for r in rows if r['half'] == 1]
    h2 = [r for r in rows if r['half'] == 2]
    tables = {}
    for cand in ('A', 'B'):
        t = {'half1': table_of(h1, cand), 'half2': table_of(h2, cand), 'both': table_of(rows, cand)}
        for p in PAIRS:
            t[p] = table_of([r for r in rows if r['pair'] == p], cand)
        tables[cand] = t
    ga, gb = gap_of(h1, 'A'), gap_of(h1, 'B')
    if ga is None and gb is None:
        chosen = 'A'
    elif gb is None:
        chosen = 'A'
    elif ga is None:
        chosen = 'B'
    else:
        chosen = 'A' if ga >= gb else 'B'
    s2 = stage2_of(h2, chosen)
    alt = s2.pop('_dropAlt')
    other = 'B' if chosen == 'A' else 'A'
    return dict(
        meta=dict(draws=DRAWS, bootSeed=BOOT_SEED, dropSeed=DROP_SEED),
        stage1=dict(gapA=ga, gapB=gb, chosen=chosen),
        stage2=s2,
        other=dict(cand=other, gap=gap_of(h2, other)),
        tables=tables,
        pairs=pair_info,
        load=dict(failed=ld.failed, files=ld.files, oneSide=ld.one_side, crossed=ld.crossed, closure=ld.closure,
                  repeated=ld.repeated),
    ), alt


# ---------------------------------------------------------------- 比べる
STR_COLS = {'pair', 'open', 'T', 'side', 'month', 'A', 'B', 'fillT', 'tpT', 'g_result'}
INT_COLS = {'half', 'filled', 'market', 'tp', 'g_both'}
FLOAT_COLS = {'E', 'm', 'top', 'bottom', 'fill', 'exit', 'endPx', 'pips', 'mae', 'hold', 'g_pips'}
COLS = ['pair', 'open', 'T', 'side', 'E', 'm', 'top', 'bottom', 'half', 'month', 'A', 'B', 'filled', 'market', 'fillT',
        'fill', 'tp', 'tpT', 'exit', 'endPx', 'pips', 'mae', 'hold', 'g_result', 'g_pips', 'g_both']


class Cmp:
    def __init__(self):
        self.n = 0
        self.examples = []
        self.fields = 0
        self.exact = 0
        self.near = 0
        self.near_max = 0.0
        self.by = {}

    def bad(self, where, what, mine, theirs):
        self.n += 1
        self.by[what] = self.by.get(what, 0) + 1
        if len(self.examples) < 30:
            self.examples.append(f'{where} {what}: mine {mine!r} / TS {theirs!r}')

    def num(self, where, what, mine, theirs):
        """数: 完全に同じか、相対 1e-9 以内（どちらかを数える）。None は null・空と同じ。"""
        self.fields += 1
        if mine is None or theirs is None:
            if mine is None and theirs is None:
                self.exact += 1
            else:
                self.bad(where, what, mine, theirs)
            return
        if isinstance(theirs, bool) or isinstance(mine, bool):
            if mine == theirs and type(mine) is type(theirs):
                self.exact += 1
            else:
                self.bad(where, what, mine, theirs)
            return
        a, b = float(mine), float(theirs)
        if a == b:
            self.exact += 1
        elif math.isfinite(a) and math.isfinite(b) and abs(a - b) <= REL * max(abs(a), abs(b)):
            self.near += 1
            self.near_max = max(self.near_max, abs(a - b) / max(abs(a), abs(b)))
        else:
            self.bad(where, what, mine, theirs)

    def same(self, where, what, mine, theirs):
        self.fields += 1
        if mine == theirs:
            self.exact += 1
        else:
            self.bad(where, what, mine, theirs)


def compare_rows(C, mine, path):
    try:
        with open(path, newline='', encoding='utf-8') as f:
            rd = csv.DictReader(f)
            head = rd.fieldnames or []
            theirs = list(rd)
    except Exception as e:  # noqa: BLE001
        die(f'rows.csv: {e!r}')
    if head != COLS:
        C.bad('rows.csv', 'header', ','.join(COLS), ','.join(head))
    C.same('rows.csv', 'row count', len(mine), len(theirs))
    tk = {(r.get('pair'), r.get('T')): r for r in theirs}
    mk = {(r['pair'], r['T']): r for r in mine}
    for key in mk:
        if key not in tk:
            C.bad(f'{key[0]} {key[1]}', 'row', 'present', 'missing in rows.csv')
    for key in tk:
        if key not in mk:
            C.bad(f'{key[0]} {key[1]}', 'row', 'missing in mine', 'present')
    order_ok = [(r['pair'], r['T']) for r in mine if (r['pair'], r['T']) in tk] == \
        [(r.get('pair'), r.get('T')) for r in theirs if (r.get('pair'), r.get('T')) in mk]
    C.same('rows.csv', 'row order', True, order_ok)
    for r in mine:
        t = tk.get((r['pair'], r['T']))
        if t is None:
            continue
        where = f"{r['pair']} T={r['T']}"
        for col in COLS:
            v = r[col]
            s = t.get(col, '')
            s = '' if s is None else s
            if col in STR_COLS:
                C.same(where, col, '' if v is None else str(v), s)
            elif col in INT_COLS:
                try:
                    tv = None if s == '' else int(s)
                except ValueError:
                    tv = s
                C.same(where, col, v, tv)
            else:
                try:
                    tv = None if s == '' else float(s)
                except ValueError:
                    tv = s
                if isinstance(tv, str):
                    C.bad(where, col, v, tv)
                else:
                    C.num(where, col, v, tv)


def compare_tree(C, where, mine, theirs, skipped):
    if isinstance(mine, dict):
        if not isinstance(theirs, dict):
            C.bad(where, 'type', 'object', theirs)
            return
        for k, v in mine.items():
            if k not in theirs:
                C.bad(f'{where}.{k}', 'key', 'present', 'missing in summary.json')
                continue
            compare_tree(C, f'{where}.{k}', v, theirs[k], skipped)
        for k in theirs:
            if k not in mine:
                skipped.append(f'{where}.{k}')
        return
    if isinstance(mine, list):
        if not isinstance(theirs, list) or len(theirs) != len(mine):
            C.bad(where, 'list', len(mine), len(theirs) if isinstance(theirs, list) else theirs)
            return
        for i, (a, b) in enumerate(zip(mine, theirs)):
            compare_tree(C, f'{where}[{i}]', a, b, skipped)
        return
    if isinstance(mine, str) or isinstance(theirs, str):
        C.same(where, 'value', mine, theirs)
        return
    if mine is None or isinstance(mine, (int, float)):
        C.num(where, 'value', mine, theirs)
        return
    C.same(where, 'value', mine, theirs)


def main():
    ap = argparse.ArgumentParser(description='docs §8.124 の独立した計算し直し')
    ap.add_argument('--cache', required=True)
    ap.add_argument('--rows', required=True)
    ap.add_argument('--summary', required=True)
    a = ap.parse_args()
    t_all = time.time()
    try:
        with open(a.summary, encoding='utf-8') as f:
            S = json.load(f)
        meta = S['meta']
        start, end, split, load_from = (ms_of(meta[k]) for k in ('start', 'end', 'split', 'loadFrom'))
    except Exception as e:  # noqa: BLE001
        die(f'summary.json meta: {e!r}')
    if not os.path.isdir(a.cache):
        die(f'no cache folder {a.cache}')
    print(f'flowz-check (docs §8.124): period T in [{iso(start)}, {iso(end)}), split {iso(split)}, bars from {iso(load_from)}')
    real = dict(start='2024-01-01T00:00:00Z', end='2026-10-17T00:00:00Z', split='2025-05-19T00:00:00Z',
                loadFrom='2023-10-01T00:00:00Z')
    if all(ms_of(real[k]) == ms_of(meta[k]) for k in real):
        print('  the period is §8.124\'s (START 2024-01-01, END 2026-10-17, split 2025-05-19, bars from 2023-10-01)')
    else:
        print('  the period is NOT §8.124\'s real one (a test run)')
    emails, pair_info, ld, extra = compute(a.cache, start, end, split, load_from, print)
    rows = [row_of(e) for e in emails]
    mine, alt = summary_of(rows, pair_info, ld)
    n_f = sum(1 for r in rows if r['filled'])
    print(f'  emails {len(rows)} (filled {n_f}, unfilled {len(rows) - n_f}; market {sum(r["market"] for r in rows)}; '
          f'TP {sum(r["tp"] for r in rows)}, held {sum(1 for r in rows if r["filled"] and not r["tp"])}); '
          f'P moved past Rakuten\'s stop {extra["shifted"]}, no bar at P {extra["noBar"]}, not ordered {extra["none"]}, '
          f'limit filled at a better open {extra["gapFill"]}; windows short of 600 bars {extra["short"]}')
    print(f'  files read {ld.files}, failed {ld.failed}; 1-min bars left out: one side {ld.one_side}, crossed {ld.crossed}, '
          f'closure {ld.closure}, repeated {ld.repeated}; 1-min bars in Rakuten\'s stop {extra["stopBars"]}')
    print(f'  rules met here (where the TS and this check are compared on them): emails whose fill/TP/guide exit would '
          f'move if Rakuten\'s stop bars were judged {extra["stopMoved"]}; guide both-in-one-bar '
          f'{sum(1 for r in rows if r["g_both"])}; signals inside the closure (not mailed) '
          f'{sum(p["notMailed"] for p in pair_info)}; emails whose bar opens in the month before T {extra["monthEdge"]}')
    s1, s2 = mine['stage1'], mine['stage2']
    print(f'  stage1: gapA {s1["gapA"]!r}, gapB {s1["gapB"]!r} -> {s1["chosen"]}; stage2 ({s2["cand"]}): gap {s2["gap"]!r}, '
          f'with {s2["withMean"]!r}, boot [{s2["boot"]["lo"]!r}, {s2["boot"]["hi"]!r}] (empty {s2["boot"]["empty"]}, '
          f'months {s2["boot"]["months"]}), random line {s2["drop"]["line"]!r} (k {s2["drop"]["k"]} of n {s2["drop"]["n"]}) '
          f'-> {s2["verdict"]}')
    if ld.failed:
        print('  files not read: ' + '; '.join(ld.failed_ex))

    C = Cmp()
    compare_rows(C, rows, a.rows)
    skipped = []
    th = dict(S)
    th_meta = th.get('meta', {})
    compare_tree(C, 'meta', mine['meta'], {k: th_meta.get(k) for k in mine['meta']}, [])
    for k in ('stage1', 'stage2', 'other', 'tables', 'pairs', 'load'):
        if k not in th:
            C.bad(k, 'key', 'present', 'missing in summary.json')
            continue
        compare_tree(C, k, mine[k], th[k], skipped)
    for k in th:
        if k not in mine and k != 'meta':
            skipped.append(k)
    ts_above = (th.get('stage2') or {}).get('drop', {}).get('above') if isinstance(th.get('stage2'), dict) else None
    if ts_above is not None and ts_above != mine['stage2']['drop']['above']:
        print(f'  note: stage2.drop.above (not defined in §8.124) is read here as the draws whose mean is above the '
              f'"with" mean; >= gives {alt["aboveOrEqual"]}, above the decided mean {alt["aboveDecided"]}')
    if alt['noTrade']:
        print(f'  note: {alt["noTrade"]} random drops left no filled trade and were left out of the line')
    print(f'compared {C.fields} fields: {C.exact} exactly equal, {C.near} equal within {REL:g} relative '
          f'(largest {C.near_max:.3g}), {C.n} different')
    if skipped:
        print('not recomputed (process counts of the TS run): ' + ', '.join(skipped))
    if C.n:
        print('differences by item: ' + ', '.join(f'{k} {v}' for k, v in sorted(C.by.items(), key=lambda x: -x[1])))
        for x in C.examples:
            print('  ' + x)
    print(f'({time.time() - t_all:.1f}s)')
    if C.n:
        print(f'FLOWZ-CHECK FAILED: {C.n} differences')
        sys.exit(1)
    print('FLOWZ-CHECK PASSED')
    sys.exit(0)


if __name__ == '__main__':
    main()
