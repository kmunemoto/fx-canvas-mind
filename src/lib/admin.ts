// Admin email(s) that bypass all plan/usage restrictions
export const ADMIN_EMAILS = ["k.munemoto@kyoto-salute.com"];

export const isAdminEmail = (email?: string | null): boolean =>
  !!email && ADMIN_EMAILS.includes(email.toLowerCase());
