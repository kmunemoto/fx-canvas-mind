import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { DISCLAIMER_MARKERS, SERVER_REASON_MARKERS, isDisclaimer, visibleWarnings, waitReasonOf } from "../lib/warnings";
import type { EntryCheck } from "../lib/types";

const locale = readFileSync("supabase/functions/analyze/locale.ts", "utf8");

describe("the disclaimer filter", () => {
  it("uses the same markers the server recognises the disclaimer by", () => {
    // withDisclaimer in analyze/locale.ts decides "already present" by these
    // substrings; the client has to drop by the same test or the two drift.
    for (const marker of DISCLAIMER_MARKERS) {
      expect(locale).toContain(`disclaimerMarker: "${marker}"`);
    }
    expect(locale.match(/disclaimerMarker: "/g)).toHaveLength(DISCLAIMER_MARKERS.length);
  });

  it("drops the disclaimer in either language, case-insensitively, and nothing else", () => {
    expect(isDisclaimer("この分析は参考情報です。投資判断は自己責任で行ってください")).toBe(true);
    expect(isDisclaimer("This analysis is reference information. Trading decisions are Your Own Responsibility.")).toBe(true);
    expect(isDisclaimer("指標発表が近い")).toBe(false);
    expect(visibleWarnings(
      ["指標発表が近い", "この分析は参考情報です。投資判断は自己責任で行ってください"],
      { reasonShown: false, mode: "full" },
    )).toEqual(["指標発表が近い"]);
  });
});

describe("the WAIT reason", () => {
  const check = (over: Partial<EntryCheck>): EntryCheck => ({
    proposed_signal: "SELL", proposed_entry: 150, proposed_stop: 150.3, proposed_tp1: 149.5,
    entry_type: "market", distance_atr: 0, risk_reward: 1.6, rejection: "poor_rr", atr: 0.4,
    ...over,
  });

  it("is a refusal only when the analyst asked for a trade", () => {
    expect(waitReasonOf("WAIT", check({}))).toEqual({ kind: "rejected", rejection: "poor_rr", proposed: "SELL" });
    expect(waitReasonOf("WAIT", check({ proposed_signal: "WAIT", rejection: "low_confidence" })))
      .toEqual({ kind: "declined", rejection: "low_confidence", proposed: "WAIT" });
  });

  it("is nothing without a rejection, on a trade, or without a proposed signal", () => {
    expect(waitReasonOf("WAIT", check({ rejection: null }))).toBeNull();
    expect(waitReasonOf("SELL", check({}))).toBeNull();
    expect(waitReasonOf("WAIT", null)).toBeNull();
    // No proposed_signal is no evidence of who decided
    expect(waitReasonOf("WAIT", { ...check({}), proposed_signal: undefined as unknown as "WAIT" })).toBeNull();
  });
});

describe("the server's refusal sentence", () => {
  const refusal = "AIの判断は SELL でしたが、このエントリーではリスクリワードが1.6しかなく、割に合わないため見送り（WAIT）に変更しました";
  const fallback = "ニュース検索が利用できなかったため、テクニカルのみで判断しています";
  const model = "指標発表が近い";

  it("is dropped from the head of the list when the hero shows the reason", () => {
    expect(visibleWarnings([refusal, model], { reasonShown: true, mode: "full" })).toEqual([model]);
    expect(visibleWarnings([refusal, model], { reasonShown: true, mode: "technical_only" })).toEqual([model]);
  });

  it("sits behind the news-fallback sentence in that mode", () => {
    expect(visibleWarnings([fallback, refusal, model], { reasonShown: true, mode: "technical_fallback" }))
      .toEqual([fallback, model]);
  });

  it("is kept when the hero is not showing a reason", () => {
    expect(visibleWarnings([refusal, model], { reasonShown: false, mode: "full" })).toEqual([refusal, model]);
  });

  it("is not guessed: a sentence of the wrong shape at that position stays", () => {
    // entry_check says a reason exists, but the head of the list is a model
    // warning — nothing is dropped rather than the wrong thing
    expect(visibleWarnings([model, "別の注意"], { reasonShown: true, mode: "full" })).toEqual([model, "別の注意"]);
    expect(visibleWarnings([], { reasonShown: true, mode: "full" })).toEqual([]);
  });

  it("drops the English sentence for a WAIT the model chose itself, which never names WAIT", () => {
    const ownWait = "The model stood aside of its own accord here, and rated that reading 45, below the 60 we require to publish. Nothing was overruled server-side; this one was the model's own call.";
    expect(visibleWarnings([ownWait, "Thin liquidity"], { reasonShown: true, mode: "full" })).toEqual(["Thin liquidity"]);
  });

  it("matches the shape of every sentence the server can prepend, in both languages", () => {
    // Every refusal / market-closed / own-WAIT sentence in analyze/locale.ts
    // carries one of the markers; if one is added there without, the client
    // keeps it and says the reason twice. The own-WAIT sentences sit on the
    // line AFTER `signal === "WAIT"`, so the match has to reach past the
    // ternary — an earlier version stopped at the code and passed on it.
    const strings = locale.slice(locale.indexOf("const STRINGS"));
    const bodies: string[] = [];
    for (const m of strings.matchAll(/marketClosed: "([^"]*)"/g)) bodies.push(m[1]);
    for (const m of strings.matchAll(/return `(\$\{head\}[^`]*)`/g)) bodies.push(m[1]);
    for (const m of strings.matchAll(/signal === "WAIT"\s*\?\s*`([^`]*)`\s*:\s*`([^`]*)`/g)) bodies.push(m[1], m[2]);
    expect(bodies.length).toBeGreaterThan(12);
    for (const body of bodies) {
      expect(
        SERVER_REASON_MARKERS.some((mk) => body.includes(mk)) || body.includes("${tail}"),
        body,
      ).toBe(true);
    }
    expect(strings).toMatch(/const tail = "ため見送り（WAIT）に変更しました"/);
    expect(strings).toMatch(/const tail = ", so this was downgraded to WAIT\."/);
  });
});
