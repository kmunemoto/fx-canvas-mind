// Which social providers the sign-in page offers.
//
// This list is a GATE, not a wish list. A provider appears here only once it
// is enabled in the Supabase dashboard and its credentials are saved: a button
// for a provider Supabase does not know about is a button that fails when
// pressed, and it fails on the sign-in page — the one screen where a person
// has no way to tell "the app is broken" from "I did something wrong".
//
// Google shipped first because the whole path is shared — the callback URL,
// the redirect allow-list, and the account linking — and proving it once on
// the cheap provider is worth more than shipping two at once.
//
// Apple is deliberately NOT here yet. It needs a paid Developer Program
// membership, a Services ID, a .p8 key, and a client secret that EXPIRES every
// six months, which is a recurring operational job rather than a one-off
// setup. It goes in when that is done and verified, not before.
export const OAUTH_PROVIDERS = ["google"] as const;

export type OAuthProvider = typeof OAUTH_PROVIDERS[number];

// Where Supabase sends the browser back to once the provider is done.
//
// Must be inside the Redirect URLs allow-list in the Supabase dashboard, or
// the round trip ends on an error page instead of the app. The plan a visitor
// picked on the landing page is carried through, so someone who pressed "start
// with the standard plan" and signed in with Google lands where the same
// person signing up by email would.
export const oauthRedirectTo = (origin: string, plan: string | null): string =>
  plan ? `${origin}/pricing?plan=${encodeURIComponent(plan)}` : `${origin}/`;
