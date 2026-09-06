// Which sentences are readings of price, and which are claims about who was
// trading and why.
//
// The app has never seen an order book, a volume print, open interest or a
// single execution. Every statement about resting stops, absorption, or
// institutional intent is therefore an inference from candles — sometimes a
// reasonable one, never an observation. Across the first twenty-one analyses
// those claims were written in the same voice as "RSI is 44.1".
//
// WHY THIS RUNS AT RENDER TIME, and not as a field the model fills in:
//
// A `type: 'measured' | 'inferred'` tag written by the model is a tag nothing
// checks. It would not merely fail to help — a "measured" chip is a STRONGER
// assertion than today's undifferentiated prose, so an unverified tag makes
// the problem worse. It also cannot reach the rows already written, and on
// the search path the schema never binds at all (structured output and web
// search are mutually exclusive, so the field contract arrives as prose).
//
// Matching text at render time has none of those properties. It is a pure
// function of what is on screen, so it applies to every one of the existing
// rows and to anything a future model writes, whether or not it cooperates.
//
// WHAT IT CANNOT DO, stated plainly: vocabulary matching loses to paraphrase.
// "157.10を上抜ければ加速しやすい" contains no listed term and is the same
// claim. This is a floor, not a filter — it is worth having because the
// alternative is nothing, not because it is complete.

// Terms that name something the app cannot see. Japanese and English both:
// the analysis prose is written in the reader's locale, so a Japanese-only
// list would leave every English run untagged.
//
// Terms are chosen to be unambiguous ON THEIR OWN. "買い方" was here and
// matched inside 買い方向 and 買い方針, tagging "上位足も買い方向で整合" —
// two computed facts — as an unobservable claim. A chip that appears on
// measured values stops meaning anything the first time a reader sees it
// there, so an ambiguous term is worse than a missing one.
const TERMS: readonly string[] = [
  // JA — order flow and intent
  "ストップ狩り", "ストップハント", "ストップを狩", "損切りを巻き込", "損切り注文が溜",
  "大口", "機関投資家", "スマートマネー", "踏み上げ", "投げ売り",
  "実需", "板情報から", "板の厚",
  "ストップが溜ま", "注文が溜ま", "流動性が溜ま", "集積", "吸収され", "利食い圧力",
  // EN — the same claims
  "smart money", "stop hunt", "stop-hunt", "stop run", "liquidity grab",
  "liquidity pool", "resting stops", "stops are resting", "stops sitting",
  "institutional", "big players", "large players", "absorption", "absorbed",
  "order flow", "order book", "sweep the",
];

export const INFERENCE_TERMS = TERMS;

// The app's own fixed disclaimers, matched WHOLE.
//
// The first version excluded any string CONTAINING a disclosure phrase, and
// that inverted the whole mechanism. The prompt now tells the model to write
// its inferences with the caveat attached — "板情報は取得していないため推測
// だが、157.10の上にストップが溜まっている" — so a model that COMPLIES put
// the caveat and the claim in one string, the substring check fired, and the
// claim rendered untagged. The blunt version, without the caveat, was tagged.
// The compliant model was punished and the careless one rewarded.
//
// Whole-string matching cannot do that: it exempts the sentence that is
// nothing but a disclaimer, and nothing else.
const DISCLAIMERS: readonly string[] = [
  "この分析は参考情報です。投資判断は自己責任で行ってください",
  "板情報・出来高・建玉・約定履歴は取得していません",
];

const normalise = (t: string) => t.trim().replace(/[。.\s]+$/u, "");

/**
 * Does this rendered string make a claim the app has no data for?
 *
 * Case-insensitive for the English terms; Japanese has no case.
 *
 * KNOWN LIMIT, and it is not small: vocabulary matching loses to paraphrase.
 * "157.10を上抜ければ加速しやすい" is the same claim in words no list holds.
 * This is a floor under the problem, not a solution to it.
 */
export const isInference = (text: string | null | undefined): boolean => {
  if (typeof text !== "string" || text.length === 0) return false;
  const trimmed = normalise(text);
  if (DISCLAIMERS.some((d) => normalise(d) === trimmed)) return false;
  const lower = text.toLowerCase();
  return TERMS.some((term) => lower.includes(term.toLowerCase()));
};
