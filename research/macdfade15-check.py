#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""research/macdfade15-spec.md recomputed apart from the TypeScript (Python, the standard library only, from the same
GMO files).

The owner (2026-11-17): 「もうシンプル96%の足できたら逆張りのメールちょうだい」,
then 「メールを1時間足から15分足に変更」.
One email at a closed 15-minute bar whose close puts the MACD line (600 closes, the newest 120 bars' pane) at SHARE of
the pane's top (bottom) when the bar before's close was not, on the fade side (top SELL, bottom BUY), the price in
only. Measured as the owner holds (CLAUDE.md: take profit TP pips, no stop, every email taken): the fade trade, the
flow trade beside it, and the same holding with no signal (the baseline).

Written from the spec's text alone: research/macdfade15.ts (the TypeScript) was not read. Reused, as the spec names
them: research/flowz-check.py (load_tf, keys_of, round_chart, M1, Seek, is_possibly_closed, js_round, iso, ms_of,
add_in_order, median, zone_entry: written apart from the TypeScript and held against it before) and research/
macd90-check.py (zones_of, zone_ref, in_band, js_str, js_div: the same). Everything else (the bars in range, the
signal, the weekend gate, the two trades, the follow, the baseline, closeVsMinute, prevAt, G, the files' forms) is
written here from the spec.

What is held against the TypeScript's files, all exactly (no tolerance):
  rows.csv      every row, cell by cell, as text (numbers as JavaScript's String() writes a double), and the header;
  summary.json  every field: its keys in their order, every number as a double, every string; then the whole file
                as text (JSON.stringify(x, null, 1), no newline at the end).
Checks of the Python's own work (a failure is counted as a difference too):
  - Z(n) and Zp(n) of the fast form (macd90-check.py zones_of) equal the slow form (zone_ref: pineEma, macd, zoneAt
    copied as they are) on the 600 closes, at every signal's bar and every ZONE_EVERY-th bar in range; Zp(n) also
    equals zoneAt at 598 of the MACD of the 599 closes ending at bar n-1 (the spec's claim, bit for bit);
  - at the email's v8 share (0.95) the signal's fade side equals flowz-check.py zone_entry (decideZoneOnWindow) on
    the same bars; no judged bar is at SHARE on both sides;
  - every entry trade, and every WALK_EVERY-th baseline trade, followed with the index equals the plain minute walk;
  - the counts add up (the spec's check 8).

TF (the spec's "On 1-hour bars (TF=1h)"): 15min (not given or empty) or 1h. The owner (2026-11-17, after the
15-minute run): 「やっぱりメールの判断1時間足で」. With 1h the chart is GMO's 1hour files, the reads 0, 3 and 5 minutes
after a close, LOAD_FROM's default 2023-10-01; the rest is the same. summary.json's meta ends with tf.

Usage:
  [TF=… START=… END=… LOAD_FROM=… SHARE=… TP=…] python3 -I research/macdfade15-check.py --cache DIR --out OUT
      DIR: <DIR>/<USD_JPY …>/<15min|1hour|1min>/<bid|ask>/<day key>.json (GMO's form)
      OUT: research/macdfade15.ts's rows.csv and summary.json (read only)
  [TF=… START=… END=… LOAD_FROM=… SHARE=… TP=…] python3 -I research/macdfade15-check.py --cache DIR --self OUT2
      writes the Python's own rows.csv and summary.json to OUT2, compares nothing
  The defaults are the spec's: TF 15min, START 2024-01-01T00:00:00Z, END 2026-11-10T21:00:00Z, LOAD_FROM
  2023-12-01T00:00:00Z (TF=1h: 2023-10-01T00:00:00Z), SHARE 0.96, TP 10.
Exit: 0 = every row and number the same (last line PYTHON AGREES); 1 = a difference, a failed check or a bad input
(last line PYTHON DISAGREES: n differences). --self: 0 when the Python's own checks pass.
Printed: counts (bars, minutes, judged, signals, entries, baseline entries) and differences; no result of a trade.
"""
import argparse
import bisect
import importlib.util
import json
import math
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))


def _load(name, file):
    sp = importlib.util.spec_from_file_location(name, os.path.join(HERE, file))
    mod = importlib.util.module_from_spec(sp)
    sp.loader.exec_module(mod)
    return mod


m90 = _load('macd90_check', 'macd90-check.py')
fc = m90.fc

MIN = fc.MIN
TF = os.environ.get('TF') or '15min'
if TF not in ('15min', '1h'):
    print(f'ERROR: TF {TF!r}: 15min or 1h')
    print('PYTHON DISAGREES: 1 differences')
    sys.exit(1)
STEP = (60 if TF == '1h' else 15) * MIN    # the chart's bar
FOLDER = '1hour' if TF == '1h' else '15min'   # GMO's folder of the chart's files
WINDOW = 600                         # macd-level.ts LEVEL_WINDOW
LO = WINDOW - 1                      # the first bar with 600 closes up to it
PAIRS = ['USD/JPY', 'EUR/JPY', 'AUD/JPY', 'EUR/USD', 'AUD/USD']
# signal-alerts/indicators.ts gmoIntervalsDue: the 15-minute chart's reads, the 1-hour chart's
READS = (0, 3, 5) if TF == '1h' else (0, 1, 3)
V8_SHARE = 0.95                      # macd-level.ts ZONE_SHARE (decideZoneOnWindow)
DEFAULTS = dict(START='2024-01-01T00:00:00Z', END='2026-11-10T21:00:00Z',
                LOAD_FROM='2023-10-01T00:00:00Z' if TF == '1h' else '2023-12-01T00:00:00Z')
DIRS = ('fade', 'flow')              # one entry's two rows: fade first
BASE_SIDES = ('BUY', 'SELL')         # one baseline entry's two trades: BUY first
COLS = ['dir', 'pair', 'open', 'T0', 'zside', 'side', 'entry', 'share0', 'target', 'result', 'T', 'exit', 'pips',
        'mae', 'minutes']
G_KEYS = ['trades', 'tp', 'open', 'pipsSum', 'pipsMean', 'pipsMedian', 'tpMinutesMedian', 'tpMinutesP90',
          'tpMinutesMax', 'within60', 'within1440', 'within10080', 'maeMedian', 'maeP90', 'maeMax', 'tpMaeMax',
          'openPipsSum', 'openPipsWorst', 'openMaeMax', 'openMinutesMax']
WITHIN = (60, 1440, 10080)
CVM_KEYS = ['bars', 'same', 'differ', 'noMinute', 'entrySame', 'entryDiffer', 'entryNoMinute']
ZONE_EVERY = 29                      # bars in range rebuilt the slow way (and every signal's bar)
WALK_EVERY = 97                      # baseline trades walked minute by minute (and every entry trade)
MAX_LINES = 30

js_str, js_div, in_band = m90.js_str, m90.js_div, m90.in_band


def die(msg):
    print('ERROR: ' + msg)
    print('PYTHON DISAGREES: 1 differences')
    sys.exit(1)


# ---------------------------------------------------------------- the environment (the spec's defaults)
def share_env():
    """SHARE: a number above 0, at most 1; not given or empty: 0.96"""
    v = os.environ.get('SHARE') or ''
    if v == '':
        return 0.96
    try:
        x = float(v)
    except ValueError:
        x = math.nan
    if not (0 < x <= 1):
        die(f'SHARE {v!r}: a number above 0 and at most 1')
    return x


def tp_env():
    """TP: a whole number of pips, at least 1; not given or empty: 10"""
    v = os.environ.get('TP') or ''
    if v == '':
        return 10
    try:
        x = float(v)
    except ValueError:
        x = math.nan
    if not (math.isfinite(x) and x.is_integer() and x >= 1):
        die(f'TP {v!r}: a whole number of pips, at least 1')
    return int(x)


def time_env(name):
    v = os.environ.get(name) or DEFAULTS[name]
    try:
        return fc.ms_of(v)
    except Exception:  # noqa: BLE001
        die(f'{name} {v!r}: not a time')


SHARE = share_env()
TP = tp_env()


# ---------------------------------------------------------------- numbers and files as JavaScript writes them
def cell(v):
    return v if isinstance(v, str) else js_str(v)


def js_json1(v, ind=''):
    """JSON.stringify(v, null, 1)"""
    nxt = ind + ' '
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
        return '{\n' + ',\n'.join(nxt + json.dumps(k, ensure_ascii=False) + ': ' + js_json1(x, nxt)
                                  for k, x in v.items()) + '\n' + ind + '}'
    if not v:
        return '[]'
    return '[\n' + ',\n'.join(nxt + js_json1(x, nxt) for x in v) + '\n' + ind + ']'


def rows_text(rows):
    return ','.join(COLS) + '\n' + ''.join(','.join(cell(r[k]) for k in COLS) + '\n' for r in rows)


# ---------------------------------------------------------------- one pair
def mailed(T):
    """the weekend gate: at least one of the reads (T + r minutes + 1 second, r in READS) not isPossiblyClosed"""
    return any(not fc.is_possibly_closed(T + r * MIN + 1000) for r in READS)


def finite(z):
    return z is not None and all(isinstance(v, float) and math.isfinite(v) for v in z)


def signal_side(s, z, zp):
    """1 = top (at s on the top side at n's close, not at the bar before's), -1 = bottom, 0 = none; both = 2"""
    up = in_band(1, s, *z) and not in_band(1, s, *zp)
    dn = in_band(-1, s, *z) and not in_band(-1, s, *zp)
    if up and dn:
        return 2
    return 1 if up else (-1 if dn else 0)


class Follow:
    """Following a trade (the spec's "Following a trade"), over one pair's 1-minute bars: from minute kf through the
    last one loaded, the target TP pips away in whole points, in each minute the worst against the trade first, then
    the target test; out at the target exactly (tp) or valued at the last minute's close (open); no stop.
    index(): the first minute reaching the target and the range's extreme by blocks (flowz-check.py Seek; P is
    monotone, so the extreme of P is P of the extreme); walk(): minute by minute, as the spec says. Both return
    (result, ko the minute out, the target in points, exit, pips, mae)."""

    def __init__(self, bh, bl, bc, ah, al, ac, scale, tp):
        self.n = len(bh)
        self.bc, self.ac, self.scale, self.tp = bc, ac, scale, tp
        P = self.P
        self.pbh = [P(x) for x in bh]                # a BUY's target test: P(bid high) >= target
        self.pal = [P(x) for x in al]                # a SELL's: P(ask low) <= target
        self.pbl = [P(x) for x in bl]                # a BUY's worst: P(entry) - P(bid low)
        self.pah = [P(x) for x in ah]                # a SELL's worst: P(ask high) - P(entry)
        self.s_bh, self.s_al = fc.Seek(self.pbh, False), fc.Seek(self.pal, True)
        self.s_bl, self.s_ah = fc.Seek(self.pbl, True), fc.Seek(self.pah, False)

    def P(self, x):
        return fc.js_round(x * self.scale)

    def _out(self, buy, pe, target, ko):
        if ko >= 0:
            return 'tp', ko, target / self.scale, self.tp
        ko = self.n - 1
        px = self.bc[ko] if buy else self.ac[ko]
        return 'open', ko, px, (self.P(px) - pe) / 10 if buy else (pe - self.P(px)) / 10

    def index(self, kf, buy, pe):
        target = pe + 10 * self.tp if buy else pe - 10 * self.tp
        ko = self.s_bh.first(kf, target) if buy else self.s_al.first(kf, target)
        result, ko, px, pips = self._out(buy, pe, target, ko)
        against = pe - self.s_bl.ext(kf, ko) if buy else self.s_ah.ext(kf, ko) - pe
        return result, ko, target, px, pips, against / 10 if against > 0 else 0

    def walk(self, kf, buy, pe):
        target = pe + 10 * self.tp if buy else pe - 10 * self.tp
        n, worst, q, ko = self.n, 0, kf, -1
        if buy:
            pbl, pbh = self.pbl, self.pbh
            while q < n:
                a = pe - pbl[q]
                if a > worst:
                    worst = a
                if pbh[q] >= target:
                    ko = q
                    break
                q += 1
        else:
            pah, pal = self.pah, self.pal
            while q < n:
                a = pah[q] - pe
                if a > worst:
                    worst = a
                if pal[q] <= target:
                    ko = q
                    break
                q += 1
        result, ko, px, pips = self._out(buy, pe, target, ko)
        return result, ko, target, px, pips, worst / 10 if worst > 0 else 0


def hand_cases():
    """Hand-made minutes, the results worked out by hand from the spec (TP 10 = 100 points; a yen pair 3 decimals,
    a /USD pair 5). Each followed both ways from minute 0. Returns the failures."""
    cases = [
        # (what, scale, buy, entry, minutes [(bid high, bid low, bid close, ask high, ask low, ask close)],
        #  expected (result, ko, target points, exit, pips, mae))
        ('a BUY whose tp minute also sets the worst (its bid low counts): worst 20 then 50 points, out at the target',
         1000.0, True, 150.0, [(150.05, 149.98, 150.0, 150.053, 149.983, 150.003),
                               (150.12, 149.95, 150.1, 150.123, 149.953, 150.103)],
         ('tp', 1, 150100, 150.1, 10, 5)),
        ('a BUY through a minute that opens beyond the target: out at the target, pips TP (not 25)',
         1000.0, True, 150.0, [(150.04, 149.99, 150.02, 150.043, 149.993, 150.023),
                               (150.25, 150.18, 150.2, 150.253, 150.183, 150.203)],
         ('tp', 1, 150100, 150.1, 10, 1)),
        ('a SELL never reaching the target: open, valued at the last ask close 150.060 (-6 pips), worst 80 points',
         1000.0, False, 150.0, [(150.027, 149.947, 150.007, 150.03, 149.95, 150.01),
                                (150.077, 149.917, 150.057, 150.08, 149.92, 150.06)],
         ('open', 1, 149900, 150.06, -6, 8)),
        ('a BUY never against it, out in its first minute: mae 0',
         1000.0, True, 150.0, [(150.1, 150.01, 150.05, 150.103, 150.013, 150.053)],
         ('tp', 0, 150100, 150.1, 10, 0)),
        ('a SELL on a /USD pair whose tp minute sets the worst: worst 30 then 60 points, out at 1.09900',
         100000.0, False, 1.1, [(1.10027, 1.09947, 1.1, 1.1003, 1.0995, 1.10003),
                                (1.10057, 1.09887, 1.09897, 1.1006, 1.0989, 1.099)],
         ('tp', 1, 109900, 1.099, 10, 6)),
    ]
    bad = []
    for what, scale, buy, entry, mins, want in cases:
        cols = list(zip(*mins))
        f = Follow(cols[0], cols[1], cols[2], cols[3], cols[4], cols[5], scale, 10)
        pe = f.P(entry)
        for how, got in (('index', f.index(0, buy, pe)), ('walk', f.walk(0, buy, pe))):
            if got != want:
                bad.append(f'hand case "{what}": {how} {got!r} / by hand {want!r}')
    return bad


def compute_pair(cache, pi, pair, start, end, load_from, ld, prob, log):
    t_pair = time.time()
    sym = pair.replace('/', '_')
    dec = 5 if pair.endswith('/USD') else 3
    scale = 10.0 ** dec
    # the chart: GMO's 15min (or 1hour) day files, both sides (loadTf, weekend "inside"), the mid close rounded as drawn
    got = fc.load_tf(cache, sym, FOLDER, STEP, fc.keys_of(load_from, end), load_from, end, ld)
    n = len(got)
    t = [x[0] for x in got]
    c = [fc.round_chart((x[1][4] + x[2][4]) / 2, dec) for x in got]
    bc = [x[1][4] for x in got]                      # GMO's own bid close of the bar (not rounded)
    ac = [x[2][4] for x in got]                      # and ask close
    del got
    # the 1-minute bars (loadM1, START to END)
    m1 = fc.M1(pair, cache, start, end, ld)
    mt, mbc, mac = m1.t, m1.bc, m1.ac
    nm = m1.n
    F = Follow(m1.bh, m1.bl, m1.bc, m1.ah, m1.al, m1.ac, scale, TP)
    del m1
    P, by_index, by_walk = F.P, F.index, F.walk

    # the line at each bar's close: Z(n) = zoneAt(macd(c[n-599..n]), 599), Zp(n) the same window at 598
    if n > LO:
        z = m90.zones_of(c, LO, n)
        Z = [None] * LO + [(z[0][j], z[1][j], z[2][j]) for j in range(LO, n)]
        Zp = [None] * LO + [(z[3][j], z[4][j], z[5][j]) for j in range(LO, n)]
        del z
    else:
        Z = Zp = [None] * n

    def check_zone(j):
        """the fast form against zoneAt on the windows rebuilt the slow way, and the signal at 0.95 against
        decideZoneOnWindow (flowz-check.py zone_entry)"""
        w = c[j - WINDOW + 1:j + 1]
        prob['zones'] += 1
        a = m90.zone_ref(w, WINDOW - 1)
        b = m90.zone_ref(w, WINDOW - 2)
        b2 = m90.zone_ref(w[:-1], WINDOW - 2)        # the bar before on its own 599 closes, at its last index
        if a != Z[j] or b != Zp[j] or b2 != Zp[j]:
            prob['bad'].append(f'{pair} bar {fc.iso(t[j])}: Z {Z[j]!r} Zp {Zp[j]!r} / rebuilt {a!r} {b!r}, '
                               f'599 closes {b2!r}')
        sd = signal_side(V8_SHARE, Z[j], Zp[j])
        mine = None if sd == 0 else ('SELL' if sd == 1 else 'BUY')
        d = fc.zone_entry(w)
        ref = None if d is None else d[0]
        if mine != ref:
            prob['bad'].append(f'{pair} bar {fc.iso(t[j])}: at 0.95 the fade side here {mine} / decideZoneOnWindow '
                               f'{ref}')

    rows = []
    base = []                                        # (T0, pi, si, result, pips, mae, minutes, kf, P(entry))
    info = dict(pair=pair, bars=n, minutes=nm, short=0, zoneless=0, judged=0, signals=0, entries=0, notMailed=0,
                prevAt=0, baseEntries=0)
    cvm = dict.fromkeys(CVM_KEYS, 0)
    for j in range(n):
        T = t[j] + STEP
        if T < start or T >= end:
            continue
        # closeVsMinute: the last 1-minute bar loaded inside [t, T)
        q = bisect.bisect_left(mt, T) - 1
        if q < 0 or mt[q] < t[j]:
            cv = 'noMinute'
        elif mbc[q] == bc[j] and mac[q] == ac[j]:
            cv = 'same'
        else:
            cv = 'differ'
            if cvm['differ'] < 3:
                log(f'  {pair} bar {fc.iso(t[j])}: the {TF} close bid {bc[j]!r} ask {ac[j]!r} / its last minute '
                    f'{fc.iso(mt[q])} bid {mbc[q]!r} ask {mac[q]!r}')
        cvm['bars'] += 1
        cvm[cv] += 1
        if j < LO:
            info['short'] += 1
            continue
        if not (finite(Z[j]) and finite(Zp[j])):
            info['zoneless'] += 1
            continue
        info['judged'] += 1
        sd = signal_side(SHARE, Z[j], Zp[j])
        if sd == 2:
            prob['bad'].append(f'{pair} bar {fc.iso(t[j])}: at {SHARE!r} on both sides')
            continue
        if sd != 0 or j % ZONE_EVERY == 0:
            check_zone(j)
        ok = mailed(T)
        if sd != 0:
            info['signals'] += 1
            if not ok:
                info['notMailed'] += 1
            else:
                info['entries'] += 1
                cvm['entry' + cv[0].upper() + cv[1:]] += 1
                if j - 1 >= LO and finite(Z[j - 1]) and in_band(sd, SHARE, *Z[j - 1]):
                    info['prevAt'] += 1
                T0 = T
                kf = bisect.bisect_left(mt, T0)
                if kf >= nm:
                    die(f'{pair} entry {fc.iso(t[j])}: no 1-minute bar at or after T0 {fc.iso(T0)}')
                zv = Z[j]
                share0 = js_div(zv[0], zv[1] if sd > 0 else zv[2])
                for di, dname in enumerate(DIRS):
                    buy = (sd < 0) if dname == 'fade' else (sd > 0)
                    entry = ac[j] if buy else bc[j]
                    pe = P(entry)
                    got = by_index(kf, buy, pe)
                    ref = by_walk(kf, buy, pe)
                    prob['walks'] += 1
                    if got != ref:
                        prob['bad'].append(f'{pair} {dname} {fc.iso(t[j])}: the index {got!r} / the walk {ref!r}')
                    result, ko, target, px, pips, mae = got
                    Tx = mt[ko] + MIN
                    dt = Tx - T0
                    rows.append(dict(_T0=T0, _pi=pi, _di=di, dir=dname, pair=pair, open=fc.iso(t[j]), T0=fc.iso(T0),
                                     zside='top' if sd > 0 else 'bottom', side='BUY' if buy else 'SELL', entry=entry,
                                     share0=share0, target=target / scale, result=result, T=fc.iso(Tx), exit=px,
                                     pips=pips, mae=mae, minutes=dt // MIN if dt % MIN == 0 else dt / MIN))
        # the baseline: every judged and mailed bar, at its first 1-minute bar, a BUY at its ask close and a SELL at
        # its bid close, followed from the first minute at or after that minute's end
        if not ok:
            continue
        k = bisect.bisect_left(mt, t[j])
        if k >= nm or mt[k] >= t[j] + STEP:
            continue
        T0 = mt[k] + MIN
        kf = bisect.bisect_left(mt, T0)
        if kf >= nm:
            die(f'{pair} baseline {fc.iso(t[j])}: no 1-minute bar at or after T0 {fc.iso(T0)}')
        info['baseEntries'] += 1
        for si, sd2 in enumerate(BASE_SIDES):
            buy = sd2 == 'BUY'
            pe = P(mac[k] if buy else mbc[k])
            result, ko, target, px, pips, mae = by_index(kf, buy, pe)
            dt = mt[ko] + MIN - T0
            base.append((T0, pi, si, result, pips, mae, dt // MIN if dt % MIN == 0 else dt / MIN, kf, pe))
    # every WALK_EVERY-th baseline trade (in this pair's order) walked minute by minute
    t_walk = time.time()
    for q in range(0, len(base), WALK_EVERY):
        b = base[q]
        buy = b[2] == 0
        got = by_index(b[7], buy, b[8])
        ref = by_walk(b[7], buy, b[8])
        prob['walks'] += 1
        if got != ref or (got[0], got[4], got[5]) != (b[3], b[4], b[5]):
            prob['bad'].append(f'{pair} baseline {fc.iso(b[0])} {BASE_SIDES[b[2]]}: the index {got!r} / the walk '
                               f'{ref!r}')
    t_walk = time.time() - t_walk
    # the baseline's entries counted again from the minutes (the bars judged and mailed with a minute inside)
    again = 0
    for j in range(LO, n):
        T = t[j] + STEP
        if start <= T < end and finite(Z[j]) and finite(Zp[j]) and mailed(T):
            k = bisect.bisect_left(mt, t[j])
            again += k < nm and mt[k] < T
    if again != info['baseEntries'] or len(base) != 2 * again:
        prob['bad'].append(f'{pair}: baseline entries {info["baseEntries"]}, trades {len(base)}, counted again {again}')
    info['signals'] = info['entries'] + info['notMailed']
    info['closeVsMinute'] = cvm
    log(f'  {pair}: bars {n}, minutes {nm}; in range: judged {info["judged"]} (short {info["short"]}, zoneless '
        f'{info["zoneless"]}), signals {info["signals"]} (entries {info["entries"]}, not mailed {info["notMailed"]}), '
        f'prevAt {info["prevAt"]}, baseline entries {info["baseEntries"]}; closeVsMinute {json.dumps(cvm)}; '
        f'{time.time() - t_pair:.1f}s (of which the baseline walks {t_walk:.1f}s)')
    base = [b[:7] for b in base]
    return rows, info, base


# ---------------------------------------------------------------- the numbers (G)
def p90(xs):
    """the value at rank (9 n + 9) // 10 (1-based) in ascending order"""
    return sorted(xs)[(9 * len(xs) + 9) // 10 - 1] if xs else None


def g_of(trs):
    """G of the trades trs, each (result, pips, mae, minutes), in the rows' order"""
    tps = [r for r in trs if r[0] == 'tp']
    ops = [r for r in trs if r[0] == 'open']
    n = len(trs)
    pips = [r[1] for r in trs]
    maes = [r[2] for r in trs]
    tmin = [r[3] for r in tps]
    s = fc.add_in_order(pips)
    out = dict(trades=n, tp=len(tps), open=len(ops),
               pipsSum=s if n else None, pipsMean=s / n if n else None, pipsMedian=fc.median(pips),
               tpMinutesMedian=fc.median(tmin), tpMinutesP90=p90(tmin), tpMinutesMax=max(tmin) if tmin else None)
    for lim in WITHIN:
        out[f'within{lim}'] = sum(1 for v in tmin if v <= lim)
    out.update(maeMedian=fc.median(maes), maeP90=p90(maes), maeMax=max(maes) if n else None,
               tpMaeMax=max(r[2] for r in tps) if tps else None,
               openPipsSum=fc.add_in_order([r[1] for r in ops]) if ops else None,
               openPipsWorst=min(r[1] for r in ops) if ops else None,
               openMaeMax=max(r[2] for r in ops) if ops else None,
               openMinutesMax=max(r[3] for r in ops) if ops else None)
    return {k: out[k] for k in G_KEYS}


def groups_of(rows):
    tr = [(r['result'], r['pips'], r['mae'], r['minutes'], r['pair'], r['side'], r['zside']) for r in rows]
    g = {'all': g_of(tr)}
    for p in PAIRS:
        g[p] = g_of([x for x in tr if x[4] == p])
    for sd in ('BUY', 'SELL'):
        g[sd] = g_of([x for x in tr if x[5] == sd])
    for zs in ('top', 'bottom'):
        g[zs] = g_of([x for x in tr if x[6] == zs])
    return g


def base_groups_of(base):
    """base: (T0, pi, si, result, pips, mae, minutes), already in the order its rows would have"""
    tr = [(b[3], b[4], b[5], b[6], b[1], b[2]) for b in base]
    g = {'all': g_of(tr)}
    for pi, p in enumerate(PAIRS):
        g[p] = g_of([x for x in tr if x[4] == pi])
    for si, sd in enumerate(BASE_SIDES):
        g[sd] = g_of([x for x in tr if x[5] == si])
    return g


def counts_add_up(summ):
    """the spec's check 8 on the Python's own numbers"""
    bad = []
    pairs = summ['pairs']
    entries = sum(p['entries'] for p in pairs)
    for dn in DIRS:
        g = summ['dirs'][dn]
        for name, s in g.items():
            if s['tp'] + s['open'] != s['trades']:
                bad.append(f'dirs.{dn}.{name}: tp + open != trades')
        if g['all']['trades'] != entries:
            bad.append(f'dirs.{dn}.all: trades != entries')
        for p in pairs:
            if g[p['pair']]['trades'] != p['entries']:
                bad.append(f'dirs.{dn}.{p["pair"]}: trades != entries')
        for a, b in (('BUY', 'SELL'), ('top', 'bottom')):
            if g[a]['trades'] + g[b]['trades'] != g['all']['trades']:
                bad.append(f'dirs.{dn}: {a} + {b} != all')
    f, d = summ['dirs']['flow'], summ['dirs']['fade']
    if f['BUY']['trades'] != d['SELL']['trades'] or f['SELL']['trades'] != d['BUY']['trades']:
        bad.append("fade's BUY is not flow's SELL (or the reverse)")
    if d['top']['trades'] != d['SELL']['trades'] or f['top']['trades'] != f['BUY']['trades']:
        bad.append('fade top is not SELL (or flow top not BUY)')
    for p in pairs:
        if p['signals'] != p['entries'] + p['notMailed']:
            bad.append(f'{p["pair"]}: signals != entries + notMailed')
        cv = p['closeVsMinute']
        if p['judged'] + p['short'] + p['zoneless'] != cv['bars']:
            bad.append(f'{p["pair"]}: judged + short + zoneless != the bars in range')
        if cv['same'] + cv['differ'] + cv['noMinute'] != cv['bars']:
            bad.append(f'{p["pair"]}: same + differ + noMinute != bars')
        if cv['entrySame'] + cv['entryDiffer'] + cv['entryNoMinute'] != p['entries']:
            bad.append(f'{p["pair"]}: entrySame + entryDiffer + entryNoMinute != entries')
    g = summ['base']
    be = sum(p['baseEntries'] for p in pairs)
    for name, s in g.items():
        if s['tp'] + s['open'] != s['trades']:
            bad.append(f'base.{name}: tp + open != trades')
    if g['all']['trades'] != 2 * be:
        bad.append('base.all: trades != 2 x baseEntries')
    for p in pairs:
        if g[p['pair']]['trades'] != 2 * p['baseEntries']:
            bad.append(f'base.{p["pair"]}: trades != 2 x baseEntries')
    for sd in BASE_SIDES:
        if g[sd]['trades'] != be:
            bad.append(f'base.{sd}: trades != baseEntries')
    return bad


def rows_bad(rows):
    """the spec's check 5 on the Python's own rows"""
    bad = []
    for q in range(0, len(rows), 2):
        a, b = rows[q], rows[q + 1]
        where = f'{a["pair"]} {a["open"]}'
        if (a['dir'], b['dir']) != DIRS:
            bad.append(f'{where}: the two rows are {a["dir"]}, {b["dir"]}')
        for k in ('pair', 'open', 'T0', 'zside', 'share0'):
            if a[k] != b[k]:
                bad.append(f'{where}: fade and flow differ in {k}')
        if a['side'] != ('SELL' if a['zside'] == 'top' else 'BUY') or a['side'] == b['side']:
            bad.append(f'{where}: fade {a["side"]} / flow {b["side"]} on the {a["zside"]} side')
    for r in rows:
        where = f'{r["dir"]} {r["pair"]} {r["open"]}'
        if r['result'] == 'tp':
            if r['pips'] != TP or r['exit'] != r['target'] or not r['_T0'] < fc.ms_of(r['T']):
                bad.append(f'{where}: tp with pips {r["pips"]!r}, exit {r["exit"]!r}, T {r["T"]}')
        elif not (r['result'] == 'open' and r['pips'] < TP):
            bad.append(f'{where}: {r["result"]} with pips {r["pips"]!r}')
        if r['mae'] < 0 or r['minutes'] * MIN != fc.ms_of(r['T']) - r['_T0'] or r['open'] != fc.iso(r['_T0'] - STEP):
            bad.append(f'{where}: mae {r["mae"]!r}, minutes {r["minutes"]!r}')
    keys = [(r['_T0'], r['_pi'], r['_di']) for r in rows]
    if keys != sorted(keys) or len(set(keys)) != len(keys):
        bad.append('rows: not in the order T0, the pairs, fade before flow (or a key twice)')
    return bad


def compute(cache, start, end, load_from, log):
    ld = fc.LoadStats()
    prob = dict(zones=0, walks=0, bad=hand_cases())
    rows, pairs, base = [], [], []
    for pi, pair in enumerate(PAIRS):
        r, info, b = compute_pair(cache, pi, pair, start, end, load_from, ld, prob, log)
        rows.extend(r)
        pairs.append(info)
        base.extend(b)
    rows.sort(key=lambda r: (r['_T0'], r['_pi'], r['_di']))
    base.sort(key=lambda b: (b[0], b[1], b[2]))
    summ = dict(meta=dict(start=fc.iso(start), end=fc.iso(end), loadFrom=fc.iso(load_from), share=SHARE, tp=TP, tf=TF),
                pairs=[{k: p[k] for k in ['pair', 'bars', 'minutes', 'short', 'zoneless', 'judged', 'signals',
                                           'entries', 'notMailed', 'prevAt', 'baseEntries', 'closeVsMinute']}
                       for p in pairs],
                dirs={dn: groups_of([r for r in rows if r['dir'] == dn]) for dn in DIRS},
                base=base_groups_of(base))
    prob['bad'] += counts_add_up(summ) + rows_bad(rows)
    log(f'  files read {ld.files}, failed {ld.failed} {ld.failed_ex}; 1-minute bars left out: one side {ld.one_side}, '
        f'crossed {ld.crossed}, in the closure {ld.closure}, repeated {ld.repeated}')
    log(f'  rows {len(rows)}, baseline trades {len(base)}; the Python\'s own checks: windows rebuilt {prob["zones"]}, '
        f'trades walked minute by minute {prob["walks"]}, failures {len(prob["bad"])}')
    return rows, summ, prob


# ---------------------------------------------------------------- comparing
class Diff:
    def __init__(self):
        self.n = 0
        self.fields = 0

    def bad(self, msg):
        self.n += 1
        if self.n <= MAX_LINES:
            print('DIFF ' + msg)


def compare_rows(D, mine, text):
    lines = text.split('\n')
    if lines and lines[-1] == '':
        lines.pop()
    else:
        D.bad('rows.csv: no newline after the last line')
    head = lines[0].split(',') if lines else []
    D.fields += len(COLS)
    if head != COLS:
        D.bad(f'rows.csv header: TS {",".join(head)} / the spec {",".join(COLS)}')
    theirs = [ln.split(',') for ln in lines[1:]]
    if len(theirs) != len(mine):
        D.bad(f'rows.csv: TS {len(theirs)} rows, Python {len(mine)}')
    for q in range(max(len(theirs), len(mine))):
        a = theirs[q] if q < len(theirs) else None
        b = [cell(mine[q][k]) for k in COLS] if q < len(mine) else None
        if a is None or b is None:
            D.bad(f'row {q + 1}: TS {",".join(a) if a else "-"} / Python {",".join(b) if b else "-"}')
            continue
        D.fields += len(COLS)
        if a == b:
            continue
        if len(a) != len(COLS):
            D.bad(f'row {q + 1}: TS has {len(a)} cells: {",".join(a)}')
            continue
        diffs = [f'{k}: TS {x!r} / Python {y!r}' for k, x, y in zip(COLS, a, b) if x != y]
        D.bad(f'row {q + 1} ({b[0]} {b[1]} open {b[2]}): ' + '; '.join(diffs))


def same_value(a, b):
    """a number of the TS's (parsed) and one of the Python's: the same double (null only with null)"""
    if a is None or b is None:
        return a is None and b is None
    if isinstance(a, bool) or isinstance(b, bool):
        return a is b
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return float(a) == float(b)
    return a == b


def compare_tree(D, where, theirs, mine):
    if isinstance(mine, dict):
        if not isinstance(theirs, dict):
            D.bad(f'{where}: TS {theirs!r} / Python an object')
            return
        if list(theirs.keys()) != list(mine.keys()):
            D.bad(f'{where}: keys TS {list(theirs.keys())} / Python {list(mine.keys())}')
        for k, v in mine.items():
            if k in theirs:
                compare_tree(D, f'{where}.{k}', theirs[k], v)
        return
    if isinstance(mine, list):
        if not isinstance(theirs, list) or len(theirs) != len(mine):
            D.bad(f'{where}: TS {len(theirs) if isinstance(theirs, list) else theirs!r} items / Python {len(mine)}')
            return
        for q, v in enumerate(mine):
            compare_tree(D, f'{where}[{q}]', theirs[q], v)
        return
    D.fields += 1
    if not same_value(theirs, mine):
        D.bad(f'{where}: TS {theirs!r} / Python {mine!r}')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--cache', required=True)
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument('--out')
    g.add_argument('--self', dest='self_out')
    args = ap.parse_args()
    start, end, load_from = time_env('START'), time_env('END'), time_env('LOAD_FROM')
    if not load_from <= start < end:
        die('LOAD_FROM <= START < END does not hold')
    t0 = time.time()
    print(f'tf {TF} share {SHARE!r} tp {TP}; start {fc.iso(start)} end {fc.iso(end)} loadFrom {fc.iso(load_from)}')
    rows, summ, prob = compute(args.cache, start, end, load_from, print)
    rtext = rows_text(rows)
    stext = js_json1(summ)
    for msg in prob['bad'][:MAX_LINES]:
        print('CHECK ' + msg)
    if args.self_out:
        os.makedirs(args.self_out, exist_ok=True)
        with open(os.path.join(args.self_out, 'rows.csv'), 'w', encoding='utf-8', newline='') as f:
            f.write(rtext)
        with open(os.path.join(args.self_out, 'summary.json'), 'w', encoding='utf-8', newline='') as f:
            f.write(stext)
        print(f'written to {args.self_out} in {time.time() - t0:.0f}s')
        if prob['bad']:
            print(f'PYTHON DISAGREES: {len(prob["bad"])} differences (the Python\'s own checks)')
            sys.exit(1)
        sys.exit(0)
    D = Diff()
    try:
        with open(os.path.join(args.out, 'rows.csv'), encoding='utf-8', newline='') as f:
            their_rows = f.read()
        with open(os.path.join(args.out, 'summary.json'), encoding='utf-8', newline='') as f:
            their_summ = f.read()
        S = json.loads(their_summ)
    except Exception as e:  # noqa: BLE001
        die(f'reading {args.out}: {type(e).__name__}: {e}')
    compare_rows(D, rows, their_rows)
    compare_tree(D, 'summary', S, summ)
    # the whole files as text (only telling when every cell and field above is the same)
    same_rows = their_rows == rtext
    same_summ = their_summ == stext
    if D.n == 0 and not same_rows:
        D.bad('rows.csv: every cell the same, the text not')
    if D.n == 0 and not same_summ:
        D.bad('summary.json: every field the same, the text not (JSON.stringify(x, null, 1), no newline at the end)')
    n_bad = D.n + len(prob['bad'])
    print(f'compared: {len(rows)} rows and {D.fields} cells and fields; rows.csv the same text {same_rows}, '
          f'summary.json the same text {same_summ}; {time.time() - t0:.0f}s')
    if n_bad:
        print(f'PYTHON DISAGREES: {n_bad} differences ({D.n} with the TypeScript\'s files, {len(prob["bad"])} in the '
              f'Python\'s own checks)')
        sys.exit(1)
    print('PYTHON AGREES')


if __name__ == '__main__':
    main()
