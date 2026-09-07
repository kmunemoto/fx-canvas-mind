// What counts as ONE independent situation.
//
// An episode is the unit of evidence. A rule survives a revision when the
// lessons citing it come from more than zero episodes, the record prints "N
// independent situations" under the win rate, and the promotion gate asks how
// many episodes the live rulebook has been measured over. Three different
// numbers, all of them this one.
//
// It had FOUR implementations, and they disagreed in two ways at once
// (measured 2026-09-07 against the working tree and the live database):
//
//   postmortem/prompt.ts   window measured from the PREVIOUS plan, so every
//                          plan pushed the deadline forward — a chain. Plus a
//                          reopen escape that could never fire, because the
//                          settlement time it reads was never selected, never
//                          mapped at the call site, and had no column in
//                          public.lessons to be selected from.
//   src/lib/outcomeStats.ts window measured from the CLUSTER'S START, so a run
//                          of plans is cut every 24 hours. No escape at all.
//   performance_stats (SQL, twice) the same fixed anchor as the client.
//
// Under a steady cadence the two anchors diverge without bound: the chain
// fuses a week of daily plans into one episode, the fixed anchor cuts it into
// seven. The number that decided whether a rule SURVIVED came from the chain;
// the number on the screen came from the fixed anchor. Nobody could have told
// which was which from either.
//
// The rule here is the union of the two halves that were each half right: the
// fixed anchor, which keeps a long run from collapsing into a single episode,
// AND the reopen escape, which lets the market genuinely move on between two
// plans inside the same day.
//
// ON THE FOUR HOURS: it is a working aggregation threshold, not a claim of
// statistical independence. Nothing measured says that two plans four hours
// and one minute apart are independent draws; what it says is that the earlier
// trade was over and done before the later one was written, so the later one
// was a fresh reading rather than the same bet restated. Treat an episode
// count as "how many separate times we decided", never as a sample size that
// licenses a significance claim.
//
// AND ON THE SETTLEMENT TIME the escape compares against: it is only as sharp
// as the interval the plan was evaluated on. analyses.closed_at is stamped at
// the evaluation BAR boundary, not at the tick — 1b003cf3 closed at exactly
// 02:00:00.000 on a 1h plan — so on a 1day plan the settlement is known to the
// day. An episode boundary inherits that granularity. Four hours is a coarse
// threshold measured with a coarse instrument, which is another reason not to
// read an episode count as anything finer than "separate occasions".
//
// ONE RULE IS NOT ENOUGH ON ITS OWN: the population fed to it has to match
// too. A row taking part in the scan anchors an episode start and overwrites
// the previous plan's settlement for the row after it, so a row that is
// present on one side and filtered out on the other moves boundaries on one
// side only — the same divergence under a new name. Every caller passes the
// same population: everything that is neither a shadow nor a weekend preview,
// filtered BEFORE the scan and not skipped inside the loop after it. That is
// what performance_stats' `mine` CTE does, and summarizeRecord and
// outcomeStats.tally were changed to match it.
//
// TWO KNOWN DIFFERENCES from the SQL statement of this same rule
// (performance_stats, and loop_health's decided-episode count), both
// unreachable on the data as it stands and both written down rather than
// papered over:
//
//   * ORDER ON A TIE. The scan below sorts on created_at alone and a stable
//     sort then keeps input order; the SQL orders on (created_at, id). Two
//     plans stamped the same millisecond would be scanned in a different order
//     on the two sides. Adding an id here would put one on every caller for a
//     case that has never occurred.
//   * A TIMESTAMP THAT WILL NOT PARSE. This gives such a row the id
//     "pair|signal|unknown" and counts it, on the principle that a row that
//     happened is not nothing. The SQL cannot: a null cluster_start makes the
//     whole concatenated id null and count(distinct) skips it.
//     analyses.created_at is NOT NULL, so the SQL never meets the case.
//
// Zero imports on purpose. Deno edge functions, the browser bundle and vitest
// all read this file directly, so it must stay a leaf: postmortem/prompt.ts
// reaches facts.ts, analyze/entry.ts and analyze/rules.ts, and any of those in
// the client bundle would drag the whole server graph across.

// Plans on the same pair in the same direction this close together were one
// decision about one situation: they count once...
export const CLUSTER_WINDOW_MS = 24 * 60 * 60 * 1000;
// ...unless the earlier plan had already settled this long before the next
// one was made, in which case the market had moved on.
export const CLUSTER_REOPEN_MS = 4 * 60 * 60 * 1000;

// Bumped whenever the rule below changes. Stamped alongside every episode
// count that is persisted, because a count that changes method looks exactly
// like a count that changed because the analyst got better, and there is no
// way to tell them apart after the fact without this number.
//   1 — the four divergent implementations described above (never stamped;
//       the version exists so that what follows can be told from them)
//   2 — this file: fixed anchor AND reopen escape, one implementation
export const EPISODE_DEFINITION_VERSION = 2;

export interface Clusterable {
  pair: string;
  signal: string;
  created_at: string;
  // When the plan settled, if known: a plan made well after the previous one
  // closed is a new decision even inside the window. Absent or null means
  // "still open, or not recorded", and neither of those may open the escape.
  closed_at?: string | null;
}

// Episode ids for a set of plans, in INPUT order (the scan itself runs in
// ascending created_at, whatever order the rows arrived in).
//
// A plan joins the episode of the previous plan on the same pair and direction
// when BOTH hold:
//   * it was made less than CLUSTER_WINDOW_MS after that EPISODE STARTED, and
//   * the immediately previous plan had not settled more than
//     CLUSTER_REOPEN_MS before this one was made.
// Otherwise it starts a new episode.
//
// Two boundary decisions, spelled out because both have been read the wrong
// way round in review: exactly 24 hours SEPARATES (the window test is `<`, so
// it is "24h or more apart"), and settling exactly 4 hours ahead does NOT
// escape (the escape test is `>`, so it is "more than 4h").
//
// The previous plan's own settlement, and never an older one's. Carrying the
// newest settlement forward — as prompt.ts did with `Math.max(closed,
// prev.closed)` — let a plan escape on the strength of some OTHER, older
// plan's close while the plan immediately before it was still open. That is
// backwards: an open position is the strongest possible evidence that we are
// still in the same bet.
//
// Deliberately NOT keyed by user. An episode is one market situation, and the
// rulebook is shared by every account, so two people analysing USD/JPY long
// within the window received two copies of ONE decision by one analyst — one
// piece of evidence about it, not two. Keying by user made a rule's support
// grow with the number of subscribers, and support is the number the prompt
// prints ("28 cases") and the number that decides whether a rule survives a
// revision.
export const episodeIds = (items: Clusterable[]): string[] => {
  const order = items
    .map((item, i) => ({ i, t: Date.parse(item.created_at) }))
    .sort((a, b) => (Number.isFinite(a.t) ? a.t : 0) - (Number.isFinite(b.t) ? b.t : 0));
  // `start` anchors the window; `prevClosed` is the settlement of the one plan
  // immediately before, NaN while it is open or unrecorded.
  const open = new Map<string, { id: string; start: number; prevClosed: number }>();
  const out = new Array<string>(items.length);
  for (const { i, t } of order) {
    const item = items[i];
    const key = `${item.pair}|${item.signal}`;
    const prev = open.get(key);
    const closed = item.closed_at ? Date.parse(item.closed_at) : NaN;
    const joins = prev !== undefined && Number.isFinite(t) &&
      t - prev.start < CLUSTER_WINDOW_MS &&
      !(Number.isFinite(prev.prevClosed) && t > prev.prevClosed + CLUSTER_REOPEN_MS);
    if (joins && prev) {
      out[i] = prev.id;
      open.set(key, { id: prev.id, start: prev.start, prevClosed: closed });
      continue;
    }
    const startIso = Number.isFinite(t) ? new Date(t).toISOString().slice(0, 13) : "unknown";
    const id = `${key}|${startIso}`;
    open.set(key, { id, start: Number.isFinite(t) ? t : 0, prevClosed: closed });
    out[i] = id;
  }
  return out;
};

// How many independent situations a set of plans represents. The gate, the
// record and the prompt all want this number rather than the ids.
//
// A time-ordered PREFIX of a population gives a lower bound, never an
// overcount: the scan above is forward-only, so rows that arrive later can add
// episodes or join existing ones but can never change a decision already made
// about an earlier row. That is what makes a truncated read safe to compare
// against a floor — see the decided-episode query in postmortem/index.ts.
export const episodeCount = (items: Clusterable[]): number => new Set(episodeIds(items)).size;
