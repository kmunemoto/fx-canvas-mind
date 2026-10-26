"""#385 (docs §8.128): random-walk OHLC cases for diffing the two AMD Po3 ports
(python3 research/amd-po3-cases.py OUT_DIR 40).

Prices live on the tick grid (integer ticks written with exactly d decimals), with
low/high volatility regimes (compression -> ranges), wick spikes (sweeps that return),
gaps, and a "coarse" mode (moves in multiples of k ticks) that forces ties and exact
tolerance/target touches.
"""
import json, random, sys, os

def make(seed, d, p0, n, coarse, confirmed_last):
    rnd = random.Random(seed)
    tick = 1 / 10 ** d
    k = coarse or 1
    x = round(p0 / tick)
    x -= x % k
    bars = []
    t = 1_700_000_000_000
    regime_left = 0
    sigma = 1.0
    for i in range(n):
        if regime_left <= 0:
            low = rnd.random() < 0.55
            sigma = (rnd.uniform(1.5, 5) if low else rnd.uniform(6, 25)) * (p0 / tick / 10800)
            regime_left = rnd.randint(25, 140) if low else rnd.randint(10, 90)
        regime_left -= 1
        o = x
        if rnd.random() < 0.02:
            o += k * round(rnd.gauss(0, sigma * 1.5) / k)
        c = o + k * round(rnd.gauss(0, sigma) / k)
        h = max(o, c) + k * round(abs(rnd.gauss(0, sigma * 0.7)) / k)
        l = min(o, c) - k * round(abs(rnd.gauss(0, sigma * 0.7)) / k)
        r = rnd.random()
        if r < 0.035:
            h += k * round(rnd.uniform(2, 6) * sigma / k)
        elif r < 0.07:
            l -= k * round(rnd.uniform(2, 6) * sigma / k)
        if rnd.random() < 0.01:   # a flat bar
            h = l = c = o
        x = c
        f = lambda v: float(f"{v / 10 ** d:.{d}f}")
        bars.append([t, f(o), f(h), f(l), f(c)])
        t += 15 * 60_000
    return {"mintick": 1 / 10 ** d, "theme": "dark" if seed % 2 == 0 else "light",
            "tf": ["15", "60", "5", "240", "D"][seed % 5],
            "confirmed": n - 1 if confirmed_last else n, "bars": bars}

if __name__ == "__main__":
    out = sys.argv[1]
    count = int(sys.argv[2]) if len(sys.argv) > 2 else 40
    specs = [(3, 150.0), (5, 1.08), (2, 2400.0), (3, 98.0), (5, 0.65)]
    for s in range(count):
        d, p0 = specs[s % len(specs)]
        coarse = [0, 0, 5, 10][s % 4]
        n = 2500 + (s * 977) % 3500
        case = make(5000 + s, d, p0, n, coarse, s % 3 == 0)
        with open(os.path.join(out, f"case{s:03d}.json"), "w") as fh:
            json.dump(case, fh)
    print("wrote", count)
