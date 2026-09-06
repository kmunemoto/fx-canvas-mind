import { describe, it, expect } from "vitest";
import { isInference } from "../lib/inference";

// The strings below are taken from what the model actually wrote in
// production, not invented for the test.
describe("telling a reading of price from a claim about who is trading", () => {
  it("tags the claims the app has no data for", () => {
    expect(isInference("直近高値の外側にストップが溜まっている可能性")).toBe(true);
    expect(isInference("大口の売りが上値を抑えている")).toBe(true);
    expect(isInference("スマートマネーは分配局面")).toBe(true);
    expect(isInference("ストップ狩りの後に反転")).toBe(true);
    // and in English, because the prose follows the reader's locale — a
    // Japanese-only list would leave every English run untagged
    expect(isInference("Stops are resting above 157.10")).toBe(true);
    expect(isInference("Smart money appears to be in distribution")).toBe(true);
    expect(isInference("a liquidity grab above the swing high")).toBe(true);
    expect(isInference("INSTITUTIONAL selling into strength")).toBe(true);
  });

  it("leaves a plain reading of the numbers alone", () => {
    expect(isInference("RSI14は44.1で、50を下回っている")).toBe(false);
    expect(isInference("価格はSMA20の下にある")).toBe(false);
    expect(isInference("Price closed below the 20-period moving average")).toBe(false);
    expect(isInference("ADX is 18, so the trend is weak")).toBe(false);
  });

  it("does not tag the app's own admission that it has no such data", () => {
    // These sentences contain the vocabulary precisely because they are the
    // disclosure. Tagging them as inference would be exactly backwards.
    expect(isInference("板情報・出来高・建玉は取得していません")).toBe(false);
    expect(isInference("出来高データは取得していないため、出来高分析は行っていない")).toBe(false);
    expect(isInference("Order book and volume are not available to this app")).toBe(false);
    expect(isInference("この分析は参考情報です。投資判断は自己責任で行ってください")).toBe(false);
  });

  it("says nothing about empty or missing text", () => {
    expect(isInference("")).toBe(false);
    expect(isInference(null)).toBe(false);
    expect(isInference(undefined)).toBe(false);
  });

  it("is a floor, not a filter — and the limit is stated in the module", () => {
    // Vocabulary matching loses to paraphrase. This test records the known
    // gap rather than pretending it is closed: the sentence below is the same
    // claim in words the list does not contain.
    expect(isInference("157.10を上抜ければ加速しやすい")).toBe(false);
  });
});
