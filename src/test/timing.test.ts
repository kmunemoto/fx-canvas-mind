import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  COSTLY_EVIDENCE,
  COSTLY_HOURS_UTC,
  ROLLOVER_SPREAD_PIPS,
  costlyHourAt,
} from "../../supabase/functions/analyze/timing";
import { stringsFor } from "../../supabase/functions/analyze/locale";
import { SERVER_REASON_MARKERS } from "../lib/warnings";

const at = (hh: number, mm = 0) => Date.parse(`2026-09-23T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00Z`);
const analyzeSrc = readFileSync("supabase/functions/analyze/index.ts", "utf8");

describe("the hours a short-term plan loses to the spread (#100)", () => {
  it("refuses 15-minute and 1-hour plans from 17:00 to 23:59 UTC, and nothing else", () => {
    for (const tf of ["15min", "1h"]) {
      expect(costlyHourAt(tf, at(16, 59))).toBe(false);
      expect(costlyHourAt(tf, at(17, 0))).toBe(true);
      expect(costlyHourAt(tf, at(21, 30))).toBe(true);
      expect(costlyHourAt(tf, at(23, 59))).toBe(true);
      expect(costlyHourAt(tf, at(0, 0))).toBe(false);
      expect(costlyHourAt(tf, at(9, 0))).toBe(false);
    }
  });

  it("refuses 1-minute plans only from 20:00, and never 4-hour or daily ones", () => {
    expect(costlyHourAt("1min", at(19, 59))).toBe(false);
    expect(costlyHourAt("1min", at(20, 0))).toBe(true);
    expect(costlyHourAt("1min", at(23, 30))).toBe(true);
    for (let h = 0; h < 24; h++) {
      expect(costlyHourAt("4h", at(h))).toBe(false);
      expect(costlyHourAt("1day", at(h))).toBe(false);
    }
    expect(costlyHourAt("15min", Number.NaN)).toBe(false);
  });

  it("covers the roll in both halves of the year (21:00 UTC in summer, 22:00 in winter)", () => {
    for (const hours of Object.values(COSTLY_HOURS_UTC)) {
      expect(hours).toContain(21);
      expect(hours).toContain(22);
    }
  });

  it("carries the measurement, and says where there is none", () => {
    for (const tf of ["15min", "1h"]) {
      const e = COSTLY_EVIDENCE[tf];
      expect(e.measured).toBe(true);
      // the rule only makes sense if the hours were worse, on both sides
      expect(e.inside!.buy).toBeLessThan(e.outside!.buy);
      expect(e.inside!.sell).toBeLessThan(e.outside!.sell);
      expect(e.period).toContain("2025-07");
    }
    expect(COSTLY_EVIDENCE["1min"].measured).toBe(false);
    expect(COSTLY_EVIDENCE["1min"].inside).toBeNull();
    expect(ROLLOVER_SPREAD_PIPS).toBe(12.5);
  });
});

describe("the gate, as analyze applies it", () => {
  // #104: the confidence floor is no longer a refusal (the rule decides the
  // signal), so the chain is the shut market, then the hour, then the shape.
  it("checks the hour after the shut market, before the plan's shape", () => {
    const chain = analyzeSrc.slice(analyzeSrc.indexOf("rejectionReason = marketShut"), analyzeSrc.indexOf("console.warn(\"Entry rejected\""));
    expect(chain).not.toContain("\"low_confidence\"");
    const order = ["\"market_closed\"", "\"costly_hours\"", "entryVerdict.rejection"].map((s) => chain.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("reads the hour off the moment the plan was priced, and only on a proposed BUY or SELL", () => {
    const decl = analyzeSrc.slice(analyzeSrc.indexOf("const costlyHours ="), analyzeSrc.indexOf("const costlyHours =") + 200);
    expect(decl).toContain('proposedSignal === "BUY" || proposedSignal === "SELL"');
    expect(decl).toContain("costlyHourAt(interval, Date.parse(pricedAtIso))");
  });

  it("shadows a plan refused only for its hour, so the rule is measured in production", () => {
    expect(analyzeSrc).toContain('const refusedForTheHour = rejectionReason === "costly_hours" && entryVerdict.ok;');
    const shadow = analyzeSrc.slice(analyzeSrc.indexOf("const shadowable ="), analyzeSrc.indexOf("if (shadowable)"));
    expect(shadow).toContain("refusedForTheHour");
    expect(analyzeSrc).toContain('costly_hours: rejectionReason === "costly_hours"');
  });
});

describe("the sentence the reader is given", () => {
  it("names the hour, the spread and the measured rates, in both languages", () => {
    const ja = stringsFor("ja").costlyHours({ signal: "SELL", interval: "1h", hourUtc: 21, evidence: COSTLY_EVIDENCE["1h"] });
    expect(ja).toContain("日本時間 6時台（UTC 21時台）");
    expect(ja).toContain("12.5pips");
    expect(ja).toContain("BUY 28%・SELL 24%");
    expect(ja).toContain("40%");
    const en = stringsFor("en").costlyHours({ signal: "SELL", interval: "1h", hourUtc: 21, evidence: COSTLY_EVIDENCE["1h"] });
    expect(en).toContain("21:00-21:59 UTC");
    expect(en).toContain("12.5 pips");
    // the client recognises the server's refusal sentences by these markers
    for (const s of [ja, en]) expect(SERVER_REASON_MARKERS.some((m) => s.includes(m))).toBe(true);
  });

  it("says a 1-minute refusal was not measured rather than quoting another timeframe's numbers", () => {
    const ja = stringsFor("ja").costlyHours({ signal: "BUY", interval: "1min", hourUtc: 20, evidence: COSTLY_EVIDENCE["1min"] });
    expect(ja).toContain("測っていません");
    expect(ja).not.toMatch(/勝率は BUY/);
    const en = stringsFor("en").costlyHours({ signal: "BUY", interval: "1min", hourUtc: 20, evidence: COSTLY_EVIDENCE["1min"] });
    expect(en).toContain("not measured");
  });
});
