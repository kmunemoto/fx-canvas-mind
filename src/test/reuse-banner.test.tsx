import { describe, it, expect, vi } from "vitest";
import { fireEvent, render as rtlRender, screen, type RenderResult } from "@testing-library/react";
import type { ReactElement } from "react";
import { LocaleProvider } from "../lib/i18n";
import ReuseBanner from "../components/ReuseBanner";
import type { AnalysisReuse } from "../lib/types";

// THE ONE INVARIANT THIS FEATURE EXISTS TO PROTECT: a stored answer is never
// shown as a fresh one (docs/OPERATIONS.md §2.4).
//
// Pinned by rendering rather than by grepping the page source. A grep for a
// testid stays green when the block that contains it becomes unreachable —
// which is exactly the failure that would put an old SELL on screen with no
// label and no way past it.

const render = (ui: ReactElement, locale: "ja" | "en" = "ja"): RenderResult =>
  rtlRender(<LocaleProvider initial={locale}>{ui}</LocaleProvider>);

const hasJapanese = (s: string) => /[ぁ-んァ-ヶ一-龠]/.test(s);

const reused = (over: Partial<AnalysisReuse> = {}): AnalysisReuse => ({
  version: 1,
  analysis_id: "a-1",
  analyzed_at: "2026-09-11T21:30:00Z",
  served_at: "2026-09-13T11:00:00Z",
  credit_refunded: true,
  ...over,
});

describe("the reuse banner", () => {
  it("says the answer is not new, and when it was made", () => {
    render(<ReuseBanner reused={reused()} busy={false} onForceFresh={() => {}} />);
    expect(screen.getByTestId("reuse-banner")).toBeTruthy();
    // The time is shown in JST, because every time on this screen is. The
    // stored answer was written 2026-09-11 21:30 UTC, which is 09/12 06:30
    // JST — a banner that printed the UTC day would put the answer on the
    // wrong calendar day for the reader who has to judge how stale it is.
    const at = screen.getByTestId("reuse-analyzed-at").textContent ?? "";
    expect(at).toContain("09/12 06:30");
    expect(at).not.toContain("09/11");
  });

  it("offers a way past it, and calls back when taken", () => {
    const onForceFresh = vi.fn();
    render(<ReuseBanner reused={reused()} busy={false} onForceFresh={onForceFresh} />);
    const button = screen.getByTestId("force-fresh") as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    expect(onForceFresh).toHaveBeenCalledTimes(1);
  });

  it("does not let the reader fire a second run while one is in flight", () => {
    render(<ReuseBanner reused={reused()} busy onForceFresh={() => {}} />);
    expect((screen.getByTestId("force-fresh") as HTMLButtonElement).disabled).toBe(true);
  });

  it("renders in English without leaking Japanese", () => {
    const { container } = render(<ReuseBanner reused={reused()} busy={false} onForceFresh={() => {}} />, "en");
    expect(hasJapanese(container.textContent ?? "")).toBe(false);
  });

  it("says the credit came back only when it actually did", () => {
    // The refund is best-effort and clears its own guard before running, so a
    // failure is permanent: the count stays down and nothing retries. Saying
    // "no credit was used" there would contradict the counter beside it.
    const back = render(<ReuseBanner reused={reused()} busy={false} onForceFresh={() => {}} />, "en");
    expect(back.getByTestId("reuse-credit").textContent).toContain("No analysis credit was used.");
    back.unmount();

    const lost = render(
      <ReuseBanner reused={reused({ credit_refunded: false })} busy={false} onForceFresh={() => {}} />, "en",
    );
    expect(lost.container.textContent).not.toContain("No analysis credit was used.");
    expect(lost.getByTestId("reuse-credit").textContent).toContain("could not be handed back");
    lost.unmount();

    // null = none was consumed at all (admin): neither claim is made.
    const none = render(
      <ReuseBanner reused={reused({ credit_refunded: null })} busy={false} onForceFresh={() => {}} />, "en",
    );
    expect(none.queryByTestId("reuse-credit")).toBeNull();
  });

  it("does not claim the match was the reader's previous run", () => {
    // The lookup takes the newest row carrying the same key. With another
    // pair analysed in between, that row is not "last time".
    const { container } = render(<ReuseBanner reused={reused()} busy={false} onForceFresh={() => {}} />, "en");
    expect(container.textContent).not.toContain("last time");
  });

  it("names the measured reason asking again would not help", () => {
    // The point of the banner is not "we saved you a credit" — it is that a
    // second ask on the same input re-rolls the analyst's noise. If that
    // sentence goes, the banner reads as a cost-saving excuse.
    const { container } = render(<ReuseBanner reused={reused()} busy={false} onForceFresh={() => {}} />, "en");
    const text = container.textContent ?? "";
    expect(text).toContain("10 of 48");
  });
});
