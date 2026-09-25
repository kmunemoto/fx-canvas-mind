import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { LocaleProvider } from "@/lib/i18n";
import ControlBar from "@/components/ControlBar";
import { SPREAD_SHARE_OF_STOP, formatLoss, lossPer10k } from "@/lib/costs";

describe("what a stop costs per 10,000 units (#111)", () => {
  it("is in yen for a yen cross and in dollars for a dollar pair, never converted", () => {
    expect(lossPer10k("USD/JPY", 150.123, 149.5)).toEqual({ amount: expect.closeTo(6230, 6), currency: "JPY" });
    expect(formatLoss(lossPer10k("USD/JPY", 150.123, 149.5)!)).toBe("¥6,230");
    expect(lossPer10k("EUR/USD", 1.1, 1.1008)).toEqual({ amount: expect.closeTo(8, 6), currency: "USD" });
    expect(formatLoss(lossPer10k("EUR/USD", 1.1, 1.1008)!)).toBe("$8.00");
    expect(lossPer10k("EUR/GBP", 0.85, 0.849)).toBeNull();
    expect(lossPer10k("USD/JPY", 150, 150)).toBeNull();
  });
});

describe("the spread's share of the stop, by timeframe (#111)", () => {
  it("is the measured one where it was measured, and nothing is claimed elsewhere", () => {
    expect(SPREAD_SHARE_OF_STOP["15min"]).toBe(0.14);
    expect(SPREAD_SHARE_OF_STOP["4h"]).toBe(0.06);
    expect(SPREAD_SHARE_OF_STOP["1min"]).toBeNull();
    expect(SPREAD_SHARE_OF_STOP["1day"]).toBeNull();
  });

  it("is said under the timeframe picker, and the short ones point to the long ones", () => {
    const props = {
      onIntervalChange: () => {},
      onAnalyze: () => {},
      loading: false,
      loadingStage: "idle" as const,
      remaining: null,
      includeFundamental: true,
      onIncludeFundamentalChange: () => {},
    };
    const at = (interval: "15min" | "4h" | "1day") => (
      <LocaleProvider initial="ja">
        <ControlBar {...props} interval={interval} />
      </LocaleProvider>
    );
    const { rerender } = render(at("15min"));
    expect(screen.getByTestId("interval-cost-wide").textContent).toContain("15分足はスプレッドだけで損切り幅の約14%");
    expect(screen.getByTestId("interval-cost-wide").textContent).toContain("4時間足・日足の方が負担は小さく");
    rerender(at("4h"));
    expect(screen.getByTestId("interval-cost-wide").textContent).toContain("約6%");
    expect(screen.getByTestId("interval-cost-wide").textContent).not.toContain("方が負担は小さく");
    rerender(at("1day"));
    expect(screen.getByTestId("interval-cost-wide").textContent).toContain("未測定");
  });
});
