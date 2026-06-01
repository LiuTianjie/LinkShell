import { useEffect, useMemo, useRef, useState } from "react";
import { getValidSession } from "../lib/supabase";
import { ensureDeviceToken } from "../lib/device-token";
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

// A selected element's identity, captured for the agent. `el` is the live DOM
// node inside the iframe (same-origin), used for live style write-back.
interface Picked {
  el: HTMLElement;
  selector: string;
  text: string;
  rect: { top: number; left: number; width: number; height: number };
}

// The curated set of CSS properties the visual editor exposes. Kept small and
// high-value (mirrors Codex's element panel): edits write back to the iframe
// DOM live for preview, and changed ones are serialized into the agent message
// so the agent can apply them to the real source.
const EDITABLE_PROPS: { cssProp: string; label: string }[] = [
  { cssProp: "color", label: "文本颜色" },
  { cssProp: "background-color", label: "背景" },
  { cssProp: "font-size", label: "字号" },
  { cssProp: "font-weight", label: "字重" },
  { cssProp: "padding", label: "内边距" },
  { cssProp: "border-radius", label: "圆角" },
];

// Read the editable properties off an element's computed style.
function readProps(el: HTMLElement): Record<string, string> {
  const cs = el.ownerDocument.defaultView?.getComputedStyle(el);
  const out: Record<string, string> = {};
  for (const { cssProp } of EDITABLE_PROPS) {
    out[cssProp] = cs?.getPropertyValue(cssProp).trim() ?? "";
  }
  return out;
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
  initialAuthToken,
  defaultPort,
  isMobile,
  onClose,
  onAnnotate,
}: {
  gatewayUrl: string;
  sessionId: string;
  initialAuthToken?: string | null;
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
  const [authToken, setAuthToken] = useState<string | null>(initialAuthToken ?? null);
  const [authResolved, setAuthResolved] = useState(false);
  const [viewport, setViewport] = useState<Viewport>("desktop");
  const [reloadKey, setReloadKey] = useState(0);
  // Annotate mode: overlay captures the mouse, highlights the hovered element,
  // and on click captures it + opens a floating comment card near the element.
  const [annotate, setAnnotate] = useState(false);
  const [annotateError, setAnnotateError] = useState<string | null>(null);
  const [hoverRect, setHoverRect] = useState<Picked["rect"] | null>(null);
  const [picked, setPicked] = useState<Picked | null>(null);
  const [comment, setComment] = useState("");
  // Visual editor collapsed by default (Codex-style): the user sees a simple
  // comment box; tapping the expand button reveals the CSS property grid.
  const [cssExpanded, setCssExpanded] = useState(false);
  // Visual editor: original computed styles of the picked element (for diffing)
  // and the user's working edits. Editing a prop writes back to the iframe DOM
  // live and records the new value here; only changed props go to the agent.
  const [baseProps, setBaseProps] = useState<Record<string, string>>({});
  const [propEdits, setPropEdits] = useState<Record<string, string>>({});
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const deviceToken = useMemo(() => ensureDeviceToken(), []);

  // Resolve a fresh JWT for tunnel auth (pro users authorize via auth_token;
  // device-token owners via token). Either alone is sufficient on the gateway.
  useEffect(() => {
    let cancelled = false;
    setAuthResolved(false);
    getValidSession()
      .then((s) => {
        if (!cancelled) setAuthToken(s?.accessToken ?? null);
      })
      .finally(() => {
        if (!cancelled) setAuthResolved(true);
      });
    return () => {
      cancelled = true;
    };
  }, [initialAuthToken]);

  const tunnelUrl = useMemo(() => {
    if (!nav) return null;
    if (initialAuthToken && !authResolved) return null;
    const base = `${gatewayUrl.replace(/\/+$/, "")}/tunnel/${encodeURIComponent(sessionId)}/${nav.port}${nav.path}`;
    const params: string[] = [];
    if (deviceToken) params.push(`token=${encodeURIComponent(deviceToken)}`);
    if (authToken) params.push(`auth_token=${encodeURIComponent(authToken)}`);
    if (params.length === 0) return base;
    const sep = nav.path.includes("?") ? "&" : "?";
    return `${base}${sep}${params.join("&")}`;
  }, [nav, gatewayUrl, sessionId, deviceToken, authToken, authResolved]);

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
      // Duck-type rather than `instanceof HTMLElement`: nodes inside the iframe
      // are instances of the IFRAME's HTMLElement, not the parent window's, so
      // a cross-realm instanceof check would wrongly fail.
      if (!el || !("style" in el)) return;
      const htmlEl = el as HTMLElement;
      setPicked({
        el: htmlEl,
        selector: cssSelector(htmlEl),
        text: (htmlEl.textContent || "").replace(/\s+/g, " ").trim().slice(0, 120),
        rect: rectOf(htmlEl),
      });
      setBaseProps(readProps(htmlEl));
      setPropEdits({});
      setComment("");
    } catch {
      setAnnotateError("此页面跨域，无法读取元素（生产环境同源可用）");
      setAnnotate(false);
    }
  };

  // Edit a property: write to the iframe DOM live (instant preview) and record
  // the new value. Stored as inline style on the live node — purely a preview;
  // the real change is what we send to the agent.
  const editProp = (cssProp: string, value: string) => {
    if (!picked) return;
    try {
      picked.el.style.setProperty(cssProp, value);
    } catch {
      // ignore write failures (e.g. invalid value mid-typing)
    }
    setPropEdits((prev) => ({ ...prev, [cssProp]: value }));
  };

  // Props the user actually changed from their computed baseline.
  const changedProps = (): { cssProp: string; from: string; to: string }[] =>
    Object.entries(propEdits)
      .filter(([k, v]) => v !== (baseProps[k] ?? ""))
      .map(([k, v]) => ({ cssProp: k, from: baseProps[k] ?? "", to: v }));

  const submitAnnotation = () => {
    if (!picked) return;
    const changes = changedProps();
    const lines = [
      "关于预览页面中的这个元素：",
      `- 选择器: \`${picked.selector}\``,
      picked.text ? `- 文本: "${picked.text}"` : "",
      `- 路径: localhost:${address}`,
      comment.trim() ? `- 批注: ${comment.trim()}` : "",
    ];
    if (changes.length > 0) {
      lines.push("- 请把以下样式改动应用到源码：");
      for (const c of changes) lines.push(`    - ${c.cssProp}: ${c.from || "(默认)"} → ${c.to}`);
    }
    onAnnotate?.(lines.filter(Boolean).join("\n"));
    setPicked(null);
    setComment("");
    setBaseProps({});
    setPropEdits({});
    setCssExpanded(false);
    setHoverRect(null);
    setAnnotate(false);
  };

  const cancelPick = () => {
    setPicked(null);
    setComment("");
    setBaseProps({});
    setPropEdits({});
    setCssExpanded(false);
  };

  const toggleAnnotate = () => {
    setAnnotateError(null);
    cancelPick();
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
              {nav && !authResolved ? "正在准备预览认证..." : "输入主机上服务的端口号，预览远程本地服务"}
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
                  {hoverRect && !picked && (
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
                </div>
              )}

              {/* Floating annotation card — Codex-style: appears near the picked
                  element. Comment input is always visible; the CSS property editor
                  is collapsed behind an expand toggle. Both comment text and any
                  CSS changes are sent to the agent together. */}
              {picked && (() => {
                // Position the card near the element. Prefer below the element;
                // flip above when there isn't enough room (e.g. element near the
                // bottom of the viewport). Clamp horizontally so it stays on-screen.
                const cardW = 280;
                const gap = 8;
                const bodyH = bodyRef.current?.clientHeight ?? 600;
                const below = picked.rect.top + picked.rect.height + gap;
                const above = picked.rect.top - gap; // card bottom edge
                const estCardH = cssExpanded ? 340 : 140;
                const flip = below + estCardH > bodyH && above - estCardH > 0;
                const top = flip ? Math.max(4, above - estCardH) : below;
                const left = Math.max(4, Math.min(picked.rect.left, (bodyRef.current?.clientWidth ?? 800) - cardW - 4));

                return (
                  <div
                    className="absolute z-20 flex flex-col gap-2 rounded-xl border border-accent-dim/40 bg-surface-raised px-3 py-2.5 shadow-2xl animate-fade-in"
                    style={{ top, left, width: cardW, maxHeight: bodyH - top - 8 }}
                  >
                    {/* Element identity */}
                    <p className="truncate font-mono text-2xs text-content-faint" title={picked.selector}>
                      {picked.selector}
                    </p>
                    {picked.text && (
                      <p className="-mt-1 truncate text-2xs text-content-muted">"{picked.text}"</p>
                    )}

                    {/* Comment input — always visible */}
                    <input
                      value={comment}
                      onChange={(e) => setComment(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && submitAnnotation()}
                      autoFocus
                      placeholder="添加批注…"
                      className="w-full rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs text-content-primary placeholder-content-muted outline-none focus:border-accent-dim"
                    />

                    {/* Expand/Collapse CSS editor toggle */}
                    <button
                      onClick={() => setCssExpanded((v) => !v)}
                      className={`flex cursor-pointer items-center gap-1 self-start rounded-md px-1.5 py-0.5 text-2xs transition-colors ${
                        cssExpanded ? "text-accent" : "text-content-muted hover:text-content-secondary"
                      }`}
                    >
                      <svg width={10} height={10} viewBox="0 0 10 10" className={`shrink-0 transition-transform ${cssExpanded ? "rotate-180" : ""}`}>
                        <path d="M2 3.5 L5 6.5 L8 3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                      调整样式
                    </button>

                    {/* CSS property editor — collapsed by default */}
                    {cssExpanded && (
                      <div className="grid grid-cols-2 gap-x-2 gap-y-1.5 animate-fade-in">
                        {EDITABLE_PROPS.map(({ cssProp, label }) => {
                          const value = propEdits[cssProp] ?? baseProps[cssProp] ?? "";
                          const changed = cssProp in propEdits && propEdits[cssProp] !== (baseProps[cssProp] ?? "");
                          return (
                            <label key={cssProp} className="flex flex-col gap-0.5">
                              <span className={`text-2xs ${changed ? "text-accent" : "text-content-faint"}`}>{label}</span>
                              <input
                                value={value}
                                onChange={(e) => editProp(cssProp, e.target.value)}
                                spellCheck={false}
                                className="w-full rounded-md border border-border bg-surface px-2 py-1 font-mono text-2xs text-content-primary outline-none focus:border-accent-dim"
                              />
                            </label>
                          );
                        })}
                      </div>
                    )}

                    {/* Actions */}
                    <div className="flex items-center gap-2">
                      <button onClick={cancelPick} className="codex-btn-ghost flex-1 text-2xs">
                        取消
                      </button>
                      <button onClick={submitAnnotation} className="codex-btn-primary flex-1 text-2xs">
                        发送给 Agent
                      </button>
                    </div>
                  </div>
                );
              })()}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
