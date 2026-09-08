import type { AnalysisMode, EntryCheck, EntryRejection } from "./types";

// The server appends a compliance disclaimer to every warnings list and
// recognises one already present by these markers, case-insensitively
// (supabase/functions/analyze/locale.ts, withDisclaimer). The footer of the
// page carries the disclaimer already, so in the warnings box it was the one
// sentence every reader had seen before they reached the first real warning.
//
// Both languages are checked whatever the UI locale is: the analysis was
// written in the locale of the REQUEST, and the reader may have switched
// since. src/test/warnings.test.ts pins these to the server's own markers.
export const DISCLAIMER_MARKERS = ["自己責任", "your own responsibility"] as const;

export const isDisclaimer = (warning: string): boolean => {
  const w = warning.toLowerCase();
  return DISCLAIMER_MARKERS.some((m) => w.includes(m));
};

// Why a WAIT is a WAIT, read from entry_check rather than from the warning
// text. Two events that the rejection string alone cannot tell apart (see
// isRejected / isSelfDeclined in outcomeStats.ts, and the sixteen-to-one
// miscount that motivated them):
//   rejected — the analyst asked for a BUY or SELL and the server published
//              a WAIT instead
//   declined — the analyst itself stood aside, and the confidence floor
//              stamped a rejection on it anyway
export interface WaitReason {
  kind: "rejected" | "declined";
  rejection: EntryRejection;
  proposed: "BUY" | "SELL" | "WAIT";
}

export const waitReasonOf = (
  signal: string,
  entryCheck: EntryCheck | null | undefined,
): WaitReason | null => {
  if (signal !== "WAIT" || !entryCheck) return null;
  const rejection = entryCheck.rejection;
  if (typeof rejection !== "string" || rejection.length === 0) return null;
  const proposed = entryCheck.proposed_signal;
  if (proposed === "BUY" || proposed === "SELL") return { kind: "rejected", rejection, proposed };
  if (proposed === "WAIT") return { kind: "declined", rejection, proposed };
  // No proposed_signal is no evidence of who decided, and both kinds are
  // claims about exactly that
  return null;
};

// Where the server puts its own sentence about the refusal: at the head of
// the list, unless the news-fallback sentence was prepended after it (analyze
// index.ts prepends the refusal first and the fallback last, and nothing else
// is prepended on a WAIT). The position alone would drop a model-written
// warning on a payload from a server that had not prepended, so the sentence
// must also have the shape of one of the server's. Every one of them names
// WAIT except the English sentence for a WAIT the model chose itself, which
// says "stood aside" instead — and was the one still said twice until
// src/test/warnings.test.ts pinned each marker to analyze/locale.ts.
const serverReasonIndex = (mode: AnalysisMode | null): number =>
  mode === "technical_fallback" ? 1 : 0;

export const SERVER_REASON_MARKERS = ["WAIT", "stood aside of its own accord"] as const;

const looksLikeServerReason = (warning: string): boolean =>
  SERVER_REASON_MARKERS.some((m) => warning.includes(m));

export interface VisibleWarningsOptions {
  // True when the hero is already showing the reason from entry_check, so the
  // server's sentence saying the same thing is dropped rather than said twice
  reasonShown: boolean;
  mode: AnalysisMode | null;
}

export const visibleWarnings = (warnings: string[], opts: VisibleWarningsOptions): string[] => {
  let out = warnings;
  if (opts.reasonShown) {
    const i = serverReasonIndex(opts.mode);
    if (typeof out[i] === "string" && looksLikeServerReason(out[i])) {
      out = [...out.slice(0, i), ...out.slice(i + 1)];
    }
  }
  return out.filter((w) => !isDisclaimer(w));
};
