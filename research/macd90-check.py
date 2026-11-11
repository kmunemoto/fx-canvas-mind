#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""research/macd90-spec.md の数え直し（Python。標準ライブラリだけ。同じ GMO のファイルから）。

オーナー（2026-11-11）: 「90%に届いたらその流れにのって注文を入れて、96%までそのままいく確率を求めて」。
1時間足の MACD の青い線（600本の窓・新しい120本の枠、v8 の枠のまま）が、0 の線から枠の上（下）への 90% に
入った足で、その向きに入り（上 → BUY、下 → SELL。入りは足の終値の払う側: BUY は Ask、SELL は Bid）、線が
96% まで行くか（reached）を、2つの終わり方で追う。
  A（帯）: 線が 90% の帯の外に出たら failed。
  B（0 の線）: 線が 0 の線かその向こうに行ったら failed。
入りの足で、もう 96% にいるものは already（数えるが、追わない。割合に入れない）。

research/macd90.ts（TypeScript の側）は読まずに、spec と、spec が名前を出す本番のエンジン
（_shared/macd.ts・_shared/pine.ts・_shared/macd-level.ts の zoneAt）から書いた。
足の読み込み（Bid と Ask の合わせ方・週末の inside・中値の丸め）は、TypeScript と別に書かれ一致した
research/flowz-check.py の関数を使う（load_tf・keys_of・round_chart・LoadStats・iso・ms_of・js_round・
add_in_order・median）。窓ごとの MACD は、macd.ts・pine.ts と同じ順の足し算・掛け算で、窓の 0 番から
EMA を作り直す（窓ごとに種が違うので、窓をまたいで続けられない）。速い形の正しさは、足の一部
（SAMPLE_EVERY 本に1つと、入りの足すべて）で、pineEma・macd・zoneAt をそのまま写した遅い形と、
s = 0.95 での flowz-check.py の zone_entry（decideZoneOnWindow と一致済み）と比べて確かめる。

使い方:
  [START=… END=… LOAD_FROM=…] python3 -I research/macd90-check.py --cache DIR --out OUT
      DIR: <DIR>/<USD_JPY など>/1hour/<bid|ask>/<鍵>.json（GMO の形）
      OUT: research/macd90.ts の出力（rows.csv と summary.json）。読むだけで、書かない。
  [START=… END=… LOAD_FROM=…] python3 -I research/macd90-check.py --cache DIR --self OUT2
      比べずに、自分の rows.csv と summary.json を OUT2 に書く。
  期間の既定は spec の START 2024-01-01T00:00:00Z、END 2026-11-10T21:00:00Z、LOAD_FROM 2023-10-01T00:00:00Z。
終了コード: 0 = 行と数がすべて一致（最後の行 PYTHON AGREES）、1 = 食い違いあり、または入力の誤り
（最後の行 PYTHON DISAGREES: n differences）。--self は書けたら 0。
"""
import argparse
import csv
import importlib.util
import json
import math
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location('flowz_check', os.path.join(HERE, 'flowz-check.py'))
fc = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(fc)

HOUR = fc.HOUR
WINDOW = fc.WINDOW               # 600（macd-level.ts LEVEL_WINDOW）
ZONE_BARS = fc.ZONE_BARS         # 120（macd-level.ts ZONE_BARS）
PAIRS = fc.PAIRS                 # USD/JPY, EUR/JPY, AUD/JPY, EUR/USD, AUD/USD（同じ T はこの順）
S_IN = 90 / 100                  # 入りの帯（0.9 と同じ double）
S_GO = 96 / 100                  # 届いたとみる帯（0.96 と同じ double）
A12, A26, A9 = 2 / (12 + 1), 2 / (26 + 1), 2 / (9 + 1)    # pine.ts pineEma の alpha = 2 / (n + 1)
B12, B26, B9 = 1 - A12, 1 - A26, 1 - A9                   # pine.ts の (1 - alpha)（同じ double）
SAMPLE_EVERY = 97                # 速い形を遅い形で確かめる足（この数に1つと、入りの足すべて）
REL = 1e-9
MAX_DIFF_LINES = 20
INF = float('inf')

DEFAULTS = dict(START='2024-01-01T00:00:00Z', END='2026-11-10T21:00:00Z', LOAD_FROM='2023-10-01T00:00:00Z')
WAYS = ('A', 'B')
WAY_COLS = ['result', 'T', 'exit', 'pips', 'mae', 'bars', 'share']
COLS = ['pair', 'open', 'T', 'side', 'entry', 'share0', 'already'] + [w + '_' + c for w in WAYS for c in WAY_COLS]
SHARE_COLS = {'share0', 'A_share', 'B_share'}           # 1e-9 まで同じとみる。ほかは文字がそのまま同じ
W_KEYS = ['reached', 'failed', 'open', 'rate', 'pipsSum', 'pipsMean', 'pipsMedian', 'reachedPipsMean',
          'failedPipsMean', 'maeMedian', 'maeMax', 'barsMedian', 'barsMax', 'openPipsSum', 'openPipsWorst']
W_NEAR = {'rate', 'pipsMean', 'pipsMedian', 'reachedPipsMean', 'failedPipsMean', 'maeMedian', 'barsMedian'}
G_KEYS = ['entries', 'already']
GROUPS = ['all'] + PAIRS + ['BUY', 'SELL']


def die(msg):
    print('ERROR: ' + msg)
    print('PYTHON DISAGREES: 1 differences')
    sys.exit(1)


# ---------------------------------------------------------------- 数を JS と同じに書く
def js_str(x):
    """JS の String(x)（Number.prototype.toString）。Python の repr(float) と同じ最短の桁を、JS の書き方に。
    整数の double は ".0" なし、-0 は "0"、指数は 1e21 以上と 1e-7 より小さいときだけ（"1e-7"、"1.5e+21"）。"""
    if isinstance(x, bool):
        return 'true' if x else 'false'
    if isinstance(x, int):
        return str(x)
    if x != x:
        return 'NaN'
    if x == INF:
        return 'Infinity'
    if x == -INF:
        return '-Infinity'
    if x == 0:
        return '0'
    r = repr(x)
    sign = ''
    if r[0] == '-':
        sign, r = '-', r[1:]
    if 'e' in r:
        mant, ex = r.split('e')
        ex = int(ex)
    else:
        mant, ex = r, 0
    ip, _, fp = mant.partition('.')
    ds = (ip + fp).lstrip('0')
    e10 = ex - len(fp)                       # 値 = int(ds) * 10^e10
    stripped = ds.rstrip('0')
    e10 += len(ds) - len(stripped)
    ds = stripped
    k = len(ds)
    n = k + e10                              # 値 = 0.ds * 10^n
    if k <= n <= 21:
        out = ds + '0' * (n - k)
    elif 0 < n <= 21:
        out = ds[:n] + '.' + ds[n:]
    elif -6 < n <= 0:
        out = '0.' + '0' * (-n) + ds
    else:
        e = n - 1
        out = ds[0] + ('.' + ds[1:] if k > 1 else '') + 'e' + ('+' if e >= 0 else '-') + str(abs(e))
    return sign + out


def js_div(a, b):
    """JS の a / b（0 で割ると Infinity・-Infinity・NaN）"""
    if b != 0:
        return a / b
    if a == 0 or a != a:
        return math.nan
    return INF if (a > 0) == (math.copysign(1.0, b) > 0) else -INF


def cell(v):
    """rows.csv の欄: None は空、文字はそのまま、数は JS の String()"""
    if v is None:
        return ''
    return v if isinstance(v, str) else js_str(v)


# ---------------------------------------------------------------- 窓の MACD（速い形）
def zones_of(c, lo, n):
    """足 i = lo..n-1（i >= 599）ごとに、足 i の窓（c[i-599..i]、600本）の MACD（macd.ts: pineEma 12・26 の差、
    その pineEma 9、ヒスト = 線 − シグナル）の、窓の 599 番（Z(i)）と 598 番（Zp(i)）の (m, top, bottom)。
    top・bottom は zoneAt と同じ: その番までの 120 本の線・シグナル・ヒストと 0 の最大・最小。
    返すのは 6 つの並び（長さ n、lo より前は None）: m599, top599, bot599, m598, top598, bot598。
    足し算・掛け算の順は pine.ts pineSmoothed と同じ（種は前から足して n で割る、以後 alpha*v + (1-alpha)*prev）。"""
    m9, t9, b9, m8, t8, b8 = ([None] * n for _ in range(6))
    a12, b12, a26, b26, a9, b9_ = A12, B12, A26, B26, A9, B9
    for i in range(lo, n):
        w = c[i - WINDOW + 1:i + 1]
        s = 0.0
        for x in w[:12]:
            s += x
        f = s / 12                               # fast の 11 番
        for x in w[12:26]:
            f = a12 * x + b12 * f
        s = 0.0
        for x in w[:26]:
            s += x
        sl = s / 26                              # slow の 25 番
        ls = [f - sl]                            # 線の 25 番
        for x in w[26:34]:                       # 線の 26..33 番
            f = a12 * x + b12 * f
            sl = a26 * x + b26 * sl
            ls.append(f - sl)
        s = 0.0
        for v in ls:
            s += v
        g = s / 9                                # シグナルの 33 番
        for x in w[34:479]:                      # 34..478 番
            f = a12 * x + b12 * f
            sl = a26 * x + b26 * sl
            g = a9 * (f - sl) + b9_ * g
        L = []
        S = []
        for x in w[479:600]:                     # 479..599 番（598 番の枠の始まりから）
            f = a12 * x + b12 * f
            sl = a26 * x + b26 * sl
            m = f - sl
            g = a9 * m + b9_ * g
            L.append(m)
            S.append(g)
        H = [p - q for p, q in zip(L, S)]
        tm = max(max(L[1:120]), max(S[1:120]), max(H[1:120]))      # 480..598 番
        bm = min(min(L[1:120]), min(S[1:120]), min(H[1:120]))
        t = max(tm, L[120], S[120], H[120])
        b = min(bm, L[120], S[120], H[120])
        m9[i] = L[120]
        t9[i] = t if t > 0.0 else 0.0
        b9[i] = b if b < 0.0 else 0.0
        t = max(tm, L[0], S[0], H[0])
        b = min(bm, L[0], S[0], H[0])
        m8[i] = L[119]
        t8[i] = t if t > 0.0 else 0.0
        b8[i] = b if b < 0.0 else 0.0
    return m9, t9, b9, m8, t8, b8


# ---------------------------------------------------------------- 遅い形（確かめるだけ）
def pine_ema_ref(xs, n):
    """pine.ts pineSmoothed をそのまま（None は null）"""
    alpha = 2 / (n + 1)
    out = [None] * len(xs)
    prev = None
    for i in range(len(xs)):
        v = xs[i]
        if prev is None:
            if i < n - 1:
                continue
            s = 0.0
            ok = True
            for k in range(i - n + 1, i + 1):
                w = xs[k]
                if w is None or not math.isfinite(w):
                    ok = False
                    break
                s += w
            if not ok:
                continue
            prev = s / n
        elif v is None or not math.isfinite(v):
            prev = None
            continue
        else:
            prev = alpha * v + (1 - alpha) * prev
        out[i] = prev
    return out


def zone_ref(closes, k):
    """macd.ts macd と macd-level.ts zoneAt をそのまま: 窓の k 番の (m, top, bottom)"""
    fast = pine_ema_ref(closes, 12)
    slow = pine_ema_ref(closes, 26)
    line = [None if fast[i] is None or slow[i] is None else fast[i] - slow[i] for i in range(len(closes))]
    sig = pine_ema_ref(line, 9)
    hist = [None if line[i] is None or sig[i] is None else line[i] - sig[i] for i in range(len(closes))]
    top = 0
    bottom = 0
    for xs in (line, sig, hist):
        for j in range(k - ZONE_BARS + 1, k + 1):
            v = xs[j]
            if v > top:
                top = v
            if v < bottom:
                bottom = v
    return line[k], float(top), float(bottom)


# ---------------------------------------------------------------- 帯
def in_band(side, s, m, top, bot):
    """side 1 = 上（top(k) > 0 and m >= s * top）、-1 = 下（bottom(k) < 0 and m <= s * bottom）"""
    if side > 0:
        return top > 0 and m >= s * top
    return bot < 0 and m <= s * bot


# ---------------------------------------------------------------- 1つの通貨
def compute_pair(cache, pi, pair, start, end, load_from, ld, chk, log):
    t_pair = time.time()
    sym = pair.replace('/', '_')
    dec = 5 if pair.endswith('/USD') else 3
    scale = 10.0 ** dec
    bars = fc.load_tf(cache, sym, '1hour', HOUR, fc.keys_of(load_from, end), load_from, end, ld)
    n = len(bars)
    t = [x[0] for x in bars]
    c = [fc.round_chart((x[1][4] + x[2][4]) / 2, dec) for x in bars]        # チャートの中値の終値
    bc = [x[1][4] for x in bars]
    bl = [x[1][3] for x in bars]
    ac = [x[2][4] for x in bars]
    ah = [x[2][2] for x in bars]
    del bars

    def P(x):
        return fc.js_round(x * scale)          # 整数の点（Math.round）

    lo = WINDOW - 1
    m9, t9, b9, m8, t8, b8 = zones_of(c, lo, n) if n > lo else ([None] * n,) * 6
    t_zone = time.time() - t_pair

    rows = []
    short = 0
    for i in range(n):
        T = t[i] + HOUR
        if T < start or T >= end:
            continue
        if i < lo:
            short += 1
            continue
        up = in_band(1, S_IN, m9[i], t9[i], b9[i]) and not in_band(1, S_IN, m8[i], t8[i], b8[i])
        dn = in_band(-1, S_IN, m9[i], t9[i], b9[i]) and not in_band(-1, S_IN, m8[i], t8[i], b8[i])
        if up and dn:
            chk['both'].append(f'{pair} {fc.iso(t[i])}')
        if not (up or dn):
            continue
        sd = 1 if up else -1
        side = 'BUY' if up else 'SELL'
        entry = ac[i] if sd > 0 else bc[i]
        edge = t9[i] if sd > 0 else b9[i]
        share0 = js_div(m9[i], edge)
        already = in_band(sd, S_GO, m9[i], t9[i], b9[i])
        r = dict(pair=pair, pi=pi, _T=T, _side=sd, open=fc.iso(t[i]), T=fc.iso(T), side=side, entry=entry,
                 share0=share0, already=1 if already else 0)
        for w in WAYS:
            for col in WAY_COLS:
                r[w + '_' + col] = None
        if not already:
            pe = P(entry)
            for w in WAYS:
                jx, res = n - 1, 'open'
                for j in range(i + 1, n):
                    if in_band(sd, S_GO, m9[j], t9[j], b9[j]):
                        jx, res = j, 'reached'
                        break
                    if w == 'A':
                        out = not in_band(sd, S_IN, m9[j], t9[j], b9[j])
                    else:
                        out = m9[j] <= 0 if sd > 0 else m9[j] >= 0
                    if out:
                        jx, res = j, 'failed'
                        break
                if sd > 0:
                    px = bc[jx]
                    pips = (P(px) - pe) / 10
                    worst = min(bl[i + 1:jx + 1]) if jx > i else None
                    against = pe - P(worst) if worst is not None else 0
                    ex_edge = t9[jx]
                else:
                    px = ac[jx]
                    pips = (pe - P(px)) / 10
                    worst = max(ah[i + 1:jx + 1]) if jx > i else None
                    against = P(worst) - pe if worst is not None else 0
                    ex_edge = b9[jx]
                r[w + '_result'] = res
                r[w + '_T'] = fc.iso(t[jx] + HOUR)
                r[w + '_exit'] = px
                r[w + '_pips'] = pips
                r[w + '_mae'] = against / 10 if against > 0 else 0
                r[w + '_bars'] = jx - i
                r[w + '_share'] = js_div(m9[jx], ex_edge)
        rows.append(r)

    # 速い形の確かめ: SAMPLE_EVERY 本に1つと、入りの足すべてで、遅い形（pineEma・macd・zoneAt のまま）と、
    # s = 0.95 の入り（上 → zone_entry の SELL、下 → BUY）を flowz-check.py の zone_entry と
    entry_i = {(r['_T'] - HOUR) for r in rows}
    for i in range(lo, n):
        if not (i % SAMPLE_EVERY == 0 or t[i] in entry_i):
            continue
        w = c[i - WINDOW + 1:i + 1]
        chk['sampled'] += 1
        a = zone_ref(w, WINDOW - 1)
        b = zone_ref(w, WINDOW - 2)
        if a != (m9[i], t9[i], b9[i]) or b != (m8[i], t8[i], b8[i]):
            chk['mismatch'].append(f'{pair} bar {fc.iso(t[i])}: fast {(m9[i], t9[i], b9[i], m8[i], t8[i], b8[i])!r} / '
                                   f'reference {a + b!r}')
        z = fc.zone_entry(w)
        s95 = fc.ZONE_SHARE
        mine = None
        if in_band(1, s95, m9[i], t9[i], b9[i]) and not in_band(1, s95, m8[i], t8[i], b8[i]):
            mine = ('SELL', m9[i], t9[i], b9[i])
        elif in_band(-1, s95, m9[i], t9[i], b9[i]) and not in_band(-1, s95, m8[i], t8[i], b8[i]):
            mine = ('BUY', m9[i], t9[i], b9[i])
        if mine != z:
            chk['mismatch'].append(f'{pair} bar {fc.iso(t[i])}: 95% entry here {mine!r} / zone_entry {z!r}')
        chk['email95'] += int(z is not None)

    log(f'  {pair}: bars {n}, entries {len(rows)} (already {sum(r["already"] for r in rows)}), short of 600 in '
        f'[START, END) {short}; zones {t_zone:.1f}s, all {time.time() - t_pair:.1f}s')
    return rows, dict(pair=pair, bars=n, entries=len(rows))


def compute(cache, start, end, load_from, log):
    ld = fc.LoadStats()
    chk = dict(sampled=0, email95=0, mismatch=[], both=[])
    rows, pairs = [], []
    for pi, pair in enumerate(PAIRS):
        r, info = compute_pair(cache, pi, pair, start, end, load_from, ld, chk, log)
        rows.extend(r)
        pairs.append(info)
    rows.sort(key=lambda r: (r['_T'], r['pi']))
    return rows, pairs, ld, chk


# ---------------------------------------------------------------- 数
def way_stats(rows, w):
    done = [r for r in rows if not r['already'] and r[w + '_result'] in ('reached', 'failed')]
    op = [r for r in rows if not r['already'] and r[w + '_result'] == 'open']
    rc = [r for r in done if r[w + '_result'] == 'reached']
    fl = [r for r in done if r[w + '_result'] == 'failed']
    pips = [r[w + '_pips'] for r in done]
    maes = [r[w + '_mae'] for r in done]
    bars = [r[w + '_bars'] for r in done]
    ops = [r[w + '_pips'] for r in op]
    nd = len(done)
    s = fc.add_in_order(pips)
    return dict(reached=len(rc), failed=len(fl), open=len(op),
                rate=100 * len(rc) / nd if nd else None,
                pipsSum=s if nd else None, pipsMean=s / nd if nd else None, pipsMedian=fc.median(pips),
                reachedPipsMean=fc.mean_in_order([r[w + '_pips'] for r in rc]),
                failedPipsMean=fc.mean_in_order([r[w + '_pips'] for r in fl]),
                maeMedian=fc.median(maes), maeMax=max(maes) if maes else None,
                barsMedian=fc.median(bars), barsMax=max(bars) if bars else None,
                openPipsSum=fc.add_in_order(ops) if ops else None, openPipsWorst=min(ops) if ops else None)


def group(rows):
    return dict(entries=len(rows), already=sum(r['already'] for r in rows), A=way_stats(rows, 'A'),
                B=way_stats(rows, 'B'))


def summary_of(rows, pairs, start, end, load_from):
    groups = {'all': group(rows)}
    for p in PAIRS:
        groups[p] = group([r for r in rows if r['pair'] == p])
    for sd in ('BUY', 'SELL'):
        groups[sd] = group([r for r in rows if r['side'] == sd])
    return dict(meta=dict(start=fc.iso(start), end=fc.iso(end), loadFrom=fc.iso(load_from)), pairs=pairs,
                groups=groups)


# ---------------------------------------------------------------- 書く（--self）
def js_json(v, ind=''):
    """JSON.stringify(v, null, 2) と同じ形（数は js_str）"""
    nxt = ind + '  '
    if v is None:
        return 'null'
    if isinstance(v, bool):
        return 'true' if v else 'false'
    if isinstance(v, (int, float)):
        return js_str(v) if math.isfinite(v) else 'null'
    if isinstance(v, str):
        return json.dumps(v, ensure_ascii=False)
    if isinstance(v, dict):
        if not v:
            return '{}'
        return '{\n' + ',\n'.join(nxt + json.dumps(k, ensure_ascii=False) + ': ' + js_json(x, nxt)
                                  for k, x in v.items()) + '\n' + ind + '}'
    if not v:
        return '[]'
    return '[\n' + ',\n'.join(nxt + js_json(x, nxt) for x in v) + '\n' + ind + ']'


def write_self(out, rows, summ):
    os.makedirs(out, exist_ok=True)
    with open(os.path.join(out, 'rows.csv'), 'w', encoding='utf-8', newline='') as f:
        f.write(','.join(COLS) + '\n')
        for r in rows:
            f.write(','.join(cell(r[c]) for c in COLS) + '\n')
    with open(os.path.join(out, 'summary.json'), 'w', encoding='utf-8') as f:
        f.write(js_json(summ) + '\n')


# ---------------------------------------------------------------- 比べる
class Cmp:
    def __init__(self):
        self.n = 0
        self.fields = 0
        self.near = 0
        self.near_max = 0.0

    def bad(self, msg):
        self.n += 1
        if self.n <= MAX_DIFF_LINES:
            print('DIFF ' + msg)

    def num(self, where, mine, theirs, near):
        self.fields += 1
        if mine is None or theirs is None:
            if not (mine is None and theirs is None):
                self.bad(f'{where}: TS {theirs!r} / Python {mine!r}')
            return
        if isinstance(theirs, bool) or not isinstance(theirs, (int, float)):
            self.bad(f'{where}: TS {theirs!r} (not a number) / Python {mine!r}')
            return
        a, b = float(mine), float(theirs)
        if a == b:
            return
        if near and math.isfinite(a) and math.isfinite(b) and abs(a - b) <= REL * max(abs(a), abs(b)):
            self.near += 1
            self.near_max = max(self.near_max, abs(a - b) / max(abs(a), abs(b)))
            return
        self.bad(f'{where}: TS {theirs!r} / Python {mine!r}')


def share_same(s, v):
    """share の欄: 空どうし、有限なら 1e-9 まで（1 より大きければ相対）、有限でなければ JS の文字で"""
    if v is None:
        return s == ''
    if not math.isfinite(v):
        return s == js_str(v)
    try:
        x = float(s)
    except ValueError:
        return False
    return math.isfinite(x) and abs(x - v) <= REL * max(1.0, abs(x), abs(v))


def compare_rows(C, mine, head, theirs):
    if head != COLS:
        C.bad(f'rows.csv header: TS {",".join(head)} / expected {",".join(COLS)}')
    if len(theirs) != len(mine):
        C.bad(f'rows: TS {len(theirs)}, Python {len(mine)}')

    def key(r):
        return (r.get('pair'), r.get('open'))
    tk = {}
    for r in theirs:
        if key(r) in tk:
            C.bad(f'rows.csv: {key(r)} has two rows')
        tk[key(r)] = r
    mk = {key(r): r for r in mine}
    for k in mk:
        if k not in tk:
            C.bad(f'row {k}: in Python ({mk[k]["side"]}, already {mk[k]["already"]}), missing in rows.csv')
    for k in tk:
        if k not in mk:
            C.bad(f'row {k}: in rows.csv ({tk[k].get("side")}, already {tk[k].get("already")}), missing in Python')
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
        where = f'row {r["pair"]} open={r["open"]} {r["side"]}'
        for col in COLS:
            s = t.get(col)
            s = '' if s is None else s
            C.fields += 1
            v = r[col]
            if col in SHARE_COLS:
                ok = share_same(s, v)
                if ok and v is not None and math.isfinite(v) and float(s) != v:
                    C.near += 1
                    C.near_max = max(C.near_max, abs(float(s) - v))
            else:
                ok = s == cell(v)
            if not ok:
                C.bad(f'{where} {col}: TS {s!r} / Python {cell(v)!r}')


def pick(obj, key):
    if not isinstance(obj, dict):
        return None
    return obj.get(key, obj.get(key.replace('/', '_')))


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
    tp = S.get('pairs')
    tpl = tp if isinstance(tp, list) else []
    tpd = {x.get('pair'): x for x in tpl if isinstance(x, dict)}
    if [x.get('pair') for x in tpl if isinstance(x, dict)] != PAIRS:
        C.bad(f'pairs: TS {[x.get("pair") for x in tpl if isinstance(x, dict)]} / Python {PAIRS}')
    for info in mine['pairs']:
        t = tpd.get(info['pair'])
        if t is None:
            C.bad(f'pairs.{info["pair"]}: missing in summary.json')
            continue
        for k in ('bars', 'entries'):
            C.num(f'pairs.{info["pair"]}.{k}', info[k], t.get(k), False)
        skipped += [f'pairs.{info["pair"]}.{k}' for k in t if k not in ('pair', 'bars', 'entries')]
    tg = S.get('groups')
    if not isinstance(tg, dict):
        C.bad('groups: missing in summary.json')
        return skipped
    for g in GROUPS:
        th = pick(tg, g)
        if not isinstance(th, dict):
            C.bad(f'groups.{g}: missing in summary.json')
            continue
        mg = mine['groups'][g]
        for k in G_KEYS:
            C.num(f'groups.{g}.{k}', mg[k], th.get(k), False)
        for w in WAYS:
            tw = th.get(w)
            if not isinstance(tw, dict):
                C.bad(f'groups.{g}.{w}: missing in summary.json')
                continue
            for k in W_KEYS:
                if k not in tw:
                    C.bad(f'groups.{g}.{w}.{k}: missing in summary.json')
                    continue
                C.num(f'groups.{g}.{w}.{k}', mg[w][k], tw[k], k in W_NEAR)
            skipped += [f'groups.{g}.{w}.{k}' for k in tw if k not in W_KEYS]
        skipped += [f'groups.{g}.{k}' for k in th if k not in G_KEYS + list(WAYS)]
    known = set(GROUPS) | {p.replace('/', '_') for p in PAIRS}
    for k in tg:
        if k not in known:
            C.bad(f'groups.{k}: in summary.json, not a group here ({", ".join(GROUPS)})')
    skipped += [k for k in S if k not in ('meta', 'pairs', 'groups')]
    return skipped


def fmt(v):
    return '-' if v is None else js_str(v)


def group_line(name, g):
    out = f'  {name}: entries {g["entries"]}, already {g["already"]}'
    for w in WAYS:
        s = g[w]
        rate = '-' if s['rate'] is None else f'{s["rate"]:.2f}%'
        out += (f'; {w}: reached {s["reached"]}, failed {s["failed"]}, open {s["open"]}, rate {rate}, '
                f'pips sum {fmt(s["pipsSum"])} / mean {fmt(s["pipsMean"])}')
    return out


# ---------------------------------------------------------------- 全体
def main():
    ap = argparse.ArgumentParser(description='research/macd90-spec.md の独立した計算し直し')
    ap.add_argument('--cache', required=True, help='GMO の日のファイルのフォルダ')
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument('--out', help='TypeScript の rows.csv と summary.json のフォルダ（読むだけ）')
    g.add_argument('--self', dest='self_out', help='比べずに、自分の rows.csv と summary.json をここに書く')
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
    print(f'macd90-check: entries closing in [{fc.iso(start)}, {fc.iso(end)}), 1-hour bars from {fc.iso(load_from)}; '
          f'the band {S_IN!r} in, {S_GO!r} reached')
    if all(period[k] == DEFAULTS[k] for k in DEFAULTS):
        print('  the period is the spec\'s')
    else:
        print('  the period is NOT the spec\'s (START, END or LOAD_FROM set)')

    rows, pairs, ld, chk = compute(a.cache, start, end, load_from, print)
    summ = summary_of(rows, pairs, start, end, load_from)
    print(f'  files read {ld.files}, failed {ld.failed}' + (' (' + '; '.join(ld.failed_ex) + ')' if ld.failed else ''))
    print(f'  the fast MACD against pineEma/macd/zoneAt as written and zone_entry at 95%: bars checked '
          f'{chk["sampled"]} (95% entries among them {chk["email95"]}), mismatches {len(chk["mismatch"])}; '
          f'bars in both bands {len(chk["both"])}')

    if a.self_out is not None:
        write_self(a.self_out, rows, summ)
        for name in GROUPS:
            print(group_line(name, summ['groups'][name]))
        bad = len(chk['mismatch']) + len(chk['both'])
        for m in (chk['mismatch'] + chk['both'])[:MAX_DIFF_LINES]:
            print('CHECK ' + m)
        print(f'wrote {len(rows)} rows and summary.json to {a.self_out} ({time.time() - t_all:.1f}s)')
        sys.exit(1 if bad else 0)

    C = Cmp()
    for m in chk['mismatch']:
        C.bad('fast MACD: ' + m)
    for m in chk['both']:
        C.bad('both bands at once: ' + m)
    compare_rows(C, rows, head, ts_rows)
    skipped = compare_summary(C, summ, S)
    print(f'compared {C.fields} fields ({len(rows)} Python rows, {len(ts_rows)} TS rows): {C.near} equal only within '
          f'{REL:g} (largest {C.near_max:.3g}), {C.n} different')
    if skipped:
        print('in summary.json, not compared: ' + ', '.join(skipped[:20]) + (' ...' if len(skipped) > 20 else ''))
    print(f'({time.time() - t_all:.1f}s)')
    if C.n:
        print(f'PYTHON DISAGREES: {C.n} differences')
        sys.exit(1)
    for name in GROUPS:
        print(group_line(name, summ['groups'][name]))
    print('PYTHON AGREES')
    sys.exit(0)


if __name__ == '__main__':
    main()
