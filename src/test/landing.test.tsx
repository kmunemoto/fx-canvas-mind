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
import Pricing from "../pages/Pricing";

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
  it("#139: sells the chart and the emails — the analysis's learning loop is gone, and so is its RPC", () => {
    render(<Landing />);
    expect(screen.getByTestId("lp-honest").textContent).toContain(ja.lp.honestTitle);
    expect(rpc).not.toHaveBeenCalled();
    expect(screen.queryByTestId("rulebook-live")).toBeNull();
  });

  it("#139: two plans — Free starts the signup, Light carries its plan to it; no Standard or Pro", () => {
    render(<Landing />);
    expect(screen.getAllByText(ja.lp.choosePlan)).toHaveLength(1);
    expect(screen.getByText("Free")).toBeInTheDocument();
    expect(screen.getByText("Light")).toBeInTheDocument();
    expect(screen.queryByText("Standard")).toBeNull();
    expect(screen.queryByText("Pro")).toBeNull();
  });
});

describe("the landing page's promises match the product", () => {
  for (const [name, d] of [["ja", ja], ["en", en]] as const) {
    it(`${name}: never quotes a win rate anywhere on the page`, () => {
      // The whole point of the honesty section is that no number is claimed
      // on the sales page. A percentage in the copy would contradict it on
      // the same screen.
      const copy = JSON.stringify({ ...d.lp, faqs: d.lp.faqs, honestBody: d.lp.honestBody });
      const percentages = copy.match(/\d+(\.\d+)?\s?%/g) ?? [];
      expect(percentages).toEqual([]);
    });

    it(`${name}: #139: promises no analysis, which came off the screen`, () => {
      const copy = JSON.stringify({ lp: d.lp, pricing: d.pricing.features, index: [d.index.upgradeTitle, d.index.upgradeBody, d.index.disclaimer] });
      expect(copy).not.toMatch(name === "ja" ? /分析|AI/ : /analys|\bAI\b/i);
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

  it("carries the plan picked on the landing page through to pricing", () => {
    render(<Pricing />, "/pricing?plan=light");
    expect(screen.getByTestId("chosen-plan").textContent).toContain("Light");
  });

  it("#139: pricing offers Free and Light only", () => {
    render(<Pricing />, "/pricing");
    expect(screen.getByTestId("pricing-free").textContent).toBe(ja.pricing.freeIncluded);
    expect(screen.getAllByText(ja.pricing.subscribe)).toHaveLength(1);
    expect(screen.queryByText("Standard")).toBeNull();
    expect(screen.queryByText("Pro")).toBeNull();
  });

  it("marks nothing when no plan was picked", () => {
    render(<Pricing />, "/pricing");
    expect(screen.queryByTestId("chosen-plan")).toBeNull();
  });
});
