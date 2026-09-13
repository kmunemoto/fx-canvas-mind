import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  CLOCK_LINE,
  REUSE_VERSION,
  canonicalInput,
  decideReuse,
  inputsKey,
  readCandidate,
  reuseFloorMs,
  REUSE_OUTCOMES,
  type CandidateRow,
  type CanonicalInput,
} from "../../supabase/functions/analyze/reuse";
import { SUPPORTED_LOCALES, stringsFor } from "../../supabase/functions/analyze/locale";

// Serving a stored answer when the question was identical (#90).
//
// The point of the feature is the measured fact behind it: replayed on
// identical stored prompts, 10 of 48 runs flipped SELL↔WAIT. So a second ask
// on the same input is a second draw from the same noise, not new evidence.
//
// The point of THESE tests is the other half: a reuse that fires when the
// input was not identical would serve a plan built on a market that has
// moved, which is worse than the noise it avoids.

const base = (over: Partial<CanonicalInput> = {}): CanonicalInput => ({
  system: "system prompt",
  user: "通貨ペア: USD/JPY\n現在時刻(UTC): 2026-09-12T10:00:00.000Z\n分析モード: full\n\n### 1h\n現在値: 150.123",
  model: "m",
  effort: "medium",
  maxTokens: 8000,
  preview: false,
  searched: false,
  contract: "market_v1",
  locale: "ja",
  ...over,
});

describe("the key is the prompt, minus the clock", () => {
  it("ignores the wall clock and nothing else", async () => {
    const a = base();
    const b = base({ user: a.user.replace("2026-09-12T10:00:00.000Z", "2026-09-12T23:59:59.000Z") });
    expect(await inputsKey(a)).toBe(await inputsKey(b));
    // ...while one digit of the price — which under market_v1 becomes the
    // entry — is a different question.
    const moved = base({ user: a.user.replace("150.123", "150.124") });
    expect(await inputsKey(moved)).not.toBe(await inputsKey(a));
  });

  it("separates every part of the shape it was sent at", async () => {
    const a = base();
    const variants: Array<Partial<CanonicalInput>> = [
      { system: "system prompt " },
      { model: "other" },
      { effort: "low" },
      { effort: null },
      { maxTokens: 16000 },
      { maxTokens: null },
      { preview: true },
      { searched: true },
      { contract: "entry_chosen_v1" },
      { locale: "en" },
    ];
    const keys = await Promise.all(variants.map((v) => inputsKey(base(v))));
    const home = await inputsKey(a);
    for (let i = 0; i < variants.length; i++) {
      expect(keys[i], JSON.stringify(variants[i])).not.toBe(home);
    }
    // and they are all different from each other
    expect(new Set([...keys, home]).size).toBe(variants.length + 1);
  });

  it("replaces the clock line rather than deleting it, so a crafted prompt cannot collide", async () => {
    const withoutLine = base({ user: "通貨ペア: USD/JPY\n分析モード: full" });
    const withLine = base({ user: "通貨ペア: USD/JPY\n現在時刻(UTC): 2026-09-12T10:00:00.000Z\n分析モード: full" });
    expect(await inputsKey(withoutLine)).not.toBe(await inputsKey(withLine));
    expect(canonicalInput(withLine)).toContain("(clock line removed for the reuse key)");
    // the replacement text is locale-neutral, so the English clock line lands
    // on exactly the same bytes as the Japanese one
    const enLine = base({ user: "pair: USD/JPY\nCurrent time (UTC): 2026-09-12T10:00:00.000Z\nmode: full" });
    expect(canonicalInput(enLine)).toContain("(clock line removed for the reuse key)");
  });

  it("matches only a whole clock line", () => {
    expect("現在時刻(UTC): 2026-09-12T10:00:00.000Z").toMatch(CLOCK_LINE);
    // not a mention of the same words inside prose
    expect("なお現在時刻(UTC): に注意").not.toMatch(CLOCK_LINE);
    expect(canonicalInput(base())).toContain(`v${REUSE_VERSION}`);
  });

  it("finds the clock in the REAL message every locale builds, exactly once", async () => {
    // The first version of the pattern knew only the Japanese sentence. The
    // English message says "Current time (UTC):", so the clock stayed inside
    // the key and the feature could never fire for an English reader — with
    // nothing anywhere to say so. Built from the locale module rather than
    // retyped, so a locale added later is covered by this test on the day it
    // is added.
    for (const locale of SUPPORTED_LOCALES) {
      const message = (nowUtc: string) =>
        stringsFor(locale).userMessage({
          pair: "USD/JPY",
          nowUtc,
          note: "分析モード: full",
          sections: "### 1h\n現在値: 150.123",
          schema: "",
        });
      const early = message("2026-09-12T10:00:00.000Z");
      const late = message("2026-09-12T23:59:59.000Z");
      expect(early, locale).toMatch(CLOCK_LINE);
      // exactly one line, so nothing else is silently swallowed
      expect(early.split("\n").filter((line) => CLOCK_LINE.test(line)), locale).toHaveLength(1);
      // and the two runs an hour apart share a key in every locale
      expect(await inputsKey(base({ user: early, locale })), locale)
        .toBe(await inputsKey(base({ user: late, locale })));
    }
  });

  it("is a sha256 hex digest", async () => {
    expect(await inputsKey(base())).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("how far back a match may be taken from", () => {
  const now = Date.parse("2026-09-12T10:00:00Z");
  const sessionStart = Date.parse("2026-09-11T21:00:00Z");

  it("is one bar of the entry timeframe while the market trades", () => {
    for (const [interval, ms] of [["15min", 15], ["1h", 60], ["4h", 240], ["1day", 1440]] as const) {
      expect(reuseFloorMs({ interval, preview: false, nowMs: now, sessionStartMs: sessionStart }))
        .toBe(now - ms * 60_000);
    }
    // an unknown timeframe falls back to the hour rather than to forever
    expect(reuseFloorMs({ interval: "2h", preview: false, nowMs: now, sessionStartMs: sessionStart }))
      .toBe(now - 60 * 60_000);
  });

  it("is the whole closed session while the market is shut", () => {
    // Nothing can trade, so nothing the clock would have told the analyst can
    // have been overtaken by an event.
    expect(reuseFloorMs({ interval: "1h", preview: true, nowMs: now, sessionStartMs: sessionStart }))
      .toBe(sessionStart);
  });
});

describe("decideReuse names every refusal", () => {
  const candidate = (over: Partial<CandidateRow> = {}): CandidateRow => ({
    id: "a-1",
    created_at: "2026-09-12T09:30:00Z",
    preview: false,
    shadow: false,
    has_result: true,
    mode: "technical_only",
    read_positions_at: "2026-09-12T09:29:10Z",
    ...over,
  });
  const floor = Date.parse("2026-09-12T09:00:00Z");
  const ok = { candidate: candidate(), floorMs: floor, preview: false, forceFresh: false, positionsChangedSince: false };

  it("serves a clean match", () => {
    expect(decideReuse(ok)).toEqual({ reuse: true, analysis_id: "a-1", analyzed_at: "2026-09-12T09:30:00Z" });
  });

  it("refuses, with a reason, on every other path", () => {
    expect(decideReuse({ ...ok, forceFresh: true })).toEqual({ reuse: false, refusal: "forced_fresh" });
    expect(decideReuse({ ...ok, candidate: null })).toEqual({ reuse: false, refusal: "no_match" });
    expect(decideReuse({ ...ok, candidate: candidate({ shadow: true }) })).toEqual({ reuse: false, refusal: "not_servable" });
    expect(decideReuse({ ...ok, candidate: candidate({ has_result: false }) })).toEqual({ reuse: false, refusal: "not_servable" });
    expect(decideReuse({ ...ok, candidate: candidate({ preview: true }) })).toEqual({ reuse: false, refusal: "not_servable" });
    // A turn that could have read the web is not keyed by the prompt, because
    // what it read is not in the prompt.
    expect(decideReuse({ ...ok, candidate: candidate({ mode: "full" }) })).toEqual({ reuse: false, refusal: "search_used" });
    expect(decideReuse({ ...ok, candidate: candidate({ mode: "technical_fallback" }) })).toEqual({ reuse: false, refusal: "search_used" });
    // and an unknown mode is not a known-safe one
    expect(decideReuse({ ...ok, candidate: candidate({ mode: null }) })).toEqual({ reuse: false, refusal: "search_used" });
    expect(decideReuse({ ...ok, candidate: candidate({ created_at: "2026-09-12T08:59:00Z" }) }))
      .toEqual({ reuse: false, refusal: "outside_window" });
    // A timestamp that could not be READ is not a row found to be old: calling
    // it outside_window sends an operator to widen the window over a fault.
    expect(decideReuse({ ...ok, candidate: candidate({ created_at: "nonsense" }) }))
      .toEqual({ reuse: false, refusal: "lookup_failed" });
    expect(decideReuse({ ...ok, positionsChangedSince: true })).toEqual({ reuse: false, refusal: "positions_changed" });
    // A check that could not be made is not a check that passed: the stored
    // answer carries a held-position card, and serving it over a holding it
    // does not describe is the failure this guard exists for. It refuses —
    // but under its OWN name, because writing "positions_changed" into the
    // log would state a fact about the reader's holdings that nobody
    // observed.
    expect(decideReuse({ ...ok, positionsChangedSince: null })).toEqual({ reuse: false, refusal: "lookup_failed" });
  });

  it("refuses a fresh run before anything else, so the button always works", () => {
    expect(decideReuse({ ...ok, forceFresh: true, candidate: null })).toEqual({ reuse: false, refusal: "forced_fresh" });
  });
});

describe("readCandidate", () => {
  it("reads a row and calls a missing result what it is", () => {
    expect(readCandidate({ id: "a", created_at: "2026-09-12T09:30:00Z", result: { signal: "WAIT" } }))
      .toEqual({
        id: "a",
        created_at: "2026-09-12T09:30:00Z",
        preview: false,
        shadow: false,
        has_result: true,
        mode: null,
        read_positions_at: "2026-09-12T09:30:00Z",
      });
    expect(readCandidate({ id: "a", created_at: "t", result: null })?.has_result).toBe(false);
    expect(readCandidate({ id: "a", created_at: "t", preview: true, shadow: true, result: {} }))
      .toMatchObject({ preview: true, shadow: true });
  });

  it("takes the EARLIEST instant the row could have read positions", () => {
    // The review starts before the model call; the row lands after it. A
    // cutoff at the write time misses a close that happened in between.
    const row = {
      id: "a",
      created_at: "2026-09-12T09:30:50Z",
      result: {},
      position_review: { at: "2026-09-12T09:30:05Z" },
      entry_check: { priced_at: "2026-09-12T09:30:20Z" },
    };
    expect(readCandidate(row)?.read_positions_at).toBe("2026-09-12T09:30:05Z");
    // each source is optional, and an unparseable one is ignored rather than
    // trusted
    expect(readCandidate({ ...row, position_review: { at: "nonsense" } })?.read_positions_at)
      .toBe("2026-09-12T09:30:20Z");
    expect(readCandidate({ id: "a", created_at: "2026-09-12T09:30:50Z", result: {} })?.read_positions_at)
      .toBe("2026-09-12T09:30:50Z");
  });

  it("returns null rather than a half-read row", () => {
    expect(readCandidate({ id: "a" })).toBeNull();
    expect(readCandidate(null)).toBeNull();
    expect(readCandidate("nope")).toBeNull();
  });
});

describe("the reuse is wired into analyze without costing a run", () => {
  const src = readFileSync("supabase/functions/analyze/index.ts", "utf8");

  it("checks before the model call and before the review is started", () => {
    const check = src.indexOf('stage = "check_reuse"');
    expect(check).toBeGreaterThan(src.indexOf("applyRequestShape();"));
    expect(check).toBeLessThan(src.indexOf("const runPositionReview = async (acc: ReviewRun)"));
    expect(check).toBeLessThan(src.indexOf("for (let attempt = 0; attempt < 5; attempt++)"));
  });

  it("hands the credit back, because no model call was made", () => {
    const served = src.slice(src.indexOf("if (decision.reuse && isRecord(candidateRaw))"), src.indexOf("// The row said it had a result"));
    expect(served).toContain("await releaseQuota();");
    expect(served).toContain("remaining: remainingToday()");
    // and it never writes a second row for a plan that already exists
    expect(served).not.toContain("/rest/v1/analyses`");
  });

  it("records the attempt whether or not it fired", () => {
    expect(src).toContain('await logReuse("served", decision.analysis_id, decision.analyzed_at);');
    expect(src).toContain("if (servedReuse === null) reuseLogs.push(logReuse(reuseRefusal, null, null));");
    expect(src).toContain("/rest/v1/analysis_reuses");
  });

  it("never makes the model turn wait on a log line", () => {
    // The refusal is the common case by this feature's own measurement (90 of
    // 91), and a full-mode turn has been measured finishing at 135002 ms
    // against a 135000 ms budget. An awaited INSERT here is web search
    // dropped, which the screen reports as a degraded mode.
    expect(src).toContain("const reuseLogs: Promise<void>[] = [];");
    expect(src).toContain("if (reuseLogs.length > 0) await Promise.all(reuseLogs);");
    // and the drain happens after the row is written, not before the model
    expect(src.indexOf("if (reuseLogs.length > 0) await Promise.all(reuseLogs);"))
      .toBeGreaterThan(src.indexOf('stage = "save_history"'));
  });

  it("bounds every hop it makes, so a stalled database cannot eat the budget", () => {
    const block = src.slice(src.indexOf('stage = "check_reuse"'), src.indexOf("// ---- the held-position review"));
    expect(block).toContain("AbortSignal.timeout(Math.max(1_000, Math.min(5_000, msLeft())))");
    // both SELECTs carry it
    expect(block.match(/signal: reuseSignal\(\)/g)?.length).toBe(2);
  });

  it("does not spend round trips to reach a decision it already has", () => {
    // forceFresh is the one path where the reader is waiting on a model turn
    // they explicitly asked for.
    const block = src.slice(src.indexOf('stage = "check_reuse"'), src.indexOf("// ---- the held-position review"));
    const forced = block.indexOf("if (forceFresh) {");
    expect(forced).toBeGreaterThan(-1);
    expect(forced).toBeLessThan(block.indexOf("/rest/v1/analyses?user_id="));
  });

  it("puts the stage back, so a model failure is not blamed on the reuse check", () => {
    // `stage` is the one field that says where a run died. Leaving it on
    // check_reuse would name this feature on every wall-clock timeout.
    const check = src.indexOf('stage = "check_reuse"');
    const back = src.indexOf('stage = "request_ai";', check);
    expect(back).toBeGreaterThan(check);
    expect(back).toBeLessThan(src.indexOf("for (let attempt = 0; attempt < 5; attempt++)"));
  });

  it("keys and serves the row's own mode, and never a searching one", () => {
    const block = src.slice(src.indexOf('stage = "check_reuse"'), src.indexOf("// ---- the held-position review"));
    // the tool block is part of the request, not the prompt, so it is keyed
    expect(block).toContain("searched: Array.isArray(baseRequest.tools) && baseRequest.tools.length > 0,");
    // the row's own mode is selected and served
    expect(block).toContain("&select=id,created_at,preview,shadow,mode,");
    expect(block).toContain('mode: typeof candidateRaw.mode === "string" ? candidateRaw.mode : "technical_only",');
    // and the cutoff for "did the holdings move" is the read, not the write
    expect(block).toContain("encodeURIComponent(candidate.read_positions_at)");
    // the stored key records the shape as SENT
    expect(src).toContain("// As sent: giveUpSearch() deletes the tool block mid-flight, and the");
  });

  it("does not call a lookup that failed a lookup that came back empty", () => {
    const block = src.slice(src.indexOf('stage = "check_reuse"'), src.indexOf("// ---- the held-position review"));
    expect(block).toContain("if (!candidateRes.ok) throw new Error(`reuse select ${candidateRes.status}`);");
    expect(block).toContain('reuseRefusal = "lookup_failed";');
    expect(block).not.toContain('reuseRefusal = "no_match";');
  });

  it("stores the key of the turn as SENT, not the one it meant to send", () => {
    // giveUpSearch rewrites the user message wholesale, so a fallback run must
    // not be findable by the searching key.
    const sent = src.slice(src.indexOf("const sentInputsKey = await inputsKey({"), src.indexOf("const promptRecord = {"));
    expect(sent).toContain("user: sentUserText,");
    expect(src).toContain("inputs_key: sentInputsKey,");
  });

  it("lets the reader ask for a fresh answer anyway", () => {
    // The banner itself is rendered and pinned in reuse-banner.test.tsx; this
    // is only the wiring that reaches it.
    expect(src).toContain("const forceFresh = body.forceFresh === true;");
    expect(src).toContain("forceFresh,");
    const page = readFileSync("src/pages/Index.tsx", "utf8");
    expect(page).toContain("forceFresh: opts?.forceFresh === true,");
    // the page renders the banner and hands it the button's action
    expect(page).toContain("onForceFresh={() => void handleAnalyze({ forceFresh: true })}");
    // ...and only when the run actually was a reuse
    expect(page).toContain("{reused && (");
  });

  it("never lets the reuse path fail the analysis", () => {
    // Every hop inside it is wrapped, and a key that could not be computed
    // falls through to a normal run rather than throwing.
    expect(src).toContain('}).catch(() => "");');
    expect(src).toContain('console.warn("Reuse lookup failed:"');
  });

  it("leaves a row even when it never got to look", () => {
    // Without this the log has a hole exactly where the feature is broken: a
    // digest that throws, or a missing service role key, would write nothing
    // at all and read back as "we simply never matched".
    const block = src.slice(src.indexOf('stage = "check_reuse"'), src.indexOf("// ---- the held-position review"));
    expect(block).toContain('reuseLogs.push(logReuse("key_unavailable", null, null));');
    // and when nothing can be written by construction, say so in the log
    expect(block).toContain('console.warn("Reuse skipped: no service role key');
  });

  it("does not put the prompt digest on the wire", () => {
    // inputs_key covers the analyst system prompt, which this repo keeps
    // server-side (20260905161000_replay_inputs_are_server_side.sql). No
    // screen reads it, so sending it buys nothing.
    const served = src.slice(src.indexOf("servedReuse = {"), src.indexOf("await releaseQuota();"));
    expect(served).not.toContain("inputs_key");
    const types = readFileSync("src/lib/types.ts", "utf8");
    const mirror = types.slice(
      types.indexOf("export interface AnalysisReuse"),
      types.indexOf("export interface HistoryEntry"),
    );
    // the FIELD, not the word — the comment there says why it is absent
    expect(mirror).not.toMatch(/^\s*inputs_key\s*:/m);
  });
});

describe("the migration", () => {
  const sql = readFileSync("supabase/migrations/20260913060000_serve_the_same_answer_to_the_same_question.sql", "utf8");
  const fix = readFileSync("supabase/migrations/20260913114000_the_index_was_dead_and_the_domain_was_wrong.sql", "utf8");
  const src = readFileSync("supabase/functions/analyze/index.ts", "utf8");

  it("indexes the lookup and keeps the log server-only", () => {
    expect(sql).toContain("alter table public.analyses add column if not exists inputs_key text;");
    expect(sql).toContain("alter table public.analysis_reuses enable row level security;");
    expect(sql).toContain("revoke all on public.analysis_reuses from public, anon, authenticated;");
    expect(sql).toMatch(/create table if not exists public\.analysis_reuses/);
  });

  it("spells the index predicate the way the query spells it", () => {
    // MEASURED on production: a `shadow = false` predicate is NOT usable by a
    // `shadow IS FALSE` query — the planner cannot prove a BooleanTest implies
    // a boolean-equality predicate — and the reverse does not hold either.
    // The first migration shipped the wrong spelling, so the index was never
    // chosen and every run walked the reader's whole history instead. The two
    // spellings have to be pinned TOGETHER or the next edit silently
    // re-breaks it.
    expect(fix).toContain("drop index if exists public.analyses_reuse_lookup_idx;");
    const live = fix.slice(fix.indexOf("create index analyses_reuse_lookup_idx"));
    expect(live).toContain("on public.analyses (user_id, inputs_key, created_at desc)");
    expect(live).toContain("where inputs_key is not null and shadow is false;");
    // ...and this is the spelling PostgREST emits for the query that uses it
    expect(src).toContain("&inputs_key=eq.${encodeURIComponent(reuseKey)}&shadow=is.false");
  });

  it("constrains outcome to exactly what the code can write", () => {
    // Derived from the code, not retyped: a refusal the code emits but the
    // constraint rejects is a failed write, and one the constraint allows but
    // the code never emits is a value no measurement will count. The old
    // version of this test looped over a hand-typed list and matched anywhere
    // in the file, so a `--` comment satisfied it and `served` was satisfied
    // by the column name `served_at`.
    const check = fix.slice(fix.indexOf("check (outcome in ("), fix.indexOf("));", fix.indexOf("check (outcome in (")));
    for (const outcome of REUSE_OUTCOMES) {
      expect(check, outcome).toContain(`'${outcome}'`);
    }
    // and nothing beyond them
    const listed = [...check.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect([...listed].sort()).toEqual([...REUSE_OUTCOMES].sort());
  });

  it("names every refusal in the column comment, so a reader of the table can count them", () => {
    const comment = fix.slice(fix.indexOf("comment on column public.analysis_reuses.outcome"));
    for (const outcome of REUSE_OUTCOMES) {
      expect(comment, outcome).toContain(outcome);
    }
  });
});
