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

  it("exempts the app's own disclaimer, and only when that is the whole string", () => {
    expect(isInference("この分析は参考情報です。投資判断は自己責任で行ってください")).toBe(false);
    expect(isInference("板情報・出来高・建玉・約定履歴は取得していません")).toBe(false);
  });

  it("still tags a claim that carries its own caveat", () => {
    // THE INVERTED INCENTIVE, and the reason whole-string matching replaced
    // the substring check. The prompt now asks the model to write inferences
    // with the caveat attached. Under the old rule a compliant model — caveat
    // and claim in one sentence — went UNTAGGED, while the blunt version was
    // tagged. Obeying the instruction turned the mechanism off.
    expect(isInference("板情報は取得していないため推測だが、157.10の上にストップが溜まっている")).toBe(true);
    expect(isInference("出来高は取得していません。大口の売りが上値を抑えている")).toBe(true);
    expect(isInference("Order book data is not available. Smart money is distributing into strength.")).toBe(true);
  });

  it("does not tag a computed observation that happens to share a word", () => {
    // 買い方 matched inside 買い方向, so two facts computed by the server
    // rendered under a chip saying they were not observed. A chip that
    // appears on measured values stops meaning anything.
    expect(isInference("上位足も買い方向で整合しており、SMA20はSMA50の上にある")).toBe(false);
    expect(isInference("売り方針を継続")).toBe(false);
    // and the plan's own action is not a claim about anyone else
    expect(isInference("157.00割れを確認してから売り仕掛けを検討")).toBe(false);
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
