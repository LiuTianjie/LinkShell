import { useState, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { LoginPage } from "./pages/LoginPage";
import { DashboardPage } from "./pages/DashboardPage";
import { loadSession } from "./lib/supabase";
import type { Session } from "./lib/supabase";
import "./index.css";

function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const s = loadSession();
    if (s) setSession(s);
    setReady(true);
  }, []);

  if (!ready) return null;

  if (!session) {
    return <LoginPage onLogin={setSession} />;
  }

  return <DashboardPage session={session} onLogout={() => setSession(null)} />;
}

createRoot(document.getElementById("root")!).render(<App />);
