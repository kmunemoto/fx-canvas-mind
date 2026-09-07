// A run that names rows, and what it owes the caller.
//
// Every way a named row could fall out of a run was silent. Measured
// 2026-09-07, request 1035: four ids in, and out came
// {"candidates":4,"due":4,"diagnosed":3,"errors":[]} — the fourth row dropped
// by a limit the caller never set, with nothing on `errors` to say so. It had
// to be found by counting the response and re-run on its own, and when it was,
// its diagnosis came out materially different, so the drop was not harmless.
//
// The rule this file exists to hold: an id the caller named is either
// diagnosed or answered for by name. Never neither, and never with a reason
// that is not true — a wrong answer is the same failure one layer up.
//
// All of it lives here rather than inline in the request handler because it is
// arithmetic about a list of ids: no database, no clock, no model. The two
// rules that were silent in production are therefore directly testable, and
// so is the predicate the sweep cooldown branches on.

// Diagnoses per run: each one is a market-data request and a model turn
export const MAX_PLANS_PER_RUN = 3;
export const MAX_PLANS_ADMIN = 6;

// analyses.id is a uuid column, and PostgREST casts the WHOLE `id=in.(...)`
// list. One entry Postgres cannot read as a uuid therefore fails the query for
// every id beside it —
//   select 'not-a-uuid'::uuid  ->  ERROR: 22P02: invalid input syntax for uuid
// — and a failed read comes back from readRows as an empty page, which is
// indistinguishable from "none of those rows exist". A typo in an operator's
// list would have turned the whole run into a no-op that blamed the database
// for rows sitting in the table. Entries are checked for uuid shape HERE, one
// at a time, so a bad one costs only itself.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// `<id>: <what happened>`, the shape the run's own deferral line already uses,
// so one reader and one grep cover every way a row can fail to be diagnosed.
// An entry with nothing printable in it is quoted rather than rendered as an
// empty string, or the line would read `: not diagnosed (...)` and name
// nothing at all.
const label = (id: string): string => (id.trim() ? id : JSON.stringify(id));

export type ParsedIds = {
  // The ids the run will actually query for: strings, trimmed, uuid-shaped,
  // and no more of them than one run can spend a worker's wall clock on.
  ids: string[];
  // How many entries the caller sent, whatever became of them. The response
  // reports THIS, not the accepted count: request 1035 was only noticeable at
  // all by counting the response against what had been sent, and a count that
  // has already dropped the truncated ids cannot be counted against anything.
  requested: number;
  // One line per entry that will never reach the query, ready for `errors`.
  rejected: string[];
};

// What `ids` in the request body means, and what it costs each entry to be
// wrong.
//
// Trimming matters beyond tidiness: `ids` is also the predicate the sweep
// cooldown branches on (a run that names rows is an operator action, exempt),
// and before the trim `{"ids":[""]}` was a targeted run — one blank string
// bought a caller the whole run body with no cooldown and nothing named. An
// entry that names no row does not make a run targeted.
export const parseIds = (value: unknown): ParsedIds => {
  const raw = Array.isArray(value) ? value : [];
  const entries = raw.filter((v): v is string => typeof v === "string").map((v) => v.trim());
  const ids: string[] = [];
  const rejected: string[] = [];
  for (const entry of entries) {
    if (!UUID_RE.test(entry)) {
      rejected.push(`${label(entry)}: not diagnosed (not a plan id)`);
      continue;
    }
    if (ids.length >= MAX_PLANS_ADMIN) {
      // Truncation used to happen with a bare .slice() two hundred lines above
      // the accounting, so the accounting could not see it: eight ids in, six
      // diagnosed, and the seventh and eighth mentioned nowhere in the
      // response — the exact shape of request 1035, one bound further out.
      rejected.push(`${entry}: not diagnosed (over MAX_PLANS_ADMIN of ${MAX_PLANS_ADMIN} ids for one run)`);
      continue;
    }
    ids.push(entry);
  }
  // Entries that were not strings at all are counted as requested and nothing
  // else: `{"ids":[1,2]}` is not a list of rows, it is a caller who has not
  // named anything, and it stays an ordinary untargeted sweep.
  return { ids, requested: raw.length, rejected };
};

// Is this run aimed at named rows — an operator action rather than a tick of
// the schedule? The sweep cooldown, the run's limit and the state row all
// branch on this one answer, so it is a named function over the PARSED ids
// rather than a length test on whatever arrived in the body: `{"ids":[""]}`
// and `{"ids":[1,2]}` name no row, and a run that names no row is a sweep and
// is paced like one.
export const isTargeted = (parsed: ParsedIds): boolean => parsed.ids.length > 0;

// How many plans this run may diagnose.
//
// Naming ids IS the statement of how many: an operator who lists four rows has
// asked for four, and the default of three was a pacing number for the cron
// that had no business truncating a hand-written list. Still bounded by
// MAX_PLANS_ADMIN, because the run has one worker's wall clock either way, and
// still overridden by an explicit `limit` — which now reads as the deliberate
// narrowing it is, and whatever it excludes is reported by unaccountedIds.
export const runLimit = (idCount: number, explicit: number | null): number => {
  if (explicit !== null && Number.isFinite(explicit)) {
    return Math.max(1, Math.min(MAX_PLANS_ADMIN, Math.round(explicit)));
  }
  return idCount > 0 ? Math.min(MAX_PLANS_ADMIN, idCount) : MAX_PLANS_PER_RUN;
};

// What the run knows about each named id by the time the queue is built.
export type IdSets = {
  // Rows this run will diagnose.
  due: ReadonlySet<string>;
  // Rows the queue accepted, before the limit was applied.
  queued: ReadonlySet<string>;
  // Rows the two candidate queries returned, before the queue judged them.
  fetched: ReadonlySet<string>;
  // Rows that exist in analyses at all, from the plain existence probe — null
  // when the probe itself could not be read.
  present: ReadonlySet<string> | null;
  // True when a candidate query failed rather than came back empty.
  unavailable: boolean;
};

// One line per named id that this run will not diagnose.
//
// The five cases are genuinely different things to have to fix, and were
// indistinguishable while all of them were silence — and then, worse,
// indistinguishable while all of them claimed the row did not exist:
//   queued      — the row is diagnosable and the limit stopped it: run it
//                 again, or raise `limit`.
//   fetched     — the row came back and the queue refused it (no entry, stop
//                 or target to measure; a WAIT already diagnosed as its
//                 shadow; a verdict that cannot be graded): nothing to run.
//   present     — the row is in the table but neither candidate query would
//                 ever return it: a pending trade, a WAIT whose verdict is
//                 'unknown' or 'no_call', a shadow row. Ten of the thirty-five
//                 rows in the table on 2026-09-07 were in exactly this state,
//                 so this is the COMMON answer, not an edge — and it used to
//                 be reported as "no settled plan with this id", which reads
//                 as a mistyped uuid and sends the operator hunting for a row
//                 they are looking straight at.
//   unavailable — a candidate query failed. Nothing is known about the id, and
//                 saying it does not exist would be inventing a fact out of a
//                 network error. Worded like the repair pass's own
//                 `lessons unavailable` line for the same reason.
//   none        — checked, and no row carries that id.
// Time-budget deferrals are NOT covered here: those happen inside the loop,
// which already names the id, and are only knowable once it is running.
export const unaccountedIds = (
  ids: readonly string[],
  sets: IdSets,
  limit: number,
): string[] => {
  const lines: string[] = [];
  for (const id of ids) {
    if (sets.due.has(id)) continue;
    if (sets.queued.has(id)) lines.push(`${id}: not diagnosed (over this run's limit of ${limit})`);
    else if (sets.fetched.has(id)) lines.push(`${id}: not diagnosed (row found, but nothing on it can be graded)`);
    else if (sets.present?.has(id)) {
      lines.push(`${id}: not diagnosed (row exists, but it is not a settled trade nor a gradeable WAIT)`);
    } else if (sets.unavailable || sets.present === null) {
      lines.push(`${id}: not diagnosed (candidate lookup unavailable, state unknown)`);
    } else lines.push(`${id}: not diagnosed (no plan with this id)`);
  }
  return lines;
};
