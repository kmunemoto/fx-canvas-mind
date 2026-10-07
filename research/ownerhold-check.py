#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ownerhold-check.py — docs/OPERATIONS.md §8.102 の独立した計算し直し（Python。標準ライブラリと numpy だけ）。

research/ownerhold*.ts は読まずに、仕様（pyspec）と §8.102 だけから書いた。
GMO の形の日のファイル（--gmo）と、プログラムの書き出し（--dump の signals.csv・meta.json）から、
メールごとの道筋（合図の向きと逆向き）・③（third.json）・口座の5つの行（main, mainSwap, worst, worstSwap,
dep0859）・すべてを受け付けた4つの行（unlimited-*: E* と M）を計算し直し、--dump の出力と比べる。

使い方:
  python3 research/ownerhold-check.py --gmo GMO_DIR --dump DUMP_DIR [--rates synthetic|BIS_CSV]
         [--out DIR] [--also DUMP2 --also DUMP3 ...]
  --also: 同じ GMO・同じ signals.csv・meta.json の別の dump（仕込んだ誤りの dump など）。計算は1回で、
          それぞれと比べ、それぞれの中に pycheck.json を書く。終了コードは --dump（主）だけで決まる。
  --out: 主の dump の pycheck.json を書くフォルダ（既定は --dump）。
  --e-round exact|mathround: E と15分足の確かめの丸め。既定 exact = double の正確な値を、ちょうど半分なら
          上へ丸める（チャートの丸め Number(v.toFixed(d))、supabase/functions/live-chart/logic.ts と同じ）。
          mathround = Math.round(x*10^d)/10^d（仕様に初め書いた形。チャートの丸めとは違う。調べる用）。
  --mine DIR: 自分の計算を dump と同じ形のファイルで DIR に書き出す（食い違いを調べる用）。
  --ledger CSV --end-b ISO [--a-csv CSV]: (b)（§8.102 (b) と「(b) のプログラムの細部」）。合図は signals.csv から
          ではなく、ledger（research/ledger/ultra15.csv）の END_b より前に送った行から自分で作り（P＝sentAt を分に
          切り上げた時刻＋1分）、TS の signals.csv・meta（S_b・END_b）と照らす。送るまでの時間と、比べる窓
          （ultra15-a.csv との1回の比べ）も自分で計算し、dump の delays.json・window.json と比べる。
終了コード: 0 = 主の dump と全件一致、1 = 主の dump に食い違いがある、2 = 入力の誤り。
"""
import argparse
import csv
import datetime
import hashlib
import heapq
import itertools
import json
import math
import os
import sys
import time
from collections import defaultdict

import numpy as np

MIN = 60_000
HOUR = 3_600_000
DAY = 86_400_000
WEEK = 7 * DAY
WEEK_OFFSET = 3 * DAY + 21 * HOUR          # 日曜 21:00 UTC
STOP_LEN = 15 * MIN                        # 楽天が止まる時間 [τ, τ+15分)
NOTICE_AFTER = 35 * MIN                    # 追証の知らせ τ+35分
UNITS = 10_000                             # 1回 1万通貨
MARGIN_RATE = 0.04                         # 25倍コース
LC_LEVEL = 0.5                             # ロスカット 50%
FEE = 0.5                                  # スワップの取り分（年率 %）
H24 = DAY
TP_PIPS = 10

PAIRS = ['USD/JPY', 'EUR/JPY', 'AUD/JPY', 'EUR/USD', 'AUD/USD']     # 楽天の一覧の順
AREAS = {'USD/JPY': ('US', 'JP'), 'EUR/JPY': ('XM', 'JP'), 'AUD/JPY': ('AU', 'JP'),
         'EUR/USD': ('XM', 'US'), 'AUD/USD': ('AU', 'US')}
SYNTH_RATES = {'US': 5.25, 'JP': 0.1, 'XM': 3.75, 'AU': 4.35}
ACCOUNT_ROWS = {
    'main': dict(swap=False, worst=False, dep='notice'),
    'mainSwap': dict(swap=True, worst=False, dep='notice'),
    'worst': dict(swap=False, worst=True, dep='notice'),
    'worstSwap': dict(swap=True, worst=True, dep='notice'),
    'dep0859': dict(swap=False, worst=False, dep='0859'),
}
UNLIMITED_ROWS = ['main', 'mainSwap', 'worst', 'worstSwap']
# (b): the ledger, the comparison's week start W0 (日曜 21:00 UTC), (a) の期間とファイル、比べる件数
B_LEDGER_HEADER = 'pair,side,open,T,E,sentAt'
B_A_HEADER = 'T,pair,side,P,week,v1d'
B_A_SHA256 = 'ce4c6acee90bdef30f616b6a018ae34864d4e48d3c443dcfc7e6d27988be70c2'
B_COMPARE_AT = 30
_EPOCH = datetime.datetime(1970, 1, 1, tzinfo=datetime.timezone.utc)


def ms_of(text):
    """UTC の ISO の文字列（Z 付き、ミリ秒まで）をミリ秒の整数に。"""
    d = datetime.datetime.fromisoformat(text.strip().replace('Z', '+00:00'))
    if d.tzinfo is None:
        raise ValueError(f'no time zone: {text}')
    return (d - _EPOCH) // datetime.timedelta(milliseconds=1)


def ceil_min(ms):
    return -(-ms // MIN) * MIN


B_W0 = ms_of('2026-10-04T21:00:00Z')
B_A_START = ms_of('2024-01-01T00:00:00Z')
B_A_END = ms_of('2026-10-03T00:00:00Z')
B_LEDGER_FROM = ms_of('2026-10-05T16:17:00Z')
BLK = 1024
NAN = float('nan')


def die(msg):
    """入力の誤り: 理由を出して終了コード 2 で止める。"""
    print('ERROR: ' + msg, file=sys.stderr)
    sys.exit(2)


# ---------------------------------------------------------------- t 分布（scipy なし）
def _betacf(a, b, x):
    fpmin = 1e-300
    qab, qap, qam = a + b, a + 1.0, a - 1.0
    c = 1.0
    d = 1.0 - qab * x / qap
    if abs(d) < fpmin:
        d = fpmin
    d = 1.0 / d
    h = d
    for m in range(1, 100000):
        m2 = 2 * m
        aa = m * (b - m) * x / ((qam + m2) * (a + m2))
        d = 1.0 + aa * d
        d = fpmin if abs(d) < fpmin else d
        c = 1.0 + aa / c
        c = fpmin if abs(c) < fpmin else c
        d = 1.0 / d
        h *= d * c
        aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2))
        d = 1.0 + aa * d
        d = fpmin if abs(d) < fpmin else d
        c = 1.0 + aa / c
        c = fpmin if abs(c) < fpmin else c
        d = 1.0 / d
        de = d * c
        h *= de
        if abs(de - 1.0) < 1e-16:
            break
    return h


def _betai(a, b, x):
    if x <= 0.0:
        return 0.0
    if x >= 1.0:
        return 1.0
    lbt = math.lgamma(a + b) - math.lgamma(a) - math.lgamma(b) + a * math.log(x) + b * math.log1p(-x)
    bt = math.exp(lbt)
    if x < (a + 1.0) / (a + b + 2.0):
        return bt * _betacf(a, b, x) / a
    return 1.0 - bt * _betacf(b, a, 1.0 - x) / b


_TQ = {}


def t975(df):
    """t 分布の 0.975 点（両側 95%）。上側の確率 = 0.5 I_x(df/2, 1/2), x = df/(df+t^2) を二分法で解く。"""
    if df in _TQ:
        return _TQ[df]

    def upper(t):
        return 0.5 * _betai(0.5 * df, 0.5, df / (df + t * t))
    lo, hi = 0.0, 1.0
    while upper(hi) > 0.025:
        hi *= 2.0
    for _ in range(300):
        mid = 0.5 * (lo + hi)
        if mid <= lo or mid >= hi:
            break
        if upper(mid) > 0.025:
            lo = mid
        else:
            hi = mid
    _TQ[df] = 0.5 * (lo + hi)
    return _TQ[df]


# ---------------------------------------------------------------- 時刻
def days_from_civil(y, m, d):
    import datetime
    return (datetime.date(y, m, d) - datetime.date(1970, 1, 1)).days


def year_of(ms):
    import datetime
    return (datetime.date(1970, 1, 1) + datetime.timedelta(days=ms // DAY)).year


_DST = {}


def us_summer(ms):
    """米国の夏時間か（3月の第2日曜 07:00 UTC 〜 11月の第1日曜 06:00 UTC）。"""
    y = year_of(ms)
    if y not in _DST:
        d = days_from_civil(y, 3, 1)
        first_sun = d + (6 - (d + 3) % 7) % 7
        start = (first_sun + 7) * DAY + 7 * HOUR
        d = days_from_civil(y, 11, 1)
        first_sun = d + (6 - (d + 3) % 7) % 7
        end = first_sun * DAY + 6 * HOUR
        _DST[y] = (start, end)
    s, e = _DST[y]
    return s <= ms < e


def ny_closes(start, end):
    """楽天の NY の引け τ（平日ごと）、期限（翌平日 09:00 UTC）、スワップの日数。"""
    taus, deads, days = [], [], []
    for dn in range((start - DAY) // DAY, end // DAY + 1):
        wd = (dn + 3) % 7
        if wd >= 5:
            continue
        dms = dn * DAY
        tau = dms + (20 * HOUR + 55 * MIN if us_summer(dms + 21 * HOUR) else 21 * HOUR + 55 * MIN)
        if tau < start - DAY or tau > end:
            continue
        nd = dn + (3 if wd == 4 else 1)
        taus.append(tau)
        deads.append(nd * DAY + 9 * HOUR)
        days.append(3 if wd == 2 else 1)
    return np.array(taus, dtype=np.int64), np.array(deads, dtype=np.int64), days


def in_closure(t):
    """GMO の週末（土曜すべて・金曜 22:00 UTC 以後・日曜 21:00 UTC 前）。t は numpy 配列。"""
    wd = (t // DAY + 3) % 7
    tod = t % DAY
    return (wd == 5) | ((wd == 4) & (tod >= 22 * HOUR)) | ((wd == 6) & (tod < 21 * HOUR))


# ---------------------------------------------------------------- GMO の読み込み
def read_side(d, problems):
    T, O, Hh, Ll, C = [], [], [], [], []
    if os.path.isdir(d):
        for fn in sorted(os.listdir(d)):
            if not fn.endswith('.json'):
                continue
            path = os.path.join(d, fn)
            try:
                with open(path, 'rb') as f:
                    j = json.loads(f.read())
                st = j.get('status')
                data = j.get('data') or []
                if st != 0 and not (st == 404 and not data):
                    problems.append(f'{path}: status {st}')
                    continue
                T.extend(int(r['openTime']) for r in data)
                O.extend(float(r['open']) for r in data)
                Hh.extend(float(r['high']) for r in data)
                Ll.extend(float(r['low']) for r in data)
                C.extend(float(r['close']) for r in data)
            except Exception as e:  # noqa: BLE001
                problems.append(f'{path}: {e!r}')
    t = np.array(T, dtype=np.int64)
    arrs = [np.array(x, dtype=np.float64) for x in (O, Hh, Ll, C)]
    order = np.argsort(t, kind='stable')
    t = t[order]
    arrs = [a[order] for a in arrs]
    if t.size:
        keep = np.ones(t.size, dtype=bool)
        keep[1:] = t[1:] != t[:-1]
        if not keep.all():
            problems.append(f'{d}: {int((~keep).sum())} repeated openTime (kept the first)')
            t = t[keep]
            arrs = [a[keep] for a in arrs]
    return t, arrs


class Seek:
    """1つの配列の上で「k 以後の最初の ≤x / ≥x」と区間の最小・最大を、ブロックの最小・最大で速く引く。"""

    def __init__(self, a, kind):
        self.a = a
        self.n = n = a.size
        nb = max(1, (n + BLK - 1) // BLK)
        pad = nb * BLK - n
        fillv = np.inf if kind == 'min' else -np.inf
        pa = np.concatenate([a, np.full(pad, fillv)]) if pad else a
        r = pa.reshape(nb, BLK)
        self.b = r.min(axis=1) if kind == 'min' else r.max(axis=1)

    def _first(self, k, x, le):
        a, n = self.a, self.n
        if k < 0:
            k = 0
        if k >= n:
            return -1
        bi = k // BLK
        seg = a[k:min((bi + 1) * BLK, n)]
        m = seg <= x if le else seg >= x
        j = int(np.argmax(m))
        if m[j]:
            return k + j
        rest = self.b[bi + 1:]
        if rest.size == 0:
            return -1
        m = rest <= x if le else rest >= x
        j = int(np.argmax(m))
        if not m[j]:
            return -1
        bb = bi + 1 + j
        seg = a[bb * BLK:min((bb + 1) * BLK, n)]
        m = seg <= x if le else seg >= x
        return bb * BLK + int(np.argmax(m))

    def first_le(self, k, x):
        return self._first(k, x, True)

    def first_ge(self, k, x):
        return self._first(k, x, False)

    def range_min(self, lo, hi):
        a = self.a
        blo, bhi = lo // BLK, hi // BLK
        if blo == bhi:
            return float(a[lo:hi + 1].min())
        m = min(float(a[lo:(blo + 1) * BLK].min()), float(a[bhi * BLK:hi + 1].min()))
        if bhi > blo + 1:
            m = min(m, float(self.b[blo + 1:bhi].min()))
        return m

    def range_max(self, lo, hi):
        a = self.a
        blo, bhi = lo // BLK, hi // BLK
        if blo == bhi:
            return float(a[lo:hi + 1].max())
        m = max(float(a[lo:(blo + 1) * BLK].max()), float(a[bhi * BLK:hi + 1].max()))
        if bhi > blo + 1:
            m = max(m, float(self.b[blo + 1:bhi].max()))
        return m


class Pair:
    def __init__(self, idx, name):
        self.idx = idx
        self.name = name
        self.sym = name.replace('/', '_')
        self.usd = name.endswith('/USD')
        self.unit = 0.0001 if self.usd else 0.01
        self.dec = 5 if self.usd else 3

    def load(self, gmo, start, end, problems):
        base = os.path.join(gmo, self.sym, '1min')
        tb, (bo, bh, bl, bc) = read_side(os.path.join(base, 'bid'), problems)
        ta, (ao, ah, al, ac) = read_side(os.path.join(base, 'ask'), problems)
        common, ib, ia = np.intersect1d(tb, ta, assume_unique=True, return_indices=True)
        t = common
        bo, bh, bl, bc = bo[ib], bh[ib], bl[ib], bc[ib]
        ao, ah, al, ac = ao[ia], ah[ia], al[ia], ac[ia]
        keep = (ac >= bc) & ~(in_closure(t) & in_closure(t + MIN - 1)) & (t >= start - DAY) & (t + MIN <= end)
        self.t = t[keep]
        self.bo, self.bh, self.bl, self.bc = bo[keep], bh[keep], bl[keep], bc[keep]
        self.ao, self.ah, self.al, self.ac = ao[keep], ah[keep], al[keep], ac[keep]
        self.n = self.t.size
        self.counts = dict(bid=int(tb.size), ask=int(ta.size), both=int(t.size), kept=int(self.n))

    def setup(self, taus):
        t = self.t
        j = np.searchsorted(taus, t, 'right') - 1
        jj = np.maximum(j, 0)
        self.stop = (j >= 0) & (t < taus[jj] + STOP_LEN) if taus.size else np.zeros(t.size, dtype=bool)
        al_s = self.al.copy()
        al_s[self.stop] = np.inf
        bh_s = self.bh.copy()
        bh_s[self.stop] = -np.inf
        self.seek_al = Seek(al_s, 'min')       # 買いの指値・売りの利確（止まる足を除く）
        self.seek_bh = Seek(bh_s, 'max')       # 売りの指値・買いの利確（止まる足を除く）
        self.seek_bl = Seek(self.bl, 'min')    # 買いの最大の逆行（止まる足も含む）
        self.seek_ah = Seek(self.ah, 'max')    # 売りの最大の逆行

    def ended(self, T):
        """値段の決まり: T 以前に終わる最後の足（open + 1分 ≦ T）の番号。無ければ −1。"""
        return int(np.searchsorted(self.t, T - MIN, 'right')) - 1

    def load15(self, gmo):
        out = {}
        for side in ('bid', 'ask'):
            d = os.path.join(gmo, self.sym, '15min', side)
            m = {}
            if os.path.isdir(d):
                for fn in sorted(os.listdir(d)):
                    if not fn.endswith('.json'):
                        continue
                    with open(os.path.join(d, fn), 'rb') as f:
                        j = json.loads(f.read())
                    for r in j.get('data') or []:
                        m.setdefault(int(r['openTime']), float(r['close']))
            out[side] = m
        return out


# ---------------------------------------------------------------- 金利（スワップ）
class Rates:
    def __init__(self, spec):
        self.synthetic = spec == 'synthetic'
        self.table = {}
        if not self.synthetic:
            self._load_bis(spec)

    def _load_bis(self, path):
        with open(path, newline='', encoding='utf-8-sig') as f:
            rd = csv.reader(f)
            header = next(rd)
            codes = [h.split(':')[0].strip().upper() for h in header]

            def col(name):
                if name not in codes:
                    die(f'BIS CSV: column {name} not found in header {header}')
                return codes.index(name)
            i_f, i_a, i_t, i_v = col('FREQ'), col('REF_AREA'), col('TIME_PERIOD'), col('OBS_VALUE')
            for r in rd:
                if len(r) <= max(i_f, i_a, i_t, i_v):
                    continue
                freq = r[i_f].split(':')[0].strip().upper()
                area = r[i_a].split(':')[0].strip().upper()
                if freq != 'M' or area not in ('US', 'JP', 'XM', 'AU'):
                    continue
                v = r[i_v].strip()
                if v == '' or v.upper() == 'NAN':
                    continue
                tp = r[i_t].strip()
                y, m = int(tp[:4]), int(tp[5:7])
                self.table[(area, y * 12 + (m - 1))] = float(v)

    def rate(self, area, tau):
        if self.synthetic:
            return SYNTH_RATES[area]
        import datetime
        d = datetime.date(1970, 1, 1) + datetime.timedelta(days=tau // DAY)
        mi = d.year * 12 + (d.month - 1) - 1          # τ の月の前の月
        for back in range(0, 4):                      # τ の月の1〜4か月前（longhist-lib の rateBefore と同じ）
            v = self.table.get((area, mi - back))
            if v is not None:
                return v
        die(f'BIS: no {area} rate in the 1-4 months before {d}')


# ---------------------------------------------------------------- 1本の注文の道筋（取引ごとの見方）
def compute_path(pr, P0, dirn, E, tp, end, taus):
    r = dict(P=P0, shifted=0, noBar=0, none=0, market=0, filled=False, fillK=None, t0=NAN, fill=NAN,
             fillGap=0, tpd=False, tpK=None, x=NAN, exit=NAN, tpGap=0, tpInFill=0, mae=NAN, endPx=NAN,
             value=0.0, firstAfter=None, k0=-1)
    P = P0
    j = int(np.searchsorted(taus, P, 'right')) - 1
    if j >= 0 and P < int(taus[j]) + STOP_LEN:
        P = int(taus[j]) + STOP_LEN
        r['shifted'] = 1
    r['P'] = P
    t = pr.t
    n = pr.n
    # 何もしない: P が END 以後か、足が1本も無い（データの最後の足より後で END より前の P は、足の無い P として
    # 最後の終値で判定する。§8.102 注文の時点。P より前に足が無いときは下で何もしない）
    if P >= end or n == 0:
        r['none'] = 1
        return r
    kk = int(np.searchsorted(t, P, 'left'))
    k0 = kk if kk < n and int(t[kk]) == P else -1
    first_after = int(np.searchsorted(t, P, 'right'))
    r['k0'] = k0
    r['firstAfter'] = first_after
    if k0 >= 0:
        now = float(pr.ao[k0]) if dirn > 0 else float(pr.bo[k0])
    else:
        r['noBar'] = 1
        kp = int(np.searchsorted(t, P - MIN, 'right')) - 1
        if kp < 0:
            r['none'] = 1
            return r
        now = float(pr.ac[kp]) if dirn > 0 else float(pr.bc[kp])
    market = (now <= E) if dirn > 0 else (now >= E)
    if market:
        r['market'] = 1
        r['filled'] = True
        r['fillK'] = k0           # −1 = 足の無い成行
        r['t0'] = P
        r['fill'] = now
        fk = k0
    else:
        ks = k0 if k0 >= 0 else first_after
        if dirn > 0:
            k = pr.seek_al.first_le(ks, E)
        else:
            k = pr.seek_bh.first_ge(ks, E)
        if k < 0:
            r['fillK'] = -2
            return r
        if dirn > 0:
            o = float(pr.ao[k])
            fill, gap = (o, 1) if o < E else (E, 0)
        else:
            o = float(pr.bo[k])
            fill, gap = (o, 1) if o > E else (E, 0)
        r.update(filled=True, fillK=k, t0=int(t[k]), fill=fill, fillGap=gap)
        fk = k
    fill = r['fill']
    ts = fk + 1 if fk >= 0 else first_after
    if dirn > 0:
        k = pr.seek_bh.first_ge(ts, tp)
    else:
        k = pr.seek_al.first_le(ts, tp)
    if fk >= 0:
        r['tpInFill'] = int(float(pr.bh[fk]) >= tp) if dirn > 0 else int(float(pr.al[fk]) <= tp)
    if k >= 0:
        if dirn > 0:
            o = float(pr.bo[k])
            ex, gap = (o, 1) if o > tp else (tp, 0)
        else:
            o = float(pr.ao[k])
            ex, gap = (o, 1) if o < tp else (tp, 0)
        r.update(tpd=True, tpK=k, x=int(t[k]), exit=ex, tpGap=gap)
        hi = k
    else:
        r['endPx'] = float(pr.bc[n - 1]) if dirn > 0 else float(pr.ac[n - 1])
        hi = n - 1
    lo = fk if fk >= 0 else first_after
    if lo <= hi:
        if dirn > 0:
            mae = (fill - pr.seek_bl.range_min(lo, hi)) / pr.unit
        else:
            mae = (pr.seek_ah.range_max(lo, hi) - fill) / pr.unit
        r['mae'] = max(0.0, mae)
    else:
        r['mae'] = 0.0
    # P＋24時間の値
    H = P + H24
    if r['tpd'] and int(t[r['tpK']]) + MIN <= H:
        r['value'] = dirn * (r['exit'] - fill) / pr.unit
    elif (fk >= 0 and int(t[fk]) + MIN <= H) or (fk == -1 and P <= H):
        kh = pr.ended(H)
        px = float(pr.bc[kh]) if dirn > 0 else float(pr.ac[kh])
        r['value'] = dirn * (px - fill) / pr.unit
    return r


def email_values(pr, r, dirn):
    """メールごとの P＋24時間と P＋1週の値（§8.102 比べるもの: 利確の足がその時刻までに終われば利確の pips、
    その時刻までに入っていれば、その時刻以前に終わる最後の足の決済する側の終値で評価、入っていなければ 0）と、
    P＋24時間ちょうどに終わる足が無いか（値段の無い時間）。r['none'] のメールは None。"""
    if r['none']:
        return None
    P = r['P']
    t = pr.t
    fk = r['fillK']
    out = {}
    for name, H in (('d1', P + H24), ('w1', P + WEEK)):
        v = 0.0
        if r['filled']:
            if r['tpd'] and int(t[r['tpK']]) + MIN <= H:
                v = dirn * (r['exit'] - r['fill']) / pr.unit
            elif (fk >= 0 and int(t[fk]) + MIN <= H) or (fk == -1 and P <= H):
                kh = pr.ended(H)
                if kh >= 0:
                    px = float(pr.bc[kh]) if dirn > 0 else float(pr.ac[kh])
                    v = dirn * (px - r['fill']) / pr.unit
        out[name] = v
    kh = pr.ended(P + H24)
    out['gap1'] = int(not (kh >= 0 and int(t[kh]) + MIN == P + H24))
    return out


def compare_emails(C, W, dump):
    """emails.csv: メールごとの1日後・1週後の値（合図の向きと逆向き）と、1日後の値段の無い時間を全件比べる"""
    rows = read_csv(os.path.join(dump, 'emails.csv'))
    name = 'emails'
    if rows is None:
        C.bad(name, 'file', 'missing', None, None)
        return
    byi = {int(r['i']): r for r in rows}
    C.count(name, 'all', len(W.sigs), len(rows))
    for s, a, b in zip(W.sigs, W.path_sig, W.path_opp):
        i = s['i']
        d = byi.get(i)
        if d is None:
            C.bad(name, i, 'row missing', None, None)
            continue
        pr = W.pairs[s['p']]
        va = email_values(pr, a, s['dir'])
        vb = email_values(pr, b, -s['dir'])
        for horizon, keys in (('d1', (('d1', 'd1', va), ('d1o', 'd1', vb))), ('w1', (('w1', 'w1', va), ('w1o', 'w1', vb)))):
            H = a['P'] + (H24 if horizon == 'd1' else WEEK)
            inside = va is not None and H <= W.end
            for col, k, v in keys:
                C.check(name, i, col, v[k] if inside else None, d[col], 'pips')
        inside1 = va is not None and a['P'] + H24 <= W.end
        C.check(name, i, 'gap1', va['gap1'] if inside1 else None, d['gap1'], 'exact')
        C.check(name, i, 'gap1o', vb['gap1'] if inside1 else None, d['gap1o'], 'exact')


# ---------------------------------------------------------------- 全体（足・時計・合図）
class World:
    def __init__(self, gmo, dump, rates_spec, log, ledger=None, end_b=None):
        t_start = time.time()
        self.meta = json.load(open(os.path.join(dump, 'meta.json')))
        m = self.meta
        self.start, self.end, self.split = int(m['start']), int(m['end']), int(m['split'])
        # P は §8.102 の決まり（T＋2分、遅れた合図は窓 i+1 の確定＋2分＝T＋17分）から自分で出す。meta の delay は
        # 照らすだけ（check_inputs の 'meta'）
        self.delay = 2
        self.meta_delay = m.get('delay')
        # (b): 合図は ledger から自分で作る（P＝sentAt を分に切り上げた時刻＋1分）
        self.mode_b = ledger is not None
        self.end_b = end_b
        self.startYen = float(m['startYen'])
        self.cap = float(m['cap'])
        self.rates = Rates(rates_spec)
        self.problems = []
        self.taus, self.deads, self.days = ny_closes(self.start, self.end)
        self.pairs = [Pair(i, n) for i, n in enumerate(PAIRS)]
        for pr in self.pairs:
            pr.load(gmo, self.start, self.end, self.problems)
            pr.setup(self.taus)
        log(f'bars loaded in {time.time() - t_start:.1f}s: ' +
            ', '.join(f'{pr.name} {pr.n}' for pr in self.pairs))
        # 時計: どれかのペアに足が始まる分（[start, end)）
        G = np.unique(np.concatenate([pr.t[(pr.t >= self.start) & (pr.t < self.end)] for pr in self.pairs]))
        self.G = G.astype(np.int64)
        self.nG = G.size
        self.e0, self.e1, self.bar, self.hasbar = [], [], [], []
        for pr in self.pairs:
            e1 = np.searchsorted(pr.t, G, 'right') - 1
            e0 = np.searchsorted(pr.t, G - MIN, 'right') - 1
            has = np.zeros(G.size, dtype=bool)
            ok = e1 >= 0
            has[ok] = pr.t[e1[ok]] == G[ok]
            self.e0.append(e0)
            self.e1.append(e1)
            self.bar.append(np.where(has, e1, -1))
            self.hasbar.append(has)
        j = np.searchsorted(self.taus, G, 'right') - 1
        jj = np.maximum(j, 0)
        self.stopG = (j >= 0) & (G < self.taus[jj] + STOP_LEN) if self.taus.size else np.zeros(G.size, bool)
        self.read_signals(dump)
        if self.mode_b:
            self.sigs_ts = self.sigs
            self.read_ledger(ledger)
        t1 = time.time()
        self.compute_paths()
        log(f'paths for {len(self.sigs)} signals x 2 sides in {time.time() - t1:.1f}s')

    def read_signals(self, dump):
        self.sigs = []
        with open(os.path.join(dump, 'signals.csv'), newline='') as f:
            for r in csv.DictReader(f):
                self.sigs.append(dict(i=int(r['i']), pair=r['pair'], p=PAIRS.index(r['pair']),
                                      dir=1 if r['side'] == 'BUY' else -1, side=r['side'],
                                      open=int(r['open']), T=int(r['T']), E=float(r['E']), tpIn=float(r['tp']),
                                      late=r['late'], lateN=(1 if str(r['late']).strip() == '1' else 0),
                                      base=int(r['base']),
                                      sent=int(r['sent']) if r.get('sent') not in (None, '') else None))

    def read_ledger(self, path):
        """(b) の合図: ledger の END_b より前に送った行。E はメールの値、利確2は E ± 10 pips、base は sentAt を
        分に切り上げた時刻（P＝base＋1分）。並びは P、楽天の一覧の順、買いが先、足の始まりの順。"""
        with open(path, newline='') as f:
            lines = [l.rstrip('\r\n') for l in f if l.strip() != '']
        if not lines or lines[0] != B_LEDGER_HEADER:
            die(f'{path}: the header is not {B_LEDGER_HEADER}')
        self.ledger = []
        seen = set()
        for n, l in enumerate(lines[1:], 1):
            c = l.split(',')
            if len(c) != 6 or c[0] not in PAIRS or c[1] not in ('BUY', 'SELL'):
                die(f'{path} row {n}: {l}')
            r = dict(pair=c[0], side=c[1], open=ms_of(c[2]), T=ms_of(c[3]), E=float(c[4]), sent=ms_of(c[5]))
            if r['open'] % (15 * MIN) != 0 or r['T'] != r['open'] + 15 * MIN or r['sent'] < r['T'] or not r['E'] > 0:
                die(f'{path} row {n}: {l}')
            key = (r['pair'], r['side'], r['open'])
            if key in seen:
                die(f'{path} row {n}: twice')
            seen.add(key)
            if self.ledger and r['sent'] < self.ledger[-1]['sent']:
                die(f'{path} row {n}: not in sentAt order')
            self.ledger.append(r)
        own = []
        for r in self.ledger:
            if r['sent'] >= self.end_b:
                continue
            p = PAIRS.index(r['pair'])
            unit = 0.0001 if r['pair'].endswith('/USD') else 0.01
            d = 1 if r['side'] == 'BUY' else -1
            own.append(dict(pair=r['pair'], p=p, dir=d, side=r['side'], open=r['open'], T=r['T'], E=r['E'],
                            tpIn=r['E'] + d * TP_PIPS * unit, late='0', lateN=0, base=ceil_min(r['sent']),
                            sent=r['sent']))
        own.sort(key=lambda x: (x['base'], x['p'], -x['dir'], x['open']))
        for i, x in enumerate(own):
            x['i'] = i
        self.sigs = own
        # S_b: 一番早い P（楽天が止まる時間に入れば、止まる時間の終わりに動かす）
        taus = ny_closes(min(x['base'] for x in own) - DAY, self.end_b)[0] if own else np.array([], np.int64)

        def moved(P):
            j = int(np.searchsorted(taus, P, 'right')) - 1
            return int(taus[j]) + STOP_LEN if j >= 0 and P < int(taus[j]) + STOP_LEN else P
        self.own_sb = min(moved(x['base'] + MIN) for x in own) if own else None

    def g_of(self, s):
        g = int(np.searchsorted(self.G, s, 'left'))
        if g >= self.nG or int(self.G[g]) != s:
            raise RuntimeError(f'minute {s} not on the clock')
        return g

    def compute_paths(self):
        self.path_sig, self.path_opp = [], []
        for s in self.sigs:
            pr = self.pairs[s['p']]
            # (a): T＋2分（遅れた合図は T＋17分）。(b): sentAt を分に切り上げた時刻＋1分
            P0 = s['base'] + MIN if self.mode_b else s['T'] + (15 * s['lateN'] + self.delay) * MIN
            for dirn, out in ((s['dir'], self.path_sig), (-s['dir'], self.path_opp)):
                tp = s['E'] + dirn * TP_PIPS * pr.unit
                r = compute_path(pr, P0, dirn, s['E'], tp, self.end, self.taus)
                r['tp'] = tp
                out.append(r)
        # 口座で使う形（合図の向き）
        self.orders_at = defaultdict(list)
        self.nobar_orders = []
        self.fill_at = defaultdict(list)
        self.tp_at = defaultdict(list)
        self.sacc = []
        for k, (s, r) in enumerate(zip(self.sigs, self.path_sig)):
            a = dict(k=k, p=s['p'], dir=s['dir'], E=s['E'], none=bool(r['none']), P=r['P'],
                     market=bool(r['market']), fill=r['fill'], fillGap=r['fillGap'], noBar=bool(r['noBar']),
                     fill_g=None, tp_g=None, tp_px=r['exit'], tpGap=r['tpGap'], t0=r['t0'])
            if not a['none']:
                key = (s['p'], 0 if s['dir'] > 0 else 1, k)
                if r['noBar']:
                    self.nobar_orders.append((r['P'], key, k))
                else:
                    self.orders_at[self.g_of(r['P'])].append((key, k))
                if r['filled'] and not r['market']:
                    a['fill_g'] = self.g_of(r['t0'])
                    self.fill_at[a['fill_g']].append(k)
                if r['tpd']:
                    a['tp_g'] = self.g_of(r['x'])
                    self.tp_at[a['tp_g']].append(k)
            self.sacc.append(a)
        for g in self.orders_at:
            self.orders_at[g] = [k for _, k in sorted(self.orders_at[g])]
        self.nobar_orders.sort()
        busy = set(self.orders_at) | set(self.fill_at) | set(self.tp_at)
        self.busy = np.array(sorted(busy), dtype=np.int64)


# ---------------------------------------------------------------- 口座
class Pos:
    __slots__ = ('k', 'p', 'dir', 'fill', 't0', 'market', 'fillGap', 'tp_g', 'tp_px', 'tpGap', 'swapQ', 'swapY')


class Call:
    __slots__ = ('tau', 'deadline', 'D', 'U', 'cancelled', 'deposits', 'credits', 'uAfter', 'end', 'endAt',
                 'held', 'hb', 'hs', 'um')


class Account:
    def __init__(self, W, swap, worst, dep, unlimited):
        self.W = W
        self.swap, self.worst, self.dep, self.unl = swap, worst, dep, unlimited
        self.yen = 0.0 if unlimited else W.startYen
        self.moneyIn = self.yen
        self.dollars = 0.0
        self.pos = {}                      # k -> Pos（入った順）
        self.ppos = [dict() for _ in PAIRS]
        self.pend = {}                     # k -> E（置いた順）
        self.ppend = [dict() for _ in PAIRS]
        self.dirty = [False] * len(PAIRS)
        self.pdirty = [False] * len(PAIRS)
        self.agg = [(0, 0, 0.0, 0.0)] * len(PAIRS)    # nb, ns, ΣfillB, ΣfillS
        self.pagg = [0.0] * len(PAIRS)                 # Σ E of pending
        self.call = None
        self.dead_g = None
        self.prev_pp = None
        self.fate = ['?'] * len(W.sigs)
        self.trades = []
        self.calls = []
        self.lcs = []
        self.deposits = []
        self.summary = {}
        self.best = None
        self.best_by = {}

    # ---- 集計
    def refresh(self):
        for p in range(len(PAIRS)):
            if self.dirty[p]:
                d = self.ppos[p]
                fb = [q.fill for q in d.values() if q.dir > 0]
                fs = [q.fill for q in d.values() if q.dir < 0]
                self.agg[p] = (len(fb), len(fs), math.fsum(fb), math.fsum(fs))
                self.dirty[p] = False
            if self.pdirty[p]:
                self.pagg[p] = math.fsum(self.ppend[p].values())
                self.pdirty[p] = False

    def uj_mid(self, k):
        pr = self.W.pairs[0]
        return (pr.bc.item(k) + pr.ac.item(k)) / 2

    def na_req(self, ix, mode, g=None):
        """ix: ペアごとの足の番号。mode: 'exit'（決済する側の終値）/'mid'/'worst'（g の足の一番悪い値）。
        戻り値: (純資産, 必要証拠金)。必要証拠金はいつも中値。"""
        self.refresh()
        W = self.W
        uj = None
        need = self.dollars != 0.0 or any(self.agg[p][0] + self.agg[p][1] > 0 for p in (3, 4))
        if need:
            uj = self.uj_mid(ix[0])
        na = self.yen
        if self.dollars != 0.0:
            na += self.dollars * uj
        req = 0.0
        for p in range(len(PAIRS)):
            nb, ns, sb, ss = self.agg[p]
            if nb + ns == 0:
                continue
            pr = W.pairs[p]
            k = ix[p]
            bc, ac = pr.bc.item(k), pr.ac.item(k)
            mid = (bc + ac) / 2
            if mode == 'mid':
                bx = ax = mid
            elif mode == 'worst' and W.hasbar[p][g]:
                kb = int(W.bar[p][g])
                bx, ax = pr.bl.item(kb), pr.ah.item(kb)
            else:
                bx, ax = bc, ac
            conv = uj if pr.usd else 1.0
            na += (nb * bx - sb + ss - ns * ax) * UNITS * conv
            req += max(nb, ns) * (UNITS * mid * MARGIN_RATE * conv)
        return na, req

    def pend_margin(self, ix):
        self.refresh()
        W = self.W
        pm = 0.0
        uj = None
        for p in range(len(PAIRS)):
            if not self.ppend[p]:
                continue
            conv = 1.0
            if W.pairs[p].usd:
                if uj is None:
                    uj = self.uj_mid(ix[0])
                conv = uj
            pm += self.pagg[p] * UNITS * MARGIN_RATE * conv
        return pm

    def order_margin(self, a, ix):
        om = a['E'] * UNITS * MARGIN_RATE
        if self.W.pairs[a['p']].usd:
            om *= self.uj_mid(ix[0])
        return om

    def offer(self, kind, value, at):
        cur = self.best_by.get(kind)
        if cur is None or value > cur['value']:
            self.best_by[kind] = dict(kind=kind, value=value, at=at)
        if self.best is None or value > self.best['value']:
            self.best = dict(kind=kind, value=value, at=at)

    # ---- 建玉
    def open_pos(self, a, fill, t0, market, fillGap):
        q = Pos()
        q.k, q.p, q.dir, q.fill, q.t0 = a['k'], a['p'], a['dir'], fill, t0
        q.market, q.fillGap = market, fillGap
        q.tp_g, q.tp_px, q.tpGap = a['tp_g'], a['tp_px'], a['tpGap']
        q.swapQ, q.swapY = 0.0, 0.0
        self.pos[q.k] = q
        self.ppos[q.p][q.k] = q
        self.dirty[q.p] = True

    def trade(self, q, px, x, how, ujk):
        pr = self.W.pairs[q.p]
        quote = UNITS * q.dir * (px - q.fill)
        yen = quote * self.uj_mid(ujk) if pr.usd else quote
        self.trades.append(dict(sig=q.k, pi=q.p, dir=q.dir, market=int(q.market), t0=q.t0, fill=q.fill,
                                fillGap=q.fillGap, x=x, exit=px, how=how, tpGap=q.tpGap if how == 'tp' else 0,
                                quote=quote, yen=yen, swapQuote=q.swapQ, swapYen=q.swapY))
        return quote

    def close_pos(self, q, px, x, how, ujk):
        del self.pos[q.k]
        del self.ppos[q.p][q.k]
        self.dirty[q.p] = True
        quote = self.trade(q, px, x, how, ujk)
        if self.W.pairs[q.p].usd:
            self.dollars += quote
        else:
            self.yen += quote
        self.fate[q.k] = how
        c = self.call
        if c is not None and q.k in c.held:
            c.held.discard(q.k)
            p = q.p
            before = max(c.hb[p], c.hs[p])
            if q.dir > 0:
                c.hb[p] -= 1
            else:
                c.hs[p] -= 1
            credit = (before - max(c.hb[p], c.hs[p])) * c.um[p]
            c.U -= credit
            c.credits += credit

    def cancel_all(self, fate):
        n = 0
        for k in list(self.pend):
            self.fate[k] = fate
            n += 1
        self.pend.clear()
        for p in range(len(PAIRS)):
            if self.ppend[p]:
                self.ppend[p].clear()
                self.pdirty[p] = True
        return n

    def end_call(self, how, at):
        c = self.call
        c.end, c.endAt = how, at
        self.call = None
        self.dead_g = None

    # ---- 注文
    def take_order(self, k, at, ix):
        a = self.W.sacc[k]
        if self.unl:
            na, req = self.na_req(ix, 'exit')
            pm = self.pend_margin(ix)
            om = self.order_margin(a, ix)
            self.offer('order', req + pm + om - na, at)
            self.offer('loss', -na, at)
        else:
            if self.call is not None:
                self.fate[k] = 'refusedCall'
                return
            na, req = self.na_req(ix, 'exit')
            pm = self.pend_margin(ix)
            om = self.order_margin(a, ix)
            if na - (req + pm) < om:
                self.fate[k] = 'refusedMargin'
                return
        if a['market']:
            self.open_pos(a, a['fill'], a['P'], 1, 0)
        else:
            self.pend[k] = a['E']
            self.ppend[a['p']][k] = a['E']
            self.pdirty[a['p']] = True

    # ---- 出来事
    def ev_close(self, ti):
        W = self.W
        tau = int(W.taus[ti])
        ix = [pr.ended(tau) for pr in W.pairs]
        pp = tuple(ix)
        prev = self.prev_pp
        self.prev_pp = pp
        if self.unl:
            # 項は行が判定する引けだけ: 前の引けと同じ値段の点の引けでは数えない
            if pp != prev:
                nam, req = self.na_req(ix, 'mid')
                nax, _ = self.na_req(ix, 'exit')
                self.offer('close', req - nam, tau)
                self.offer('loss', -nax, tau)
            return
        if self.call is not None or pp == prev:
            return
        nam, req = self.na_req(ix, 'mid')
        if req > 0 and nam < req:
            c = Call()
            c.tau, c.deadline = tau, int(W.deads[ti])
            c.D = req - nam
            c.U = c.D
            c.deposits = 0.0
            c.credits = 0.0
            c.uAfter = None
            c.end, c.endAt = 'open', None
            c.cancelled = self.cancel_all('cancelCall')
            c.held = set(self.pos)
            c.hb, c.hs, c.um = [0] * 5, [0] * 5, [0.0] * 5
            uj = None
            for p in range(len(PAIRS)):
                nb, ns, _, _ = self.agg[p]
                c.hb[p], c.hs[p] = nb, ns
                if nb + ns:
                    pr = W.pairs[p]
                    mid = (pr.bc.item(ix[p]) + pr.ac.item(ix[p])) / 2
                    conv = 1.0
                    if pr.usd:
                        if uj is None:
                            uj = self.uj_mid(ix[0])
                        conv = uj
                    c.um[p] = UNITS * mid * MARGIN_RATE * conv
            self.call = c
            self.calls.append(c)
            g = int(np.searchsorted(W.G, c.deadline, 'left'))
            self.dead_g = g if g < W.nG else None
            if self.dep == '0859':
                heapq.heappush(self.heap, (c.deadline - MIN, 1, next(self.seq), 'dep', c))

    def ev_swap(self, ti):
        if not self.pos:
            return
        W = self.W
        tau = int(W.taus[ti])
        days = W.days[ti]
        mids = {}
        ujk = None
        for q in list(self.pos.values()):
            if not q.t0 < tau:
                continue
            pr = W.pairs[q.p]
            if q.p not in mids:
                k = pr.ended(tau)
                mids[q.p] = (pr.bc.item(k) + pr.ac.item(k)) / 2
            rb = W.rates.rate(AREAS[pr.name][0], tau)
            rq = W.rates.rate(AREAS[pr.name][1], tau)
            qv = (q.dir * (rb - rq) - FEE) / 100 * UNITS * mids[q.p] * days / 365
            if pr.usd:
                cents = math.floor(qv * 100 + 1e-9) / 100
                if ujk is None:
                    ujk = W.pairs[0].ended(tau)
                u = W.pairs[0]
                rate = u.bc.item(ujk) if cents >= 0 else u.ac.item(ujk)
                y = float(math.floor(cents * rate + 1e-9))
            else:
                y = float(math.floor(qv + 1e-9))
            self.yen += y
            q.swapQ += qv
            q.swapY += y

    def deposit(self, c, at):
        amount = min(c.U, self.W.cap - self.moneyIn)
        if amount < 0:
            amount = 0.0
        if amount > 0:
            self.yen += amount
            self.moneyIn += amount
            self.deposits.append(dict(at=at, amount=amount, total=self.moneyIn, why='call'))
        c.deposits += amount
        c.U -= amount
        c.uAfter = c.U
        if c.U <= 0:
            self.end_call('deposit', at)

    def ev(self, e):
        t, rank, _, kind, arg = e
        W = self.W
        if kind == 'close':
            self.ev_close(arg)
        elif kind == 'swap':
            self.ev_swap(arg)
        elif kind == 'notice':
            if self.call is not None and self.call.tau == int(W.taus[arg]):
                self.deposit(self.call, t)
        elif kind == 'dep':
            if self.call is arg:
                self.deposit(arg, t)
        elif kind == 'order':
            ix = [pr.ended(t) for pr in W.pairs]
            self.take_order(arg, t, ix)
        elif kind == 'split':
            ix = [pr.ended(t) for pr in W.pairs]
            na, _ = self.na_req(ix, 'exit')
            self.summary['naSplit'] = na
            self.summary['inSplit'] = self.moneyIn
        elif kind == 'end':
            ix = [pr.ended(t) for pr in W.pairs]
            na, _ = self.na_req(ix, 'exit')
            self.summary['naEnd'] = na
            self.summary['inEnd'] = self.moneyIn
            for q in list(self.pos.values()):
                pr = W.pairs[q.p]
                k = ix[q.p]
                px = pr.bc.item(k) if q.dir > 0 else pr.ac.item(k)
                self.trade(q, px, None, 'held', ix[0])
                self.fate[q.k] = 'held'
            for k in self.pend:
                self.fate[k] = 'unfilled'
            # 追証が END でまだ続いていれば end='open', endAt=なし（Call の初期値のまま）

    # ---- 1分足
    def lc_check(self, g):
        W = self.W
        s = int(W.G[g])
        ix1 = [int(W.e1[p][g]) for p in range(len(PAIRS))]
        mode = 'worst' if self.worst else 'exit'
        na, req = self.na_req(ix1, mode, g)
        if self.unl:
            # 損益の項も、この行が⑤で判定する純資産（一番悪い値の行では一番悪い値）で数える（報告の曖昧さ 参照）
            self.offer('lc', LC_LEVEL * req - na, s + MIN)
            self.offer('loss', -na, s + MIN)
            return
        if req > 0 and na < LC_LEVEL * req:
            closed = 0
            for q in list(self.pos.values()):
                pr = W.pairs[q.p]
                if self.worst and W.hasbar[q.p][g]:
                    kb = int(W.bar[q.p][g])
                    px = pr.bl.item(kb) if q.dir > 0 else pr.ah.item(kb)
                else:
                    k = ix1[q.p]
                    px = pr.bc.item(k) if q.dir > 0 else pr.ac.item(k)
                self.close_pos(q, px, s, 'lc', ix1[0])
                closed += 1
            cancelled = self.cancel_all('cancelLc')
            na_after, _ = self.na_req(ix1, 'exit')
            self.lcs.append(dict(at=s + MIN, naBefore=na, naAfter=na_after, closed=closed, cancelled=cancelled))
            if self.call is not None:
                self.end_call('lc', s + MIN)

    def minute(self, g):
        W = self.W
        s = int(W.G[g])
        c = self.call
        # ① 期限
        if c is not None and s >= c.deadline and c.U > 0:
            ix0 = [int(W.e0[p][g]) for p in range(len(PAIRS))]
            for q in list(self.pos.values()):
                pr = W.pairs[q.p]
                if W.hasbar[q.p][g]:
                    kb = int(W.bar[q.p][g])
                    px = pr.bo.item(kb) if q.dir > 0 else pr.ao.item(kb)
                else:
                    k = ix0[q.p]
                    px = pr.bc.item(k) if q.dir > 0 else pr.ac.item(k)
                self.close_pos(q, px, s, 'deadline', ix0[0])
            self.end_call('deadline', s)
        if W.stopG[g]:
            return
        # ② P = s の注文
        olist = W.orders_at.get(g)
        if olist:
            ix0 = [int(W.e0[p][g]) for p in range(len(PAIRS))]
            for k in olist:
                self.take_order(k, s, ix0)
        # ③ 指値の約定（置いた順）
        flist = W.fill_at.get(g)
        if flist:
            order = {k: i for i, k in enumerate(self.pend)}
            for k in sorted((k for k in flist if k in self.pend), key=order.get):
                a = W.sacc[k]
                del self.pend[k]
                del self.ppend[a['p']][k]
                self.pdirty[a['p']] = True
                self.open_pos(a, a['fill'], s, 0, a['fillGap'])
        # ④ 利確（入った順。入った足では数えない — 道筋の TP の足は入った足より後）
        tlist = W.tp_at.get(g)
        if tlist:
            order = {k: i for i, k in enumerate(self.pos)}
            ujk = int(W.e0[0][g])
            for k in sorted((k for k in tlist if k in self.pos), key=order.get):
                q = self.pos[k]
                self.close_pos(q, q.tp_px, s, 'tp', ujk)
        # ⑤ ロスカットと解消
        self.lc_check(g)
        c = self.call
        if c is not None and c.U <= 0:
            self.end_call('settle', s + MIN)

    def quiet(self, ga, gb):
        """①〜④が何も起きない分 [ga, gb) の⑤を、まとめて numpy で見る。ロスカットの分の番号を返す。"""
        W = self.W
        self.refresh()
        active = [p for p in range(len(PAIRS)) if self.agg[p][0] + self.agg[p][1] > 0]
        if not self.unl and not active:
            return None
        sl = slice(ga, gb)
        nonstop = ~W.stopG[sl]
        if not nonstop.any():
            return None
        L = gb - ga
        need_uj = self.dollars != 0.0 or any(W.pairs[p].usd for p in active)
        ujm = None
        if need_uj:
            k = W.e1[0][sl]
            u = W.pairs[0]
            ujm = (u.bc[k] + u.ac[k]) / 2
        na = np.full(L, self.yen)
        if self.dollars != 0.0:
            na = na + self.dollars * ujm
        req = np.zeros(L)
        for p in active:
            nb, ns, sb, ss = self.agg[p]
            pr = W.pairs[p]
            k = W.e1[p][sl]
            bc = pr.bc[k]
            ac = pr.ac[k]
            mid = (bc + ac) / 2
            conv = ujm if pr.usd else 1.0
            if self.worst:
                hb = W.hasbar[p][sl]
                kb = W.bar[p][sl]
                bx = np.where(hb, pr.bl[kb], bc)
                ax = np.where(hb, pr.ah[kb], ac)
            else:
                bx, ax = bc, ac
            na += (nb * bx - sb + ss - ns * ax) * UNITS * conv
            req += max(nb, ns) * (UNITS * mid * MARGIN_RATE * conv)
        if not self.unl:
            cond = nonstop & (req > 0) & (na < LC_LEVEL * req)
            j = int(np.argmax(cond))
            return ga + j if cond[j] else None
        lc = np.where(nonstop, LC_LEVEL * req - na, -np.inf)
        loss = np.where(nonstop, -na, -np.inf)
        j1 = int(np.argmax(lc))
        j2 = int(np.argmax(loss))
        cand = sorted([(j1, 0, 'lc', float(lc[j1])), (j2, 1, 'loss', float(loss[j2]))])
        for j, _, kind, v in cand:
            self.offer(kind, v, int(W.G[ga + j]) + MIN)
        return None

    def run(self):
        W = self.W
        self.heap = heap = []
        self.seq = seq = itertools.count()
        for ti in range(W.taus.size):
            tau = int(W.taus[ti])
            heap.append((tau, 3, next(seq), 'close', ti))
            if self.swap:
                heap.append((tau + STOP_LEN, 0, next(seq), 'swap', ti))
            if self.dep == 'notice' and not self.unl:
                heap.append((tau + NOTICE_AFTER, 1, next(seq), 'notice', ti))
        for P, _, k in W.nobar_orders:
            heap.append((P, 2, next(seq), 'order', k))
        heap.append((W.split, 9, next(seq), 'split', None))
        heap.append((W.end, 10, next(seq), 'end', None))
        heapq.heapify(heap)
        for k, a in enumerate(W.sacc):
            if a['none']:
                self.fate[k] = 'none'
        G, nG, busy = W.G, W.nG, W.busy
        g = 0
        bptr = 0
        while True:
            if heap and (g >= nG or heap[0][0] <= int(G[g])):
                e = heapq.heappop(heap)
                if e[3] == 'end' or e[0] > W.end:
                    if e[3] == 'end':
                        self.ev(e)
                    break
                self.ev(e)
                continue
            if g >= nG:
                break
            while bptr < busy.size and busy[bptr] < g:
                bptr += 1
            nb = int(busy[bptr]) if bptr < busy.size else nG
            if self.dead_g is not None and self.dead_g >= g:
                nb = min(nb, self.dead_g)
            ge = int(np.searchsorted(G, heap[0][0], 'left')) if heap else nG
            stop_at = min(nb, ge)
            if stop_at > g:
                lg = self.quiet(g, stop_at)
                if lg is None:
                    g = stop_at
                else:
                    self.minute(lg)
                    g = lg + 1
                continue
            self.minute(g)
            g += 1
        if self.unl:
            self.summary['estar'] = self.best
            self.summary['estarBy'] = self.best_by
            self.summary['mSplit'] = self.summary.get('naSplit')
            self.summary['mEnd'] = self.summary.get('naEnd')
        return self


# ---------------------------------------------------------------- ③
def third(W):
    rows = []
    for s, a, b in zip(W.sigs, W.path_sig, W.path_opp):
        if a['P'] + H24 <= W.end:
            rows.append((s, a['value'] - b['value']))
    N = len(rows)
    cells = {}
    for pn in PAIRS:
        for sd in ('BUY', 'SELL'):
            cells[(pn, sd)] = []
    for s, d in rows:
        cells[(s['pair'], s['side'])].append(d)
    out = dict(n=N, main=None, loWeeks=None, loBlocks=None, L=None, plain=None, plainL=None,
               cells=[dict(pair=pn, side=sd, n=len(v), mean=(sum(v) / len(v) if v else None))
                      for (pn, sd), v in cells.items()])
    if N == 0:
        return out
    weeks = [(s['T'] - WEEK_OFFSET) // WEEK for s, _ in rows]
    blocks = [w // 4 for w in weeks]

    def lows(x, mean):
        res = []
        for keys in (weeks, blocks):
            S, n = defaultdict(float), defaultdict(int)
            for kk, xi in zip(keys, x):
                S[kk] += xi
                n[kk] += 1
            C = len(S)
            if C < 2:
                res.append(None)
                continue
            ss = sum((S[kk] - mean * n[kk]) ** 2 for kk in S)
            se = math.sqrt(C / (C - 1) * ss) / N
            res.append(mean - t975(C - 1) * se)
        return res
    d = [dd for _, dd in rows]
    plain = sum(d) / N
    out['plain'] = plain
    pw, pb = lows(d, plain)
    out['plainL'] = min(pw, pb) if pw is not None and pb is not None else None
    if all(len(v) > 0 for v in cells.values()):
        ncell = {kk: len(v) for kk, v in cells.items()}
        x = [N / (10 * ncell[(s['pair'], s['side'])]) * dd for s, dd in rows]
        main = sum(x) / N
        lw, lb = lows(x, main)
        out.update(main=main, loWeeks=lw, loBlocks=lb, L=(min(lw, lb) if lw is not None and lb is not None else None))
    return out


# ---------------------------------------------------------------- 比べる
def fnum(v):
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return None if (isinstance(v, float) and math.isnan(v)) else float(v)
    v = str(v).strip()
    if v == '' or v.lower() in ('nan', 'null', 'none', 'undefined'):
        return None
    return float(v)


def jsonable(v):
    if isinstance(v, float) and (math.isnan(v) or math.isinf(v)):
        return None
    if isinstance(v, (np.integer,)):
        return int(v)
    if isinstance(v, (np.floating,)):
        return jsonable(float(v))
    return v


class Cmp:
    def __init__(self):
        self.compared = defaultdict(int)
        self.mism = defaultdict(int)
        self.ex = defaultdict(list)

    def bad(self, kind, key, field, mine, dump):
        self.mism[kind] += 1
        if len(self.ex[kind]) < 20:
            self.ex[kind].append(dict(key=key, field=field, mine=jsonable(mine), dump=jsonable(dump)))

    def check(self, kind, key, field, mine, dump, how):
        self.compared[kind] += 1
        if how == 'str':
            ok = (mine if mine is not None else '') == (dump if dump is not None else '')
        else:
            a, b = fnum(mine), fnum(dump)
            if a is None or b is None:
                ok = a is None and b is None
            elif how == 'exact':
                ok = a == b
            elif how == 'price':
                ok = abs(a - b) <= 1e-9
            elif how == 'pips':
                ok = abs(a - b) <= 1e-6
            elif how == 'yen':
                ok = abs(a - b) <= max(1e-6, 1e-12 * max(abs(a), abs(b)))
            else:
                raise ValueError(how)
        if not ok:
            self.bad(kind, key, field, mine, dump)
        return ok

    def count(self, kind, key, mine_n, dump_n):
        return self.check(kind, key, 'rows', mine_n, dump_n, 'exact')


def read_csv(path):
    if not os.path.exists(path):
        return None
    with open(path, newline='') as f:
        return list(csv.DictReader(f))


def compare_paths(C, W, dump):
    for name, paths in (('paths-main', W.path_sig), ('paths-opposite', W.path_opp)):
        rows = read_csv(os.path.join(dump, name + '.csv'))
        if rows is None:
            C.bad(name, 'file', 'missing', None, None)
            continue
        byi = {int(r['i']): r for r in rows}
        C.count(name, 'all', len(paths), len(rows))
        for s, r in zip(W.sigs, paths):
            i = s['i']
            d = byi.get(i)
            if d is None:
                C.bad(name, i, 'row missing', None, None)
                continue
            for f in ('P', 'shifted', 'noBar', 'none', 'market', 'fillGap', 'tpGap', 'tpInFill'):
                C.check(name, i, f, r[f], d[f], 'exact')
            dfk = fnum(d['fillK'])
            dfilled = (dfk is not None and dfk != -2 and int(fnum(d['none']) or 0) == 0)
            C.check(name, i, 'filled', int(r['filled']), int(dfilled), 'exact')
            dtk = fnum(d['tpK'])
            C.check(name, i, 'tpd', int(r['tpd']), int(dtk is not None and dtk >= 0), 'exact')
            C.check(name, i, 't0', r['t0'], d['t0'], 'exact')
            C.check(name, i, 'x', r['x'], d['x'], 'exact')
            C.check(name, i, 'fill', r['fill'], d['fill'], 'price')
            C.check(name, i, 'exit', r['exit'], d['exit'], 'price')
            C.check(name, i, 'endPx', r['endPx'], d['endPx'], 'price')
            C.check(name, i, 'mae', r['mae'], d['mae'], 'pips')


def compare_third(C, mine, dump):
    j = json.load(open(os.path.join(dump, 'third.json'))) if os.path.exists(os.path.join(dump, 'third.json')) else None
    if j is None:
        C.bad('third', 'file', 'missing', None, None)
        return
    d = j.get('main', {})
    C.check('third', 'main', 'n', mine['n'], d.get('n'), 'exact')
    for f in ('main', 'loWeeks', 'loBlocks', 'L', 'plain', 'plainL'):
        a, b = mine[f], fnum(d.get(f))
        C.compared['third'] += 1
        if (a is None) != (b is None) or (a is not None and abs(a - b) > 1e-9):
            C.bad('third', 'main', f, a, b)
    dc = {(c['pair'], c['side']): c for c in d.get('cells', [])}
    for c in mine['cells']:
        e = dc.get((c['pair'], c['side']))
        if e is None:
            C.bad('third', 'cells', f"{c['pair']} {c['side']} missing", None, None)
            continue
        C.check('third', f"{c['pair']} {c['side']}", 'n', c['n'], e.get('n'), 'exact')
        a, b = c['mean'], fnum(e.get('mean'))
        C.compared['third'] += 1
        if (a is None) != (b is None) or (a is not None and abs(a - b) > 1e-9):
            C.bad('third', f"{c['pair']} {c['side']}", 'mean', a, b)


TRADE_FIELDS = [('pi', 'exact'), ('dir', 'exact'), ('market', 'exact'), ('t0', 'exact'), ('fill', 'price'),
                ('fillGap', 'exact'), ('x', 'exact'), ('exit', 'price'), ('how', 'str'), ('tpGap', 'exact'),
                ('quote', 'yen'), ('yen', 'yen'), ('swapQuote', 'yen'), ('swapYen', 'exact')]


def compare_account(C, acc, dump, row, unlimited):
    pre = f'{row}'
    base = os.path.join(dump, f'acct-{row}-')
    # fates
    kind = pre + '.fates'
    rows = read_csv(base + 'fates.csv')
    if rows is None:
        C.bad(kind, 'file', 'missing', None, None)
    else:
        C.count(kind, 'all', len(acc.fate), len(rows))
        byk = {int(r['k']): r['fate'] for r in rows}
        for k, f in enumerate(acc.fate):
            C.check(kind, k, 'fate', f, byk.get(k), 'str')
    # trades
    kind = pre + '.trades'
    rows = read_csv(base + 'trades.csv')
    if rows is None:
        C.bad(kind, 'file', 'missing', None, None)
    else:
        mine = {t['sig']: t for t in acc.trades}
        dmp = {int(r['sig']): r for r in rows}
        C.count(kind, 'all', len(mine), len(rows))
        for k in sorted(set(mine) | set(dmp)):
            if k not in mine or k not in dmp:
                C.bad(kind, k, 'trade only in ' + ('mine' if k in mine else 'dump'), None, None)
                continue
            for f, how in TRADE_FIELDS:
                if f not in dmp[k]:
                    C.bad(kind, k, f + ' column missing', mine[k][f], None)
                    continue
                C.check(kind, k, f, mine[k][f], dmp[k][f], how)
    # calls
    kind = pre + '.calls'
    rows = read_csv(base + 'calls.csv')
    if rows is None:
        C.bad(kind, 'file', 'missing', None, None)
    else:
        C.count(kind, 'all', len(acc.calls), len(rows))
        for n, (c, d) in enumerate(zip(acc.calls, rows)):
            key = f'#{n} tau={c.tau}'
            C.check(kind, key, 'tau', c.tau, d['tau'], 'exact')
            C.check(kind, key, 'deadline', c.deadline, d['deadline'], 'exact')
            C.check(kind, key, 'D', c.D, d['D'], 'yen')
            C.check(kind, key, 'cancelled', c.cancelled, d['cancelled'], 'exact')
            C.check(kind, key, 'deposits', c.deposits, d['deposits'], 'yen')
            C.check(kind, key, 'credits', c.credits, d['credits'], 'yen')
            C.check(kind, key, 'uAfterDeposit', c.uAfter, d['uAfterDeposit'], 'yen')
            C.check(kind, key, 'end', c.end, d['end'], 'str')
            C.check(kind, key, 'endAt', c.endAt, d['endAt'], 'exact')
    # lcs
    kind = pre + '.lcs'
    rows = read_csv(base + 'lcs.csv')
    if rows is None:
        C.bad(kind, 'file', 'missing', None, None)
    else:
        C.count(kind, 'all', len(acc.lcs), len(rows))
        for n, (c, d) in enumerate(zip(acc.lcs, rows)):
            key = f'#{n} at={c["at"]}'
            C.check(kind, key, 'at', c['at'], d['at'], 'exact')
            C.check(kind, key, 'naBefore', c['naBefore'], d['naBefore'], 'yen')
            C.check(kind, key, 'naAfter', c['naAfter'], d['naAfter'], 'yen')
            C.check(kind, key, 'closed', c['closed'], d['closed'], 'exact')
            C.check(kind, key, 'cancelled', c['cancelled'], d['cancelled'], 'exact')
    # deposits
    kind = pre + '.deposits'
    rows = read_csv(base + 'deposits.csv')
    if rows is None:
        C.bad(kind, 'file', 'missing', None, None)
    else:
        C.count(kind, 'all', len(acc.deposits), len(rows))
        for n, (c, d) in enumerate(zip(acc.deposits, rows)):
            key = f'#{n} at={c["at"]}'
            C.check(kind, key, 'at', c['at'], d['at'], 'exact')
            C.check(kind, key, 'amount', c['amount'], d['amount'], 'yen')
            C.check(kind, key, 'total', c['total'], d['total'], 'yen')
            C.check(kind, key, 'why', c['why'], d['why'], 'str')
    # summary
    kind = pre + '.summary'
    p = base + 'summary.json'
    if not os.path.exists(p):
        C.bad(kind, 'file', 'missing', None, None)
        return
    d = json.load(open(p))
    for f in ('naSplit', 'inSplit', 'naEnd', 'inEnd'):
        C.check(kind, row, f, acc.summary.get(f), d.get(f), 'yen')
    if unlimited:
        kind = pre + '.estar'
        e, de = acc.summary['estar'], d.get('estar') or {}
        C.check(kind, 'estar', 'value', e['value'] if e else None, de.get('value'), 'yen')
        C.check(kind, 'estar', 'kind', e['kind'] if e else None, de.get('kind'), 'str')
        C.check(kind, 'estar', 'at', e['at'] if e else None, de.get('at'), 'exact')
        dby = d.get('estarBy') or {}
        for kk in ('order', 'close', 'lc', 'loss'):
            m, b = acc.summary['estarBy'].get(kk), dby.get(kk)
            C.check(kind, 'estarBy.' + kk, 'value', m['value'] if m else None, (b or {}).get('value'), 'yen')
            C.check(kind, 'estarBy.' + kk, 'at', m['at'] if m else None, (b or {}).get('at'), 'exact')
        kind = pre + '.M'
        C.check(kind, row, 'mSplit', acc.summary['mSplit'], d.get('mSplit'), 'yen')
        C.check(kind, row, 'mEnd', acc.summary['mEnd'], d.get('mEnd'), 'yen')


def round_chart(x, dec, mode):
    """E の丸め。exact: x（double）の正確な値を、半分は上へ丸める（チャートの Number(v.toFixed(d))）。
    mathround: Math.round(x*10^d)/10^d（調べる用）。"""
    if mode == 'mathround':
        return math.floor(x * 10 ** dec + 0.5) / 10 ** dec
    from decimal import Decimal, ROUND_HALF_UP
    return float(Decimal(x).quantize(Decimal(1).scaleb(-dec), ROUND_HALF_UP))


EXPECT_REAL = dict(startYen=300000.0, cap=1000000.0, start='2024-01-01T00:00:00Z', split='2025-05-19T00:00:00Z')


def check_meta(C, W, expect_real):
    """注文の時刻の元（§8.102: P＝T＋2分。遅れた合図は窓 i+1 の確定 T＋15分の2分後）と、実データの run の決まった値"""
    if W.mode_b:
        check_meta_b(C, W)
        return
    C.check('meta', 'delay', 'delay', W.meta_delay, 2, 'exact')
    for s in W.sigs:
        C.check('signals.time', s['i'], 'T', s['T'], s['open'] + 15 * MIN, 'exact')
        C.check('signals.time', s['i'], 'late', str(s['late']).strip() in ('0', '1'), True, 'str')
        C.check('signals.time', s['i'], 'base', s['base'], s['T'] + 15 * MIN * s['lateN'], 'exact')
    if expect_real:
        import datetime
        iso = lambda ms: datetime.datetime.fromtimestamp(ms / 1000, datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
        C.check('meta', 'real', 'startYen', W.startYen, EXPECT_REAL['startYen'], 'exact')
        C.check('meta', 'real', 'cap', W.cap, EXPECT_REAL['cap'], 'exact')
        C.check('meta', 'real', 'start', iso(W.start), EXPECT_REAL['start'], 'str')
        C.check('meta', 'real', 'split', iso(W.split), EXPECT_REAL['split'], 'str')


def check_meta_b(C, W):
    """(b): meta（P の元の1分・S_b・END_b・境＝END_b・30万円・100万円）と、TS の signals.csv を、ledger から
    自分で作った合図と1件ずつ照らす（並び・ペア・向き・足・E・利確2・sentAt・base）"""
    m = W.meta
    C.check('meta', 'b', 'delay', W.meta_delay, 1, 'exact')
    C.check('meta', 'b', 'mode', m.get('mode'), 'b', 'str')
    C.check('meta', 'b', 'start (S_b)', W.start, W.own_sb, 'exact')
    C.check('meta', 'b', 'end', W.end, W.end_b, 'exact')
    C.check('meta', 'b', 'endB', m.get('endB'), W.end_b, 'exact')
    C.check('meta', 'b', 'split', W.split, W.end_b, 'exact')
    C.check('meta', 'b', 'startYen', W.startYen, 300000.0, 'exact')
    C.check('meta', 'b', 'cap', W.cap, 1000000.0, 'exact')
    C.count('signals.b', 'all', len(W.sigs), len(W.sigs_ts))
    for own, ts in zip(W.sigs, W.sigs_ts):
        i = own['i']
        C.check('signals.b', i, 'i', own['i'], ts['i'], 'exact')
        C.check('signals.b', i, 'pair', own['pair'], ts['pair'], 'str')
        C.check('signals.b', i, 'side', own['side'], ts['side'], 'str')
        for f in ('open', 'T', 'base'):
            C.check('signals.b', i, f, own[f], ts[f], 'exact')
        C.check('signals.b', i, 'E', own['E'], ts['E'], 'price')
        C.check('signals.b', i, 'tp', own['tpIn'], ts['tpIn'], 'price')
        C.check('signals.b', i, 'late', str(ts['late']).strip(), '0', 'str')
        C.check('signals.b', i, 'sent', own['sent'], ts.get('sent'), 'exact')


def b_quantile(xs, q):
    """小さい順の floor(q ×（個数 − 1）) 番目（money-stats.ts の quantile と同じ）"""
    s = sorted(xs)
    return s[min(len(s) - 1, math.floor(q * (len(s) - 1)))]


def b_median(xs):
    s = sorted(xs)
    n = len(s)
    if not n:
        return None
    return s[(n - 1) // 2] if n % 2 else (s[n // 2 - 1] + s[n // 2]) / 2


def compare_b(C, W, dump, a_csv):
    """(b): 送るまでの時間（delays.json）と、比べる窓（window.json）を自分で計算して比べる"""
    # 送るまでの時間: END_b より前に送った全行の sentAt − T（秒）
    xs = [(r['sent'] - r['T']) / 1000 for r in W.ledger if r['sent'] < W.end_b]
    p = os.path.join(dump, 'delays.json')
    if not os.path.exists(p):
        C.bad('b.delays', 'file', 'missing', None, None)
    else:
        d = json.load(open(p))
        C.check('b.delays', 'all', 'n', len(xs), d.get('n'), 'exact')
        C.check('b.delays', 'all', 'median', b_median(xs), d.get('median'), 'price')
        C.check('b.delays', 'all', 'max', max(xs) if xs else None, d.get('max'), 'price')
    # (a) のファイル: commit したものそのものか
    raw = open(a_csv, 'rb').read()
    C.check('b.acsv', 'sha256', 'sha256', hashlib.sha256(raw).hexdigest(), B_A_SHA256, 'str')
    lines = [l for l in raw.decode('utf-8').split('\n') if l != '']
    if not lines or lines[0] != B_A_HEADER:
        die(f'{a_csv}: the header is not {B_A_HEADER}')
    arows = []
    for l in lines[1:]:
        c = l.split(',')
        arows.append((ms_of(c[3]), float(c[5])))
    # 数える行: 道筋が何もしないでなく、P＋24時間 ≦ END_b（P は止まる時間で動かした後）。値は P から1日後
    vals = []
    for sg, r in zip(W.sigs, W.path_sig):
        if r['none'] or r['P'] + H24 > W.end_b:
            continue
        vals.append((r['P'], email_values(W.pairs[sg['p']], r, sg['dir'])['d1']))
    n = sum(1 for P, _ in vals if P + H24 <= W.end_b)
    n_prev = sum(1 for P, _ in vals if P + H24 <= W.end_b - WEEK)
    due = n >= B_COMPARE_AT and n_prev < B_COMPARE_AT
    p = os.path.join(dump, 'window.json')
    if not os.path.exists(p):
        C.bad('b.window', 'file', 'missing', None, None)
        return
    d = json.load(open(p))
    C.check('b.window', 'all', 'n', n, d.get('n'), 'exact')
    C.check('b.window', 'all', 'nPrev', n_prev, d.get('nPrev'), 'exact')
    C.check('b.window', 'all', 'due', int(due), int(bool(d.get('due'))), 'exact')
    if not due or not d.get('due'):
        return
    sb = W.own_sb
    o1 = sb - B_W0
    o2 = W.end_b - H24 - B_W0
    C.check('b.window', 'all', 'o1', o1, d.get('o1'), 'exact')
    C.check('b.window', 'all', 'o2', o2, d.get('o2'), 'exact')
    bs = [v for P, v in vals if sb <= P <= W.end_b - H24]
    bv = sum(bs) / len(bs)
    db = d.get('b') or {}
    C.check('b.window', 'b', 'n', len(bs), db.get('n'), 'exact')
    C.check('b.window', 'b', 'value', bv, db.get('value'), 'pips')
    lst, empty, k = [], 0, 1
    while True:
        w = B_W0 - k * WEEK
        k += 1
        if w + o1 < B_A_START:
            break
        if w + o2 + H24 > B_A_END:
            continue
        ys = [v for P, v in arows if w + o1 <= P <= w + o2]
        if not ys:
            empty += 1
            continue
        lst.append((w, len(ys), sum(ys) / len(ys)))
    values = [x[2] for x in lst]
    q05, q95 = b_quantile(values, 0.05), b_quantile(values, 0.95)
    da = d.get('a') or {}
    C.check('b.window', 'a', 'values', len(values), da.get('values'), 'exact')
    C.check('b.window', 'a', 'empty', empty, da.get('empty'), 'exact')
    C.check('b.window', 'a', 'q05', q05, da.get('q05'), 'pips')
    C.check('b.window', 'a', 'q95', q95, da.get('q95'), 'pips')
    ns = [x[1] for x in lst]
    dc = da.get('counts') or {}
    C.check('b.window', 'a', 'counts.min', min(ns), dc.get('min'), 'exact')
    C.check('b.window', 'a', 'counts.median', b_median(ns), dc.get('median'), 'exact')
    C.check('b.window', 'a', 'counts.max', max(ns), dc.get('max'), 'exact')
    dl = da.get('list') or []
    C.count('b.window', 'a.list', len(lst), len(dl))
    for (w, nn, v), e in zip(lst, dl):
        C.check('b.window', w, 'W', w, ms_of(e['W']), 'exact')
        C.check('b.window', w, 'n', nn, e.get('n'), 'exact')
        C.check('b.window', w, 'value', v, e.get('value'), 'pips')
    verdict = 'above' if bv > q95 else 'below' if bv < q05 else 'inside'
    C.check('b.window', 'all', 'verdict', verdict, d.get('verdict'), 'str')


def check_inputs(C, W, pairs15, e_mode, notes):
    # E と 15分足（合図の足の中値の終値、チャートと同じ丸め）
    n_skip = n_other = 0
    for s in W.sigs:
        pr = W.pairs[s['p']]
        p15 = pairs15[s['p']]
        if not p15['bid'] and not p15['ask']:
            n_skip += 1          # そのペアの15分足のファイルが全部空（手の例）: E は確かめられない
        else:
            b = p15['bid'].get(s['open'])
            a = p15['ask'].get(s['open'])
            if W.mode_b:
                # (b): E はメールの値。15分足から作り直した値との違いは数えるだけ（TS の照合の一覧に出る）
                x = (b + a) / 2 if a is not None and b is not None else None
                if x is None or abs(round_chart(x, pr.dec, e_mode) - s['E']) > 1e-12:
                    notes['b_E_differs_from_15min_bars'] = notes.get('b_E_differs_from_15min_bars', 0) + 1
            elif a is None or b is None:
                C.compared['E'] += 1
                C.bad('E', s['i'], 'no 15min bar at open', None, s['E'])
            else:
                C.compared['E'] += 1
                x = (b + a) / 2
                r = round_chart(x, pr.dec, e_mode)
                if abs(r - s['E']) > 1e-12:
                    other = round_chart(x, pr.dec, 'exact' if e_mode == 'mathround' else 'mathround')
                    n_other += abs(other - s['E']) <= 1e-12
                    C.bad('E', s['i'], f'E (mid {x!r}; other rounding gives {other!r})', r, s['E'])
        # 利確（合図の向き）= E ± 10 pips
        C.check('signals.tp', s['i'], 'tp', s['E'] + s['dir'] * TP_PIPS * pr.unit, s['tpIn'], 'price')
    notes['E_rounding'] = e_mode
    notes['E_not_checked_no_15min_files'] = n_skip
    notes['E_mismatches_that_the_other_rounding_matches'] = n_other


def _fmt(v):
    if v is None:
        return 'NaN'
    if isinstance(v, bool):
        return str(int(v))
    if isinstance(v, float):
        if math.isnan(v):
            return 'NaN'
        if v == int(v) and abs(v) < 1e15:
            return str(int(v))
        return repr(v)
    return str(v)


def write_mine(d, W, th, accs, unl):
    os.makedirs(d, exist_ok=True)

    def wcsv(name, cols, rows):
        with open(os.path.join(d, name), 'w', newline='') as f:
            w = csv.writer(f, lineterminator='\n')
            w.writerow(cols)
            for r in rows:
                w.writerow([_fmt(r.get(c)) for c in cols])
    pcols = ['i', 'P', 'shifted', 'noBar', 'none', 'market', 'filled', 't0', 'fill', 'fillGap', 'tpd', 'x', 'exit',
             'tpGap', 'tpInFill', 'mae', 'endPx', 'value']
    for name, paths in (('paths-main.csv', W.path_sig), ('paths-opposite.csv', W.path_opp)):
        wcsv(name, pcols, [dict(r, i=s['i']) for s, r in zip(W.sigs, paths)])
    with open(os.path.join(d, 'third.json'), 'w') as f:
        json.dump(dict(main=th), f, default=jsonable)
    for prefix, group in (('', accs), ('unlimited-', unl)):
        for row, a in group.items():
            b = f'acct-{prefix}{row}-'
            wcsv(b + 'fates.csv', ['k', 'fate'], [dict(k=k, fate=f) for k, f in enumerate(a.fate)])
            wcsv(b + 'trades.csv', [c for c, _ in [('sig', 0)] + TRADE_FIELDS], a.trades)
            wcsv(b + 'calls.csv', ['tau', 'deadline', 'D', 'cancelled', 'deposits', 'credits', 'uAfterDeposit', 'end',
                                   'endAt'],
                 [dict(tau=c.tau, deadline=c.deadline, D=c.D, cancelled=c.cancelled, deposits=c.deposits,
                       credits=c.credits, uAfterDeposit=c.uAfter, end=c.end, endAt=c.endAt) for c in a.calls])
            wcsv(b + 'lcs.csv', ['at', 'naBefore', 'naAfter', 'closed', 'cancelled'], a.lcs)
            wcsv(b + 'deposits.csv', ['at', 'amount', 'total', 'why'], a.deposits)
            with open(os.path.join(d, b + 'summary.json'), 'w') as f:
                json.dump(a.summary, f, default=jsonable)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--gmo', required=True)
    ap.add_argument('--dump', required=True)
    ap.add_argument('--also', action='append', default=[])
    ap.add_argument('--out', default=None)
    ap.add_argument('--rates', default='synthetic')
    ap.add_argument('--mine', default=None, help='自分の計算を、dump と同じ形のファイルでこのフォルダに書き出す（調べる用）')
    ap.add_argument('--e-round', choices=['exact', 'mathround'], default='exact',
                    help='E の丸めの確かめ方（既定 exact = チャートの toFixed。mathround は調べる用）')
    ap.add_argument('--expect-real', action='store_true',
                    help='実データの run: meta の startYen・cap・start・split が §8.102 の値（30万円・100万円・2024-01-01・2025-05-19）と同じかも照らす')
    ap.add_argument('--ledger', default=None, help='(b): research/ledger/ultra15.csv（合図をここから自分で作る）')
    ap.add_argument('--end-b', default=None, help='(b): END_b（UTC の ISO。土曜 00:00）')
    ap.add_argument('--a-csv', default='research/ledger/ultra15-a.csv', help='(b): (a) のメールごとの値')
    ap.add_argument('--quiet', action='store_true',
                    help='実データ用: 計算した数（追証・ロスカット・入金の回数、E*、比べた件数、食い違いの例）を出さず、'
                         '食い違いの合計と、食い違いのあった種類の名前だけを出す（§8.102 確かめ B (5)）')
    args = ap.parse_args()
    t0 = time.time()

    def log(m):
        print(f'[{time.time() - t0:7.1f}s] {m}', flush=True)

    # --also の入力（signals.csv・meta.json）が主と同じか
    def inputs_of(d):
        with open(os.path.join(d, 'signals.csv'), newline='') as f:
            sig = [tuple(r) for r in csv.reader(f)]
        return json.load(open(os.path.join(d, 'meta.json'))), sig
    main_in = inputs_of(args.dump)
    for d in args.also:
        if inputs_of(d) != main_in:
            die(f'{d}: signals.csv or meta.json differs from {args.dump}')

    if (args.ledger is None) != (args.end_b is None):
        die('--ledger and --end-b go together')
    end_b = ms_of(args.end_b) if args.end_b else None
    W = World(args.gmo, args.dump, args.rates, log, ledger=args.ledger, end_b=end_b)
    pairs15 = [pr.load15(args.gmo) for pr in W.pairs]
    th = third(W)
    log('third done')
    accs = {}
    for row, cfg in ACCOUNT_ROWS.items():
        t1 = time.time()
        accs[row] = Account(W, cfg['swap'], cfg['worst'], cfg['dep'], False).run()
        if args.quiet:
            log(f'account {row}: {time.time() - t1:.1f}s')
        else:
            log(f'account {row}: {time.time() - t1:.1f}s, calls {len(accs[row].calls)}, lcs {len(accs[row].lcs)}, '
                f'deposits {len(accs[row].deposits)}')
    unl = {}
    for row in UNLIMITED_ROWS:
        cfg = ACCOUNT_ROWS[row]
        t1 = time.time()
        unl[row] = Account(W, cfg['swap'], cfg['worst'], cfg['dep'], True).run()
        e = unl[row].summary['estar']
        log(f'unlimited-{row}: {time.time() - t1:.1f}s' + ('' if args.quiet else f', E* {e}'))
    elapsed = time.time() - t0

    if args.mine:
        write_mine(args.mine, W, th, accs, unl)
        log(f'my own tables written to {args.mine}')

    def compare(dump):
        C = Cmp()
        C.notes = {}
        for msg in W.problems:
            C.bad('load', 'gmo', msg, None, None)
        check_inputs(C, W, pairs15, args.e_round, C.notes)
        check_meta(C, W, args.expect_real)
        if W.mode_b:
            compare_b(C, W, dump, args.a_csv)
        compare_paths(C, W, dump)
        compare_emails(C, W, dump)
        compare_third(C, th, dump)
        for row in ACCOUNT_ROWS:
            compare_account(C, accs[row], dump, row, False)
        for row in UNLIMITED_ROWS:
            compare_account(C, unl[row], dump, 'unlimited-' + row, True)
        return C

    def write(C, outdir, dump):
        kinds = sorted(set(C.compared) | set(C.mism))
        res = dict(ok=sum(C.mism.values()) == 0, dump=os.path.abspath(dump),
                   compared={k: C.compared.get(k, 0) for k in kinds},
                   mismatched={k: C.mism.get(k, 0) for k in kinds},
                   examples={k: v for k, v in C.ex.items() if v},
                   notes=C.notes, seconds=round(elapsed, 1), rates=args.rates)
        os.makedirs(outdir, exist_ok=True)
        with open(os.path.join(outdir, 'pycheck.json'), 'w') as f:
            json.dump(res, f, indent=1, default=jsonable)
        return res

    main_rc = 0
    for n, d in enumerate([args.dump] + args.also):
        C = compare(d)
        res = write(C, (args.out or d) if n == 0 else d, d)
        tot_c, tot_m = sum(res['compared'].values()), sum(res['mismatched'].values())
        if args.quiet:
            names = ', '.join(k for k, v in res['mismatched'].items() if v)
            print(f'{"main" if n == 0 else "also"} dump: mismatched {tot_m}' + (f' (in: {names})' if names else ''))
            if n == 0:
                main_rc = 0 if tot_m == 0 else 1
            continue
        if n == 0:
            print('kind'.ljust(34), 'compared'.rjust(9), 'mismatched'.rjust(10))
            for k in res['compared']:
                print(k.ljust(34), str(res['compared'][k]).rjust(9), str(res['mismatched'][k]).rjust(10))
            for k, ex in res['examples'].items():
                print(f'--- {k}: first {len(ex)} of {res["mismatched"][k]} mismatches')
                for e in ex:
                    print('   ', json.dumps(e, default=jsonable))
            main_rc = 0 if tot_m == 0 else 1
        bad = ', '.join(f'{k} {v}' for k, v in res['mismatched'].items() if v)
        print(f'{d}: compared {tot_c}, mismatched {tot_m}' + (f' ({bad})' if bad else ''))
    log('done')
    sys.exit(main_rc)


if __name__ == '__main__':
    main()
