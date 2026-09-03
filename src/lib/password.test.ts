import { describe, it, expect } from "vitest";
import { MIN_PASSWORD_LENGTH, translateSignUpError, validatePassword } from "./password";
import { ja } from "@/lib/i18n/ja";
import { en } from "@/lib/i18n/en";

const JA = ja.password;

describe("MIN_PASSWORD_LENGTH", () => {
  it("matches the configured Supabase minimum", () => {
    expect(MIN_PASSWORD_LENGTH).toBe(9);
  });
});

describe("validatePassword", () => {
  it("accepts a password meeting both rules", () => {
    expect(validatePassword("munekan29x", JA)).toBeNull();
  });

  it("rejects a password that is too short", () => {
    expect(validatePassword("abc12", JA)).toContain(`${MIN_PASSWORD_LENGTH}文字以上`);
  });

  it("rejects a long password with no digit", () => {
    expect(validatePassword("abcdefghij", JA)).toBe("パスワードには英字と数字を両方含めてください");
  });

  it("rejects a long password with no letter", () => {
    expect(validatePassword("1234567890", JA)).toBe("パスワードには英字と数字を両方含めてください");
  });
});

describe("translateSignUpError", () => {
  it("reports the length the server actually requires", () => {
    expect(translateSignUpError("Password should be at least 9 characters.", JA)).toBe(
      "パスワードは9文字以上で入力してください",
    );
    expect(translateSignUpError("Password should be at least 12 characters.", JA)).toBe(
      "パスワードは12文字以上で入力してください",
    );
  });

  it("explains a rejected leaked password", () => {
    expect(
      translateSignUpError("Password is known to be weak and easy to guess, please choose a different one.", JA),
    ).toContain("漏洩");
  });

  it("explains unmet character requirements", () => {
    expect(
      translateSignUpError(
        "Password should contain at least one character of each: abcdefghijklmnopqrstuvwxyz, 0123456789.", JA),
    ).toContain("英字と数字");
  });

  it("keeps the existing duplicate-email message", () => {
    expect(translateSignUpError("User already registered", JA)).toBe(
      "このメールアドレスは既に登録されています",
    );
  });

  it("falls back to the raw message for anything else", () => {
    expect(translateSignUpError("Signups not allowed for this instance", JA)).toBe(
      "登録エラー: Signups not allowed for this instance",
    );
  });
});

describe("password messages in other locales", () => {
  it("reports the same failures in English", () => {
    expect(validatePassword("abc12", en.password)).toBe(
      `Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
    );
    expect(validatePassword("abcdefghij", en.password)).toBe(
      "Password must contain both letters and digits",
    );
    expect(validatePassword("munekan29x", en.password)).toBeNull();
  });

  it("still reads the required length out of the server message", () => {
    expect(translateSignUpError("Password should be at least 12 characters.", en.password)).toBe(
      "Password must be at least 12 characters",
    );
  });
});
