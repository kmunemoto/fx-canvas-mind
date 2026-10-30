#!/usr/bin/env python3
"""EMA cross + return move (#387, docs §8.130): an independent implementation
written only from research/ema-return-spec.md. Standard library only.

    python3 ema_return.py IN.json OUT.json [--windows FROM]
"""
import argparse
import json
import operator

FAST = 20
SLOW = 200
WINDOW = 600
WARM = 400
PIV = 3
SKIP = 2

TOUCH, LINES, RETEST, DONE = "TOUCH", "LINES", "RETEST", "DONE"

# Optional debug hook: set to a list to receive (k, event, details) tuples.
_TRACE = None


def _tr(k, event, **details):
    if _TRACE is not None:
        _TRACE.append((k, event, details))


def ema(xs, length):
    """Pine ta.ema with its seed. None where undefined (k < length-1)."""
    n = len(xs)
    out = [None] * n
    if n < length:
        return out
    s = 0.0
    for i in range(length):
        s = s + xs[i]
    prev = s / length
    out[length - 1] = prev
    alpha = 2 / (length + 1)
    for k in range(length, n):
        prev = alpha * xs[k] + (1 - alpha) * prev
        out[k] = prev
    return out


def _cross(fast, slow, k):
    if k < 1:
        return 0
    f0, s0, f1, s1 = fast[k - 1], slow[k - 1], fast[k], slow[k]
    if f0 is None or s0 is None or f1 is None or s1 is None:
        return 0
    if f0 <= s0 and f1 > s1:
        return 1
    if f0 >= s0 and f1 < s1:
        return -1
    return 0


def _side(d, h, l):
    """The comparisons of one side. BUY is the spec as written; SELL is its
    mirror: h <-> l, max <-> min, > <-> <, >= <-> <=, above <-> below."""
    if d == 1:
        return {
            "far": h,            # h (BUY) / l (SELL): A, swing highs, H, the target side
            "near": l,           # l (BUY) / h (SELL): touch, return move, stop, L1, L2
            "gt": operator.gt,   # >  /  <
            "ge": operator.ge,   # >= /  <=
            "lt": operator.lt,   # <  /  >
            "le": operator.le,   # <= /  >=
            "body": max,         # max(o[R], c[R]) / min(o[R], c[R])
            "worst": min,        # lowest low / highest high
            "name": "BUY",
        }
    return {
        "far": l,
        "near": h,
        "gt": operator.lt,
        "ge": operator.le,
        "lt": operator.gt,
        "le": operator.ge,
        "body": min,
        "worst": max,
        "name": "SELL",
    }


def scan_arrays(o, h, l, c, warm=WARM, piv=PIV, skip=SKIP):
    n = len(c)
    fast = ema(c, FAST)
    slow = ema(c, SLOW)
    entries = []

    phase = None          # None (no setup), TOUCH, LINES, RETEST, DONE
    d = 0
    sd = None
    swing_memo = {}       # (d, p) -> bool
    x = t = aAt = None
    A = None
    B = H = K = Dk = R = None
    cand_upto = None      # the last p already looked at for the current t
    best = None           # the best swing high so far for the current t (and A)

    def is_swing(p):
        key = (d, p)
        v = swing_memo.get(key)
        if v is not None:
            return v
        far, gt, ge = sd["far"], sd["gt"], sd["ge"]
        ok = p - piv >= 0
        if ok:
            fp = far[p]
            for j in range(p + 1, p + piv + 1):
                if not gt(fp, far[j]):
                    ok = False
                    break
        if ok:
            for j in range(p - piv, p):
                if not ge(fp, far[j]):
                    ok = False
                    break
        swing_memo[key] = ok
        return ok

    def diag(j, Bp):
        # diag(j) = A + (h[B] - A) * (j - aAt) / (B - aAt), this order
        return A + (sd["far"][Bp] - A) * (j - aAt) / (Bp - aAt)

    for k in range(warm, n):
        cr = _cross(fast, slow, k)
        if cr != 0:
            d = cr
            sd = _side(d, h, l)
            x = k
            phase = TOUCH
            A = sd["far"][k]
            aAt = k
            t = B = H = K = Dk = R = None
            cand_upto = best = None
            _tr(k, "cross", dir=sd["name"], A=A)
            continue
        if phase is None or phase == DONE:
            continue

        far, near = sd["far"], sd["near"]
        gt, ge, lt, le = sd["gt"], sd["ge"], sd["lt"], sd["le"]

        if phase == TOUCH:
            if gt(far[k], A):
                A = far[k]
                aAt = k
            if le(near[k], slow[k]):
                phase = LINES
                t = k
                cand_upto = t      # swing highs p with t < p
                best = None
                _tr(k, "touch", A=A, aAt=aAt)

        elif phase == LINES:
            # B: among the swing highs p with t < p, p + PIV <= k and h[p] < A,
            # the one with the highest h[p] (the latest of equal highs).
            # A is fixed while t is fixed, so the choice is kept incrementally.
            last_p = k - piv
            p = cand_upto + 1
            while p <= last_p:
                if p > t and is_swing(p) and lt(far[p], A):
                    if best is None or ge(far[p], far[best]):
                        best = p
                p += 1
            if last_p > cand_upto:
                cand_upto = last_p
            Bk = best
            if Bk is not None and gt(c[k], far[Bk]) and gt(c[k], diag(k, Bk)):
                if ge(far[k], A):
                    phase = DONE
                    _tr(k, "break-at-target", B=Bk)
                else:
                    phase = RETEST
                    K = k
                    B = Bk
                    H = far[Bk]
                    Dk = None
                    for j in range(B + 1, K + 1):
                        if gt(c[j], diag(j, B)):
                            Dk = j
                            break
                    R = None
                    _tr(k, "break", B=B, H=H, Dk=Dk)
            elif gt(far[k], A):
                phase = TOUCH
                A = far[k]
                aAt = k
                _tr(k, "new-extreme", A=A)

        elif phase == RETEST:
            if ge(far[k], A):
                phase = DONE
                _tr(k, "target-before-entry")
            elif lt(c[k], H):
                phase = LINES
                _tr(k, "break-failed")
            elif R is not None and gt(c[k], sd["body"](o[R], c[R])):
                E = c[k]
                worst = sd["worst"]
                stop = worst(near[Dk:k + 1])
                L1 = worst(near[t:B + 1])
                L2 = worst(near[B:K + 1])
                tp2 = L2 + (far[B] - L1)
                if not gt(tp2, E):
                    tp2 = None
                rr = (A - E) / (E - stop)
                entries.append({
                    "bar": k, "dir": sd["name"], "x": x, "t": t, "aAt": aAt,
                    "A": A, "B": B, "H": H, "K": K, "Dk": Dk, "R": R,
                    "entry": E, "stop": stop, "tp1": A, "tp2": tp2, "rr": rr,
                })
                phase = DONE
                _tr(k, "entry", R=R)
            elif k >= K + skip + 1 and le(near[k], H):
                R = k
                _tr(k, "return-move")

    return entries


def _arrays(bars):
    o = [float(b["o"]) for b in bars]
    h = [float(b["h"]) for b in bars]
    l = [float(b["l"]) for b in bars]
    c = [float(b["c"]) for b in bars]
    return o, h, l, c


def scan(bars, warm=WARM, piv=PIV, skip=SKIP):
    o, h, l, c = _arrays(bars)
    return scan_arrays(o, h, l, c, warm=warm, piv=piv, skip=skip)


IDX_KEYS = ("bar", "x", "t", "aAt", "B", "K", "Dk", "R")


def scan_windows(bars, start):
    o, h, l, c = _arrays(bars)
    n = len(c)
    out = []
    for i in range(max(start, 0), n):
        lo = i - (WINDOW - 1)
        if lo < 0:
            continue
        ents = scan_arrays(o[lo:i + 1], h[lo:i + 1], l[lo:i + 1], c[lo:i + 1])
        for e in ents:
            if e["bar"] == WINDOW - 1:
                e = dict(e)
                for key in IDX_KEYS:
                    e[key] = e[key] + lo
                out.append(e)
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("inp")
    ap.add_argument("out")
    ap.add_argument("--windows", type=int, default=None, metavar="FROM")
    a = ap.parse_args(argv)
    with open(a.inp) as f:
        bars = json.load(f)["bars"]
    if a.windows is None:
        entries = scan(bars)
    else:
        entries = scan_windows(bars, a.windows)
    with open(a.out, "w") as f:
        json.dump({"entries": entries}, f)


if __name__ == "__main__":
    main()
