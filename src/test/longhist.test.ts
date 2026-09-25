import { describe, it, expect } from "vitest";
import {
  TREND_RULES,
  crossSeries,
  donchian55x20,
  ma200,
  parseEcb,
  parseFred,
  placebo,
  portfolio,
  rateBefore,
  simulate,
  statsOf,
  tsmom252,
} from "../../research/longhist-lib";

const ECB = [
  "Date,USD,JPY,GBP,",
  "2026-09-25,1.1700,175.50,0.8700,",
  "2026-09-24,1.1600,N/A,0.8650,",
  "2026-09-23,1.1500,172.50,0.8600,",
].join("\n");

describe("the data", () => {
  it("reads the ECB's per-euro rates and crosses them into pairs", () => {
    const e = parseEcb(ECB);
    expect(e.get("USD")!.get("2026-09-25")).toBe(1.17);
    expect(e.get("JPY")!.has("2026-09-24")).toBe(false);
    const usdjpy = crossSeries(e, "USD", "JPY");
    // a day one leg did not fix is left out, oldest first
    expect(usdjpy.dates).toEqual(["2026-09-23", "2026-09-25"]);
    expect(usdjpy.px[1]).toBeCloseTo(175.5 / 1.17, 10);
    const eurusd = crossSeries(e, "EUR", "USD");
    expect(eurusd.px).toEqual([1.15, 1.16, 1.17]);
    expect(crossSeries(e, "GBP", "USD").px[0]).toBeCloseTo(1.15 / 0.86, 10);
  });

  it("uses a month's rate only once the month is over, and not long after the series stops", () => {
    const rows = parseFred("observation_date,X\n2026-01-01,4.5\n2026-02-01,.\n2026-03-01,4.0\n");
    expect(rows).toEqual([["2026-01-01", 4.5], ["2026-03-01", 4]]);
    expect(rateBefore(rows, "2026-01-20")).toBeNull();
    expect(rateBefore(rows, "2026-02-10")).toBe(4.5);
    expect(rateBefore(rows, "2026-03-31")).toBe(4.5);
    expect(rateBefore(rows, "2026-04-01")).toBe(4.0);
    expect(rateBefore(rows, "2026-07-15")).toBe(4.0);
    expect(rateBefore(rows, "2026-08-15")).toBeNull();
  });
});

const walk = (n: number, seed: number) => {
  let s = seed;
  const rnd = () => {
    s = (s + 0x6d2b79f5) | 0;
    let x = Math.imul(s ^ (s >>> 15), 1 | s);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
  const px: number[] = [];
  let p = 100;
  for (let i = 0; i < n; i++) {
    p *= Math.exp((rnd() - 0.5) * 0.02);
    px.push(p);
  }
  const dates = px.map((_, i) => new Date(Date.parse("2000-01-03T00:00:00Z") + i * 86_400_000).toISOString().slice(0, 10));
  return { dates, px };
};

describe("the rules", () => {
  const d = walk(1500, 3);

  it("never read a later close", () => {
    for (const [name, rule] of Object.entries(TREND_RULES)) {
      const full = rule(d.px);
      for (const cut of [300, 700, 1499]) {
        const part = rule(d.px.slice(0, cut + 1));
        expect(part[cut], `${name} at ${cut}`).toBe(full[cut]);
      }
    }
  });

  it("follow a trend both ways", () => {
    const up = Array.from({ length: 400 }, (_, i) => 100 + i * 0.1);
    const down = up.map((p) => 1 / p);
    for (const [name, rule] of Object.entries(TREND_RULES)) {
      expect(rule(up)[399], name).toBe(1);
      expect(rule(down)[399], name).toBe(-1);
    }
    expect(tsmom252(up)[100]).toBe(0);
    expect(ma200(up)[150]).toBe(0);
  });

  it("the breakout holds until the 20-day exit", () => {
    const px = [...Array.from({ length: 60 }, () => 100), 101, 101.5, 101.2, ...Array.from({ length: 25 }, () => 100.5), 100.2];
    const pos = donchian55x20(px);
    expect(pos[60]).toBe(1);
    expect(pos[70]).toBe(1);
    // 100.2 closes below the last 20 closes (out) but not below the last 55
    // (no new short)
    expect(pos[px.length - 1]).toBe(0);
    // a close below the 55-day low as well turns the exit into a short
    expect(donchian55x20([...px.slice(0, -1), 99])[px.length - 1]).toBe(-1);
  });
});

describe("the simulation", () => {
  it("scales to the target volatility and pays the spread on each change", () => {
    const d = walk(800, 9);
    const always = d.px.map((_, t) => (t < 100 ? 0 : 1));
    const free = simulate(d, always, { pip: 0.01, spreadPips: 0, targetVol: 0.1 });
    const paid = simulate(d, always, { pip: 0.01, spreadPips: 1, targetVol: 0.1 });
    const s = statsOf(d.dates, free.pnl, "2000-06-01", "2100-01-01")!;
    expect(s.annVol).toBeGreaterThan(0.06);
    expect(s.annVol).toBeLessThan(0.16);
    const sumFree = free.pnl.reduce((a, b) => a + b, 0);
    const sumPaid = paid.pnl.reduce((a, b) => a + b, 0);
    expect(sumPaid).toBeLessThan(sumFree);
    expect(paid.turnover).toBeGreaterThan(0);
  });

  it("earns the differential less the haircut on a long, pays it on a short, per calendar day", () => {
    const d = { dates: ["2026-01-02", "2026-01-05", "2026-01-06"], px: [100, 100, 100] };
    // no volatility: scale by hand through a tiny wiggle-free series is 0, so
    // use a long enough series with returns instead
    const dates: string[] = [];
    const px: number[] = [];
    for (let i = 0; i < 100; i++) {
      dates.push(new Date(Date.parse("2026-01-01T00:00:00Z") + i * 86_400_000).toISOString().slice(0, 10));
      px.push(100 * (1 + (i % 2 === 0 ? 0.005 : -0.005)));
    }
    const pos = px.map((_, t) => (t < 30 ? 0 : 1));
    const noCarry = simulate({ dates, px }, pos, { pip: 0.01, spreadPips: 0, targetVol: 0.1 });
    const withCarry = simulate({ dates, px }, pos, { pip: 0.01, spreadPips: 0, targetVol: 0.1, carry: () => 4, haircut: 0.5 });
    const diff = withCarry.pnl.map((x, t) => x - noCarry.pnl[t]);
    // each day held earns (4 - 0.5)% x weight / 365
    expect(diff[50]).toBeGreaterThan(0);
    const short = simulate({ dates, px }, pos.map((p) => -p), { pip: 0.01, spreadPips: 0, targetVol: 0.1, carry: () => 4, haircut: 0.5 });
    const noCarryShort = simulate({ dates, px }, pos.map((p) => -p), { pip: 0.01, spreadPips: 0, targetVol: 0.1 });
    expect(short.pnl[50] - noCarryShort.pnl[50]).toBeLessThan(0);
    // paying 4.5 is worse than earning 3.5 is good
    expect(Math.abs(short.pnl[50] - noCarryShort.pnl[50])).toBeGreaterThan(diff[50]);
    expect(d.px.length).toBe(3);
    const unknown = simulate({ dates, px }, pos, { pip: 0.01, spreadPips: 0, targetVol: 0.1, carry: () => null });
    expect(unknown.carryKnown[50]).toBe(false);
  });

  it("a portfolio averages its legs day by day, and placebos are reproducible", () => {
    const p = portfolio([
      { dates: ["a", "b", "c"], pnl: [0, 0.01, 0.02] },
      { dates: ["a", "b", "c"], pnl: [0, 0.03, 0.0] },
    ]);
    expect(p.dates).toEqual(["b", "c"]);
    expect(p.pnl[0]).toBeCloseTo(0.02, 10);
    expect(placebo(400, 1 / 60, 5)).toEqual(placebo(400, 1 / 60, 5));
    expect(placebo(400, 1 / 60, 5).slice(0, 252).every((x) => x === 0)).toBe(true);
  });
});
