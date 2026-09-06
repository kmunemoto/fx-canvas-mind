import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { supabase } from "@/lib/supabase";
import { translateSignUpError } from "@/lib/password";
import { oauthRedirectTo, type OAuthProvider } from "@/lib/oauth";
import { useT } from "@/lib/i18n";
import type { User, Session } from "@supabase/supabase-js";

interface Profile {
  id: string;
  plan?: string;
  next_billing_date?: string;
  [key: string]: any;
}

interface AuthContextType {
  user: User | null;
  profile: Profile | null;
  loading: boolean;
  signUp: (email: string, password: string) => Promise<{ error: string | null }>;
  signIn: (email: string, password: string) => Promise<{ error: string | null }>;
  // Hands the browser to the provider. On success this function does not
  // return in any useful sense — the page navigates away — so callers should
  // leave their loading state on and only handle the error path.
  signInWithProvider: (provider: OAuthProvider, plan: string | null) => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const useAuth = () => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
};

const fetchProfile = async (userId: string): Promise<Profile | null> => {
  try {
    const { data, error } = await supabase
      .from("profiles")
      .select("*")
      .eq("id", userId)
      .single();
    if (error) {
      console.warn("Profile fetch error:", error.message);
      return null;
    }
    return data;
  } catch {
    return null;
  }
};

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const t = useT();
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let isMounted = true;

    const syncSession = async (session: Session | null) => {
      if (!isMounted) return;

      const nextUser = session?.user ?? null;
      setUser(nextUser);

      if (!nextUser) {
        setProfile(null);
        setLoading(false);
        return;
      }

      const p = await fetchProfile(nextUser.id);

      if (!isMounted) return;

      setProfile(p);
      setLoading(false);
    };

    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (_event, session: Session | null) => {
        void syncSession(session);
      }
    );

    void supabase.auth.getSession().then(({ data: { session } }) => syncSession(session));

    return () => {
      isMounted = false;
      subscription.unsubscribe();
    };
  }, []);

  const signUp = async (email: string, password: string) => {
    const { error } = await supabase.auth.signUp({ email, password });
    if (error) {
      return { error: translateSignUpError(error.message, t.password) };
    }
    return { error: null };
  };

  const signIn = async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      const msg = error.message.includes("Invalid login")
        ? t.errors.signIn
        : t.errors.signInOther(error.message);
      return { error: msg };
    }
    return { error: null };
  };

  // Social sign-in. Supabase redirects to the provider, the provider redirects
  // back to `redirectTo`, and supabase-js picks the session out of the URL —
  // which the existing onAuthStateChange subscription above already handles,
  // so there is no separate callback route to maintain.
  const signInWithProvider = async (provider: OAuthProvider, plan: string | null) => {
    const { error } = await supabase.auth.signInWithOAuth({
      provider,
      options: { redirectTo: oauthRedirectTo(window.location.origin, plan) },
    });
    if (error) {
      // The two failures worth telling apart: the provider is not switched on
      // in Supabase at all, and everything else. The first is a configuration
      // mistake the user can do nothing about, and saying "try again" to it
      // would send them round a loop that cannot succeed.
      const disabled = /provider is not enabled|Unsupported provider/i.test(error.message);
      return { error: disabled ? t.login.providerOff : t.login.providerFailed(error.message) };
    }
    return { error: null };
  };

  const signOut = async () => {
    await supabase.auth.signOut();
    setUser(null);
    setProfile(null);
  };

  return (
    <AuthContext.Provider value={{ user, profile, loading, signUp, signIn, signInWithProvider, signOut }}>
      {children}
    </AuthContext.Provider>
  );
};
