import { useEffect, useMemo, useRef, useState } from "react";
import { getValidSession } from "../lib/supabase";
import { getDeviceToken } from "../lib/device-token";
import { IconRefresh, IconExternal, IconGlobe, IconClose, IconMonitor, IconPhone, IconComment } from "./icons";

// Port-forward preview: load a service running on the host's localhost:{port}
// through the gateway's same-origin tunnel, inside an iframe. Mirrors the mobile
// BrowserView (manual port entry, no auto-discovery) but for the web console.
// The tunnel is same-origin, so the annotate mode can read the iframe DOM
// directly to let the user point at an element and comment on it for the agent.

type Viewport = "desktop" | "mobile";

interface Nav {
  port: string;
  path: string; // always starts with "/"
}

// A selected element's identity, captured for the agent.
interface Picked {
  selector: string;
  text: string;
  rect: { top: number; left: number; width: number; height: number };
}

// "3000" or "3000/tools/color?x=1" → { port, path }. Returns null if no port.
function parseAddress(input: string): Nav | null {
  const m = /^\s*(\d{1,5})(.*)$/.exec(input);
  if (!m) return null;
  const port = m[1];
  if (Number(port) < 1 || Number(port) > 65535) return null;
  let path = m[2] || "/";
  if (!path.startsWith("/")) path = `/${path}`;
  return { port, path };
}

// Build a reasonably-unique CSS selector for an element: prefer #id, else walk
// up a few levels using tag + classes + :nth-of-type. Good enough to point the
// agent at the right node without being a bulletproof XPath.
function cssSelector(el: Element): string {
  if (el.id) return `#${CSS.escape(el.id)}`;
  const parts: string[] = [];
  let node: Element | null = el;
  let depth = 0;
  while (node && node.nodeType === 1 && depth < 4) {
    let part = node.tagName.toLowerCase();
    const cls = (node.getAttribute("class") || "")
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((c) => `.${CSS.escape(c)}`)
      .join("");
    part += cls;
    const parent: Element | null = node.parentElement;
    if (parent) {
      const sameTag = [...parent.children].filter((c) => c.tagName === node!.tagName);
      if (sameTag.length > 1) {
        part += `:nth-of-type(${sameTag.indexOf(node) + 1})`;
      }
    }
    parts.unshift(part);
    if (node.id) {
      parts[0] = `#${CSS.escape(node.id)}`;
      break;
    }
    node = parent;
    depth += 1;
  }
  return parts.join(" > ");
}

export function PortPreview({
  gatewayUrl,
  sessionId,
  defaultPort,
  isMobile,
  onClose,
  onAnnotate,
}: {
  gatewayUrl: string;
  sessionId: string;
  defaultPort?: string;
  isMobile?: boolean;
  onClose: () => void;
  /** Send a structured "I'm pointing at this element + comment" message to the
   *  composer so the agent can act on the referenced element. */
  onAnnotate?: (text: string) => void;
}) {
  // The editable address bar text — "{port}{path}". Follows the iframe's real
  // location on navigation (same-origin only), edited + Enter to navigate.
  const [address, setAddress] = useState(defaultPort || "3000");
  // The committed navigation target driving the iframe src. Updated ONLY on an
  // explicit go/Enter — never from the load-follow handler, which would loop.
  const [nav, setNav] = useState<Nav | null>(null);
  const [authToken, setAuthToken] = useState<string | null>(null);
  const [viewport, setViewport] = useState<Viewport>("desktop");
  const [reloadKey, setReloadKey] = useState(0);
  // Annotate mode: overlay captures the mouse, highlights the hovered element,
  // and on click captures it + opens a comment box.
  const [annotate, setAnnotate] = useState(false);
  const [annotateError, setAnnotateError] = useState<string | null>(null);
  const [hoverRect, setHoverRect] = useState<Picked["rect"] | null>(null);
  const [picked, setPicked] = useState<Picked | null>(null);
  const [comment, setComment] = useState("");
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
    if (!nav) return null;
    const base = `${gatewayUrl.replace(/\/+$/, "")}/tunnel/${encodeURIComponent(sessionId)}/${nav.port}${nav.path}`;
    const params: string[] = [];
    if (deviceToken) params.push(`token=${encodeURIComponent(deviceToken)}`);
    if (authToken) params.push(`auth_token=${encodeURIComponent(authToken)}`);
    if (params.length === 0) return base;
    const sep = nav.path.includes("?") ? "&" : "?";
    return `${base}${sep}${params.join("&")}`;
  }, [nav, gatewayUrl, sessionId, deviceToken, authToken]);

  const go = () => {
    const parsed = parseAddress(address);
    if (!parsed) return;
    setNav(parsed);
    setReloadKey((k) => k + 1);
  };

  const reload = () => setReloadKey((k) => k + 1);

  // After each iframe navigation, reflect the real path back into the address
  // bar (so it tracks client-side route changes inside the previewed app).
  const onLoad = () => {
    if (!nav) return;
    try {
      const win = iframeRef.current?.contentWindow;
      if (!win) return;
      const prefix = `/tunnel/${encodeURIComponent(sessionId)}/${nav.port}`;
      let path = win.location.pathname;
      if (path.startsWith(prefix)) path = path.slice(prefix.length) || "/";
      const sp = new URLSearchParams(win.location.search);
      sp.delete("token");
      sp.delete("auth_token");
      const q = sp.toString();
      setAddress(`${nav.port}${path}${q ? `?${q}` : ""}`);
    } catch {
      // cross-origin (dev) — leave the address as the user typed it.
    }
  };

  // Translate an overlay mouse event into the element under it inside the
  // iframe. Same-origin only; throws under cross-origin (dev) — caught upstream.
  const elementAt = (clientX: number, clientY: number): Element | null => {
    const iframe = iframeRef.current;
    const doc = iframe?.contentDocument;
    if (!iframe || !doc) return null;
    const r = iframe.getBoundingClientRect();
    return doc.elementFromPoint(clientX - r.left, clientY - r.top);
  };

  const rectOf = (el: Element): Picked["rect"] => {
    const r = el.getBoundingClientRect();
    return { top: r.top, left: r.left, width: r.width, height: r.height };
  };

  const onOverlayMove = (e: React.MouseEvent) => {
    try {
      const el = elementAt(e.clientX, e.clientY);
      setHoverRect(el ? rectOf(el) : null);
    } catch {
      setHoverRect(null);
      setAnnotateError("此页面跨域，无法读取元素（生产环境同源可用）");
      setAnnotate(false);
    }
  };

  const onOverlayClick = (e: React.MouseEvent) => {
    e.preventDefault();
    try {
      const el = elementAt(e.clientX, e.clientY);
      if (!el) return;
      setPicked({
        selector: cssSelector(el),
        text: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 120),
        rect: rectOf(el),
      });
      setComment("");
    } catch {
      setAnnotateError("此页面跨域，无法读取元素（生产环境同源可用）");
      setAnnotate(false);
    }
  };

  const submitAnnotation = () => {
    if (!picked) return;
    const lines = [
      "关于预览页面中的这个元素：",
      `- 选择器: \`${picked.selector}\``,
      picked.text ? `- 文本: "${picked.text}"` : "",
      `- 路径: localhost:${address}`,
      comment.trim() ? `- 批注: ${comment.trim()}` : "",
    ].filter(Boolean);
    onAnnotate?.(lines.join("\n"));
    setPicked(null);
    setComment("");
    setHoverRect(null);
    setAnnotate(false);
  };

  const toggleAnnotate = () => {
    setAnnotateError(null);
    setPicked(null);
    setHoverRect(null);
    setAnnotate((v) => !v);
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
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && go()}
            placeholder="3000"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent font-mono text-2xs text-content-primary outline-none"
            aria-label="端口与路径"
          />
          <button
            onClick={go}
            className="shrink-0 cursor-pointer rounded bg-accent-dim px-2 py-0.5 text-2xs font-medium text-white transition-colors hover:bg-accent"
          >
            前往
          </button>
        </div>
        {/* Annotate toggle */}
        <button
          onClick={toggleAnnotate}
          disabled={!nav}
          className={`shrink-0 cursor-pointer rounded-md p-1.5 transition-colors disabled:opacity-40 ${annotate ? "bg-accent-dim text-white" : "text-content-muted hover:bg-surface-overlay hover:text-accent"}`}
          title="标注元素"
          aria-label="标注元素"
        >
          <IconComment size={14} />
        </button>
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
            <IconPhone size={13} />
          </button>
        </div>
        <button
          onClick={reload}
          disabled={!nav}
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

      {annotateError && (
        <p className="border-b border-border bg-warning/10 px-3 py-1.5 text-2xs text-warning">{annotateError}</p>
      )}
      {annotate && !picked && (
        <p className="border-b border-border bg-accent/10 px-3 py-1.5 text-2xs text-accent">
          标注模式：移动鼠标高亮元素，点击选择并添加批注。
        </p>
      )}

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
            <div className="relative h-full w-full">
              <iframe
                key={`${tunnelUrl}-${reloadKey}`}
                ref={iframeRef}
                src={tunnelUrl}
                title="端口预览"
                onLoad={onLoad}
                className="h-full w-full bg-white"
              />
              {/* Annotate overlay: captures the mouse over the iframe so we can
                  hit-test and highlight without mutating the previewed page. */}
              {annotate && (
                <div
                  className="absolute inset-0 cursor-crosshair"
                  onMouseMove={onOverlayMove}
                  onMouseLeave={() => setHoverRect(null)}
                  onClick={onOverlayClick}
                >
                  {hoverRect && (
                    <div
                      className="pointer-events-none absolute border-2 border-accent bg-accent/10"
                      style={{
                        top: hoverRect.top,
                        left: hoverRect.left,
                        width: hoverRect.width,
                        height: hoverRect.height,
                      }}
                    />
                  )}
                  {picked && (
                    <div
                      className="pointer-events-none absolute border-2 border-accent-dim"
                      style={{
                        top: picked.rect.top,
                        left: picked.rect.left,
                        width: picked.rect.width,
                        height: picked.rect.height,
                      }}
                    />
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Comment box for the picked element */}
      {picked && (
        <div className="border-t border-border bg-surface px-3 py-2.5">
          <p className="mb-1 truncate font-mono text-2xs text-content-faint" title={picked.selector}>
            {picked.selector}
          </p>
          {picked.text && <p className="mb-2 truncate text-2xs text-content-muted">“{picked.text}”</p>}
          <div className="flex items-center gap-2">
            <input
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submitAnnotation()}
              autoFocus
              placeholder="对这个元素的批注（可留空）…"
              className="codex-input flex-1 text-sm"
            />
            <button onClick={submitAnnotation} className="codex-btn-primary shrink-0 text-xs">
              发送给 Agent
            </button>
            <button onClick={() => setPicked(null)} className="codex-btn-ghost shrink-0 text-xs">
              取消
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

