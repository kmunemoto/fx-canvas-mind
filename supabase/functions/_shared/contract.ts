// Which bargain a plan was written under.
//
// The contract decides what the analyst is even able to say, so it decides
// what its record means and which of its own past rules it can still follow:
//
//   entry_chosen_v1 — the model picked an entry price. A plan the market never
//                     reached went unfilled and was never scored at all, and
//                     "wait for a pullback" was a move it could make.
//   market_v1       — the server fills at the market price of the moment. The
//                     model places only the stop and the targets, or answers
//                     WAIT. Nothing can go unfilled, and no instruction about
//                     where to enter is executable.
//
// Two contracts are two populations. Statistics refuse to pool them, and the
// rulebook refuses to show a rule from one era to an analyst working in
// another — see analyze/rules.ts `inForce` and outcomeStats.ts `contractKey`.
//
// Kept here rather than inlined so that "what contract are we on" has one
// answer that analyze, track-outcomes and postmortem all read.
//
// Deno-free on purpose: the vitest suite imports this file directly.

// The contract every plan written from now on is made under.
export const PLAN_CONTRACT = "market_v1";

// Rows and rules written before the column existed are legacy by definition:
// the contract only ever moves forwards.
export const LEGACY_PLAN_CONTRACT = "entry_chosen_v1";
