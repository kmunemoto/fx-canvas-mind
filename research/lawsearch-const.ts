// 法則探し (docs §8.136, research/lawsearch-spec.md): the study's fixed numbers and the sha256 of the files that hold
// its rules. This file is part of the merge that sets R_law (spec 12: the first 00:00 UTC after the merge to main).
// After R_law the rules do not change; a run stops when any file's sha256 differs from the constant here.
//
//   SPEC_SHA256        research/lawsearch-spec.md (with 付録 A's list and the two hand files' sha256)
//   HAND_JSON_SHA256   research/lawsearch-hand.json (付録 A, the values both implementations reproduce)
//   HAND_MD_SHA256     research/lawsearch-hand.md (付録 A, the examples' text)
//   CANDIDATES_SHA256  research/ledger/lawsearch-candidates.json (the 1,364 trials in table order, spec 4.6)
//   SPREAD_H1_SHA256   research/ledger/spread-hours-h1.csv (the first half's wide-spread slots, spec 6 ⑥; Actions run
//                      41773855614, commit 0b1d4d8, the TS and the Python agreeing on every value)

import { HOUR, MINUTE, WEEK, WEEK_OFFSET } from "./lib.ts";

export const SPEC_SHA256 = "df93c55b64d50235a603aede78f96da89f75d15dfe9aef6d8cd33157c6f1e221";
export const HAND_JSON_SHA256 = "41d4788084630bb4dbc7f6c0a3a46cce40dd604a76b29358f84bf461f53a1d9a";
export const HAND_MD_SHA256 = "f51112b57eb3d62df4afadcf3e838bbf51cb54b62942ca095c881d701840bae7";
export const CANDIDATES_SHA256 = "92adb97481cf5a7cc7b17a4a31d06da638c2d30246951a6c51b564e7018fdeab";
export const SPREAD_H1_SHA256 = "2e5a8892d306bc9a9b183f32bddf1a3d7473f741b07e96b332b91e365ea6ce3a";

export const FILES: ReadonlyArray<readonly [string, string]> = [
  ["research/lawsearch-spec.md", SPEC_SHA256],
  ["research/lawsearch-hand.json", HAND_JSON_SHA256],
  ["research/lawsearch-hand.md", HAND_MD_SHA256],
  ["research/ledger/lawsearch-candidates.json", CANDIDATES_SHA256],
  ["research/ledger/spread-hours-h1.csv", SPREAD_H1_SHA256],
];

// spec 1: the five GMO pairs; pip 0.01 on the yen pairs, 0.0001 on the dollar pairs; a point is 0.1 pip
export const PAIRS = ["USD/JPY", "EUR/JPY", "AUD/JPY", "EUR/USD", "AUD/USD"] as const;
export const POINTS_PER_PRICE = (pair: string): number => (pair.endsWith("JPY") ? 1000 : 100000);
export const MID_DIGITS = (pair: string): number => (pair.endsWith("JPY") ? 3 : 5);

// spec 1: the dates (fixed)
export const S0 = Date.parse("2023-10-27T00:00:00Z");
export const START = Date.parse("2024-01-01T00:00:00Z");
export const SPLIT = Date.parse("2025-05-19T00:00:00Z");
export const END = Date.parse("2026-10-31T00:00:00Z");

// spec 1: the week of t (weeks start Sunday 21:00 UTC, lib.ts) and the weeks the spec worked out
export const wk = (t: number): number => Math.floor((t - WEEK_OFFSET) / WEEK);
export const WK = { S0: 2807, START: 2817, SPLIT: 2889, FIRST_HALF_LAST: 2888, END: 2964 } as const;

// spec 7: the trade's length in bars; the two timeframes and their higher timeframes (spec 2)
export const N_BARS = 8;
export const STEP = { m15: 15 * MINUTE, h1: HOUR } as const;
export const HIGHER = { m15: HOUR, h1: 4 * HOUR } as const;

// the weeks above are the spec's arithmetic; a run checks them before it reads a bar
export const checkConstants = (): string[] => {
  const bad: string[] = [];
  if (wk(S0) !== WK.S0) bad.push(`wk(S0) ${wk(S0)}`);
  if (wk(START) !== WK.START) bad.push(`wk(START) ${wk(START)}`);
  if (wk(SPLIT) !== WK.SPLIT) bad.push(`wk(SPLIT) ${wk(SPLIT)}`);
  if (wk(Date.parse("2025-05-18T21:00:00Z")) !== WK.SPLIT) bad.push("the week of 2025-05-18 21:00 UTC");
  if (wk(END) !== WK.END) bad.push(`wk(END) ${wk(END)}`);
  return bad;
};

const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, "0")).join("");
// every rules file against its constant (the run stops on any difference)
export const checkFiles = async (root = "."): Promise<string[]> => {
  const bad: string[] = [];
  for (const [path, want] of FILES) {
    const got = hex(await crypto.subtle.digest("SHA-256", await Deno.readFile(`${root}/${path}`)));
    if (got !== want) bad.push(`${path}: sha256 ${got}, not ${want}`);
  }
  return bad;
};
