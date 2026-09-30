import { describe, it, expect } from "vitest";
import {
  CROSSES,
  CURRENCIES,
  NC,
  TRADED,
  addTo,
  diffStatOf,
  edgeOf,
  edgesOf,
  firesOf,
  gridOf,
  legsOf,
  lowEndOf,
  mergeAggs,
  momentumState,
  newAgg,
  newTable,
  placeboValues,
  rankFires,
  rankState,
  ranksFor,
  ranksOf,
  spearman,
  statOf,
  strengthAt,
  tQuantile,
  tiesOf,
  tOf,
  verdictOf,
  type Agg,
  type Values,
} from "../../research/strength-lib";

// a meter of eight on bars 0 and 1: every value 0 at bar 0; at bar 1 the logs
// below (JPY, USD, EUR, GBP, AUD, NZD, CAD, CHF)
const AT1 = [0, 0.01, 0.02, -0.01, 0.03, -0.02, 0, 0.005];
const two = (): Values => AT1.map((x) => Float64Array.from([0, x]));

describe("#174 the currencies and the pairs", () => {
  it("names the seven yen crosses and the eleven traded pairs by base and quote", () => {
    expect(CURRENCIES).toEqual(["JPY", "USD", "EUR", "GBP", "AUD", "NZD", "CAD", "CHF"]);
    expect(CROSSES).toEqual(["USD/JPY", "EUR/JPY", "GBP/JPY", "AUD/JPY", "NZD/JPY", "CAD/JPY", "CHF/JPY"]);
    expect(TRADED).toHaveLength(11);
    expect(legsOf("EUR/USD")).toEqual([2, 1]);
    expect(legsOf("CHF/JPY")).toEqual([7, 0]);
    expect(() => legsOf("TRY/JPY")).toThrow();
  });
});

describe("#174 the grid", () => {
  it("keeps only the times every series has, joined by time", () => {
    expect(gridOf([[1, 2, 3, 5], [2, 3, 4, 5], [0, 2, 5]])).toEqual([2, 5]);
    expect(gridOf([[1, 2], []])).toEqual([]);
  });
  it("refuses a series out of order (a join by position would hide it)", () => {
    expect(() => gridOf([[1, 3, 2]])).toThrow();
    expect(() => gridOf([[1, 1]])).toThrow();
  });
});

describe("#174 the meter", () => {
  it("works each strength as its move less the eight's mean, by hand", () => {
    const s = new Float64Array(NC);
    expect(strengthAt(two(), 1, 1, s)).toBe(true);
    const mean = 0.035 / 8;
    AT1.forEach((x, c) => expect(s[c]).toBeCloseTo(x - mean, 15));
    expect(s.reduce((a, b) => a + b, 0)).toBeCloseTo(0, 15);
    // the identity: s_A − s_B is A/B's own move
    expect(s[2] - s[1]).toBeCloseTo(0.02 - 0.01, 15);
    expect(strengthAt(two(), 0, 1, s)).toBe(false);
    expect(strengthAt(two(), 1, 2, s)).toBe(false);
  });
  it("ranks the strongest 1, an exact tie to the earlier currency", () => {
    const s = new Float64Array(NC);
    strengthAt(two(), 1, 1, s);
    // AUD 0.03, EUR 0.02, USD 0.01, CHF 0.005, JPY 0 and CAD 0 (JPY first), GBP −0.01, NZD −0.02
    expect(Array.from(ranksOf(s))).toEqual([5, 3, 2, 7, 1, 8, 6, 4]);
    expect(tiesOf(s)).toBe(1);
    expect(Array.from(ranksOf([1, 1, 1, 1, 1, 1, 1, 1]))).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
  it("keeps every bar's ranks, 0 where the lookback is not there", () => {
    const r = ranksFor(two(), 1);
    expect(Array.from(r.subarray(0, NC))).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(Array.from(r.subarray(NC))).toEqual([5, 3, 2, 7, 1, 8, 6, 4]);
  });
  it("gives a pair +1 with its base in the top two and its quote in the bottom two, −1 the mirror", () => {
    const r = ranksFor(two(), 1);
    expect(rankState(r, 1, 4, 5, 2)).toBe(1); // AUD 1, NZD 8
    expect(rankState(r, 1, 5, 4, 2)).toBe(-1);
    expect(rankState(r, 1, 2, 3, 2)).toBe(1); // EUR 2, GBP 7
    expect(rankState(r, 1, 2, 0, 2)).toBe(0); // EUR 2, JPY 5
    expect(rankState(r, 1, 2, 3, 1)).toBe(0); // top one: EUR is not first
    expect(rankState(r, 1, 4, 5, 1)).toBe(1);
    expect(rankState(r, 0, 4, 5, 2)).toBeNull();
    expect(rankState(r, -1, 4, 5, 2)).toBeNull();
  });
  it("gives M the sign of the pair's own move", () => {
    expect(momentumState(two(), 1, 1, 2, 1)).toBe(1);
    expect(momentumState(two(), 1, 1, 1, 2)).toBe(-1);
    expect(momentumState(two(), 1, 1, 0, 6)).toBe(0);
    expect(momentumState(two(), 0, 1, 2, 1)).toBeNull();
  });
});

describe("#174 the signals", () => {
  const states: Array<-1 | 0 | 1 | null> = [null, 0, 1, 1, 0, -1, 1, 1, null, 1];
  it("fires once on entering a state, and on a flip, never from an unknown state", () => {
    const f = firesOf((_p, k) => states[k], 1, states.length, () => true);
    expect(f).toEqual([
      { p: 0, k: 2, side: 1 },
      { p: 0, k: 5, side: -1 },
      { p: 0, k: 6, side: 1 },
    ]);
  });
  it("loses a state entered where no fire may be taken, and does not fire it later", () => {
    const f = firesOf((_p, k) => states[k], 1, states.length, (_p, k) => k !== 2);
    expect(f.map((x) => x.k)).toEqual([5, 6]);
  });
  it("reads the stale meter's ranks from `lag` bars before", () => {
    const v: Values = AT1.map((x) => Float64Array.from([0, 0, x, x, x]));
    const t = newTable(5, 1);
    t.ok.fill(1);
    const r = ranksFor(v, 1);
    // AUD/NZD: bars 1, 3 and 4 have no move, so every strength ties at 0
    // (the order: AUD 5, NZD 6: state 0); bar 2 has AT1's (+1)
    expect(rankFires(r, [[4, 5]], t, 2)).toEqual([{ p: 0, k: 2, side: 1 }]);
    expect(rankFires(r, [[4, 5]], t, 2, 1)).toEqual([{ p: 0, k: 3, side: 1 }]);
    // never from bar 0's unknown ranks
    expect(rankFires(r, [[4, 5]], t, 2, 2)).toEqual([{ p: 0, k: 4, side: 1 }]);
  });
});

describe("#174 the yardstick and the numbers kept", () => {
  it("takes e as half the side's pips less the other side's", () => {
    expect(edgeOf(10, -14, 1)).toBe(12);
    expect(edgeOf(10, -14, -1)).toBe(-12);
  });
  it("works the standard error from the clusters' sums, C / (C − 1)", () => {
    const a = newAgg();
    addTo(a, 0, 1);
    addTo(a, 0, 3);
    addTo(a, 1, 5);
    addTo(a, 5, -1);
    const st = statOf(a, "weeks")!;
    // mean 2; clusters: (4 − 2·2) = 0, (5 − 2) = 3, (−1 − 2) = −3
    expect(st.m).toBe(2);
    expect(st.C).toBe(3);
    expect(st.se).toBeCloseTo(Math.sqrt((3 / 2) * 18) / 4, 12);
    // blocks: weeks 0 and 1 in block 0, week 5 in block 1
    const sb = statOf(a, "blocks")!;
    expect(sb.C).toBe(2);
    expect(sb.se).toBeCloseTo(Math.sqrt(2 * ((9 - 6) ** 2 + (-1 - 2) ** 2)) / 4, 12);
    expect(statOf(newAgg(), "weeks")).toBeNull();
  });
  it("gives a difference of a set with itself 0 and a standard error of 0", () => {
    const a = newAgg();
    [[0, 1], [1, 4], [2, -2], [2, 7]].forEach(([w, x]) => addTo(a, w, x));
    const d = diffStatOf(a, a, "weeks")!;
    expect(d.m).toBe(0);
    expect(d.se).toBe(0);
  });
  it("works the joint standard error by hand, weeks shared", () => {
    const x = newAgg();
    const y = newAgg();
    addTo(x, 0, 2);
    addTo(x, 1, 4);
    addTo(y, 1, 1);
    addTo(y, 2, 3);
    // mx 3, my 2; u0 = (2 − 3)/2 = −0.5; u1 = (4 − 3)/2 − (1 − 2)/2 = 1; u2 = −(3 − 2)/2 = −0.5
    const d = diffStatOf(x, y, "weeks")!;
    expect(d.m).toBe(1);
    expect(d.C).toBe(3);
    expect(d.se).toBeCloseTo(Math.sqrt(1.5 * (0.25 + 1 + 0.25)), 12);
  });
  it("merges sums as if kept together", () => {
    const a = newAgg();
    const b = newAgg();
    addTo(a, 0, 1);
    addTo(b, 0, 2);
    addTo(b, 9, 3);
    const m = mergeAggs([a, undefined, b]);
    expect(m.n).toBe(3);
    expect(m.sum).toBe(6);
    expect(m.weeks.get(0)).toEqual({ n: 2, s: 3 });
    expect(m.blocks.get(2)).toEqual({ n: 1, s: 3 });
  });
});

describe("#174 the pick and the call", () => {
  it("has Student's t", () => {
    for (const [p, df, want] of [[0.975, 1, 12.706], [0.975, 10, 2.228], [0.975, 17, 2.11], [0.975, 70, 1.994], [0.9875, 17, 2.458]]) {
      expect(tQuantile(p, df)).toBeCloseTo(want, 2);
    }
  });
  // one trade a week, its pips `f(w)`
  const weekly = (weeks: number, f: (w: number) => number): Agg => {
    const a = newAgg();
    for (let w = 0; w < weeks; w++) addTo(a, w, f(w));
    return a;
  };
  it("takes the low end as the lower of by week and by four weeks", () => {
    const a = weekly(40, (w) => 1 + (w % 2 ? 1 : -1));
    const lw = statOf(a, "weeks")!;
    const lb = statOf(a, "blocks")!;
    const want = Math.min(lw.m - tQuantile(0.975, lw.C - 1) * lw.se, lb.m - tQuantile(0.975, lb.C - 1) * lb.se);
    expect(lowEndOf(a)).toBeCloseTo(want, 12);
    expect(lowEndOf(weekly(1, () => 1))).toBeNull();
  });
  it("picks the higher t on the first half, and calls only on the second half's low end above 0 in 30 weeks or more", () => {
    const noisy = (m: number, weeks: number) => weekly(weeks, (w) => m + (w % 2 ? 3 : -3));
    // candidate 1 the higher t on the first half
    const v = verdictOf([noisy(0.2, 40), noisy(1, 40)], [noisy(-1, 40), noisy(2, 40)]);
    expect(v.pick).toBe(1);
    expect(v.t[1]!).toBeGreaterThan(v.t[0]!);
    expect(v.called).toBe(true);
    expect(v.low!).toBeGreaterThan(0);
    expect(v.bonf).toEqual([false, true]);
    // the same second half in 29 weeks: cannot say
    const short = verdictOf([noisy(0.2, 40), noisy(1, 40)], [noisy(-1, 29), noisy(2, 29)]);
    expect(short.called).toBe(false);
    expect(short.weeks).toBe(29);
    // picked on the first half: the other's second half does not make a call
    const other = verdictOf([noisy(1, 40), noisy(0.2, 40)], [noisy(-1, 40), noisy(2, 40)]);
    expect(other.pick).toBe(0);
    expect(other.called).toBe(false);
    expect(other.bonf).toEqual([false, true]);
  });
  it("breaks a tie in t toward the earlier candidate", () => {
    const a = weekly(40, (w) => 1 + (w % 2 ? 3 : -3));
    expect(tOf(a)).toBe(tOf(weekly(40, (w) => 1 + (w % 2 ? 3 : -3))));
    expect(verdictOf([a, weekly(40, (w) => 1 + (w % 2 ? 3 : -3))], [a, a]).pick).toBe(0);
  });
  it("adds a fire's e to the half its close is in, the first half's only where pickable", () => {
    const t = newTable(3, 2);
    t.half.set([0, 0, 1]);
    t.week.set([10, 10, 11]);
    // pair 0: bars 0, 1, 2; pair 1: bar 1 without a trade
    t.buy.set([2, 4, 6], 0);
    t.sell.set([-2, 0, -6], 0);
    t.pickable.set([1, 0, 0], 0);
    const x = edgesOf(
      [
        { p: 0, k: 0, side: 1 },
        { p: 0, k: 1, side: -1 },
        { p: 0, k: 2, side: -1 },
        { p: 1, k: 1, side: 1 },
      ],
      t,
    );
    expect(x.n).toBe(3);
    expect(x.first.n).toBe(1);
    expect(x.first.sum).toBe(2);
    expect(x.second.n).toBe(1);
    expect(x.second.sum).toBe(-6);
    expect(x.all.sum).toBe(2 - 2 - 6);
  });
});

describe("#174 the placebos and the IC", () => {
  it("makes the same made-up meter from the same seed, another from another", () => {
    const a = placeboValues(1, 50);
    const b = placeboValues(1, 50);
    const c = placeboValues(2, 50);
    expect(a).toHaveLength(NC);
    for (let k = 0; k < NC; k++) {
      expect(a[k][0]).toBe(0);
      expect(Array.from(a[k])).toEqual(Array.from(b[k]));
    }
    expect(Array.from(a[3])).not.toEqual(Array.from(c[3]));
    // the yen moves too
    expect(a[0].some((x) => x !== 0)).toBe(true);
  });
  it("has Spearman 1 for the same order and −1 for the reverse", () => {
    const x = [8, 7, 6, 5, 4, 3, 2, 1];
    expect(spearman(x, x)).toBe(1);
    expect(spearman(x, [...x].reverse())).toBe(-1);
    // one swap of neighbours: 1 − 6·2 / 504
    expect(spearman(x, [7, 8, 6, 5, 4, 3, 2, 1])).toBeCloseTo(1 - 12 / 504, 12);
  });
});
