import { describe, it, expect } from "vitest";
import { ADMIN_EMAILS, isAdminEmail, resolvePlanName } from "./admin";

describe("isAdminEmail", () => {
  it("recognizes every configured admin email", () => {
    for (const email of ADMIN_EMAILS) {
      expect(isAdminEmail(email)).toBe(true);
    }
  });

  it("is case insensitive", () => {
    expect(isAdminEmail("Munekan2989@Gmail.com")).toBe(true);
  });

  it("rejects non-admin and empty values", () => {
    expect(isAdminEmail("someone@example.com")).toBe(false);
    expect(isAdminEmail(null)).toBe(false);
    expect(isAdminEmail(undefined)).toBe(false);
    expect(isAdminEmail("")).toBe(false);
  });
});

describe("resolvePlanName", () => {
  it("gives admins the top plan even without a subscription", () => {
    expect(resolvePlanName("munekan2989@gmail.com", null)).toBe("Pro");
    expect(resolvePlanName("munekan2989@gmail.com", "free")).toBe("Pro");
  });

  it("capitalizes the stored plan for regular users", () => {
    expect(resolvePlanName("someone@example.com", "standard")).toBe("Standard");
  });

  it("falls back to Free when no plan is stored", () => {
    expect(resolvePlanName("someone@example.com", null)).toBe("Free");
  });
});
