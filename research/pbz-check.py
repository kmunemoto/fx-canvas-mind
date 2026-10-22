#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
pbz-check.py — docs/OPERATIONS.md §8.125（楽天FXのピークボトム、期間10、1時間足のメール A・B・C）の独立した
計算し直し（Python。標準ライブラリだけ。numpy は使わない）。

書いた元: §8.125 と、そこが指す §8.124（期間・足の読み方・mailedAt・E の丸め・持ち方・目安・月の bootstrap）・
§8.102（オーナーの持ち方）・§8.106（GMO の足の読み方）。決まりとして名前の出る本番のコード: live-chart/logic.ts
（historyRead の丸め Number(v.toFixed(d))、中値は analyze/price-source.ts の midCandle〈(Bid＋Ask)÷2〉）、
_shared/market-hours.ts（isPossiblyClosed・isMarketClosed・barInsideClosure）、track-outcomes/quotes.ts（GMO の
ファイルの形と mergeSides）。research/pbz.ts・pbz-lib.ts・pbz-hand.ts・.github/workflows/pbz.yml と、その取引の
コードの元の research/flowz.ts・flowz-lib.ts は読んでいない。

research/flowz-check.py（§8.124 の独立した Python。実データで TypeScript と一致した）から使ったもの:
  - そのまま: GMO のファイルの読み方（LoadStats・_num・parse_klines・sound・read_side・date_keys_day・keys_of・
    load_tf・M1）、時刻と閉まり（ms_of・iso・js_day・utc_hour・ymd・jst_day_key・is_market_closed・
    is_possibly_closed・bar_inside_closure・mailed・ny_summer・stop_start）、数（js_round・round_chart・
    mulberry32・add_in_order・mean_in_order・median）、比べる道具 Cmp。
  - 手を入れて: Seek.first（探す範囲の終わり lim を足した）、follow（終わりの時刻 end と、end までに終わる1分足の
    数 n_end を受け取り、SPLIT で切る取引にも使う。目安を出すかどうかを選べる）、compare_rows・compare_tree
    （この節の列と、summary.json の知らない鍵を違いとして数えるように）。
  丸の並び（M_k・M_{k,分}・M_END）、メール A・B・C、逆向き、SPLIT で切った取引、表・段1・段2・beside・counts・
  pairs・startCheck は、ここで新しく書いた。

速さ（はじめから出し直すのと同じになる近道だけを使う）:
  - 足 t の候補は、後の10本がそろうと（足 t＋10 の確定で）もう変わらない。それを古い順に「確定した並び」に
    交互の決まりで足していく。M_k は、確定した並び（足 k−10 まで）の最後の丸から、まだ変わりうる足 k−9〜k の
    候補だけを交互に足して出す。M_{k,分} は、確定した並び（足 k−11 まで）の最後の丸から、足 k−10〜k（足 k は
    その分までの1分足の高値・安値）を足して出す。交互の決まりは直前に残した1つしか見ないので、毎回はじめから
    出した並びと同じになる。
  - 作っている足の中では、高値か安値が変わった分だけ M_{k,分} を出し直す（変わらない分は並びも C の判定も前の
    分と同じ）。足 k が候補でない分（高値が前の10本の高値以下で、安値が前の10本の安値以上）は、丸が足 k に
    出ないので並びを出さない。

この節が決めていない所の読み方（依頼のエージェントから受け取った。§8.125 に書き足される予定）:
  1. C は、決まりに合う最初の分に出る（送れるかどうかによらない）。送れない時刻なら「閉まりの中」に数え、
     その足には、ほかの C は出ない。1本の足に C は1回まで。
  2. C が読むのは、始まりが [足 k の始まり, ＋1時間) の1分足だけ。1分足の無い足に C は出ない。
  3. 前の足が無い（k＝0）時、M_{k−1} に丸は無い。
  4. sameBarAB: 送った B の行のうち、同じペア・同じ足 k に送った A の行があるもの。sameBarAC も同じ。
  5. cVanished: 送った C の行のうち、M_k（足 k の確定の時）で足 k に同じ種類の丸が無いもの。
  6. cBarsSeen: 確定が期間の中の足のうち、中に1分足が1本以上あるもの。cBarDiff: そのうち、中の1分足すべての
     Bid の高値の一番高い値か安値の一番安い値が、1時間足のファイルの Bid の高値・安値と違うもの。
  7. SPLIT でまだ持っている取引の SPLIT の値: SPLIT までに終わる最後の1分足の決済側の終値（END の値と同じ作り）。
     持った期間は SPLIT まで。P（楽天の停止を過ぎて動かした後）が SPLIT 以後の取引は入らない。
  8. heldAtSplit.pipsAtEnd は、それぞれの取引の通しの結果（SPLIT の後に利確したならその利確、そうでなければ
     END の値）。

使い方:
  python3 research/pbz-check.py --cache DIR --rows rows.csv --summary summary.json
    DIR: <DIR>/<USD_JPY など>/<1min|1hour>/<bid|ask>/<YYYYMMDD>.json（GMO の形。鍵は GMO の日）
    期間（start・end・split・loadFrom）は summary.json の meta から読む。meta が §8.125 の実データの期間の時だけ、
    読み込みの始まりの確かめ（startCheck: 1時間足を 2023-12-01 から読み直したメール。1分足は同じ）も計算し直す
    （--start-check on|off で、いつも・決して、に変えられる。実データの期間で作った作り物の値動きは off）。
    読み直した1時間足のファイルは load の数に入れない（別に出す）。
終了コード: 0 = 全部一致（最後の行 PBZ-CHECK PASSED）、1 = 違いがある、または入力の誤り
（最後の行 PBZ-CHECK FAILED: n differences）。
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
PAIRS = ['USD/JPY', 'EUR/JPY', 'AUD/JPY', 'EUR/USD', 'AUD/USD']   # 行の順（同じ時刻はこの順）
CANDS = ['A', 'B', 'C']                                           # 同じ時刻・同じペアはこの順
TERM = 10                        # ピークボトムの期間（前の10本・後の10本）
TP_PIPS = 10                     # オーナーの利確（E ± 10 pips）
G_SL, G_TP = 13, 4               # メールの目安（損切り E ∓ 13、利確 E ± 4）
P_AFTER = 2 * MIN                # P ＝ メールの時刻 ＋ 2分
STOP_LEN = 15 * MIN              # 楽天が止まる時間 [τ, τ＋15分)
READ_AFTER = (0, 3, 5)           # A・B: 確定の0・3・5分後（の1秒後）に読む（§8.124 の mailedAt）
DRAWS = 10_000
BOOT_SEED = 378
REL = 1e-9
BLK = 256
INF = float('inf')
PEAK, BOTTOM = 'peak', 'bottom'
REAL = dict(start='2024-01-01T00:00:00Z', end='2026-10-17T00:00:00Z', split='2025-05-19T00:00:00Z',
            loadFrom='2023-10-01T00:00:00Z')
LATER_FROM = '2023-12-01T00:00:00Z'   # 読み込みの始まりの確かめ（実データ）
_EPOCH = datetime.datetime(1970, 1, 1, tzinfo=datetime.timezone.utc)


def die(msg):
    """入力の誤り: 理由を出し、違い1つとして失敗で終える"""
    print('ERROR: ' + msg)
    print('PBZ-CHECK FAILED: 1 differences')
    sys.exit(1)


# ---------------------------------------------------------------- 時刻（JS の Date の UTC と同じ）〔flowz-check.py〕
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


def month_of(ms):
    y, m, _ = ymd(ms)
    return '%04d-%02d' % (y, m)


def jst_day_key(ms):
    """track-outcomes/quotes.ts jstDayKey"""
    y, m, d = ymd(ms + 9 * HOUR)
    return '%04d%02d%02d' % (y, m, d)


def is_market_closed(ms):
    """market-hours.ts isMarketClosed"""
    d, h = js_day(ms), utc_hour(ms)
    return d == 6 or (d == 5 and h >= 22) or (d == 0 and h < 21)


def is_possibly_closed(ms):
    """market-hours.ts isPossiblyClosed"""
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
    """A・B が送られる時刻: 確定の0・3・5分後（の1秒後）のどれかが isPossiblyClosed でない（§8.124 mailedAt）"""
    return any(not is_possibly_closed(T + m * MIN + 1000) for m in READ_AFTER)


def mailed_c(T):
    """C が送られる時刻: T_C の1秒あとが閉まりの中でない"""
    return not is_possibly_closed(T + 1000)


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


# ---------------------------------------------------------------- 数（JS と同じ）〔flowz-check.py〕
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
    """前から1つずつ足す（Python 3.12 の sum() は補正つきの足し方なので、小数には使わない）"""
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


# ---------------------------------------------------------------- GMO のファイル〔flowz-check.py〕
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
    """1分足（ownerhold-data.ts loadM1）と、探すための塊ごとの最小・最大〔flowz-check.py〕"""

    def __init__(self, pair, cache, from_ms, to_ms, ld):
        self.pair = pair
        self.usd = pair.endswith('/USD')
        self.unit = 0.0001 if self.usd else 0.01
        sym = pair.replace('/', '_')
        t, bo, bh, bl, bc, ao, ah, al, ac = ([] for _ in range(9))
        last = -INF
        # loadM1: 鍵ごとに Bid と Ask を時刻で合わせ（片側だけ・Ask の終値が下は落とす）、鍵の順に、期間の外・
        # 閉まりの中・前の足と同じか前の時刻を落とす
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
    """k 以後（lim より前）の最初の「≦x」（min）／「≧x」（max）と、区間の最小・最大を、塊ごとの最小・最大で引く"""

    def __init__(self, a, is_min):
        self.a = a
        self.n = len(a)
        f = min if is_min else max
        self.b = [f(a[i:i + BLK]) for i in range(0, self.n, BLK)]
        self.is_min = is_min

    def first(self, k, x, lim=None):
        a, b = self.a, self.b
        n = self.n if lim is None else min(lim, self.n)
        if k < 0:
            k = 0
        if k >= n:
            return -1
        bi = k // BLK
        end = min((bi + 1) * BLK, n)
        nb = (n + BLK - 1) // BLK
        if self.is_min:
            for i in range(k, end):
                if a[i] <= x:
                    return i
            for j in range(bi + 1, nb):
                if b[j] <= x:
                    for i in range(j * BLK, min((j + 1) * BLK, n)):
                        if a[i] <= x:
                            return i
            return -1
        for i in range(k, end):
            if a[i] >= x:
                return i
        for j in range(bi + 1, nb):
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


# ---------------------------------------------------------------- 1通の持ち方（§8.102 の本線）と目安〔flowz-check.py を手直し〕
def follow(pr, P0, dirn, E, end, n_end, with_guide):
    """§8.102 の本線の追い方: P が楽天の止まる時間に入れば、その終わりに動かす。P に始まる足があればその始値で、
    無ければ P 以前に終わる最後の足の終値で、すでに E より良ければ成行。そうでなければ E の指値（触れたら約定。
    始値が E より良ければ始値）。利確は約定の次の足から（利確の値と始値の良い方）。止まる時間の足では約定・利確を
    判定しない。目安（損切り13・利確4）は同じ約定から、次の足以後で先に届いた方。
    end: 終わりの時刻（END、または SPLIT で切る取引の SPLIT）。n_end: end までに終わる1分足の数（その先は見ない）。
    end までに利確しない取引の値は、end までに終わる最後の1分足の決済側の終値、持った期間は end まで。"""
    r = dict(none=False, filled=False, market=0, t0=None, fill=None, tp=0, tpK=-1, tpT=None, exit=None, endPx=None,
             pips=None, mae=None, hold=None, g_result=None, g_pips=None, g_both=None, shifted=0, noBar=0, gap=0,
             stopMoved=0)
    P = P0
    tau = stop_start(P)
    if tau is not None:
        P = tau + STOP_LEN
        r['shifted'] = 1
    r['P'] = P
    t, unit = pr.t, pr.unit
    n = n_end
    if P >= end or n == 0:
        r['none'] = True
        return r
    kk = bisect.bisect_left(t, P, 0, n)
    k0 = kk if kk < n and t[kk] == P else -1
    first_after = bisect.bisect_right(t, P, 0, n)
    if k0 >= 0:
        now = pr.ao[k0] if dirn > 0 else pr.bo[k0]
    else:
        r['noBar'] = 1
        kp = bisect.bisect_right(t, P - MIN, 0, n) - 1
        if kp < 0:
            r['none'] = True
            return r
        now = pr.ac[kp] if dirn > 0 else pr.bc[kp]
    ks0 = k0 if k0 >= 0 else first_after
    if (now <= E) if dirn > 0 else (now >= E):
        fk, t0, fill = k0, P, now
        r['market'] = 1
    else:
        k = pr.s_al.first(ks0, E, n) if dirn > 0 else pr.s_bh.first(ks0, E, n)
        if k < 0:
            u = pr.u_al.first(ks0, E, n) if dirn > 0 else pr.u_bh.first(ks0, E, n)
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
    k = pr.s_bh.first(ts, tp, n) if dirn > 0 else pr.s_al.first(ts, tp, n)
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
    moved = False
    if not r['market']:
        moved = (pr.u_al.first(ks0, E, n) if dirn > 0 else pr.u_bh.first(ks0, E, n)) != fk
    moved = moved or (pr.u_bh.first(ts, tp, n) if dirn > 0 else pr.u_al.first(ts, tp, n)) != r['tpK']
    if not with_guide:
        r['stopMoved'] = int(moved)
        return r
    # メールの目安
    sl = E - dirn * G_SL * unit
    gt = E + dirn * G_TP * unit

    def guide(k1, k2):
        """k1: 損切りに届いた最初の足、k2: 利確（4）に届いた最初の足（無ければ −1）から、先に届いた方"""
        hits = [x for x in (k1, k2) if x >= 0]
        if not hits:
            return 'held', end_px, 0, -1
        kx = min(hits)
        o2 = pr.bo[kx] if dirn > 0 else pr.ao[kx]
        if (o2 <= sl) if dirn > 0 else (o2 >= sl):
            return 'sl', o2, 0, kx                     # 始まりですでに越えていた: その始値
        if (o2 >= gt) if dirn > 0 else (o2 <= gt):
            return 'tp', o2, 0, kx
        if k1 == kx and k2 == kx:
            return 'sl', sl, 1, kx                     # 同じ1分足で両方: 損切りとして数える
        if k1 == kx:
            return 'sl', sl, 0, kx
        return 'tp', gt, 0, kx

    if dirn > 0:
        g = guide(pr.s_bl.first(ts, sl, n), pr.s_bh.first(ts, gt, n))
    else:
        g = guide(pr.s_ah.first(ts, sl, n), pr.s_al.first(ts, gt, n))
    r.update(g_result=g[0], g_pips=dirn * (g[1] - fill) / unit, g_both=g[2])
    # 数えるだけ（結果は変えない）: 止まる時間の足も判定していたら、約定・利確・目安の決済が変わっていたか
    if dirn > 0:
        moved = moved or guide(pr.m_bl.first(ts, sl, n), pr.u_bh.first(ts, gt, n)) != g
    else:
        moved = moved or guide(pr.m_ah.first(ts, sl, n), pr.u_al.first(ts, gt, n)) != g
    r['stopMoved'] = int(moved)
    return r


# ---------------------------------------------------------------- ピークボトムの丸の並び（§8.125）
def candidate(j, h, l, pp, pb, fp, fb):
    """足 j の候補: (足の番号, 種類, 値, 両方) か None。fp・fb は後の足の高値の一番高い値・安値の一番安い値
    （後の足が無ければ None: 前の10本とだけ比べる）。両方の候補はピークだけとして扱う（両方＝True）。"""
    pk = h > pp and (fp is None or h >= fp)
    bt = l < pb and (fb is None or l <= fb)
    if pk:
        return (j, PEAK, h, bt)
    if bt:
        return (j, BOTTOM, l, False)
    return None


def step_last(cur, c):
    """交互の決まりの1歩（直前に残した1つだけを見る）。返すのは、新しく直前に残した丸。"""
    if cur is None or cur[1] != c[1]:
        return c
    if (c[2] > cur[2]) if c[1] == PEAK else (c[2] < cur[2]):
        return c
    return cur


def tail_of(base, cands):
    """確定した並びの最後の丸 base（無ければ None）から、候補 cands を古い順に交互の決まりで足した後ろの部分。
    並び全体は、確定した並びの最後の1つを除いたもの ＋ これ。"""
    out = [base] if base is not None else []
    for c in cands:
        if not out or out[-1][1] != c[1]:
            out.append(c)
        elif (c[2] > out[-1][2]) if c[1] == PEAK else (c[2] < out[-1][2]):
            out[-1] = c
    return out


class Tally:
    def __init__(self):
        self.replaced = 0          # 確定した並びで、同じ種類のより高い（安い）候補が直前の丸を置き換えた
        self.dropped = 0           # 確定した並びで、同じ種類の候補が直前の丸より低い（高い）ので残らなかった
        self.ties = 0              # 確定した並びで、同じ種類・同じ値なので古い方を残した
        self.tail_ties = 0         # 期間の M_k の右端の部分で、同じ種類・同じ値なので古い方を残した
        self.tail_replaced = 0     # 期間の M_k の右端の部分で、同じ種類の候補が直前の丸を置き換えた
        self.eq_fp = []            # 確定した候補で H＝FP（≧ で候補）の足
        self.eq_fb = []            # 確定した候補で L＝FB（≦ で候補）の足
        self.eq_pp = 0             # H＝PP で、> でなければピークの候補だった足（≧ FP は満たす）
        self.eq_pb = 0             # L＝PB で、< でなければボトムの候補だった足
        self.both_final = 0        # 確定した候補で両方の条件を満たした足（ピークとして扱う）
        self.both_became_bottom = 0  # M_k ではピーク（両方）として出て、M_END では同じ足がボトム


class MarkRun:
    pass


def run_marks(t1, H, L, m1, start, end):
    """1ペアの丸の並びを、読み込んだ最初の足から順に作る。
    返すもの: events（A・B・C の合図。時刻は期間の外のものも含む）、M_END、足ごとの M_k の足 k の丸の種類、
    1分足から作った足の高値・安値、両方の足、数えたもの。"""
    N = len(t1)
    PP = [None] * N
    PB = [None] * N
    for t in range(TERM, N):
        PP[t] = max(H[t - TERM:t])
        PB[t] = min(L[t - TERM:t])
    tl = Tally()
    final = []                     # 確定した並び（後の10本がそろった足の候補だけを交互にしたもの）
    final_both = bytearray(N)      # 確定した候補の評価で両方の条件を満たした足
    events = []                    # (cand, k, time, mark, minute_index or -1)
    on_k = [None] * N              # M_k で足 k にある丸の種類（無ければ None）
    minute_hl = {}                 # 足 k: (1分足の Bid の高値の一番高い値, 安値の一番安い値, 1分足の数)
    latest_prev = None             # M_{k−1} の一番新しい丸
    last_tail = []
    edge_both = {}                 # M_END の右端（後の10本がそろわない足）で両方の条件を満たした足
    if m1 is not None:
        mt, mbh, mbl = m1.t, m1.bh, m1.bl
    for k in range(N):
        # ---- C（足 k を作っている間。確定した並びは足 k−11 まで）
        if m1 is not None:
            lo_i = bisect.bisect_left(mt, t1[k])
            hi_i = bisect.bisect_left(mt, t1[k] + HOUR, lo_i)
            if lo_i < hi_i:
                base = final[-1] if final else None
                pkind = latest_prev[1] if latest_prev is not None else None
                ppk, pbk = PP[k], PB[k]
                h, l = -INF, INF
                fired = None
                sh = sl = None
                j0 = max(k - TERM, 0)
                for i in range(lo_i, hi_i):
                    x = mbh[i]
                    y = mbl[i]
                    ch = False
                    if x > h:
                        h = x
                        ch = True
                    if y < l:
                        l = y
                        ch = True
                    if not ch or fired is not None or ppk is None:
                        continue
                    if not (h > ppk or l < pbk):
                        continue                       # 足 k は候補でない: 丸は足 k に出ない
                    if sh is None:
                        # 足 j（k−10〜k−1）の後の確定した足（j＋1〜k−1）の高値の一番高い値・安値の一番安い値
                        sh = [0.0] * (k - j0)
                        sl = [0.0] * (k - j0)
                        a, b = -INF, INF
                        for j in range(k - 1, j0 - 1, -1):
                            sh[j - j0] = a
                            sl[j - j0] = b
                            if H[j] > a:
                                a = H[j]
                            if L[j] < b:
                                b = L[j]
                    cur = base
                    for j in range(j0, k):
                        if j < TERM:
                            continue
                        fp = sh[j - j0]
                        if h > fp:
                            fp = h
                        fb = sl[j - j0]
                        if l < fb:
                            fb = l
                        c = candidate(j, H[j], L[j], PP[j], PB[j], fp, fb)
                        if c is not None:
                            cur = step_last(cur, c)
                    c = candidate(k, h, l, ppk, pbk, None, None)
                    if c is not None:
                        cur = step_last(cur, c)
                    if cur is not None and cur[0] == k and cur[1] != pkind:
                        fired = (i, cur)
                minute_hl[k] = (h, l, hi_i - lo_i)
                if fired is not None:
                    i, cur = fired
                    events.append(('C', k, mt[i] + MIN, cur, i))
        # ---- 足 k−10 の候補は、後の10本（k−9〜k）がそろったので、もう変わらない: 確定した並びに足す
        t = k - TERM
        if t >= TERM:
            hh, ll = H[t], L[t]
            fp = max(H[t + 1:k + 1])
            fb = min(L[t + 1:k + 1])
            pk = hh > PP[t] and hh >= fp
            bt = ll < PB[t] and ll <= fb
            if pk and hh == fp:
                tl.eq_fp.append(t)
            if bt and ll == fb:
                tl.eq_fb.append(t)
            if hh == PP[t] and hh >= fp:
                tl.eq_pp += 1
            if ll == PB[t] and ll <= fb:
                tl.eq_pb += 1
            if pk and bt:
                final_both[t] = 1
                tl.both_final += 1
            c = (t, PEAK, hh, bt) if pk else ((t, BOTTOM, ll, False) if bt else None)
            if c is not None:
                if not final or final[-1][1] != c[1]:
                    final.append(c)
                else:
                    last = final[-1]
                    if (c[2] > last[2]) if c[1] == PEAK else (c[2] < last[2]):
                        final[-1] = c
                        tl.replaced += 1
                    elif c[2] == last[2]:
                        tl.ties += 1
                    else:
                        tl.dropped += 1
        # ---- M_k（足 k まで確定）: 確定した並び（足 k−10 まで）の最後の丸から、足 k−9〜k の候補を足す
        base = final[-1] if final else None
        rev = []
        a, b = -INF, INF
        jlo = max(k - TERM + 1, TERM)
        j = k
        while j >= jlo:
            if j == k:
                c = candidate(j, H[j], L[j], PP[j], PB[j], None, None)
            else:
                c = candidate(j, H[j], L[j], PP[j], PB[j], a, b)
            if c is not None:
                rev.append(c)
            if H[j] > a:
                a = H[j]
            if L[j] < b:
                b = L[j]
            j -= 1
        rev.reverse()
        tail = [base] if base is not None else []
        in_period = start <= t1[k] + HOUR < end
        for c in rev:
            if not tail or tail[-1][1] != c[1]:
                tail.append(c)
            elif (c[2] > tail[-1][2]) if c[1] == PEAK else (c[2] < tail[-1][2]):
                tail[-1] = c
                if in_period:
                    tl.tail_replaced += 1
            elif c[2] == tail[-1][2] and in_period:
                tl.tail_ties += 1
        latest = tail[-1] if tail else None
        # A: M_k に足 k−10 の丸がある
        if t >= TERM:
            for m in tail:
                if m[0] == t:
                    events.append(('A', k, t1[k] + HOUR, m, -1))
                    break
        # B: M_k の一番新しい丸が足 k にあり、その種類が M_{k−1} の一番新しい丸と違う（M_{k−1} に丸が無い時も）
        if latest is not None and latest[0] == k and (latest_prev is None or latest_prev[1] != latest[1]):
            events.append(('B', k, t1[k] + HOUR, latest, -1))
        on_k[k] = latest[1] if latest is not None and latest[0] == k else None
        latest_prev = latest
        if k == N - 1:
            last_tail = tail
            for c in rev:
                if c[3]:
                    edge_both[c[0]] = True
    mr = MarkRun()
    mr.events = events
    mr.mend = (final[:-1] + last_tail) if final else list(last_tail)
    mr.on_k = on_k
    mr.minute_hl = minute_hl
    mr.final_both = final_both
    mr.edge_both = edge_both
    mr.tally = tl
    mr.N = N
    return mr


# ---------------------------------------------------------------- 1ペアの計算
def half_counts():
    return dict(half1=0, half2=0, both=0)


def add_half(d, half):
    d['half1' if half == 1 else 'half2'] += 1
    d['both'] += 1


def emails_of(mr, pair, t1, Eab, m1, dec, start, end, split):
    """期間の中の合図を、送れるもの（行）と送れないもの（閉まりの中）に分ける。行は取引の前の形。"""
    out, closed = [], {c: half_counts() for c in CANDS}
    for cand, k, tm, mark, mi in mr.events:
        if not (start <= tm < end):
            continue
        half = 1 if tm < split else 2
        ok = mailed(tm) if cand != 'C' else mailed_c(tm)
        if not ok:
            add_half(closed[cand], half)
            continue
        E = Eab[k] if cand != 'C' else round_chart((m1.bc[mi] + m1.ac[mi]) / 2, dec)
        out.append(dict(cand=cand, pair=pair, k=k, open=iso(t1[k]), T=iso(tm), _t=tm, side='BUY' if mark[1] == BOTTOM else 'SELL',
                        E=E, markI=mark[0], markT=iso(t1[mark[0]]), markKind=mark[1], markPrice=mark[2],
                        both=1 if mark[3] else 0, weekFirst=1 if k > 0 and t1[k] - t1[k - 1] >= 24 * HOUR else 0,
                        half=half, month=month_of(tm), _mi=mi))
    return out, closed


def compute_pair(cache, pi, pair, start, end, split, load_from, ld, later_from, ld2, log):
    t_pair = time.time()
    sym = pair.replace('/', '_')
    dec = 5 if pair.endswith('/USD') else 3
    h1 = load_tf(cache, sym, '1hour', HOUR, keys_of(load_from, end), load_from, end, ld)
    t1 = [x[0] for x in h1]
    H = [x[1][2] for x in h1]
    L = [x[1][3] for x in h1]
    Eab = [round_chart((x[1][4] + x[2][4]) / 2, dec) for x in h1]
    m1 = M1(pair, cache, start, end, ld)
    t_load = time.time() - t_pair
    mr = run_marks(t1, H, L, m1, start, end)
    mend = {m[0]: m for m in mr.mend}
    rows, closed = emails_of(mr, pair, t1, Eab, m1, dec, start, end, split)
    n_split = bisect.bisect_right(m1.t, split - MIN)          # SPLIT までに終わる1分足の数
    x = dict(shifted=0, noBar=0, none=0, gap=0, unfilled=0, stopMoved=0, o_shifted=0, o_noBar=0, o_none=0, o_gap=0,
             o_unfilled=0, o_stopMoved=0, s_unfilled=0, so_unfilled=0, s_heldAtSplit=0, stopBars=m1.stops,
             m1bars=m1.n, eqfp_rows=0)
    eq_set = set(mr.tally.eq_fp) | set(mr.tally.eq_fb)
    for r in rows:
        dirn = 1 if r['side'] == 'BUY' else -1
        tm = r['_t']
        m = mend.get(r['markI'])
        r['stays'] = 1 if m is not None and m[1] == r['markKind'] else 0
        r['otherKind'] = 1 if m is not None and m[1] != r['markKind'] else 0
        if r['cand'] == 'A' and r['markI'] in eq_set:
            x['eqfp_rows'] += 1
        own = follow(m1, tm + P_AFTER, dirn, r['E'], end, m1.n, True)
        opp = follow(m1, tm + P_AFTER, -dirn, r['E'], end, m1.n, False)
        for p, pre in ((own, ''), (opp, 'o_')):
            x[pre + 'shifted'] += p['shifted']
            x[pre + 'noBar'] += p['noBar']
            x[pre + 'none'] += int(p['none'])
            x[pre + 'gap'] += p['gap']
            x[pre + 'unfilled'] += int(not p['filled'] and not p['none'])
            x[pre + 'stopMoved'] += p['stopMoved']
        f = own['filled']
        r.update(filled=int(f), market=own['market'] if f else 0, fillT=iso(own['t0']) if f else None,
                 fill=own['fill'] if f else None, tp=own['tp'] if f else 0,
                 tpT=iso(own['tpT']) if f and own['tp'] else None, exit=own['exit'] if f and own['tp'] else None,
                 endPx=own['endPx'] if f and not own['tp'] else None, pips=own['pips'] if f else None,
                 mae=own['mae'] if f else None, hold=own['hold'] if f else None,
                 g_result=own['g_result'] if f else None, g_pips=own['g_pips'] if f else None,
                 g_both=own['g_both'] if f else None)
        g = opp['filled']
        r.update(o_filled=int(g), o_market=opp['market'] if g else 0, o_fillT=iso(opp['t0']) if g else None,
                 o_fill=opp['fill'] if g else None, o_tp=opp['tp'] if g else 0,
                 o_tpT=iso(opp['tpT']) if g and opp['tp'] else None, o_pips=opp['pips'] if g else None,
                 o_mae=opp['mae'] if g else None, o_hold=opp['hold'] if g else None)
        if r['half'] == 1:
            s = follow(m1, tm + P_AFTER, dirn, r['E'], split, n_split, False)
            so = follow(m1, tm + P_AFTER, -dirn, r['E'], split, n_split, False)
            sf, sof = s['filled'], so['filled']
            r.update(s_filled=int(sf), s_tp=s['tp'] if sf else 0, s_held=1 if sf and not s['tp'] else 0,
                     s_pips=s['pips'] if sf else None, so_filled=int(sof), so_pips=so['pips'] if sof else None)
            x['s_unfilled'] += int(not sf)
            x['so_unfilled'] += int(not sof)
            x['s_heldAtSplit'] += int(sf and not s['tp'])
        else:
            r.update(s_filled=None, s_tp=None, s_held=None, s_pips=None, so_filled=None, so_pips=None)
    # 数（このペア）
    marks = {PEAK: half_counts(), BOTTOM: half_counts()}
    both_bars = {'full': half_counts(), 'edge': half_counts()}
    judged = 0
    N = mr.N
    for k in range(N):
        cl = t1[k] + HOUR
        if not (start <= cl < end):
            continue
        judged += 1
        half = 1 if cl < split else 2
        m = mend.get(k)
        if m is not None:
            add_half(marks[m[1]], half)
        if k + TERM <= N - 1:
            if mr.final_both[k]:
                add_half(both_bars['full'], half)
        elif mr.edge_both.get(k):
            add_half(both_bars['edge'], half)
    seen = diff = 0
    for k, (h, l, cnt) in mr.minute_hl.items():
        cl = t1[k] + HOUR
        if not (start <= cl < end) or cnt == 0:
            continue
        seen += 1
        if h != H[k] or l != L[k]:
            diff += 1
    vanished = sum(1 for r in rows if r['cand'] == 'C' and mr.on_k[r['k']] != r['markKind'])
    # 両方として出たピークが、M_END では同じ足のボトムになったもの（数えるだけ）
    became = sum(1 for r in rows if r['both'] and r['otherKind'])
    info = dict(pair=pair, bars=N, firstBar=iso(t1[0]) if t1 else None, judged=judged, marks=marks,
                bothBars=both_bars, closed=closed, cVanished=vanished, cBarDiff=diff, cBarsSeen=seen,
                emails=len(rows))
    # 読み込みの始まりの確かめ（実データ）: 1時間足を later_from から読んでも、期間のメールが同じか
    # （1時間足を later_from から読み直す。1分足は同じ。読んだファイルは load に入れず、ld2 に数える。）
    later = None
    if later_from is not None:
        h1b = load_tf(cache, sym, '1hour', HOUR, keys_of(later_from, end), later_from, end, ld2)
        t1b = [y[0] for y in h1b]
        mr2 = run_marks(t1b, [y[1][2] for y in h1b], [y[1][3] for y in h1b], m1, start, end)
        rows2, _ = emails_of(mr2, pair, t1b, [round_chart((y[1][4] + y[2][4]) / 2, dec) for y in h1b], m1, dec,
                             start, end, split)
        later = [key_of(r) for r in rows2]
        info_later = f'; from {iso(later_from)}: 1h {len(t1b)} bars from {iso(t1b[0]) if t1b else None}, emails {len(rows2)}'
    else:
        info_later = ''
    tal = mr.tally
    x.update(eq_fp=len(tal.eq_fp), eq_fb=len(tal.eq_fb), eq_fp_kept=sum(1 for t in tal.eq_fp if t in mend and mend[t][1] == PEAK),
             eq_fb_kept=sum(1 for t in tal.eq_fb if t in mend and mend[t][1] == BOTTOM), eq_pp=tal.eq_pp, eq_pb=tal.eq_pb,
             replaced=tal.replaced, dropped=tal.dropped, ties=tal.ties, tail_ties=tal.tail_ties,
             tail_replaced=tal.tail_replaced, both_final=tal.both_final, became=became, loadS=t_load,
             firstMinute=iso(m1.t[0]) if m1.n else None)
    del m1
    log(f'  {pair}: 1h {N} bars from {info["firstBar"]}, judged {judged}; 1-min {x["m1bars"]}; '
        f'emails {len(rows)} (A {sum(1 for r in rows if r["cand"] == "A")}, B {sum(1 for r in rows if r["cand"] == "B")}, '
        f'C {sum(1 for r in rows if r["cand"] == "C")}); not mailable A/B/C '
        f'{closed["A"]["both"]}/{closed["B"]["both"]}/{closed["C"]["both"]} '
        f'(load {t_load:.1f}s, all {time.time() - t_pair:.1f}s){info_later}')
    return rows, info, x, later


def key_of(r):
    """読み込みの始まりの確かめで比べる鍵（足の番号は始まりで変わるので、丸の足は始まりの時刻で）"""
    return (r['cand'], r['pair'], r['T'], r['side'], repr(float(r['E'])), r['markT'], r['markKind'],
            repr(float(r['markPrice'])), int(r['both']))


# ---------------------------------------------------------------- 表と比べ方
def own_t(r):
    return dict(filled=r['filled'], tp=r['tp'], pips=r['pips'], mae=r['mae'], hold=r['hold'])


def opp_t(r):
    return dict(filled=r['o_filled'], tp=r['o_tp'], pips=r['o_pips'], mae=r['o_mae'], hold=r['o_hold'])


def stats_of(trades):
    fl = [x for x in trades if x['filled']]
    nf = len(fl)
    tp = sum(1 for x in fl if x['tp'])
    pips = [x['pips'] for x in fl]
    held = [x['pips'] for x in fl if not x['tp']]
    maes = [x['mae'] for x in fl]
    holds = [x['hold'] for x in fl]
    return dict(mails=len(trades), filled=nf, unfilled=len(trades) - nf, tp=tp, held=nf - tp,
                win=100 * tp / nf if nf else None,
                pipsMean=mean_in_order(pips), pipsMedian=median(pips),
                maeMedian=median(maes), maeMax=max(maes) if maes else None,
                holdMedian=median(holds), holdMax=max(holds) if holds else None,
                heldPipsSum=add_in_order(held), heldPipsMin=min(held) if held else None)


def guide_of(rows):
    fl = [r for r in rows if r['filled']]
    nf = len(fl)
    g = [r['g_result'] for r in fl]
    return dict(guideTp=g.count('tp'), guideSl=g.count('sl'), guideHeld=g.count('held'),
                guideBoth=sum(1 for r in fl if r['g_both']),
                guideWin=100 * g.count('tp') / nf if nf else None,
                guidePipsMean=mean_in_order([r['g_pips'] for r in fl]))


def table_of(rows):
    gone = [r for r in rows if not r['stays']]
    both = [r for r in rows if r['both']]
    return dict(own=stats_of([own_t(r) for r in rows]), guide=guide_of(rows), opp=stats_of([opp_t(r) for r in rows]),
                gone=len(gone), goneOtherKind=sum(1 for r in gone if r['otherKind']),
                goneOwn=stats_of([own_t(r) for r in gone]),
                both=len(both), bothOwn=stats_of([own_t(r) for r in both]), bothOpp=stats_of([opp_t(r) for r in both]),
                weekFirst=sum(1 for r in rows if r['weekFirst']),
                buy=sum(1 for r in rows if r['side'] == 'BUY'), sell=sum(1 for r in rows if r['side'] == 'SELL'))


def mean_own(rows):
    return mean_in_order([r['pips'] for r in rows if r['filled']])


def mean_opp(rows):
    return mean_in_order([r['o_pips'] for r in rows if r['o_filled']])


def gap_of(rows):
    a, b = mean_own(rows), mean_opp(rows)
    return None if a is None or b is None else a - b


def end_of(sorted_vals, q):
    """幅の端: floor(q × C ＋ 0.5) 番目（JS の Math.round。1 より小さければ 1、C より大きければ C。1 から数える）"""
    c = len(sorted_vals)
    i = js_round(q * c)
    if i < 1:
        i = 1
    if i > c:
        i = c
    return sorted_vals[i - 1]


def stage2_of(rows2):
    """後半、選んだもの: 差＝メールの平均 − 逆向きの平均。月を引き直す bootstrap（種 378、10,000回）。"""
    mean, opp = mean_own(rows2), mean_opp(rows2)
    gap = None if mean is None or opp is None else mean - opp
    months = sorted(set(r['month'] for r in rows2))
    M = len(months)
    gaps, owns, empty = [], [], 0
    if M:
        by = {mo: ([r['pips'] for r in rows2 if r['month'] == mo and r['filled']],
                   [r['o_pips'] for r in rows2 if r['month'] == mo and r['o_filled']]) for mo in months}
        rnd = mulberry32(BOOT_SEED)
        for _ in range(DRAWS):
            so = 0.0
            no = 0
            sp = 0.0
            np_ = 0
            for _ in range(M):
                a, b = by[months[math.floor(rnd() * M)]]
                for v in a:
                    so += v
                no += len(a)
                for v in b:
                    sp += v
                np_ += len(b)
            if no == 0 or np_ == 0:
                empty += 1
                continue
            om = so / no
            owns.append(om)
            gaps.append(om - sp / np_)
    gaps.sort()
    owns.sort()
    kept = len(gaps)
    boot = dict(gapLo=end_of(gaps, 0.025) if kept else None, gapHi=end_of(gaps, 0.975) if kept else None,
                ownLo=end_of(owns, 0.025) if kept else None, ownHi=end_of(owns, 0.975) if kept else None,
                kept=kept, empty=empty, months=M)
    if kept and boot['gapLo'] > 0 and boot['ownLo'] > 0:
        verdict = 'better'
    elif kept and boot['gapHi'] < 0:
        verdict = 'worse'
    else:
        verdict = 'indistinguishable'
    return dict(mean=mean, oppMean=opp, gap=gap, boot=boot, verdict=verdict)


def summary_of(rows, infos, ld, meta, later_keys):
    by_c = {c: [r for r in rows if r['cand'] == c] for c in CANDS}
    tables = {}
    for c in CANDS:
        t = {}
        for grp in ['all'] + PAIRS:
            rs = by_c[c] if grp == 'all' else [r for r in by_c[c] if r['pair'] == grp]
            t[grp] = {'half1': table_of([r for r in rs if r['half'] == 1]),
                      'half2': table_of([r for r in rs if r['half'] == 2]), 'both': table_of(rs)}
        tables[c] = t
    # 段1: 前半、SPLIT で切った取引の平均（入った取引、行の順）
    means, held = {}, {}
    for c in CANDS:
        h1 = [r for r in by_c[c] if r['half'] == 1]
        means[c] = mean_in_order([r['s_pips'] for r in h1 if r['s_filled']])
        hs = [r for r in h1 if r['s_held']]
        held[c] = dict(n=len(hs), pipsAtEnd=add_in_order([r['pips'] for r in hs]))
    chosen, best = 'A', None
    for c in CANDS:
        if means[c] is not None and (best is None or means[c] > best):
            chosen, best = c, means[c]
    # 段2
    h2 = [r for r in by_c[chosen] if r['half'] == 2]
    s2 = stage2_of(h2)
    stage2 = dict(cand=chosen, mean=s2['mean'], oppMean=s2['oppMean'], gap=s2['gap'], boot=s2['boot'],
                  verdict=s2['verdict'])
    # 判定に使わない数
    h1c = [r for r in by_c[chosen] if r['half'] == 1]
    a = mean_in_order([r['s_pips'] for r in h1c if r['s_filled']])
    b = mean_in_order([r['so_pips'] for r in h1c if r['so_filled']])
    beside = dict(firstHalfGap=None if a is None or b is None else a - b,
                  pairGaps={p: gap_of([r for r in h2 if r['pair'] == p]) for p in PAIRS},
                  buyGap=gap_of([r for r in h2 if r['side'] == 'BUY']),
                  sellGap=gap_of([r for r in h2 if r['side'] == 'SELL']),
                  others=[dict(cand=c, mean=mean_own([r for r in by_c[c] if r['half'] == 2]),
                               oppMean=mean_opp([r for r in by_c[c] if r['half'] == 2]),
                               gap=gap_of([r for r in by_c[c] if r['half'] == 2])) for c in CANDS if c != chosen])
    # counts（5ペアを足したもの）
    def sum_half(get):
        d = half_counts()
        for inf in infos:
            for k2 in d:
                d[k2] += get(inf)[k2]
        return d
    a_keys = set((r['pair'], r['k']) for r in rows if r['cand'] == 'A')
    counts = dict(
        marks={kd: sum_half(lambda inf, kd=kd: inf['marks'][kd]) for kd in (PEAK, BOTTOM)},
        bothBars={w: sum_half(lambda inf, w=w: inf['bothBars'][w]) for w in ('full', 'edge')},
        closed={c: sum_half(lambda inf, c=c: inf['closed'][c]) for c in CANDS},
        sameBarAB=sum(1 for r in rows if r['cand'] == 'B' and (r['pair'], r['k']) in a_keys),
        sameBarAC=sum(1 for r in rows if r['cand'] == 'C' and (r['pair'], r['k']) in a_keys),
        cVanished=sum(inf['cVanished'] for inf in infos),
        cBarDiff=sum(inf['cBarDiff'] for inf in infos),
        cBarsSeen=sum(inf['cBarsSeen'] for inf in infos))
    start_check = None
    if later_keys is not None:
        mine_keys = sorted(key_of(r) for r in rows)
        start_check = dict(compared=len(rows), later=len(later_keys), same=mine_keys == sorted(later_keys))
    return dict(
        meta=dict(start=meta['start'], end=meta['end'], split=meta['split'], loadFrom=meta['loadFrom'], term=TERM,
                  draws=DRAWS, bootSeed=BOOT_SEED),
        stage1=dict(means=means, chosen=chosen, heldAtSplit=held),
        stage2=stage2,
        beside=beside,
        tables=tables,
        counts=counts,
        startCheck=start_check,
        pairs=infos,
        load=dict(files=ld.files, failed=ld.failed, oneSide=ld.one_side, crossed=ld.crossed, closure=ld.closure,
                  repeated=ld.repeated),
    )


# ---------------------------------------------------------------- 比べる〔flowz-check.py を手直し〕
COLS = ['cand', 'pair', 'k', 'open', 'T', 'side', 'E', 'markI', 'markT', 'markKind', 'markPrice', 'both', 'weekFirst',
        'stays', 'otherKind', 'half', 'month', 'filled', 'market', 'fillT', 'fill', 'tp', 'tpT', 'exit', 'endPx',
        'pips', 'mae', 'hold', 'g_result', 'g_pips', 'g_both', 'o_filled', 'o_market', 'o_fillT', 'o_fill', 'o_tp',
        'o_tpT', 'o_pips', 'o_mae', 'o_hold', 's_filled', 's_tp', 's_held', 's_pips', 'so_filled', 'so_pips']
STR_COLS = {'cand', 'pair', 'open', 'T', 'side', 'markT', 'markKind', 'month', 'fillT', 'tpT', 'g_result', 'o_fillT',
            'o_tpT'}
INT_COLS = {'k', 'markI', 'both', 'weekFirst', 'stays', 'otherKind', 'half', 'filled', 'market', 'tp', 'g_both',
            'o_filled', 'o_market', 'o_tp', 's_filled', 's_tp', 's_held', 'so_filled'}
LOAD_COMPARED = ('files', 'failed', 'oneSide', 'crossed', 'closure', 'repeated')


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
        elif (not (isinstance(mine, int) and isinstance(theirs, int)) and math.isfinite(a) and math.isfinite(b)
              and abs(a - b) <= REL * max(abs(a), abs(b))):
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

    def key(r):
        return (r.get('cand'), r.get('pair'), r.get('T'))
    tk = {key(r): r for r in theirs}
    mk = {key(r): r for r in mine}
    for k in mk:
        if k not in tk:
            C.bad(f'{k[0]} {k[1]} {k[2]}', 'row', 'present', 'missing in rows.csv')
    for k in tk:
        if k not in mk:
            C.bad(f'{k[0]} {k[1]} {k[2]}', 'row', 'missing in mine', 'present')
    order_ok = [key(r) for r in mine if key(r) in tk] == [key(r) for r in theirs if key(r) in mk]
    C.same('rows.csv', 'row order', True, order_ok)
    for r in mine:
        t = tk.get(key(r))
        if t is None:
            continue
        where = f"{r['cand']} {r['pair']} T={r['T']}"
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


def compare_tree(C, where, mine, theirs):
    """mine と theirs を全部比べる。theirs にだけある鍵も違いとして数える（計算し直していない数を残さない）。"""
    if isinstance(mine, dict):
        if not isinstance(theirs, dict):
            C.bad(where, 'type', 'object', theirs)
            return
        for k, v in mine.items():
            if k not in theirs:
                C.bad(f'{where}.{k}', 'key', 'present', 'missing in summary.json')
                continue
            compare_tree(C, f'{where}.{k}', v, theirs[k])
        for k in theirs:
            if k not in mine:
                C.bad(f'{where}.{k}', 'key', 'not recomputed here', 'present in summary.json')
        return
    if isinstance(mine, list):
        if not isinstance(theirs, list) or len(theirs) != len(mine):
            C.bad(where, 'list', len(mine), len(theirs) if isinstance(theirs, list) else theirs)
            return
        for i, (a, b) in enumerate(zip(mine, theirs)):
            compare_tree(C, f'{where}[{i}]', a, b)
        return
    if isinstance(mine, str) or isinstance(theirs, str) or isinstance(mine, bool) or isinstance(theirs, bool):
        C.same(where, 'value', mine, theirs)
        return
    if mine is None or isinstance(mine, (int, float)):
        C.num(where, 'value', mine, theirs)
        return
    C.same(where, 'value', mine, theirs)


def main():
    ap = argparse.ArgumentParser(description='docs §8.125 の独立した計算し直し')
    ap.add_argument('--cache', required=True)
    ap.add_argument('--rows', required=True)
    ap.add_argument('--summary', required=True)
    ap.add_argument('--start-check', choices=('auto', 'on', 'off'), default='auto',
                    help='auto: recompute startCheck only when meta is §8.125\'s real period (default); on/off: always/never '
                         '(off for a walk run over the real period, whose startCheck the TS writes as null)')
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
    print(f'pbz-check (docs §8.125): email times in [{iso(start)}, {iso(end)}), split {iso(split)}, '
          f'1-hour bars from {iso(load_from)}, 1-minute bars from {iso(start)}')
    is_real = all(ms_of(REAL[k]) == ms_of(meta[k]) for k in REAL)
    do_check = a.start_check == 'on' or (a.start_check == 'auto' and is_real)
    later_from = ms_of(LATER_FROM) if do_check else None
    print(('  the period is §8.125\'s real one' if is_real else '  the period is NOT §8.125\'s real one (a test run)')
          + (': the start check (1-hour bars read again from 2023-12-01) is recomputed' if do_check
             else ': startCheck must be null') + f' (--start-check {a.start_check})')
    ld = LoadStats()
    ld2 = LoadStats()                     # 読み込みの始まりの確かめで読み直したファイル（load には入れない）
    rows, infos, xs = [], [], []
    later = [] if do_check else None
    for pi, pair in enumerate(PAIRS):
        r, info, x, lk = compute_pair(a.cache, pi, pair, start, end, split, load_from, ld, later_from, ld2, print)
        rows.extend(r)
        infos.append(info)
        xs.append(x)
        if lk is not None:
            later.extend(lk)
    rows.sort(key=lambda r: (r['_t'], PAIRS.index(r['pair']), CANDS.index(r['cand'])))
    mine = summary_of(rows, infos, ld, meta, later)

    def tot(k):
        return sum(x[k] for x in xs)
    by = {c: [r for r in rows if r['cand'] == c] for c in CANDS}

    def per_c(f):
        return ', '.join(f'{c} {f(by[c])}' for c in CANDS)
    nf = sum(1 for r in rows if r['filled'])
    print(f'  rows {len(rows)} ({per_c(len)}); email trades filled {nf} (market {sum(r["market"] for r in rows)}), '
          f'unfilled limits {tot("unfilled")}, TP {sum(r["tp"] for r in rows)}, still held at END '
          f'{sum(1 for r in rows if r["filled"] and not r["tp"])}')
    print(f'  1-min bars in Rakuten\'s stop {tot("stopBars")}; files read {ld.files}, failed {ld.failed}; 1-min bars '
          f'left out: one side {ld.one_side}, crossed {ld.crossed}, closure {ld.closure}, repeated {ld.repeated}')
    if ld.failed:
        print('  files not read: ' + '; '.join(ld.failed_ex))
    print('special situations met here (the TS and this check are compared on them):')
    print(f'  email trades: fill/TP/guide exit would move if Rakuten\'s stop bars were judged {tot("stopMoved")}; '
          f'P moved past a stop {tot("shifted")}; no 1-min bar at P {tot("noBar")}; not ordered (no bar before P / P at '
          f'END) {tot("none")}; limit filled at a better open {tot("gap")}; unfilled limits {tot("unfilled")}; guide '
          f'both-in-one-bar {sum(1 for r in rows if r["g_both"])}')
    print(f'  opposite trades: would move if stop bars were judged {tot("o_stopMoved")}; P moved past a stop '
          f'{tot("o_shifted")}; no 1-min bar at P {tot("o_noBar")}; better open {tot("o_gap")}; unfilled limits '
          f'{tot("o_unfilled")}')
    print(f'  half-1 trades cut at split: email unfilled {tot("s_unfilled")} (of {sum(1 for r in rows if r["half"] == 1)}), '
          f'still held at split {tot("s_heldAtSplit")}; opposite unfilled {tot("so_unfilled")}')
    cl = mine['counts']['closed']
    print(f'  not mailable (fired in the period inside the closure): A {cl["A"]["both"]}, B {cl["B"]["both"]}, '
          f'C {cl["C"]["both"]}')
    bb = mine['counts']['bothBars']
    print(f'  bars meeting both tests in M_END (period): full {bb["full"]["both"]}, edge {bb["edge"]["both"]}; '
          f'all bars meeting both in their final test {tot("both_final")}; emails decided on a both bar: '
          f'{per_c(lambda rs: sum(1 for r in rs if r["both"]))}; of those, the bar is a bottom in M_END {tot("became")}')
    print(f'  alternation (marks fixed by 10 later bars): same-kind replaced by a higher peak / lower bottom '
          f'{tot("replaced")}, same-kind dropped (not more extreme) {tot("dropped")}, same-price ties kept older '
          f'{tot("ties")}; in M_k\'s right edge (bars closed in the period): replaced {tot("tail_replaced")}, ties kept '
          f'older {tot("tail_ties")}')
    print(f'  test boundaries: H = FP on a peak candidate {tot("eq_fp")} (in M_END {tot("eq_fp_kept")}), L = FB on a '
          f'bottom candidate {tot("eq_fb")} (in M_END {tot("eq_fb_kept")}); A emails on such a mark {tot("eqfp_rows")}; '
          f'not a candidate only because H = PP {tot("eq_pp")} / L = PB {tot("eq_pb")}')
    print(f'  emails whose mark is not in M_END: {per_c(lambda rs: sum(1 for r in rs if not r["stays"]))}; of those '
          f'with the other kind there: {per_c(lambda rs: sum(1 for r in rs if r["otherKind"]))}')
    cc = mine['counts']
    print(f'  C bars whose 1-min high/low differ from the 1-hour file {cc["cBarDiff"]} (of {cc["cBarsSeen"]} seen); '
          f'C emails whose mark vanished by the bar\'s close {cc["cVanished"]}; same bar A&B {cc["sameBarAB"]}, A&C '
          f'{cc["sameBarAC"]}; weekFirst emails: {per_c(lambda rs: sum(1 for r in rs if r["weekFirst"]))}')
    s1, s2 = mine['stage1'], mine['stage2']
    print(f'  stage1 means (cut at split): A {s1["means"]["A"]!r}, B {s1["means"]["B"]!r}, C {s1["means"]["C"]!r} -> '
          f'{s1["chosen"]}; stage2 ({s2["cand"]}): mean {s2["mean"]!r}, opp {s2["oppMean"]!r}, gap {s2["gap"]!r}, '
          f'gap [{s2["boot"]["gapLo"]!r}, {s2["boot"]["gapHi"]!r}], own [{s2["boot"]["ownLo"]!r}, '
          f'{s2["boot"]["ownHi"]!r}] (kept {s2["boot"]["kept"]}, empty {s2["boot"]["empty"]}, months '
          f'{s2["boot"]["months"]}) -> {s2["verdict"]}')
    if mine['startCheck'] is not None:
        sc = mine['startCheck']
        print(f'  start check: rows {sc["compared"]}, emails with 1-hour bars from 2023-12-01 {sc["later"]}, '
              f'same {sc["same"]} (1-hour files read again for it {ld2.files}, failed {ld2.failed}; not counted in load)')

    C = Cmp()
    compare_rows(C, [{c: r.get(c) for c in COLS} for r in rows], a.rows)
    th = dict(S)
    for k in ('meta', 'stage1', 'stage2', 'beside', 'tables', 'counts', 'startCheck', 'pairs'):
        if k not in th:
            C.bad(k, 'key', 'present', 'missing in summary.json')
            continue
        compare_tree(C, k, mine[k], th[k])
    tl_ = th.get('load')
    skipped = []
    if not isinstance(tl_, dict):
        C.bad('load', 'key', 'present', 'missing in summary.json')
    else:
        for k in LOAD_COMPARED:
            if k not in tl_:
                C.bad(f'load.{k}', 'key', 'present', 'missing in summary.json')
            else:
                C.num(f'load.{k}', 'value', mine['load'][k], tl_[k])
        skipped = [f'load.{k}' for k in tl_ if k not in LOAD_COMPARED]
    for k in th:
        if k not in mine:
            C.bad(k, 'key', 'not recomputed here', 'present in summary.json')
    print(f'compared {C.fields} values: {C.exact} exactly equal, {C.near} equal within {REL:g} relative '
          f'(largest {C.near_max:.3g}), {C.n} different')
    if skipped:
        print('not recomputed (process counts of the TS run): ' + ', '.join(skipped))
    if C.n:
        print('differences by item: ' + ', '.join(f'{k} {v}' for k, v in sorted(C.by.items(), key=lambda x: -x[1])))
        for x in C.examples:
            print('  ' + x)
    print(f'({time.time() - t_all:.1f}s)')
    if C.n:
        print(f'PBZ-CHECK FAILED: {C.n} differences')
        sys.exit(1)
    print('PBZ-CHECK PASSED')
    sys.exit(0)


if __name__ == '__main__':
    main()
