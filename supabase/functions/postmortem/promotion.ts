// The gate a written revision has to pass before the analyst is shown it.
//
// Versions 6, 7 and 8 were each replaced before a single trade under them
// closed, so no version was ever measured and no comparison between two of
// them was possible. The revision is still written every time experience calls
// for one; it waits in `candidate` until the live version has been measured on
// enough evidence to have been worth measuring.
//
// "Enough evidence" is COUNTED IN EPISODES, not in rows. Ten plans on USD/JPY
// short over one afternoon are one reading of one situation restated ten
// times; calling that ten measurements promotes a rulebook on the strength of
// a single afternoon. Every other place the loop counts evidence — a rule's
// support, the record's "independent situations" — already counts episodes,
// and this was the last one that did not.
//
// The old query made the same mistake twice over. It selected ONLY `id`, so
// the rows it clustered carried no pair, no direction and no timestamps: every
// row produced the identical episode id and the count was 1 forever, whatever
// the population. That is not a hypothetical about a future refactor — it is
// what `select=id` would have done the moment anyone counted episodes off it.
//
// Split out of index.ts so the arithmetic can be tested without a database, a
// model call, or a Deno runtime.

import { EPISODE_DEFINITION_VERSION, episodeCount, type Clusterable } from "../_shared/episodes.ts";

// Independent situations the live rulebook must have been decided over before
// a candidate replaces it.
export const MIN_DECIDED_EPISODES = 10;

// How many rows the decided-population read is allowed to return.
//
// The old limit of 100 was a silent truncation: with the population capped and
// unordered, the rows that came back were an arbitrary subset, and an
// arbitrary subset can both inflate a count (a scattered sample looks like
// many situations) and deflate it. Two changes make truncation safe rather
// than merely rarer:
//
//   * the read is ORDERED BY created_at ASCENDING, so what comes back is a
//     time-ordered PREFIX of the population rather than an arbitrary slice;
//   * the episode scan is forward-only, so rows that would have arrived later
//     can add episodes or join existing ones but can never change a decision
//     already made about an earlier row.
//
// Together those make a truncated count a strict LOWER BOUND on the true one,
// which is the safe direction for a gate that asks "at least ten": a lower
// bound at or above the floor proves the floor is cleared. It can only ever
// delay a promotion, never wave one through. The bound is set well above any
// population that can occur — 30 analyses exist in total as of 2026-09-07 —
// so `truncated` is reported for the day that stops being true.
//
// `truncated` is inferred from the row count coming back at the limit, so a
// server-side cap below it (PostgREST's own db-max-rows) would truncate
// without saying so. The count stays a valid lower bound either way — the
// prefix argument above does not depend on where the cut fell — so the gate
// is still safe in the right direction; only the warning is lost.
export const DECIDED_ROW_LIMIT = 1000;

// The rows the gate needs: enough to say which situation each plan belonged
// to, which is exactly what `select=id` did not carry.
export interface DecidedRow extends Clusterable {
  pair: string;
  signal: string;
  created_at: string;
  closed_at?: string | null;
}

// The PostgREST path for the decided population under one rulebook version.
//
// preview=is.false is new here: a weekend preview is never scored, never
// diagnosed and counted in no other statistic, but it does carry a
// rulebook_version, so it was eligible for this count alone. Its outcome is
// 'skipped', which the outcome filter already excludes — the filter is written
// anyway, because an invariant that holds by side effect is one nobody will
// notice breaking.
export const decidedRowsPath = (version: number): string =>
  `analyses?select=pair,signal,created_at,closed_at&rulebook_version=eq.${version}` +
  `&outcome=in.(win,loss,expired)&shadow=is.false&preview=is.false` +
  `&order=created_at.asc&limit=${DECIDED_ROW_LIMIT}`;

export interface PromotionVerdict {
  // Whether a candidate may be promoted on the evidence
  measured: boolean;
  // Independent situations decided under the live version; null when the read
  // failed. A failed read is NOT zero — coercing it to zero demotes a revision
  // that had earned promotion and reports the coercion as a measured fact.
  episodes: number | null;
  // How many more are needed, null when the count is unknown
  needed: number | null;
  // The population hit DECIDED_ROW_LIMIT, so `episodes` is a lower bound
  truncated: boolean;
  // What "one situation" meant when this count was taken. Stored with the
  // verdict, because a change of counting method is otherwise indistinguishable
  // from the analyst improving.
  episode_definition_version: number;
  // Rows that came back without enough on them to say which situation they
  // belonged to. Not zero episodes and not one: a read that did not return
  // what was asked for. See the guard below.
  unplaceable: number;
}

// A decided row can only be placed in a situation if it says which market,
// which direction and when. `select=id` returned none of the three, and the
// episode rule answers that with a single id shared by every row — so a
// population of any size counted as one situation and the gate would have
// held every candidate back forever, reporting a measured 1.
//
// Nothing about that failure is visible in the count itself, which is why it
// is checked rather than trusted: the rows are asked whether they can be
// placed, and a run that cannot place them says so instead of publishing a
// number it made up.
const placeable = (r: DecidedRow): boolean =>
  r.pair.length > 0 && r.signal.length > 0 && Number.isFinite(Date.parse(r.created_at));

// Version 0 is an empty book: it has no rules to measure and no cohort that
// could ever exist, because no plan can be made under rules that do not exist.
// Holding the first revision back would hold it forever.
export const promotionGate = (version: number, rows: DecidedRow[] | null): PromotionVerdict => {
  if (rows === null) {
    return {
      measured: version === 0,
      episodes: null,
      needed: null,
      truncated: false,
      episode_definition_version: EPISODE_DEFINITION_VERSION,
      unplaceable: 0,
    };
  }
  // Rows that cannot be placed are treated exactly like a read that failed,
  // for the same reason: an unknown count is not a low one, and coercing it
  // either way reports a guess as a measurement.
  const unplaceable = rows.filter((r) => !placeable(r)).length;
  if (unplaceable > 0) {
    return {
      measured: version === 0,
      episodes: null,
      needed: null,
      truncated: rows.length >= DECIDED_ROW_LIMIT,
      episode_definition_version: EPISODE_DEFINITION_VERSION,
      unplaceable,
    };
  }
  const episodes = episodeCount(rows);
  return {
    measured: version === 0 || episodes >= MIN_DECIDED_EPISODES,
    episodes,
    needed: Math.max(0, MIN_DECIDED_EPISODES - episodes),
    truncated: rows.length >= DECIDED_ROW_LIMIT,
    episode_definition_version: EPISODE_DEFINITION_VERSION,
    unplaceable: 0,
  };
};
