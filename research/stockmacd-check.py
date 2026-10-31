#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""#390（docs §8.133）: research/stockmacd.ts の数え直し（Python。標準ライブラリだけ。同じ Yahoo のファイルから）。

research/stockmacd-spec.md だけから書いた（research/stockmacd.ts・live-chart/stocks.ts・_shared/macd-level.ts は
読んでいない）。株（米国・日本）の1時間足に、1時間足の MACD のメールの決まり（v8）をかけ、メール1通ずつを
オーナーの持ち方（E の指値・利確は E の x%・損切りなし）で、利確の4つの大きさごとに追い、TypeScript の
rows.csv の全部の行・全部の列と、summary.json の shares と sizes の数を全部比べる。

自分で書いたもの: Yahoo の答えから足を作る（終わりの点のつなぎ方・END・丸め）、メールの作り方、1通の追い方
（約定・利確・pct・mae・持った時間）、表の数、比べ方。
research/flowz-check.py（#371 で TypeScript と別に書かれ、行と数がすべて一致したもの）から使うもの:
  round_chart  … Number(v.toFixed(d)): double の正確な値を、半分は 0 から遠い方へ（Decimal の ROUND_HALF_UP）。
  zone_entry   … 600本の窓の MACD（12・26・9。EMA は最初の n 本を古い順に足した単純平均から、以後
                 alpha * x + (1 - alpha) * prev、alpha = 2 / (n + 1)。signal は line の最初の値から）で、
                 窓の 599 番が 120 本の枠の 95% の帯に入ったか（598 番も同じ窓で、それ自身の 120 本で見る）。
  median・add_in_order … 偶数個は真ん中2つの平均。和は前から1つずつ足す。
（どれも spec の決まりと同じことを読んで確かめた。）

使い方:
  python3 -I research/stockmacd-check.py --files DIR --out OUT [--symbols SYM1,SYM2,...]
    DIR: <DIR>/<SYMBOL>.json（Yahoo の v8 chart の答えそのまま）
    OUT: research/stockmacd.ts の出力（rows.csv と summary.json）。読むだけ。
    --symbols: 株の並びを変える（合成データの確かめ用）。`.T` で終われば jp、ほかは us。無ければ spec の22。
ネットワークには出ない。書くのは標準出力・標準エラーだけ（flowz-check.py の読み込みでも .pyc を書かない）。
終了コード: 0 = 全部一致（最後の行 `stockmacd-check: PASSED rows=N`）、1 = 食い違いあり
（最初の20個と総数を出す）、2 = 入力の誤り（無いファイルなど。名前を出す）。
"""
import argparse
import csv
import datetime
import importlib.util
import json
import math
import os
import sys

sys.dont_write_bytecode = True   # flowz-check.py を読み込むときに __pycache__ を書かない
HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location('flowz_check', os.path.join(HERE, 'flowz-check.py'))
fc = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(fc)

# ---------------------------------------------------------------- spec の数
SYMBOLS = [('NVDA', 'us'), ('INTC', 'us'), ('AAPL', 'us'), ('MSFT', 'us'), ('GOOGL', 'us'), ('AMZN', 'us'),
           ('META', 'us'), ('TSLA', 'us'),
           ('7203.T', 'jp'), ('6758.T', 'jp'), ('9984.T', 'jp'), ('8306.T', 'jp'), ('6861.T', 'jp'), ('9983.T', 'jp'),
           ('8035.T', 'jp'), ('7974.T', 'jp'), ('9432.T', 'jp'), ('6501.T', 'jp'), ('7267.T', 'jp'), ('6920.T', 'jp'),
           ('4063.T', 'jp'), ('8058.T', 'jp')]
DECIMALS = {'us': 2, 'jp': 1}          # チャートの小数の桁
END_ISO = '2026-10-31T00:00:00Z'
SIZES = [(0.1, '0.1'), (0.25, '0.25'), (0.5, '0.5'), (1.0, '1')]   # 利確の大きさ（E の %）と、その String(x)
WINDOW = 600
DAY_S = 86400
HOUR_MS = 3600000
REL = 1e-9
MAX_DIFF_LINES = 20

COLS = ['sym', 'market', 'i', 'open', 'side', 'E', 'x', 'TP', 'filled', 'fillMode', 'fillT', 'F', 'exitMode', 'exitT',
        'exit', 'held', 'pct', 'mae', 'holdH', 'holdBars', 'sameBar']
TEXT_COLS = {'sym', 'market', 'open', 'side', 'fillMode', 'fillT', 'exitMode', 'exitT'}
STAT_KEYS = ['mails', 'filled', 'unfilled', 'tp', 'held', 'sameBar', 'gapExits', 'win', 'pctSum', 'pctMean',
             'pctMedian', 'heldPctSum', 'heldPctMin', 'maeMedian', 'maeMax', 'holdMedian', 'holdMax']
COUNT_KEYS = {'mails', 'filled', 'unfilled', 'tp', 'held', 'sameBar', 'gapExits'}     # 同じ数
NEAR_KEYS = {'win', 'pctSum', 'pctMean', 'heldPctSum'}                                  # 和・平均（割合）: 相対 1e-9
# ほか（中央値・最大・最小）は同じ double
SHARE_TEXT = ['sym', 'market']
SHARE_TIME = ['first', 'last']
SHARE_COUNT = ['bars', 'judged', 'mails', 'buys', 'sells']

_EPOCH = datetime.datetime(1970, 1, 1, tzinfo=datetime.timezone.utc)


class InputError(Exception):
    pass


def ms_of(text):
    d = datetime.datetime.fromisoformat(str(text).strip().replace('Z', '+00:00'))
    if d.tzinfo is None:
        raise ValueError(f'no time zone: {text}')
    return (d - _EPOCH) // datetime.timedelta(milliseconds=1)


def iso(ms):
    """YYYY-MM-DDTHH:MM:SSZ（足の始まりは秒の整数なので、ミリ秒は無い）"""
    if ms % 1000:
        raise InputError(f'time with milliseconds: {ms}')
    d = _EPOCH + datetime.timedelta(milliseconds=int(ms))
    return d.strftime('%Y-%m-%dT%H:%M:%SZ')


END_MS = ms_of(END_ISO)


# ---------------------------------------------------------------- 足（Yahoo の答えから）
def is_num(v):
    """JS の「有限の数」: JSON の数（true/false は数でない）で、有限"""
    return type(v) in (int, float) and math.isfinite(v)


def _get(obj, key):
    return obj.get(key) if isinstance(obj, dict) else None


def _at(arr, k):
    return arr[k] if isinstance(arr, list) and 0 <= k < len(arr) else None


def raw_bars(body, where):
    """spec「The bars」の walk（丸める前・END の前）。足は [t ms, open, high, low, close]。"""
    result = _get(_get(body, 'chart'), 'result')
    r = _at(result, 0)
    if not isinstance(r, dict):
        raise InputError(f'{where}: chart.result[0] is missing')
    ts = r.get('timestamp')
    if ts is None:
        ts = []
    if not isinstance(ts, list):
        raise InputError(f'{where}: chart.result[0].timestamp is not an array')
    q = _at(_get(_get(r, 'indicators'), 'quote'), 0)
    if not isinstance(q, dict):
        raise InputError(f'{where}: chart.result[0].indicators.quote[0] is missing')
    reg = _get(_get(_get(r, 'meta'), 'currentTradingPeriod'), 'regular')
    s_start, s_end = _get(reg, 'start'), _get(reg, 'end')
    has_session = is_num(s_start) and is_num(s_end) and s_end > s_start
    opens, highs, lows, closes = q.get('open'), q.get('high'), q.get('low'), q.get('close')

    bars = []
    last_t = None          # 最後に足した足の時刻（秒）
    joined = 0
    for k in range(len(ts)):
        tk = ts[k]
        o, h, l, c = _at(opens, k), _at(highs, k), _at(lows, k), _at(closes, k)
        # 1. 有限の数でない・終値か安値が 0 以下・高値 < 安値 は飛ばす
        if not (is_num(tk) and is_num(o) and is_num(h) and is_num(l) and is_num(c)):
            continue
        o, h, l, c = float(o), float(h), float(l), float(c)
        if c <= 0 or l <= 0 or h < l:
            continue
        # 2. 取引時間の終わり以後で、最後に足した足から1日未満: その足につなぐ（大引けの点）
        if has_session and tk >= s_end and bars and tk - last_t < DAY_S:
            b = bars[-1]
            b[2] = max(b[2], h)
            b[3] = min(b[3], l)
            b[4] = c
            joined += 1
            continue
        # 3. ほかは足す
        bars.append([tk * 1000, o, h, l, c])
        last_t = tk
    return bars, joined, has_session


def read_bars(path, market):
    """1つの株の足: walk、END より前に始まる足だけ、チャートの桁に丸める"""
    if not os.path.isfile(path):
        raise InputError(f'missing file: {path}')
    try:
        with open(path, encoding='utf-8') as fh:
            body = json.load(fh)
    except (OSError, ValueError) as e:
        raise InputError(f'cannot read {path}: {e}')
    bars, joined, has_session = raw_bars(body, path)
    bars = [b for b in bars if b[0] < END_MS]
    d = DECIMALS[market]
    out = [[b[0]] + [fc.round_chart(v, d) for v in b[1:]] for b in bars]
    return out, joined, has_session


# ---------------------------------------------------------------- メールと、1通の追い方
def emails_of(bars):
    """i >= 599 の足ごとに、i-599..i の終値の窓で決める。[(i, side, E)]（i の順）"""
    closes = [b[4] for b in bars]
    out = []
    for i in range(WINDOW - 1, len(bars)):
        d = fc.zone_entry(closes[i - WINDOW + 1:i + 1])
        if d is not None:
            out.append((i, d[0], closes[i]))
    return out


def fill_of(bars, i, side, E):
    """E の指値（次の足から。良い値段ならすぐ）: (f, F, mode) か None"""
    for j in range(i + 1, len(bars)):
        _, o, h, l, _c = bars[j]
        if side == 'BUY':
            if o <= E:
                return j, o, 'open'
            if l <= E:
                return j, E, 'limit'
        else:
            if o >= E:
                return j, o, 'open'
            if h >= E:
                return j, E, 'limit'
    return None


def follow(bars, sym, market, i, side, E, x, fill):
    """1通・1つの大きさの行（spec の列。空は None か ''）"""
    d = 1 if side == 'BUY' else -1
    TP = E * (1 + d * x / 100)
    row = dict(sym=sym, market=market, i=i, open=iso(bars[i][0]), side=side, E=E, x=x, TP=TP, filled=0,
               fillMode='', fillT='', F=None, exitMode='', exitT='', exit=None, held=0, pct=None, mae=None,
               holdH=None, holdBars=None, sameBar=0)
    if fill is None:
        return row
    f, F, fmode = fill
    n = len(bars)
    same = 0
    if fmode == 'limit':
        start = f + 1
        same = 1 if (bars[f][2] >= TP if d == 1 else bars[f][3] <= TP) else 0
    else:
        start = f
    ex, exit_px, xmode = None, None, ''
    for k in range(start, n):
        _, o, h, l, _c = bars[k]
        if d == 1:
            if o >= TP:
                ex, exit_px, xmode = k, o, 'open'
                break
            if h >= TP:
                ex, exit_px, xmode = k, TP, 'limit'
                break
        else:
            if o <= TP:
                ex, exit_px, xmode = k, o, 'open'
                break
            if l <= TP:
                ex, exit_px, xmode = k, TP, 'limit'
                break
    held = 0
    if ex is None:
        ex, exit_px, held = n - 1, bars[n - 1][4], 1
    pct = d * (exit_px - F) / F * 100
    worst = -math.inf
    for b in range(f, ex + 1):
        adv = bars[b][3] if d == 1 else bars[b][2]
        v = d * (F - adv) / F * 100
        if v > worst:
            worst = v
    mae = max(0, worst)
    row.update(filled=1, fillMode=fmode, fillT=iso(bars[f][0]), F=F, exitMode=xmode, exitT=iso(bars[ex][0]),
               exit=exit_px, held=held, pct=pct, mae=mae, holdH=(bars[ex][0] - bars[f][0]) / HOUR_MS,
               holdBars=ex - f, sameBar=same)
    return row


def stats_of(rows):
    """sizes の1つの表。和・平均は約定した行を行の順に足す。和は行が無ければ 0（ほかの研究の statsOf と同じ）。"""
    fl = [r for r in rows if r['filled']]
    nf = len(fl)
    tp = sum(1 for r in fl if r['exitMode'])
    pcts = [r['pct'] for r in fl]
    held_pcts = [r['pct'] for r in fl if r['held']]
    maes = [r['mae'] for r in fl]
    holds = [r['holdH'] for r in fl]
    pct_sum = fc.add_in_order(pcts)
    return dict(mails=len(rows), filled=nf, unfilled=len(rows) - nf, tp=tp, held=len(held_pcts),
                sameBar=sum(r['sameBar'] for r in rows), gapExits=sum(1 for r in fl if r['exitMode'] == 'open'),
                win=100 * tp / nf if nf else None,
                pctSum=pct_sum, pctMean=pct_sum / nf if nf else None, pctMedian=fc.median(pcts),
                heldPctSum=fc.add_in_order(held_pcts), heldPctMin=min(held_pcts) if held_pcts else None,
                maeMedian=fc.median(maes), maeMax=max(maes) if maes else None,
                holdMedian=fc.median(holds), holdMax=max(holds) if holds else None)


def compute(files_dir, symbols, log=None):
    """全部の行（株の順・i・x）と、shares（株ごと）と、sizes（大きさごとの表）"""
    rows = []
    shares = []
    for sym, market in symbols:
        bars, joined, has_session = read_bars(os.path.join(files_dir, sym + '.json'), market)
        mails = emails_of(bars)
        n = len(bars)
        shares.append(dict(sym=sym, market=market, bars=n, first=iso(bars[0][0]) if n else None,
                           last=iso(bars[-1][0]) if n else None, judged=max(0, n - (WINDOW - 1)),
                           mails=len(mails), buys=sum(1 for m in mails if m[1] == 'BUY'),
                           sells=sum(1 for m in mails if m[1] == 'SELL')))
        for i, side, E in mails:
            fill = fill_of(bars, i, side, E)
            for x, _key in SIZES:
                rows.append(follow(bars, sym, market, i, side, E, x, fill))
        if log:
            log(f'{sym} ({market}): bars={n} joined={joined} session={"yes" if has_session else "no"} '
                f'mails={len(mails)}')
    sizes = {}
    for x, key in SIZES:
        xr = [r for r in rows if r['x'] == x]
        t = {'all': stats_of(xr), 'us': stats_of([r for r in xr if r['market'] == 'us']),
             'jp': stats_of([r for r in xr if r['market'] == 'jp'])}
        for sym, _m in symbols:
            t[sym] = stats_of([r for r in xr if r['sym'] == sym])
        sizes[key] = t
    return rows, shares, sizes


# ---------------------------------------------------------------- 比べる
class Cmp:
    def __init__(self):
        self.n = 0

    def bad(self, msg):
        self.n += 1
        if self.n <= MAX_DIFF_LINES:
            print('DIFF ' + msg)

    def num(self, where, mine, theirs, near=False):
        """JSON の数（theirs）と自分の数。None は null。near なら相対 1e-9 まで同じとみる。"""
        if mine is None or theirs is None:
            if not (mine is None and theirs is None):
                self.bad(f'{where}: TS {theirs!r} / Python {mine!r}')
            return
        if type(theirs) not in (int, float):
            self.bad(f'{where}: TS {theirs!r} (not a number) / Python {mine!r}')
            return
        a, b = float(mine), float(theirs)
        if a == b:
            return
        if near and math.isfinite(a) and math.isfinite(b) and abs(a - b) <= REL * max(abs(a), abs(b)):
            return
        self.bad(f'{where}: TS {theirs!r} / Python {mine!r}')

    def time(self, where, mine, theirs):
        """summary の時刻（ISO）。同じ文字列か、同じ時刻（.000Z の書き方の違いだけ）なら同じ。"""
        if mine is None or theirs is None:
            if not (mine is None and theirs is None):
                self.bad(f'{where}: TS {theirs!r} / Python {mine!r}')
            return
        if theirs == mine:
            return
        try:
            if isinstance(theirs, str) and ms_of(theirs) == ms_of(mine):
                return
        except ValueError:
            pass
        self.bad(f'{where}: TS {theirs!r} / Python {mine!r}')


def compare_rows(C, mine, path):
    try:
        with open(path, encoding='utf-8', newline='') as fh:
            table = [r for r in csv.reader(fh) if r]
    except OSError as e:
        raise InputError(f'cannot read {path}: {e}')
    if not table:
        raise InputError(f'{path} is empty')
    head, theirs = table[0], table[1:]
    if head != COLS:
        C.bad(f'rows.csv header: TS {",".join(head)} / expected {",".join(COLS)}')
        return
    if len(theirs) != len(mine):
        C.bad(f'rows: TS {len(theirs)}, Python {len(mine)}')
    for n, (m, t) in enumerate(zip(mine, theirs)):
        line = n + 2                       # ファイルの行番号（見出しが1）
        tag = f'{m["sym"]} i={m["i"]} x={m["x"]:g}'
        if len(t) != len(COLS):
            C.bad(f'rows.csv line {line} ({tag}): {len(t)} fields, expected {len(COLS)}')
            continue
        for col, tv in zip(COLS, t):
            mv = m[col]
            where = f'rows.csv line {line} ({tag}) {col}'
            if col in TEXT_COLS:
                if tv != mv:
                    C.bad(f'{where}: TS {tv!r} / Python {mv!r}')
            elif mv is None:
                if tv != '':
                    C.bad(f'{where}: TS {tv!r} / Python empty')
            else:
                try:
                    tf = float(tv)
                except ValueError:
                    C.bad(f'{where}: TS {tv!r} (not a number) / Python {mv!r}')
                    continue
                if tf != float(mv):
                    C.bad(f'{where}: TS {tv!r} / Python {mv!r}')


def stats_dicts(node, path, out):
    """sizes[x] の下の表（mails と filled を持つ dict）を、(名前, 道, 表) で集める。名前は表の sym か、置かれた鍵。"""
    if isinstance(node, dict):
        if 'mails' in node and 'filled' in node:
            name = node['sym'] if isinstance(node.get('sym'), str) else (path[-1] if path else None)
            out.append((name, path, node))
            return
        for k, v in node.items():
            stats_dicts(v, path + [str(k)], out)
    elif isinstance(node, list):
        for k, v in enumerate(node):
            stats_dicts(v, path + [str(k)], out)


def compare_summary(C, symbols, shares, sizes, path, notes):
    try:
        with open(path, encoding='utf-8') as fh:
            S = json.load(fh)
    except (OSError, ValueError) as e:
        raise InputError(f'cannot read {path}: {e}')
    if not isinstance(S, dict):
        raise InputError(f'{path}: not a JSON object')

    # meta
    meta = S.get('meta')
    if not isinstance(meta, dict):
        C.bad('summary.meta: missing')
    else:
        C.time('summary.meta.end', END_ISO, meta.get('end'))
        ts = meta.get('sizes')
        if not isinstance(ts, list) or len(ts) != len(SIZES):
            C.bad(f'summary.meta.sizes: TS {ts!r} / Python {[x for x, _k in SIZES]!r}')
        else:
            for k, (x, _key) in enumerate(SIZES):
                C.num(f'summary.meta.sizes[{k}]', x, ts[k])
        want = [s for s, _m in symbols]
        if meta.get('symbols') != want:
            C.bad(f'summary.meta.symbols: TS {meta.get("symbols")!r} / Python {want!r}')

    # shares（配列なら順に、dict なら sym で）
    th = S.get('shares')
    if isinstance(th, dict):
        th = [th.get(s['sym']) for s in shares]
    if not isinstance(th, list):
        C.bad('summary.shares: missing')
        th = []
    if len(th) != len(shares):
        C.bad(f'summary.shares: TS {len(th)} entries, Python {len(shares)}')
    for m, t in zip(shares, th):
        where = f'summary.shares[{m["sym"]}]'
        if not isinstance(t, dict):
            C.bad(f'{where}: TS {t!r}')
            continue
        for k in SHARE_TEXT:
            if t.get(k) != m[k]:
                C.bad(f'{where}.{k}: TS {t.get(k)!r} / Python {m[k]!r}')
        for k in SHARE_TIME:
            if k not in t:
                C.bad(f'{where}.{k}: missing')
            else:
                C.time(f'{where}.{k}', m[k], t[k])
        for k in SHARE_COUNT:
            if k not in t:
                C.bad(f'{where}.{k}: missing')
            else:
                C.num(f'{where}.{k}', m[k], t[k])
        extra = sorted(set(t) - set(SHARE_TEXT) - set(SHARE_TIME) - set(SHARE_COUNT))
        if extra:
            notes.append(f'{where}: keys not in the spec (not compared): {", ".join(extra)}')

    # sizes（鍵は String(x)。その下の表を、名前（all・us・jp・株）で）
    tz = S.get('sizes')
    if not isinstance(tz, dict):
        C.bad('summary.sizes: missing')
        return
    want_keys = [key for _x, key in SIZES]
    extra = sorted(set(tz) - set(want_keys))
    if extra:
        C.bad(f'summary.sizes: keys not in the spec: {", ".join(extra)}')
    for _x, key in SIZES:
        if key not in tz:
            C.bad(f'summary.sizes["{key}"]: missing')
            continue
        found = []
        stats_dicts(tz[key], [], found)
        by_name = {}
        for name, p, d in found:
            by_name.setdefault(name, []).append((p, d))
        for name in sorted(set(by_name) - set(sizes[key]), key=str):
            C.bad(f'summary.sizes["{key}"]: a table not in the spec at {"/".join(by_name[name][0][0])}')
        for name, mine in sizes[key].items():
            got = by_name.get(name, [])
            where = f'summary.sizes["{key}"].{name}'
            if len(got) != 1:
                C.bad(f'{where}: found {len(got)} tables (expected 1)')
                continue
            t = got[0][1]
            for k in STAT_KEYS:
                if k not in t:
                    C.bad(f'{where}.{k}: missing')
                    continue
                C.num(f'{where}.{k}', mine[k], t[k], near=k in NEAR_KEYS)
            ex = sorted(set(t) - set(STAT_KEYS) - {'sym', 'market'})
            if ex:
                notes.append(f'{where}: keys not in the spec (not compared): {", ".join(ex)}')


def parse_symbols(text):
    if text is None:
        return list(SYMBOLS)
    syms = [s.strip() for s in text.split(',') if s.strip()]
    if not syms:
        raise InputError('--symbols is empty')
    if len(set(syms)) != len(syms):
        raise InputError('--symbols has a symbol twice')
    return [(s, 'jp' if s.endswith('.T') else 'us') for s in syms]


def main():
    ap = argparse.ArgumentParser(description='research/stockmacd.ts の数え直し（research/stockmacd-spec.md）')
    ap.add_argument('--files', required=True, help='<DIR>/<SYMBOL>.json（Yahoo の答え）のある DIR')
    ap.add_argument('--out', required=True, help='research/stockmacd.ts の出力（rows.csv・summary.json）のある DIR')
    ap.add_argument('--symbols', help='株の並び（, で区切る）。無ければ spec の22')
    a = ap.parse_args()

    def log(msg):
        print(msg, file=sys.stderr)

    try:
        symbols = parse_symbols(a.symbols)
        rows, shares, sizes = compute(a.files, symbols, log)
        C = Cmp()
        notes = []
        compare_rows(C, rows, os.path.join(a.out, 'rows.csv'))
        compare_summary(C, symbols, shares, sizes, os.path.join(a.out, 'summary.json'), notes)
    except InputError as e:
        print(f'stockmacd-check: ERROR {e}')
        sys.exit(2)
    for s in notes[:MAX_DIFF_LINES]:
        log('NOTE ' + s)
    if C.n:
        if C.n > MAX_DIFF_LINES:
            print(f'... {C.n - MAX_DIFF_LINES} more differences not shown')
        print(f'stockmacd-check: FAILED differences={C.n} rows={len(rows)}')
        sys.exit(1)
    print(f'stockmacd-check: PASSED rows={len(rows)}')
    sys.exit(0)


if __name__ == '__main__':
    main()
