import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { Zap, Loader2, AlertCircle } from "lucide-react";

const Login = () => {
  const { signIn, signUp } = useAuth();
  const navigate = useNavigate();
  const [isSignUp, setIsSignUp] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [successMsg, setSuccessMsg] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSuccessMsg("");

    if (!email || !password) {
      setError("メールアドレスとパスワードを入力してください");
      return;
    }

    if (isSignUp) {
      if (password.length < 6) {
        setError("パスワードは6文字以上で入力してください");
        return;
      }
      if (password !== confirmPassword) {
        setError("パスワードが一致しません");
        return;
      }
    }

    setLoading(true);
    const result = isSignUp
      ? await signUp(email, password)
      : await signIn(email, password);

    if (result.error) {
      setError(result.error);
    } else if (isSignUp) {
      setSuccessMsg("確認メールを送信しました。メールを確認してください。");
    } else {
      navigate("/");
    }
    setLoading(false);
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
            {isSignUp ? "アカウントを作成" : "ログインして開始"}
          </p>
        </div>

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
            <label className="text-sm text-muted-foreground">メールアドレス</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              className="w-full mt-1 px-3 py-2 bg-secondary rounded-lg border border-border text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>

          <div>
            <label className="text-sm text-muted-foreground">パスワード</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="6文字以上"
              className="w-full mt-1 px-3 py-2 bg-secondary rounded-lg border border-border text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>

          {isSignUp && (
            <div>
              <label className="text-sm text-muted-foreground">パスワード確認</label>
              <input
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="もう一度入力"
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
            {isSignUp ? "アカウント作成" : "ログイン"}
          </button>

          <p className="text-center text-sm text-muted-foreground">
            {isSignUp ? "既にアカウントをお持ちですか？" : "アカウントをお持ちでないですか？"}
            <button
              type="button"
              onClick={() => {
                setIsSignUp(!isSignUp);
                setError("");
                setSuccessMsg("");
              }}
              className="ml-1 text-primary hover:underline"
            >
              {isSignUp ? "ログイン" : "アカウント作成"}
            </button>
          </p>
        </form>

        {isSignUp && (
          <p className="text-[10px] text-muted-foreground text-center leading-relaxed">
            アカウント作成により、<Link to="/terms" className="text-primary hover:underline">利用規約</Link>と<Link to="/privacy" className="text-primary hover:underline">プライバシーポリシー</Link>に同意したものとみなされます。
          </p>
        )}

        <p className="text-[10px] text-muted-foreground text-center leading-relaxed">
          本アプリの分析結果はAIによる参考情報であり、投資助言ではありません。
        </p>
      </div>
    </div>
  );
};

export default Login;
