import type { GainzEvidence, GainzSummary, RsiSarEvidence, RsiSarSummary, RsiSarTrigger } from "./types";

// #104: the RSI/SAR summary as the client accepts it. Everything arrives as
// JSON from the analyze function (technicalData.rsiSar, entry_check.rsi_sar);
// anything malformed is dropped rather than rendered as a price.

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
const rec = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const sideOf = (v: unknown): "BUY" | "SELL" | null => (v === "BUY" || v === "SELL" ? v : null);

const trigger = (v: unknown, side: "BUY" | "SELL"): RsiSarTrigger | null => {
  const t = rec(v);
  if (!t || t.side !== side || typeof t.ready !== "boolean") return null;
  const plan = rec(t.plan);
  return {
    side,
    ready: t.ready,
    rsi_close: num(t.rsi_close),
    sar_on_side: bool(t.sar_on_side),
    sar_level: num(t.sar_level),
    complete_close: num(t.complete_close),
    plan: plan ? { entry: num(plan.entry), stop: num(plan.stop), target: num(plan.target) } : null,
  };
};

const evidence = (v: unknown): RsiSarEvidence => {
  const e = rec(v);
  return {
    measured: e?.measured === true,
    win: num(e?.win),
    winN: num(e?.winN),
    hit: num(e?.hit),
    hitN: num(e?.hitN),
  };
};

const tally = (v: unknown) => {
  const t = rec(v);
  const n = (k: string) => num(t?.[k]) ?? 0;
  return { n: n("n"), wins: n("wins"), losses: n("losses"), ambiguous: n("ambiguous"), expired: n("expired"), open: n("open") };
};

export const normalizeRsiSar = (value: unknown): RsiSarSummary | null => {
  const s = rec(value);
  if (!s || typeof s.tf !== "string" || typeof s.ok !== "boolean") return null;
  const now = rec(s.now);
  const next = rec(s.next);
  const buy = next ? trigger(next.buy, "BUY") : null;
  const sell = next ? trigger(next.sell, "SELL") : null;
  const close = next ? rec(next.close) : null;
  const sar = next ? rec(next.sar) : null;
  const ev = rec(s.evidence);
  const be = rec(ev?.breakeven);
  const blind = rec(ev?.blind);
  const t = rec(s.tally);
  return {
    tf: s.tf,
    rule: typeof s.rule === "string" ? s.rule : "",
    ok: s.ok,
    reason: typeof s.reason === "string" ? s.reason : null,
    bars: num(s.bars) ?? 0,
    stop_atr: num(s.stop_atr) ?? 0.8,
    reward_ratio: num(s.reward_ratio) ?? 1.5,
    horizon: num(s.horizon) ?? 48,
    now: now && typeof now.datetime === "string"
      ? {
        datetime: now.datetime,
        close: num(now.close),
        rsi: num(now.rsi),
        rsi_prev: num(now.rsi_prev),
        sar: num(now.sar),
        sar_below: bool(now.sar_below),
        atr: num(now.atr),
        signal: sideOf(now.signal),
      }
      : null,
    next: buy && sell
      ? {
        close: close && typeof close.at === "string" && typeof close.costly === "boolean" ? { at: close.at, costly: close.costly } : null,
        sar: sar && typeof sar.below === "boolean" ? { level: num(sar.level), below: sar.below } : null,
        buy,
        sell,
      }
      : null,
    tally: { BUY: tally(t?.BUY), SELL: tally(t?.SELL) },
    evidence: {
      period: typeof ev?.period === "string" ? ev.period : "",
      pairs: num(ev?.pairs) ?? 0,
      breakeven: { win: num(be?.win) ?? 0.4, hit: num(be?.hit) ?? 0.5 },
      blind: { win: num(blind?.win) ?? 0, hit: num(blind?.hit) ?? 0 },
      tf: evidence(ev?.tf),
      all: evidence(ev?.all),
    },
  };
};

// #112: the GA-style rule's summary (analyze/gainz.ts compactGainz)
const gaEvidence = (v: unknown): GainzEvidence => {
  const e = rec(v);
  return { measured: e?.measured === true, win: num(e?.win), n: num(e?.n), meanR: num(e?.meanR) };
};

export const normalizeGainz = (value: unknown): GainzSummary | null => {
  const s = rec(value);
  if (!s || typeof s.tf !== "string" || typeof s.ok !== "boolean") return null;
  const now = rec(s.now);
  const plan = now ? rec(now.plan) : null;
  const ev = rec(s.evidence);
  const t = rec(s.tally);
  return {
    tf: s.tf,
    rule: typeof s.rule === "string" ? s.rule : "",
    ok: s.ok,
    reason: typeof s.reason === "string" ? s.reason : null,
    bars: num(s.bars) ?? 0,
    stop_atr: num(s.stop_atr) ?? 1,
    reward_ratio: num(s.reward_ratio) ?? 2,
    horizon: num(s.horizon) ?? 48,
    now: now && typeof now.datetime === "string"
      ? {
        datetime: now.datetime,
        close: num(now.close),
        rsi: num(now.rsi),
        atr: num(now.atr),
        signal: sideOf(now.signal),
        plan: plan ? { entry: num(plan.entry), stop: num(plan.stop), target: num(plan.target) } : null,
      }
      : null,
    tally: { BUY: tally(t?.BUY), SELL: tally(t?.SELL) },
    evidence: {
      period: typeof ev?.period === "string" ? ev.period : "",
      pairs: num(ev?.pairs) ?? 0,
      breakeven: num(ev?.breakeven) ?? 1 / 3,
      tf: gaEvidence(ev?.tf),
      all: gaEvidence(ev?.all),
    },
  };
};

// One value per candle, or nothing: a series that does not line up with the
// candles would put a SAR dot under the wrong bar.
export const alignedNumbers = (value: unknown, length: number): Array<number | null> | undefined =>
  Array.isArray(value) && value.length === length ? value.map(num) : undefined;

export const alignedBools = (value: unknown, length: number): Array<boolean | null> | undefined =>
  Array.isArray(value) && value.length === length ? value.map(bool) : undefined;
