import { describe, it, expect, vi, afterEach } from "vitest";
import { render as rtlRender, screen, waitFor, act, type RenderResult } from "@testing-library/react";
import type { ReactElement } from "react";
import { LocaleProvider } from "@/lib/i18n";

vi.mock("@/lib/supabase", () => ({ supabase: {} }));

import LiveChart from "../components/LiveChart";
import { normalizeLiveRead, type LiveRead, type Tick } from "../lib/liveChart";
import { liveRead } from "../../supabase/functions/live-chart/logic";
import type { QuoteCandle } from "../../supabase/functions/track-outcomes/quotes";

// #181: the live chart card on a month's and a week's bars (docs §8.92)

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const render = (ui: ReactElement): RenderResult => rtlRender(<LocaleProvider initial="ja">{ui}</LocaleProvider>);

// GMO's bars, stamped as GMO stamps them: a month at 21:00 UTC on the day
// before its first (06:00 JST on the 1st), a week at 21:00 UTC on Saturday
const q = (t: number, p: number): QuoteCandle => {
  const at = new Date(t).toISOString();
  const c = { datetime: at, open: p, high: p + 0.8, low: p - 0.7, close: p + 0.3 };
  return { datetime: at, bid: c, ask: { ...c, open: p + 0.003, high: p + 0.803, low: p - 0.697, close: p + 0.303 } };
};
const months = (to: number): QuoteCandle[] => {
  const out: QuoteCandle[] = [];
  for (let y = 2023; y <= 2026; y++) {
    for (let m = 0; m < 12; m++) {
      const t = Date.UTC(y, m, 1) - 3 * HOUR;
      if (t <= to) out.push(q(t, 140 + out.length * 0.4));
    }
  }
  return out;
};
const weeks = (to: number): QuoteCandle[] => {
  const out: QuoteCandle[] = [];
  for (let t = Date.parse("2022-12-31T21:00:00Z"); t <= to; t += 7 * DAY) out.push(q(t, 140 + Math.sin(out.length / 9) * 5));
  return out;
};
const readOf = (interval: string, quotes: QuoteCandle[], now: number): LiveRead => normalizeLiveRead(liveRead("USD/JPY", interval, quotes, now))!;

afterEach(() => {
  vi.useRealTimers();
});

describe("#181 the live chart on a month's bars", () => {
  it("moves the month forming (a 30-day one) with the price, says the close's date and the days left, and starts the next month at its open", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // mid-November: its bar opened 2026-10-31 21:00 UTC and closes 2026-11-30 21:00 UTC
    const now = Date.parse("2026-11-15T00:00:00Z");
    vi.setSystemTime(now);
    const read = readOf("1month", months(now), now);
    expect(read.formingOpen).toBe(Date.parse("2026-10-31T21:00:00Z"));
    expect(read.nextClose).toBe("2026-11-30T21:00:00.000Z");
    let tick: Tick = { bid: 160.499, ask: 160.501, mid: 160.5, time: new Date(now).toISOString(), open: true };
    let calls = 0;
    // the read after the first never answers: what moves the chart is the price
    const loadBars = vi.fn((): Promise<LiveRead> => (++calls === 1 ? Promise.resolve(read) : new Promise<LiveRead>(() => {})));
    const loadTicks = vi.fn(async () => ({ "USD/JPY": tick }));
    render(<LiveChart defaultInterval="1month" loadBars={loadBars} loadTicks={loadTicks} />);
    // the price moves the month's bar: its close is the price now
    await waitFor(() => expect(screen.getByTestId("chart-price-now").textContent).toBe("160.500"));
    // the close on another day: its date (06:00 JST on 1 December) and the days left
    const next = screen.getByTestId("live-next-close").textContent ?? "";
    expect(next).toContain("12-01 06:00");
    expect(next).toMatch(/あと 15日 2\d:\d\d:\d\d/);
    // past the month's end: the next month starts there, closing at the end of December
    tick = { bid: 161.199, ask: 161.201, mid: 161.2, time: "2026-11-30T21:00:30.000Z", open: true };
    vi.setSystemTime(Date.parse("2026-11-30T21:00:31Z"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000);
    });
    await waitFor(() => expect(screen.getByTestId("live-next-close").textContent).toContain("01-01 06:00"));
    expect(screen.getByTestId("chart-price-now").textContent).toBe("161.200");
  });
});

describe("#181 the live chart on a week's bars", () => {
  it("labels the time axis with the year, and counts down in days", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const now = Date.parse("2026-10-01T12:00:00Z");
    vi.setSystemTime(now);
    const read = readOf("1week", weeks(now), now);
    expect(read.formingOpen).toBe(Date.parse("2026-09-26T21:00:00Z"));
    render(<LiveChart defaultInterval="1week" loadBars={async () => read} loadTicks={async () => ({})} />);
    await waitFor(() => expect(screen.getByTestId("live-next-close")).toBeTruthy());
    expect(screen.getByTestId("live-next-close").textContent).toContain("10-04 06:00");
    expect(screen.getByTestId("live-next-close").textContent).toMatch(/あと 2日 /);
    const labels = Array.from(document.querySelectorAll("[data-time-label]")).map((n) => n.textContent ?? "");
    expect(labels.length).toBeGreaterThan(2);
    for (const label of labels) expect(label).toMatch(/^20\d\d\/\d\d\/\d\d$/);
    // the timeframe's name on the tab
    expect(screen.getByTestId("live-interval-1week").getAttribute("aria-selected")).toBe("true");
  });
});
