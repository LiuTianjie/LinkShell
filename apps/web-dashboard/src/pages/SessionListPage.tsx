import { useEffect, useState, useCallback } from "react";
import { signOut, isPro } from "../lib/supabase";
import type { Session } from "../lib/supabase";
import { loadGatewayConfig, saveGatewayUrl } from "../lib/gateway-config";
import { claimPairing, listSessions, listMySessions } from "../lib/gateway-api";
import { getDeviceToken } from "../lib/device-token";
import { loadKnownSessions, rememberSessions, forgetSession, markAllOffline } from "../lib/storage";
import { BrandLogo, IconClose, IconChevronRight, IconPlus, IconRefresh, ProviderIcon } from "../components/icons";
import type { SessionSummary } from "../lib/types";

function agentStatusLabel(status: SessionSummary["agentStatus"]): string | null {
  switch (status) {
    case "running":
      return "运行中";
    case "waiting_permission":
      return "等待授权";
    case "error":
      return "异常";
    case "idle":
      return "空闲";
    default:
      return null;
  }
}

function agentStatusClass(status: SessionSummary["agentStatus"]): string {
  switch (status) {
    case "running":
      return "border-success/30 bg-success/10 text-success";
    case "waiting_permission":
      return "border-warning/40 bg-warning/10 text-warning";
    case "error":
      return "border-danger/30 bg-danger/10 text-danger";
    case "idle":
      return "border-border bg-surface-overlay text-content-muted";
    default:
      return "border-border bg-surface-overlay text-content-muted";
  }
}

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
  // Seed from remembered sessions so "back" shows a clickable list instantly,
  // even before the live /sessions call returns (or if it's momentarily empty).
  const [sessions, setSessions] = useState<SessionSummary[]>(() => loadKnownSessions());
  const [loading, setLoading] = useState(true);
  const [pairingCode, setPairingCode] = useState("");
  const [claiming, setClaiming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The pairing form is secondary once sessions exist — show it on demand.
  const [showPairing, setShowPairing] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
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
    refresh();
  }, [refresh]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, 5000);
    return () => window.clearInterval(timer);
  }, [refresh]);

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

  const handleGatewayChange = (url: string) => {
    saveGatewayUrl(url);
    setConfig({ httpUrl: url.replace(/\/+$/, "") });
  };

  return (
    <div className="min-h-screen bg-canvas">
      <header className="glass-bar sticky top-0 z-10 flex h-14 items-center justify-between gap-3 border-b border-border px-4 sm:px-6">
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
              <span className="min-w-0 truncate text-[13px] text-content-muted">{session.user.email}</span>
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

      <main className="mx-auto max-w-[46rem] animate-fade-in px-6 py-10">
        {/* Sessions (primary) */}
        <section className="space-y-5">
          <div className="flex items-center justify-between">
            <h2 className="text-[15px] font-semibold text-content-primary">
              我的会话 <span className="font-normal text-content-muted">({sessions.length})</span>
            </h2>
            <div className="flex items-center gap-2">
              <button onClick={refresh} className="codex-btn-ghost text-2xs">
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
              <input
                value={config.httpUrl}
                onChange={(e) => handleGatewayChange(e.target.value)}
                className="codex-input mb-4 font-mono text-2xs"
                placeholder="https://gateway.itool.tech"
              />
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

          {sessions.length === 0 ? (
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
              {sessions.map((s) => (
                <div
                  key={s.id}
                  className="codex-card group flex items-center justify-between p-4 transition-colors hover:bg-surface-overlay"
                >
                  <button
                    onClick={() => onOpenSession(s.id)}
                    className="flex flex-1 cursor-pointer items-center justify-between text-left"
                  >
                    <div>
                      <p className="flex items-center gap-2 text-[15px] font-medium text-content-primary">
                        <span className={`h-1.5 w-1.5 rounded-full ${s.hasHost ? "bg-success" : "bg-content-faint"}`} />
                        {s.projectName || s.hostname || s.id.slice(0, 8)}
                        {s.provider && (
                          <span className="codex-chip">
                            <ProviderIcon provider={s.provider} size={12} />
                            {s.provider}
                          </span>
                        )}
                        {agentStatusLabel(s.agentStatus) && (
                          <span className={`rounded-full border px-2 py-0.5 text-2xs font-medium ${agentStatusClass(s.agentStatus)}`}>
                            {s.agentProvider && s.agentProvider !== s.provider ? `${s.agentProvider} · ` : ""}
                            {agentStatusLabel(s.agentStatus)}
                          </span>
                        )}
                      </p>
                      <p className="mt-1 font-mono text-2xs text-content-muted">
                        {s.cwd ?? "—"} · {s.hasHost ? "在线" : "主机离线"}
                        {s.agentTitle ? ` · ${s.agentTitle}` : ""}
                      </p>
                    </div>
                  </button>
                  <div className="flex items-center gap-2 pl-3">
                    <button
                      onClick={() => handleForget(s.id)}
                      className="cursor-pointer rounded-lg p-1.5 text-content-faint opacity-0 transition-colors hover:text-danger group-hover:opacity-100"
                      title="从列表移除"
                      aria-label="移除会话"
                    >
                      <IconClose size={14} />
                    </button>
                    <IconChevronRight size={16} className="text-content-faint" />
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
