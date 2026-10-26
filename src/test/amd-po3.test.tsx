import { describe, it, expect, afterEach } from "vitest";
import { render as rtlRender, screen, fireEvent, type RenderResult } from "@testing-library/react";
import type { ReactElement } from "react";
import { LocaleProvider } from "@/lib/i18n";
import PriceChart from "../components/PriceChart";
import { CHART_PREFS_KEY, resetChartPrefsCache } from "../lib/chartPrefs";
import { amdPo3, pineFmt, pineFmtTick, pineCss, tvPeriodOf, type AmdBar } from "../lib/amdPo3";
import { amdWalk } from "./amd-po3-walk";
import golden from "./amd-po3-golden.json";

const render = (ui: ReactElement): RenderResult => rtlRender(<LocaleProvider initial="ja">{ui}</LocaleProvider>);
const asBars = (xs: ReadonlyArray<{ open: number; high: number; low: number; close: number }>): AmdBar[] =>
  xs.map((b) => ({ o: b.open, h: b.high, l: b.low, c: b.close }));

const walk = amdWalk(1600);

afterEach(() => {
  localStorage.clear();
  resetChartPrefsCache();
});

describe("#385 AMD Po3 (a port of WillyAlgoTrader's open-source code)", () => {
  it("gives what the independent Python port gives, value for value (events, boxes, lines, labels, the table)", () => {
    // research/amd-po3-check.py, written from the Pine source alone, on the
    // same walk with its last bar still forming (research/amd-po3-golden.ts)
    const { live: _live, ...out } = amdPo3(asBars(walk), { mintick: 0.001, theme: "dark", tf: "15", confirmed: walk.length - 1 });
    expect(out).toEqual(golden);
    const kinds = new Set(out.events.map((e) => e.type));
    for (const k of ["ACCUM", "SWEEP", "MANIP", "DIST", "OUTCOME", "BREAKOUT"]) expect(kinds.has(k as never)).toBe(true);
  });

  it("opens each trade as the script does: entry the close, the target the 1.5 extension on the tick grid, the stop 0.4 ATR past the tip, rounded outward", () => {
    const r = amdPo3(asBars(walk), { mintick: 0.001 });
    const dists = r.events.filter((e) => e.type === "DIST");
    expect(dists.length).toBeGreaterThan(5);
    for (const d of dists) {
      if (d.type !== "DIST") continue;
      const acc = [...r.events].reverse().find((e) => e.type === "ACCUM" && e.bar <= d.bar);
      const man = r.events.find((e) => e.type === "MANIP" && e.bar === d.bar);
      if (!acc || acc.type !== "ACCUM" || !man || man.type !== "MANIP") throw new Error("no range or manipulation");
      const hi = [...r.events].reverse().find((e) => e.type === "RANGE_HIGH" && e.bar > acc.bar && e.bar <= d.bar);
      const lo = [...r.events].reverse().find((e) => e.type === "RANGE_LOW" && e.bar > acc.bar && e.bar <= d.bar);
      const top = hi && hi.type === "RANGE_HIGH" ? hi.value : acc.high;
      const bottom = lo && lo.type === "RANGE_LOW" ? lo.value : acc.low;
      expect(d.entry).toBe(walk[d.bar].close);
      const leg = d.dir === 1 ? top - man.extreme : man.extreme - bottom;
      const tgt = d.dir === 1 ? top + 0.5 * leg : bottom - 0.5 * leg;
      expect(Math.abs(d.target - tgt)).toBeLessThanOrEqual(0.0005 + 1e-9);
      const raw = d.dir === 1 ? man.extreme - 0.4 * acc.atrAnchor : man.extreme + 0.4 * acc.atrAnchor;
      expect(d.dir === 1 ? d.stop <= raw + 1e-9 : d.stop >= raw - 1e-9).toBe(true);
      expect(Math.abs(d.stop - raw)).toBeLessThan(0.001 + 1e-9);
      expect(d.riskR).toBeCloseTo(Math.max(Math.abs(d.entry - d.stop), 0.001), 12);
    }
  });

  it("judges the newest closed bar on the 600 bars ending at it as on the whole history (the email's window, the chart's run)", () => {
    const bars = asBars(walk);
    const full = amdPo3(bars, { mintick: 0.001 }).events.filter((e) => e.type === "DIST");
    const at = new Set(full.map((e) => e.bar).filter((b) => b >= 599));
    // every DIST bar, and the bars around each
    const checked = new Set<number>();
    for (const b of at) for (let k = -3; k <= 3; k++) if (b + k >= 599 && b + k < bars.length) checked.add(b + k);
    for (let b = 599; b < bars.length; b += 37) checked.add(b);
    for (const b of checked) {
      const w = amdPo3(bars.slice(b - 599, b + 1), { mintick: 0.001 }).events.find((e) => e.type === "DIST" && e.bar === 599);
      const f = full.find((e) => e.bar === b);
      expect(w ? { ...w, bar: b, cycle: 0 } : null).toEqual(f ? { ...f, cycle: 0 } : null);
    }
    expect(at.size).toBeGreaterThan(3);
  });

  it("writes numbers as Pine does: half up on the shortest digits, trailing zeros dropped, the tick's decimals kept", () => {
    expect(pineFmt(0.5, 2)).toBe("0.5");
    expect(pineFmt(1, 2)).toBe("1");
    expect(pineFmt(10, 2)).toBe("10");
    expect(pineFmt(2.675, 2)).toBe("2.68");
    expect(pineFmt(-0.004, 2)).toBe("0");
    expect(pineFmt(-1.236, 2)).toBe("-1.24");
    expect(pineFmt(12.5, 0)).toBe("13");
    expect(pineFmt(0.99999, 2)).toBe("1");
    expect(pineFmt(0.00004, 2)).toBe("0");
    expect(pineFmtTick(150.12, 0.001)).toBe("150.120");
    expect(pineFmtTick(150.1234999, 0.001)).toBe("150.123");
    expect(pineFmtTick(1.0850049, 0.00001)).toBe("1.08500");
    expect(pineFmtTick(Number.NaN, 0.01)).toBe("—");
    expect(pineCss(["#3AA66B", 82])).toBe("rgba(58, 166, 107, 0.18)");
    expect(pineCss(null)).toBe("transparent");
    expect([60_000, 900_000, 3_600_000, 14_400_000, 86_400_000, 7 * 86_400_000].map(tvPeriodOf)).toEqual(["1", "15", "60", "240", "D", "W"]);
  });
});

describe("#385 AMD Po3 on the chart", () => {
  const past = walk.slice(0, 1200);
  const shown = walk.slice(1200);

  it("is listed off; on, its boxes, lines and labels, the table row for row and the watermark, from the deep history and the candles", () => {
    render(<PriceChart candles={shown} pair="USD/JPY" interactive={false} deepHistory={{ bars: past, status: "ready" }} />);
    expect(screen.getByTestId("chart-overlay-name-amdPo3").textContent).toBe("AMD Po3（WillyAlgoTrader）");
    expect(screen.getByTestId("chart-toggle-amdPo3").getAttribute("aria-pressed")).toBe("false");
    expect(screen.queryByTestId("chart-amdpo3-boxes")).toBeNull();
    fireEvent.click(screen.getByTestId("chart-toggle-amdPo3"));
    expect(JSON.parse(localStorage.getItem(CHART_PREFS_KEY)!).overlays.amdPo3).toBe(true);

    const r = amdPo3(asBars(walk), { mintick: 0.001, theme: "dark", tf: "15" });
    const off = past.length;
    const seen = (a: number, b: number) => b - off >= -1 && a - off <= shown.length;
    expect(screen.getAllByTestId("chart-amdpo3-box")).toHaveLength(r.boxes.filter((b) => seen(b.left, b.right)).length);
    expect(screen.getAllByTestId("chart-amdpo3-line")).toHaveLength(r.lines.filter((l) => seen(l.x1, l.x2)).length);
    const drawn = screen.getAllByTestId("chart-amdpo3-label").map((g) => `${g.getAttribute("data-bar")}|${g.getAttribute("data-text")}`);
    const texts = drawn.map((d) => d.split("|")[1]);
    // every label anchored on a candle (or up to 6 bars past the newest) is
    // drawn; one anchored before the first candle only while its bubble
    // reaches over the plot, in the run's order
    const at = (l: { x: number; text: string }) => `${l.x - off}|${l.text}`;
    for (const l of r.labels.filter((l) => l.x - off >= 0 && l.x - off <= shown.length + 5)) expect(drawn).toContain(at(l));
    expect(drawn.every((d) => Number(d.split("|")[0]) >= -40)).toBe(true);
    expect(r.labels.map(at).filter((d) => drawn.includes(d))).toEqual(drawn);
    expect(texts).toContain("M");
    expect(texts.some((x) => x === "D ▲" || x === "D ▼")).toBe(true);
    expect(texts.some((x) => x?.startsWith("Entry "))).toBe(true);
    // D's numbers on hover, as the original's tooltip
    const d = screen.getAllByTestId("chart-amdpo3-label").find((g) => g.getAttribute("data-text")?.startsWith("D "))!;
    expect(d.querySelector("title")?.textContent).toMatch(/^Distribution (UP|DOWN)\nSweep: (HIGH|LOW)\nEntry: \d+\.\d{3} \| Stop: \d+\.\d{3}\nTarget: \d+\.\d{3} \| R:R: [\d.]+$/);
    // the table, row for row
    const rows = screen.getAllByTestId("chart-amdpo3-dash-row").map((tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent));
    expect(rows).toEqual(r.dash.map((x) => (x.r === null ? [x.l] : [x.l, x.r])));
    expect(rows[0][0]).toMatch(/^◆ Po3 · /);
    expect(rows[rows.length - 1][0]).toBe("Po3 · v2.4.0");
    expect(screen.getByTestId("chart-amdpo3-watermark").textContent).toBe("WillyAlgoTrader");
    const note = screen.getByTestId("chart-amdpo3-legend").textContent!;
    expect(note).toContain("WillyAlgoTrader");
    expect(note).toContain("読めた足: 1,600本（最初の220本は準備のため判定しません）");
    // and off again
    fireEvent.click(screen.getByTestId("chart-toggle-amdPo3"));
    expect(screen.queryByTestId("chart-amdpo3-boxes")).toBeNull();
    expect(screen.queryByTestId("chart-amdpo3-dash")).toBeNull();
  });

  it("shows a live trade's entry, stop, target, R:R and age in the table, in the direction's header colour", () => {
    localStorage.setItem(CHART_PREFS_KEY, JSON.stringify({ overlays: { amdPo3: true } }));
    resetChartPrefsCache();
    const all = asBars(walk);
    const full = amdPo3(all, { mintick: 0.001 });
    const dist = full.events.find((e) => e.type === "DIST" && e.bar > 1250)!;
    if (dist.type !== "DIST") throw new Error("no trade");
    const upTo = walk.slice(0, dist.bar + 4);
    render(<PriceChart candles={upTo.slice(1200)} pair="USD/JPY" interactive={false} deepHistory={{ bars: upTo.slice(0, 1200), status: "ready" }} />);
    const rows = screen.getAllByTestId("chart-amdpo3-dash-row").map((tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent));
    expect(rows[0][0]).toBe(`◆ Po3 · DISTRIBUTION ${dist.dir === 1 ? "▲" : "▼"}`);
    expect(rows).toContainEqual(["Entry", `${dist.dir === 1 ? "Long" : "Short"} @ ${pineFmtTick(dist.entry, 0.001)}`]);
    expect(rows).toContainEqual(["Stop", pineFmtTick(dist.stop, 0.001)]);
    expect(rows).toContainEqual(["Target", pineFmtTick(dist.target, 0.001)]);
    expect(rows).toContainEqual(["Age", "3 bars"]);
    expect(screen.getAllByTestId("chart-amdpo3-dash-row")[0].getAttribute("style")).toContain(dist.dir === 1 ? "rgb(15, 110, 86)" : "rgb(163, 45, 45)");
    // its price labels, 6 bars past the newest candle, are inside the plot (the
    // chart keeps the room for them, as TradingView's margin shows them)
    const clip = document.querySelector("clipPath rect")!;
    const right = Number(clip.getAttribute("x")) + Number(clip.getAttribute("width"));
    const tags = screen.getAllByTestId("chart-amdpo3-label").filter((g) => /^(Entry|Stop|Target) /.test(g.getAttribute("data-text") ?? ""));
    const live = tags.filter((g) => g.getAttribute("data-text")!.includes(pineFmtTick(dist.entry, 0.001)) || g.getAttribute("data-text")!.includes(pineFmtTick(dist.stop, 0.001)));
    expect(live.length).toBeGreaterThanOrEqual(2);
    for (const g of live) {
      const r = g.querySelector("rect")!;
      expect(Number(r.getAttribute("x")) + Number(r.getAttribute("width"))).toBeLessThanOrEqual(right + 0.5);
    }
  });

  it("is not listed on a chart without the history and too few candles for a first cycle (the analysis and outcome charts)", () => {
    localStorage.setItem(CHART_PREFS_KEY, JSON.stringify({ overlays: { amdPo3: true } }));
    resetChartPrefsCache();
    const { unmount } = render(<PriceChart candles={shown.slice(-120)} pair="USD/JPY" interactive={false} />);
    expect(screen.queryByTestId("chart-overlay-name-amdPo3")).toBeNull();
    expect(screen.queryByTestId("chart-amdpo3-dash")).toBeNull();
    expect(screen.queryByTestId("chart-amdpo3-watermark")).toBeNull();
    expect(screen.queryByTestId("chart-amdpo3-legend")).toBeNull();
    unmount();
    // with candles enough of its own, it is
    render(<PriceChart candles={walk.slice(0, 400)} pair="USD/JPY" interactive={false} />);
    expect(screen.getByTestId("chart-overlay-name-amdPo3")).toBeTruthy();
    expect(screen.getByTestId("chart-amdpo3-dash")).toBeTruthy();
  });

  it("while the bars before the chart are loading, nothing yet, and says so; locked, nothing at all", () => {
    localStorage.setItem(CHART_PREFS_KEY, JSON.stringify({ overlays: { amdPo3: true } }));
    resetChartPrefsCache();
    const { unmount } = render(<PriceChart candles={shown} pair="USD/JPY" interactive={false} deepHistory={{ bars: null, status: "loading" }} />);
    expect(screen.queryByTestId("chart-amdpo3-boxes")).toBeNull();
    expect(screen.queryByTestId("chart-amdpo3-dash")).toBeNull();
    expect(screen.getByTestId("chart-amdpo3-legend").textContent).toContain("読み込み中");
    unmount();
    render(<PriceChart candles={shown} pair="USD/JPY" interactive={false} deepHistory={{ bars: past, status: "ready" }} indicatorsLocked />);
    expect(screen.queryByTestId("chart-amdpo3-boxes")).toBeNull();
    expect(screen.queryByTestId("chart-amdpo3-dash")).toBeNull();
    expect(screen.queryByTestId("chart-amdpo3-watermark")).toBeNull();
  });
});
