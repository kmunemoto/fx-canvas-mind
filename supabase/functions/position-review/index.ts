// THE HELD-POSITION REVIEW, AS ITS OWN FUNCTION.
//
// WHY IT MOVED. Nothing about the judgement changed; the deploy path did.
// analyze's bundle reached 116.2KB and the only route this project has for
// putting an edge function live carries the file inline in one tool call —
// which stopped working, measured three times (docs/OPERATIONS.md §6.1.1).
// The review is 22.8KB of that bundle, almost all of it prompt text, and it
// already ran as a separate model call on a separate schema. Splitting it out
// puts analyze back to ~97KB and gives this half its own budget.
//
// WHAT DID NOT CHANGE, and must not:
//   - Two independent references (docs/OPERATIONS.md §2.3): the OPEN POSITION
//     on this pair at any timeframe, and the PREVIOUS run on this pair and
//     timeframe. Each absence is named; a lookup that could not be made is
//     never recorded as a lookup that came back empty.
//   - The mechanical facts are computed BEFORE the model call, so a review
//     that times out still carries them.
//   - The verdict is NOT derived here. This returns the raw ReviewRun; the
//     server's own overrides and the coherence check live in finalizeReview,
//     which analyze runs once it knows this run's own signal.
//
// WHY THE CALLER'S DISCONNECT MATTERS. analyze waits for this only for a
// bounded grace and then gives up. Before the split, giving up aborted the
// in-flight Anthropic call. Over HTTP that guarantee has to be rebuilt: the
// request's own signal fires when analyze drops the connection, and it is
// bound into every fetch below alongside the caller's remaining budget.
// Without it, an abandoned review would keep walking to its deadline and POST
// a billed request whose answer nobody reads.
//
// AUTH. Service role only. analyze holds that key already; nothing else may
// call this, because the body names the user whose positions get read.

import {
  PREVIOUS_WINDOW_HOURS,
  buildReviewRequest,
  emptyReviewRun,
  mechanicalFacts,
  parseReviewAnswer,
  readHeldReference,
  readPreviousReference,
  recordRequest,
  type ReferenceSet,
  type ReviewRun,
} from "../analyze/review.ts";
import { resolveAnalysisLocale } from "../analyze/locale.ts";
import type { Candle } from "../analyze/indicators.ts";
import { extractAnthropicText, parseAnalysisJson } from "../_shared/model-output.ts";

const FUNCTION_VERSION = "position-review-v1-2026-09-13T06:00:00Z";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const redactSecrets = (message: string): string =>
  message
    .replace(/apikey=[^&\s)"']+/gi, "apikey=***")
    .replace(/x-api-key["\s:]+[^\s,"']+/gi, "x-api-key ***");

const parseJsonResponse = (rawText: string): unknown => {
  if (!rawText) return null;
  try {
    return JSON.parse(rawText);
  } catch {
    return null;
  }
};

const json = (body: JsonRecord, status = 200) =>
  new Response(JSON.stringify({ version: FUNCTION_VERSION, ...body }), {
    status,
    headers: { ...CORS, "Content-Type": "application/json", "X-Function-Version": FUNCTION_VERSION },
  });

// The caller's numbers, read defensively. analyze is the only caller and it is
// authenticated, but a shape it did not mean to send should fail as a named
// review failure rather than as a 500 that costs the reader their analysis.
const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;
const str = (v: unknown): string => (typeof v === "string" ? v : "");

const readCandles = (raw: unknown): Candle[] => {
  if (!Array.isArray(raw)) return [];
  const out: Candle[] = [];
  for (const row of raw) {
    if (!isRecord(row)) continue;
    const open = num(row.open), high = num(row.high), low = num(row.low), close = num(row.close);
    if (open === null || high === null || low === null || close === null) continue;
    out.push({ datetime: str(row.datetime), open, high, low, close });
  }
  return out;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const startedMs = Date.now();
  const startedAt = new Date(startedMs).toISOString();
  // HOISTED ON PURPOSE. Everything this function measures before the model
  // call — the two references, the mechanical facts, the record of what was
  // sent — accumulates here, and the catch below has to be able to answer
  // with it. Scoped inside the try, a budget expiry would throw away facts it
  // had already measured and paid for, and the row would read as "we looked
  // and found nothing" (docs/OPERATIONS.md §6.1.2).
  const acc: ReviewRun = emptyReviewRun(startedAt);
  // Every exit below returns 200 with a ReviewRun. A non-200 would make
  // analyze invent its own failure text; a named status keeps the reason.
  const done = (run: ReviewRun) => json({ ok: true, run: { ...run, elapsed_ms: Date.now() - startedMs } });
  // Answers with whatever `acc` holds, which is the whole point of hoisting
  // it. `status` stays "failed" here on purpose: `partial` is finalizeReview's
  // word, derived on analyze's side from whether the facts survived — a run
  // that carries reference + mechanical becomes "partial" there, and one that
  // carries nothing stays "failed". Setting it here would be this function
  // asserting a conclusion that is not its to draw.
  const failed = (error: string) => done({ ...acc, status: "failed", error });

  try {
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!serviceRoleKey || !supabaseUrl || !anthropicKey) {
      console.error("position-review is not configured", {
        hasServiceRole: Boolean(serviceRoleKey),
        hasUrl: Boolean(supabaseUrl),
        hasAnthropic: Boolean(anthropicKey),
      });
      return failed("not_configured");
    }

    // The service role key is the credential. Anyone holding it already has
    // the database, so this gate is about making the blast radius of a
    // mis-addressed call nil, not about defending the key itself.
    const auth = req.headers.get("Authorization") ?? "";
    if (auth !== `Bearer ${serviceRoleKey}`) {
      return json({ ok: false, error: "service role required" }, 401);
    }

    const body = parseJsonResponse(await req.text());
    if (!isRecord(body)) return failed("bad_request");

    const userId = str(body.user_id);
    const pair = str(body.pair);
    const interval = str(body.interval);
    if (!userId || !pair || !interval) return failed("bad_request");

    const locale = resolveAnalysisLocale(body.locale);
    const decimals = num(body.decimals) ?? (pair.toUpperCase().includes("JPY") ? 3 : 5);
    const model = str(body.model);
    const nowUtc = str(body.now_utc) || startedAt;
    const sections = str(body.sections);
    const price = num(body.price);
    const pricedAt = str(body.priced_at);
    const feed = body.feed === "gmo" ? "gmo" as const : "twelve_data" as const;
    const feedDeltaAtr = num(body.feed_delta_atr);
    const candles = readCandles(body.candles);
    const newestBarClosed = typeof body.newest_bar_closed === "boolean" ? body.newest_bar_closed : null;

    // The caller's remaining budget, in ms. Bound together with the request's
    // own signal so this stops when EITHER the clock runs out or analyze stops
    // listening — the second is what keeps an abandoned review from billing a
    // call nobody will read.
    const budgetMs = Math.max(1_000, num(body.budget_ms) ?? 20_000);
    const signal = AbortSignal.any([req.signal, AbortSignal.timeout(budgetMs)]);

    const restHeaders = {
      Authorization: `Bearer ${serviceRoleKey}`,
      apikey: serviceRoleKey,
      "accept-profile": "public",
    };
    const restGet = async (path: string): Promise<unknown> => {
      const res = await fetch(`${supabaseUrl}/rest/v1/${path}`, { headers: restHeaders, signal });
      const text = await res.text();
      if (!res.ok) throw new Error(`rest ${res.status}: ${text.slice(0, 120)}`);
      return parseJsonResponse(text);
    };

    const uid = encodeURIComponent(userId);
    const pairQ = encodeURIComponent(pair);
    // The reference row, with the four JSON paths the review reads aliased
    // out so the row's own evaluation.path (60 points) is not fetched.
    const planSelect = "id,created_at,priced_at,interval,signal,confidence,thesis,entry_point,stop_loss,take_profit_1," +
      "outcome,outcome_price,closed_at,entry_check,price_basis:evaluation->>price_basis,key_factors:result->key_factors," +
      "snapshot:context->entry,structure:context->structure->0";
    const sinceIso = new Date(Date.now() - PREVIOUS_WINDOW_HOURS * 60 * 60 * 1000).toISOString();

    const refs: ReferenceSet = { held: null, held_reason: null, previous: null, previous_reason: null, thesis_of: null };
    // A lookup that could not be made is a different thing from a lookup that
    // came back empty, and it has to be loud in both places: in the log,
    // because an outage the row records as "no reference" is invisible; and in
    // the row, because "nothing to review" and "could not look" draw the same
    // blank screen.
    const lookupFailed = (what: string) => (err: unknown) => {
      console.warn(
        `Position review ${what} lookup failed:`,
        redactSecrets(err instanceof Error ? err.message : String(err)).slice(0, 200),
      );
      return "lookup_failed" as const;
    };
    const [positionsRaw, previousRaw] = await Promise.all([
      restGet(`positions?user_id=eq.${uid}&pair=eq.${pairQ}&status=eq.open&select=*&order=opened_at.desc,created_at.desc&limit=10`)
        .catch(lookupFailed("positions")),
      restGet(
        `analyses?user_id=eq.${uid}&pair=eq.${pairQ}&interval=eq.${encodeURIComponent(interval)}&preview=is.false&shadow=is.false` +
          `&created_at=gte.${encodeURIComponent(sinceIso)}&select=${planSelect}&order=created_at.desc&limit=1`,
      ).catch(lookupFailed("previous analysis")),
    ]);
    if (positionsRaw === "lookup_failed") {
      refs.held_reason = "lookup_failed";
    } else if (Array.isArray(positionsRaw) && positionsRaw.length > 0 && isRecord(positionsRaw[0])) {
      const newest = positionsRaw[0];
      const others = positionsRaw.slice(1)
        .map((p) => (isRecord(p) && typeof p.id === "string" ? p.id : null))
        .filter((x): x is string => x !== null);
      const planRaw = typeof newest.analysis_id === "string"
        ? await restGet(`analyses?id=eq.${encodeURIComponent(newest.analysis_id)}&select=${planSelect}&limit=1`)
          .catch(lookupFailed("held plan"))
        : "lookup_failed" as const;
      const planFetchFailed = planRaw === "lookup_failed";
      const plan = Array.isArray(planRaw) && planRaw.length > 0 ? planRaw[0] : null;
      refs.held = readHeldReference(newest, plan, others);
      // The position row points at its plan with an ON DELETE CASCADE
      // reference, so a plan row that is genuinely gone cannot coexist with an
      // open position: `plan_row_missing` is reserved for the fetch that came
      // back EMPTY, and a fetch that threw says so.
      if (refs.held === null) refs.held_reason = "lookup_failed";
      else if (planFetchFailed) refs.held_reason = "lookup_failed";
      else if (plan === null) refs.held_reason = "plan_row_missing";
    } else {
      refs.held_reason = "no_open_position";
    }
    if (previousRaw === "lookup_failed") {
      refs.previous_reason = "lookup_failed";
    } else {
      refs.previous = Array.isArray(previousRaw) && previousRaw.length > 0 ? readPreviousReference(previousRaw[0]) : null;
      if (refs.previous === null) refs.previous_reason = "none_within_window";
    }
    refs.thesis_of = refs.held ? "held" : refs.previous ? "previous" : null;
    acc.reference = refs;
    if (refs.thesis_of === null) {
      // `skipped` means there was nothing to review. When a lookup threw,
      // there may well have been — say so, so the row is not counted among the
      // runs that found no position and no previous call.
      const lookupBroke = refs.held_reason === "lookup_failed" || refs.previous_reason === "lookup_failed";
      acc.status = lookupBroke ? "failed" : "skipped";
      acc.skipped_reason = lookupBroke ? null : "no_reference";
      acc.error = lookupBroke ? "lookup_failed" : null;
      return done(acc);
    }

    // The facts first, before any model call, so a timed-out review still
    // stores them. Measured on the entry-timeframe mid series the CALLER
    // fetched, from the bar after the anchor — this function never fetches
    // market data of its own, because a second fetch would be a different
    // series than the plan was read on.
    const subject = refs.held ?? refs.previous!;
    const levels = subject.kind === "held"
      ? { direction: subject.direction, entry: subject.entry, stop: subject.stop, tp1: subject.tp1 }
      : subject.levels;
    acc.mechanical = levels === null || price === null ? null : mechanicalFacts({
      subject: subject.kind,
      direction: levels.direction,
      entry: levels.entry,
      stop: levels.stop,
      tp1: levels.tp1,
      anchor: subject.kind === "held"
        ? { at: subject.opened_at, source: "opened_at" }
        : { at: subject.priced_at, source: "priced_at" },
      candles,
      newestBarClosed,
      price,
      pricedAt,
      feed,
      feedDeltaAtr,
      decimals,
    });
    if (model === "") {
      acc.status = "failed";
      acc.error = "no_model";
      return done(acc);
    }

    const request = buildReviewRequest({
      model,
      locale,
      pair,
      nowUtc,
      reference: subject,
      mechanical: acc.mechanical,
      sections,
      decimals,
    });
    const sentAt = new Date().toISOString();
    // Recorded before the call, so a turn that dies still says what was sent.
    // analyze writes this to position_review_prompts once it has a row id.
    acc.request = recordRequest(request, sentAt);
    const calledAt = Date.now();
    // The budget is a deadline to ANSWER by, not merely to stop at. If the
    // model turn is still running when it expires, this returns the facts it
    // already has rather than letting the caller time out holding nothing.
    // The signal still aborts the call itself, so nothing keeps running after
    // the answer has been sent.
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(request),
      signal,
    });
    const raw = await res.text();
    const shape = {
      model: request.model,
      effort: acc.request.effort,
      max_tokens: request.max_tokens,
      elapsed_ms: Date.now() - calledAt,
    };
    const failedAnswer = (error: string) => {
      acc.analyst = { status: "failed", verdict: null, thesis_status: null, reasons: [], what_changed: [], watch: null, ...shape, error };
      acc.status = "failed";
      acc.error = error;
    };
    if (!res.ok) {
      console.error("Position review API error:", res.status, raw.slice(0, 300));
      failedAnswer(`api_${res.status}`);
      return done(acc);
    }
    const answer = parseReviewAnswer(parseAnalysisJson(extractAnthropicText(parseJsonResponse(raw))), subject.kind);
    if (!answer.ok) {
      failedAnswer(`parse_${answer.error}`);
      return done(acc);
    }
    acc.analyst = {
      status: "ok",
      verdict: answer.verdict,
      thesis_status: answer.thesis_status,
      reasons: answer.reasons,
      what_changed: answer.what_changed,
      watch: answer.watch,
      ...shape,
      error: null,
    };
    acc.status = "ok";
    return done(acc);
  } catch (err) {
    // Same classification the in-process version used, so the row's `error`
    // keeps meaning what it meant: a deadline or a dropped caller is
    // `time_budget`, everything else is the redacted message.
    const timedOut = err instanceof DOMException && (err.name === "TimeoutError" || err.name === "AbortError");
    const error = timedOut ? "time_budget" : redactSecrets(err instanceof Error ? err.message : String(err)).slice(0, 200);
    if (!timedOut) console.error("position-review threw:", error);
    // `failed` answers from the hoisted accumulator, so a budget expiry after
    // the references and facts were measured still returns them — and still
    // returns `acc.request`, which is what keeps "timed out after sending"
    // distinguishable from "never asked" in position_review_prompts.
    return failed(error);
  }
});
