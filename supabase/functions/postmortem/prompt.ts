// Prompts and response contracts for the post-mortem model calls.
//
// Two calls. The diagnosis reads one plan and its facts and names a cause
// and a lesson; the consolidation reads every lesson and the record and
// rewrites the rulebook. Both use structured outputs, and both are parsed
// back defensively — a malformed answer becomes "no diagnosis", never a
// stored one.
//
// Deno-free on purpose: src/test/postmortem.test.ts imports this file
// directly.

import { CAUSES, isCause, type Cause, type PostmortemFacts } from "./facts.ts";
import type { Rule } from "../analyze/rules.ts";

export const MAX_RULES = 10;
export const MAX_LESSON_CHARS = 160;
export const MAX_RULE_CHARS = 160;

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
  // A plan the entry gate refused, tracked to check the refusal
  shadow: boolean;
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
  },
  required: [
    "cause", "secondary_causes", "avoidable", "confidence",
    "verdict_ja", "verdict_en", "evidence_ja", "evidence_en",
    "lesson_ja", "lesson_en", "scope",
  ],
  additionalProperties: false,
};

export const DIAGNOSIS_SYSTEM_PROMPT = `あなたはFXトレードの検証担当（ポストモーテム）です。AIアナリストが出したトレードプランと、その後の実際の値動きから計算した事実（facts）を突き合わせ、なぜその予想が外れた（または当たった）のかを厳密に診断します。

原則:
- 根拠にしてよいのは facts と plan に書かれていることだけ。事実に無い出来事（ニュース等）を推測で作らない。ニュース要因（news_shock）は、plan の warnings/key_factors に指標やイベントへの言及があり、かつ facts.abnormal_bar が観測された場合に限る。
- 次の順に検討する: (1) 方向は合っていたか (2) エントリーは約定したか、しなかったなら値幅を逃したか (3) 損切り幅は適切だったか (4) 利確は届く距離だったか (5) 相場環境（トレンド/レンジ）の読みは正しかったか。
- facts.counterfactual（成行で入っていた場合／損切りを1.5倍・2倍に広げた場合／利確を半分にした場合の判定結果）は原因の切り分けに使う最重要の証拠。facts.hints は決定論的な事前分類で、通常はその中から選ぶ。覆す場合は evidence で理由を示す。
- lesson は「条件 → 行動」の形で、次回以降のプラン作成に直接使える一般則にする。個別の価格・日付・その日固有の出来事は書かない。同じ状況が来たときに何を変えるかを書く。
- lesson は、アナリストが実際に出力できる範囲の指示にする。プランは1つのエントリー価格・1つの損切り・3つの利確で構成され、分割エントリー・ナンピン・両建て・トレーリングストップは表現できない。「一部を成行、残りを指値」のような分割指示は書かず、「エントリーを現在値の成行にする」「指値を現在値からATR0.5倍以内に置く」のように単一のエントリーで実行できる形にする。
- 勝ちでも、最大逆行が損切り近くまで達した（mae_r ≥ 0.8）等プロセスに危うさがあれば lucky_win とし、教訓を書く。
- confidence は診断の確からしさ。決着後の足が無い、反実仮想が ambiguous 等、事実が少ないときは下げる。
- shadow=true のプランは、サーバー側のエントリーゲートが「約定しない」等の理由で却下したものを検証用に追跡した結果である。却下が正しかったか（未約定なら正しい、勝っていたなら誤り）を verdict に含める。

原因の定義:
- direction_wrong: 方向そのものが逆。約定後に損切りまでほぼ一直線／損切り後も逆行が続いた（after.beyond_sl_r が大きい）／約定前に損切り側へ到達（reason=invalidated）。
- stop_too_tight: 方向は合っていたが損切りが近すぎた。損切り到達後に TP1 へ到達（after.reached_tp1）、または損切りを広げた反実仮想が win。
- entry_too_far: 方向は合っていたがエントリーが約定しなかった。成行の反実仮想が win、または from_signal.max_favorable_r が大きい。
- target_too_far: 約定して順行したが TP1 に届かず反転。利確を半分にした反実仮想が win、mfe_r が大きい。
- regime_misread: トレンド/レンジの読み違い。facts.regime.conflict、レンジ相場でのトレンドフォロー等。
- news_shock: 指標・イベントの異常な値幅でプランが無効化された。
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
    "次のトレードプランを検証してください。plan は AI が出したプラン（と、その時点で見ていた指標 context）、facts は実際の値動きから計算した事実です。",
    "数値の単位: *_r はプランのリスク幅（エントリー〜損切り）を 1 とした倍率。時刻は UTC。",
    "",
    JSON.stringify(payload),
  ].join("\n");
  return { system: DIAGNOSIS_SYSTEM_PROMPT, user };
};

// A malformed answer is not stored. The cause must be one of ours; when the
// model's pick is not, the deterministic hint stands.
export const parseDiagnosis = (raw: unknown, hints: Cause[]): Diagnosis | null => {
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
  };
};

// ---------------------------------------------------------------------------
// Consolidation
// ---------------------------------------------------------------------------

export interface LessonRow {
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
  created_at: string;
}

export interface RecordStats {
  total: number;
  wins: number;
  losses: number;
  untriggered: number;
  expired: number;
  ambiguous: number;
  open: number;
  win_rate: number | null;
  fill_rate: number | null;
  by_cause: Record<string, number>;
  // Plans the entry gate refused, and how many of them the market then
  // filled anyway
  rejected: number;
  shadow: { total: number; untriggered: number; wins: number; losses: number; open: number };
}

export const CONSOLIDATION_SCHEMA = {
  type: "object",
  properties: {
    rules: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string", description: "既存ルールを引き継ぐ場合はその id、新規は r + 番号" },
          text_ja: { type: "string", description: "「条件 → 行動」の一般則。100字以内、日本語。個別の価格・日付を含めない" },
          text_en: { type: "string", description: "The same rule in English" },
          cause: { type: "string", enum: [...CAUSES, "general"] },
          support: { type: "integer", description: "このルールを裏付ける lessons の件数（統合時は合算）" },
          scope: { type: ["string", "null"], description: "適用範囲を短く。無ければ null" },
        },
        required: ["id", "text_ja", "text_en", "cause", "support", "scope"],
        additionalProperties: false,
      },
    },
    summary_ja: { type: "string", description: "実績から見た現状の弱点と、今回の改訂内容。日本語、200字以内" },
    summary_en: { type: "string", description: "The same summary in English" },
  },
  required: ["rules", "summary_ja", "summary_en"],
  additionalProperties: false,
};

export const CONSOLIDATION_SYSTEM_PROMPT = `あなたはFX分析AIの「ルールブック」の編集者です。個々のプランの検証結果（lessons）と実績統計（stats）から、次回以降のプラン作成で AI アナリストが従う一般則を最大${MAX_RULES}個にまとめます。ルールブックは AI のシステムプロンプトにそのまま入ります。

原則:
- 既存ルール（current_rules）は、新しい lessons に裏付けられれば support を合算して残し、矛盾する証拠が積み上がれば書き換えるか削除する。
- 同じ趣旨のルールは1つに統合する。似た lessons が複数あれば、それらをまとめた1本のルールにし support を件数にする。
- ルールは「条件 → 行動」の形、100字以内。個別の価格・日付・銘柄固有の出来事は書かない。
- 1件だけの lesson から強い断定はしない（support 1 のルールは「検討する」「注意する」程度の表現にする）。
- stats（勝率・約定率・原因別件数・却下プラン shadow の追跡結果）と矛盾するルールは作らない。shadow の多くが未約定なら却下は正しく機能しており、そのルールは強めてよい。
- 重要度・support の高い順に並べる。
- ルールは、アナリストが実際に出力できる形式の指示に限る。プランはエントリー1つ・損切り1つ・利確3つで、分割エントリー・ナンピン・両建て・トレーリングストップは表現できない。「一部を成行で、残りを指値で」のようなルールは作らず、単一のエントリーで実行できる形（成行にする、指値をATR0.5倍以内に置く、見送る）に書き換える。
- id は既存ルールを引き継ぐ場合そのまま、新規は "r" + 通し番号。`;

export const buildConsolidationPrompt = (
  rules: Rule[],
  lessons: LessonRow[],
  stats: RecordStats,
): { system: string; user: string } => {
  const payload = {
    current_rules: rules.map((r) => ({ id: r.id, text_ja: r.text_ja, text_en: r.text_en, cause: r.cause, support: r.support, scope: r.scope })),
    lessons: lessons.map((l) => ({
      cause: l.cause,
      outcome: l.outcome,
      interval: l.interval,
      signal: l.signal,
      order_type: l.order_type,
      shadow: l.shadow,
      confidence: l.confidence,
      avoidable: l.avoidable,
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
}

export const parseConsolidation = (raw: unknown, previous: Rule[], nowIso: string): Consolidation | null => {
  if (!isRecord(raw) || !Array.isArray(raw.rules)) return null;
  const since = new Map(previous.map((r) => [r.id, r.since]));
  const seen = new Set<string>();
  const rules: Rule[] = [];
  for (const item of raw.rules) {
    if (!isRecord(item)) continue;
    const textJa = str(item.text_ja, MAX_RULE_CHARS);
    const textEn = str(item.text_en, MAX_RULE_CHARS);
    if (!textJa && !textEn) continue;
    let id = str(item.id, 20) || `r${rules.length + 1}`;
    while (seen.has(id)) id = `${id}_`;
    seen.add(id);
    const cause = typeof item.cause === "string" && (isCause(item.cause) || item.cause === "general") ? item.cause : "general";
    rules.push({
      id,
      text_ja: textJa || textEn,
      text_en: textEn || textJa,
      cause,
      support: clampInt(item.support, 1, 10_000, 1),
      scope: str(item.scope, 60) || null,
      since: since.get(id) ?? nowIso,
    });
    if (rules.length >= MAX_RULES) break;
  }
  if (rules.length === 0) return null;
  return {
    rules,
    summary_ja: str(raw.summary_ja, 600),
    summary_en: str(raw.summary_en, 600),
  };
};

// The record as numbers, from the rows the consolidation is given
export const summarizeRecord = (
  rows: Array<{ outcome: string; signal: string; shadow: boolean; rejection: string | null; filled: boolean }>,
  lessons: Array<{ cause: string }>,
): RecordStats => {
  const s: RecordStats = {
    total: 0, wins: 0, losses: 0, untriggered: 0, expired: 0, ambiguous: 0, open: 0,
    win_rate: null, fill_rate: null, by_cause: {}, rejected: 0,
    shadow: { total: 0, untriggered: 0, wins: 0, losses: 0, open: 0 },
  };
  let filled = 0;
  let settled = 0;
  for (const r of rows) {
    if (r.shadow) {
      s.shadow.total++;
      if (r.outcome === "untriggered") s.shadow.untriggered++;
      else if (r.outcome === "win") s.shadow.wins++;
      else if (r.outcome === "loss") s.shadow.losses++;
      else if (r.outcome === "pending") s.shadow.open++;
      continue;
    }
    if (r.signal === "WAIT") {
      if (r.rejection) s.rejected++;
      continue;
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
      settled++;
    } else if (r.outcome === "untriggered") {
      settled++;
    }
  }
  const closed = s.wins + s.losses;
  s.win_rate = closed > 0 ? Math.round((s.wins / closed) * 100) : null;
  s.fill_rate = settled > 0 ? Math.round((filled / settled) * 100) : null;
  for (const l of lessons) s.by_cause[l.cause] = (s.by_cause[l.cause] ?? 0) + 1;
  return s;
};
