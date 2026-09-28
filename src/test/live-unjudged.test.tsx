import { describe, it, expect, vi, afterEach } from "vitest";
import { render, waitFor, act } from "@testing-library/react";
import { LocaleProvider } from "@/lib/i18n";

vi.mock("@/lib/supabase", () => ({ supabase: {} }));

// the chart itself is not what is checked here: what the live chart tells it
const seen: Array<{ n: number; formingLast?: boolean; unjudged?: number }> = [];
vi.mock("../components/PriceChart", () => ({
  default: (p: { candles: unknown[]; formingLast?: boolean; unjudged?: number }) => {
    seen.push({ n: p.candles.length, formingLast: p.formingLast, unjudged: p.unjudged });
    return null;
  },
}));

import LiveChart from "../components/LiveChart";
import { normalizeLiveRead, type LiveRead } from "../lib/liveChart";
import { liveRead } from "../../supabase/functions/live-chart/logic";
import type { QuoteCandle } from "../../supabase/functions/track-outcomes/quotes";

const M1 = 60_000;

describe("#149 the live chart leaves the bars the prices made out of the indicators' judging", () => {
  afterEach(() => {
    vi.useRealTimers();
    seen.length = 0;
  });

  it("the forming bar only, then — once the prices start the next bar before the next read — that one and the bar it closed", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const formingAt = Math.floor(Date.now() / M1) * M1;
    const quotes: QuoteCandle[] = Array.from({ length: 201 }, (_, i) => {
      const t = new Date(formingAt - (200 - i) * M1).toISOString();
      const p = 150 + Math.sin(i / 7) * 0.05;
      const side = (d: number) => ({ datetime: t, open: p + d, high: p + 0.01 + d, low: p - 0.01 + d, close: p + d });
      return { datetime: t, bid: side(-0.002), ask: side(0.002) };
    });
    const first = normalizeLiveRead(liveRead("USD/JPY", "1min", quotes, formingAt + 5_000))!;
    let calls = 0;
    // the read after the close never answers
    const loadBars = vi.fn((): Promise<LiveRead> => (++calls === 1 ? Promise.resolve(first) : new Promise<LiveRead>(() => {})));
    const loadTicks = vi.fn(async () => ({
      "USD/JPY": { bid: 150.02, ask: 150.024, mid: 150.022, time: new Date(Date.now()).toISOString(), open: true },
    }));
    render(
      <LocaleProvider initial="ja">
        <LiveChart defaultInterval="1min" loadBars={loadBars} loadTicks={loadTicks} />
      </LocaleProvider>,
    );
    await waitFor(() => expect(seen.some((s) => s.n === first.candles.length)).toBe(true));
    expect(seen.filter((s) => s.n === first.candles.length).every((s) => s.unjudged === 1 && s.formingLast)).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(formingAt + M1 - Date.now() + 6_000);
    });
    await waitFor(() => expect(seen.some((s) => s.n === first.candles.length + 1)).toBe(true));
    expect(seen.filter((s) => s.n === first.candles.length + 1).every((s) => s.unjudged === 2 && s.formingLast)).toBe(true);
  });
});
