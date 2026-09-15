// WHICH VERSION OF THE ANALYST WROTE THIS PLAN.
//
// Until now this project had exactly one way to try a change: edit a module
// constant and deploy it to 100% of traffic. docs/OPERATIONS.md §8.5 and
// §8.5-a are what that costs — two production 504s and a two-stage rollback
// inside one day. The rulebook's `candidate` is not an answer either: it is an
// offline replay object, and analyze has never read it.
//
// So a candidate needs three things, and this file is the first of them:
//   1. a name the request can ask for,
//   2. a name the ROW keeps forever, so the two populations can never be
//      pooled by accident,
//   3. a name the reuse key includes, or the candidate arm gets served the
//      control arm's stored answer (analyze/reuse.ts).
//
// WHY NOT plan_contract. That column means "the rule by which a plan fills"
// (_shared/contract.ts). Neither candidate changes how a plan fills — both
// change what the analyst is SHOWN or ALLOWED TO SAY. Reusing plan_contract
// would make the statistics refuse to pool runs that are, as trades,
// identical, and would say something false about the contract besides.
//
// WHY THERE IS NO "both". The record these arms are measured against is 48
// settled trades. Split two ways that is ~24 each — barely over MIN_STAT_N
// (20, postmortem/prompt.ts), which is the floor for reporting a statistic at
// all, not a comfortable sample. Split four ways it is under the floor in
// every cell: noise with a label on it. (An earlier version of this comment
// said 24 was already BELOW MIN_STAT_N. That was simply wrong, and it argued
// for the right answer with a false number.) One candidate at a time is not a
// limitation of the mechanism — it is the only shape the evidence can carry.
// Adding a combined arm later touches the data layer only lightly — one enum
// value and one CHECK constraint — but that is not the whole cost: making the
// analyst actually DO both things means usesLowerTimeframe and
// usesConditionalWait below (exact-equality checks against one Variant) also
// have to change, since a combined value would fail both today.

export const VARIANTS = ["control", "lower_tf", "conditional_wait"] as const;

export type Variant = (typeof VARIANTS)[number];

export const DEFAULT_VARIANT: Variant = "control";

// Unknown values fall back to control rather than failing the request. A
// client asking for an arm this build does not have is not an error the
// reader should see — it is a control run, and the ROW says so, which is the
// only place the distinction has to survive.
export const resolveVariant = (value: unknown): Variant =>
  typeof value === "string" && (VARIANTS as readonly string[]).includes(value)
    ? (value as Variant)
    : DEFAULT_VARIANT;

// #87 — the analyst also sees ONE timeframe below the entry frame, for entry
// timing only. Direction stays with the higher frames.
export const usesLowerTimeframe = (variant: Variant): boolean => variant === "lower_tf";

// #86 — when the answer is WAIT, the analyst may also name a trigger level, a
// side and an expiry. RECORDED AND SCORED, never turned into an order: #37
// measured what happens when the analyst picks a fill price (5 of 8 went
// unfilled, every one of them carrying its own trend tag in the signal's
// direction), and analyze/entry.ts's should_be_market exists to refuse it.
export const usesConditionalWait = (variant: Variant): boolean => variant === "conditional_wait";
