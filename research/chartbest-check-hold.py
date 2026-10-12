#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
chartbest-check-hold.py — the owner's way (docs/OPERATIONS.md §8.113 9) in the independent Python re-computation:
the signal lists the accounts are run on, made from the Python's own signals, compared with each hold dump the TS
wrote (hold/<src>-<acct>/dump/signals.csv and meta.json); then research/ownerhold-check.py (the independent Python of
§8.102 / §8.111, used as SQ-07 says) recomputes that dump's accounts from the GMO 1-minute files and compares them.

The lists (9, §8.111, SQ-27):
  * items: every signal passing ① and ② (③ and ④ not applied) with START <= T < END; E = the bar's rounded mid
    close, TP = E + d x 10 x pip, late 0, base = T;
  * ULTRA 5分足: the same on-time signals, and the late ones (window i+1) with base = T + 5 min, late 1, sent when one
    of the reads at base + 0, 1, 3 minutes is outside isPossiblyClosed (§8.111 2; always within the 10-minute
    freshness);
  * MACD の山・谷: the sent fires (no late ones);
  * the second-half account keeps SPLIT <= T < END (SQ-27, by T).
Order: P (= base + 2 min), then the pairs' order, BUY first, then the bar's open; `i` numbers that order.
Not built here: the owner-hold sentences (§8.102 書く文, SQ-08) — build-py.md.
"""
import csv
import importlib.util
import json
import os
import subprocess
import sys


def _mod(name):
    key = f'cbcheck_{name}'
    if key in sys.modules:
        return sys.modules[key]
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), f'chartbest-check-{name}.py')
    spec = importlib.util.spec_from_file_location(key, path)
    m = importlib.util.module_from_spec(spec)
    sys.modules[key] = m
    spec.loader.exec_module(m)
    return m


D = _mod('data')
S = _mod('signals')
CMP = _mod('compare')

HOLD_TP = 10                 # 9: the owner's TP 10 pips (ultraLevels' TP2)
START_YEN, CAP_YEN = 300000.0, 1000000.0
ACCOUNTS = ('full', 'h2')
HEADER = ['i', 'pair', 'side', 'open', 'T', 'E', 'tp', 'late', 'base']


def hold_rows(src, sigs, late, bars, period, account):
    """The list one account of one source runs on."""
    lo = period['start'] if account == 'full' else period['split']
    hi = period['end']
    rows = []
    for s in sigs:
        if s.src != src or s.reason in ('r1', 'r2') or not (lo <= s.T < hi):
            continue
        rows.append(_row(bars[s.pi], int(bars[s.pi].t[s.i]), s.T, s.E, s.dir, 0, s.T))
    if src == 'ultra5':
        for pb in bars:
            for i, d in late.get(pb.pair, []):
                T = int(pb.t[i]) + D.STEP
                base = T + D.STEP
                if not (lo <= T < hi) or not D.sent(base):
                    continue
                rows.append(_row(pb, int(pb.t[i]), T, float(pb.mc[i]), d, 1, base))
    rows.sort(key=lambda r: (r['base'] + 2 * D.MIN, D.PAIRS.index(r['pair']), 0 if r['side'] == 'BUY' else 1, r['open']))
    for k, r in enumerate(rows):
        r['i'] = k
    return rows


def _row(pb, open_, T, E, d, late, base):
    tp = E + (d * HOLD_TP) * pb.pip
    return {'pair': pb.pair, 'side': S.DIR_NAME[d], 'open': open_, 'T': T, 'E': D.price_str(E, pb.digits),
            'tp': tp, 'late': late, 'base': base}


def write_rows(path, rows):
    CMP.write_csv(path, HEADER, [[str(r['i']), r['pair'], r['side'], str(r['open']), str(r['T']), r['E'],
                                  CMP.js_num(r['tp']), str(r['late']), str(r['base'])] for r in rows])


def compare_hold(rep, out, hold_dir, gmo, sources, sigs, late, bars, period, log):
    """Every (source, account) of 9: the lists against the dump's signals.csv and meta.json, then ownerhold-check.py on
    the dump (its exit code: 0 equal, 1 differences, 2 input error)."""
    here = os.path.dirname(os.path.abspath(__file__))
    for src in sources:
        for acct in ACCOUNTS:
            tag = f'{src}-{acct}'
            mine_dir = os.path.join(out, 'hold', tag)
            os.makedirs(mine_dir, exist_ok=True)
            rows = hold_rows(src, sigs, late, bars, period, acct)
            write_rows(os.path.join(mine_dir, 'signals.csv'), rows)
            dump = os.path.join(hold_dir, tag, 'dump')
            name = f'hold/{tag}/signals.csv'
            if not os.path.isdir(dump):
                rep.add(name, '-', 'missing in ts')
                continue
            CMP.compare_csv(rep, name, os.path.join(mine_dir, 'signals.csv'), os.path.join(dump, 'signals.csv'),
                            ['pair', 'side', 'open', 'late'],
                            {'i': 'int', 'open': 'int', 'T': 'int', 'E': 'price', 'late': 'int', 'base': 'int', 'side': 'dir'})
            meta_path = os.path.join(dump, 'meta.json')
            want = {'start': period['start'] if acct == 'full' else period['split'], 'end': period['end'],
                    'split': period['split'], 'startYen': START_YEN, 'cap': CAP_YEN, 'step': 5}
            try:
                with open(meta_path, encoding='utf-8') as f:
                    meta = json.load(f)
                for k, v in want.items():
                    if k not in meta or float(meta[k]) != float(v):
                        rep.add(f'hold/{tag}/meta.json', k, 'value')
            except (OSError, ValueError):
                rep.add(f'hold/{tag}/meta.json', '-', 'unreadable')
                continue
            cmd = [sys.executable, '-I', os.path.join(here, 'ownerhold-check.py'), '--gmo', gmo, '--dump', dump,
                   '--out', mine_dir, '--rates', 'synthetic', '--quiet']
            log(f'hold {tag}: ownerhold-check.py on the dump ({len(rows)} signals)')
            r = subprocess.run(cmd, capture_output=True, text=True)
            rep.compared += 1
            if r.returncode != 0:
                rep.add(f'hold/{tag}/accounts', '-', f'ownerhold-check.py exit {r.returncode}')
            with open(os.path.join(mine_dir, 'ownerhold-check.log'), 'w', encoding='utf-8') as f:
                f.write(r.stdout[-200000:])
                f.write(r.stderr[-20000:])
