#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
chartbest-check-compare.py — the writers of the Python's own dumps (py/) and the comparison with the TS dumps (ts/)
of the independent re-computation of docs/OPERATIONS.md §8.113 (20 (d)「数は完全に一致、実数は 1e-9 以内、文は1字も
違わない ... 違った時は値を出さず、どこが違うかだけを出す」).

Formats (the plan's 4.2): CSV with a header, ',' and LF, no quoting, empty = null; integers in decimal; times in
integer ms; prices as toFixed(d); other reals in the shortest round trip ('NaN' for not-a-number); JSON plain numbers
and null; sentences.tsv = id<TAB>text.

The comparison matches rows by each file's key columns (not by position), so a different row order is reported once
as a note and never hides a difference. Cells are compared after canonicalising the encodings the plan leaves
open: a direction BUY/SELL/1/-1, a kind t/s/a/o or tp/sl/amb/open, a boolean true/false/1/0, an empty cell / null /
'-' for "none" where the column allows it. Integers and strings compare exactly, reals within 1e-9, sentences
character for character. A CSV column the plan requires and one side lacks is a difference; a column beyond the
plan on one side only is a note. JSON files can first go through chartbest-check-canon.py (one layout for both
sides). `--strict-format` (chartbest-check.py) turns both tolerances off (the plan's 4.4: headers and keys equal).
"""
import json
import math
import os

TOL = 1e-9
TSV_HEADER = 'id\ttext'


# ---------------------------------------------------------------- writing
def js_num(x):
    """A real as JavaScript's String(x) would mostly write it (the comparison parses numbers anyway)."""
    if x is None:
        return ''
    if isinstance(x, bool):
        return 'true' if x else 'false'
    if isinstance(x, int):
        return str(x)
    if isinstance(x, float):
        if math.isnan(x):
            return 'NaN'
        if math.isinf(x):
            return 'Infinity' if x > 0 else '-Infinity'
        if x == int(x) and abs(x) < 1e21:
            return str(int(x))
        r = repr(x)
        if 'e' in r:
            m, e = r.split('e')
            e = int(e)
            r = f'{m}e{"+" if e > 0 else "-"}{abs(e)}'
        return r
    return str(x)


def write_csv(path, header, rows):
    with open(path, 'w', encoding='utf-8', newline='\n') as f:
        f.write(','.join(header) + '\n')
        for r in rows:
            f.write(','.join(js_num(v) if not isinstance(v, str) else v for v in r) + '\n')


def _clean(o):
    if isinstance(o, float):
        return None if (math.isnan(o) or math.isinf(o)) else o
    if isinstance(o, dict):
        return {str(k): _clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [_clean(v) for v in o]
    return o


def write_json(path, obj):
    with open(path, 'w', encoding='utf-8', newline='\n') as f:
        json.dump(_clean(obj), f, ensure_ascii=False, indent=1, sort_keys=False)
        f.write('\n')


def write_tsv(path, rows):
    """sentences.tsv: the header `id<TAB>text`, then one line per sentence (a reader skips the header if present)."""
    with open(path, 'w', encoding='utf-8', newline='\n') as f:
        f.write(TSV_HEADER + '\n')
        for k, text in rows:
            f.write(f'{k}\t{text}\n')


# ---------------------------------------------------------------- canonical cells
DIRS = {'BUY': 'BUY', '1': 'BUY', 'SELL': 'SELL', '-1': 'SELL'}
KINDS = {'t': 't', 'tp': 't', 's': 's', 'sl': 's', 'a': 'a', 'amb': 'a', 'o': 'o', 'open': 'o'}
BOOLS = {'true': '1', '1': '1', 'false': '0', '0': '0'}
NONE = {'', 'null', 'None', '-', 'NaN-none'}


def _canon(kind, v):
    v = v.strip()
    if kind == 'dir':
        return DIRS.get(v, v)
    if kind == 'kind':
        return KINDS.get(v, v)
    if kind == 'bool':
        return BOOLS.get(v.lower(), v)
    if kind == 'half':
        return '' if v in NONE else v
    if kind == 'list':
        return ';'.join(sorted(x for x in v.split(';') if x))
    return v


def _same_cell(kind, a, b):
    a, b = _canon(kind, a), _canon(kind, b)
    if kind in ('int', 'str', 'price', 'dir', 'kind', 'bool', 'half', 'list'):
        if kind == 'int' and a not in NONE and b not in NONE:
            try:
                return int(float(a)) == int(float(b)) and float(a) == int(float(a)) and float(b) == int(float(b))
            except ValueError:
                return a == b
        if a in NONE and b in NONE:
            return True
        return a == b
    # real
    if a in NONE and b in NONE:
        return True
    if a in NONE or b in NONE:
        return False
    try:
        x, y = float(a), float(b)
    except ValueError:
        return a == b
    if math.isnan(x) and math.isnan(y):
        return True
    if math.isinf(x) or math.isinf(y):
        return x == y
    return abs(x - y) <= TOL


class Report:
    def __init__(self):
        self.compared = 0
        self.differ = []
        self.notes = []          # not failures: a different row order (the rows themselves are matched by key)

    def add(self, file, key, column):
        self.differ.append({'file': file, 'key': key, 'column': column})

    def note(self, file, what):
        self.notes.append({'file': file, 'note': what})


def read_csv(path):
    with open(path, encoding='utf-8') as f:
        lines = f.read().split('\n')
    if lines and lines[-1] == '':
        lines = lines[:-1]
    if not lines:
        return [], []
    header = lines[0].split(',')
    return header, [ln.split(',') for ln in lines[1:]]


def compare_csv(rep, name, py_path, ts_path, keys, kinds, required=None, strict=False):
    """kinds: {column: kind}; a column not named is 'real' unless it is a key ('str'). required: the plan's columns
    (4.3): one missing on either side is a difference; other columns on one side only are notes (compared where
    both have them). strict (or required None): the headers must be equal, as the plan's 4.4 says."""
    if not os.path.exists(ts_path):
        rep.add(name, '-', 'missing in ts')
        return
    hp, rp = read_csv(py_path)
    ht, rt = read_csv(ts_path)
    rep.compared += 1
    common = [c for c in hp if c in ht]
    if hp != ht:
        if strict or required is None:
            rep.add(name, '-', 'header')
        else:
            for c in required:
                if c not in hp:
                    rep.add(name, '-', f'column missing in py: {c}')
                if c not in ht:
                    rep.add(name, '-', f'column missing in ts: {c}')
            extra_p = [c for c in hp if c not in ht and c not in required]
            extra_t = [c for c in ht if c not in hp and c not in required]
            if extra_p:
                rep.note(name, 'columns only in py (not compared): ' + ';'.join(extra_p))
            if extra_t:
                rep.note(name, 'columns only in ts (not compared): ' + ';'.join(extra_t))
            if [c for c in hp if c in ht] != [c for c in ht if c in hp]:
                rep.note(name, 'column order differs')
    if len(rp) != len(rt):
        rep.add(name, '-', 'row count')
    ip = {c: k for k, c in enumerate(hp)}
    it = {c: k for k, c in enumerate(ht)}
    if any(k not in ip or k not in it for k in keys):
        rep.add(name, '-', 'key columns')
        return

    def key_of(r, ix):
        return tuple(_canon(kinds.get(k, 'str'), r[ix[k]]) if ix[k] < len(r) else '' for k in keys)

    mp, order_p = {}, []
    for r in rp:
        k = key_of(r, ip)
        if k in mp:
            rep.add(name, '|'.join(k), 'repeated key (py)')
        mp[k] = r
        order_p.append(k)
    mt, order_t = {}, []
    for r in rt:
        k = key_of(r, it)
        if k in mt:
            rep.add(name, '|'.join(k), 'repeated key (ts)')
        mt[k] = r
        order_t.append(k)
    for k in mp:
        if k not in mt:
            rep.add(name, '|'.join(k), 'row only in py')
    for k in mt:
        if k not in mp:
            rep.add(name, '|'.join(k), 'row only in ts')
    shared = [k for k in order_p if k in mt]
    if [k for k in order_t if k in mp] != shared:
        rep.note(name, 'row order differs')
    for k in shared:
        a, b = mp[k], mt[k]
        for c in common:
            if c in keys:
                continue
            va = a[ip[c]] if ip[c] < len(a) else ''
            vb = b[it[c]] if it[c] < len(b) else ''
            if not _same_cell(kinds.get(c, 'real'), va, vb):
                rep.add(name, '|'.join(k), c)


def _num(x):
    return isinstance(x, (int, float)) and not isinstance(x, bool)


def compare_obj(rep, name, a, b, path='', special=None):
    """JSON recursively: keys equal, ints exact, reals 1e-9, everything else exact."""
    if special and path in special:
        if not special[path](a, b):
            rep.add(name, path or '/', 'value')
        return
    if isinstance(a, dict) and isinstance(b, dict):
        for k in a:
            if k not in b:
                rep.add(name, f'{path}/{k}', 'key only in py')
        for k in b:
            if k not in a:
                rep.add(name, f'{path}/{k}', 'key only in ts')
        for k in a:
            if k in b:
                compare_obj(rep, name, a[k], b[k], f'{path}/{k}', special)
        return
    if isinstance(a, list) and isinstance(b, list):
        if len(a) != len(b):
            rep.add(name, path or '/', 'length')
            return
        for k, (x, y) in enumerate(zip(a, b)):
            compare_obj(rep, name, x, y, f'{path}[{k}]', special)
        return
    if _num(a) and _num(b):
        if isinstance(a, int) and isinstance(b, int):
            if a != b:
                rep.add(name, path or '/', 'int')
            return
        fa, fb = float(a), float(b)
        if math.isnan(fa) and math.isnan(fb):
            return
        if not abs(fa - fb) <= TOL:
            rep.add(name, path or '/', 'real')
        return
    if a != b:
        rep.add(name, path or '/', 'value')


def compare_json_file(rep, name, py_path, ts_path, special=None, canon=None):
    """canon: an optional function (py_obj, ts_obj) -> (py_obj, ts_obj, notes) bringing both sides to one layout
    first (chartbest-check-canon.py); its notes (layout differences, never values) are reported as notes."""
    if not os.path.exists(ts_path):
        rep.add(name, '-', 'missing in ts')
        return
    rep.compared += 1
    with open(py_path, encoding='utf-8') as f:
        a = json.load(f)
    try:
        with open(ts_path, encoding='utf-8') as f:
            b = json.load(f)
    except ValueError:
        rep.add(name, '-', 'not JSON')
        return
    if canon is not None:
        a, b, notes = canon(a, b)
        for n in notes:
            rep.note(name, n)
    compare_obj(rep, name, a, b, '', special)


def compare_tsv(rep, name, py_path, ts_path):
    if not os.path.exists(ts_path):
        rep.add(name, '-', 'missing in ts')
        return
    rep.compared += 1

    def rd(p):
        with open(p, encoding='utf-8') as f:
            lines = f.read().split('\n')
        if lines and lines[0] == TSV_HEADER:
            lines = lines[1:]
        out = {}
        order = []
        for ln in lines:
            if not ln:
                continue
            k, _, text = ln.partition('\t')
            out[k] = text
            order.append(k)
        return out, order
    a, oa = rd(py_path)
    b, ob = rd(ts_path)
    for k in a:
        if k not in b:
            rep.add(name, k, 'sentence only in py')
        elif a[k] != b[k]:
            rep.add(name, k, 'text')
    for k in b:
        if k not in a:
            rep.add(name, k, 'sentence only in ts')
    if [k for k in oa if k in b] != [k for k in ob if k in a]:
        rep.note(name, 'sentence order differs')


def partition_equal(a, b):
    """Two {member: group id} maps describe the same partition (ids may differ)."""
    if not isinstance(a, dict) or not isinstance(b, dict) or set(a) != set(b):
        return False
    pa = {frozenset(k for k in a if a[k] == g) for g in a.values()}
    pb = {frozenset(k for k in b if b[k] == g) for g in b.values()}
    return pa == pb
