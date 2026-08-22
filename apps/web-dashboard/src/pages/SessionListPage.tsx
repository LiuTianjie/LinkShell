import { useEffect, useState, useCallback } from "react";
import { signOut, isPro } from "../lib/supabase";
import type { Session } from "../lib/supabase";
import { loadGatewayConfig, saveGatewayUrl } from "../lib/gateway-config";
import { claimPairing, listSessions, listMySessions } from "../lib/gateway-api";
import { getDeviceToken } from "../lib/device-token";
import { loadKnownSessions, rememberSessions, forgetSession, markAllOffline } from "../lib/storage";
import { connectPresenceWatcher, type PresenceLiveState } from "../lib/presence-client";
import { BrandLogo, IconClose, IconChevronRight, IconPlus, IconRefresh, ProviderIcon } from "../components/icons";
import {
  attentionStatus,
  sessionHeadline,
  sessionStory,
  sessionUrgency,
} from "../lib/agent-presence";
import type { SessionSummary } from "../lib/types";

export function SessionListPage({
  session,
  onLogin,
  onLogout,
  onOpenSession,
}: {
  session: Session | null;
  onLogin: () => void;
  onLogout: () => void;
  onOpenSession: (sessionId: string) => void;
}) {
  const [config, setConfig] = useState(loadGatewayConfig());
  // Gateway URL is committed on blur/Enter (not per keystroke) so the 5s
  // refresh loop never fires requests at half-typed origins.
  const [gatewayInput, setGatewayInput] = useState(config.httpUrl);
  const [gatewayInvalid, setGatewayInvalid] = useState(false);
  // Seed from remembered sessions so "back" shows a clickable list instantly,
  // even before the live /sessions call returns (or if it's momentarily empty).
  const [sessions, setSessions] = useState<SessionSummary[]>(() => loadKnownSessions());
  // Online sessions first (sorted by recency); offline (host gone) ones live in
  // a collapsed group below — still reachable so they can be removed. The full
  // `sessions` state is kept intact so the cache-reconciliation logic
  // (rememberSessions/markAllOffline) still works across refreshes.
  const recency = (s: SessionSummary) => Math.max(s.lastActivity ?? 0, s.agentLastActivity ?? 0);
  const onlineSessions = sessions
    .filter((s) => s.hasHost)
    .sort((a, b) => {
      const urgency = sessionUrgency(a) - sessionUrgency(b);
      if (urgency !== 0) return urgency;
      return recency(b) - recency(a);
    });
  const offlineSessions = sessions.filter((s) => !s.hasHost).sort((a, b) => recency(b) - recency(a));
  // Badge cards with their hostname when sessions span multiple machines.
  const multiHost = new Set(sessions.map((s) => s.hostname).filter(Boolean)).size > 1;
  const [showOffline, setShowOffline] = useState(false);
  const [loading, setLoading] = useState(true);
  const [pairingCode, setPairingCode] = useState("");
  const [claiming, setClaiming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The pairing form is secondary once sessions exist — show it on demand.
  const [showPairing, setShowPairing] = useState(false);
  const [liveState, setLiveState] = useState<PresenceLiveState>("poll");

  const refresh = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoading(true);
    try {
      // Two ownership models, merged: (1) /sessions/mine — sessions the logged-in
      // user owns automatically after `linkshell login` (pro users never pair);
      // (2) /sessions — sessions claimed via a pairing code on this device.
      // allSettled (not all): one endpoint failing (network blip / 401 / timeout)
      // must NOT blank the whole list — we still show whatever the other returns,
      // falling back to remembered sessions so the page never gets stuck loading.
      const [mineRes, ownedRes] = await Promise.allSettled([
        listMySessions(config, session?.accessToken ?? null),
        listSessions(config, {
          deviceToken: getDeviceToken(),
          jwt: session?.accessToken ?? null,
        }),
      ]);
      const mine = mineRes.status === "fulfilled" ? mineRes.value : [];
      const owned = ownedRes.status === "fulfilled" ? ownedRes.value : [];
      const bothFailed = mineRes.status === "rejected" && ownedRes.status === "rejected";
      const byId = new Map<string, SessionSummary>();
      for (const s of [...mine, ...owned]) byId.set(s.id, s);
      const list = [...byId.values()];
      // Reconcile cache against live truth: live results drive hasHost; cached
      // sessions absent from live are marked offline. If BOTH calls failed, keep
      // the remembered list as-is (a transient error shouldn't wipe the view);
      // if live is genuinely empty, mark everything offline (host gone).
      if (bothFailed) {
        setSessions(loadKnownSessions());
      } else {
        setSessions(list.length > 0 ? rememberSessions(list) : markAllOffline());
      }
    } catch {
      // Defensive: never leave the page stuck on "加载中…".
      setSessions(loadKnownSessions());
    } finally {
      setLoading(false);
    }
  }, [config, session?.accessToken]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    return connectPresenceWatcher({
      config,
      deviceToken: getDeviceToken(),
      jwt: session?.accessToken ?? null,
      onState: setLiveState,
      onPresence: (sessionId, patch) => {
        setSessions((prev) => {
          const existing = prev.find((s) => s.id === sessionId);
          if (!existing) {
            void refresh({ silent: true });
            return prev;
          }
          return prev.map((s) =>
            s.id === sessionId
              ? {
                  ...s,
                  ...patch,
                  lastActivity: patch.lastActivity ?? s.lastActivity,
                }
              : s,
          );
        });
      },
    });
  }, [config, session?.accessToken, refresh]);

  useEffect(() => {
    const intervalMs = liveState === "live" ? 30_000 : 8_000;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh({ silent: true });
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [refresh, liveState]);

  const handleClaim = async () => {
    const code = pairingCode.trim();
    if (!/^\d{6}$/.test(code)) {
      setError("请输入 6 位配对码");
      return;
    }
    setClaiming(true);
    setError(null);
    try {
      const { sessionId } = await claimPairing(config, code);
      // Persist the claimed session IMMEDIATELY — independent of /sessions, which
      // often returns empty right after the host connects. Without this the
      // session vanished from the list on return and (being one-shot) locked the
      // user out. The device token is now bound, so this id is definitively ours.
      rememberSessions([
        {
          id: sessionId,
          state: "active",
          hasHost: true,
          clientCount: 1,
          provider: null,
          machineId: null,
          hostname: null,
          platform: null,
          projectName: null,
          cwd: null,
          lastActivity: Date.now(),
        },
      ]);
      setPairingCode("");
      setShowPairing(false);
      void refresh();
      onOpenSession(sessionId);
    } catch (e: any) {
      setError(e.message || "配对失败");
    } finally {
      setClaiming(false);
    }
  };

  const handleForget = (sessionId: string) => {
    setSessions(forgetSession(sessionId));
  };

  // Commit the gateway URL only when it parses as an http(s) origin; called on
  // blur and Enter. Invalid input shows a subtle error state and the committed
  // config (used by the background refresh) stays untouched.
  const commitGatewayUrl = () => {
    const trimmed = gatewayInput.trim().replace(/\/+$/, "");
    if (trimmed === config.httpUrl) {
      setGatewayInvalid(false);
      return;
    }
    let valid = false;
    try {
      const parsed = new URL(trimmed);
      valid = parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
      valid = false;
    }
    if (!valid) {
      setGatewayInvalid(true);
      return;
    }
    setGatewayInvalid(false);
    setGatewayInput(trimmed);
    saveGatewayUrl(trimmed);
    setConfig({ httpUrl: trimmed });
  };

  // One session card. Online cards open the console on click; offline cards
  // (host gone) have no connect action — only 移除 remains.
  const renderCard = (s: SessionSummary) => {
    const story = sessionStory(s, { showHost: multiHost });
    const attention = attentionStatus(s.agentStatus);
    const stripe =
      s.agentStatus === "waiting_permission"
        ? "bg-warning"
        : s.agentStatus === "running"
          ? "bg-accent"
          : s.agentStatus === "error"
            ? "bg-danger"
            : null;
    const storyClass =
      story.tone === "warning"
        ? "text-warning"
        : story.tone === "danger"
          ? "text-danger"
          : "text-content-muted";
    const body = (
      <div className="min-w-0">
        <p className="flex items-center gap-2 text-[15px] font-medium text-content-primary">
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${s.hasHost ? (s.agentStatus === "running" || s.agentStatus === "waiting_permission" ? "bg-accent animate-pulse-dot" : "bg-success") : "bg-content-faint"}`} />
          <span className="truncate">{sessionHeadline(s)}</span>
          {s.agentProvider && (
            <ProviderIcon provider={s.agentProvider} size={12} />
          )}
          {attention && (
            <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-2xs font-medium ${attention.className}`}>
              {attention.pulsing && (
                <span className="h-1.5 w-1.5 rounded-full bg-current animate-pulse-dot" />
              )}
              {attention.text}
            </span>
          )}
        </p>
        <p className={`mt-1 truncate text-2xs ${storyClass}`}>
          {story.text}
        </p>
      </div>
    );
    return (
      <div
        key={s.id}
        className={`codex-card group relative flex items-center justify-between overflow-hidden p-4 transition-colors ${s.hasHost ? "hover:bg-surface-overlay" : "opacity-70"} ${s.agentStatus === "running" ? "border-accent/25" : s.agentStatus === "waiting_permission" ? "border-warning/30" : s.agentStatus === "error" ? "border-danger/25" : ""}`}
      >
        {stripe && (
          <span
            aria-hidden
            className={`absolute inset-y-0 left-0 w-0.5 ${stripe}`}
          />
        )}
        {s.hasHost ? (
          <button
            onClick={() => onOpenSession(s.id)}
            className="flex flex-1 cursor-pointer items-center justify-between text-left"
          >
            {body}
          </button>
        ) : (
          <div className="flex flex-1 items-center justify-between text-left">{body}</div>
        )}
        <div className="flex items-center gap-2 pl-3">
          <button
            onClick={() => handleForget(s.id)}
            className="cursor-pointer rounded-lg p-1.5 text-content-faint opacity-0 transition-colors hover:text-danger group-hover:opacity-100"
            title="从列表移除"
            aria-label="移除会话"
          >
            <IconClose size={14} />
          </button>
          {s.hasHost && <IconChevronRight size={16} className="text-content-faint" />}
        </div>
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-canvas">
      <header
        className="glass-bar sticky top-0 z-10 flex min-h-14 items-center justify-between gap-3 border-b border-border px-4 sm:px-6"
        style={{ paddingTop: "env(safe-area-inset-top)" }}
      >
        <div className="flex shrink-0 items-center gap-2.5">
          <BrandLogo size={26} />
          <h1 className="font-mono text-[15px] font-semibold text-content-primary">LinkShell</h1>
        </div>
        <div className="flex min-w-0 items-center gap-2 sm:gap-3">
          {isPro(session) && (
            <span className="shrink-0 rounded-full border border-accent/30 bg-accent/10 px-2.5 py-0.5 text-2xs font-semibold tracking-wide text-accent">
              PRO
            </span>
          )}
          {session ? (
            <>
              <span className="hidden min-w-0 truncate text-[13px] text-content-muted sm:inline">{session.user.email}</span>
              <button onClick={async () => { await signOut(); onLogout(); }} className="codex-btn-ghost shrink-0 whitespace-nowrap text-2xs">
                退出
              </button>
            </>
          ) : (
            <button onClick={onLogin} className="codex-btn-outline shrink-0 whitespace-nowrap text-2xs">
              登录
            </button>
          )}
        </div>
      </header>

      <main className="mx-auto max-w-[46rem] animate-fade-in px-4 py-6 sm:px-6 sm:py-10">
        {/* Sessions (primary) */}
        <section className="space-y-5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <h2 className="flex flex-wrap items-center gap-2 text-[15px] font-semibold text-content-primary">
              我的会话 <span className="font-normal text-content-muted">({onlineSessions.length})</span>
              <span
                className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-2xs font-medium ${
                  liveState === "live"
                    ? "border-success/30 bg-success/10 text-success"
                    : "border-border bg-surface-overlay text-content-muted"
                }`}
              >
                {liveState === "live" && (
                  <span className="h-1.5 w-1.5 rounded-full bg-current animate-pulse-dot" />
                )}
                {liveState === "live" ? "实时" : liveState === "connecting" ? "连接中" : "轮询"}
              </span>
            </h2>
            <div className="flex items-center gap-2">
              <button onClick={() => void refresh()} className="codex-btn-ghost text-2xs">
                <IconRefresh size={13} /> 刷新
              </button>
              <button onClick={() => setShowPairing((v) => !v)} className="codex-btn-primary text-2xs">
                <IconPlus size={13} /> 添加连接
              </button>
            </div>
          </div>

          {/* Pairing form (secondary, on demand) */}
          {showPairing && (
            <section className="codex-card animate-slide-in p-5">
              <label className="mb-1.5 block text-2xs font-semibold uppercase tracking-wider text-content-faint">网关地址</label>
              <div className="mb-4">
                <input
                  value={gatewayInput}
                  onChange={(e) => {
                    setGatewayInput(e.target.value);
                    setGatewayInvalid(false);
                  }}
                  onBlur={commitGatewayUrl}
                  onKeyDown={(e) => e.key === "Enter" && commitGatewayUrl()}
                  className={`codex-input font-mono text-2xs ${gatewayInvalid ? "border-danger/60" : ""}`}
                  placeholder="https://gateway.itool.tech"
                />
                {gatewayInvalid && (
                  <p className="mt-1.5 text-2xs text-danger">请输入有效的 http(s) 地址</p>
                )}
              </div>
              <label className="mb-1.5 block text-2xs font-semibold uppercase tracking-wider text-content-faint">配对码（在主机运行 linkshell 获取）</label>
              <div className="flex gap-2">
                <input
                  value={pairingCode}
                  onChange={(e) => setPairingCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  placeholder="123456"
                  inputMode="numeric"
                  autoFocus
                  className="codex-input flex-1 font-mono tracking-widest"
                  onKeyDown={(e) => e.key === "Enter" && handleClaim()}
                />
                <button onClick={handleClaim} disabled={claiming} className="codex-btn-primary">
                  {claiming ? "…" : "连接"}
                </button>
              </div>
              {error && <p className="mt-3 text-[13px] text-danger">{error}</p>}
            </section>
          )}

          {onlineSessions.length === 0 && offlineSessions.length === 0 ? (
            <div className="codex-card flex flex-col items-center gap-3 px-6 py-20 text-center">
              {loading ? (
                <p className="text-[15px] leading-7 text-content-muted">加载中…</p>
              ) : (
                <p className="max-w-sm text-[15px] leading-7 text-content-muted">
                  还没有会话。在主机运行{" "}
                  <code className="font-mono text-accent">linkshell</code>，然后点「添加连接」输入配对码。
                </p>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              {onlineSessions.map((s) => renderCard(s))}
              {offlineSessions.length > 0 && (
                <div className="space-y-3 pt-2">
                  <button
                    onClick={() => setShowOffline((v) => !v)}
                    className="flex w-full cursor-pointer items-center gap-1.5 text-2xs font-semibold uppercase tracking-wider text-content-faint transition-colors hover:text-content-muted"
                  >
                    <IconChevronRight
                      size={12}
                      className={`transition-transform ${showOffline ? "rotate-90" : ""}`}
                    />
                    离线 ({offlineSessions.length})
                  </button>
                  {showOffline && offlineSessions.map((s) => renderCard(s))}
                </div>
              )}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
