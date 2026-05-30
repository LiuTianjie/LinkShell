import { useState, type FormEvent } from "react";
import { signIn, signUp } from "../lib/supabase";
import { BrandLogo } from "../components/icons";
import type { Session } from "../lib/supabase";

export function LoginPage({ onLogin, onCancel }: { onLogin: (s: Session) => void; onCancel?: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const handleSignIn = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const result = await signIn(email, password);
    setLoading(false);
    if (result.error) setError(result.error);
    else if (result.session) onLogin(result.session);
  };

  const handleSignUp = async () => {
    setLoading(true);
    setError(null);
    setMessage(null);
    const result = await signUp(email, password);
    setLoading(false);
    if (result.error) setError(result.error);
    else if (result.session) onLogin(result.session);
    else setMessage("请查收邮件以确认账户。");
  };

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center">
          <div className="mx-auto mb-3 flex items-center justify-center">
            <BrandLogo size={56} />
          </div>
          <h1 className="font-mono text-xl font-bold text-content-primary">LinkShell</h1>
          <p className="mt-1 text-sm text-content-muted">登录以连接你的 agent 会话</p>
        </div>
        <form onSubmit={handleSignIn} className="space-y-3">
          <input
            type="email"
            placeholder="邮箱"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            className="codex-input"
            autoComplete="email"
          />
          <input
            type="password"
            placeholder="密码"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={6}
            className="codex-input"
            autoComplete="current-password"
          />
          {error && <p className="text-sm text-danger">{error}</p>}
          {message && <p className="text-sm text-success">{message}</p>}
          <button type="submit" disabled={loading} className="codex-btn-primary w-full">
            {loading ? "…" : "登录"}
          </button>
          <button
            type="button"
            onClick={handleSignUp}
            disabled={loading || !email || !password}
            className="codex-btn-outline w-full"
          >
            创建账户
          </button>
          {onCancel && (
            <button type="button" onClick={onCancel} className="codex-btn-ghost w-full">
              暂不登录，用配对码连接
            </button>
          )}
        </form>
        <p className="text-center text-2xs text-content-faint">
          登录可选 · Pro 账户登录后免扫码直接看到自己的会话
        </p>
      </div>
    </div>
  );
}
