// Keep in sync with the Supabase Auth setting:
// Authentication → Sign In / Providers → Email → Minimum password length.
// The server is the source of truth; this only drives the client-side hint so
// the user is not told "9 characters" while the server rejects at a different
// length.
export const MIN_PASSWORD_LENGTH = 9;

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
