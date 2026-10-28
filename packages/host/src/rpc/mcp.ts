import { RpcError, type MethodParams, type MethodResult } from "@linkshell/wire";
import type { McpAppsSupport } from "../drivers/types.js";
import type { SessionHub } from "../hub.js";

/** The session's MCP Apps and its native id; refused for an agent that has none, or a Codex that can't run. */
function mcpOf(hub: SessionHub, sessionId: string): { mcp: McpAppsSupport; nativeId: string } {
  const { session, driver } = hub.sessionDriver(sessionId);
  if (!driver?.mcpApps) throw RpcError.app("not_supported", "插件页面（MCP App）只在 Codex 会话里可用");
  const status = driver.status();
  if (!status.installed) throw RpcError.app("agent_unavailable", `这台电脑上没有安装 ${driver.label}`);
  if (status.problem) throw RpcError.app("agent_unavailable", `${driver.label} 现在用不了：${status.problem}`);
  return { mcp: driver.mcpApps, nativeId: session.nativeId };
}

/** `mcp.*`: MCP tools with pages of their own, in Codex sessions. */
export function mcpHandlers(hub: SessionHub) {
  return {
    "mcp.apps": async (params: MethodParams<"mcp.apps">): Promise<MethodResult<"mcp.apps">> => {
      const { mcp, nativeId } = mcpOf(hub, params.sessionId);
      return { apps: await mcp.apps(nativeId) };
    },
    "mcp.resource": (params: MethodParams<"mcp.resource">): Promise<MethodResult<"mcp.resource">> => {
      const { sessionId, ...request } = params;
      const { mcp, nativeId } = mcpOf(hub, sessionId);
      return mcp.resource(nativeId, request);
    },
    "mcp.call": (params: MethodParams<"mcp.call">): Promise<MethodResult<"mcp.call">> => {
      const { sessionId, ...request } = params;
      const { mcp, nativeId } = mcpOf(hub, sessionId);
      return mcp.call(nativeId, request);
    },
  };
}
