# #176: how far the chart's Zero-lag TEMA (src/lib/zlTema.ts) is from
# TradingView's with N closed bars read before the 120 it draws (docs §8.87).
#
# TradingView's line is taken to be Pine's own (each ta.ema starts from the
# simple average of its first n values) computed over a long history: here
# 4,000 bars of a random walk. The chart's is the port (each EMA starts from
# its first value; no crossing marked up to and on the bar where the closes
# first move from the first one) over the N + 120 newest bars only. For 120
# walks (seed 2026), on the 120 bars drawn, it counts:
#   same marks:  walks whose L/S marks (ta.crossover / ta.crossunder of the
#                fast line, 22, and the slow one, 144) are TradingView's
#   max slow:    the largest gap of the slow line, in units of a bar's mean
#                move (the mean |close - previous close| of the walk)
#   wrong bars:  bars coloured otherwise (fast > slow or not), mean and most
#                of the 120 walks
# and, for comparison, the same with Pine's own start over N + 120 bars.
#
#   python3 research/zltema-warmup.py
import random
import statistics


def pine_ema(src, n):
    a = 2 / (n + 1)
    out = [None] * len(src)
    prev = None
    for i in range(len(src)):
        if prev is None:
            if i >= n - 1 and all(src[j] is not None for j in range(i - n + 1, i + 1)):
                prev = sum(src[i - n + 1:i + 1]) / n
                out[i] = prev
        elif src[i] is not None:
            prev = a * src[i] + (1 - a) * prev
            out[i] = prev
    return out


def ema_first(src, n):
    a = 2 / (n + 1)
    out = []
    prev = None
    for x in src:
        prev = x if prev is None else a * x + (1 - a) * prev
        out.append(prev)
    return out


def tema_with(ema):
    def tema(src, n):
        e1 = ema(src, n)
        e2 = ema(e1, n)
        e3 = ema(e2, n)
        return [None if (x is None or y is None or z is None) else 3 * (x - y) + z for x, y, z in zip(e1, e2, e3)]
    return tema


def zero_lag(ema):
    tema = tema_with(ema)
    return lambda src, n: tema(tema(src, n), n)


ZL_PINE = zero_lag(pine_ema)
ZL_PORT = zero_lag(ema_first)


def marks(fast, slow, parted_at):
    # the bars of the window (index i) marked L or S; none up to and on
    # window index parted_at (the port's rule; -1 for Pine's line)
    out = []
    for i in range(1, len(fast)):
        if i <= parted_at or None in (fast[i], slow[i], fast[i - 1], slow[i - 1]):
            continue
        if fast[i] > slow[i] and fast[i - 1] <= slow[i - 1]:
            out.append((i, "L"))
        elif fast[i] < slow[i] and fast[i - 1] >= slow[i - 1]:
            out.append((i, "S"))
    return out


WALKS = 120
DRAWN = 120
PORT_NS = (0, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 1200)
PINE_NS = (1200, 1500)

random.seed(2026)
rows = {("port", n): {"same": 0, "max": 0.0, "wrong": []} for n in PORT_NS}
rows.update({("pine", n): {"same": 0, "max": 0.0, "wrong": []} for n in PINE_NS})
for _ in range(WALKS):
    drift = random.choice([0, 0, 0.05, -0.05, 0.15, -0.15])
    xs = [1000.0]
    for i in range(4000):
        d = drift if i < 3100 else random.choice([drift, 0])
        xs.append(xs[-1] + random.gauss(d, 1.0))
    mean_move = statistics.mean(abs(xs[i] - xs[i - 1]) for i in range(1, len(xs)))
    tv_fast = ZL_PINE(xs, 22)[-DRAWN:]
    tv_slow = ZL_PINE(xs, 144)[-DRAWN:]
    tv_marks = marks(tv_fast, tv_slow, -1)
    tv_side = [f > s for f, s in zip(tv_fast, tv_slow)]
    for (kind, n), row in rows.items():
        part = xs[-(n + DRAWN):]
        zl = ZL_PORT if kind == "port" else ZL_PINE
        fast = zl(part, 22)[-DRAWN:]
        slow = zl(part, 144)[-DRAWN:]
        if kind == "port":
            moved = next((k for k, c in enumerate(part) if c != part[0]), len(part))
            parted_at = moved - n
        else:
            parted_at = -1
        if kind == "pine" and slow[0] is None:
            continue
        row["max"] = max(row["max"], max(abs(a - b) for a, b in zip(slow, tv_slow)) / mean_move)
        if marks(fast, slow, parted_at) == tv_marks:
            row["same"] += 1
        row["wrong"].append(sum(1 for f, s, t in zip(fast, slow, tv_side) if (f > s) != t))

print(f"{WALKS} walks (seed 2026), the {DRAWN} bars drawn")
print("start  bars before  same marks  max slow (mean moves)  wrong bars mean (most)")
for (kind, n), row in rows.items():
    w = row["wrong"]
    print(f"{kind:5}  {n:11}  {row['same']:5}/{WALKS}  {row['max']:21.3f}  {statistics.mean(w):.2f} ({max(w)})")
