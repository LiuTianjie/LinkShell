import { useState, FormEvent } from "react";
import { signIn, signUp } from "../lib/supabase";
import type { Session } from "../lib/supabase";

export function LoginPage({ onLogin }: { onLogin: (s: Session) => void }) {
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
    else setMessage("Check your email to confirm your account.");
  };

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center">
          <h1 className="text-2xl font-bold">LinkShell</h1>
          <p className="text-gray-400 mt-1">Sign in to your account</p>
        </div>
        <form onSubmit={handleSignIn} className="space-y-4">
          <input
            type="email"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            className="w-full px-4 py-2.5 rounded-lg bg-gray-900 border border-gray-700 text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
          />
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={6}
            className="w-full px-4 py-2.5 rounded-lg bg-gray-900 border border-gray-700 text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
          />
          {error && <p className="text-red-400 text-sm">{error}</p>}
          {message && <p className="text-green-400 text-sm">{message}</p>}
          <button
            type="submit"
            disabled={loading}
            className="w-full py-2.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-medium disabled:opacity-50 transition"
          >
            {loading ? "..." : "Sign In"}
          </button>
          <button
            type="button"
            onClick={handleSignUp}
            disabled={loading || !email || !password}
            className="w-full py-2.5 rounded-lg border border-gray-600 hover:border-gray-500 text-gray-300 font-medium disabled:opacity-50 transition"
          >
            Create Account
          </button>
        </form>
      </div>
    </div>
  );
}
