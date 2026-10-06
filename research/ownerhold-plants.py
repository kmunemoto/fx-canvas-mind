#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ownerhold-plants.py — docs/OPERATIONS.md §8.102 確かめ A の仕込んだ誤りを、手の例と作り物の値動きを合わせて判定する。

ownerhold.yml の plants の段で、fixtures の段と full の段（6つ）の成果物を集めてから走らせる。
  ROOT/fixtures/plants-fixtures.json          手の例: 誤りごとの変わった数・手の例の照合が失敗した例・失敗した自分の確かめ
  ROOT/fixtures/<例>/dump-<誤り>/pycheck.json  手の例の Python の照らし合わせ（変わった誤りだけ）
  ROOT/full-*/plants-full.json                作り物の値動き: 誤りごとの変わった数・失敗した自分の確かめ
  ROOT/full-*/dump-<誤り>/pycheck.json         作り物の値動きの Python の照らし合わせ

決まり:
  - §8.102: 誤りごとに、その誤りを数える行（ownerhold.ts PLANT_ROWS）で変わった判断と数字の数を、手の例と
    作り物の値動きで合わせ、0 なら仕込みの失敗として止める。
  - 加えて（§8.102 より厳しい側）: 手の例の照合・自分の確かめ・Python の照らし合わせのどれも、手の例でも
    作り物の値動きでも食い違いを出さなかった誤りは、見つけられない誤りとして止める。
  - それぞれの確かめが何件の食い違いを出したかは、表に書く（§8.102: それぞれ食い違いを何件出したかを書く）。
使い方: python3 research/ownerhold-plants.py ROOT 誤り1,誤り2,...
終了コード: 0 = すべての誤りが変わり、変わった所で見つかった。1 = そうでない。2 = 入力の誤り。
"""
import glob
import json
import os
import sys


def die(msg):
    print(f'ownerhold-plants: {msg}', file=sys.stderr)
    sys.exit(2)


def load(path):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError) as e:
        die(f'{path}: {e}')


def py_mismatches(paths):
    return sum(sum(load(p).get('mismatched', {}).values()) for p in paths)


def main():
    if len(sys.argv) != 3:
        die('usage: ownerhold-plants.py ROOT plant1,plant2,...')
    root, plants = sys.argv[1], [p for p in sys.argv[2].split(',') if p]
    fx = load(os.path.join(root, 'fixtures', 'plants-fixtures.json'))
    full = {}
    fulls = sorted(glob.glob(os.path.join(root, 'full-*')))
    if not fulls:
        die(f'{root}: no full-* folders')
    for d in fulls:
        for k, v in load(os.path.join(d, 'plants-full.json')).items():
            if k in full:
                die(f'{k}: in two full runs')
            full[k] = (v, d)
    bad = []
    print(f'{"planted error":24} {"hand ex. changed":>16} {"caught by":32} {"walk changed":>12} {"caught by":32}')
    for p in plants:
        f = fx.get(p, {'changed': 0, 'flagged': [], 'checks': []})
        g, gd = full.get(p, ({'changed': 0, 'checks': []}, None))
        py_f = py_mismatches(glob.glob(os.path.join(root, 'fixtures', '*', f'dump-{p}', 'pycheck.json')))
        py_g = py_mismatches(glob.glob(os.path.join(gd, f'dump-{p}', 'pycheck.json'))) if gd else 0
        by_f = (['worked-out'] if f.get('flagged') else []) + list(f.get('checks', [])) + (['python'] if py_f else [])
        by_g = list(g.get('checks', [])) + (['python'] if py_g else [])
        ch_f, ch_g = f.get('changed', 0), g.get('changed', 0)
        print(f'{p:24} {ch_f:>16} {",".join(by_f) + (f" (python {py_f})" if py_f else "") or "-":32} '
              f'{ch_g:>12} {",".join(by_g) + (f" (python {py_g})" if py_g else "") or "-":32}')
        if ch_f + ch_g == 0:
            bad.append(f'{p}: changed nothing on its rows, on the hand examples or the walk')
        if not by_f and not by_g:
            bad.append(f'{p}: caught by nothing, on the hand examples or the walk')
    for k in sorted(set(full) - set(plants)):
        bad.append(f'{k}: run but not in the list')
    for b in bad:
        print('FAILED', b)
    print('planted errors: ' + ('every one changed its rows and was caught' if not bad else f'{len(bad)} failed'))
    sys.exit(1 if bad else 0)


if __name__ == '__main__':
    main()
