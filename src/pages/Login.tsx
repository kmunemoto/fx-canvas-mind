import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { OAUTH_PROVIDERS, type OAuthProvider } from "@/lib/oauth";
import { MIN_PASSWORD_LENGTH, validatePassword } from "@/lib/password";
import { Zap, Loader2, AlertCircle } from "lucide-react";
import { useT } from "@/lib/i18n";

// Drawn inline rather than fetched: a sign-in button that waits on a request
// to another origin is a sign-in button that can render blank.
const GoogleMark = () => (
  <svg className="h-4 w-4" viewBox="0 0 48 48" aria-hidden="true">
    <path fill="#4285F4" d="M45.1 24.5c0-1.6-.1-3.1-.4-4.5H24v8.5h11.8c-.5 2.7-2 5-4.4 6.6v5.5h7.1c4.1-3.8 6.6-9.4 6.6-16.1z" />
    <path fill="#34A853" d="M24 46c5.9 0 10.9-2 14.5-5.4l-7.1-5.5c-2 1.3-4.5 2.1-7.4 2.1-5.7 0-10.5-3.8-12.2-9H4.5v5.7C8.1 41.1 15.4 46 24 46z" />
    <path fill="#FBBC05" d="M11.8 28.2c-.4-1.3-.7-2.7-.7-4.2s.2-2.9.7-4.2v-5.7H4.5C3 17.1 2.1 20.4 2.1 24s.9 6.9 2.4 9.9l7.3-5.7z" />
    <path fill="#EA4335" d="M24 10.8c3.2 0 6.1 1.1 8.4 3.3l6.3-6.3C34.9 4.2 29.9 2 24 2 15.4 2 8.1 6.9 4.5 14.1l7.3 5.7c1.7-5.2 6.5-9 12.2-9z" />
  </svg>
);

const Login = () => {
  const t = useT();
  const { signIn, signUp, signInWithProvider } = useAuth();
  // Every call to action on the landing page links here with ?tab=signup.
  // Until this read it, a first-time visitor pressing the big blue button was
  // shown the sign-IN form and asked for a password they had never set.
  const [params] = useSearchParams();
  const [isSignUp, setIsSignUp] = useState(params.get("tab") === "signup");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [successMsg, setSuccessMsg] = useState("");

  // The provider takes over the page on success, so the spinner is left
  // running rather than cleared: clearing it would flash an idle button for
  // the moment before the browser navigates, which reads as "nothing
  // happened" and invites a second press.
  const [oauthBusy, setOauthBusy] = useState<OAuthProvider | null>(null);

  const handleProvider = async (provider: OAuthProvider) => {
    setError("");
    setSuccessMsg("");
    setOauthBusy(provider);
    const result = await signInWithProvider(provider, params.get("plan"));
    if (result.error) {
      setError(result.error);
      setOauthBusy(null);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSuccessMsg("");

    if (!email || !password) {
      setError(t.login.bothRequired);
      return;
    }

    if (isSignUp) {
      const passwordError = validatePassword(password, t.password);
      if (passwordError) {
        setError(passwordError);
        return;
      }
      if (password !== confirmPassword) {
        setError(t.login.mismatch);
        return;
      }
    }

    setLoading(true);

    try {
      if (isSignUp) {
        const result = await signUp(email, password);

        if (result.error) {
          setError(result.error);
          return;
        }

        setSuccessMsg(t.login.created);
        // Analysis is paid-only, so the dashboard has nothing a new account can
        // do yet. Send them to the plans instead, keeping the one they picked
        // on the landing page.
        const plan = params.get("plan");
        window.location.href = plan ? `/pricing?plan=${encodeURIComponent(plan)}` : "/pricing";
        return;
      }

      const result = await signIn(email, password);

      if (result.error) {
        setError(result.error);
        return;
      }

      window.location.href = "/";
    } catch (err: any) {
      setError(err?.message || t.login.genericError);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm space-y-8">
        {/* Logo */}
        <div className="text-center space-y-2">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-primary/10 border border-primary/20 mb-2">
            <Zap className="h-7 w-7 text-primary" />
          </div>
          <h1 className="text-2xl font-bold text-foreground tracking-tight">
            FX Tactical Analyzer
          </h1>
          <p className="text-sm text-muted-foreground">
            {isSignUp ? t.login.createAccount : t.login.signInToStart}
          </p>
        </div>

        {/* Social sign-in, above the form: it is the shorter path, and a person
            who has one of these does not need to read the password rules
            underneath to find that out. */}
        {OAUTH_PROVIDERS.length > 0 && (
          <div className="space-y-2">
            {OAUTH_PROVIDERS.map((provider) => (
              <button
                key={provider}
                type="button"
                onClick={() => void handleProvider(provider)}
                disabled={oauthBusy !== null || loading}
                className="w-full flex items-center justify-center gap-2 rounded-lg border border-border bg-secondary/40 px-4 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-secondary disabled:opacity-60"
                data-testid={`oauth-${provider}`}
              >
                {oauthBusy === provider
                  ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  : <GoogleMark />}
                {provider === "google" ? t.login.withGoogle : t.login.withApple}
              </button>
            ))}
            <p className="text-[11px] text-muted-foreground text-center">{t.login.socialNote}</p>
            <div className="flex items-center gap-3 pt-1">
              <span className="h-px flex-1 bg-border" />
              <span className="text-[11px] text-muted-foreground">{t.login.orContinueWith}</span>
              <span className="h-px flex-1 bg-border" />
            </div>
          </div>
        )}

        {/* Form */}
        <form onSubmit={handleSubmit} className="glass rounded-xl border border-border p-6 space-y-4">
          {error && (
            <div className="flex items-start gap-2 p-3 rounded-lg bg-destructive/10 border border-destructive/20">
              <AlertCircle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
              <p className="text-sm text-destructive">{error}</p>
            </div>
          )}

          {successMsg && (
            <div className="p-3 rounded-lg bg-primary/10 border border-primary/20">
              <p className="text-sm text-primary">{successMsg}</p>
            </div>
          )}

          <div>
            <label htmlFor="login-email" className="text-sm text-muted-foreground">{t.login.email}</label>
            <input
              id="login-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              className="w-full mt-1 px-3 py-2 bg-secondary rounded-lg border border-border text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>

          <div>
            <label htmlFor="login-password" className="text-sm text-muted-foreground">{t.login.password}</label>
            <input
              id="login-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={t.login.passwordPlaceholder(MIN_PASSWORD_LENGTH)}
              className="w-full mt-1 px-3 py-2 bg-secondary rounded-lg border border-border text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>

          {isSignUp && (
            <div>
              <label htmlFor="login-confirm" className="text-sm text-muted-foreground">{t.login.confirmPassword}</label>
              <input
                id="login-confirm"
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder={t.login.confirmPlaceholder}
                className="w-full mt-1 px-3 py-2 bg-secondary rounded-lg border border-border text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full py-2.5 rounded-lg bg-primary text-primary-foreground font-semibold text-sm hover:bg-primary/90 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {loading && <Loader2 className="h-4 w-4 animate-spin" />}
            {isSignUp ? t.login.submitSignUp : t.login.submitSignIn}
          </button>

          <p className="text-center text-sm text-muted-foreground">
            {isSignUp ? t.login.haveAccount : t.login.noAccount}
            <button
              type="button"
              onClick={() => {
                setIsSignUp(!isSignUp);
                setError("");
                setSuccessMsg("");
              }}
              className="ml-1 text-primary hover:underline"
            >
              {isSignUp ? t.login.submitSignIn : t.login.submitSignUp}
            </button>
          </p>
        </form>

        {isSignUp && (
          <p className="text-[10px] text-muted-foreground text-center leading-relaxed">
            {t.login.consentBefore}<Link to="/terms" className="text-primary hover:underline">{t.landing.terms}</Link>{t.login.consentMiddle}<Link to="/privacy" className="text-primary hover:underline">{t.landing.privacy}</Link>{t.login.consentAfter}
          </p>
        )}

        <p className="text-[10px] text-muted-foreground text-center leading-relaxed">
          {t.login.disclaimer}
        </p>
      </div>
    </div>
  );
};

export default Login;
