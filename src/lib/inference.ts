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
const TERMS: readonly string[] = [
  // JA — order flow and intent
  "ストップ狩り", "ストップハント", "ストップを狩", "損切りを巻き込", "損切り注文が",
  "大口", "機関投資家", "スマートマネー", "仕掛け", "踏み上げ", "投げ",
  "buy the dip 勢", "買い方", "売り方", "実需", "板",
  "溜まって", "溜まりやす", "集積", "吸収", "利食い圧力", "利確売りが出",
  // EN — the same claims
  "smart money", "stop hunt", "stop-hunt", "stop run", "liquidity grab",
  "liquidity pool", "resting stops", "stops are resting", "stops sitting",
  "institutional", "big players", "large players", "absorption", "absorbed",
  "accumulation", "distribution", "order flow", "order book", "sweep the",
];

// Sentences the APP itself writes to say it has no such data. Tagging these
// as inference would be exactly backwards: they are the disclosure.
const DISCLOSURES: readonly string[] = [
  // Every negative form the app's own disclosures use. "取得していない" alone
  // missed "取得していません", which is how the sentence is actually written,
  // so the disclosure was being tagged as the claim it disclaims.
  "取得していな", "取得していませ", "取得しておら", "取得しておりませ",
  "は未取得", "データがありません", "見ていない", "見ていませ",
  "not observed", "not available", "we do not have", "no order flow",
  "参考情報です",
];

export const INFERENCE_TERMS = TERMS;

/**
 * Does this rendered string make a claim the app has no data for?
 *
 * Case-insensitive for the English terms; Japanese has no case. A string that
 * is the app's own disclosure is never tagged, however many terms it contains
 * — the sentence "we did not fetch volume" contains "volume" and is the
 * opposite of a volume claim.
 */
export const isInference = (text: string | null | undefined): boolean => {
  if (typeof text !== "string" || text.length === 0) return false;
  const lower = text.toLowerCase();
  if (DISCLOSURES.some((d) => lower.includes(d.toLowerCase()))) return false;
  return TERMS.some((term) => lower.includes(term.toLowerCase()));
};
