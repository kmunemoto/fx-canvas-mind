import { describe, it, expect, vi, beforeEach } from "vitest";
import { render as rtlRender, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { LocaleProvider } from "../lib/i18n";
import { ja } from "../lib/i18n/ja";
import { en } from "../lib/i18n/en";

const rpc = vi.fn();
vi.mock("@/lib/supabase", () => ({ supabase: { rpc: (...a: unknown[]) => rpc(...a) } }));
vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({ signIn: vi.fn(), signUp: vi.fn(), user: null, profile: null }),
}));

import Landing from "../pages/Landing";
import Login from "../pages/Login";

const render = (ui: ReactElement, path = "/", locale: "ja" | "en" = "ja") =>
  rtlRender(
    <LocaleProvider initial={locale}>
      <MemoryRouter initialEntries={[path]}>{ui}</MemoryRouter>
    </LocaleProvider>,
  );

beforeEach(() => {
  rpc.mockReset();
  rpc.mockResolvedValue({ data: null, error: null });
});

describe("landing page", () => {
  it("shows the live rulebook version once the public RPC answers", async () => {
    rpc.mockResolvedValue({
      data: { rulebook_version: 5, rules: 9, updated_at: "2026-09-03T17:08:00Z" },
      error: null,
    });
    render(<Landing />);
    await waitFor(() => expect(screen.getByTestId("rulebook-live")).toBeInTheDocument());
    expect(rpc).toHaveBeenCalledWith("public_track_record");
    expect(screen.getByTestId("rulebook-live").textContent).toContain("v5");
    expect(screen.getByTestId("rulebook-live").textContent).toContain("9");
  });

  it("says nothing at all rather than claiming a rulebook that was never revised", async () => {
    rpc.mockResolvedValue({ data: { rulebook_version: 0, rules: 0, updated_at: null }, error: null });
    render(<Landing />);
    await waitFor(() => expect(rpc).toHaveBeenCalled());
    expect(screen.queryByTestId("rulebook-live")).toBeNull();
  });

  it("survives the RPC failing — the page is still the page", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "boom" } });
    render(<Landing />);
    await waitFor(() => expect(rpc).toHaveBeenCalled());
    expect(screen.queryByTestId("rulebook-live")).toBeNull();
    expect(screen.getByText(ja.lp.loopTitle)).toBeInTheDocument();
  });

  it("gives every plan its own call to action, carrying the plan to signup", () => {
    render(<Landing />);
    expect(screen.getAllByText(ja.lp.choosePlan)).toHaveLength(3);
  });
});

describe("the landing page's promises match the product", () => {
  for (const [name, d] of [["ja", ja], ["en", en]] as const) {
    it(`${name}: never quotes a win rate anywhere on the page`, () => {
      // The whole point of the honesty section is that no number is claimed
      // before the sample supports one. A percentage in the sales copy would
      // contradict it on the same screen.
      const copy = JSON.stringify({ ...d.lp, faqs: d.lp.faqs, honestBody: d.lp.honestBody });
      const percentages = copy.match(/\d+(\.\d+)?\s?%/g) ?? [];
      // 95% (the confidence interval) is the only percentage that may appear
      expect(percentages.filter((p) => !p.startsWith("95"))).toEqual([]);
    });

    it(`${name}: does not promise a faster analysis than the FAQ admits`, () => {
      const faqAnswer = d.lp.faqs.find((f) => /10.*15|10.*15/.test(f.a))?.a ?? "";
      expect(faqAnswer).not.toBe("");
      const features = d.lp.features.map((f) => `${f.title} ${f.desc}`).join(" ");
      // "in ten seconds" in a feature card contradicted the FAQ's 10-30s
      expect(features).not.toMatch(/10\s?秒|ten seconds|10 seconds/i);
    });

    it(`${name}: the loop section has exactly the three stages the code runs`, () => {
      expect(d.lp.loopSteps).toHaveLength(3);
      for (const s of d.lp.loopSteps) {
        expect(s.title.length).toBeGreaterThan(0);
        expect(s.desc.length).toBeGreaterThan(20);
      }
    });
  }
});

describe("signup entry points", () => {
  it("opens the signup form when the landing page sends ?tab=signup", () => {
    render(<Login />, "/login?tab=signup");
    // The confirm-password field only exists on the signup form
    expect(screen.getByLabelText(ja.login.confirmPassword)).toBeInTheDocument();
  });

  it("still defaults to signing in for a bare /login", () => {
    render(<Login />, "/login");
    expect(screen.queryByLabelText(ja.login.confirmPassword)).toBeNull();
  });
});
