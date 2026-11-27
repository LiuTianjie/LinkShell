import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ContentBlock, McpApp } from "@linkshell/wire";
import { openExternalUrl } from "../../bridge/desktop-bridge";
import type { Connection } from "../../core/connections";
import {
  AppBridge,
  appCsp,
  appDocument,
  appResourceMeta,
  appTabId,
  decodeBase64Utf8,
  isAppPage,
  isSafeExternalUrl,
  mcpContentBlocks,
  type AppHostContext,
} from "../../core/mcp-bridge";
import { Button, EmptyState } from "../../primitives";
import { getResolvedTheme } from "../../theme";
import { useInspectorI18n } from "./i18n-inspector";
import type { InspectorSessionActions } from "./use-inspector-connection";

export interface McpAppsDiscoveryState {
  apps: McpApp[];
  loading: boolean;
  showPluginTab: boolean;
  refresh: () => Promise<void>;
}

export function useMcpAppsDiscovery(params: {
  connection?: Connection;
  online: boolean;
  sessionId?: string;
  sessionAgent?: string;
  /** The agent's `mcpApps` capability; older hosts don't say, and there only Codex had them. */
  capable?: boolean;
}): McpAppsDiscoveryState {
  const { connection, online, sessionId, sessionAgent } = params;
  const capable = params.capable ?? sessionAgent === "codex";
  const [apps, setApps] = useState<McpApp[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!connection || !online || !sessionId || !capable) {
      setApps([]);
      return;
    }
    setLoading(true);
    try {
      const res = await connection.link.call("mcp.apps", { sessionId });
      setApps(Array.isArray(res?.apps) ? res.apps : []);
    } catch {
      setApps([]);
    } finally {
      setLoading(false);
    }
  }, [capable, connection, online, sessionId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const safeApps = Array.isArray(apps) ? apps : [];

  const showPluginTab = safeApps.length > 0 || capable;

  return {
    apps: safeApps,
    loading,
    showPluginTab,
    refresh,
  };
}

interface LoadedMcpPage {
  key: string;
  srcDoc: string;
}

export interface McpAppPanelProps {
  connection?: Connection;
  online: boolean;
  sessionId?: string;
  apps: readonly McpApp[];
  loading: boolean;
  onRefresh: () => void;
  actions?: InspectorSessionActions;
  initialAppKey?: string;
}

export function McpAppPanel({
  connection,
  online,
  sessionId,
  apps,
  loading,
  onRefresh,
  actions,
  initialAppKey,
}: McpAppPanelProps) {
  const { locale, ti } = useInspectorI18n();
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  const [loadedPage, setLoadedPage] = useState<LoadedMcpPage | null>(null);
  const [pageLoading, setPageLoading] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);
  const [reloadSeq, setReloadSeq] = useState(0);

  const safeApps = useMemo(() => (Array.isArray(apps) ? apps : []), [apps]);

  const selectedApp = useMemo(() => {
    if (safeApps.length === 0) return undefined;
    return (
      safeApps.find(
        (app) => appTabId(app.server, app.resourceUri) === initialAppKey,
      ) ?? safeApps[0]
    );
  }, [safeApps, initialAppKey]);

  useEffect(() => {
    if (!connection || !online || !sessionId || !selectedApp) {
      setLoadedPage(null);
      setPageError(null);
      return undefined;
    }

    let cancelled = false;
    setPageLoading(true);
    setPageError(null);

    void connection.link
      .call("mcp.resource", {
        sessionId,
        server: selectedApp.server,
        uri: selectedApp.resourceUri,
        connector: selectedApp.connector,
      })
      .then((res) => {
        if (cancelled) return;
        const html = res.text ?? (res.blob ? decodeBase64Utf8(res.blob) : "");
        if (!html || (res.mimeType && !isAppPage(res.mimeType))) {
          setLoadedPage(null);
          setPageError(ti("noMcpAppsDesc"));
          return;
        }
        const meta = appResourceMeta(res.meta);
        const csp = appCsp(meta.csp);
        setLoadedPage({
          key: appTabId(selectedApp.server, selectedApp.resourceUri),
          srcDoc: appDocument(html, csp),
        });
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadedPage(null);
        setPageError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setPageLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [connection, online, sessionId, selectedApp, ti, reloadSeq]);

  // Register the postMessage listener synchronously before srcDoc scripts emit ui/initialize.
  useLayoutEffect(() => {
    const frameEl = iframeRef.current;
    if (
      !frameEl ||
      !connection ||
      !sessionId ||
      !selectedApp ||
      !loadedPage
    ) {
      return undefined;
    }

    let live = true;
    const initialContext: AppHostContext = {
      theme: getResolvedTheme(),
      displayMode: "fullscreen",
      availableDisplayModes: ["fullscreen"],
      platform: "desktop",
      locale,
    };

    const callTool = async (name: string, args: Record<string, unknown>) => {
      const result = await connection.link.call("mcp.call", {
        sessionId,
        server: selectedApp.server,
        tool: name,
        arguments: args,
        connector: selectedApp.connector,
      });
      return {
        content: result.content,
        structuredContent: result.structuredContent,
        isError: result.isError,
        _meta: result.meta,
      };
    };

    const bridge = new AppBridge(
      frameEl,
      {
        callTool,
        readResource: async (uri) => {
          const resource = await connection.link.call("mcp.resource", {
            sessionId,
            server: selectedApp.server,
            uri,
            connector: selectedApp.connector,
          });
          return {
            contents: [
              {
                uri,
                mimeType: resource.mimeType,
                ...(resource.blob !== undefined
                  ? { blob: resource.blob }
                  : { text: resource.text ?? "" }),
                _meta: resource.meta,
              },
            ],
          };
        },
        openLink: (url) => {
          if (isSafeExternalUrl(url)) {
            openExternalUrl(url);
          }
        },
        message: actions
          ? async (content) => {
              const extracted = mcpContentBlocks(content);
              const blocks: ContentBlock[] = extracted.flatMap((b): ContentBlock[] => {
                if (b.type === "text" && b.text?.trim()) return [{ type: "text", text: b.text }];
                if (b.type === "image" && b.data && b.mimeType) {
                  return [{ type: "image", data: b.data, mimeType: b.mimeType }];
                }
                return [];
              });
              if (blocks.length > 0) {
                await actions.send(blocks);
              }
            }
          : undefined,
        ready: () => {
          void callTool(selectedApp.tool, {}).then(
            (result) => {
              if (!live) return;
              bridge.notify("ui/notifications/tool-input", { arguments: {} });
              bridge.notify("ui/notifications/tool-result", result);
            },
            (reason: unknown) => {
              if (!live) return;
              bridge.notify("ui/notifications/tool-input", { arguments: {} });
              bridge.notify("ui/notifications/tool-result", {
                content: [{ type: "text", text: reason instanceof Error ? reason.message : String(reason) }],
                isError: true,
              });
            },
          );
        },
      },
      initialContext,
      { name: "LinkShell Desktop", version: "2.0.0" },
    );

    const observer =
      typeof MutationObserver !== "undefined" && typeof document !== "undefined"
        ? new MutationObserver(() => {
            bridge.setContext({ theme: getResolvedTheme() });
          })
        : undefined;

    observer?.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "data-theme-mode"],
    });

    return () => {
      live = false;
      observer?.disconnect();
      void bridge.teardown().finally(() => bridge.dispose());
    };
  }, [connection, sessionId, selectedApp, loadedPage, locale, actions]);

  return (
    <div className="inspector-panel-fill" data-testid="mcp-app-panel">
      <div className="inspector-preview-frame-wrap">
        {safeApps.length === 0 ? (
          <EmptyState
            icon="puzzle"
            title={ti("noMcpAppsTitle")}
            description={ti("noMcpAppsDesc")}
          />
        ) : pageLoading ? (
          <EmptyState compact icon="spinner" title={ti("loading")} />
        ) : pageError ? (
          <EmptyState
            compact
            icon="alert-circle"
            title={selectedApp?.title ?? ti("tabPlugins")}
            description={pageError}
            actions={
              <Button
                size="sm"
                variant="secondary"
                leadingIcon="refresh"
                loading={loading || pageLoading}
                disabled={!online || !sessionId}
                onClick={() => {
                  setReloadSeq((n) => n + 1);
                  onRefresh();
                }}
              >
                {ti("refresh")}
              </Button>
            }
          />
        ) : loadedPage ? (
          <iframe
            ref={iframeRef}
            key={loadedPage.key}
            title={selectedApp?.title ?? "MCP App"}
            sandbox="allow-scripts allow-forms"
            referrerPolicy="no-referrer"
            srcDoc={loadedPage.srcDoc}
            className="inspector-mcp-iframe"
          />
        ) : null}
      </div>
    </div>
  );
}
