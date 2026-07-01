import { useEffect, useRef, useState } from "react";
import type { AgentMcpServerDescriptor, AgentMcpServerStatus } from "../lib/types";
import { IconPlug, IconChevronDown } from "./icons";

const MCP_STATUS_LABEL: Record<AgentMcpServerStatus, string> = {
  pending: "等待中",
  connecting: "连接中",
  connected: "已连接",
  failed: "连接失败",
  needs_auth: "需要授权",
};

// Per-status dot color, reusing the app's semantic tokens.
const MCP_STATUS_DOT: Record<AgentMcpServerStatus, string> = {
  pending: "bg-content-faint",
  connecting: "bg-warning",
  connected: "bg-success",
  failed: "bg-danger",
  needs_auth: "bg-warning",
};

// The aggregate dot on the button: red if anything failed, amber if anything is
// still settling / needs auth, green once everything is connected.
function aggregateTone(servers: AgentMcpServerDescriptor[]): string {
  if (servers.some((s) => s.status === "failed")) return "bg-danger";
  if (servers.some((s) => s.status === "pending" || s.status === "connecting" || s.status === "needs_auth")) return "bg-warning";
  return "bg-success";
}

/** Header button showing MCP server connection status (parity with Claude Code /
 *  Codex). Renders nothing when the active provider has no MCP servers, so it
 *  stays out of the way for the common case. */
export function McpStatusButton({ mcpServers }: { mcpServers?: AgentMcpServerDescriptor[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  if (!mcpServers || mcpServers.length === 0) return null;
  const connected = mcpServers.filter((s) => s.status === "connected").length;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title={`MCP 服务器（${connected}/${mcpServers.length} 已连接）`}
        aria-label="MCP 服务器状态"
        className={`flex cursor-pointer items-center gap-1 rounded-md p-1.5 transition-colors ${open ? "bg-accent-dim text-white" : "text-content-muted hover:bg-surface-overlay hover:text-content-primary"}`}
      >
        <IconPlug size={16} />
        <span className={`h-1.5 w-1.5 rounded-full ${aggregateTone(mcpServers)}`} />
      </button>
      {open && (
        <div className="codex-card-raised absolute right-0 top-full z-20 mt-1.5 min-w-[13rem] overflow-hidden p-1 animate-fade-in">
          <div className="px-2 py-1 text-2xs font-medium uppercase tracking-wide text-content-faint">
            MCP 服务器
          </div>
          {mcpServers.map((server) => (
            <div
              key={server.name}
              className="flex items-center gap-2 rounded px-2 py-1.5 text-xs"
              title={server.error ?? MCP_STATUS_LABEL[server.status]}
            >
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${MCP_STATUS_DOT[server.status]}`} />
              <span className="flex-1 truncate text-content-primary">{server.name}</span>
              {typeof server.toolCount === "number" && server.status === "connected" && (
                <span className="text-2xs text-content-faint">{server.toolCount} 个工具</span>
              )}
              <span className="text-2xs text-content-muted">{MCP_STATUS_LABEL[server.status]}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
