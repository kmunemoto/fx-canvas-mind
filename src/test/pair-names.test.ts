import { describe, it, expect } from "vitest";
import { ja } from "@/lib/i18n/ja";
import { PAIR_JA, pairJa } from "../../supabase/functions/_shared/pair-names";
import { LIVE_PAIRS } from "../../supabase/functions/live-chart/logic";
import { ALERT_PAIRS } from "../../supabase/functions/signal-alerts/logic";

// #211: the Japanese emails name each pair as the app's picker does (楽天FX's names)
describe("the pairs' Japanese names in the emails", () => {
  it("are the app's picker's names, pair for pair", () => {
    expect(PAIR_JA).toEqual(ja.live.pairShort);
  });

  it("name every pair an email can be sent for", () => {
    // Q-Trend and ULTRA follow the live chart's pairs; RSI + SAR and the GA-style rule, ALERT_PAIRS
    for (const p of [...LIVE_PAIRS, ...ALERT_PAIRS]) expect(PAIR_JA[p], p).toBeTruthy();
    expect(pairJa("EUR/JPY")).toBe("ユーロ/円");
    expect(pairJa("USD/JPY")).toBe("ドル/円");
    expect(pairJa("AUD/USD")).toBe("豪ドル/ドル");
    expect(pairJa("XAU/USD")).toBe("金");
  });

  it("leave a pair they do not know as its code", () => {
    expect(pairJa("CNH/JPY")).toBe("CNH/JPY");
    // not the object's own built-in names
    expect(pairJa("toString")).toBe("toString");
    expect(pairJa("constructor")).toBe("constructor");
  });
});
