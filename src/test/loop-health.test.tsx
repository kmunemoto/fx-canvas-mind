import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { render as rtlRender, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { LocaleProvider } from "../lib/i18n";
import LoopHealth from "../components/LoopHealth";
import type { LoopHealth as LoopHealthData } from "../lib/types";

const render = (ui: ReactElement, locale: "ja" | "en" = "ja") =>
  rtlRender(<LocaleProvider initial={locale}>{ui}</LocaleProvider>);

const healthy: LoopHealthData = {
  tracker_last_run_at: "2026-09-03T12:48:00Z",
  postmortem_last_run_at: "2026-09-03T12:53:00Z",
  postmortem_last_diagnosed: 1,
  open_plans: 6,
  awaiting_review: 1,
  reviewed: 8,
  lessons: 8,
  rulebook_version: 4,
  rulebook_updated_at: "2026-09-03T12:00:00Z",
  lessons_since_rulebook: 2,
  jobs: [
    { name: "postmortem-sweep", schedule: "8,23,38,53 * * * *", active: true },
    { name: "track-outcomes-sweep", schedule: "3,18,33,48 * * * *", active: true },
  ],
  now: "2026-09-03T13:00:00Z",
};

describe("LoopHealth", () => {
  it("shows when each sweep last ran, what waits on it, and the distance to the next rulebook revision", () => {
    render(<LoopHealth health={healthy} />);
    const panel = screen.getByTestId("loop-health");
    expect(panel).toHaveTextContent("勝敗判定");
    expect(panel).toHaveTextContent("12分前");
    expect(panel).toHaveTextContent("7分前");
    expect(panel).toHaveTextContent("進行中 6件 · 原因分析待ち 1件 · 分析済み 8件 · 教訓 8件 · ルールブック v4");
    expect(panel).toHaveTextContent("次回改訂まで教訓あと3件");
    expect(panel).not.toHaveTextContent("停止の可能性");
  });

  it("calls out a sweep that has not run for an hour, or whose schedule is off", () => {
    render(<LoopHealth health={{ ...healthy, tracker_last_run_at: "2026-09-03T11:30:00Z", jobs: [{ name: "postmortem-sweep", schedule: "x", active: false }, { name: "track-outcomes-sweep", schedule: "x", active: true }] }} />);
    const panel = screen.getByTestId("loop-health");
    expect(panel).toHaveTextContent("停止の可能性");
    expect(panel).toHaveTextContent("スケジュールが無効");
  });

  it("renders in English and says when nothing has run yet", () => {
    render(<LoopHealth health={{ ...healthy, postmortem_last_run_at: null, lessons_since_rulebook: 5 }} />, "en");
    const panel = screen.getByTestId("loop-health");
    expect(panel).toHaveTextContent("not yet run");
    expect(panel).toHaveTextContent("revised on the next review");
  });

  it("renders nothing without data", () => {
    const { container } = render(<LoopHealth health={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});

// The RPC and the panel are two halves of one contract, and the SQL cannot be
// unit-tested from here — so what the SQL must contain is pinned to the text
// of the migration that defines it.
describe("the panel's two counters are taken over the same queue", () => {
  const sql = readFileSync("supabase/migrations/20260905190000_loop_health_counts_the_wait_queue.sql", "utf8");

  it("counts a reviewable WAIT as awaiting review", () => {
    // `reviewed` has never had a signal filter, so a diagnosed WAIT landed
    // there while awaiting_review, scoped to BUY/SELL, still read 0. The
    // panel renders the two side by side and exists to make a backlog visible.
    const awaiting = sql.slice(sql.indexOf("'awaiting_review'"), sql.indexOf("'reviewed'"));
    expect(awaiting).toContain("signal = 'WAIT'");
    expect(awaiting).toContain("wait_plan is not null");
    // On exactly the terms the post-mortem uses: a verdict the tracker
    // actually reached. A queue of rows that can never be graded would never
    // drain, which is a worse lie than the one it replaces.
    expect(awaiting).toContain("wait_check->>'verdict' in ('missed', 'correct')");
  });

  it("still returns the clock and the schedules the panel reads", () => {
    expect(sql).toContain("'now', now()");
    expect(sql).toContain("'jobs',");
  });
});
