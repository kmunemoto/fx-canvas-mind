#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
chartbest-check-canon.py — one layout for the JSON dumps before the independent Python re-computation of
docs/OPERATIONS.md §8.113 compares them with the TS's (20 (d)).

The plan's 4.3 fixes some of the dumps' shapes and leaves others open, and the two programs were written in parallel,
each aligning to the other's first dumps. So the same numbers can arrive in more than one layout: names (kTotal /
Ktotal, p95 / q95, dULb / dUSimLb, c2Applied / c2c3Applied.c2, the marks' names), nesting (counts.json's sources
under "sources" or at the top; warmDate per source or per half; the stats rows' shift as {delta, late} or flat),
encodings (warmDate in ms or as 'YYYY-MM-DD HH:MM' UTC; noBlindRows as {layer: n} or as an integer with
noBlindRowsCal; byPairDir with or without zero counts; a condition not applied as null or as met), and fields only
one program writes (beyond the plan). This module rewrites both sides into one canonical layout and returns notes
naming each rewrite (never a value); every number either side has is still compared, except:
  * OPTIONAL paths (fields beyond the plan, or derived from other compared fields) present on one side only: left
    out on that side, with a note;
  * DESCRIPTIVE paths (Est fields the plan names without defining: the unaligned a's strata, a difference's N and
    strata; a yardstick's floor) null on one side only: left out, with a note; both non-null are compared.
Anything else present on one side only stays a difference (DIFFER ... key only in py / ts).
`--strict-format` (chartbest-check.py) skips this module: the plan's 4.4 "keys equal" comparison.
"""
import datetime

MARK_NAMES = {'passMin': 'passMin10', 'passMin10': 'passMin10', 'mde': 'mde10', 'mde10': 'mde10',
              'size': 'mde10', 'size10': 'mde10', 'n26': 'n26'}

OPTIONAL = {
    'counts.json': ['/period', '/floorItems', '/C4', '/sources/*/kind', '/sources/*/group',
                    '/sources/*/H*/noBlindRowsCal'],
    'stats.json': ['/*/H*/*/counted', '/*/H*/*/nE', '/*/H*/*/unresolved', '/*/H*/*/lateExcluded',
                   '/*/H*/*/byDir/*/strata', '/*/H*/*/byDir/*/dropped', '/*/H*/*/byPair/*/strata',
                   '/*/H*/*/byPair/*/dropped', '/*/H*/*/shift/late', '/*/H*/*/shift'],
    'select.json': ['/stopped', '/groups', '/shift95/k', '/notEligibleCount', '/yardstickHit'],
    'stage2.json': ['/items/*/src', '/items/*/group', '/items/*/c3q', '/items/*/c3pos', '/yardstickHit',
                    '/stopped'],
}
DESCRIPTIVE = {
    # a yardstick's floor: 11's floor is the items' (the Python writes null)
    'counts.json': ['/sources/ultra5/floor', '/sources/macdx5/floor'],
    'stats.json': ['/*/H*/*/a/strata', '/blind/H*/*/a/strata', '/blind/H*/pairDir/*/a/strata'],
    'stage2.json': ['/items/*/dU/N', '/items/*/dU/strata', '/items/*/dM/N', '/items/*/dM/strata',
                    '/dAB[*]/est/N', '/dAB[*]/est/strata'],
}


# ---------------------------------------------------------------- paths
# A path is the tuple of keys from the root (list positions as ints), so keys holding '/' ('USD/JPY BUY') stay one
# key. A pattern is written '/a/*/H*/b' ('*' any one key, 'H*' a key starting with H, 'x[*]' key x then any position).
_INDEX = object()


def _compile(pat):
    out = []
    for seg in pat.split('/')[1:]:
        if seg.endswith('[*]'):
            out += [seg[:-3], _INDEX]
        else:
            out.append(seg)
    return out


def _seg_ok(p, k):
    if p is _INDEX:
        return isinstance(k, int)
    if isinstance(k, int):
        return False
    if p == '*':
        return True
    if p.endswith('*'):
        return k.startswith(p[:-1])
    return p == k


def _matcher(pats):
    rs = [(p, _compile(p)) for p in pats]

    def m(path):
        for p, segs in rs:
            if len(segs) == len(path) and all(_seg_ok(x, k) for x, k in zip(segs, path)):
                return p
        return None
    return m


# ---------------------------------------------------------------- single-side rewrites
def _ms_of(v):
    if isinstance(v, str):
        try:
            d = datetime.datetime.strptime(v.strip(), '%Y-%m-%d %H:%M').replace(tzinfo=datetime.timezone.utc)
            return int(d.timestamp()) * 1000
        except ValueError:
            return v
    return v


def _total(v):
    """intervalsSeen as an integer: itself, or an itemised object's total (or the sum of its parts)."""
    if isinstance(v, dict):
        if 'total' in v:
            return v['total']
        return sum(x for x in v.values() if isinstance(x, (int, float)) and not isinstance(x, bool))
    return v


def counts_one(o, notes, sources, measures, group_of):
    if not isinstance(o, dict):
        return o
    o = dict(o)
    if isinstance(o.get('sources'), dict):
        srcs = o.pop('sources')
        notes.add('sources under "sources"')
    else:
        srcs = {k: o.pop(k) for k in list(o) if k in sources}
    out = {}
    for src, rec in srcs.items():
        if not isinstance(rec, dict):
            out[src] = rec
            continue
        rec = dict(rec)
        wd = rec.pop('warmDate', None)
        if wd is not None:
            notes.add('warmDate per source')
        own = group_of.get(src, 'chart')
        for h in ('H1', 'H2'):
            if not isinstance(rec.get(h), dict):
                continue
            hh = dict(rec[h])
            w = hh.pop('warmDate', None)
            if w is not None:
                if wd is None:
                    wd = w
                elif w != wd:
                    hh['warmDate'] = w                       # kept apart: compared as it is
            if isinstance(hh.get('byPairDir'), dict):
                nz = {k: v for k, v in hh['byPairDir'].items() if v != 0}
                if len(nz) != len(hh['byPairDir']):
                    notes.add('byPairDir lists zero counts')
                hh['byPairDir'] = nz
            nb = hh.get('noBlindRows')
            if isinstance(nb, dict):
                notes.add('noBlindRows as {layer: n}')
                hh['noBlindRows'] = nb.get(own)
                hh['noBlindRowsCal'] = nb.get('cal') if src in measures else None
            rec[h] = hh
        if isinstance(wd, dict):
            if any(isinstance(v, str) for v in wd.values()):
                notes.add('warmDate as text')
            wd = {p: _ms_of(v) for p, v in wd.items()}
        if wd is not None:
            rec['warmDate'] = wd
        out[src] = rec
    o['sources'] = out
    if isinstance(o.get('projections'), dict):
        pr = {}
        for src, p in o['projections'].items():
            if isinstance(p, dict) and isinstance(p.get('marks'), list):
                p = dict(p)
                names = [MARK_NAMES.get(x, x) for x in p['marks']]
                if names != p['marks']:
                    notes.add('mark names')
                p['marks'] = names
            pr[src] = p
        o['projections'] = pr
    if isinstance(o.get('floorItems'), list):
        o['floorItems'] = sorted(o['floorItems'])
    return o


def stats_one(o, notes):
    if not isinstance(o, dict):
        return o
    out = {}
    for src, halves in o.items():
        if src == 'blind' or not isinstance(halves, dict):
            out[src] = halves
            continue
        hv = {}
        for h, layers in halves.items():
            if not isinstance(layers, dict):
                hv[h] = layers
                continue
            ly = {}
            for layer, row in layers.items():
                if isinstance(row, dict) and isinstance(row.get('shift'), dict) and 'delta' not in row['shift'] \
                        and 'n' in row['shift']:
                    row = dict(row)
                    row['shift'] = {'delta': row['shift']}
                    notes.add('the week shift summary flat (Δ only)')
                ly[layer] = row
            hv[h] = ly
        out[src] = hv
    return out


def select_one(o, notes):
    if not isinstance(o, dict):
        return o
    o = dict(o)
    if 'Ktotal' in o and 'kTotal' not in o:
        o['kTotal'] = o.pop('Ktotal')
        notes.add('Ktotal for kTotal')
    sh = o.get('shift95')
    if isinstance(sh, dict):
        sh = dict(sh)
        for g in ('items', 'groups'):
            if isinstance(sh.get(g), dict) and 'q95' in sh[g]:
                x = dict(sh[g])
                x['p95'] = x.pop('q95')
                sh[g] = x
                notes.add('q95 for p95')
        o['shift95'] = sh
    if 'yardstickHits' in o:
        v = o.pop('yardstickHits')
        o['yardstickHit'] = bool(v)
        notes.add('yardstick hits as a list (compared as hit / no hit)')
    if 'intervalsSeen' in o:
        if isinstance(o['intervalsSeen'], dict):
            notes.add('intervalsSeen itemised (compared by its total)')
        o['intervalsSeen'] = _total(o['intervalsSeen'])
    return o


def stage2_one(o, notes):
    if not isinstance(o, dict):
        return o
    o = dict(o)
    if 'Ktotal' in o and 'kTotal' not in o:
        o['kTotal'] = o.pop('Ktotal')
        notes.add('Ktotal for kTotal')
    if 'intervalsSeen' in o:
        if isinstance(o['intervalsSeen'], dict):
            notes.add('intervalsSeen itemised (compared by its total)')
        o['intervalsSeen'] = _total(o['intervalsSeen'])
    if isinstance(o.get('items'), dict):
        items = {}
        for src, it in o['items'].items():
            if not isinstance(it, dict):
                items[src] = it
                continue
            it = dict(it)
            ap = it.pop('c2c3Applied', None)
            if isinstance(ap, dict):
                it.setdefault('c2Applied', ap.get('c2'))
                it.setdefault('c3Applied', ap.get('c3'))
                notes.add('c2c3Applied for c2Applied / c3Applied')
            for c in ('c2', 'c3'):
                if it.get(c + 'Applied') is False and it.get(c) is not None:
                    notes.add('a condition not applied written as met')
                    it[c] = None
            for old, new in (('dUSimLb', 'dULb'), ('dMSimLb', 'dMLb')):
                if old in it and new not in it:
                    it[new] = it.pop(old)
                    notes.add('dUSimLb / dMSimLb for dULb / dMLb')
            if isinstance(it.get('marks'), list):
                names = [MARK_NAMES.get(x, x) for x in it['marks']]
                if names != it['marks']:
                    notes.add('mark names')
                it['marks'] = names
            items[src] = it
        o['items'] = items
    return o


# ---------------------------------------------------------------- both sides: optional and descriptive paths
def _reconcile(a, b, path, opt, desc, notes):
    if isinstance(a, dict) and isinstance(b, dict):
        for k in set(a) ^ set(b):
            p = path + (k,)
            pat = opt(p)
            if pat is not None:
                side = 'py' if k in a else 'ts'
                (a if k in a else b).pop(k)
                notes.add(f'{pat} only in {side} (not compared)')
        for k in set(a) & set(b):
            p = path + (k,)
            pat = desc(p)
            if pat is not None and (a[k] is None) != (b[k] is None):
                side = 'py' if a[k] is None else 'ts'
                notes.add(f'{pat} null in {side} only (not compared)')
                a[k] = b[k] = None
                continue
            _reconcile(a[k], b[k], p, opt, desc, notes)
    elif isinstance(a, list) and isinstance(b, list) and len(a) == len(b):
        for i, (x, y) in enumerate(zip(a, b)):
            _reconcile(x, y, path + (i,), opt, desc, notes)


def canon_pair(name, a, b, sources=(), measures=(), group_of=None):
    """Both sides of one JSON file in the canonical layout: (a, b, notes); notes are strings with the side."""
    group_of = group_of or {}
    na, nb = set(), set()
    if name == 'counts.json':
        a, b = counts_one(a, na, sources, measures, group_of), counts_one(b, nb, sources, measures, group_of)
    elif name == 'stats.json':
        a, b = stats_one(a, na), stats_one(b, nb)
    elif name == 'select.json':
        a, b = select_one(a, na), select_one(b, nb)
    elif name == 'stage2.json':
        a, b = stage2_one(a, na), stage2_one(b, nb)
    # a rewrite made on both sides is no difference between them: only those that leave something uncompared
    notes = [f'{n} (py)' for n in sorted(na - nb)] + [f'{n} (ts)' for n in sorted(nb - na)] + \
        [f'{n} (py+ts)' for n in sorted(na & nb) if 'not compared' in n]
    both = set()
    _reconcile(a, b, (), _matcher(OPTIONAL.get(name, [])), _matcher(DESCRIPTIVE.get(name, [])), both)
    return a, b, notes + sorted(both)
