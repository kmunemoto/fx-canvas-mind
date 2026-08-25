import { describe, it, expect } from "vitest";
import { MIN_PASSWORD_LENGTH, translateSignUpError, validatePassword } from "./password";

describe("MIN_PASSWORD_LENGTH", () => {
  it("matches the configured Supabase minimum", () => {
    expect(MIN_PASSWORD_LENGTH).toBe(9);
  });
});

describe("validatePassword", () => {
  it("accepts a password meeting both rules", () => {
    expect(validatePassword("munekan29x")).toBeNull();
  });

  it("rejects a password that is too short", () => {
    expect(validatePassword("abc12")).toContain(`${MIN_PASSWORD_LENGTH}文字以上`);
  });

  it("rejects a long password with no digit", () => {
    expect(validatePassword("abcdefghij")).toBe("パスワードには英字と数字を両方含めてください");
  });

  it("rejects a long password with no letter", () => {
    expect(validatePassword("1234567890")).toBe("パスワードには英字と数字を両方含めてください");
  });
});

describe("translateSignUpError", () => {
  it("reports the length the server actually requires", () => {
    expect(translateSignUpError("Password should be at least 9 characters.")).toBe(
      "パスワードは9文字以上で入力してください",
    );
    expect(translateSignUpError("Password should be at least 12 characters.")).toBe(
      "パスワードは12文字以上で入力してください",
    );
  });

  it("explains a rejected leaked password", () => {
    expect(
      translateSignUpError("Password is known to be weak and easy to guess, please choose a different one."),
    ).toContain("漏洩");
  });

  it("explains unmet character requirements", () => {
    expect(
      translateSignUpError(
        "Password should contain at least one character of each: abcdefghijklmnopqrstuvwxyz, 0123456789.",
      ),
    ).toContain("英字と数字");
  });

  it("keeps the existing duplicate-email message", () => {
    expect(translateSignUpError("User already registered")).toBe(
      "このメールアドレスは既に登録されています",
    );
  });

  it("falls back to the raw message for anything else", () => {
    expect(translateSignUpError("Signups not allowed for this instance")).toBe(
      "登録エラー: Signups not allowed for this instance",
    );
  });
});
