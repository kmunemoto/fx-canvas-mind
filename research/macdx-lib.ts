// #272 (docs §8.109): the MACD extreme-cross rule. #275: the code moved to
// supabase/functions/_shared/macd-extreme.ts so the email sweep decides with
// the very code the rule was measured with; this file only re-exports it, so
// the study (macdx.ts), the hand examples (macdx-hand.ts) and the workflow
// read it from the place they always did. The rule (frozen 2026-10-10 before
// any of the measured period was read, PR #197) is described there.
export * from "../supabase/functions/_shared/macd-extreme.ts";
