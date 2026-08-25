// Keep in sync with the Supabase Auth setting:
// Authentication → Sign In / Providers → Email → Minimum password length.
// The server is the source of truth; this only drives the client-side hint so
// the user is not told "9 characters" while the server rejects at a different
// length.
export const MIN_PASSWORD_LENGTH = 9;

// Mirrors "Password requirements: Letters and digits" in the same Auth setting.
// Validating here only saves a round trip — the server rejects it either way.
export const validatePassword = (password: string): string | null => {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `パスワードは${MIN_PASSWORD_LENGTH}文字以上で入力してください`;
  }

  if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
    return "パスワードには英字と数字を両方含めてください";
  }

  return null;
};

// Supabase returns sign-up errors in English, and the password rules live in
// the server-side Auth settings, so read the required length out of the
// message rather than hardcoding it here.
export const translateSignUpError = (message: string): string => {
  if (message.includes("already registered")) {
    return "このメールアドレスは既に登録されています";
  }

  const lengthMatch = message.match(/at least (\d+) characters/i);
  if (lengthMatch) {
    return `パスワードは${lengthMatch[1]}文字以上で入力してください`;
  }

  if (/weak|easy to guess|pwned|leaked|compromised/i.test(message)) {
    return "このパスワードは過去に漏洩したものとして知られています。別のパスワードを設定してください";
  }

  if (/should contain at least one character of each/i.test(message)) {
    return "パスワードに英字と数字（設定によっては記号）を混ぜてください";
  }

  return `登録エラー: ${message}`;
};
