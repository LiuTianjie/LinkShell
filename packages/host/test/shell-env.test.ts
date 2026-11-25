import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseShellEnvOutput, resolveDefaultShell, resolveLoginShellEnv, withCommonPaths, withoutClaudeSession } from "../src/shell-env.js";
import { defaultTerminalLocale } from "../src/terminals.js";

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
      const qoder = join(home, ".qoder/bin");
      const pnpmLinux = join(home, ".local/share/pnpm");
      const miseShims = join(home, ".local/share/mise/shims");
      const asdfShims = join(home, ".asdf/shims");
      const fnmBin = join(home, ".fnm/aliases/default/bin");
      mkdirSync(local, { recursive: true });
      mkdirSync(qoder, { recursive: true });
      mkdirSync(pnpmLinux, { recursive: true });
      mkdirSync(miseShims, { recursive: true });
      mkdirSync(asdfShims, { recursive: true });
      mkdirSync(fnmBin, { recursive: true });
      const env = withCommonPaths({ HOME: home, PATH: ["/mine", "/usr/bin"].join(delimiter) });
      const path = env.PATH!.split(delimiter);
      expect(path.slice(0, 2)).toEqual(["/mine", "/usr/bin"]);
      expect(path).toContain(local);
      expect(path).toContain(qoder);
      expect(path).toContain(pnpmLinux);
      expect(path).toContain(miseShims);
      expect(path).toContain(asdfShims);
      expect(path).toContain(fnmBin);
      expect(path).not.toContain(join(home, ".bun/bin"));
      expect(path.filter((entry) => entry === "/usr/bin")).toHaveLength(1);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("Linux shell fallback, Alpine env parsing, and default terminal locale", () => {
  it("resolves default POSIX shell via env.SHELL -> userInfo.shell -> bash/zsh/sh without assuming /bin/zsh", () => {
    // Alpine Linux container: no SHELL, no bash, no zsh -> /bin/sh.
    expect(
      resolveDefaultShell({}, { platform: "linux", userShell: null, fileExists: (p) => p === "/bin/sh" }),
    ).toBe("/bin/sh");

    // Standard Linux distro: /bin/bash exists, /bin/zsh does not.
    expect(
      resolveDefaultShell({ SHELL: "/nonexistent/zsh" }, { platform: "linux", userShell: "/missing", fileExists: (p) => p === "/bin/bash" || p === "/bin/sh" }),
    ).toBe("/bin/bash");

    // Respects existing userInfo().shell when env.SHELL is unset.
    expect(
      resolveDefaultShell({}, { platform: "linux", userShell: "/usr/bin/fish", fileExists: (p) => p === "/usr/bin/fish" || p === "/bin/bash" }),
    ).toBe("/usr/bin/fish");

    // Respects existing env.SHELL first.
    expect(
      resolveDefaultShell({ SHELL: "/usr/bin/bash" }, { platform: "linux", userShell: "/bin/sh", fileExists: () => true }),
    ).toBe("/usr/bin/bash");

    expect(resolveDefaultShell({}, { platform: "win32" })).toBe("powershell.exe");
  });

  it("parses Node JSON env output (with multiline values and banner noise) and env -0 / plain env fallbacks", () => {
    const markers = { jsonStart: "<J>", jsonEnd: "</J>", nulStart: "<N>", lineStart: "<L>" };
    const jsonOut = `welcome MOTD\n<J>${JSON.stringify({ PATH: "/usr/bin", MULTI: "line1\nline2", LINKSHELL_RESOLVING_SHELL_ENV: "1" })}</J>\nbye`;
    expect(parseShellEnvOutput(jsonOut, markers)).toEqual({ PATH: "/usr/bin", MULTI: "line1\nline2" });

    const nulOut = `banner<N>PATH=/bin:/usr/bin\0FOO=bar\0LINKSHELL_RESOLVING_SHELL_ENV=1\0`;
    expect(parseShellEnvOutput(nulOut, markers)).toEqual({ PATH: "/bin:/usr/bin", FOO: "bar" });

    const lineOut = `banner<L>PATH=/bin:/usr/bin\nALPINE=1\nLINKSHELL_RESOLVING_SHELL_ENV=1\n`;
    expect(parseShellEnvOutput(lineOut, markers)).toEqual({ PATH: "/bin:/usr/bin", ALPINE: "1" });
  });

  it("prefers C.UTF-8 on Linux when LANG and LC_ALL are unset", () => {
    expect(defaultTerminalLocale({}, "linux")).toBe("C.UTF-8");
    expect(defaultTerminalLocale({ LC_ALL: "zh_CN.UTF-8" }, "linux")).toBeUndefined();
    expect(defaultTerminalLocale({ LANG: "en_GB.UTF-8" }, "linux")).toBe("en_GB.UTF-8");
    expect(defaultTerminalLocale({}, "darwin")).toBe("en_US.UTF-8");
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
