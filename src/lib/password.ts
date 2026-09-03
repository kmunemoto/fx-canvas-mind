// Keep in sync with the Supabase Auth setting:
// Authentication → Sign In / Providers → Email → Minimum password length.
// The server is the source of truth; this only drives the client-side hint so
// the user is not told "9 characters" while the server rejects at a different
// length.
export const MIN_PASSWORD_LENGTH = 9;

import type { Dict } from "@/lib/i18n/ja";

// The messages come from the caller's dictionary rather than being baked in,
// so these stay pure functions and the rules keep one home.
type PasswordStrings = Dict["password"];

// Mirrors "Password requirements: Letters and digits" in the same Auth setting.
// Validating here only saves a round trip — the server rejects it either way.
export const validatePassword = (password: string, s: PasswordStrings): string | null => {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return s.tooShort(MIN_PASSWORD_LENGTH);
  }

  if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
    return s.needsBoth;
  }

  return null;
};

// Supabase returns sign-up errors in English, and the password rules live in
// the server-side Auth settings, so read the required length out of the
// message rather than hardcoding it here.
export const translateSignUpError = (message: string, s: PasswordStrings): string => {
  if (message.includes("already registered")) {
    return s.alreadyRegistered;
  }

  const lengthMatch = message.match(/at least (\d+) characters/i);
  if (lengthMatch) {
    return s.tooShort(Number(lengthMatch[1]));
  }

  if (/weak|easy to guess|pwned|leaked|compromised/i.test(message)) {
    return s.leaked;
  }

  if (/should contain at least one character of each/i.test(message)) {
    return s.weak;
  }

  return s.signUpOther(message);
};
