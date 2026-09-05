-- The rulebook reaches clients through rulebook_for_client (SECURITY
-- DEFINER, owned by postgres), which strips supported_by — the analysis_ids
-- of OTHER users' plans — before it answers (20260904100000). The table
-- itself stayed readable by any signed-in user through PostgREST: a SELECT
-- grant to `authenticated` plus a policy `using (true)`, so
-- /rest/v1/rulebook?id=eq.1 returned every rule with every id and the strip
-- was decorative.
--
-- Nothing in the app uses that path. The frontend calls the RPC
-- (src/pages/Index.tsx); analyze reads the table with the service role
-- (supabase/functions/analyze/index.ts, dbAuthorization) and so does
-- postmortem (readRowsOrNull), and the service role is not subject to row
-- level security. The RPCs keep working because a SECURITY DEFINER function
-- reads as its owner, not as the caller.
--
-- Both halves go: dropping only the policy would leave a grant on a table
-- whose RLS then denies every row, which is safe but says the wrong thing
-- about who may read it.
drop policy if exists "Signed-in users can read the rulebook" on public.rulebook;
revoke select on public.rulebook from authenticated;
