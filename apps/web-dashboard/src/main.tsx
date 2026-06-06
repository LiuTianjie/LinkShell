import { useState, useEffect, useMemo } from "react";
import { createRoot } from "react-dom/client";
import { LoginPage } from "./pages/LoginPage";
import { SessionListPage } from "./pages/SessionListPage";
import { AgentConsolePage } from "./pages/AgentConsolePage";
import { loadSession, getValidSession, onAuthExpired } from "./lib/supabase";
import type { Session } from "./lib/supabase";
import { loadView, saveView, type AppView } from "./lib/storage";
import { initTheme, setThemePref } from "./lib/theme";
import {
  readEmbedBootstrap,
  applyEmbedBootstrap,
  postRequestCloseToHost,
  isEmbedded,
} from "./lib/embed";
import "./index.css";

initTheme();

function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  // Login is OPTIONAL — it just lets Pro users see their sessions without
  // scanning a code. Shown on demand, not as a gate.
  const [showLogin, setShowLogin] = useState(false);
  // Embedded boot (mobile WebView): seed gateway/token/theme from the query
  // string and jump straight to the console, skipping login + session list.
  // Returns null on plain web → falls back to the restored view below.
  const embedView = useMemo(() => applyEmbedBootstrap(readEmbedBootstrap()), []);
  // Read the PERSISTED embed flag (not just the query string): the query is
  // dropped on reload/pull-to-refresh, but the native host seeds a localStorage
  // flag that survives, so the app stays embed-aware across reloads.
  const isEmbed = useMemo(() => isEmbedded(), []);
  // Restore the last view so a refresh keeps you in the console you were in.
  const [view, setViewState] = useState<AppView>(() => embedView ?? loadView());

  const setView = (next: AppView) => {
    setViewState(next);
    saveView(next);
  };

  useEffect(() => {
    // Seed synchronously from storage so a returning user paints as logged-in
    // instantly, then validate in the background: getValidSession refreshes a
    // near-expiry token and, if the refresh token is dead, clears the session
    // and fires onAuthExpired (handled below). This is what stops a stale
    // credential from reaching the gateway and 401-ing.
    const stored = loadSession();
    if (stored) setSession(stored);
    setReady(true);
    if (stored) {
      getValidSession().then((valid) => {
        if (valid) setSession(valid);
      });
    }
  }, []);

  // Embedded only: expose a hook the native host calls (via injectJavaScript)
  // when the user flips the app's theme while the WebView is mounted, so the
  // embedded console re-themes live instead of only at boot.
  useEffect(() => {
    if (!isEmbed) return;
    const w = window as unknown as {
      __linkshellSetTheme?: (mode: "dark" | "light") => void;
    };
    w.__linkshellSetTheme = (mode) => {
      if (mode === "dark" || mode === "light") setThemePref(mode);
    };
    return () => {
      delete w.__linkshellSetTheme;
    };
  }, [isEmbed]);

  // When a refresh token is definitively rejected, the session was already
  // cleared from storage — drop it from state and bounce back to the home list
  // so a Pro user isn't left on a logged-in view sending a dead credential.
  useEffect(() => {
    return onAuthExpired(() => {
      setSession(null);
      setShowLogin(false);
      setViewState((v) => (v.name === "list" ? v : { name: "list" }));
      saveView({ name: "list" });
    });
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
        onBack={isEmbed ? postRequestCloseToHost : () => setView({ name: "list" })}
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
