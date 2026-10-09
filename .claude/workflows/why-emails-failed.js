export const meta = {
  name: 'why-emails-failed',
  description: 'Read-only: why did the 15-minute ULTRA emails of one JST day miss (weak signal, chance, or something else)? Four fact-finders, a skeptical verifier for each, then a Japanese answer for the owner',
  whenToUse: 'When the owner says a day\'s emails missed (e.g. SELLs while the price kept rising). args: { date: "YYYY-MM-DD" (the JST day), note?: the owner\'s context (positions, chart readings, screenshots described in words), side?: "SELL" | "BUY" (default both) }',
  phases: [
    { title: 'Facts', detail: 'emails and correctness; price path after each email; the signal\'s measured strength; chart context of the day' },
    { title: 'Verify', detail: 'a skeptical verifier per fact-finder' },
    { title: 'Synthesize', detail: 'weak signal vs chance vs other, with the numbers' },
  ],
}

// First run by hand on 2026-10-09 (docs: the owner's 「判断材料が甘いの？それともたまたま？それともほかの理由？」),
// then saved at the owner's request (「保存して」) for the loop that learns from each missed email (task #251).
// The owner's rules: chart analysis only, no news (「ニュースは考慮しなくていいです。チャート分析だけで大丈夫」);
// a win rate always with the P/L per trade; say what was not checked. Read-only throughout; only F2 may
// dispatch the read-only feed-check.yml. Steps that are mostly SQL and reading run on a smaller model.
const date = args?.date
if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('args.date (YYYY-MM-DD, the JST day) is required')
const note = typeof args?.note === 'string' && args.note.trim() ? args.note.trim() : '(none given)'
const side = args?.side === 'SELL' || args?.side === 'BUY' ? args.side : 'both'

const PRE = `READ-ONLY investigation. Repository: /home/user/fx-canvas-mind. Live Supabase project "endcqzewujdvimdlazhj" (SELECT-only SQL via mcp__Supabase__execute_sql; load with ToolSearch "select:mcp__Supabase__execute_sql").
HARD RULES: no file edits in the repository, no commits, pushes, deploys or DB writes. Never print user_id values, email addresses, tokens or secrets. Never select cron.job "command" or the vault schema. Do not call Lovable, Gmail or Higgsfield. Only the fact-finder told so may dispatch the read-only workflow feed-check.yml. Chart analysis only: do not use news or the economic calendar (the owner's rule).
THE DAY: ${date} in JST (UTC+9), i.e. emails whose public.signal_alerts.closed_at is in [${date} 00:00 JST, next day 00:00 JST); sides of interest: ${side}.
THE OWNER'S CONTEXT: ${note}
THE SIGNAL: ULTRA on 15-minute bars — RSI(14) (Wilder/Pine) of the GMO bid/ask MID close; SELL when it crosses down through 70, BUY when it crosses up through 30 (supabase/functions/_shared/ultra.ts, supabase/functions/signal-alerts/indicators.ts). FX pairs from GMO: USD/JPY, EUR/JPY, AUD/JPY, EUR/USD, AUD/USD; gold XAU/USD from Twelve Data (stored 15-minute bars in public.live_chart_fallback). Email levels: stop 13 pips ($13 on gold), TP1 4, TP2 10, TP3 16 from the entry E (the signal bar's mid close). The owner's way (docs/OPERATIONS.md §8.102 "持ち方 O"): order at P (sent_at rounded up to the minute + 1 min), market if already better than E else a limit at E, TP 10 pips, no stop.
GMO DAY FILES: key K covers K-1 21:00 UTC to K 21:00 UTC (06:00 JST to 06:00 JST). Ended days are stored in public.gmo_kline_files (15-minute BID/ASK); the running day is not stored until about 00:00 UTC the next day.
KNOWN FROM EARLIER WORK (verify, do not assume): §8.102 study (a), 2024-01..2026-10, about 9,500 emails: one day after the order the signal's direction was not better than the opposite (+0.39 pips, lower bound -0.89); per email 98.8% at +4.86 pips but the opposite direction also 98.8% at +2.65 (the high rate comes from having no stop); 11.1% of emails were at -30 pips or worse one day later. The email prints "TP1 before the stop 72.0%, -1.51 pips a trade" (break-even needs more than 76.5%). On 2026-10-07 (8 EUR/USD BUYs into a fall) and 2026-10-09 (EUR/JPY SELLs at 177.290, 177.388, 177.581, 177.769, 177.702 into a rise) the rule repeated the same direction at worse and worse prices, because it has no trend condition and no memory of earlier emails.
THE OWNER'S QUESTION: why did the emails miss — are the decision criteria weak (判断材料が甘い), was it chance (たまたま), or something else? Answers must be honest: a win rate always with the P/L per trade; say what was not checked.`

const FACTS = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    claims: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, claim: { type: 'string' }, evidence: { type: 'string' }, confidence: { type: 'string', enum: ['high', 'medium', 'low'] } }, required: ['id', 'claim', 'evidence', 'confidence'] } },
    not_checked: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary', 'claims', 'not_checked'],
}
const VERDICTS = {
  type: 'object',
  properties: { results: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, verdict: { type: 'string', enum: ['CONFIRMED', 'CORRECTED', 'UNVERIFIABLE'] }, statement: { type: 'string' }, evidence: { type: 'string' } }, required: ['id', 'verdict', 'statement', 'evidence'] } } },
  required: ['results'],
}
const ANSWER = {
  type: 'object',
  properties: {
    verdict_short: { type: 'string' },
    causes: { type: 'array', items: { type: 'object', properties: { cause: { type: 'string' }, weight: { type: 'string' }, evidence: { type: 'string' } }, required: ['cause', 'weight', 'evidence'] } },
    day_table: { type: 'string' },
    how_unusual: { type: 'string' },
    what_not_checked: { type: 'array', items: { type: 'string' } },
    lessons_for_the_rule: { type: 'array', items: { type: 'string' } },
    next_steps_for_owner: { type: 'array', items: { type: 'string' } },
  },
  required: ['verdict_short', 'causes', 'day_table', 'how_unusual', 'what_not_checked', 'lessons_for_the_rule', 'next_steps_for_owner'],
}

const FINDERS = [
  {
    key: 'F1-correctness',
    model: 'sonnet',
    prompt: `F1 — WERE THE DAY'S EMAILS CORRECT PER THE RULE (not a bug)? List the day's rows of public.signal_alerts (interval 15min): pair, side, status, bar_time, closed_at, sent_at, entry, stop, target, rsi_prev, rsi. For every SELL check rsi_prev >= 70 > rsi, for every BUY rsi_prev <= 30 < rsi; stop/target distances; the sending delay. If net._http_response still holds the hours (it keeps about 6 hours; json in "content", mode "indicators", each read has pair, newest, signals), confirm every bar was judged and no ULTRA signal was missing or extra for the subscribed charts. For ended GMO days, recompute the RSI crossings from public.gmo_kline_files exactly as the app rounds (the mid of BID and ASK as doubles, then Number(x.toFixed(3)) on JPY pairs and toFixed(5) on the others) and compare with the emails. Explain from the code what the rule uses and what it ignores, and why it fires again each time RSI falls back under 70 (or rises back over 30) while the price keeps going.`,
  },
  {
    key: 'F2-price-path',
    model: undefined,
    prompt: `F2 — WHAT HAPPENED AFTER EACH EMAIL. You MAY dispatch the read-only workflow feed-check.yml (owner "kmunemoto", repo "fx-canvas-mind", ref "main"; inputs: urls = space-separated GMO public URLs, filter = a jq program applied to each JSON answer, max_bytes) with mcp__github__actions_run_trigger (method run_workflow), then read its log with mcp__github__actions_list and mcp__github__get_job_logs (return_content true); load these tools with ToolSearch. GMO URLs: https://forex-api.coin.z.com/public/v1/klines?symbol=EUR_JPY&priceType=ASK&interval=1min&date=YYYYMMDD (answers {"data":[{"openTime":"ms","open","high","low","close"},...]}, prices are strings; use every GMO day key the period needs). Make jq compute the per-email numbers ON THE RUNNER and print only small results, so no long data is copied by hand: for a SELL with close time C (ms) and entry E — the lowest ASK low after C and when, whether ASK reached E-4 pips (TP1) and E-10 pips (TP2) and when first, whether ASK reached E+13 pips (the email's stop) and when, the highest ASK high after C and when, the newest bar's close; mirror for a BUY with BID. Pip = 0.01 on JPY pairs, 0.0001 on EUR/USD and AUD/USD. Report for each FX email of the sides of interest: E, best move in our favour, TP1/TP2 reached or not and when (JST), stop line reached or not, worst adverse pips, the pips now; then the totals (the email's way: TP1 4 or stop 13 first, win rate WITH P/L per trade; the owner's way: TP 10 reached or still open, P/L per trade). Gold: only if its bars are readable from public.live_chart_fallback; otherwise say not checked. Never invent numbers; say which run each number came from.`,
  },
  {
    key: 'F3-structural',
    model: undefined,
    prompt: `F3 — IS THE SIGNAL ITSELF WEAK? Collect the measured evidence (exact numbers and lines): study (a) of docs/OPERATIONS.md §8.102 (per email, the opposite direction, the account); the figure the email prints (supabase/functions/signal-alerts/indicators.ts INDICATOR_MEASURED) and its break-even rate; what the chart's ULTRA tally ("勝率") counts (src/components/PriceChart.tsx: mid bars, no spread, loaded bars only, the email's levels) and its P/L per trade; every filter or trend condition this project has measured and its result (search docs for 絞り込み, トレンド, 流れ, ダウ, Stoch, BLSH, MACD, 通貨の強弱, #142, #158, #159, #174, #179, #130, and any later trend-condition measurement such as task #250). Using research/ledger/ultra15-a.csv (T,pair,side,P,week,v1d; v1d = the owner's-way value one day after P, in pips — confirm in the research code), compute how often an email of the same pair group and side was at -30 pips or worse one day later, and how clusters of same-pair same-direction emails within 3 hours did (first email vs later ones vs single emails). Say whether this day's pattern is the common failure mode of the rule.`,
  },
  {
    key: 'F4-chart-context',
    model: 'sonnet',
    prompt: `F4 — THE DAY'S CHART CONTEXT AND HOW UNUSUAL IT WAS (chart data only; no news). From public.gmo_kline_files (ended GMO days, 15-minute BID/ASK; mid = (bid+ask)/2) compare the day's move over the hours of the emails with the same hours on the last 20-30 stored days (percentile of the move and of its absolute size, typical daily range, any recent change in volatility). If the day has not ended, use only the email entries and the prices the owner gave in the context; say so. Check whether the pairs moved together (JPY weakness/strength, USD weakness/strength): the correlation of 15-minute returns between the pairs over the stored days, and what that means for several same-direction emails on correlated pairs (one bet, not several). Report claims with evidence; say what could not be checked.`,
  },
]

const verified = await pipeline(
  FINDERS,
  (f) => agent(`${PRE}\n\n${f.prompt}`, { label: `facts:${f.key}`, phase: 'Facts', schema: FACTS, ...(f.model ? { model: f.model } : {}) }),
  (found, f) => {
    if (!found || !Array.isArray(found.claims) || found.claims.length === 0) return { key: f.key, found, verified: null }
    return agent(`${PRE}\n\nYou are a SKEPTICAL VERIFIER of another investigator's claims for this question:\n${f.prompt}\n\nClaims (JSON):\n${JSON.stringify(found.claims, null, 1)}\n\nRe-check every claim yourself (re-read the code/docs lines, re-run the SQL, recompute the numbers from the same sources; for numbers from a feed-check run, read that run's log yourself and recompute from it — dispatch a new run only if a number cannot be checked otherwise). Look for contrary evidence. CONFIRMED only if you saw it yourself; CORRECTED with the right statement; UNVERIFIABLE otherwise. Keep the ids.`,
      { label: `verify:${f.key}`, phase: 'Verify', schema: VERDICTS, ...(f.model ? { model: f.model } : {}) }).then((v) => ({ key: f.key, found, verified: v }))
  },
)

phase('Synthesize')
const compact = verified.filter(Boolean).map((r) => ({ key: r.key, summary: r.found ? r.found.summary : null, claims: r.found ? r.found.claims : [], not_checked: r.found ? r.found.not_checked : [], verified: r.verified ? r.verified.results : null }))
const answer = await agent(`${PRE}\n\nVerified findings (JSON; use only CONFIRMED statements or the CORRECTED versions; treat UNVERIFIABLE as not established):\n${JSON.stringify(compact, null, 1)}\n\nWrite the answer to the owner's question as structured data: verdict_short (one or two sentences, honestly weighted between weak signal, chance and other reasons); causes (each with weight and evidence); day_table (a compact table of the day's FX emails: time JST, pair, side, E, best move in our favour, TP1/TP2 reached?, worst adverse pips, pips now); how_unusual; what_not_checked; lessons_for_the_rule (chart-only conditions this day suggests testing — each to be measured BEFORE any change, decided before looking at data, adopted only if the win rate rises and the P/L per trade does not fall on data not used to choose it); next_steps_for_owner (options only; the owner decides). Owner-facing text in Japanese, short sentences; every win rate with the P/L per trade; no claim beyond the verified evidence.`,
  { label: 'synthesize', phase: 'Synthesize', schema: ANSWER })

return { date, side, findings: compact, answer }
