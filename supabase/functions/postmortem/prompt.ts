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

import { CAUSES, PULLBACK_R, isCause, type Cause, type PostmortemFacts } from "./facts.ts";
import { MIN_RISK_REWARD, MIN_STOP_ATR, TREND_ADX } from "../analyze/entry.ts";
import { isRuleKind, orderRules, type Rule, type RuleKind } from "../analyze/rules.ts";

export const MAX_RULES = 10;
export const MAX_LESSON_CHARS = 160;
export const MAX_RULE_CHARS = 160;
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

const str = (v: unknown, max = 400): string => (typeof v === "string" ? v.trim().slice(0, max) : "");

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
  user_id?: string | null;
}

// Cluster ids for a set of plans, in input order. A plan joins the cluster
// of the previous plan on the same pair, direction (and user) when it was
// made within CLUSTER_WINDOW_MS of it, unless that plan had settled more
// than CLUSTER_REOPEN_MS earlier.
export const clusterIds = (items: Clusterable[]): string[] => {
  const order = items
    .map((item, i) => ({ i, t: Date.parse(item.created_at) }))
    .sort((a, b) => (Number.isFinite(a.t) ? a.t : 0) - (Number.isFinite(b.t) ? b.t : 0));
  const last = new Map<string, { id: string; t: number; closed: number }>();
  const out = new Array<string>(items.length);
  for (const { i, t } of order) {
    const item = items[i];
    const key = `${item.user_id ?? ""}|${item.pair}|${item.signal}`;
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
export const LEGACY_CONTRACT = "entry_chosen_v1";

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
    by_cause: {}, by_cause_clusters: {}, shadow_by_cause: {}, by_rulebook_version: {}, rule_feedback: {},
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
    if (l.shadow) {
      s.shadow_by_cause[l.cause] = (s.shadow_by_cause[l.cause] ?? 0) + 1;
      return;
    }
    s.by_cause[l.cause] = (s.by_cause[l.cause] ?? 0) + 1;
    const set = causeClusters.get(l.cause) ?? new Set<string>();
    set.add(l.cluster ?? `lesson-${i}`);
    causeClusters.set(l.cause, set);
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

export const DIAGNOSIS_SCHEMA = {
  type: "object",
  properties: {
    cause: { type: "string", enum: [...CAUSES] },
    secondary_causes: { type: "array", items: { type: "string", enum: [...CAUSES] } },
    avoidable: { type: "boolean", description: "分析時点の情報だけで回避できたか" },
    confidence: { type: "integer", description: "診断の確からしさ 0-100" },
    verdict_ja: { type: "string", description: "何が起きたかの結論。日本語、120字以内" },
    verdict_en: { type: "string", description: "The same conclusion in English, one or two sentences" },
    evidence_ja: { type: "array", items: { type: "string" }, description: "根拠 2-4 点。facts の数値を引用する。日本語" },
    evidence_en: { type: "array", items: { type: "string" }, description: "The same evidence in English" },
    lesson_ja: { type: "string", description: "次回に使う一般則。「条件 → 行動」の形、90字以内、日本語。個別の価格・日付を含めない" },
    lesson_en: { type: "string", description: "The same lesson in English" },
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
};

export const DIAGNOSIS_SYSTEM_PROMPT = `あなたはFXトレードの検証担当（ポストモーテム）です。AIアナリストが出したトレードプランと、その後の実際の値動きから計算した事実（facts）を突き合わせ、なぜその予想が外れた（または当たった）のかを厳密に診断します。

原則:
- 根拠にしてよいのは facts と plan に書かれていることだけ。事実に無い出来事（ニュース等）を推測で作らない。ニュース要因（news_shock）は、plan の warnings/key_factors に指標やイベントへの言及があり、かつ facts.abnormal_bar が観測された場合に限る。
- 次の順に検討する: (1) 方向は合っていたか (2) エントリーは約定したか、しなかったなら値幅を逃したか、したなら入るのが早すぎなかったか (3) 損切り幅は適切だったか (4) 利確は届く距離だったか (5) 相場環境（トレンド/レンジ）の読みは正しかったか。
- facts.counterfactual は原因の切り分けに使う最重要の証拠。market_entry（成行で入っていたら）、market_entry_same_risk（成行で入り損切り幅を元のプランと同じにしていたら）、stop_x1_5 / stop_x2（損切りを広げていたら）、tp_half（利確を半分にしていたら）、limit_pullback（${PULLBACK_R}R の押し目・戻りを待つ指値にしていたら。損切り幅は同じ）。各項目の rr はその案自体のリスクリワード、viable はサーバーのエントリーゲートを通る案かどうか、gate は通らない理由（poor_rr: RR ${MIN_RISK_REWARD} 未満、stop_too_tight: 損切り幅 ATR${MIN_STOP_ATR}倍未満、too_far: 指値が現在値から遠すぎる、should_be_market: トレンド局面ではサーバーが指値を成行に修正する）。viable=false の案は「勝っていた」としても採用できない案なので、それを根拠に「成行にすべきだった」「指値にすべきだった」等の教訓を書かない。limit_pullback の gate が should_be_market / too_far のときは、押し目待ちは公開できないので、lesson は「その条件では見送る（WAIT）」か「成行で追いかけない条件」の形にする。
- facts.hints は決定論的な事前分類で、通常はその中から選ぶ。覆す場合は evidence で理由を示す。facts.notes には判定の補足がある。
- facts.early_adverse_r は約定直後 3 本以内の最大逆行（R、取引中のみ）。成行で入って即座に逆行した場合、追いかけ（entry_too_early）を疑う。
- lesson は「条件 → 行動」の形で、次回以降のプラン作成に直接使える一般則にする。個別の価格・日付・その日固有の出来事は書かない。同じ状況が来たときに何を変えるかを書く。
- lesson の「条件」は指標由来の観測量（ADX、ATR、SMA20/50の並び、上位足との整合、RSI、直近の値幅）で書く。アナリスト自身の自己申告（confidence の高さ、mode の宣言）を条件にしない。
- lesson は、アナリストが実際に出力できる範囲の指示にする。プランは1つのエントリー価格・1つの損切り・3つの利確で構成され、分割エントリー・ナンピン・両建て・トレーリングストップは表現できない。「一部を成行、残りを指値」のような分割指示は書かない。基本手順（損切りの幅、RR の下限）は lesson で上書きできない。その範囲内で書く。
- plan.contract が "market_v1" のプランでは、エントリー価格はアナリストが選んでいない。分析した瞬間の現在値がそのまま成行の約定価格になったものであり、「もっと引きつけて入るべきだった」「押し目を待つべきだった」は実行できない指示なので lesson にしない。動かせるのは方向・損切り幅・利確幅・そもそも入るか（WAIT）の4つだけで、lesson はそのいずれかを動かす形にする。反実仮想の limit_pullback も、この契約のプランでは「その状況では入らない（WAIT）」の根拠としてのみ読む。
- plan.contract が "entry_chosen_v1"（または未記載）の古いプランは、アナリストがエントリー価格を選んでいた時代のもの。当時の事実として検証してよいが、そこから引く lesson は上の4つの範囲に翻訳して書く。
- 勝ちでも、最大逆行が損切り近くまで達した（mae_r ≥ 0.8）等プロセスに危うさがあれば lucky_win とし、教訓を書く。
- plan.rules_in_force があれば、そのプランがどのルールの影響下で作られたかを踏まえ、結果を招いた／貢献したルールがあれば rule_blamed / rule_credited に id を書く。無ければ null。
- confidence は診断の確からしさ。決着後の足が無い、反実仮想が ambiguous 等、事実が少ないときは下げる。
- shadow=true のプランは、サーバー側のエントリーゲートが「約定しない」等の理由で却下したものを検証用に追跡した結果である。却下が正しかったか（未約定なら正しい、勝っていたなら誤り）を verdict に含める。

原因の定義:
- direction_wrong: 方向そのものが逆。約定後に損切りまでほぼ一直線／損切り後も逆行が続いた（after.beyond_sl_r が大きい）／約定前に損切り側へ到達（reason=invalidated）。
- stop_too_tight: 方向は合っていたが損切りが近すぎた。損切り到達後に TP1 へ到達（after.reached_tp1）、または損切りを広げた反実仮想が win。広げた案が viable でない（RR 不足）場合、lesson は「損切りを広げる」だけでなく利確の置き方も併せて書く。
- entry_too_far: 方向は合っていたがエントリーが約定しなかった。成行の反実仮想（market_entry または market_entry_same_risk）が viable かつ win。
- entry_too_early: 方向は合っていたが成行で追いかけて即座の逆行で損切り。early_adverse_r が大きく、limit_pullback が win（rr と損切り幅は成立）。
- target_too_far: 約定して順行したが TP1 に届かず反転。利確を半分にした反実仮想が win、mfe_r が大きい。
- regime_misread: トレンド/レンジの読み違い。facts.regime.conflict、レンジ相場でのトレンドフォロー等。
- news_shock: 指標・イベントの異常な値幅でプランが無効化された。facts.abnormal_bar.event があれば、その足で実際に発表された経済指標なので、推測ではなく事実として名指ししてよい。event が null の異常足は「原因不明の急変動」であって、指標のせいだと断定しない。
- plan_incoherent: 水準の矛盾で判定不能。
- good_call: 想定通りに勝った。
- lucky_win: 勝ったがプロセスに問題があった。
- inconclusive: 事実が足りず断定できない。`;

const compactAnalysis = (text: string, max = 1400): string =>
  text.length <= max ? text : `${text.slice(0, max)}…（以下省略）`;

export const buildDiagnosisPrompt = (plan: PlanSummary, facts: PostmortemFacts): { system: string; user: string } => {
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
  return { system: DIAGNOSIS_SYSTEM_PROMPT, user };
};

// A malformed answer is not stored. The cause must be one of ours; when the
// model's pick is not, the deterministic hint stands.
export const parseDiagnosis = (raw: unknown, hints: Cause[], ruleIds: string[] = []): Diagnosis | null => {
  if (!isRecord(raw)) return null;
  const lessonJa = str(raw.lesson_ja, MAX_LESSON_CHARS);
  const lessonEn = str(raw.lesson_en, MAX_LESSON_CHARS);
  const verdictJa = str(raw.verdict_ja);
  const verdictEn = str(raw.verdict_en);
  if (!lessonJa && !lessonEn) return null;
  if (!verdictJa && !verdictEn) return null;
  const cause: Cause = isCause(raw.cause) ? raw.cause : hints[0] ?? "inconclusive";
  const secondary = Array.isArray(raw.secondary_causes)
    ? raw.secondary_causes.filter((c): c is Cause => isCause(c) && c !== cause).slice(0, 3)
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
    user_id: l.user_id ?? null,
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
          text_en: { type: "string", description: "The same rule in English" },
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
    summary_en: { type: "string", description: "The same summary in English" },
  },
  required: ["rules", "summary_ja", "summary_en"],
  additionalProperties: false,
};

export const CONSOLIDATION_SYSTEM_PROMPT = `あなたはFX分析AIの「ルールブック」の編集者です。個々のプランの検証結果（lessons）と実績統計（stats）から、次回以降のプラン作成で AI アナリストが従う一般則を最大${MAX_RULES}個にまとめます。ルールブックは AI のシステムプロンプトに、基本手順とリスク規定の後ろに「補助的な指針」として入ります。基本手順（トレンド局面での成行、損切り幅、RR の下限）を上書きすることはできないので、その範囲内で書きます。

証拠の数え方:
- 証拠の単位は「独立クラスタ」。同じ通貨ペア・同じ方向で近い時間に作られたプランは同じ局面についての同じ判断であり、lessons が何件あっても証拠としては1件。各 lesson には cluster が付いている。stats.by_cause_clusters が原因別のクラスタ数。
- 各ルールには supported_by として根拠の lesson の analysis_id を列挙する。数えられるのは、そのルールの cause と同じ原因の lesson（cause が general のルールは、inconclusive / plan_incoherent / good_call 以外のどの原因でも可。constraint のルールは lucky_win / direction_wrong / regime_misread / news_shock / entry_too_early も可）だけで、shadow の lesson は数えない。実績件数（support）はサーバーがその条件で独立クラスタ数を数える。無関係な lesson を引用しても数えられず、根拠が1件も残らないルールは削除される。
- stats.win_rate / fill_rate は決着数が ${MIN_STAT_N} 未満のとき null。null や小さい n の統計を根拠にルールを強めない。stats.win_rate_ci95 は勝率の95%信頼区間。
- stats は stats.contract のエントリー契約で作られたプランだけを集計している。別の契約のプランは stats.other_contract_rows として件数だけ数え、勝率にも件数にも入れていない。契約をまたいだ比較はできない。
- 勝率の分母は stats.decided（WIN + LOSS + 期限切れ）。期限切れは「届かない利確を置いた」結果であり、勝率から外れる逃げ道にはならない。
- 見送り（WAIT）も採点される。stats.waits_missed は「見送った後、このアプリ自身が許す最小のトレード（損切り ATR${MIN_STOP_ATR}倍・RR ${MIN_RISK_REWARD}）なら勝っていた」局面の数、stats.wait_miss_rate はその割合。これが実績の中で唯一「慎重すぎた」ことを示す証拠なので、見送りを増やすルールを足すときは必ずこの数字を見る。損失を減らすルールばかりを積むと、この数字だけが増えていく。
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
    current_rules: rules.map((r) => ({
      id: r.id, kind: r.kind, text_ja: r.text_ja, text_en: r.text_en, cause: r.cause,
      support: r.support, supported_by: r.supported_by, scope: r.scope, since: r.since,
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
  changes: { added: string[]; removed: string[]; restored: string[]; dropped: string[] };
}

export interface CitableLesson {
  analysis_id: string;
  cluster?: string | null;
  cause?: string;
  shadow?: boolean;
}

// Causes that a "don't trade / cut the risk" rule may draw on beyond its own
const CONSTRAINT_CAUSES: readonly string[] = ["lucky_win", "direction_wrong", "regime_misread", "news_shock", "entry_too_early"];
// Lessons that are about nothing in particular are evidence for nothing
const UNCITABLE_CAUSES: readonly string[] = ["inconclusive", "plan_incoherent", "good_call"];

// Whether a lesson is evidence for a rule: same failure, or a general rule
// (any real failure), or a constraint drawing on the risk causes. Never a
// shadow plan's lesson — those are about the gate, not the analyzer.
export const citationAllowed = (rule: { cause: string; kind: RuleKind }, lesson: CitableLesson): boolean => {
  if (lesson.shadow) return false;
  const cause = lesson.cause ?? "";
  if (!cause || UNCITABLE_CAUSES.includes(cause)) return false;
  if (rule.cause === cause) return true;
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
): Consolidation | null => {
  if (!isRecord(raw) || !Array.isArray(raw.rules)) return null;
  const prior = new Map(previous.map((r) => [r.id, r]));
  const byId = new Map(lessons.map((l) => [l.analysis_id, l]));
  const evidence = (rule: { cause: string; kind: RuleKind }, ids: string[]): { cited: string[]; support: number } => {
    const cited = [...new Set(ids.filter((id) => {
      const lesson = byId.get(id);
      return lesson !== undefined && citationAllowed(rule, lesson);
    }))];
    const clusters = new Set(cited.map((id) => byId.get(id)?.cluster ?? id));
    return { cited, support: clusters.size };
  };
  const seen = new Set<string>();
  const rules: Rule[] = [];
  const added: string[] = [];
  const dropped: string[] = [];
  for (const item of raw.rules) {
    if (!isRecord(item)) continue;
    const textJa = str(item.text_ja, MAX_RULE_CHARS);
    const textEn = str(item.text_en, MAX_RULE_CHARS);
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
    const cause = typeof item.cause === "string" && (isCause(item.cause) || item.cause === "general") ? item.cause : "general";
    const kind: RuleKind = isRuleKind(item.kind) ? item.kind : prior.get(id)?.kind ?? "heuristic";
    const citedIds = Array.isArray(item.supported_by) ? item.supported_by.filter((v): v is string => typeof v === "string") : [];
    const { cited, support } = evidence({ cause, kind }, citedIds);
    if (support === 0) {
      // No evidence, no rule: a continuing rule that lost its evidence goes
      // through the removal accounting below like any other omission
      dropped.push(id);
      continue;
    }
    seen.add(id);
    if (isNew) added.push(id);
    rules.push({
      id,
      text_ja: textJa || textEn,
      text_en: textEn || textJa,
      cause,
      support,
      scope: str(item.scope, 60) || null,
      since: prior.get(id)?.since ?? nowIso,
      kind,
      supported_by: cited,
    });
    if (rules.length >= MAX_RULES) break;
  }

  // Omitted (or evidence-less) prior rules: the allowance is spent on the
  // weakest; the rest come back with their evidence recounted, and those
  // whose evidence no longer holds up go too
  const missing = previous.filter((p) => !seen.has(p.id)).sort((a, b) => a.support - b.support);
  const removed = missing.slice(0, MAX_RULES_REMOVED).map((r) => r.id);
  const restored: string[] = [];
  for (const rule of missing.slice(MAX_RULES_REMOVED).sort((a, b) => b.support - a.support)) {
    if (rules.length >= MAX_RULES) break;
    const { cited, support } = evidence(rule, rule.supported_by);
    if (support === 0) {
      removed.push(rule.id);
      continue;
    }
    rules.push({ ...rule, support, supported_by: cited });
    restored.push(rule.id);
  }
  if (rules.length === 0) return null;

  return {
    rules: orderRules(rules),
    summary_ja: str(raw.summary_ja, 600),
    summary_en: str(raw.summary_en, 600),
    changes: { added, removed, restored, dropped },
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
