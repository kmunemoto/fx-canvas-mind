#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""research/macd90m-spec.md の数え直し（Python。標準ライブラリだけ。同じ GMO のファイルから）。

オーナー（2026-11-11）: 「足の確定ではなく、96%に到達した瞬間があればいい」。research/macd90-spec.md の
1時間足の MACD の青い線（600本の窓・120本の枠）を、作りかけの足の中でも1分ごとに読み、96% に届いた最初の分で
reached とする。入り方は2つ:
  close : macd90 の入り（Z(i) が 90%、Zp(i) が違う）。足 i の終値で入り、足 i+1 の最初の分から追う。
  moment: Zp(i) がその側の 90% にない足 i の中で、90% に触れた最初の分。その分の終値で入り、次の分から追う。
追い方（どちらも）: 分が 96% に触れたら reached（その1分足の終値で出る）。足 j の確定では macd90 と同じく、
A は Z(j) が 90% の外、B は線が 0 の線かその向こうで failed（その1時間足の終値で出る）。どちらもなければ open。
C（オーナー、2026-11-12: 「96%に届くまで持ち続ける」）: failed は無く、96% に触れた最初の分で reached、読み込んだ
最後の足までに触れなければ open。持っている間（同じ入り方・通貨・向きで、前に取った入りの出る時 T より前の入り、
または前に取った入りが open）の入りは skipped（取引なし。T0 == T は取る）。already の入りは何も始めず、何も止めない。
分の値段は、上の側は中値の高値 hi = round_chart((bh + ah) / 2)、下の側は中値の安値 lo = round_chart((bl + al) / 2)。

research/macd90.ts・research/macd90m.ts（TypeScript の側）は読まずに、spec と、spec が名前を出す本番のエンジン
（_shared/macd.ts・_shared/pine.ts・_shared/macd-level.ts の zoneAt）と、research/macdlive-check.py の
prep・decide（作りかけの足の 599 番だけを足し直す形。TS と一致済み）から書いた。
足と1分足の読み込みは research/flowz-check.py（load_tf・keys_of・round_chart・M1）、数の書き方・比べ方・
窓の MACD の確かめは research/macd90-check.py（TS と一致済み）を使う。

確かめ（食い違いとして数える）:
  - 足ごとの Z(j)・Zp(j) が macd90-check.py の zones_of と同じ（すべての足）。
  - 分の線（準備した 598 番の状態に x を足したもの）が、x で窓を組み直した zoneAt のそのまま写し（zone_ref）と
    同じ（moment の入りの分・reached の分すべてと、SAMPLE_EVERY 分に1つ）。
  - 入り方ごとに、A の reached なら B も同じ時に reached。数が足し合う。
  - C: 取った C が reached で A（B）も reached なら、T・pips・mae が同じ。C の T は A・B の T より前にならない。
    同じ入り方・通貨・向きの取った C は重ならない。reached + open + skipped + already = entries。

REACH（オーナー、2026-11-12: 「90に到達した瞬間に注文入れたら、95か96に到達する確率？」）: 環境変数 REACH に
0.9 より大きく 1 以下の数（例 0.95）を渡すと、上の「96%」（already・reached・C）がすべてその割合になる。ほかは同じ。
渡さない・空なら spec の 0.96。summary.json の meta.reach が同じ数でなければ食い違い。

touch（オーナー、2026-11-17: 「やっぱり96%をメールの合図にして」「利確10・損切りなし」「両方を測って決める」。
spec の最後の節）: 上の2つとは別の3つ目の入り方。TypeScript の側（research/macd90m.ts）とその差分は読まずに、
spec の文と、このファイルの上の部分（準備した 598 番の状態・分の線・帯）だけから書いた。
  入り: 足 i（確定が [START, END)、600本そろう）の中で、Zp(i) がその側の t（TOUCH）にない側を「開いている」とし、
        開いている側で t に触れた最初の分（上は hi、下は lo で線を作る。両方に触れて両方開いていれば上）。
        足に1つまで。T0 = その分の終わり、share0 = その分の hi（上）・lo（下）での線の割合。
  1つの入りに2つの取引: flow（上 → BUY、下 → SELL）と fade（上 → SELL、下 → BUY）。入りの値段はその1分足の
        終値（BUY は Ask、SELL は Bid）。資金は無限（CLAUDE.md）: 飛ばす入りは無い。
  追い方: 入りの分の次の分から、読み込んだ最後の1分足まで（どの1時間足にも入らない分も）。
        目標は整数の点で BUY P(entry) + 10 TP、SELL P(entry) − 10 TP（P(x) = round(x * 10^d)）。
        tp: BUY は P(bid high) >= 目標、SELL は P(ask low) <= 目標 の最初の分。目標ちょうどで出る（pips = TP）。
        open: そのような分が無い。最後の分の終値（BUY は Bid、SELL は Ask）で値をつける。損切りは無い。
  mae は入りの分の次の分から出る分まで（BUY P(entry) − min P(bid low)、SELL max P(ask high) − P(entry)、
        逆に行かなければ 0）。minutes = (T − T0) / 1分。
  出力は rows-tp.csv と summary-tp.json（rows.csv と summary.json は変えない）。
  TOUCH: 0 より大きく 1 以下の数（無い・空なら 0.96）。TP: 1 以上の整数の pips（無い・空なら 10）。
  確かめ（食い違いとして数える）: 入りの分の線が x で組み直した窓の zoneAt と同じ。入りの足の分ごとの触れ方
  （速い形の印）が、分の線と帯（line_at・in_band）で読み直したものと同じ（入りの足すべてと、TOUCH_SAMPLE 本に
  1つの足）。2つの取引の pair・open・T0・zside・share0 が同じで向きが逆、入りがその分の Ask と Bid の終値。
  tp の pips は TP、open の pips は TP より下。tp + open = trades、flow と fade の trades = entries。

使い方:
  [START=… END=… LOAD_FROM=… REACH=… TOUCH=… TP=…] python3 -I research/macd90m-check.py --cache DIR --out OUT
      DIR: <DIR>/<USD_JPY など>/<1hour|1min>/<bid|ask>/<鍵>.json（GMO の形）
      OUT: research/macd90m.ts の出力（rows.csv・summary.json・rows-tp.csv・summary-tp.json）。読むだけで、
      書かない。touch の2つのファイルが無ければ、そう書いて食い違いとする。
  [START=… END=… LOAD_FROM=… REACH=… TOUCH=… TP=…] python3 -I research/macd90m-check.py --cache DIR --self OUT2
      比べずに、自分の rows.csv・summary.json・rows-tp.csv・summary-tp.json を OUT2 に書く。
  [START=… END=… LOAD_FROM=… TOUCH=… TP=…] python3 -I research/macd90m-check.py --cache DIR --touch-only OUT3
      touch だけを数え、比べずに、自分の rows-tp.csv と summary-tp.json を OUT3 に書く（close・moment は数えない）。
  期間の既定は spec の START 2024-01-01T00:00:00Z、END 2026-11-10T21:00:00Z、LOAD_FROM 2023-10-01T00:00:00Z。
終了コード: 0 = 行と数がすべて一致（最後の行 PYTHON AGREES）、1 = 食い違いあり、または入力の誤り
（最後の行 PYTHON DISAGREES: n differences）。--self・--touch-only は確かめが通れば 0。
"""
import argparse
import bisect
import csv
import importlib.util
import json
import math
import os
import sys
import time
from decimal import ROUND_HALF_UP, Decimal

HERE = os.path.dirname(os.path.abspath(__file__))


def _load(name, file):
    sp = importlib.util.spec_from_file_location(name, os.path.join(HERE, file))
    mod = importlib.util.module_from_spec(sp)
    sp.loader.exec_module(mod)
    return mod


m90 = _load('macd90_check', 'macd90-check.py')
fc = m90.fc

MIN = fc.MIN
HOUR = fc.HOUR
WINDOW = fc.WINDOW               # 600
PAIRS = fc.PAIRS
S_IN = m90.S_IN                  # 0.9
S_GO = m90.S_GO                  # 0.96（spec の数。REACH を渡した時は、下の reach_of でその数にする）
A12, A26, A9 = m90.A12, m90.A26, m90.A9
B12, B26, B9 = m90.B12, m90.B26, m90.B9
REL = m90.REL
INF = m90.INF
MAX_DIFF_LINES = m90.MAX_DIFF_LINES
SAMPLE_EVERY = 4999              # 分の線を組み直した窓で確かめる（この数に1つと、入り・reached の分すべて）
DEFAULTS = m90.DEFAULTS
WAYS_IN = ('close', 'moment')    # 同じ入りの時・同じ通貨は close が先
WAYS = ('A', 'B')
WAY_COLS = ['result', 'T', 'exit', 'pips', 'mae', 'minutes', 'share']
COLS = ['way', 'pair', 'open', 'T0', 'side', 'entry', 'share0', 'already'] + \
       [w + '_' + c for w in WAYS for c in WAY_COLS]
C_COLS = ['C_' + c for c in WAY_COLS]                # way C（96% に届くまで持つ）: B_share の後ろの7つの欄
COLS = COLS + C_COLS
SHARE_COLS = {'share0', 'A_share', 'B_share', 'C_share'}
W_KEYS = ['reached', 'failed', 'open', 'rate', 'pipsSum', 'pipsMean', 'pipsMedian', 'reachedPipsMean',
          'failedPipsMean', 'maeMedian', 'maeMax', 'minutesMedian', 'minutesMax', 'openPipsSum', 'openPipsWorst']
W_NEAR = {'rate', 'pipsMean', 'pipsMedian', 'reachedPipsMean', 'failedPipsMean', 'maeMedian', 'minutesMedian'}
C_KEYS = ['reached', 'open', 'skipped', 'plus', 'minus', 'pipsSum', 'pipsMean', 'pipsMedian', 'pipsMin',
          'maeMedian', 'maeP90', 'maeMax', 'minutesMedian', 'minutesP90', 'minutesMax', 'within60', 'within1440',
          'within10080', 'openPipsSum', 'openPipsWorst', 'openMaeMax', 'openMinutesMax']
C_NEAR = {'pipsMean', 'pipsMedian', 'maeMedian', 'minutesMedian'}     # ほか（数え方・和・最小・最大・P90）は同じ数
C_WITHIN = (60, 1440, 10080)
G_KEYS = ['entries', 'already']
GROUPS = ['all'] + PAIRS + ['BUY', 'SELL']
PAIR_KEYS = ['bars', 'minutes', 'close', 'moment']
T90, T96, B90, B96 = 1, 2, 4, 8  # 分の触れ方（上の 90%・96%、下の 90%・96%）
TT, BT = 16, 32                  # touch: 上・下で TOUCH の割合に触れる
# ---- touch（spec の最後の節）の出力の形
TP_DIRS = ('flow', 'fade')       # 同じ入りの2つの取引は flow が先
TP_COLS = ['dir', 'pair', 'open', 'T0', 'zside', 'side', 'entry', 'share0', 'target', 'result', 'T', 'exit', 'pips',
           'mae', 'minutes']
TP_SHARE_COLS = {'share0'}       # 割合は既存の share の比べ方（1e-9 まで）。値段・pips ほかは文字がそのまま同じ
TG_KEYS = ['trades', 'tp', 'open', 'pipsSum', 'pipsMean', 'pipsMedian', 'tpMinutesMedian', 'tpMinutesP90',
           'tpMinutesMax', 'within60', 'within1440', 'within10080', 'maeMedian', 'maeP90', 'maeMax', 'tpMaeMax',
           'openPipsSum', 'openPipsWorst', 'openMaeMax', 'openMinutesMax']
TG_NEAR = {'pipsMean', 'pipsMedian', 'tpMinutesMedian', 'maeMedian'}   # C_NEAR と同じく平均と中央値だけ
TP_GROUPS = ['all'] + PAIRS + ['BUY', 'SELL', 'top', 'bottom']
TP_PAIR_KEYS = ['entries']
TOUCH_SAMPLE = 97                # 入りの足のほか、この数に1つの足でも、分ごとの触れ方を線と帯で読み直す

js_str, js_div, cell, in_band, die = m90.js_str, m90.js_div, m90.cell, m90.in_band, m90.die


def reach_of():
    """届いたとみる割合: 環境変数 REACH（無い・空なら spec の 0.96）。0.9 より大きく 1 以下の数でなければ止まる。"""
    v = os.environ.get('REACH') or ''
    if v == '':
        return m90.S_GO
    try:
        x = float(v)
    except ValueError:
        x = float('nan')
    if not (S_IN < x <= 1):
        die(f'REACH {v!r}: a share above {S_IN!r} and at most 1')
    return x


S_GO = reach_of()


def touch_of():
    """touch の割合 t: 環境変数 TOUCH（無い・空なら spec の 0.96）。0 より大きく 1 以下の数でなければ止まる。"""
    v = os.environ.get('TOUCH') or ''
    if v == '':
        return m90.S_GO
    try:
        x = float(v)
    except ValueError:
        x = float('nan')
    if not (0 < x <= 1):
        die(f'TOUCH {v!r}: a share above 0 and at most 1')
    return x


def tp_of():
    """利確の pips: 環境変数 TP（無い・空なら spec の 10）。1 以上の整数でなければ止まる。"""
    v = os.environ.get('TP') or ''
    if v == '':
        return 10
    try:
        x = float(v)
    except ValueError:
        x = float('nan')
    if not (math.isfinite(x) and x.is_integer() and x >= 1):
        die(f'TP {v!r}: a whole number of pips, at least 1')
    return int(x)


TOUCH = touch_of()
TP = tp_of()


# ---------------------------------------------------------------- 窓の 598 番までの状態（足ごとに1回）
def prep_all(c, lo, n):
    """足 i = lo..n-1 ごとに、足 i の窓（c[i-599..i]）の 598 番の ema12・ema26・シグナルと、599 番の枠に入る
    480..598 番の線・シグナル・ヒストと 0 の最大（pt）・最小（pb）、それと Zp(i)（598 番の m・top・bottom）。
    足し算・掛け算の順は macd90-check.py zones_of（pine.ts pineSmoothed）と同じ。"""
    F, SL, G, PT, PB, M8, T8, B8 = ([None] * n for _ in range(8))
    a12, b12, a26, b26, a9, b9 = A12, B12, A26, B26, A9, B9
    for i in range(lo, n):
        w = c[i - WINDOW + 1:i + 1]
        s = 0.0
        for x in w[:12]:
            s += x
        f = s / 12
        for x in w[12:26]:
            f = a12 * x + b12 * f
        s = 0.0
        for x in w[:26]:
            s += x
        sl = s / 26
        ls = [f - sl]
        for x in w[26:34]:
            f = a12 * x + b12 * f
            sl = a26 * x + b26 * sl
            ls.append(f - sl)
        s = 0.0
        for v in ls:
            s += v
        g = s / 9
        for x in w[34:479]:
            f = a12 * x + b12 * f
            sl = a26 * x + b26 * sl
            g = a9 * (f - sl) + b9 * g
        L = []
        S = []
        for x in w[479:599]:                     # 479..598 番
            f = a12 * x + b12 * f
            sl = a26 * x + b26 * sl
            m = f - sl
            g = a9 * m + b9 * g
            L.append(m)
            S.append(g)
        H = [p - q for p, q in zip(L, S)]
        tm = max(max(L[1:]), max(S[1:]), max(H[1:]))      # 480..598 番
        bm = min(min(L[1:]), min(S[1:]), min(H[1:]))
        F[i], SL[i], G[i] = f, sl, g
        PT[i] = tm if tm > 0.0 else 0.0
        PB[i] = bm if bm < 0.0 else 0.0
        t = max(tm, L[0], S[0], H[0])                      # 598 番の枠（479..598）
        b = min(bm, L[0], S[0], H[0])
        M8[i] = L[119]
        T8[i] = t if t > 0.0 else 0.0
        B8[i] = b if b < 0.0 else 0.0
    return F, SL, G, PT, PB, M8, T8, B8


def line_at(f0, s0, g0, pt, pb, x):
    """599 番の値段を x としたときの (m, top, bottom)（spec の式、macdlive-check.py decide と同じ順）"""
    f = A12 * x + B12 * f0
    s = A26 * x + B26 * s0
    m = f - s
    g = A9 * m + B9 * g0
    h = m - g
    top = pt
    if m > top:
        top = m
    if g > top:
        top = g
    if h > top:
        top = h
    bot = pb
    if m < bot:
        bot = m
    if g < bot:
        bot = g
    if h < bot:
        bot = h
    return m, top, bot


def share_of(sd, z):
    m, top, bot = z
    return js_div(m, top if sd > 0 else bot)


# ---------------------------------------------------------------- 1つの通貨
def compute_pair(cache, pi, pair, start, end, load_from, ld, chk, log, old=True):
    """old = False（--touch-only）: close・moment の行は作らない（touch だけ）"""
    t_pair = time.time()
    sym = pair.replace('/', '_')
    dec = 5 if pair.endswith('/USD') else 3
    scale = 10.0 ** dec
    quant = Decimal(1).scaleb(-dec)
    bars = fc.load_tf(cache, sym, '1hour', HOUR, fc.keys_of(load_from, end), load_from, end, ld)
    n = len(bars)
    t = [x[0] for x in bars]
    c = [fc.round_chart((x[1][4] + x[2][4]) / 2, dec) for x in bars]
    hbc = [x[1][4] for x in bars]
    hac = [x[2][4] for x in bars]
    del bars
    m1 = fc.M1(pair, cache, start, end, ld)          # 1分足（START から END まで、loadM1）
    mt, mbl, mbc, mah, mac = m1.t, m1.bl, m1.bc, m1.ah, m1.ac
    mbh, mal = m1.bh, m1.al
    nm = m1.n
    del m1

    def P(x):
        return fc.js_round(x * scale)

    lo = WINDOW - 1
    F, SL, G, PT, PB, M8, T8, B8 = prep_all(c, lo, n) if n > lo else ([None] * n,) * 8
    Z = [None] * n                                   # Z(j) = 599 番に足 j の終値
    for j in range(lo, n):
        Z[j] = line_at(F[j], SL[j], G[j], PT[j], PB[j], c[j])
    # macd90-check.py の zones_of と、すべての足で同じか
    if n > lo:
        z9 = m90.zones_of(c, lo, n)
        for j in range(lo, n):
            if Z[j] != (z9[0][j], z9[1][j], z9[2][j]) or (M8[j], T8[j], B8[j]) != (z9[3][j], z9[4][j], z9[5][j]):
                chk['mismatch'].append(f'{pair} bar {fc.iso(t[j])}: Z/Zp here {Z[j]!r} {(M8[j], T8[j], B8[j])!r} / '
                                       f'macd90 zones_of {tuple(z[j] for z in z9)!r}')
        del z9
    t_zone = time.time() - t_pair

    # 1分足を足に: 足 j の分は ms[j] .. me[j]-1（t[j] <= u < t[j] + 1時間）
    ms = [bisect.bisect_left(mt, x) for x in t]
    me = [bisect.bisect_left(mt, x + HOUR) for x in t]
    in_bars = sum(me[j] - ms[j] for j in range(n))
    orphan = nm - in_bars                            # どの足にも入らない分（読まない）

    # 分ごとの触れ方（上は hi、下は lo で線を作る）。足 j >= 599 の分だけ。
    cache_r = {}

    def rc(v):
        r = cache_r.get(v)
        if r is None:
            r = float(Decimal(v).quantize(quant, ROUND_HALF_UP))
            cache_r[v] = r
        return r
    flags = bytearray(nm)
    mbar = [-1] * nm                                 # 分の足（触れ方を読んだ分だけ）
    a12, b12, a26, b26, a9, b9 = A12, B12, A26, B26, A9, B9
    for j in range(lo, n):
        a, b = ms[j], me[j]
        if a == b:
            continue
        f0, s0, g0, pt, pb = F[j], SL[j], G[j], PT[j], PB[j]
        for k in range(a, b):
            mbar[k] = j
            fl = 0
            x = rc((mbh[k] + mah[k]) / 2)            # hi: 上の側
            m = (a12 * x + b12 * f0) - (a26 * x + b26 * s0)
            g = a9 * m + b9 * g0
            h = m - g
            top = pt
            if m > top:
                top = m
            if g > top:
                top = g
            if h > top:
                top = h
            if top > 0:
                if m >= S_IN * top:
                    fl = T90
                if m >= S_GO * top:
                    fl |= T96
                if m >= TOUCH * top:                 # touch（in_band(1, TOUCH, …) と同じ式）
                    fl |= TT
            x = rc((mbl[k] + mal[k]) / 2)            # lo: 下の側
            m = (a12 * x + b12 * f0) - (a26 * x + b26 * s0)
            g = a9 * m + b9 * g0
            h = m - g
            bot = pb
            if m < bot:
                bot = m
            if g < bot:
                bot = g
            if h < bot:
                bot = h
            if bot < 0:
                if m <= S_IN * bot:
                    fl |= B90
                if m <= S_GO * bot:
                    fl |= B96
                if m <= TOUCH * bot:                 # touch（in_band(-1, TOUCH, …) と同じ式）
                    fl |= BT
            flags[k] = fl
    t_min = time.time() - t_pair - t_zone
    go96 = {1: [k for k in range(nm) if flags[k] & T96], -1: [k for k in range(nm) if flags[k] & B96]}

    def minute_line(sd, k):
        j = mbar[k]
        x = rc((mbh[k] + mah[k]) / 2) if sd > 0 else rc((mbl[k] + mal[k]) / 2)
        return j, x, line_at(F[j], SL[j], G[j], PT[j], PB[j], x)

    checked = set()

    def check_minute(sd, k):
        """分の線を、x で組み直した窓の zoneAt のそのまま写しと比べる"""
        if (sd, k) in checked:
            return
        checked.add((sd, k))
        j, x, z = minute_line(sd, k)
        w = c[j - WINDOW + 1:j] + [x]
        ref = m90.zone_ref(w, WINDOW - 1)
        chk['minutesChecked'] += 1
        if ref != z:
            chk['mismatch'].append(f'{pair} minute {fc.iso(mt[k])} ({"hi" if sd > 0 else "lo"} {x!r}): prepared {z!r} / '
                                   f'window rebuilt {ref!r}')

    def follow(sd, jb, k_start):
        """足 jb の分 k_start から（同じ足のその前の分は読まない）、分の 96% の触れ方と、足の確定の failed を時の順に。
        返すのは {A: ev, B: ev}。ev = (result, 'min', k) か (result, 'bar', j)。"""
        need = T96 if sd > 0 else B96
        res = {'A': None, 'B': None}
        j = jb
        while j < n:
            a = max(k_start, ms[j]) if j == jb else ms[j]
            for k in range(a, me[j]):
                if flags[k] & need:
                    ev = ('reached', 'min', k)
                    for w in WAYS:
                        if res[w] is None:
                            res[w] = ev
                    return res
            m = Z[j][0]
            if res['A'] is None and not in_band(sd, S_IN, *Z[j]):
                res['A'] = ('failed', 'bar', j)
            if res['B'] is None and (m <= 0 if sd > 0 else m >= 0):
                res['B'] = ('failed', 'bar', j)
            if res['A'] is not None and res['B'] is not None:
                return res
            j += 1
        for w in WAYS:
            if res[w] is None:
                res[w] = ('open', 'bar', n - 1)
        return res

    def fill(r, sd, res, T0, pe, k_lo):
        """1つの入りの、res にある道（A・B、または C）の欄。mae は分 k_lo から出る分まで（足の確定で出るときは、
        その足の確定より前の最後の分）。"""
        for w in res:
            kind, what, idx = res[w]
            if what == 'min':
                k = idx
                Tx = mt[k] + MIN
                px = mbc[k] if sd > 0 else mac[k]
                k_hi = k
                share = share_of(sd, minute_line(sd, k)[2])
                check_minute(sd, k)
            else:
                j = idx
                Tx = t[j] + HOUR
                px = hbc[j] if sd > 0 else hac[j]
                k_hi = me[j] - 1
                share = share_of(sd, Z[j])
            if sd > 0:
                pips = (P(px) - pe) / 10
                against = pe - P(min(mbl[k_lo:k_hi + 1])) if k_hi >= k_lo else 0
            else:
                pips = (pe - P(px)) / 10
                against = P(max(mah[k_lo:k_hi + 1])) - pe if k_hi >= k_lo else 0
            d = Tx - T0
            r[w + '_result'] = kind
            r[w + '_T'] = fc.iso(Tx)
            r[w + '_exit'] = px
            r[w + '_pips'] = pips
            r[w + '_mae'] = against / 10 if against > 0 else 0
            r[w + '_minutes'] = d // MIN if d % MIN == 0 else d / MIN
            r[w + '_share'] = share
            r['_' + w + '_Tms'] = Tx

    held = {}                                        # (入り方, 向き) → 最後に取った C の出る時（open は INF）

    def trade(r, sd, jb, k_start, T0, entry):
        """already でない入り1つ: A・B を追い、C は持っていなければ取る（k_start から最初の 96% の分。無ければ open）"""
        pe = P(entry)
        res = follow(sd, jb, k_start)
        fill(r, sd, res, T0, pe, k_start)
        if res['A'][0] == 'reached' and (res['B'][0] != 'reached' or r['A_T'] != r['B_T']):
            chk['aNotB'].append(f'{pair} {r["way"]} {r["open"]}')
        key = (r['way'], sd)
        last = held.get(key)
        if last is not None and T0 < last:           # 持っている間（open は INF）: 取らない
            r['C_result'] = 'skipped'
            return
        q = bisect.bisect_left(go96[sd], k_start)
        ev = ('reached', 'min', go96[sd][q]) if q < len(go96[sd]) else ('open', 'bar', n - 1)
        fill(r, sd, {'C': ev}, T0, pe, k_start)
        held[key] = r['_C_Tms'] if ev[0] == 'reached' else INF
        where = f'{pair} {r["way"]} {r["open"]}'
        for w in WAYS:
            if r['_C_Tms'] < r['_' + w + '_Tms']:
                chk['cBefore'].append(f'{where}: C out before {w}')
            if r[w + '_result'] == 'reached' and not (
                    ev[0] == 'reached' and all(r['C_' + col] == r[w + '_' + col] for col in WAY_COLS)):
                chk['cNotSame'].append(f'{where}: {w} reached, C not the same trade')

    def row(way, i, T0, sd, entry, share0, already):
        r = dict(way=way, wi=WAYS_IN.index(way), pair=pair, pi=pi, _T0=T0, open=fc.iso(t[i]), T0=fc.iso(T0),
                 side='BUY' if sd > 0 else 'SELL', entry=entry, share0=share0, already=1 if already else 0)
        for w in WAYS + ('C',):
            for col in WAY_COLS:
                r[w + '_' + col] = None
        return r

    rows = []
    short = 0
    n_close = n_moment = 0
    for i in range(n if old else 0):
        T = t[i] + HOUR
        if T < start or T >= end:
            continue
        if i < lo:
            short += 1
            continue
        zp = (M8[i], T8[i], B8[i])
        # close（macd90 の入り）
        up = in_band(1, S_IN, *Z[i]) and not in_band(1, S_IN, *zp)
        dn = in_band(-1, S_IN, *Z[i]) and not in_band(-1, S_IN, *zp)
        if up and dn:
            chk['both'].append(f'{pair} close {fc.iso(t[i])}')
        if up or dn:
            sd = 1 if up else -1
            entry = hac[i] if sd > 0 else hbc[i]
            already = in_band(sd, S_GO, *Z[i])
            r = row('close', i, T, sd, entry, share_of(sd, Z[i]), already)
            if not already:
                trade(r, sd, i + 1, ms[i + 1] if i + 1 < n else nm, T, entry)
            rows.append(r)
            n_close += 1
        # moment: Zp(i) がその側の 90% にない足の、90% に触れた最初の分（両方に触れる分は上の側で読む）
        ok_up = not in_band(1, S_IN, *zp)
        ok_dn = not in_band(-1, S_IN, *zp)
        for k in range(ms[i], me[i]):
            fl = flags[k]
            if ok_up and fl & T90:
                sd = 1
            elif ok_dn and fl & B90:
                sd = -1
            else:
                continue
            if fl & T90 and fl & B90:
                chk['bothMinute'].append(f'{pair} minute {fc.iso(mt[k])}')
            check_minute(sd, k)
            T0 = mt[k] + MIN
            entry = mac[k] if sd > 0 else mbc[k]
            already = bool(fl & (T96 if sd > 0 else B96))
            r = row('moment', i, T0, sd, entry, share_of(sd, minute_line(sd, k)[2]), already)
            if not already:
                trade(r, sd, i, k + 1, T0, entry)
            rows.append(r)
            n_moment += 1
            break

    # 分の線の確かめ（ほかの分の一部）
    for k in range(0, nm, SAMPLE_EVERY):
        if mbar[k] >= 0:
            check_minute(1, k)
            check_minute(-1, k)

    t_old = time.time()
    trows, n_touch, t_short = touch_pair(pi, pair, start, end, dict(
        n=n, lo=lo, t=t, ms=ms, me=me, flags=flags, M8=M8, T8=T8, B8=B8, mt=mt, nm=nm, mbh=mbh, mbl=mbl, mbc=mbc,
        mah=mah, mal=mal, mac=mac, P=P, scale=scale, minute_line=minute_line, c=c), chk)
    t_touch = time.time() - t_old

    if old:
        log(f'  {pair}: bars {n}, 1-min bars {nm} (in no bar, not read: {orphan}), entries close {n_close} '
            f'(already {sum(r["already"] for r in rows if r["way"] == "close")}), moment {n_moment} '
            f'(already {sum(r["already"] for r in rows if r["way"] == "moment")}), short of 600 in [START, END) {short}; '
            f'zones {t_zone:.1f}s, minutes {t_min:.1f}s, all {time.time() - t_pair:.1f}s')
    log(f'  {pair} touch {TOUCH!r}, tp {TP}: entries {n_touch} (top {sum(1 for r in trows if r["dir"] == "flow" and r["zside"] == "top")}, '
        f'bottom {sum(1 for r in trows if r["dir"] == "flow" and r["zside"] == "bottom")}), '
        + ', '.join(f'{d} tp {sum(1 for r in trows if r["dir"] == d and r["result"] == "tp")} / open '
                    f'{sum(1 for r in trows if r["dir"] == d and r["result"] == "open")}' for d in TP_DIRS) +
        f'; short of 600 in [START, END) {t_short}; touch {t_touch:.1f}s')
    chk['orphan'] += orphan
    return rows, dict(pair=pair, bars=n, minutes=nm, close=n_close, moment=n_moment), trows, dict(pair=pair, entries=n_touch)


# ---------------------------------------------------------------- touch（spec の最後の節）: 1つの通貨
def touch_pair(pi, pair, start, end, d, chk):
    """d は compute_pair の足・1分足・分の触れ方（flags の TT・BT）・598 番の状態。返すのは (行, 入りの数, 600本に
    足りない足の数)。行は1つの入りに flow と fade の2つ。"""
    n, lo, t, ms, me, flags = d['n'], d['lo'], d['t'], d['ms'], d['me'], d['flags']
    M8, T8, B8 = d['M8'], d['T8'], d['B8']
    mt, nm, mbh, mbl, mbc, mah, mal, mac = d['mt'], d['nm'], d['mbh'], d['mbl'], d['mbc'], d['mah'], d['mal'], d['mac']
    P, scale, minute_line, c = d['P'], d['scale'], d['minute_line'], d['c']
    # 整数の点（P は単調なので、min P(bid low) = P(min bid low)）。塊ごとの最小・最大で引く（flowz-check.py Seek）
    s_tp_buy = fc.Seek([P(x) for x in mbh], False)   # BUY の利確: 最初の P(bid high) >= 目標
    s_tp_sell = fc.Seek([P(x) for x in mal], True)   # SELL の利確: 最初の P(ask low) <= 目標
    s_mae_buy = fc.Seek([P(x) for x in mbl], True)   # BUY の mae: P(bid low) の最小
    s_mae_sell = fc.Seek([P(x) for x in mah], False)  # SELL の mae: P(ask high) の最大
    checked = set()

    def check_line(sd, k):
        """入りの分の線を、x で組み直した窓の zoneAt のそのまま写し（macd90-check.py zone_ref）と比べる"""
        if (sd, k) in checked:
            return
        checked.add((sd, k))
        j, x, z = minute_line(sd, k)
        ref = m90.zone_ref(c[j - WINDOW + 1:j] + [x], WINDOW - 1)
        chk['tLines'] += 1
        if ref != z:
            chk['tMismatch'].append(f'{pair} minute {fc.iso(mt[k])} ({"hi" if sd > 0 else "lo"} {x!r}): prepared '
                                    f'{z!r} / window rebuilt {ref!r}')

    def trade(dname, di, i, k, zs, ts, T0, share0):
        """1つの取引（ts = 1 は BUY、-1 は SELL）。入りの分 k の次の分から、読み込んだ最後の分まで。"""
        buy = ts > 0
        entry = mac[k] if buy else mbc[k]
        pe = P(entry)
        target = pe + 10 * TP if buy else pe - 10 * TP
        kx = (s_tp_buy if buy else s_tp_sell).first(k + 1, target)
        if kx >= 0:
            result, ko, px, pips = 'tp', kx, target / scale, TP
        else:
            ko = nm - 1                              # 最後の分（入りの分が最後なら、その分）
            result = 'open'
            if buy:
                px = mbc[ko]
                pips = (P(px) - pe) / 10
            else:
                px = mac[ko]
                pips = (pe - P(px)) / 10
        if ko > k:
            against = pe - s_mae_buy.ext(k + 1, ko) if buy else s_mae_sell.ext(k + 1, ko) - pe
        else:
            against = 0
        Tx = mt[ko] + MIN
        dt = Tx - T0
        return dict(dir=dname, di=di, pair=pair, pi=pi, _T0=T0, _k=k, _ko=ko, open=fc.iso(t[i]), T0=fc.iso(T0),
                    zside='top' if zs > 0 else 'bottom', side='BUY' if buy else 'SELL', entry=entry, share0=share0,
                    target=target / scale, result=result, T=fc.iso(Tx), exit=px, pips=pips,
                    mae=against / 10 if against > 0 else 0, minutes=dt // MIN if dt % MIN == 0 else dt / MIN)

    rows = []
    n_entries = short = 0
    for i in range(n):
        T = t[i] + HOUR
        if T < start or T >= end:
            continue
        if i < lo:
            short += 1
            continue
        zp = (M8[i], T8[i], B8[i])
        op_up = not in_band(1, TOUCH, *zp)           # 開いている側: Zp(i) がその側の t にない
        op_dn = not in_band(-1, TOUCH, *zp)
        ke, sd = -1, 0
        for k in range(ms[i], me[i]):
            fl = flags[k]
            if op_up and fl & TT:
                ke, sd = k, 1
            elif op_dn and fl & BT:
                ke, sd = k, -1
            else:
                continue
            if fl & TT and fl & BT and op_up and op_dn:
                chk['tBoth'].append(f'{pair} minute {fc.iso(mt[k])}')
            break
        # 速い形の印を、分の線（line_at）と帯（in_band）で読み直す: 入りの足は入りの分まで、ほかは一部の足の全部
        if ke >= 0 or i % TOUCH_SAMPLE == 0:
            for k in range(ms[i], (ke if ke >= 0 else me[i] - 1) + 1):
                up = op_up and in_band(1, TOUCH, *minute_line(1, k)[2])
                dn = op_dn and in_band(-1, TOUCH, *minute_line(-1, k)[2])
                chk['tFlagMinutes'] += 1
                ok = (up if sd > 0 else (dn and not up)) if k == ke else not (up or dn)
                if not ok:
                    chk['tFlag'].append(f'{pair} minute {fc.iso(mt[k])}: the fast mark reads '
                                        f'{"entry " + ("top" if sd > 0 else "bottom") if k == ke else "no entry"}, '
                                        f'the line and band read top {up}, bottom {dn}')
        if ke < 0:
            continue
        k = ke
        check_line(sd, k)
        T0 = mt[k] + MIN
        share0 = share_of(sd, minute_line(sd, k)[2])
        n_entries += 1
        pr = [trade(dname, di, i, k, sd, sd if dname == 'flow' else -sd, T0, share0) for di, dname in enumerate(TP_DIRS)]
        for r in pr:                                 # 入りはその分の Ask（BUY）・Bid（SELL）の終値
            if r['entry'] != (mac[k] if r['side'] == 'BUY' else mbc[k]):
                chk['tEntry'].append(f'{pair} {r["dir"]} {r["open"]}: entry {r["entry"]!r} is not the minute\'s close')
        rows.extend(pr)
    return rows, n_entries, short


def touch_rows_bad(rows):
    """行だけから: 1つの入りの2つの取引（flow が先）が、pair・open・T0・zside・share0 が同じで向きが逆、flow の向きが
    上 → BUY・下 → SELL、BUY の入り >= SELL の入り。tp は pips = TP・exit = target、open は pips < TP。
    T は T0 より前にならない。行の順は T0、通貨の順、flow・fade。"""
    bad = []
    if len(rows) % 2:
        bad.append(f'{len(rows)} touch rows: an odd number (each entry has two)')
    for q in range(0, len(rows) - 1, 2):
        a, b = rows[q], rows[q + 1]
        where = f'{a["pair"]} {a["open"]}'
        if (a['dir'], b['dir']) != TP_DIRS:
            bad.append(f'{where}: the two rows are {a["dir"]}, {b["dir"]}')
        for col in ('pair', 'open', 'T0', 'zside', 'share0'):
            if a[col] != b[col] and not (col == 'share0' and a[col] != a[col] and b[col] != b[col]):
                bad.append(f'{where}: flow and fade differ in {col}')
        if {a['side'], b['side']} != {'BUY', 'SELL'}:
            bad.append(f'{where}: sides {a["side"]}, {b["side"]}')
        if a['side'] != ('BUY' if a['zside'] == 'top' else 'SELL'):
            bad.append(f'{where}: flow is {a["side"]} on the {a["zside"]} side')
        buy, sell = (a, b) if a['side'] == 'BUY' else (b, a)
        if buy['entry'] < sell['entry']:
            bad.append(f'{where}: the BUY entry {buy["entry"]!r} below the SELL entry {sell["entry"]!r}')
    for r in rows:
        where = f'{r["pair"]} {r["dir"]} {r["open"]}'
        if r['result'] == 'tp':
            if r['pips'] != TP or r['exit'] != r['target']:
                bad.append(f'{where}: tp with pips {r["pips"]!r}, exit {r["exit"]!r}, target {r["target"]!r}')
        elif r['result'] == 'open':
            if not r['pips'] < TP:
                bad.append(f'{where}: open with pips {r["pips"]!r}, not below TP')
        else:
            bad.append(f'{where}: result {r["result"]!r}')
        if r['minutes'] < 0 or r['mae'] < 0:
            bad.append(f'{where}: minutes {r["minutes"]!r}, mae {r["mae"]!r}')
    keys = [(r['_T0'], r['pi'], r['di']) for r in rows]
    if keys != sorted(keys) or len(set(keys)) != len(keys):
        bad.append('touch rows: not in the order T0, pair, flow / fade (or a repeated key)')
    return bad


def compute(cache, start, end, load_from, log, old=True):
    ld = fc.LoadStats()
    chk = dict(minutesChecked=0, orphan=0, mismatch=[], both=[], bothMinute=[], aNotB=[], cOverlap=[], cBefore=[],
               cNotSame=[], tLines=0, tFlagMinutes=0, tMismatch=[], tFlag=[], tEntry=[], tBoth=[], tRows=[])
    rows, pairs, trows, tpairs = [], [], [], []
    for pi, pair in enumerate(PAIRS):
        r, info, tr, tinfo = compute_pair(cache, pi, pair, start, end, load_from, ld, chk, log, old)
        rows.extend(r)
        pairs.append(info)
        trows.extend(tr)
        tpairs.append(tinfo)
    rows.sort(key=lambda r: (r['_T0'], r['pi'], r['wi']))
    chk['cOverlap'] = c_overlaps(rows)
    trows.sort(key=lambda r: (r['_T0'], r['pi'], r['di']))
    chk['tRows'] = touch_rows_bad(trows)
    return rows, pairs, ld, chk, trows, tpairs


def c_overlaps(rows):
    """取った C（reached・open）を、入り方・通貨・向きごとに入りの時の順に見て、前の取引の出る時より前に始まるもの、
    open の後に始まるもの、取るはずなのに skipped のもの（前に取った取引が無い・もう出ている）を並べる。
    行だけから数え直す（skip を決めた状態は使わない）。"""
    bad = []
    last = {}                                        # (入り方, 通貨, 向き) → (出る時, open か)
    for r in rows:                                   # 行は入りの時の順
        if r['already']:
            if r['C_result'] is not None:
                bad.append(f'{r["pair"]} {r["way"]} {r["open"]}: an already row with a C result')
            continue
        key = (r['way'], r['pair'], r['side'])
        prev = last.get(key)
        holding = prev is not None and (prev[1] or r['_T0'] < prev[0])
        where = f'{r["pair"]} {r["way"]} {r["open"]} {r["side"]}'
        if r['C_result'] == 'skipped':
            if not holding:
                bad.append(f'{where}: skipped, but no trade of its way in, pair and side is held at T0')
            if any(r['C_' + col] is not None for col in WAY_COLS[1:]):
                bad.append(f'{where}: skipped, but C cells are filled')
            continue
        if r['C_result'] not in ('reached', 'open'):
            bad.append(f'{where}: C result {r["C_result"]!r}')
            continue
        if holding:
            bad.append(f'{where}: taken while the trade before it is held')
        last[key] = (r['_C_Tms'], r['C_result'] == 'open')
    return bad


# ---------------------------------------------------------------- 数
def way_stats(rows, w):
    done = [r for r in rows if not r['already'] and r[w + '_result'] in ('reached', 'failed')]
    op = [r for r in rows if not r['already'] and r[w + '_result'] == 'open']
    rc = [r for r in done if r[w + '_result'] == 'reached']
    fl = [r for r in done if r[w + '_result'] == 'failed']
    pips = [r[w + '_pips'] for r in done]
    maes = [r[w + '_mae'] for r in done]
    mins = [r[w + '_minutes'] for r in done]
    ops = [r[w + '_pips'] for r in op]
    nd = len(done)
    s = fc.add_in_order(pips)
    return dict(reached=len(rc), failed=len(fl), open=len(op),
                rate=100 * len(rc) / nd if nd else None,
                pipsSum=s if nd else None, pipsMean=s / nd if nd else None, pipsMedian=fc.median(pips),
                reachedPipsMean=fc.mean_in_order([r[w + '_pips'] for r in rc]),
                failedPipsMean=fc.mean_in_order([r[w + '_pips'] for r in fl]),
                maeMedian=fc.median(maes), maeMax=max(maes) if maes else None,
                minutesMedian=fc.median(mins), minutesMax=max(mins) if mins else None,
                openPipsSum=fc.add_in_order(ops) if ops else None, openPipsWorst=min(ops) if ops else None)


def p90(xs):
    """n 個の値の P90: 小さい順の (9n + 9) // 10 番目（1 から数える。0.9 n の切り上げ）。無ければ None"""
    if not xs:
        return None
    return sorted(xs)[(9 * len(xs) + 9) // 10 - 1]


def c_stats(rows):
    """way C の数（行の順）。reached の行・open の行それぞれの数。値が無ければ None（和も）。"""
    rc = [r for r in rows if r['C_result'] == 'reached']
    op = [r for r in rows if r['C_result'] == 'open']
    pips = [r['C_pips'] for r in rc]
    maes = [r['C_mae'] for r in rc]
    mins = [r['C_minutes'] for r in rc]
    ops = [r['C_pips'] for r in op]
    n = len(rc)
    s = fc.add_in_order(pips)
    out = dict(reached=n, open=len(op), skipped=sum(1 for r in rows if r['C_result'] == 'skipped'),
               plus=sum(1 for v in pips if v > 0), minus=sum(1 for v in pips if v < 0),
               pipsSum=s if n else None, pipsMean=s / n if n else None, pipsMedian=fc.median(pips),
               pipsMin=min(pips) if n else None,
               maeMedian=fc.median(maes), maeP90=p90(maes), maeMax=max(maes) if n else None,
               minutesMedian=fc.median(mins), minutesP90=p90(mins), minutesMax=max(mins) if n else None)
    for lim in C_WITHIN:
        out[f'within{lim}'] = sum(1 for v in mins if v <= lim)
    out.update(openPipsSum=fc.add_in_order(ops) if ops else None, openPipsWorst=min(ops) if ops else None,
               openMaeMax=max(r['C_mae'] for r in op) if op else None,
               openMinutesMax=max(r['C_minutes'] for r in op) if op else None)
    return {k: out[k] for k in C_KEYS}


def group(rows):
    return dict(entries=len(rows), already=sum(r['already'] for r in rows), A=way_stats(rows, 'A'),
                B=way_stats(rows, 'B'), C=c_stats(rows))


def groups_of(rows):
    g = {'all': group(rows)}
    for p in PAIRS:
        g[p] = group([r for r in rows if r['pair'] == p])
    for sd in ('BUY', 'SELL'):
        g[sd] = group([r for r in rows if r['side'] == sd])
    return g


def summary_of(rows, pairs, start, end, load_from):
    return dict(meta=dict(start=fc.iso(start), end=fc.iso(end), loadFrom=fc.iso(load_from), reach=S_GO), pairs=pairs,
                ways={wi: groups_of([r for r in rows if r['way'] == wi]) for wi in WAYS_IN})


def counts_add_up(summ):
    bad = []
    for wi in WAYS_IN:
        for name, g in summ['ways'][wi].items():
            for w in WAYS:
                s = g[w]
                if s['reached'] + s['failed'] + s['open'] + g['already'] != g['entries']:
                    bad.append(f'ways.{wi}.{name}.{w}: reached + failed + open + already != entries')
            s = g['C']
            if s['reached'] + s['open'] + s['skipped'] + g['already'] != g['entries']:
                bad.append(f'ways.{wi}.{name}.C: reached + open + skipped + already != entries')
    return bad


def write_self(out, rows, summ):
    os.makedirs(out, exist_ok=True)
    with open(os.path.join(out, 'rows.csv'), 'w', encoding='utf-8', newline='') as f:
        f.write(','.join(COLS) + '\n')
        for r in rows:
            f.write(','.join(cell(r[c]) for c in COLS) + '\n')
    with open(os.path.join(out, 'summary.json'), 'w', encoding='utf-8') as f:
        f.write(m90.js_json(summ) + '\n')


# ---------------------------------------------------------------- touch の数（spec の最後の節）
def tp_stats(rows):
    """1つの組の G（行の順）。値が無ければ None（和も）。within は数なので 0。"""
    tps = [r for r in rows if r['result'] == 'tp']
    ops = [r for r in rows if r['result'] == 'open']
    pips = [r['pips'] for r in rows]
    maes = [r['mae'] for r in rows]
    tmin = [r['minutes'] for r in tps]
    n = len(rows)
    s = fc.add_in_order(pips)
    out = dict(trades=n, tp=len(tps), open=len(ops),
               pipsSum=s if n else None, pipsMean=s / n if n else None, pipsMedian=fc.median(pips),
               tpMinutesMedian=fc.median(tmin), tpMinutesP90=p90(tmin), tpMinutesMax=max(tmin) if tmin else None)
    for lim in C_WITHIN:
        out[f'within{lim}'] = sum(1 for v in tmin if v <= lim)
    out.update(maeMedian=fc.median(maes), maeP90=p90(maes), maeMax=max(maes) if maes else None,
               tpMaeMax=max(r['mae'] for r in tps) if tps else None,
               openPipsSum=fc.add_in_order([r['pips'] for r in ops]) if ops else None,
               openPipsWorst=min(r['pips'] for r in ops) if ops else None,
               openMaeMax=max(r['mae'] for r in ops) if ops else None,
               openMinutesMax=max(r['minutes'] for r in ops) if ops else None)
    return {k: out[k] for k in TG_KEYS}


def tp_groups_of(rows):
    g = {'all': tp_stats(rows)}
    for p in PAIRS:
        g[p] = tp_stats([r for r in rows if r['pair'] == p])
    for sd in ('BUY', 'SELL'):                       # 取引の向き
        g[sd] = tp_stats([r for r in rows if r['side'] == sd])
    for zs in ('top', 'bottom'):                     # 入りの側
        g[zs] = tp_stats([r for r in rows if r['zside'] == zs])
    return g


def tp_summary_of(trows, tpairs, start, end, load_from):
    return dict(meta=dict(start=fc.iso(start), end=fc.iso(end), loadFrom=fc.iso(load_from), touch=TOUCH, tp=TP),
                pairs=tpairs, dirs={dn: tp_groups_of([r for r in trows if r['dir'] == dn]) for dn in TP_DIRS})


def tp_counts_add_up(ts):
    """tp + open = trades（どの組も）、flow と fade の trades = entries（全体と通貨ごと）、BUY + SELL = top + bottom
    = all、flow の top = fade の top。"""
    bad = []
    entries = sum(p['entries'] for p in ts['pairs'])
    for dn in TP_DIRS:
        g = ts['dirs'][dn]
        for name, s in g.items():
            if s['tp'] + s['open'] != s['trades']:
                bad.append(f'dirs.{dn}.{name}: tp + open != trades')
        if g['all']['trades'] != entries:
            bad.append(f'dirs.{dn}.all: trades {g["all"]["trades"]} != entries {entries}')
        for p in ts['pairs']:
            if g[p['pair']]['trades'] != p['entries']:
                bad.append(f'dirs.{dn}.{p["pair"]}: trades != the pair\'s entries')
        for a, b in (('BUY', 'SELL'), ('top', 'bottom')):
            if g[a]['trades'] + g[b]['trades'] != g['all']['trades']:
                bad.append(f'dirs.{dn}: {a} + {b} != all')
    f, d = ts['dirs']['flow'], ts['dirs']['fade']
    if (f['top']['trades'], f['BUY']['trades']) != (d['top']['trades'], d['SELL']['trades']) or \
            f['top']['trades'] != f['BUY']['trades']:
        bad.append('flow and fade: the top entries are not flow\'s BUYs and fade\'s SELLs')
    return bad


def write_touch(out, trows, tsumm):
    os.makedirs(out, exist_ok=True)
    with open(os.path.join(out, 'rows-tp.csv'), 'w', encoding='utf-8', newline='') as f:
        f.write(','.join(TP_COLS) + '\n')
        for r in trows:
            f.write(','.join(cell(r[c]) for c in TP_COLS) + '\n')
    with open(os.path.join(out, 'summary-tp.json'), 'w', encoding='utf-8') as f:
        f.write(m90.js_json(tsumm) + '\n')


# ---------------------------------------------------------------- 比べる
def compare_rows(C, mine, head, theirs):
    if head != COLS:
        C.bad(f'rows.csv header: TS {",".join(head)} / expected {",".join(COLS)}')
    if len(theirs) != len(mine):
        C.bad(f'rows: TS {len(theirs)}, Python {len(mine)}')

    def key(r):
        return (r.get('way'), r.get('pair'), r.get('open'))
    tk = {}
    for r in theirs:
        if key(r) in tk:
            C.bad(f'rows.csv: {key(r)} has two rows')
        tk[key(r)] = r
    mk = {key(r): r for r in mine}
    for k in mk:
        if k not in tk:
            C.bad(f'row {k}: in Python (T0 {mk[k]["T0"]} {mk[k]["side"]}, already {mk[k]["already"]}), '
                  f'missing in rows.csv')
    for k in tk:
        if k not in mk:
            C.bad(f'row {k}: in rows.csv (T0 {tk[k].get("T0")} {tk[k].get("side")}, already {tk[k].get("already")}), '
                  f'missing in Python')
    a = [key(r) for r in mine if key(r) in tk]
    b = [key(r) for r in theirs if key(r) in mk]
    if a != b:
        at = next((q for q in range(min(len(a), len(b))) if a[q] != b[q]), min(len(a), len(b)))
        C.bad(f'row order: from the shared row {at} on, Python {a[at] if at < len(a) else None} / '
              f'TS {b[at] if at < len(b) else None}')
    for r in mine:
        t = tk.get(key(r))
        if t is None:
            continue
        where = f'row {r["way"]} {r["pair"]} open={r["open"]} {r["side"]}'
        for col in COLS:
            s = t.get(col)
            s = '' if s is None else s
            C.fields += 1
            v = r[col]
            if col in SHARE_COLS:
                ok = m90.share_same(s, v)
                if ok and v is not None and math.isfinite(v) and float(s) != v:
                    C.near += 1
                    C.near_max = max(C.near_max, abs(float(s) - v))
            else:
                ok = s == cell(v)
            if not ok:
                C.bad(f'{where} {col}: TS {s!r} / Python {cell(v)!r}')


def compare_summary(C, mine, S):
    skipped = []
    meta = S.get('meta')
    for k in ('start', 'end', 'loadFrom'):
        C.fields += 1
        v = meta.get(k) if isinstance(meta, dict) else None
        try:
            same = v is not None and fc.ms_of(v) == fc.ms_of(mine['meta'][k])
        except Exception:  # noqa: BLE001
            same = False
        if not same:
            C.bad(f'meta.{k}: TS {v!r} / Python {mine["meta"][k]!r} (set START, END, LOAD_FROM as the TS run)')
    C.fields += 1
    v = meta.get('reach') if isinstance(meta, dict) else None
    if not (isinstance(v, (int, float)) and not isinstance(v, bool) and float(v) == S_GO):
        C.bad(f'meta.reach: TS {v!r} / Python {S_GO!r} (set REACH as the TS run)')
    skipped += [f'meta.{k}' for k in (meta if isinstance(meta, dict) else {}) if k not in ('start', 'end', 'loadFrom', 'reach')]
    tp = S.get('pairs')
    tpl = [x for x in tp if isinstance(x, dict)] if isinstance(tp, list) else []
    if [x.get('pair') for x in tpl] != PAIRS:
        C.bad(f'pairs: TS {[x.get("pair") for x in tpl]} / Python {PAIRS}')
    tpd = {x.get('pair'): x for x in tpl}
    for info in mine['pairs']:
        t = tpd.get(info['pair'])
        if t is None:
            C.bad(f'pairs.{info["pair"]}: missing in summary.json')
            continue
        for k in PAIR_KEYS:
            C.num(f'pairs.{info["pair"]}.{k}', info[k], t.get(k), False)
        skipped += [f'pairs.{info["pair"]}.{k}' for k in t if k not in ['pair'] + PAIR_KEYS]
    tw_all = S.get('ways')
    if not isinstance(tw_all, dict):
        C.bad('ways: missing in summary.json')
        return skipped
    for wi in WAYS_IN:
        tg = tw_all.get(wi)
        if not isinstance(tg, dict):
            C.bad(f'ways.{wi}: missing in summary.json')
            continue
        for g in GROUPS:
            th = m90.pick(tg, g)
            if not isinstance(th, dict):
                C.bad(f'ways.{wi}.{g}: missing in summary.json')
                continue
            mg = mine['ways'][wi][g]
            for k in G_KEYS:
                C.num(f'ways.{wi}.{g}.{k}', mg[k], th.get(k), False)
            for w in WAYS:
                tw = th.get(w)
                if not isinstance(tw, dict):
                    C.bad(f'ways.{wi}.{g}.{w}: missing in summary.json')
                    continue
                for k in W_KEYS:
                    if k not in tw:
                        C.bad(f'ways.{wi}.{g}.{w}.{k}: missing in summary.json')
                        continue
                    C.num(f'ways.{wi}.{g}.{w}.{k}', mg[w][k], tw[k], k in W_NEAR)
                skipped += [f'ways.{wi}.{g}.{w}.{k}' for k in tw if k not in W_KEYS]
            tc = th.get('C')
            if not isinstance(tc, dict):
                C.bad(f'ways.{wi}.{g}.C: missing in summary.json')
            else:
                for k in C_KEYS:
                    if k not in tc:
                        C.bad(f'ways.{wi}.{g}.C.{k}: missing in summary.json')
                        continue
                    C.num(f'ways.{wi}.{g}.C.{k}', mg['C'][k], tc[k], k in C_NEAR)
                skipped += [f'ways.{wi}.{g}.C.{k}' for k in tc if k not in C_KEYS]
            skipped += [f'ways.{wi}.{g}.{k}' for k in th if k not in G_KEYS + list(WAYS) + ['C']]
        known = set(GROUPS) | {p.replace('/', '_') for p in PAIRS}
        for k in tg:
            if k not in known:
                C.bad(f'ways.{wi}.{k}: in summary.json, not a group here ({", ".join(GROUPS)})')
    for k in tw_all:
        if k not in WAYS_IN:
            C.bad(f'ways.{k}: in summary.json, not a way in here ({", ".join(WAYS_IN)})')
    skipped += [k for k in S if k not in ('meta', 'pairs', 'ways')]
    return skipped


def compare_tp_rows(C, mine, head, theirs):
    """rows-tp.csv を1行ずつ、欄ごとに（share0 は既存の share の比べ方、ほかは文字がそのまま同じ）"""
    if head != TP_COLS:
        C.bad(f'rows-tp.csv header: TS {",".join(head)} / expected {",".join(TP_COLS)}')
    if len(theirs) != len(mine):
        C.bad(f'rows-tp.csv rows: TS {len(theirs)}, Python {len(mine)}')

    def key(r):
        return (r.get('dir'), r.get('pair'), r.get('open'))
    tk = {}
    for r in theirs:
        if key(r) in tk:
            C.bad(f'rows-tp.csv: {key(r)} has two rows')
        tk[key(r)] = r
    mk = {key(r): r for r in mine}
    for k in mk:
        if k not in tk:
            C.bad(f'touch row {k}: in Python (T0 {mk[k]["T0"]} {mk[k]["zside"]} {mk[k]["side"]}), missing in rows-tp.csv')
    for k in tk:
        if k not in mk:
            C.bad(f'touch row {k}: in rows-tp.csv (T0 {tk[k].get("T0")} {tk[k].get("zside")} {tk[k].get("side")}), '
                  f'missing in Python')
    a = [key(r) for r in mine if key(r) in tk]
    b = [key(r) for r in theirs if key(r) in mk]
    if a != b:
        at = next((q for q in range(min(len(a), len(b))) if a[q] != b[q]), min(len(a), len(b)))
        C.bad(f'rows-tp.csv order: from the shared row {at} on, Python {a[at] if at < len(a) else None} / '
              f'TS {b[at] if at < len(b) else None}')
    for r in mine:
        t = tk.get(key(r))
        if t is None:
            continue
        where = f'touch row {r["dir"]} {r["pair"]} open={r["open"]} {r["side"]}'
        for col in TP_COLS:
            s = t.get(col)
            s = '' if s is None else s
            C.fields += 1
            v = r[col]
            if col in TP_SHARE_COLS:
                ok = m90.share_same(s, v)
                if ok and v is not None and math.isfinite(v) and float(s) != v:
                    C.near += 1
                    C.near_max = max(C.near_max, abs(float(s) - v))
            else:
                ok = s == cell(v)
            if not ok:
                C.bad(f'{where} {col}: TS {s!r} / Python {cell(v)!r}')


def compare_tp_summary(C, mine, S):
    """summary-tp.json の数をすべて（meta の touch・tp も）。near は平均と中央値だけ。"""
    skipped = []
    meta = S.get('meta')
    for k in ('start', 'end', 'loadFrom'):
        C.fields += 1
        v = meta.get(k) if isinstance(meta, dict) else None
        try:
            same = v is not None and fc.ms_of(v) == fc.ms_of(mine['meta'][k])
        except Exception:  # noqa: BLE001
            same = False
        if not same:
            C.bad(f'summary-tp meta.{k}: TS {v!r} / Python {mine["meta"][k]!r} (set START, END, LOAD_FROM as the TS run)')
    for k, mv, env in (('touch', TOUCH, 'TOUCH'), ('tp', TP, 'TP')):
        C.fields += 1
        v = meta.get(k) if isinstance(meta, dict) else None
        if not (isinstance(v, (int, float)) and not isinstance(v, bool) and float(v) == mv):
            C.bad(f'summary-tp meta.{k}: TS {v!r} / Python {mv!r} (set {env} as the TS run)')
    if isinstance(meta, dict) and 'reach' in meta:
        C.bad(f'summary-tp meta.reach: TS {meta["reach"]!r} (the spec: touch and tp in place of reach)')
    skipped += [f'summary-tp meta.{k}' for k in (meta if isinstance(meta, dict) else {})
                if k not in ('start', 'end', 'loadFrom', 'touch', 'tp', 'reach')]
    tp = S.get('pairs')
    tpl = [x for x in tp if isinstance(x, dict)] if isinstance(tp, list) else []
    if [x.get('pair') for x in tpl] != PAIRS:
        C.bad(f'summary-tp pairs: TS {[x.get("pair") for x in tpl]} / Python {PAIRS}')
    tpd = {x.get('pair'): x for x in tpl}
    for info in mine['pairs']:
        t = tpd.get(info['pair'])
        if t is None:
            C.bad(f'summary-tp pairs.{info["pair"]}: missing in summary-tp.json')
            continue
        for k in TP_PAIR_KEYS:
            C.num(f'summary-tp pairs.{info["pair"]}.{k}', info[k], t.get(k), False)
        skipped += [f'summary-tp pairs.{info["pair"]}.{k}' for k in t if k not in ['pair'] + TP_PAIR_KEYS]
    td_all = S.get('dirs')
    if not isinstance(td_all, dict):
        C.bad('summary-tp dirs: missing in summary-tp.json')
        return skipped
    for dn in TP_DIRS:
        tg = td_all.get(dn)
        if not isinstance(tg, dict):
            C.bad(f'summary-tp dirs.{dn}: missing in summary-tp.json')
            continue
        for g in TP_GROUPS:
            th = m90.pick(tg, g)
            if not isinstance(th, dict):
                C.bad(f'summary-tp dirs.{dn}.{g}: missing in summary-tp.json')
                continue
            mg = mine['dirs'][dn][g]
            for k in TG_KEYS:
                if k not in th:
                    C.bad(f'summary-tp dirs.{dn}.{g}.{k}: missing in summary-tp.json')
                    continue
                C.num(f'summary-tp dirs.{dn}.{g}.{k}', mg[k], th[k], k in TG_NEAR)
            skipped += [f'summary-tp dirs.{dn}.{g}.{k}' for k in th if k not in TG_KEYS]
        known = set(TP_GROUPS) | {p.replace('/', '_') for p in PAIRS}
        for k in tg:
            if k not in known:
                C.bad(f'summary-tp dirs.{dn}.{k}: in summary-tp.json, not a group here ({", ".join(TP_GROUPS)})')
    for k in td_all:
        if k not in TP_DIRS:
            C.bad(f'summary-tp dirs.{k}: in summary-tp.json, not a direction here ({", ".join(TP_DIRS)})')
    skipped += [f'summary-tp {k}' for k in S if k not in ('meta', 'pairs', 'dirs')]
    return skipped


def fmt(v):
    return '-' if v is None else js_str(v)


def tp_group_line(dn, name, g):
    return (f'  touch {dn} {name}: trades {g["trades"]}, tp {g["tp"]}, open {g["open"]}, pips sum {fmt(g["pipsSum"])} / '
            f'mean {fmt(g["pipsMean"])} / median {fmt(g["pipsMedian"])}, tp minutes median {fmt(g["tpMinutesMedian"])} / '
            f'P90 {fmt(g["tpMinutesP90"])} / max {fmt(g["tpMinutesMax"])}, within 60 {g["within60"]} / 1440 '
            f'{g["within1440"]} / 10080 {g["within10080"]}, mae median {fmt(g["maeMedian"])} / P90 {fmt(g["maeP90"])} / '
            f'max {fmt(g["maeMax"])}, tp mae max {fmt(g["tpMaeMax"])}, open pips sum {fmt(g["openPipsSum"])} / worst '
            f'{fmt(g["openPipsWorst"])}, open mae max {fmt(g["openMaeMax"])}, open minutes max {fmt(g["openMinutesMax"])}')


def tp_problems(chk, tsums):
    return (['touch minute line: ' + m for m in chk['tMismatch']] +
            ['touch fast mark against the line and band: ' + m for m in chk['tFlag']] +
            ['touch entry price: ' + m for m in chk['tEntry']] +
            ['touch rows: ' + m for m in chk['tRows']] +
            ['touch counts: ' + m for m in tsums])


def tp_check_line(chk, tsums):
    return (f'  checks, touch: entry minute lines against the window rebuilt ({chk["tLines"]}): mismatches '
            f'{len(chk["tMismatch"])}; fast marks read again with the line and band ({chk["tFlagMinutes"]} minutes): '
            f'mismatches {len(chk["tFlag"])}; entry prices not the minute\'s ask / bid close {len(chk["tEntry"])}; '
            f'rows (pairs of flow / fade, sides, tp pips = TP, open pips < TP, order) {len(chk["tRows"])}; counts not '
            f'adding up {len(tsums)}; entry minutes touching both open sides (read on the top side) {len(chk["tBoth"])}')


def group_line(wi, name, g):
    out = f'  {wi} {name}: entries {g["entries"]}, already {g["already"]}'
    for w in WAYS:
        s = g[w]
        rate = '-' if s['rate'] is None else f'{s["rate"]:.2f}%'
        out += (f'; {w}: reached {s["reached"]}, failed {s["failed"]}, open {s["open"]}, rate {rate}, '
                f'pips sum {fmt(s["pipsSum"])} / mean {fmt(s["pipsMean"])}')
    s = g['C']
    out += (f'; C: reached {s["reached"]} (plus {s["plus"]}, minus {s["minus"]}), open {s["open"]}, skipped '
            f'{s["skipped"]}, pips sum {fmt(s["pipsSum"])} / mean {fmt(s["pipsMean"])} / min {fmt(s["pipsMin"])}, '
            f'mae max {fmt(s["maeMax"])}, minutes median {fmt(s["minutesMedian"])} / max {fmt(s["minutesMax"])}, '
            f'open pips {fmt(s["openPipsSum"])}')
    return out


# ---------------------------------------------------------------- 全体
def main():
    ap = argparse.ArgumentParser(description='research/macd90m-spec.md の独立した計算し直し')
    ap.add_argument('--cache', required=True, help='GMO の日のファイルのフォルダ')
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument('--out', help='TypeScript の rows.csv と summary.json のフォルダ（読むだけ）')
    g.add_argument('--self', dest='self_out', help='比べずに、自分の rows.csv・summary.json・rows-tp.csv・'
                                                   'summary-tp.json をここに書く')
    g.add_argument('--touch-only', dest='touch_out', help='touch だけを数え、比べずに、自分の rows-tp.csv と '
                                                          'summary-tp.json をここに書く')
    a = ap.parse_args()
    t_all = time.time()
    period = {k: (os.environ.get(k) or DEFAULTS[k]) for k in DEFAULTS}
    try:
        start, end, load_from = (fc.ms_of(period[k]) for k in ('START', 'END', 'LOAD_FROM'))
    except Exception as e:  # noqa: BLE001
        die(f'START, END, LOAD_FROM: {e!r}')
    if not os.path.isdir(a.cache):
        die(f'no cache folder {a.cache}')
    S = head = ts_rows = None
    if a.out is not None:
        try:
            with open(os.path.join(a.out, 'summary.json'), encoding='utf-8') as f:
                S = json.load(f)
            with open(os.path.join(a.out, 'rows.csv'), newline='', encoding='utf-8') as f:
                rd = csv.DictReader(f)
                head = list(rd.fieldnames or [])
                ts_rows = list(rd)
        except Exception as e:  # noqa: BLE001
            die(f'reading {a.out}: {e!r}')
        if not isinstance(S, dict):
            die('summary.json is not an object')
        # touch の2つのファイル: 無い・読めない時は、ここでは止めずに食い違いとして数える（rows.csv の比べは続ける）
        tp_missing = []
        TS_tp = tp_head = ts_trows = None
        for name in ('rows-tp.csv', 'summary-tp.json'):
            if not os.path.isfile(os.path.join(a.out, name)):
                tp_missing.append(f'{name}: missing in {a.out} (the TypeScript did not write the touch files)')
        if not tp_missing:
            try:
                with open(os.path.join(a.out, 'summary-tp.json'), encoding='utf-8') as f:
                    TS_tp = json.load(f)
                with open(os.path.join(a.out, 'rows-tp.csv'), newline='', encoding='utf-8') as f:
                    rd = csv.DictReader(f)
                    tp_head = list(rd.fieldnames or [])
                    ts_trows = list(rd)
            except Exception as e:  # noqa: BLE001
                tp_missing.append(f'reading the touch files in {a.out}: {e!r}')
            if not tp_missing and not isinstance(TS_tp, dict):
                tp_missing.append('summary-tp.json is not an object')
    print(f'macd90m-check: entries closing in [{fc.iso(start)}, {fc.iso(end)}), 1-hour bars from {fc.iso(load_from)}, '
          f'1-minute bars from START; the band {S_IN!r} in, {S_GO!r} reached (a minute touches with its mid high / low)')
    if a.touch_out is None:
        print('  the reach share is the spec\'s' if S_GO == m90.S_GO else f'  the reach share is NOT the spec\'s 0.96 (REACH set: {S_GO!r})')
    print(f'  touch: the share {TOUCH!r}' + (' (the spec\'s)' if TOUCH == m90.S_GO else ' (NOT the spec\'s 0.96: TOUCH set)') +
          f', take profit {TP} pips' + (' (the spec\'s)' if TP == 10 else ' (NOT the spec\'s 10: TP set)') + ', no stop')
    if all(period[k] == DEFAULTS[k] for k in DEFAULTS):
        print('  the period is the spec\'s')
    else:
        print('  the period is NOT the spec\'s (START, END or LOAD_FROM set)')

    rows, pairs, ld, chk, trows, tpairs = compute(a.cache, start, end, load_from, print, a.touch_out is None)
    tsumm = tp_summary_of(trows, tpairs, start, end, load_from)
    tsums = tp_counts_add_up(tsumm)
    tprob = tp_problems(chk, tsums)
    print(f'  files read {ld.files}, failed {ld.failed}' + (' (' + '; '.join(ld.failed_ex) + ')' if ld.failed else '') +
          f'; 1-min bars left out: one side {ld.one_side}, crossed {ld.crossed}, closure {ld.closure}, repeated '
          f'{ld.repeated}; 1-min bars in no 1-hour bar (not read) {chk["orphan"]}')
    print(tp_check_line(chk, tsums))
    for m in chk['tBoth'][:5]:
        print('  note: a touch entry minute touching both open sides (read on the top side): ' + m)

    if a.touch_out is not None:
        # touch は Z/Zp と分の線の上に立つので、その確かめ（すべての足の Z/Zp・SAMPLE_EVERY 分に1つの分の線）も数える
        print(f'  checks: Z/Zp of every bar against macd90-check.py, minute lines against the window rebuilt '
              f'({chk["minutesChecked"]} sampled minute lines): mismatches {len(chk["mismatch"])}')
        tprob = ['minute/bar line: ' + m for m in chk['mismatch']] + tprob
        write_touch(a.touch_out, trows, tsumm)
        for dn in TP_DIRS:
            for name in TP_GROUPS:
                print(tp_group_line(dn, name, tsumm['dirs'][dn][name]))
        for m in tprob[:MAX_DIFF_LINES]:
            print('CHECK ' + m)
        print(f'wrote {len(trows)} touch rows ({sum(p["entries"] for p in tpairs)} entries) and summary-tp.json to '
              f'{a.touch_out} ({time.time() - t_all:.1f}s)')
        sys.exit(1 if tprob else 0)

    summ = summary_of(rows, pairs, start, end, load_from)
    sums = counts_add_up(summ)
    print(f'  checks: Z/Zp of every bar against macd90-check.py, minute lines against the window rebuilt '
          f'({chk["minutesChecked"]} minute lines): mismatches {len(chk["mismatch"])}; A reached without B at the '
          f'same moment {len(chk["aNotB"])}; close entries in both bands {len(chk["both"])}; moment minutes touching '
          f'both sides {len(chk["bothMinute"])}; counts not adding up {len(sums)}')
    print(f'  checks, way C: A or B reached and C not the same trade {len(chk["cNotSame"])}; C out before A or B '
          f'{len(chk["cBefore"])}; taken while held, or skipped while nothing is held (from the rows alone) '
          f'{len(chk["cOverlap"])}')
    problems = (['minute/bar line: ' + m for m in chk['mismatch']] +
                ['A reached, B not at the same moment: ' + m for m in chk['aNotB']] +
                ['both bands at a close: ' + m for m in chk['both']] + sums +
                ['way C: ' + m for m in chk['cNotSame'] + chk['cBefore'] + chk['cOverlap']])
    for m in chk['bothMinute'][:5]:
        print('  note: a moment minute touching both sides (read on the top side if it may enter there): ' + m)

    if a.self_out is not None:
        write_self(a.self_out, rows, summ)
        write_touch(a.self_out, trows, tsumm)
        for wi in WAYS_IN:
            for name in GROUPS:
                print(group_line(wi, name, summ['ways'][wi][name]))
        for dn in TP_DIRS:
            for name in TP_GROUPS:
                print(tp_group_line(dn, name, tsumm['dirs'][dn][name]))
        for m in (problems + tprob)[:MAX_DIFF_LINES]:
            print('CHECK ' + m)
        print(f'wrote {len(rows)} rows and summary.json, {len(trows)} touch rows and summary-tp.json to {a.self_out} '
              f'({time.time() - t_all:.1f}s)')
        sys.exit(1 if problems or tprob else 0)

    C = m90.Cmp()
    for m in problems:
        C.bad(m)
    compare_rows(C, rows, head, ts_rows)
    skipped = compare_summary(C, summ, S)
    n_old, f_old, near_old = C.n, C.fields, C.near
    print(f'rows.csv and summary.json: compared {f_old} fields ({len(rows)} Python rows, {len(ts_rows)} TS rows): '
          f'{near_old} equal only within {REL:g} (largest {C.near_max:.3g}), {n_old} different')
    if skipped:
        print('in summary.json, not compared: ' + ', '.join(skipped[:20]) + (' ...' if len(skipped) > 20 else ''))
    # touch: rows-tp.csv と summary-tp.json（同じ Cmp: 出す食い違いの行は合わせて MAX_DIFF_LINES まで）
    for m in tprob:
        C.bad(m)
    if tp_missing:
        for m in tp_missing:
            C.bad('touch: ' + m)
        print(f'rows-tp.csv and summary-tp.json: NOT compared ({"; ".join(tp_missing)})')
    else:
        compare_tp_rows(C, trows, tp_head, ts_trows)
        tskipped = compare_tp_summary(C, tsumm, TS_tp)
        print(f'rows-tp.csv and summary-tp.json: compared {C.fields - f_old} fields ({len(trows)} Python rows, '
              f'{len(ts_trows)} TS rows): {C.near - near_old} equal only within {REL:g}, {C.n - n_old} different')
        if tskipped:
            print('in summary-tp.json, not compared: ' + ', '.join(tskipped[:20]) + (' ...' if len(tskipped) > 20 else ''))
    print(f'compared {C.fields} fields in all: {C.near} equal only within {REL:g} (largest {C.near_max:.3g}), '
          f'{C.n} different')
    print(f'({time.time() - t_all:.1f}s)')
    if C.n:
        print(f'PYTHON DISAGREES: {C.n} differences')
        sys.exit(1)
    for wi in WAYS_IN:
        for name in GROUPS:
            print(group_line(wi, name, summ['ways'][wi][name]))
    for dn in TP_DIRS:
        for name in TP_GROUPS:
            print(tp_group_line(dn, name, tsumm['dirs'][dn][name]))
    print('PYTHON AGREES')
    sys.exit(0)


if __name__ == '__main__':
    main()
