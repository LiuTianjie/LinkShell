import { useEffect, useMemo, useRef, useState } from "react";
import { getValidSession } from "../lib/supabase";
import { getDeviceToken } from "../lib/device-token";
import { IconRefresh, IconExternal, IconGlobe, IconClose, IconMonitor, IconDevice } from "./icons";

// Port-forward preview: load a service running on the host's localhost:{port}
// through the gateway's same-origin tunnel, inside an iframe. Mirrors the mobile
// BrowserView (manual port entry, no auto-discovery) but for the web console.
// The tunnel is same-origin, so a later "select element" overlay can read the
// iframe DOM directly — this component is the foundation for that.

type Viewport = "desktop" | "mobile";

export function PortPreview({
  gatewayUrl,
  sessionId,
  defaultPort,
  isMobile,
  onClose,
}: {
  gatewayUrl: string;
  sessionId: string;
  defaultPort?: string;
  isMobile?: boolean;
  onClose: () => void;
}) {
  const [portInput, setPortInput] = useState(defaultPort || "3000");
  const [activePort, setActivePort] = useState<string | null>(null);
  const [authToken, setAuthToken] = useState<string | null>(null);
  const [viewport, setViewport] = useState<Viewport>("desktop");
  const [reloadKey, setReloadKey] = useState(0);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const deviceToken = getDeviceToken();

  // Resolve a fresh JWT for tunnel auth (pro users authorize via auth_token;
  // device-token owners via token). Either alone is sufficient on the gateway.
  useEffect(() => {
    let cancelled = false;
    getValidSession().then((s) => {
      if (!cancelled) setAuthToken(s?.accessToken ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const tunnelUrl = useMemo(() => {
    if (!activePort) return null;
    const base = `${gatewayUrl.replace(/\/+$/, "")}/tunnel/${encodeURIComponent(sessionId)}/${activePort}`;
    const params: string[] = [];
    if (deviceToken) params.push(`token=${encodeURIComponent(deviceToken)}`);
    if (authToken) params.push(`auth_token=${encodeURIComponent(authToken)}`);
    return params.length ? `${base}?${params.join("&")}` : base;
  }, [activePort, gatewayUrl, sessionId, deviceToken, authToken]);

  const go = () => {
    const n = Number(portInput);
    if (!Number.isInteger(n) || n < 1 || n > 65535) return;
    setActivePort(String(n));
    setReloadKey((k) => k + 1);
  };

  const reload = () => {
    setReloadKey((k) => k + 1);
  };

  return (
    <div className="flex h-full flex-col bg-canvas">
      {/* Toolbar */}
      <div className="flex items-center gap-1.5 border-b border-border bg-surface px-2 py-1.5">
        {isMobile && (
          <button onClick={onClose} className="codex-btn-ghost px-2 py-1.5" aria-label="关闭预览">
            <IconClose size={15} />
          </button>
        )}
        <div className="flex min-w-0 flex-1 items-center gap-1 rounded-lg border border-border bg-surface-raised px-2 py-1">
          <span className="shrink-0 font-mono text-2xs text-content-faint">localhost:</span>
          <input
            value={portInput}
            onChange={(e) => setPortInput(e.target.value.replace(/\D/g, "").slice(0, 5))}
            onKeyDown={(e) => e.key === "Enter" && go()}
            inputMode="numeric"
            placeholder="3000"
            className="min-w-0 flex-1 bg-transparent font-mono text-2xs text-content-primary outline-none"
            aria-label="端口号"
          />
          <button
            onClick={go}
            className="shrink-0 cursor-pointer rounded bg-accent-dim px-2 py-0.5 text-2xs font-medium text-white transition-colors hover:bg-accent"
          >
            前往
          </button>
        </div>
        {/* Viewport toggle */}
        <div className="flex shrink-0 items-center rounded-lg border border-border bg-surface-raised p-0.5">
          <button
            onClick={() => setViewport("desktop")}
            className={`cursor-pointer rounded p-1 transition-colors ${viewport === "desktop" ? "bg-surface-overlay text-content-primary" : "text-content-muted hover:text-content-primary"}`}
            title="桌面视口"
            aria-label="桌面视口"
          >
            <IconMonitor size={13} />
          </button>
          <button
            onClick={() => setViewport("mobile")}
            className={`cursor-pointer rounded p-1 transition-colors ${viewport === "mobile" ? "bg-surface-overlay text-content-primary" : "text-content-muted hover:text-content-primary"}`}
            title="移动视口"
            aria-label="移动视口"
          >
            <IconDevice size={13} />
          </button>
        </div>
        <button
          onClick={reload}
          disabled={!activePort}
          className="shrink-0 cursor-pointer rounded-md p-1.5 text-content-muted transition-colors hover:bg-surface-overlay hover:text-accent disabled:opacity-40"
          title="刷新"
          aria-label="刷新"
        >
          <IconRefresh size={14} />
        </button>
        <button
          onClick={() => tunnelUrl && window.open(tunnelUrl, "_blank", "noopener,noreferrer")}
          disabled={!tunnelUrl}
          className="shrink-0 cursor-pointer rounded-md p-1.5 text-content-muted transition-colors hover:bg-surface-overlay hover:text-accent disabled:opacity-40"
          title="在新窗口打开"
          aria-label="在新窗口打开"
        >
          <IconExternal size={14} />
        </button>
      </div>

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-auto bg-surface-raised">
        {!tunnelUrl ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
            <IconGlobe size={34} className="text-content-faint" />
            <p className="text-sm leading-6 text-content-muted">
              输入主机上服务的端口号，预览远程本地服务
            </p>
          </div>
        ) : (
          <div className={viewport === "mobile" ? "mx-auto h-full w-[390px] max-w-full border-x border-border" : "h-full w-full"}>
            <iframe
              key={`${tunnelUrl}-${reloadKey}`}
              ref={iframeRef}
              src={tunnelUrl}
              title="端口预览"
              className="h-full w-full bg-white"
            />
          </div>
        )}
      </div>
    </div>
  );
}
