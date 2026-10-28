import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { LoaderCircle, RefreshCw } from "lucide-react";
import type { ContentBlock } from "@linkshell/wire";
import { Button } from "@/components/ui/button";
import { EmptyState, messageOf, useConnection } from "./common";
import { isDesktop, openDesktopExternal } from "./desktop";
import { AppBridge, appCsp, appDocument, appResourceMeta, isAppPage } from "./mcp-app";

/** An MCP App open in the inspector: one per app page, reused by its later calls. */
export interface AppTab {
  /** `app:<server>\n<resource>`: the inspector's panel id for it. */
  id: string;
  server: string;
  tool: string;
  title: string;
  resourceUri: string;
  /** A connector's page (Codex's `codex_apps`): its tools are the ones it may call. */
  connector?: string;
  /** The call it shows: what the agent asked, and, once it's done, what came back. */
  callId?: string;
  input?: Record<string, unknown>;
  result?: unknown;
  /** Opened from the menu rather than by a call: the app is run once, with nothing, to start. */
  launched?: boolean;
}

export const appTabId = (server: string, resourceUri: string) => `app:${server}\n${resourceUri}`;

function currentTheme(): "light" | "dark" {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

/** What the agent can be told from a page: its text and pictures, in our blocks. */
function blocksOf(content: unknown[]): ContentBlock[] {
  return content.flatMap((item): ContentBlock[] => {
    const block = item as { type?: unknown; text?: unknown; data?: unknown; mimeType?: unknown };
    if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) return [{ type: "text", text: block.text }];
    if (block?.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string") return [{ type: "image", data: block.data, mimeType: block.mimeType }];
    return [];
  });
}

export function McpAppView({
  sessionId,
  tab,
  hidden,
  say,
}: {
  sessionId: string;
  tab: AppTab;
  hidden: boolean;
  /** Puts what the page says into the conversation. */
  say?: (content: ContentBlock[]) => Promise<void>;
}) {
  const { link } = useConnection();
  const frame = useRef<HTMLIFrameElement>(null);
  const bridge = useRef<AppBridge | undefined>(undefined);
  const [page, setPage] = useState<{ html: string } | { error: string }>();
  const [attempt, setAttempt] = useState(0);
  // The latest call, read by the bridge's callbacks without re-creating the frame.
  const latest = useRef(tab);
  latest.current = tab;
  const delivered = useRef<{ callId?: string; input?: unknown; result?: unknown }>({});

  useEffect(() => {
    let live = true;
    setPage(undefined);
    link.call("mcp.resource", { sessionId, server: tab.server, uri: tab.resourceUri, connector: tab.connector }).then(
      (resource) => {
        if (!live) return;
        if (typeof resource.text !== "string" || !isAppPage(resource.mimeType)) {
          setPage({ error: "这个应用没有可显示的页面" });
          return;
        }
        setPage({ html: appDocument(resource.text, appCsp(appResourceMeta(resource.meta).csp)) });
      },
      (reason: unknown) => live && setPage({ error: messageOf(reason) }),
    );
    return () => { live = false; };
  }, [link, sessionId, tab.server, tab.resourceUri, tab.connector, attempt]);

  // Tells the page about its call: the input once, the result when there is one (again for a new call).
  const deliver = () => {
    const current = bridge.current;
    if (!current?.ready) return;
    const { callId, input, result } = latest.current;
    const sent = delivered.current;
    if (callId !== sent.callId || input !== sent.input) current.notify("ui/notifications/tool-input", { arguments: input ?? {} });
    if (result !== undefined && (callId !== sent.callId || result !== sent.result)) current.notify("ui/notifications/tool-result", result);
    delivered.current = { callId, input, result };
  };

  // Before the frame's own script runs, so its first message (ui/initialize) finds us listening.
  useLayoutEffect(() => {
    const element = frame.current;
    if (!page || !("html" in page) || !element) return;
    delivered.current = {};
    const { server, connector } = tab;
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await link.call("mcp.call", { sessionId, server, connector, tool: name, arguments: args });
      return { content: result.content, structuredContent: result.structuredContent, isError: result.isError, _meta: result.meta };
    };
    const app = new AppBridge(
      element,
      {
        callTool: call,
        readResource: async (uri) => {
          const resource = await link.call("mcp.resource", { sessionId, server, connector, uri });
          return { contents: [{ uri, mimeType: resource.mimeType, ...(resource.blob !== undefined ? { blob: resource.blob } : { text: resource.text ?? "" }), _meta: resource.meta }] };
        },
        openLink: (url) => (isDesktop ? openDesktopExternal(url) : void window.open(url, "_blank", "noopener,noreferrer")),
        message: say ? (content) => say(blocksOf(content)) : undefined,
        ready: () => {
          const opened = latest.current;
          if (opened.launched && opened.result === undefined) {
            // Opened by hand: the app gets what running it once returns, as Codex starts it.
            void call(opened.tool, {}).then(
              (result) => {
                if (latest.current.id !== opened.id) return;
                app.notify("ui/notifications/tool-input", { arguments: {} });
                app.notify("ui/notifications/tool-result", result);
              },
              (reason: unknown) => app.notify("ui/notifications/tool-result", { content: [{ type: "text", text: messageOf(reason) }], isError: true }),
            );
            return;
          }
          deliver();
        },
      },
      { theme: currentTheme(), displayMode: "fullscreen", availableDisplayModes: ["fullscreen"], platform: "desktop", locale: navigator.language || "zh-CN" },
      { name: "LinkShell", version: "1" },
    );
    bridge.current = app;
    const themes = new MutationObserver(() => app.setContext({ theme: currentTheme() }));
    themes.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => {
      themes.disconnect();
      bridge.current = undefined;
      void app.teardown().finally(() => app.dispose());
    };
    // The frame is the page's: a new call reaches it through `deliver`, not a new frame.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);

  useEffect(() => deliver(), [tab.callId, tab.input, tab.result]);

  return (
    <div className="mcp-app" hidden={hidden} aria-label={tab.title}>
      {!page && (
        <div className="mcp-app-state" role="status">
          <LoaderCircle className="animate-spin" />
          <span>正在打开 {tab.title}…</span>
        </div>
      )}
      {page && "error" in page && (
        <EmptyState
          title={`${tab.title} 无法打开`}
          description={page.error}
        >
          <Button variant="secondary" size="sm" onClick={() => setAttempt((value) => value + 1)}>
            <RefreshCw data-icon="inline-start" />重试
          </Button>
        </EmptyState>
      )}
      {page && "html" in page && (
        <iframe
          ref={frame}
          className="mcp-app-frame"
          title={tab.title}
          srcDoc={page.html}
          // Scripts in an opaque origin of their own: no same-origin, no popups, no top navigation.
          sandbox="allow-scripts allow-forms"
          allow="clipboard-write; encrypted-media"
          referrerPolicy="no-referrer"
        />
      )}
    </div>
  );
}
