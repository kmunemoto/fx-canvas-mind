// Prompts and response contracts for the post-mortem model calls.
//
// Two calls. The diagnosis reads one plan and its facts and names a cause
// and a lesson; the consolidation reads every lesson and the record and
// rewrites the rulebook. Both use structured outputs, and both are parsed
// back defensively — a malformed answer becomes "no diagnosis", never a
// stored one.
//
// The consolidation is where a learning loop goes wrong quietly, so the
// numbers it is given and the numbers it may write back are both kept
// honest here: statistics below a sample floor are handed over as null, a
// rule's support is computed from the lessons it cites (and a citation
// only counts when the lesson is actually about the rule's failure), plans
// made in the same market situation count once, and a revision may add or
// drop only a couple of rules so that any version of the rulebook lives
// long enough to be measured.
//
// Deno-free on purpose: src/test/postmortem.test.ts imports this file
// directly.

import {
  CAUSES,
  CHOP_CROSSINGS,
  LATE_LIFE_RATIO,
  LUCKY_MAE_R,
  MARKET_CONTRACT,
  MIN_DANGER_BARS,
  PULLBACK_R,
  SPIKE_CLOSE_R,
  SPIKE_REVERSAL_R,
  UNDERWATER_RATIO,
  canonicalCause,
  causeOutsideContract,
  causesFor,
  isCause,
  type Cause,
  type PostmortemFacts,
} from "./facts.ts";
import { MIN_RISK_REWARD, MIN_STOP_ATR, TREND_ADX } from "../analyze/entry.ts";
import { isRuleKind, orderRules, type Rule, type RuleKind } from "../analyze/rules.ts";
import { LEGACY_PLAN_CONTRACT } from "../_shared/contract.ts";

export const MAX_RULES = 10;
// Storage caps, per language, because one number cannot serve both. The
// schema asks for 90-100 characters of Japanese and the same sentence in
// English; English renders that in roughly two to two and a half times the
// characters, so a shared 160 cut two rules in three and fifteen lessons in
// seventeen mid-word (measured 2026-09-05), while the Japanese never came
// within fifty characters of the cap. Each cap sits well above what its
// language is asked for, the way 160 sat above 100 for Japanese alone.
export const MAX_LESSON_CHARS = 160;
export const MAX_LESSON_CHARS_EN = 320;
export const MAX_RULE_CHARS = 160;
export const MAX_RULE_CHARS_EN = 320;
// The revision note has the same shape of problem one step behind: v8 stored
// 567 English characters against a shared 600 while its Japanese ran 304, so
// the next one cuts. Display-only, but displayed in the reader's language.
export const MAX_SUMMARY_CHARS = 600;
export const MAX_SUMMARY_CHARS_EN = 1200;
// Below this many settled trades a win rate is not a statistic
export const MIN_STAT_N = 20;
// Rules a single revision may add / drop
export const MAX_RULES_ADDED = 2;
export const MAX_RULES_REMOVED = 2;
// Plans on the same pair in the same direction this close together were one
// decision about one situation: they count once...
export const CLUSTER_WINDOW_MS = 24 * 60 * 60 * 1000;
// ...unless the earlier plan had already settled this long before the next
// one was made, in which case the market had moved on
export const CLUSTER_REOPEN_MS = 4 * 60 * 60 * 1000;

type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// Trimmed on both sides of the cut: trimming only before it lets the cut
// itself leave a trailing space, and then the same sentence stored twice
// differs by that one character. That is not a hypothetical — it made the
// first live `reworded` a false positive (rulebook v8, rule r11).
const str = (v: unknown, max = 400): string => (typeof v === "string" ? v.trim().slice(0, max).trim() : "");

const strList = (v: unknown, max = 6, each = 300): string[] =>
  Array.isArray(v) ? v.map((x) => str(x, each)).filter(Boolean).slice(0, max) : [];

const clampInt = (v: unknown, lo: number, hi: number, fallback: number): number => {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.round(Math.min(hi, Math.max(lo, n)));
};

const round2 = (v: number) => Number(v.toFixed(2));

// ---------------------------------------------------------------------------
// Clusters and statistics
// ---------------------------------------------------------------------------

export interface Clusterable {
  pair: string;
  signal: string;
  created_at: string;
  // When the plan settled, if known: a plan made well after the previous
  // one closed is a new decision even inside the window
  closed_at?: string | null;
}

// Cluster ids for a set of plans, in input order. A plan joins the cluster of
// the previous plan on the same pair and direction when it was made within
// CLUSTER_WINDOW_MS of it, unless that plan had settled more than
// CLUSTER_REOPEN_MS earlier.
//
// Deliberately NOT keyed by user. A cluster is one market situation, and the
// rulebook is shared by every account, so two people analysing USD/JPY long
// within the window received two copies of ONE decision by one analyst — one
// piece of evidence about it, not two. Keying by user made a rule's support
// grow with the number of subscribers, and support is the number the prompt
// prints ("28 cases") and the number that decides whether a rule survives a
// revision. The client's own clusterIds (src/lib/outcomeStats.ts) never keyed
// by user either; only this side did.
export const clusterIds = (items: Clusterable[]): string[] => {
  const order = items
    .map((item, i) => ({ i, t: Date.parse(item.created_at) }))
    .sort((a, b) => (Number.isFinite(a.t) ? a.t : 0) - (Number.isFinite(b.t) ? b.t : 0));
  const last = new Map<string, { id: string; t: number; closed: number }>();
  const out = new Array<string>(items.length);
  for (const { i, t } of order) {
    const item = items[i];
    const key = `${item.pair}|${item.signal}`;
    const prev = last.get(key);
    const closed = item.closed_at ? Date.parse(item.closed_at) : NaN;
    const joins = prev !== undefined && Number.isFinite(t) &&
      t - prev.t < CLUSTER_WINDOW_MS &&
      !(Number.isFinite(prev.closed) && t > prev.closed + CLUSTER_REOPEN_MS);
    if (joins && prev) {
      out[i] = prev.id;
      last.set(key, { id: prev.id, t, closed: Number.isFinite(closed) ? Math.max(closed, prev.closed || 0) : prev.closed });
      continue;
    }
    const startIso = Number.isFinite(t) ? new Date(t).toISOString().slice(0, 13) : "unknown";
    const id = `${key}|${startIso}`;
    last.set(key, { id, t: Number.isFinite(t) ? t : 0, closed: Number.isFinite(closed) ? closed : NaN });
    out[i] = id;
  }
  return out;
};

// One shared rulebook, many accounts: take the newest from each contributor
// in turn rather than the newest overall.
//
// The record and the lessons are read newest-first with a fixed limit. With
// one account that is simply "the recent past". With several it is "whoever
// analysed most", and the rulebook quietly becomes that person's — their
// pairs, their timeframes, their read of the market — while everyone else's
// results never enter the window at all.
//
// Round-robin needs no threshold and no notion of a fair share: it degenerates
// to plain newest-first when one account contributed, and it never lets a
// heavy account take a second row before every other account has taken a
// first. What it cannot fix is an account whose volume exceeds the fetch
// window entirely — hence the over-fetch at the call site and the contributor
// counts in the run summary, so crowding is visible rather than assumed away.
export const fairShare = <T>(items: T[], userOf: (x: T) => string, limit: number): T[] => {
  if (limit <= 0) return [];
  const byUser = new Map<string, T[]>();
  for (const item of items) {
    const key = userOf(item);
    const list = byUser.get(key);
    if (list) list.push(item);
    else byUser.set(key, [item]);
  }
  const queues = [...byUser.values()];
  if (queues.length <= 1) return items.slice(0, limit);
  const out: T[] = [];
  for (let round = 0; out.length < limit; round++) {
    let took = false;
    for (const queue of queues) {
      if (queue.length <= round) continue;
      out.push(queue[round]);
      took = true;
      if (out.length >= limit) break;
    }
    if (!took) break;
  }
  return out;
};

// Wilson score interval for a proportion, in percent
export const wilson = (successes: number, n: number, z = 1.96): [number, number] | null => {
  if (n <= 0) return null;
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return [Math.round(Math.max(0, centre - half) * 100), Math.round(Math.min(1, centre + half) * 100)];
};

export interface RecordRow {
  id?: string;
  user_id?: string | null;
  pair: string;
  signal: string;
  created_at: string;
  closed_at?: string | null;
  outcome: string;
  shadow: boolean;
  rejection: string | null;
  filled: boolean;
  entry: number | null;
  stop: number | null;
  tp1: number | null;
  // What the judge saw the plan fill at, when it recorded one
  fill_price?: number | null;
  outcome_price: number | null;
  rulebook_version: number | null;
  // Which entry contract the plan was made under. Rows from any contract but
  // the live one are counted apart rather than pooled: under entry_chosen_v1
  // the model picked the entry price and a plan the market never reached was
  // never scored at all, which cannot happen under market_v1. A rate taken
  // over both describes a population that never existed.
  contract?: string | null;
  // The verdict on a call that declined to trade, once the tracker has
  // reached one. 'missed' means the market then offered a trade this app
  // would itself have allowed, and it won.
  wait_verdict?: string | null;
}

// What the plan made or lost, in multiples of its planned risk. A win is
// paid at TP1, a loss costs 1R, an expiry is marked where it closed.
// Frictionless: no spread or slippage is charged.
export const realizedR = (
  row: Pick<RecordRow, "signal" | "outcome" | "entry" | "stop" | "tp1" | "outcome_price" | "fill_price">,
): number | null => {
  const { stop, tp1 } = row;
  // The price the trade actually opened at, when the judge recorded one
  const entry = typeof row.fill_price === "number" && Number.isFinite(row.fill_price) ? row.fill_price : row.entry;
  if (entry === null || stop === null || tp1 === null || ![entry, stop, tp1].every(Number.isFinite)) return null;
  const risk = Math.abs(entry - stop);
  if (risk <= 0) return null;
  const sign = row.signal === "BUY" ? 1 : row.signal === "SELL" ? -1 : 0;
  if (sign === 0) return null;
  if (row.outcome === "win") return round2(Math.abs(tp1 - entry) / risk);
  if (row.outcome === "loss") return -1;
  if (row.outcome === "expired" && row.outcome_price !== null && Number.isFinite(row.outcome_price)) {
    return round2((sign * (row.outcome_price - entry)) / risk);
  }
  return null;
};

export interface Bucket {
  plans: number;
  wins: number;
  losses: number;
  untriggered: number;
  open: number;
  sum_r: number;
}

const emptyBucket = (): Bucket => ({ plans: 0, wins: 0, losses: 0, untriggered: 0, open: 0, sum_r: 0 });

const addToBucket = (b: Bucket, row: RecordRow) => {
  b.plans++;
  if (row.outcome === "win") b.wins++;
  else if (row.outcome === "loss") b.losses++;
  else if (row.outcome === "untriggered") b.untriggered++;
  else if (row.outcome === "pending") b.open++;
  const r = realizedR(row);
  if (r !== null) b.sum_r = round2(b.sum_r + r);
};

// Rows written before the plan_contract column existed are legacy by
// definition: the contract only ever moved forwards.
export const LEGACY_CONTRACT = LEGACY_PLAN_CONTRACT;

export const rowContract = (row: Pick<RecordRow, "contract">): string =>
  typeof row.contract === "string" && row.contract.length > 0 ? row.contract : LEGACY_CONTRACT;

// Which contract the record is about: the one the most recent plan was made
// under. Derived rather than named by a constant so that the next change of
// contract needs no edit here — the day the first plan under a new contract
// is written, the old record stops being pooled into the new one on its own.
export const liveContract = (rows: RecordRow[]): string => {
  let contract = LEGACY_CONTRACT;
  let newest = -Infinity;
  for (const r of rows) {
    if (r.shadow) continue;
    const t = Date.parse(r.created_at);
    if (!Number.isFinite(t) || t <= newest) continue;
    newest = t;
    contract = rowContract(r);
  }
  return contract;
};

// Plans made under the seeded empty rulebook (version 0) had no rules in
// force either
export const versionKey = (v: number | null): string => (typeof v === "number" && Number.isFinite(v) && v > 0 ? String(v) : "none");

export interface LessonSummary {
  cause: string;
  cluster?: string | null;
  // The entry contract the plan was made under, so the editor can tell a
  // lesson whose remedy still exists from one whose remedy does not
  contract?: string | null;
  shadow?: boolean;
  rule_blamed?: string | null;
  rule_credited?: string | null;
}

export interface RecordStats {
  // Which entry contract every number below is about, and how many rows were
  // left out because they were made under a different one
  contract: string;
  other_contract_rows: number;
  total: number;
  wins: number;
  losses: number;
  untriggered: number;
  expired: number;
  ambiguous: number;
  open: number;
  // wins + losses: trades that reached one of their own levels
  settled: number;
  // wins + losses + expired — the win-rate denominator. An expiry is a call
  // that did not work out, and leaving it out let a target placed beyond
  // reach sit out the number entirely.
  decided: number;
  // Calls that declined to trade, and how they scored. A WAIT that is never
  // counted can never be wrong, which is the one escape hatch that costs
  // nothing to use; 'missed' is the record's only evidence of over-caution.
  waits: number;
  waits_judged: number;
  waits_missed: number;
  wait_miss_rate: number | null;
  // null until MIN_STAT_N decided trades exist
  win_rate: number | null;
  win_rate_ci95: [number, number] | null;
  fill_rate: number | null;
  realized_r: { n: number; sum: number; mean: number | null };
  // Settled trades counted once per market situation
  independent_clusters: number;
  min_stat_n: number;
  // Lessons of live plans by cause (shadow plans apart)
  by_cause: Record<string, number>;
  // The same, counting each cluster once
  by_cause_clusters: Record<string, number>;
  shadow_by_cause: Record<string, number>;
  // How many lessons came from each entry contract. The causes above pool the
  // eras; this is what says in what proportion.
  lessons_by_contract: Record<string, number>;
  // The record of every plan made under each rulebook version — the
  // before/after comparison. It is the version's record, not any one rule's.
  by_rulebook_version: Record<string, Bucket>;
  // How often a diagnosis named a rule as the cause of, or a help to, a
  // result — the one per-rule signal there is
  rule_feedback: Record<string, { blamed: number; credited: number }>;
  // Plans the entry gate refused, and how many of them the market then
  // filled anyway
  rejected: number;
  shadow: { total: number; untriggered: number; wins: number; losses: number; open: number };
}

// The record as numbers, from the rows the consolidation is given
export const summarizeRecord = (rows: RecordRow[], lessons: LessonSummary[]): RecordStats => {
  const s: RecordStats = {
    contract: liveContract(rows), other_contract_rows: 0,
    total: 0, wins: 0, losses: 0, untriggered: 0, expired: 0, ambiguous: 0, open: 0,
    settled: 0, decided: 0, waits: 0, waits_judged: 0, waits_missed: 0, wait_miss_rate: null,
    win_rate: null, win_rate_ci95: null, fill_rate: null,
    realized_r: { n: 0, sum: 0, mean: null },
    independent_clusters: 0, min_stat_n: MIN_STAT_N,
    by_cause: {}, by_cause_clusters: {}, shadow_by_cause: {}, lessons_by_contract: {},
    by_rulebook_version: {}, rule_feedback: {},
    rejected: 0,
    shadow: { total: 0, untriggered: 0, wins: 0, losses: 0, open: 0 },
  };
  let filled = 0;
  let settledOrLapsed = 0;
  const clusters = clusterIds(rows);
  const settledClusters = new Set<string>();
  rows.forEach((r, i) => {
    // Before anything else: a plan made under another contract is not part of
    // this record. Counted, so that a record that suddenly shrinks is legible
    // as a contract change rather than as plans going missing.
    if (rowContract(r) !== s.contract) {
      s.other_contract_rows++;
      return;
    }
    if (r.shadow) {
      s.shadow.total++;
      if (r.outcome === "untriggered") s.shadow.untriggered++;
      else if (r.outcome === "win") s.shadow.wins++;
      else if (r.outcome === "loss") s.shadow.losses++;
      else if (r.outcome === "pending") s.shadow.open++;
      return;
    }
    if (r.signal === "WAIT") {
      if (r.rejection) s.rejected++;
      s.waits++;
      // 'pending' and 'unknown' are not verdicts, so they stay out of both
      // sides of the rate: the first has not been judged yet, the second
      // never can be.
      if (r.wait_verdict === "missed" || r.wait_verdict === "correct") {
        s.waits_judged++;
        if (r.wait_verdict === "missed") s.waits_missed++;
      }
      return;
    }
    s.total++;
    if (r.outcome === "win") s.wins++;
    else if (r.outcome === "loss") s.losses++;
    else if (r.outcome === "untriggered") s.untriggered++;
    else if (r.outcome === "expired") s.expired++;
    else if (r.outcome === "ambiguous") s.ambiguous++;
    else if (r.outcome === "pending") s.open++;
    if (r.outcome === "win" || r.outcome === "loss" || r.outcome === "expired" || (r.outcome === "ambiguous" && r.filled)) {
      filled++;
      settledOrLapsed++;
    } else if (r.outcome === "untriggered") {
      settledOrLapsed++;
    }
    if (r.outcome === "win" || r.outcome === "loss") settledClusters.add(clusters[i]);
    const rr = realizedR(r);
    if (rr !== null) {
      s.realized_r.n++;
      s.realized_r.sum = round2(s.realized_r.sum + rr);
    }
    addToBucket(s.by_rulebook_version[versionKey(r.rulebook_version)] ??= emptyBucket(), r);
  });
  s.settled = s.wins + s.losses;
  s.decided = s.settled + s.expired;
  s.win_rate = s.decided >= MIN_STAT_N ? Math.round((s.wins / s.decided) * 100) : null;
  s.win_rate_ci95 = wilson(s.wins, s.decided);
  s.fill_rate = settledOrLapsed >= MIN_STAT_N ? Math.round((filled / settledOrLapsed) * 100) : null;
  s.wait_miss_rate = s.waits_judged >= MIN_STAT_N
    ? Math.round((s.waits_missed / s.waits_judged) * 100)
    : null;
  s.realized_r.mean = s.realized_r.n > 0 ? round2(s.realized_r.sum / s.realized_r.n) : null;
  s.independent_clusters = settledClusters.size;
  const causeClusters = new Map<string, Set<string>>();
  lessons.forEach((l, i) => {
    // Counted under the live spelling, so a rename does not split one concept
    // across two buckets in a histogram this small.
    const cause = canonicalCause(l.cause);
    s.lessons_by_contract[l.contract ?? LEGACY_CONTRACT] =
      (s.lessons_by_contract[l.contract ?? LEGACY_CONTRACT] ?? 0) + 1;
    if (l.shadow) {
      s.shadow_by_cause[cause] = (s.shadow_by_cause[cause] ?? 0) + 1;
      return;
    }
    s.by_cause[cause] = (s.by_cause[cause] ?? 0) + 1;
    const set = causeClusters.get(cause) ?? new Set<string>();
    set.add(l.cluster ?? `lesson-${i}`);
    causeClusters.set(cause, set);
    if (l.rule_blamed) (s.rule_feedback[l.rule_blamed] ??= { blamed: 0, credited: 0 }).blamed++;
    if (l.rule_credited) (s.rule_feedback[l.rule_credited] ??= { blamed: 0, credited: 0 }).credited++;
  });
  for (const [cause, set] of causeClusters) s.by_cause_clusters[cause] = set.size;
  return s;
};

// ---------------------------------------------------------------------------
// Diagnosis
// ---------------------------------------------------------------------------

export interface PlanSummary {
  id: string;
  pair: string;
  interval: string;
  signal: string;
  mode: string | null;
  confidence: number | null;
  thesis: string | null;
  entry: number;
  stop_loss: number;
  take_profit_1: number;
  take_profit_2: number | null;
  take_profit_3: number | null;
  price_at_signal: number | null;
  created_at: string;
  outcome: string;
  reason: string | null;
  filled_at: string | null;
  resolved_at: string | null;
  mfe_r: number | null;
  mae_r: number | null;
  tps_hit: number[];
  key_factors: string[];
  warnings: string[];
  analysis: string;
  market_context_detail: JsonRecord | null;
  timeframe_alignment: unknown[];
  entry_check: JsonRecord | null;
  context: JsonRecord | null;
  // Which entry contract the plan was made under. Old plans chose their own
  // entry price; new ones cannot, so the levers a lesson may move differ.
  contract?: string | null;
  // A plan the entry gate refused, tracked to check the refusal
  shadow: boolean;
  // The rules the plan was actually shown, so the diagnosis can say whether
  // one of them caused the miss
  rules_in_force?: Array<{ id: string; text_ja: string }>;
}

export interface Diagnosis {
  cause: Cause;
  secondary_causes: Cause[];
  avoidable: boolean;
  confidence: number;
  verdict_ja: string;
  verdict_en: string;
  evidence_ja: string[];
  evidence_en: string[];
  lesson_ja: string;
  lesson_en: string;
  scope: string | null;
  // Rule ids (from rules_in_force) the diagnosis blames or credits
  rule_blamed: string | null;
  rule_credited: string | null;
}

export const diagnosisSchema = (contract?: string | null) => ({
  type: "object",
  properties: {
    cause: { type: "string", enum: [...causesFor(contract)] },
    secondary_causes: { type: "array", items: { type: "string", enum: [...causesFor(contract)] } },
    avoidable: { type: "boolean", description: "分析時点の情報だけで回避できたか" },
    confidence: { type: "integer", description: "診断の確からしさ 0-100" },
    verdict_ja: { type: "string", description: "何が起きたかの結論。日本語、120字以内" },
    verdict_en: { type: "string", description: "The same conclusion in English, one or two sentences" },
    evidence_ja: { type: "array", items: { type: "string" }, description: "根拠 2-4 点。facts の数値を引用する。日本語" },
    evidence_en: { type: "array", items: { type: "string" }, description: "The same evidence in English" },
    lesson_ja: { type: "string", description: "次回に使う一般則。「条件 → 行動」の形、90字以内、日本語。個別の価格・日付を含めない" },
    lesson_en: { type: "string", description: "The same lesson in English, 220 characters or fewer" },
    scope: { type: ["string", "null"], description: "ルールが当てはまる範囲を短く（例: '1h/4h の戻り売り', 'レンジ相場'）。無ければ null" },
    rule_blamed: { type: ["string", "null"], description: "plan.rules_in_force のうち、この結果を招いたルールの id。無ければ null" },
    rule_credited: { type: ["string", "null"], description: "plan.rules_in_force のうち、この結果に貢献したルールの id。無ければ null" },
  },
  required: [
    "cause", "secondary_causes", "avoidable", "confidence",
    "verdict_ja", "verdict_en", "evidence_ja", "evidence_en",
    "lesson_ja", "lesson_en", "scope", "rule_blamed", "rule_credited",
  ],
  additionalProperties: false,
});

// The legacy-era shape, kept as the name the tests and older callers use.
export const DIAGNOSIS_SCHEMA = diagnosisSchema();

export const DIAGNOSIS_SYSTEM_PROMPT = `あなたはFXトレードの検証担当（ポストモーテム）です。AIアナリストが出したトレードプランと、その後の実際の値動きから計算した事実（facts）を突き合わせ、なぜその予想が外れた（または当たった）のかを厳密に診断します。

原則:
- 根拠にしてよいのは facts と plan に書かれていることだけ。事実に無い出来事（ニュース等）を推測で作らない。ニュース要因（news_shock）は、plan の warnings/key_factors に指標やイベントへの言及があり、かつ facts.abnormal_bar が観測された場合に限る。
- 次の順に検討する: (1) 方向は合っていたか (2) その場面で入ったこと自体が妥当だったか（伸びきった動きに飛び乗っていないか。旧契約 entry_chosen_v1 のプランでは、約定したか・逃したかも見る） (3) 損切り幅は適切だったか (4) 利確は届く距離だったか (5) 相場環境（トレンド/レンジ）の読みは正しかったか。
- facts.counterfactual は原因の切り分けに使う最重要の証拠。market_entry（成行で入っていたら）、market_entry_same_risk（成行で入り損切り幅を元のプランと同じにしていたら）、stop_x1_5 / stop_x2（損切りを広げていたら）、tp_half（利確を半分にしていたら）、limit_pullback（同じプランを ${PULLBACK_R}R 有利な値で約定していたら。損切り幅は同じ。現行契約では出せる注文ではなく、「伸びきったところを掴んだ」ことの尺度）。各項目の rr はその案自体のリスクリワード、viable はサーバーのエントリーゲートを通る案かどうか、gate は通らない理由（poor_rr: RR ${MIN_RISK_REWARD} 未満、stop_too_tight: 損切り幅 ATR${MIN_STOP_ATR}倍未満、too_far: 指値が現在値から遠すぎる、should_be_market: トレンド局面ではサーバーが指値を成行に修正する）。viable=false の案は「勝っていた」としても採用できない案なので、それを根拠に「成行にすべきだった」「指値にすべきだった」等の教訓を書かない。limit_pullback が win なら「その値位置で入るには遅すぎた」という事実であって、指値・押し目待ちの推奨ではない。ここから書ける lesson は「その条件では見送る（WAIT）」の形だけ。gate はその案が当時のゲートを通るかを示すだけで、「指値にすべきだった」の根拠にはならない。
- facts.hints は決定論的な事前分類で、通常はその中から選ぶ。覆す場合は evidence で理由を示す。facts.notes には判定の補足がある。
- facts.early_adverse_r は約定直後 3 本以内の最大逆行（R、取引中のみ）。即座に逆行した場合、伸びきった動きに乗った（chased_move）を疑う。
- lesson は「条件 → 行動」の形で、次回以降のプラン作成に直接使える一般則にする。個別の価格・日付・その日固有の出来事は書かない。同じ状況が来たときに何を変えるかを書く。
- lesson の「条件」は指標由来の観測量（ADX、ATR、SMA20/50の並び、上位足との整合、RSI、直近の値幅）で書く。アナリスト自身の自己申告（confidence の高さ、mode の宣言）を条件にしない。
- lesson は、アナリストが実際に出力できる範囲の指示にする。プランは1つのエントリー価格・1つの損切り・3つの利確で構成され、分割エントリー・ナンピン・両建て・トレーリングストップは表現できない。「一部を成行、残りを指値」のような分割指示は書かない。基本手順（損切りの幅、RR の下限）は lesson で上書きできない。その範囲内で書く。
- plan.contract が "market_v1" のプランでは、エントリー価格はアナリストが選んでいない。分析した瞬間の現在値がそのまま成行の約定価格になったものであり、「もっと引きつけて入るべきだった」「押し目を待つべきだった」は実行できない指示なので lesson にしない。動かせるのは方向・損切り幅・利確幅・そもそも入るか（WAIT）の4つだけで、lesson はそのいずれかを動かす形にする。反実仮想の limit_pullback も、この契約のプランでは「その状況では入らない（WAIT）」の根拠としてのみ読む。
- plan.contract が "entry_chosen_v1"（または未記載）の古いプランは、アナリストがエントリー価格を選んでいた時代のもの。当時の事実として検証してよいが、そこから引く lesson は上の4つの範囲に翻訳して書く。entry_too_far / entry_too_early はこの契約でのみ起こりうる原因で、market_v1 のプランでは選べない（スキーマの enum からも除いてある）。
- facts.danger は約定したプランの「危うさ」を約定から決着までの足で測ったもの。bars_in_trade（保有した足の本数）、underwater_bars / underwater_ratio（終値がエントリーより不利な側にあった足の本数と割合）、longest_underwater_bars（含み損が続いた最長の本数）、entry_crossings（終値がエントリー価格をまたいだ回数）、closest_to_stop_r（損切りまで最も近づいたときの残り R = 1 − mae_r）、target_bar_close_r（勝ちのみ。TP1 に届いた足の終値と TP1 の差を R で表したもの。負なら終値は TP1 に届いていない）、reversed_after_r（勝ちのみ。決着後の足で TP1 からどれだけ戻したか、R）、life_used_ratio（決着までに使った時間を、その時間足の期限に対する割合で表したもの）。flags は勝ちのときだけ立ち、各フラグの意味は: deep_mae（mae_r ≥ ${LUCKY_MAE_R}。損切り直前まで逆行した）、mostly_underwater（underwater_ratio ≥ ${UNDERWATER_RATIO} かつ ${MIN_DANGER_BARS} 本以上保有。保有期間の大半が含み損だった）、chop（entry_crossings ≥ ${CHOP_CROSSINGS}。エントリー価格を何度もまたいだ）、spike_target（target_bar_close_r ≤ −${SPIKE_CLOSE_R} かつ reversed_after_r ≥ ${SPIKE_REVERSAL_R}。利確はヒゲだけで、その後 ${SPIKE_REVERSAL_R}R 以上戻した）、late_win（life_used_ratio ≥ ${LATE_LIFE_RATIO}。期限の大半を使ってようやく届いた）。
- lucky_win は facts.danger.flags に実際に立っているフラグで根拠づける（evidence でそのフラグ名と数値を挙げる）。立っていないフラグを理由にしない。フラグが一つも無い勝ちは、plan や facts の他の項目に問題が見えない限り good_call とする。
- plan.rules_in_force があれば、そのプランがどのルールの影響下で作られたかを踏まえ、結果を招いた／貢献したルールがあれば rule_blamed / rule_credited に id を書く。無ければ null。
- confidence は診断の確からしさ。決着後の足が無い、反実仮想が ambiguous 等、事実が少ないときは下げる。
- shadow=true のプランは、サーバー側のエントリーゲートが「約定しない」等の理由で却下したものを検証用に追跡した結果である。却下が正しかったか（未約定なら正しい、勝っていたなら誤り）を verdict に含める。

原因の定義:
- direction_wrong: 方向そのものが逆。約定後に損切りまでほぼ一直線／損切り後も逆行が続いた（after.beyond_sl_r が大きい）／約定前に損切り側へ到達（reason=invalidated）。
- stop_too_tight: 方向は合っていたが損切りが近すぎた。損切り到達後に TP1 へ到達（after.reached_tp1）、または損切りを広げた反実仮想が win。広げた案が viable でない（RR 不足）場合、lesson は「損切りを広げる」だけでなく利確の置き方も併せて書く。
- entry_too_far:（entry_chosen_v1 の旧プランのみ）方向は合っていたがエントリーが約定しなかった。成行の反実仮想（market_entry または market_entry_same_risk）が viable かつ win。market_v1 のプランでは起こりえない。
- chased_move: 伸びきった動きに乗ってしまい、約定直後の逆行で損切り。early_adverse_r が大きく、limit_pullback（${PULLBACK_R}R 有利な約定）が win。同じ方向・同じ損切り幅でも、より良い値なら勝っていたということ。remedy は「その場面では入らない（WAIT）」であって、押し目を待つことではない。旧プランでは entry_too_early と呼んでいた同じ事象。
- target_too_far: 約定して順行したが TP1 に届かず反転。利確を半分にした反実仮想が win、mfe_r が大きい。
- regime_misread: トレンド/レンジの読み違い。facts.regime.conflict、レンジ相場でのトレンドフォロー等。
- news_shock: 指標・イベントの異常な値幅でプランが無効化された。facts.abnormal_bar.event があれば、その足で実際に発表された経済指標なので、推測ではなく事実として名指ししてよい。event が null の異常足は「原因不明の急変動」であって、指標のせいだと断定しない。
- plan_incoherent: 水準の矛盾で判定不能。
- good_call: 想定通りに勝った。
- lucky_win: 勝ったがプロセスに問題があった。
- inconclusive: 事実が足りず断定できない。`;

const compactAnalysis = (text: string, max = 1400): string =>
  text.length <= max ? text : `${text.slice(0, max)}…（以下省略）`;

export const buildDiagnosisPrompt = (
  plan: PlanSummary,
  facts: PostmortemFacts,
): { system: string; user: string; schema: ReturnType<typeof diagnosisSchema> } => {
  const payload = {
    plan: {
      ...plan,
      analysis: compactAnalysis(plan.analysis),
    },
    facts,
  };
  const user = [
    "次のトレードプランを検証してください。plan は AI が出したプラン（と、その時点で見ていた指標 context、適用されていたルール rules_in_force）、facts は実際の値動きから計算した事実です。",
    "数値の単位: *_r はプランのリスク幅（エントリー〜損切り）を 1 とした倍率。時刻は UTC。",
    "",
    JSON.stringify(payload),
  ].join("\n");
  return { system: DIAGNOSIS_SYSTEM_PROMPT, user, schema: diagnosisSchema(plan.contract) };
};

// A malformed answer is not stored. The cause must be one of ours; when the
// model's pick is not, the deterministic hint stands.
export const parseDiagnosis = (
  raw: unknown,
  hints: Cause[],
  ruleIds: string[] = [],
  contract?: string | null,
): Diagnosis | null => {
  if (!isRecord(raw)) return null;
  const lessonJa = str(raw.lesson_ja, MAX_LESSON_CHARS);
  const lessonEn = str(raw.lesson_en, MAX_LESSON_CHARS_EN);
  const verdictJa = str(raw.verdict_ja);
  const verdictEn = str(raw.verdict_en);
  if (!lessonJa && !lessonEn) return null;
  if (!verdictJa && !verdictEn) return null;
  // Canonicalised in both eras, so no new row ever stores the dead spelling;
  // a cause the row's own contract cannot produce falls through to the
  // deterministic hint, which is contract-correct by construction.
  const allowed = causesFor(contract);
  const pick = (v: unknown): Cause | null => {
    if (!isCause(v)) return null;
    const k = canonicalCause(v);
    return isCause(k) && allowed.includes(k) ? k : null;
  };
  const cause: Cause = pick(raw.cause) ?? hints[0] ?? "inconclusive";
  const secondary = Array.isArray(raw.secondary_causes)
    ? [...new Set(raw.secondary_causes.map(pick).filter((c): c is Cause => c !== null && c !== cause))].slice(0, 3)
    : [];
  const ruleRef = (v: unknown): string | null => {
    const id = str(v, 20);
    return id && ruleIds.includes(id) ? id : null;
  };
  return {
    cause,
    secondary_causes: secondary,
    avoidable: raw.avoidable === true,
    confidence: clampInt(raw.confidence, 0, 100, 50),
    verdict_ja: verdictJa || verdictEn,
    verdict_en: verdictEn || verdictJa,
    evidence_ja: strList(raw.evidence_ja),
    evidence_en: strList(raw.evidence_en),
    lesson_ja: lessonJa || lessonEn,
    lesson_en: lessonEn || lessonJa,
    scope: str(raw.scope, 60) || null,
    rule_blamed: ruleRef(raw.rule_blamed),
    rule_credited: ruleRef(raw.rule_credited),
  };
};

// ---------------------------------------------------------------------------
// Consolidation
// ---------------------------------------------------------------------------

export interface LessonRow {
  analysis_id: string;
  user_id?: string | null;
  pair: string;
  cause: string;
  contract: string | null;
  outcome: string;
  interval: string;
  signal: string;
  mode: string | null;
  order_type: string | null;
  lesson_ja: string;
  lesson_en: string;
  confidence: number | null;
  avoidable: boolean | null;
  shadow: boolean;
  scope: string | null;
  // When the review ran
  created_at: string;
  // When the plan was made (what clustering is about)
  plan_created_at: string | null;
  plan_closed_at?: string | null;
  rule_blamed: string | null;
  rule_credited: string | null;
  // Filled in by withClusters
  cluster?: string;
}

export const withClusters = (lessons: LessonRow[]): LessonRow[] => {
  const ids = clusterIds(lessons.map((l) => ({
    pair: l.pair,
    signal: l.signal,
    created_at: l.plan_created_at ?? l.created_at,
    closed_at: l.plan_closed_at ?? null,
  })));
  return lessons.map((l, i) => ({ ...l, cluster: ids[i] }));
};

export const CONSOLIDATION_SCHEMA = {
  type: "object",
  properties: {
    rules: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string", description: "既存ルールを引き継ぐ場合はその id、新規は r + 番号（既存と重複しない）" },
          text_ja: { type: "string", description: "「条件 → 行動」の一般則。100字以内、日本語。個別の価格・日付を含めない" },
          text_en: { type: "string", description: "The same rule in English, 240 characters or fewer" },
          cause: { type: "string", enum: [...CAUSES, "general"] },
          kind: { type: "string", enum: ["constraint", "heuristic"], description: "constraint: 見送る・リスクを絞る歯止め。heuristic: こう取るという指針" },
          scope: { type: ["string", "null"], description: "適用範囲を短く。無ければ null" },
          supported_by: { type: "array", items: { type: "string" }, description: "このルールの根拠となる lessons の analysis_id（そのルールの cause と同じ原因の lesson に限る）" },
        },
        required: ["id", "text_ja", "text_en", "cause", "kind", "scope", "supported_by"],
        additionalProperties: false,
      },
    },
    summary_ja: { type: "string", description: "実績から見た現状の弱点と、今回の改訂内容。日本語、200字以内" },
    summary_en: { type: "string", description: "The same summary in English, 480 characters or fewer" },
  },
  required: ["rules", "summary_ja", "summary_en"],
  additionalProperties: false,
};

// Causes that a "don't trade / cut the risk" rule may draw on beyond its own.
// Canonical spellings only — citationAllowed canonicalises both operands
// before testing, so "entry_too_early" is covered by "chased_move".
// Declared ABOVE CONSOLIDATION_SYSTEM_PROMPT because that template
// interpolates both lists and is evaluated at module load: moving either back
// below it is a ReferenceError that takes down the whole function.
export const CONSTRAINT_CAUSES: readonly string[] = ["lucky_win", "direction_wrong", "regime_misread", "news_shock", "chased_move"];
// Lessons that are about nothing in particular are evidence for nothing
export const UNCITABLE_CAUSES: readonly string[] = ["inconclusive", "plan_incoherent", "good_call"];

// Vocabulary that names WHERE or WHEN to enter.
//
// Under market_v1 the server fills at the price of the moment; the analyst
// chooses direction, stop width, target width, and whether to trade at all.
// A rule whose text is ABOUT the entry price is unfollowable there whichever
// way it points — "wait for a pullback" and "do not wait for a pullback" are
// both instructions about a lever that does not exist, and the live rule r1
// was the second kind. So the test is topical, not directional: naming the
// lever is the defect.
//
// Matched on the VERB, never on the noun. An earlier draft listed
// 「エントリー価格」/"entry price", which reads as decisive until you notice
// that analyze's own market_v1 prompt says 「損切りと利確1/2/3を、与えられた
// エントリー価格の周りに決める」: under this contract the entry price is the
// house term for the GIVEN fill, the reference point every stop and target is
// measured from. A rule saying "place the stop at least 0.8xATR from the entry
// price" moves a lever the analyst really does have, and vetoing it would hold
// back the most followable rule the editor can write. Naming the price is
// required; choosing it is what does not exist.
//
// A floor, not a ceiling: it catches the vocabulary, not every paraphrase.
// The ceiling is one model call per REVISION (not per plan) asking of each
// emitted rule whether it moves one of the four levers. Until that exists this
// list is the floor, and the invariant test in src/test/postmortem.test.ts is
// what keeps the floor from eroding.
const ENTRY_LEVER_PHRASES: readonly string[] = [
  // ja — each names the act of choosing or timing the entry, not the price it
  // is measured from
  "押し目を待",
  "押し目まで待",
  "戻りを待",
  "戻りまで待",
  "戻り待ち",
  "指値で入",
  "指値でエントリー",
  "エントリーを引きつけ",
  "エントリーを引き付け",
  "引きつけて入",
  "引き付けて入",
  "成行で執行",
  "現値で執行",
  "どこで入る",
  // en — matched lower-cased
  "wait for a pullback",
  "wait for the pullback",
  "wait for a retrace",
  "wait for the retrace",
  "limit entry",
  "limit order",
  "where to enter",
  "enter at market",
  "market entry",
];

// Does this rule's text instruct a move the contract does not have?
export const unfollowableUnder = (text: string, contract: string | null): boolean => {
  if (contract !== MARKET_CONTRACT) return false;
  const hay = text.toLowerCase();
  return ENTRY_LEVER_PHRASES.some((phrase) => hay.includes(phrase));
};

// The only writer of Rule.contract.
//
// It answers the single question its only reader asks (analyze/rules.ts
// `inForce`): can an analyst working under `writingContract` carry this
// instruction out? Not "when was it written", not "where did the evidence come
// from". The two vetoes can only REFUSE a stamp, never grant one, and nothing
// is ever inherited — a rule's stamp is recomputed from its own cause and its
// own text on every parse, by both the emit path and the restore path.
//
// That is the whole fix: the field used to be handed the running build's
// PLAN_CONTRACT, so it recorded which era was current when the editor happened
// to run. Four rules learned entirely from entry_chosen_v1 evidence were
// stamped market_v1 that way, and one of them taught the analyst where to
// enter under a contract that fills at the market.
export const stampFor = (
  rule: { cause: string; text_ja: string; text_en: string },
  writingContract: string | null,
): string | null => {
  if (writingContract === null) return null;
  if (causeOutsideContract(rule.cause, writingContract)) return null;
  if (unfollowableUnder(rule.text_ja, writingContract)) return null;
  if (unfollowableUnder(rule.text_en, writingContract)) return null;
  return writingContract;
};

export const CONSOLIDATION_SYSTEM_PROMPT = `あなたはFX分析AIの「ルールブック」の編集者です。個々のプランの検証結果（lessons）と実績統計（stats）から、次回以降のプラン作成で AI アナリストが従う一般則を最大${MAX_RULES}個にまとめます。ルールブックは AI のシステムプロンプトに、基本手順とリスク規定の後ろに「補助的な指針」として入ります。基本手順（トレンド局面での成行、損切り幅、RR の下限）を上書きすることはできないので、その範囲内で書きます。

証拠の数え方:
- 証拠の単位は「独立クラスタ」。同じ通貨ペア・同じ方向で近い時間に作られたプランは同じ局面についての同じ判断であり、lessons が何件あっても証拠としては1件。各 lesson には cluster が付いている。stats.by_cause_clusters が原因別のクラスタ数。
- 各ルールには supported_by として根拠の lesson の analysis_id を列挙する。数えられるのは、そのルールの cause と同じ原因の lesson（cause が general のルールは、${UNCITABLE_CAUSES.join(" / ")} 以外のどの原因でも可。constraint のルールは ${CONSTRAINT_CAUSES.join(" / ")} も可）だけで、shadow の lesson は数えない。実績件数（support）はサーバーがその条件で独立クラスタ数を数える。無関係な lesson を引用しても数えられず、根拠が1件も残らないルールは削除される。
- stats.win_rate / fill_rate は決着数が ${MIN_STAT_N} 未満のとき null。null や小さい n の統計を根拠にルールを強めない。stats.win_rate_ci95 は勝率の95%信頼区間。
- stats は stats.contract のエントリー契約で作られたプランだけを集計している。別の契約のプランは stats.other_contract_rows として件数だけ数え、勝率にも件数にも入れていない。契約をまたいだ比較はできない。
- 勝率の分母は stats.decided（WIN + LOSS + 期限切れ）。期限切れは「届かない利確を置いた」結果であり、勝率から外れる逃げ道にはならない。
- 見送り（WAIT）も採点される。stats.waits_missed は「見送った後、このアプリ自身が許す最小のトレード（損切り ATR${MIN_STOP_ATR}倍・RR ${MIN_RISK_REWARD}）なら勝っていた」局面の数、stats.wait_miss_rate はその割合。これが実績の中で唯一「慎重すぎた」ことを示す証拠なので、見送りを増やすルールを足すときは必ずこの数字を見る。損失を減らすルールばかりを積むと、この数字だけが増えていく。
- 各 lesson には contract（作られた時のエントリー契約）が付いている。別の契約の lesson は「同じ状況がまた起きる」証拠としては使えるが、その remedy が今は存在しない操作（押し目待ち・指値）を指している場合があるので、ルールの文言はそのまま写さない。stats.lessons_by_contract が契約別の件数。
- entry_too_far / entry_too_early は旧契約の語彙。entry_too_early は chased_move として集計されている。
- current_rules の各ルールには contract（実行できる契約）・evidence_contracts（根拠 lesson の契約）・in_force（現行契約 ${MARKET_CONTRACT} のプロンプトに実際に入っているか）が付いている。in_force が false のルールはアナリストのプロンプトに入っていない。原因が現行契約では起こりえないか、文言が「押し目を待つ・指値で入る・どこで入るか」というアナリストが動かせない対象を指しているためで、同じ文言のまま出し直しても false のままになる。残す価値があるなら方向・損切り幅・利確幅・見送りの4つのどれかを動かす形に書き直し、書き直せないなら出力から外す。
- evidence_contracts が現行契約以外だけのルールは、根拠が旧契約の記録しかない。使ってよいが、プロンプトには「旧契約含む」と表示され、証拠としては弱い。
- stats.by_rulebook_version は「その版のもとで作られたプラン全体」の実績（決着数・勝敗・実現R合計 sum_r）。版の比較（ルールを足す前と後）には使えるが、版の中のどのルールのせいかは区別できない。個別ルールの証拠は stats.rule_feedback（診断がそのルールを結果の原因 blamed / 貢献 credited と名指しした回数）と、lessons の rule_blamed / rule_credited。blamed が credited を上回るルールは弱めるか削除する。
- 対称性: untriggered の lesson は「約定を妨げた」側、loss の lesson は「損を招いた」側の証拠。片方だけを見ない。反実仮想の「成行なら勝っていた」は viable=true の案だけが根拠になる（lesson 側で考慮済み）。

ルールの書き方:
- kind: "constraint" は「見送る・リスクを絞る」側の歯止め、"heuristic" は「こう取る」側の指針。執行を促すルールが増えるほど、歯止めのルールも必要になる。
- 条件は指標由来の観測量（ADX、ATR、SMA20/50の並び、上位足との整合、RSI、直近の値幅）に限る。アナリスト自身の自己申告値（confidence、mode の宣言、direction）を条件にしない。
- 「条件 → 行動」の形、100字以内。個別の価格・日付・銘柄固有の出来事は書かない。
- アナリストが実際に出力できる形式に限る。プランはエントリー1つ・損切り1つ・利確3つで、分割エントリー・ナンピン・両建て・トレーリングストップは表現できない。
- ゲートとの整合: 現行契約（market_v1）では、エントリー価格はアナリストが選ばない。分析した瞬間の現在値がそのまま成行の約定価格になる。したがって「押し目を待つ」「浅い指値で入る」「エントリーを引きつける」形のルールは実行できないので書かない。アナリストが決められるのは方向・損切り幅・利確幅と、そもそも入るかどうか（WAIT）の4つだけであり、ルールもその4つのいずれかを動かす形にする。損切り幅は ATR${MIN_STOP_ATR}倍以上、RR は ${MIN_RISK_REWARD} 以上をサーバーが強制する。トレンド局面（ADX ${TREND_ADX} 以上で SMA が方向に並ぶ）の判定は、入るか見送るかの条件としてのみ使う。
- 同じ趣旨のルールは1つに統合する。
- id は既存ルールを引き継ぐ場合そのまま、新規は "r" + 通し番号（既存と重複しない）。既存ルールを別の id で書き直さない。

改訂の制限:
- 1回の改訂で追加は最大${MAX_RULES_ADDED}本、削除は最大${MAX_RULES_REMOVED}本（サーバー側でも強制される）。既存ルールの文言変更は、新しい lessons の裏付けがあるときだけ。
- 並び順: constraint を先に、次に根拠の強い順。`;

export const buildConsolidationPrompt = (
  rules: Rule[],
  lessons: LessonRow[],
  stats: RecordStats,
): { system: string; user: string } => {
  const payload = {
    // contract / evidence_contracts / in_force are shown because without them
    // the editor cannot tell a suppressed rule from a live one, and re-emitting
    // a held-back rule verbatim forever is its path of least resistance.
    current_rules: rules.map((r) => ({
      id: r.id, kind: r.kind, text_ja: r.text_ja, text_en: r.text_en, cause: r.cause,
      support: r.support, supported_by: r.supported_by, scope: r.scope, since: r.since,
      contract: r.contract,
      evidence_contracts: r.evidence_contracts,
      in_force: r.contract === MARKET_CONTRACT,
    })),
    lessons: lessons.map((l) => ({
      analysis_id: l.analysis_id,
      cluster: l.cluster ?? null,
      plan_created_at: l.plan_created_at ?? l.created_at,
      pair: l.pair,
      interval: l.interval,
      signal: l.signal,
      order_type: l.order_type,
      outcome: l.outcome,
      cause: l.cause,
      contract: l.contract,
      shadow: l.shadow,
      confidence: l.confidence,
      avoidable: l.avoidable,
      scope: l.scope,
      rule_blamed: l.rule_blamed,
      rule_credited: l.rule_credited,
      lesson_ja: l.lesson_ja,
      lesson_en: l.lesson_en,
    })),
    stats,
  };
  const user = [
    "現在のルールブック、検証結果の一覧、実績統計は次のとおりです。改訂後のルールブック全体を出力してください。",
    "",
    JSON.stringify(payload),
  ].join("\n");
  return { system: CONSOLIDATION_SYSTEM_PROMPT, user };
};

export interface Consolidation {
  rules: Rule[];
  summary_ja: string;
  summary_en: string;
  // held_back: rules that ARE in the book but which stampFor refused a stamp,
  // so no prompt will show them. Recorded because a rule that silently never
  // reaches the analyst is the failure mode this whole field exists to make
  // visible.
  //
  // reworded: rules kept under their own id whose text or cause the editor
  // changed. Not an addition and not a removal, so before this field a
  // rewrite left `changes` completely empty — a version bump whose diff said
  // nothing, while the sentence the analyst follows had been replaced and its
  // `since` still claimed the older date.
  changes: { added: string[]; removed: string[]; restored: string[]; dropped: string[]; held_back: string[]; reworded: string[] };
}

export interface CitableLesson {
  analysis_id: string;
  cluster?: string | null;
  cause?: string;
  shadow?: boolean;
  // The era of the plan this lesson came from. NOT a citation gate: a failure
  // observed under the old contract is still evidence that the same situation
  // recurs. Read only to fill Rule.evidence_contracts, which labels a rule
  // rather than suppressing it.
  contract?: string | null;
}

// Whether a lesson is evidence for a rule: same failure, or a general rule
// (any real failure), or a constraint drawing on the risk causes. Never a
// shadow plan's lesson — those are about the gate, not the analyzer.
export const citationAllowed = (rule: { cause: string; kind: RuleKind }, lesson: CitableLesson): boolean => {
  if (lesson.shadow) return false;
  const cause = canonicalCause(lesson.cause ?? "");
  if (!cause || UNCITABLE_CAUSES.includes(cause)) return false;
  if (canonicalCause(rule.cause) === cause) return true;
  if (rule.cause === "general") return true;
  if (rule.kind === "constraint" && CONSTRAINT_CAUSES.includes(cause)) return true;
  return false;
};

// The model's rewrite, checked against what it was given: every cited
// lesson must exist and be about the rule's failure, support is counted from
// those citations by cluster, a rule left with no evidence is dropped, and
// a revision may not add or drop more than a couple of rules — the surplus
// additions are dropped and the surplus removals put back (with their
// support recounted the same way), weakest rules going first.
export const parseConsolidation = (
  raw: unknown,
  previous: Rule[],
  nowIso: string,
  lessons: CitableLesson[] = [],
  // The contract the emitted rules are TESTED against — the question, not the
  // answer. Whether any given rule receives it is decided by stampFor, from
  // that rule's own cause and its own text. Passing PLAN_CONTRACT here no
  // longer means "stamp everything with today's build".
  writingContract: string | null = null,
): Consolidation | null => {
  if (!isRecord(raw) || !Array.isArray(raw.rules)) return null;
  const prior = new Map(previous.map((r) => [r.id, r]));
  const byId = new Map(lessons.map((l) => [l.analysis_id, l]));
  const evidence = (
    rule: { cause: string; kind: RuleKind },
    ids: string[],
  ): { cited: string[]; support: number; eras: string[] } => {
    const cited = [...new Set(ids.filter((id) => {
      const lesson = byId.get(id);
      return lesson !== undefined && citationAllowed(rule, lesson);
    }))];
    const clusters = new Set(cited.map((id) => byId.get(id)?.cluster ?? id));
    // Eras of the citations that actually COUNTED. A lesson the gate rejected
    // must not leak its era into the label, or a rule would be marked as
    // resting on evidence it is not allowed to rest on. A lesson with no
    // recorded contract predates the column and is legacy by definition, the
    // same convention summarizeRecord uses.
    const eras = [...new Set(cited.map((id) => byId.get(id)?.contract || LEGACY_PLAN_CONTRACT))].sort();
    return { cited, support: clusters.size, eras };
  };
  const seen = new Set<string>();
  const rules: Rule[] = [];
  const added: string[] = [];
  const dropped: string[] = [];
  const reworded: string[] = [];
  for (const item of raw.rules) {
    if (!isRecord(item)) continue;
    const textJa = str(item.text_ja, MAX_RULE_CHARS);
    const textEn = str(item.text_en, MAX_RULE_CHARS_EN);
    if (!textJa && !textEn) continue;
    let id = str(item.id, 20);
    if (!id) {
      // A made-up id must not land on an existing rule and take it over
      id = `r${rules.length + 1}`;
      while (prior.has(id) || seen.has(id)) id = `${id}_`;
    }
    while (seen.has(id)) id = `${id}_`;
    const isNew = !prior.has(id);
    if (isNew && previous.length > 0 && added.length >= MAX_RULES_ADDED) {
      dropped.push(id);
      continue;
    }
    const cause = typeof item.cause === "string" && (isCause(item.cause) || item.cause === "general")
      ? canonicalCause(item.cause)
      : "general";
    const kind: RuleKind = isRuleKind(item.kind) ? item.kind : prior.get(id)?.kind ?? "heuristic";
    const citedIds = Array.isArray(item.supported_by) ? item.supported_by.filter((v): v is string => typeof v === "string") : [];
    const { cited, support, eras } = evidence({ cause, kind }, citedIds);
    if (support === 0) {
      // No evidence, no rule: a continuing rule that lost its evidence goes
      // through the removal accounting below like any other omission
      dropped.push(id);
      continue;
    }
    // The book is full. Recorded as dropped rather than breaking out of the
    // loop, so a rule squeezed out of the book leaves a trace instead of
    // vanishing from `changes` entirely.
    if (rules.length >= MAX_RULES) {
      dropped.push(id);
      continue;
    }
    seen.add(id);
    if (isNew) added.push(id);
    const textJaFinal = textJa || textEn;
    const textEnFinal = textEn || textJa;
    // A rule kept under an existing id is a continuation: it keeps its `since`
    // and does not spend the addition allowance. That is right for a rule the
    // editor refined, and it is also what happens when the editor rewrites the
    // sentence into something else entirely, so the change is recorded rather
    // than inferred from a diff nobody stores. The cause counts too: it decides
    // which lessons may cite the rule, so moving it moves the rule's evidence.
    // Compared trimmed on both sides: a rule stored before str() trimmed after
    // the cut can carry a trailing space that no reader would call a change.
    const before = prior.get(id);
    const same = (a: string, b: string) => a.trim() === b.trim();
    if (before && (!same(before.text_ja, textJaFinal) || !same(before.text_en, textEnFinal) || before.cause !== cause)) {
      reworded.push(id);
    }
    rules.push({
      id,
      text_ja: textJaFinal,
      text_en: textEnFinal,
      cause,
      support,
      scope: str(item.scope, 60) || null,
      since: prior.get(id)?.since ?? nowIso,
      contract: stampFor({ cause, text_ja: textJaFinal, text_en: textEnFinal }, writingContract),
      evidence_contracts: eras,
      kind,
      supported_by: cited,
    });
  }

  // Omitted (or evidence-less) prior rules: the allowance is spent on the
  // weakest; the rest come back with their evidence recounted, and those
  // whose evidence no longer holds up go too
  const missing = previous.filter((p) => !seen.has(p.id)).sort((a, b) => a.support - b.support);
  const removed = missing.slice(0, MAX_RULES_REMOVED).map((r) => r.id);
  const restored: string[] = [];
  for (const rule of missing.slice(MAX_RULES_REMOVED).sort((a, b) => b.support - a.support)) {
    if (rules.length >= MAX_RULES) {
      // No room left: it leaves the book, and says so.
      removed.push(rule.id);
      continue;
    }
    const { cited, support, eras } = evidence(rule, rule.supported_by);
    if (support === 0) {
      removed.push(rule.id);
      continue;
    }
    // The stamp is re-derived here too, from the STORED rule's own cause and
    // text. A restored rule must not carry a stamp forward: inheriting it is
    // what let a rule keep an endorsement that only ever existed because a
    // defective build wrote it.
    rules.push({
      ...rule,
      support,
      supported_by: cited,
      evidence_contracts: eras,
      contract: stampFor(rule, writingContract),
    });
    restored.push(rule.id);
  }
  if (rules.length === 0) return null;

  // With writingContract null every stamp is null and this is empty, which is
  // the right answer: a caller that named no contract asked no question.
  const held_back = writingContract === null ? [] : rules.filter((r) => r.contract !== writingContract).map((r) => r.id);

  return {
    rules: orderRules(rules),
    summary_ja: str(raw.summary_ja, MAX_SUMMARY_CHARS),
    summary_en: str(raw.summary_en, MAX_SUMMARY_CHARS_EN),
    changes: { added, removed, restored, dropped, held_back, reworded },
  };
};

// Whether the rulebook is due for a rewrite: enough new lessons since the
// last version, or a day with at least one. Any single lesson used to
// rewrite the whole book, which meant no version ever lasted long enough for
// its plans to settle.
export const MIN_NEW_LESSONS = 5;
export const MIN_REVISION_INTERVAL_MS = 24 * 60 * 60 * 1000;

export const revisionDue = (
  newLessonsSinceVersion: number,
  lastUpdatedIso: string | null,
  nowMs: number,
): boolean => {
  if (newLessonsSinceVersion <= 0) return false;
  if (!lastUpdatedIso) return true;
  const last = Date.parse(lastUpdatedIso);
  if (!Number.isFinite(last)) return true;
  if (newLessonsSinceVersion >= MIN_NEW_LESSONS) return true;
  return nowMs - last >= MIN_REVISION_INTERVAL_MS;
};
