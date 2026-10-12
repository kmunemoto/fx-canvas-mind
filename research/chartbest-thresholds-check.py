#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
chartbest-thresholds-check.py — docs/OPERATIONS.md §8.113 置8 のしきい値の、別の計算し直し（numpy）。

research/chartbest-thresholds.ts と同じ乱数の列（mulberry32・種 9001〜9003・u ＝ (x＋0.5) ÷ 2^32・
Box–Muller で cos を先、sin を次）を、numpy でまとめて作る（mulberry32 の状態は種＋k×定数なので、
k 番目の値を直接作れる）。z*・H・r は配列の計算で出すので、足す順は TS と違う。
2つの出力（--ts に TS の JSON）を照らし、点の差が 1e−9 を超えるか、表の値（小数3桁）が違えば
終了コード1で終わる。

使い方: python3 research/chartbest-thresholds-check.py [--ts ts-output.json]
"""
import json
import math
import sys

import numpy as np

M = np.uint64(0xFFFFFFFF)


def mulberry_block(seed, n):
    k = np.arange(1, n + 1, dtype=np.uint64)
    s = (np.uint64(seed) + k * np.uint64(0x6D2B79F5)) & M
    t = ((s ^ (s >> np.uint64(15))) * (s | np.uint64(1))) & M
    t2 = ((t ^ (t >> np.uint64(7))) * (t | np.uint64(61))) & M
    t = t ^ ((t + t2) & M)
    return (t ^ (t >> np.uint64(14))).astype(np.float64)


def normals(seed, n):
    x = mulberry_block(seed, 2 * ((n + 1) // 2))
    u1 = (x[0::2] + 0.5) / 4294967296.0
    u2 = (x[1::2] + 0.5) / 4294967296.0
    r = np.sqrt(-2.0 * np.log(u1))
    z = np.empty(2 * len(u1))
    z[0::2] = r * np.cos(2 * np.pi * u2)
    z[1::2] = r * np.sin(2 * np.pi * u2)
    return z[:n]


def point(sorted_v, q):
    return float(sorted_v[int(math.floor(q * (len(sorted_v) - 1)))])


def round3(v):
    return math.copysign(math.floor(abs(v) * 1000 + 0.5) / 1000, v)


def main():
    out = {"firstNormals9001": normals(9001, 4).tolist()}
    # vr
    N, Q, W = 1008, 12, 10000
    a = normals(9001, N * W).reshape(W, N)
    mu = a.mean(axis=1, keepdims=True)
    e = a - mu
    SS = (e * e).sum(axis=1)
    Z = np.concatenate([np.zeros((W, 1)), np.cumsum(a, axis=1)], axis=1)
    d = Z[:, Q:] - Z[:, :-Q] - Q * mu
    m = Q * (N - Q + 1) * (1 - Q / N)
    VR = ((d * d).sum(axis=1) / m) / (SS / (N - 1))
    e2 = e * e
    theta = np.zeros(W)
    for j in range(1, Q):
        theta += (2 * (Q - j) / Q) ** 2 * (N * (e2[:, j:] * e2[:, :-j]).sum(axis=1) / (SS * SS))
    s = np.sort(math.sqrt(N) * (VR - 1) / np.sqrt(theta))
    out["vr"] = {"lo": point(s, 0.025), "hi": point(s, 0.975), "median": point(s, 0.5)}
    # hurst
    W2 = 20000
    rho = normals(9002, 256 * W2).reshape(W2, 256)
    xs, ys = [], []
    for n in (8, 16, 32, 64, 128, 256):
        seg = rho.reshape(W2, 256 // n, n)
        dev = seg - seg.mean(axis=2, keepdims=True)
        Y = np.cumsum(dev, axis=2)
        RS = (Y.max(axis=2) - Y.min(axis=2)) / np.sqrt((dev * dev).sum(axis=2) / n)
        xs.append(math.log(n))
        ys.append(np.log(RS.mean(axis=1)))
    X = np.array(xs)
    Yv = np.stack(ys, axis=1)
    H = ((X - X.mean()) * (Yv - Yv.mean(axis=1, keepdims=True))).sum(axis=1) / ((X - X.mean()) ** 2).sum()
    s = np.sort(H)
    out["hurst"] = {"lo": point(s, 0.025), "hi": point(s, 0.975), "median": point(s, 0.5)}
    # linreg
    y = np.cumsum(normals(9003, 100 * W2).reshape(W2, 100), axis=1)
    dy = y - y.mean(axis=1, keepdims=True)
    r = ((np.arange(100) - 49.5) * dy).sum(axis=1) / np.sqrt(83325 * (dy * dy).sum(axis=1))
    s = np.sort(np.abs(r))
    out["linreg"] = {"absQ80": point(s, 0.8), "median": point(s, 0.5)}
    out["vr"]["table"] = [round3(out["vr"]["lo"]), round3(out["vr"]["hi"])]
    out["hurst"]["table"] = [round3(out["hurst"]["lo"]), round3(out["hurst"]["hi"])]
    out["linreg"]["table"] = round3(out["linreg"]["absQ80"])
    print(json.dumps(out, indent=1))
    if "--ts" in sys.argv:
        ts = json.load(open(sys.argv[sys.argv.index("--ts") + 1], encoding="utf-8"))
        bad = []
        if ts["firstNormals9001"] != out["firstNormals9001"]:
            bad.append("firstNormals9001")
        for item, keys in (("vr", ("lo", "hi", "median")), ("hurst", ("lo", "hi", "median")), ("linreg", ("absQ80", "median"))):
            for k in keys:
                if abs(ts[item][k] - out[item][k]) > 1e-9:
                    bad.append(f"{item}.{k}")
            if ts[item]["table"] != out[item]["table"]:
                bad.append(f"{item}.table")
        print("compare with TS:", "ok" if not bad else "MISMATCH " + ", ".join(bad), file=sys.stderr)
        sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
