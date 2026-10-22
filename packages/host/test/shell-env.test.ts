import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveLoginShellEnv, withCommonPaths, withoutClaudeSession } from "../src/shell-env.js";

describe("withoutClaudeSession", () => {
  it("drops what a surrounding Claude Code session added, and keeps the user's settings", () => {
    const env = withoutClaudeSession({
      PATH: "/usr/bin",
      CLAUDECODE: "1",
      CLAUDE_CODE_CHILD_SESSION: "1",
      CLAUDE_CODE_SESSION_ID: "abc",
      CLAUDE_EFFORT: "low",
      CLAUDE_CODE_MESSAGING_TOKEN: "t",
      CLAUDE_CONFIG_DIR: "/me/.claude",
      ANTHROPIC_API_KEY: "k",
      CLAUDE_CODE_USE_BEDROCK: "1",
    });
    expect(env).toEqual({ PATH: "/usr/bin", CLAUDE_CONFIG_DIR: "/me/.claude", ANTHROPIC_API_KEY: "k", CLAUDE_CODE_USE_BEDROCK: "1" });
  });

  it("leaves an environment alone outside a Claude Code session", () => {
    const outside = { PATH: "/usr/bin", CLAUDE_EFFORT: "high" };
    expect(withoutClaudeSession(outside)).toBe(outside);
  });

  it("lets standalone Claude use the user's provider instead of a parent host's auth", () => {
    const provider = {
      CLAUDE_CONFIG_DIR: "/me/.claude",
      ANTHROPIC_AUTH_TOKEN: "user-token",
      ANTHROPIC_BASE_URL: "http://127.0.0.1:15721",
      ANTHROPIC_MODEL: "user-model",
    };
    const inherited = {
      ...provider,
      CLAUDECODE: "1",
      CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "1",
      CLAUDE_CODE_HOST_AUTH_ENV_VAR: "PARENT_HOST_TOKEN",
    };

    expect(withoutClaudeSession(inherited)).toEqual(provider);
    expect(inherited.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST).toBe("1");
    expect(inherited.CLAUDE_CODE_HOST_AUTH_ENV_VAR).toBe("PARENT_HOST_TOKEN");
  });
});

describe.skipIf(process.platform === "win32")("resolveLoginShellEnv", () => {
  const shell = process.env.SHELL;
  let dir: string | undefined;
  afterEach(() => {
    process.env.SHELL = shell;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });
  const fakeShell = (body: string) => {
    dir = mkdtempSync(join(tmpdir(), "linkshell-shell-"));
    const path = join(dir, "shell");
    writeFileSync(path, `#!/bin/sh\nflags="$1"; shift\n${body}\nexec /bin/sh -c "$1"\n`);
    chmodSync(path, 0o755);
    process.env.SHELL = path;
  };

  it("doesn't wait on a profile that asks a question", async () => {
    // Like compinit's "insecure directories" prompt: it reads stdin, which must be at its end.
    fakeShell('read answer; export FROM_PROFILE=yes');
    const env = await resolveLoginShellEnv(5000);
    expect(env.FROM_PROFILE).toBe("yes");
  });

  it("falls back to a plain login shell when the interactive one fails, and says so when both do", async () => {
    fakeShell('[ "$flags" = "-ilc" ] && exit 3; export FROM_PROFILE=login');
    expect((await resolveLoginShellEnv(5000)).FROM_PROFILE).toBe("login");
    rmSync(dir!, { recursive: true, force: true });
    fakeShell("exit 3");
    const logged: string[] = [];
    const env = await resolveLoginShellEnv(5000, (message) => logged.push(message));
    expect(env.FROM_PROFILE).toBeUndefined();
    expect(logged.join("\n")).toContain("couldn't read the login shell's environment");
  });
});

describe("withCommonPaths", () => {
  it("appends install directories that exist and keeps the user's order", () => {
    const home = mkdtempSync(join(tmpdir(), "linkshell-home-"));
    try {
      const local = join(home, ".local/bin");
      mkdirSync(local, { recursive: true });
      const env = withCommonPaths({ HOME: home, PATH: ["/mine", "/usr/bin"].join(delimiter) });
      const path = env.PATH!.split(delimiter);
      expect(path.slice(0, 2)).toEqual(["/mine", "/usr/bin"]);
      expect(path).toContain(local);
      expect(path).not.toContain(join(home, ".bun/bin"));
      expect(path.filter((entry) => entry === "/usr/bin")).toHaveLength(1);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("registryValue", () => {
  it("reads a REG_EXPAND_SZ Path and expands its variables", async () => {
    const { registryValue } = await import("../src/shell-env.js");
    const output = "\r\nHKEY_CURRENT_USER\\Environment\r\n    Path    REG_EXPAND_SZ    %USERPROFILE%\\AppData\\Local\\Programs;C:\\Tools;\r\n\r\n";
    expect(registryValue(output, { USERPROFILE: "C:\\Users\\me" })).toEqual(["C:\\Users\\me\\AppData\\Local\\Programs", "C:\\Tools"]);
    expect(registryValue("ERROR: The system was unable to find the specified registry key", {})).toEqual([]);
  });
});
