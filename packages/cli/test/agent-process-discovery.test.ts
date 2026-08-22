import { describe, expect, it } from "vitest";
import {
  classifyAgentCommand,
  discoverAgentProcesses,
  isControlPlaneCommand,
  liveConversationId,
  parsePsOutput,
  sessionIdFromCommand,
} from "../src/runtime/acp/agent-process-discovery.js";

describe("agent process discovery", () => {
  it("classifies the Open Island agent catalog and ignores control-plane CLIs", () => {
    expect(classifyAgentCommand("claude")).toBe("claude");
    expect(classifyAgentCommand("/Users/me/.local/bin/claude --resume 11111111-1111-4111-8111-111111111111")).toBe("claude");
    expect(classifyAgentCommand("codex")).toBe("codex");
    expect(classifyAgentCommand("gemini")).toBe("gemini");
    expect(classifyAgentCommand("npx @google/gemini-cli")).toBe("gemini");
    expect(classifyAgentCommand("copilot")).toBe("copilot");
    expect(classifyAgentCommand("cursor-agent")).toBe("cursor");
    expect(classifyAgentCommand("kimi")).toBe("kimi");
    expect(classifyAgentCommand("opencode")).toBe("opencode");
    expect(classifyAgentCommand("npx opencode")).toBe("opencode");
    expect(classifyAgentCommand("pnpm dlx opencode-ai")).toBe("opencode");
    expect(classifyAgentCommand("npm install opencode")).toBeUndefined();
    expect(classifyAgentCommand("kimi-mcp")).toBeUndefined();
    expect(classifyAgentCommand("codex app-server --listen stdio://")).toBeUndefined();
    expect(classifyAgentCommand("claude --print --output-format stream-json --verbose")).toBeUndefined();
    expect(isControlPlaneCommand("codex app-server --listen stdio://")).toBe(true);
  });

  it("reads a resume session id from the command line", () => {
    expect(sessionIdFromCommand("claude --resume 11111111-1111-4111-8111-111111111111")).toBe(
      "11111111-1111-4111-8111-111111111111",
    );
  });

  it("parses ps output and discovers one session per TTY/provider", () => {
    const ps = [
      "  11  1 ??      /usr/libexec/sysmond",
      "  21  1 ttys001 claude --resume 11111111-1111-4111-8111-111111111111",
      "  22  1 ttys002 gemini",
      "  23  1 ttys003 kimi",
      "  24  1 ??      opencode",
      "  25  1 ttys004 codex app-server --listen stdio://",
      "  26  1 ttys005 cursor-agent",
    ].join("\n");

    const processes = parsePsOutput(ps);
    expect(processes).toHaveLength(7);

    const snapshots = discoverAgentProcesses({
      processes,
      run: () => undefined,
    });
    expect(snapshots.map((item) => item.provider).sort()).toEqual([
      "claude",
      "cursor",
      "gemini",
      "kimi",
      "opencode",
    ]);
    expect(snapshots.find((item) => item.provider === "claude")?.sessionId).toBe(
      "11111111-1111-4111-8111-111111111111",
    );
    expect(liveConversationId(snapshots.find((item) => item.provider === "gemini")!)).toBe("agent-live-gemini-22");
  });
});
