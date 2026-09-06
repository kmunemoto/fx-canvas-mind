import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { render as rtlRender, screen, fireEvent } from "@testing-library/react";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { LocaleProvider } from "../lib/i18n";
import { OAUTH_PROVIDERS, oauthRedirectTo } from "../lib/oauth";

const authContext = readFileSync("src/contexts/AuthContext.tsx", "utf8");
const loginPage = readFileSync("src/pages/Login.tsx", "utf8");

describe("which providers the sign-in page offers", () => {
  it("offers only providers that are switched on in Supabase", () => {
    // The list is a gate, not a wish list: a button for a provider Supabase
    // does not know about fails when pressed, on the one screen where a person
    // cannot tell "the app is broken" from "I did something wrong".
    expect([...OAUTH_PROVIDERS]).toEqual(["google"]);
  });

  it("does not offer Apple until its recurring setup is actually done", () => {
    // Paid membership, Services ID, .p8 key, and a client secret that expires
    // every six months. It goes in when that is done and verified.
    expect([...OAUTH_PROVIDERS]).not.toContain("apple");
  });
});

describe("where the provider sends the browser back", () => {
  it("returns to the app root by default", () => {
    expect(oauthRedirectTo("https://fx-canvas-mind.lovable.app", null))
      .toBe("https://fx-canvas-mind.lovable.app/");
  });

  it("carries the plan the visitor picked on the landing page", () => {
    // Someone who pressed "start with this plan" and chose Google should land
    // where the same person signing up by email lands.
    expect(oauthRedirectTo("https://fx-canvas-mind.lovable.app", "standard"))
      .toBe("https://fx-canvas-mind.lovable.app/pricing?plan=standard");
  });

  it("escapes the plan rather than pasting it into a URL", () => {
    expect(oauthRedirectTo("https://x.app", "a b&c=d")).toBe("https://x.app/pricing?plan=a%20b%26c%3Dd");
  });

  it("builds an absolute URL, which is what the allow-list matches on", () => {
    // A relative redirectTo is rejected by Supabase against the Redirect URLs
    // list and the round trip ends on an error page instead of the app.
    for (const plan of [null, "standard"]) {
      expect(oauthRedirectTo("http://localhost:8080", plan)).toMatch(/^http:\/\/localhost:8080\//);
    }
  });
});

describe("the sign-in call", () => {
  it("goes through signInWithOAuth with an explicit redirect", () => {
    expect(authContext).toContain("supabase.auth.signInWithOAuth({");
    expect(authContext).toContain("redirectTo: oauthRedirectTo(window.location.origin, plan)");
  });

  it("needs no callback route, because the existing listener already handles it", () => {
    // supabase-js reads the session out of the URL and onAuthStateChange fires;
    // a separate /auth/callback page would be a second thing to keep in step.
    expect(authContext).toContain("supabase.auth.onAuthStateChange(");
  });

  it("tells a provider that is switched off apart from every other failure", () => {
    // "Try again" on a configuration mistake sends someone round a loop that
    // cannot succeed.
    expect(authContext).toContain("provider is not enabled|Unsupported provider");
    expect(authContext).toContain("t.login.providerOff");
  });

  it("keeps the spinner running, because the page is about to navigate away", () => {
    // Clearing it would flash an idle button and invite a second press.
    const handler = loginPage.slice(loginPage.indexOf("const handleProvider"), loginPage.indexOf("const handleSubmit"));
    expect(handler).toContain("setOauthBusy(provider)");
    // Cleared on the error path only
    expect(handler.match(/setOauthBusy\(null\)/g) ?? []).toHaveLength(1);
    expect(handler).toContain("if (result.error)");
  });

  it("draws the provider mark inline instead of fetching it", () => {
    // A sign-in button that waits on another origin can render blank.
    expect(loginPage).toContain("const GoogleMark = ()");
    expect(loginPage).not.toMatch(/<img[^>]+google/i);
  });
});

describe("what the sign-in page tells the reader", () => {
  const render = (ui: ReactElement, locale: "ja" | "en" = "ja") =>
    rtlRender(<LocaleProvider initial={locale}>{ui}</LocaleProvider>);

  it("says that a matching address signs you into the account you already have", async () => {
    // The single most likely worry: "will this make me a second account and
    // lose what I paid for?"
    const { ja } = await import("../lib/i18n/ja");
    const { en } = await import("../lib/i18n/en");
    expect(ja.login.socialNote).toContain("同じアカウント");
    expect(en.login.socialNote).toContain("same account");
  });

  it("has both locales in step", async () => {
    const { ja } = await import("../lib/i18n/ja");
    const { en } = await import("../lib/i18n/en");
    for (const key of ["orContinueWith", "withGoogle", "withApple", "providerOff", "socialNote"] as const) {
      expect(typeof en.login[key], key).toBe(typeof ja.login[key]);
    }
    // The English strings must carry no Japanese
    for (const key of ["orContinueWith", "withGoogle", "withApple", "providerOff", "socialNote"] as const) {
      expect(String(en.login[key]), key).not.toMatch(/[ぁ-んァ-ン一-龥]/);
    }
  });
});
