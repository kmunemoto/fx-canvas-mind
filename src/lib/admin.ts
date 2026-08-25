// Admin email(s) that bypass all plan/usage restrictions.
// These accounts always get the top plan without any subscription.
export const ADMIN_EMAILS = [
  "k.munemoto@kyoto-salute.com",
  "munekan2989@gmail.com",
];

// Plan granted to admin accounts regardless of billing status
export const ADMIN_PLAN = "Pro";

export const isAdminEmail = (email?: string | null): boolean =>
  !!email && ADMIN_EMAILS.includes(email.toLowerCase());

// Display name of the plan a user is effectively on
export const resolvePlanName = (email?: string | null, plan?: string | null): string => {
  if (isAdminEmail(email)) return ADMIN_PLAN;
  if (!plan) return "Free";
  return plan.charAt(0).toUpperCase() + plan.slice(1).toLowerCase();
};
