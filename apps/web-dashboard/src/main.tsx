import { useState, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { LoginPage } from "./pages/LoginPage";
import { SessionListPage } from "./pages/SessionListPage";
import { AgentConsolePage } from "./pages/AgentConsolePage";
import { loadSession } from "./lib/supabase";
import type { Session } from "./lib/supabase";
import { loadView, saveView, type AppView } from "./lib/storage";
import { initTheme } from "./lib/theme";
import "./index.css";

initTheme();

function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  // Login is OPTIONAL — it just lets Pro users see their sessions without
  // scanning a code. Shown on demand, not as a gate.
  const [showLogin, setShowLogin] = useState(false);
  // Restore the last view so a refresh keeps you in the console you were in.
  const [view, setViewState] = useState<AppView>(() => loadView());

  const setView = (next: AppView) => {
    setViewState(next);
    saveView(next);
  };

  useEffect(() => {
    const s = loadSession();
    if (s) setSession(s);
    setReady(true);
  }, []);

  if (!ready) return null;

  if (showLogin) {
    return (
      <LoginPage
        onLogin={(s) => {
          setSession(s);
          setShowLogin(false);
        }}
        onCancel={() => setShowLogin(false)}
      />
    );
  }

  if (view.name === "console") {
    return (
      <AgentConsolePage
        sessionId={view.sessionId}
        session={session}
        onBack={() => setView({ name: "list" })}
      />
    );
  }

  return (
    <SessionListPage
      session={session}
      onLogin={() => setShowLogin(true)}
      onLogout={() => {
        setSession(null);
        setView({ name: "list" });
      }}
      onOpenSession={(sessionId) => setView({ name: "console", sessionId })}
    />
  );
}

createRoot(document.getElementById("root")!).render(<App />);
