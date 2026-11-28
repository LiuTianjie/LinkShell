import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LINUX_GATEWAY_SERVICE_UNIT,
  LINUX_SERVICE_UNIT,
  MACOS_SERVICE_LABEL,
  WINDOWS_TASK_NAME,
  WINDOWS_WRAPPER_NAME,
  checkLinuxLinger,
  extractGatewayFromServiceFile,
  formatCommandFailure,
  getServiceStatus,
  parseLinuxServiceStatus,
  parseLinuxSystemdShowStatus,
  parseMacServiceStatus,
  parseSystemdShowProperties,
  parseWindowsServiceStatus,
  planInstallGatewayService,
  planInstallService,
  planUninstallGatewayService,
  restartManagedHostService,
  runInstallService,
  runServiceStatus,
  runUninstallService,
  stopManagedHostService,
  type CommandResult,
  type ServiceFs,
} from "../src/commands/service.js";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("service install planning across platforms", () => {
  it("plans a macOS LaunchAgent plist with non-colliding label, KeepAlive on failure, logs, PATH, and custom LINKSHELL_HOME", () => {
    const plan = planInstallService({
      platform: "darwin",
      homeDir: "/Users/alice",
      uid: 501,
      nodePath: "/opt/homebrew/bin/node",
      execArgv: [],
      entryScript: "/opt/homebrew/lib/node_modules/linkshell-cli/dist/cli/src/index.js",
      env: {
        HOME: "/Users/alice",
        PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
        LINKSHELL_HOME: "/Users/alice/.linkshell-dev",
      },
      gateway: "wss://gw.example.com/",
    });

    expect(plan.platform).toBe("darwin");
    expect(plan.serviceName).toBe(MACOS_SERVICE_LABEL);
    expect(plan.serviceName).not.toBe("com.bd.linkshell.host");
    expect(plan.filePath).toBe("/Users/alice/Library/LaunchAgents/com.bd.linkshell.cli-host.plist");
    expect(plan.logPath).toBe("/Users/alice/.linkshell-dev/host.log");

    expect(plan.fileContent).toContain("<string>com.bd.linkshell.cli-host</string>");
    expect(plan.fileContent).toContain("<string>/opt/homebrew/bin/node</string>");
    expect(plan.fileContent).toContain("<string>/opt/homebrew/lib/node_modules/linkshell-cli/dist/cli/src/index.js</string>");
    expect(plan.fileContent).toContain("<string>host</string>");
    expect(plan.fileContent).toContain("<string>--_foreground-host</string>");
    expect(plan.fileContent).toContain("<key>RunAtLoad</key>\n  <true/>");
    expect(plan.fileContent).toContain("<key>KeepAlive</key>\n  <dict>\n    <key>SuccessfulExit</key>\n    <false/>\n  </dict>");
    expect(plan.fileContent).toContain("<key>StandardOutPath</key>\n  <string>/Users/alice/.linkshell-dev/host.log</string>");
    expect(plan.fileContent).toContain("<key>StandardErrorPath</key>\n  <string>/Users/alice/.linkshell-dev/host.log</string>");
    expect(plan.fileContent).toContain("<key>PATH</key>\n    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>");
    expect(plan.fileContent).toContain("<key>LINKSHELL_HOME</key>\n    <string>/Users/alice/.linkshell-dev</string>");
    expect(plan.fileContent).toContain("<key>LINKSHELL_GATEWAY</key>\n    <string>wss://gw.example.com</string>");
    expect(plan.fileContent).not.toContain("LINKSHELL_ENV_FROM_TERMINAL");

    expect(plan.commands).toEqual([
      { command: "launchctl", args: ["bootout", "gui/501/com.bd.linkshell.cli-host"], ignoreFailure: true },
      { command: "launchctl", args: ["bootstrap", "gui/501", "/Users/alice/Library/LaunchAgents/com.bd.linkshell.cli-host.plist"] },
    ]);
  });

  it("omits LINKSHELL_HOME on macOS when using the default directory and escapes XML characters", () => {
    const plan = planInstallService({
      platform: "darwin",
      homeDir: "/Users/al&ice",
      uid: 502,
      nodePath: "/usr/local/bin/node",
      execArgv: [],
      entryScript: "/Users/al&ice/cli/index.js",
      env: {
        HOME: "/Users/al&ice",
        PATH: "/usr/bin:/bin",
        LINKSHELL_HOME: "/Users/al&ice/.linkshell",
      },
      gateway: "default",
    });

    expect(plan.fileContent).not.toContain("<key>LINKSHELL_HOME</key>");
    expect(plan.fileContent).not.toContain("<key>LINKSHELL_GATEWAY</key>");
    expect(plan.fileContent).toContain("/Users/al&amp;ice/cli/index.js");
  });

  it("plans a Linux systemd user unit honoring XDG_CONFIG_HOME and LINKSHELL_HOME", () => {
    const plan = planInstallService({
      platform: "linux",
      homeDir: "/home/alice",
      nodePath: "/usr/bin/node",
      execArgv: [],
      entryScript: "/opt/link shell/dist/index.js",
      env: {
        HOME: "/home/alice",
        XDG_CONFIG_HOME: "/home/alice/.xdg-cfg",
        LINKSHELL_HOME: "/var/tmp/linkshell-home",
      },
      gateway: "off",
    });

    expect(plan.platform).toBe("linux");
    expect(plan.serviceName).toBe(LINUX_SERVICE_UNIT);
    expect(plan.filePath).toBe("/home/alice/.xdg-cfg/systemd/user/linkshell-host.service");
    expect(plan.logPath).toBe("/var/tmp/linkshell-home/host.log");

    expect(plan.fileContent).toContain('ExecStart=/usr/bin/node "/opt/link shell/dist/index.js" host --_foreground-host');
    expect(plan.fileContent).toContain("Restart=on-failure");
    expect(plan.fileContent).toContain("RestartSec=3");
    expect(plan.fileContent).toContain("KillMode=mixed");
    expect(plan.fileContent).toContain("TimeoutStopSec=15");
    expect(plan.fileContent).toContain("StartLimitIntervalSec=60");
    expect(plan.fileContent).toContain("StartLimitBurst=5");
    expect(plan.fileContent).toContain("StandardOutput=append:/var/tmp/linkshell-home/host.log");
    expect(plan.fileContent).toContain("StandardError=append:/var/tmp/linkshell-home/host.log");
    expect(plan.fileContent).toContain('Environment="LINKSHELL_HOME=/var/tmp/linkshell-home"');
    expect(plan.fileContent).toContain('Environment="LINKSHELL_GATEWAY=off"');

    expect(plan.commands).toEqual([
      { command: "systemctl", args: ["--user", "daemon-reload"] },
      { command: "systemctl", args: ["--user", "enable", "--now", "linkshell-host.service"] },
    ]);
  });

  it("uses ~/.config/systemd/user and omits LINKSHELL_HOME on Linux when unset", () => {
    const plan = planInstallService({
      platform: "linux",
      homeDir: "/home/bob",
      nodePath: "/usr/bin/node",
      execArgv: [],
      entryScript: "/usr/lib/node_modules/linkshell-cli/dist/cli/src/index.js",
      env: { HOME: "/home/bob" },
    });

    expect(plan.filePath).toBe("/home/bob/.config/systemd/user/linkshell-host.service");
    expect(plan.fileContent).not.toContain("LINKSHELL_HOME");
    expect(plan.fileContent).not.toContain("LINKSHELL_GATEWAY");
  });

  it("plans a Windows wrapper .cmd and interactive ONLOGON scheduled task", () => {
    const plan = planInstallService({
      platform: "win32",
      homeDir: "C:\\Users\\Alice Smith",
      nodePath: "C:\\Program Files\\nodejs\\node.exe",
      execArgv: [],
      entryScript: "C:\\Users\\Alice Smith\\AppData\\Roaming\\npm\\node_modules\\linkshell-cli\\dist\\cli\\src\\index.js",
      env: {
        USERPROFILE: "C:\\Users\\Alice Smith",
        LINKSHELL_HOME: "D:\\LinkShellData\\100%dev",
      },
      gateway: "ws://192.168.1.50:8787",
    });

    expect(plan.platform).toBe("win32");
    expect(plan.serviceName).toBe(WINDOWS_TASK_NAME);
    expect(plan.filePath).toBe(`D:\\LinkShellData\\100%dev\\${WINDOWS_WRAPPER_NAME}`);
    expect(plan.logPath).toBe("D:\\LinkShellData\\100%dev\\host.log");

    expect(plan.fileContent).toContain("@echo off\r\nsetlocal\r\n");
    expect(plan.fileContent).toContain('set "LINKSHELL_HOME=D:\\LinkShellData\\100%%dev"\r\n');
    expect(plan.fileContent).toContain('set "LINKSHELL_GATEWAY=ws://192.168.1.50:8787"\r\n');
    expect(plan.fileContent).toContain(
      '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\Alice Smith\\AppData\\Roaming\\npm\\node_modules\\linkshell-cli\\dist\\cli\\src\\index.js" host --_foreground-host >> "D:\\LinkShellData\\100%%dev\\host.log" 2>&1',
    );

    expect(plan.commands).toEqual([
      {
        command: "schtasks",
        args: [
          "/Create",
          "/F",
          "/TN",
          "LinkShell Host",
          "/SC",
          "ONLOGON",
          "/RL",
          "LIMITED",
          "/TR",
          '"D:\\LinkShellData\\100%dev\\host-service.cmd"',
        ],
      },
      { command: "schtasks", args: ["/Run", "/TN", "LinkShell Host"] },
    ]);
  });

  it("rejects unsupported platforms and invalid --gateway values", () => {
    expect(() => planInstallService({ platform: "freebsd", homeDir: "/home/a", entryScript: "/a.js" })).toThrow(
      /Unsupported platform "freebsd"/,
    );
    expect(() =>
      planInstallService({ platform: "linux", homeDir: "/home/a", entryScript: "/a.js", gateway: "ftp://bad" }),
    ).toThrow(/Invalid --gateway URL/);
  });
});

describe("service execution, --dry-run, and uninstall", () => {
  it("performs zero filesystem or command side effects during install --dry-run and uninstall --dry-run", async () => {
    const tempHome = makeTempDir("lsh-svc-dry-");
    const fsSpy: ServiceFs = {
      existsSync: vi.fn(() => true),
      mkdirSync: vi.fn(),
      readFileSync: vi.fn(() => ""),
      writeFileSync: vi.fn(),
      rmSync: vi.fn(),
    };
    const runner = vi.fn(async (): Promise<CommandResult> => ({ exitCode: 0, stdout: "", stderr: "" }));
    const stopExistingHost = vi.fn(async () => false);
    let installOutput = "";
    let uninstallOutput = "";

    await runInstallService(
      {
        platform: "darwin",
        dryRun: true,
        homeDir: tempHome,
        uid: 501,
        nodePath: "/usr/local/bin/node",
        execArgv: [],
        entryScript: "/usr/local/bin/linkshell",
        env: { HOME: tempHome, PATH: "/usr/local/bin:/usr/bin" },
      },
      { fs: fsSpy, runner, stopExistingHost, stdout: (t) => { installOutput += t; } },
    );

    expect(fsSpy.mkdirSync).not.toHaveBeenCalled();
    expect(fsSpy.writeFileSync).not.toHaveBeenCalled();
    expect(fsSpy.rmSync).not.toHaveBeenCalled();
    expect(runner).not.toHaveBeenCalled();
    expect(stopExistingHost).not.toHaveBeenCalled();
    expect(existsSync(join(tempHome, "Library"))).toBe(false);
    expect(installOutput).toContain("Dry run");
    expect(installOutput).toContain(join(tempHome, "Library/LaunchAgents/com.bd.linkshell.cli-host.plist"));
    expect(installOutput).toContain("<key>KeepAlive</key>");
    expect(installOutput).toContain("launchctl bootstrap gui/501");

    await runUninstallService(
      {
        platform: "linux",
        dryRun: true,
        homeDir: tempHome,
        nodePath: "/usr/bin/node",
        execArgv: [],
        entryScript: "/usr/bin/linkshell",
        env: { HOME: tempHome },
      },
      { fs: fsSpy, runner, stdout: (t) => { uninstallOutput += t; } },
    );

    expect(fsSpy.rmSync).not.toHaveBeenCalled();
    expect(runner).not.toHaveBeenCalled();
    expect(uninstallOutput).toContain("Dry run");
    expect(uninstallOutput).toContain(join(tempHome, ".config/systemd/user/linkshell-host.service"));
    expect(uninstallOutput).toContain("systemctl --user disable --now linkshell-host.service");
  });

  it("writes the macOS plist, stops an existing daemon, boots out, and bootstraps", async () => {
    const tempHome = makeTempDir("lsh-svc-mac-");
    const calls: Array<{ command: string; args: string[] }> = [];
    const runner = vi.fn(async (command: string, args: string[]): Promise<CommandResult> => {
      calls.push({ command, args });
      if (args[0] === "bootout") return { exitCode: 113, stdout: "", stderr: "Could not find service" };
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    const stopExistingHost = vi.fn(async () => true);
    let output = "";

    const plan = await runInstallService(
      {
        platform: "darwin",
        homeDir: tempHome,
        uid: 501,
        nodePath: "/usr/local/bin/node",
        execArgv: [],
        entryScript: "/opt/linkshell/index.js",
        env: { HOME: tempHome, PATH: "/usr/local/bin:/usr/bin" },
      },
      { runner, stopExistingHost, stdout: (t) => { output += t; } },
    );

    expect(existsSync(plan.filePath)).toBe(true);
    expect(readFileSync(plan.filePath, "utf8")).toBe(plan.fileContent);
    expect(stopExistingHost).toHaveBeenCalledWith(join(tempHome, ".linkshell"));
    expect(calls).toEqual([
      { command: "launchctl", args: ["bootout", "gui/501/com.bd.linkshell.cli-host"] },
      { command: "launchctl", args: ["bootstrap", "gui/501", plan.filePath] },
    ]);
    expect(output).toContain("Installed LinkShell host service");

    // Idempotent uninstall removes plist and tolerates bootout failure when already unloaded
    calls.length = 0;
    await runUninstallService(
      { platform: "darwin", homeDir: tempHome, uid: 501, entryScript: "/opt/linkshell/index.js", env: { HOME: tempHome } },
      { runner, stdout: () => {} },
    );
    expect(existsSync(plan.filePath)).toBe(false);
    expect(calls).toEqual([{ command: "launchctl", args: ["bootout", "gui/501/com.bd.linkshell.cli-host"] }]);

    // Running uninstall a second time remains idempotent
    let secondOut = "";
    await runUninstallService(
      { platform: "darwin", homeDir: tempHome, uid: 501, entryScript: "/opt/linkshell/index.js", env: { HOME: tempHome } },
      { runner, stdout: (t) => { secondOut += t; } },
    );
    expect(secondOut).toContain("already uninstalled");
  });

  it("falls back to launchctl load/unload on older macOS setups without bootstrap", async () => {
    const tempHome = makeTempDir("lsh-svc-mac-legacy-");
    const calls: string[] = [];
    const runner = vi.fn(async (_command: string, args: string[]): Promise<CommandResult> => {
      calls.push(args.join(" "));
      if (args[0] === "bootout" || args[0] === "bootstrap") {
        return { exitCode: 1, stdout: "", stderr: `Unrecognized subcommand: ${args[0]}` };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    const plan = await runInstallService(
      {
        platform: "darwin",
        homeDir: tempHome,
        uid: 501,
        entryScript: "/opt/linkshell/index.js",
        env: { HOME: tempHome, PATH: "/usr/bin" },
      },
      { runner, stopExistingHost: async () => false, stdout: () => {} },
    );

    expect(calls).toEqual([
      "bootout gui/501/com.bd.linkshell.cli-host",
      `unload -w ${plan.filePath}`,
      `bootstrap gui/501 ${plan.filePath}`,
      `unload -w ${plan.filePath}`,
      `load -w ${plan.filePath}`,
    ]);
  });

  it("propagates real launchctl bootstrap failures without masking them with load fallback", async () => {
    const tempHome = makeTempDir("lsh-svc-mac-err-");
    const runner = vi.fn(async (_command: string, args: string[]): Promise<CommandResult> => {
      if (args[0] === "bootout") return { exitCode: 113, stdout: "", stderr: "Could not find service" };
      return { exitCode: 5, stdout: "", stderr: "Bootstrap failed: 5: Input/output error" };
    });

    await expect(
      runInstallService(
        {
          platform: "darwin",
          homeDir: tempHome,
          uid: 501,
          entryScript: "/opt/linkshell/index.js",
          env: { HOME: tempHome, PATH: "/usr/bin" },
        },
        { runner, stopExistingHost: async () => false, stdout: () => {} },
      ),
    ).rejects.toThrow(/Input\/output error.*active macOS user GUI session/);
  });

  it("ignores stale host.pid files during installation", async () => {
    const tempHome = makeTempDir("lsh-svc-stale-pid-");
    const linkshellHome = join(tempHome, ".linkshell");
    const runner = vi.fn(async (): Promise<CommandResult> => ({ exitCode: 0, stdout: "", stderr: "" }));
    const plan = await runInstallService(
      {
        platform: "linux",
        homeDir: tempHome,
        linkshellHome,
        entryScript: "/usr/lib/linkshell/index.js",
        env: { HOME: tempHome },
      },
      { runner, stdout: () => {} },
    );
    expect(existsSync(plan.filePath)).toBe(true);

    writeFileSync(join(linkshellHome, "host.pid"), "999999998\n");
    await expect(
      runInstallService(
        {
          platform: "linux",
          homeDir: tempHome,
          linkshellHome,
          entryScript: "/usr/lib/linkshell/index.js",
          env: { HOME: tempHome },
        },
        { runner, stdout: () => {} },
      ),
    ).resolves.toMatchObject({ serviceName: LINUX_SERVICE_UNIT });
  });

  it("installs, restarts when active, checks linger, and uninstalls the Linux systemd user service", async () => {
    const tempHome = makeTempDir("lsh-svc-linux-");
    const calls: string[] = [];
    const runner = vi.fn(async (command: string, args: string[]): Promise<CommandResult> => {
      calls.push(`${command} ${args.join(" ")}`);
      if (args[1] === "is-active") return { exitCode: 0, stdout: "active\n", stderr: "" };
      if (command === "loginctl" && args[0] === "show-user") return { exitCode: 0, stdout: "yes\n", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    const plan = await runInstallService(
      {
        platform: "linux",
        homeDir: tempHome,
        user: "alice",
        nodePath: "/usr/bin/node",
        execArgv: [],
        entryScript: "/usr/lib/linkshell/index.js",
        env: { HOME: tempHome, PATH: "/home/alice/.nvm/versions/node/v22.13.0/bin:/usr/bin:/bin" },
      },
      { runner, stopExistingHost: async () => false, stdout: () => {} },
    );

    expect(existsSync(plan.filePath)).toBe(true);
    expect(plan.fileContent).toContain('Environment="PATH=/home/alice/.nvm/versions/node/v22.13.0/bin:/usr/bin:/bin"');
    expect(calls).toEqual([
      "systemctl --user is-active linkshell-host.service",
      "systemctl --user daemon-reload",
      "systemctl --user enable --now linkshell-host.service",
      "systemctl --user restart linkshell-host.service",
      "loginctl show-user alice -p Linger --value",
    ]);

    calls.length = 0;
    await runUninstallService(
      { platform: "linux", homeDir: tempHome, entryScript: "/usr/lib/linkshell/index.js", env: { HOME: tempHome } },
      { runner, stdout: () => {} },
    );

    expect(existsSync(plan.filePath)).toBe(false);
    expect(calls).toEqual([
      "systemctl --user disable --now linkshell-host.service",
      "systemctl --user daemon-reload",
    ]);
  });

  it("installs and uninstalls the Windows scheduled task using an in-memory/mocked filesystem", async () => {
    const files = new Map<string, string>();
    const dirs = new Set<string>();
    const fsMock: ServiceFs = {
      existsSync: (p) => files.has(p),
      mkdirSync: (p) => { dirs.add(p); },
      readFileSync: (p) => files.get(p) ?? "",
      writeFileSync: (p, data) => { files.set(p, data); },
      rmSync: (p) => { files.delete(p); },
    };
    const calls: Array<{ command: string; args: string[] }> = [];
    const runner = vi.fn(async (command: string, args: string[]): Promise<CommandResult> => {
      calls.push({ command, args });
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    const plan = await runInstallService(
      {
        platform: "win32",
        homeDir: "C:\\Users\\alice",
        nodePath: "C:\\Program Files\\nodejs\\node.exe",
        execArgv: [],
        entryScript: "C:\\linkshell\\index.js",
        env: { USERPROFILE: "C:\\Users\\alice" },
      },
      { fs: fsMock, runner, stopExistingHost: async () => false, stdout: () => {} },
    );

    expect(dirs.has("C:\\Users\\alice\\.linkshell")).toBe(true);
    expect(files.get("C:\\Users\\alice\\.linkshell\\host-service.cmd")).toBe(plan.fileContent);
    expect(calls).toEqual([
      {
        command: "schtasks",
        args: [
          "/Create",
          "/F",
          "/TN",
          "LinkShell Host",
          "/SC",
          "ONLOGON",
          "/RL",
          "LIMITED",
          "/TR",
          '"C:\\Users\\alice\\.linkshell\\host-service.cmd"',
        ],
      },
      { command: "schtasks", args: ["/Run", "/TN", "LinkShell Host"] },
    ]);

    calls.length = 0;
    await runUninstallService(
      { platform: "win32", homeDir: "C:\\Users\\alice", entryScript: "C:\\linkshell\\index.js", env: { USERPROFILE: "C:\\Users\\alice" } },
      { fs: fsMock, runner, stdout: () => {} },
    );
    expect(files.has("C:\\Users\\alice\\.linkshell\\host-service.cmd")).toBe(false);
    expect(calls).toEqual([
      { command: "schtasks", args: ["/End", "/TN", "LinkShell Host"] },
      { command: "schtasks", args: ["/Delete", "/F", "/TN", "LinkShell Host"] },
    ]);
  });
});

describe("service-status parsing and output", () => {
  it("parses macOS launchctl print states (running, stopped, not-installed)", () => {
    const plist = "/Users/alice/Library/LaunchAgents/com.bd.linkshell.cli-host.plist";

    const running = parseMacServiceStatus(
      true,
      { exitCode: 0, stdout: "gui/501/com.bd.linkshell.cli-host = {\n\tstate = running\n\tpid = 4321\n}\n", stderr: "" },
      plist,
    );
    expect(running).toEqual({
      platform: "darwin",
      serviceName: MACOS_SERVICE_LABEL,
      filePath: plist,
      installed: true,
      loaded: true,
      running: true,
      enabled: true,
      pid: 4321,
      state: "running",
    });

    const stopped = parseMacServiceStatus(
      true,
      { exitCode: 0, stdout: "\tstate = waiting\n\tlast exit code = 0\n", stderr: "" },
      plist,
    );
    expect(stopped).toMatchObject({ installed: true, loaded: true, running: false, state: "stopped" });

    const notInstalled = parseMacServiceStatus(
      false,
      { exitCode: 113, stdout: "", stderr: 'Could not find service "com.bd.linkshell.cli-host" in domain for user gui: 501' },
      plist,
    );
    expect(notInstalled).toEqual({
      platform: "darwin",
      serviceName: MACOS_SERVICE_LABEL,
      filePath: plist,
      installed: false,
      loaded: false,
      running: false,
      state: "not-installed",
    });
  });

  it("parses Linux systemctl status and Windows schtasks query", () => {
    const unit = "/home/alice/.config/systemd/user/linkshell-host.service";
    const linuxActive = parseLinuxServiceStatus(
      true,
      { exitCode: 0, stdout: "active\n", stderr: "" },
      {
        exitCode: 0,
        stdout: [
          "● linkshell-host.service - LinkShell Host",
          "     Loaded: loaded (/home/alice/.config/systemd/user/linkshell-host.service; enabled; preset: enabled)",
          "     Active: active (running) since Sat 2026-11-21 10:00:00 UTC; 5min ago",
          "   Main PID: 9876 (node)",
        ].join("\n"),
        stderr: "",
      },
      unit,
    );
    expect(linuxActive).toEqual({
      platform: "linux",
      serviceName: LINUX_SERVICE_UNIT,
      filePath: unit,
      installed: true,
      loaded: true,
      running: true,
      enabled: true,
      pid: 9876,
      state: "running",
    });

    const wrapper = "C:\\Users\\alice\\.linkshell\\host-service.cmd";
    const winRunning = parseWindowsServiceStatus(
      true,
      { exitCode: 0, stdout: "TaskName: \\LinkShell Host\r\nStatus: Running\r\n", stderr: "" },
      wrapper,
    );
    expect(winRunning).toEqual({
      platform: "win32",
      serviceName: WINDOWS_TASK_NAME,
      filePath: wrapper,
      installed: true,
      loaded: true,
      running: true,
      enabled: true,
      state: "running",
    });

    const winMissing = parseWindowsServiceStatus(
      false,
      { exitCode: 1, stdout: "", stderr: "ERROR: The system cannot find the file specified." },
      wrapper,
    );
    expect(winMissing).toEqual({
      platform: "win32",
      serviceName: WINDOWS_TASK_NAME,
      filePath: wrapper,
      installed: false,
      loaded: false,
      running: false,
      state: "not-installed",
    });
  });

  it("outputs --json and human-readable status via runServiceStatus", async () => {
    const tempHome = makeTempDir("lsh-svc-status-");
    const unitDir = join(tempHome, ".config", "systemd", "user");
    const runner = vi.fn(async (_cmd: string, args: string[]): Promise<CommandResult> => {
      if (args[1] === "is-active") return { exitCode: 3, stdout: "inactive\n", stderr: "" };
      return {
        exitCode: 3,
        stdout: `○ linkshell-host.service\n   Loaded: loaded (${join(unitDir, LINUX_SERVICE_UNIT)}; disabled; preset: enabled)\n   Active: inactive (dead)\n`,
        stderr: "",
      };
    });

    const fsMock: ServiceFs = {
      existsSync: () => true,
      mkdirSync: () => {},
      readFileSync: () => "",
      writeFileSync: () => {},
      rmSync: () => {},
    };

    let jsonOut = "";
    const status = await runServiceStatus(
      { platform: "linux", homeDir: tempHome, entryScript: "/usr/bin/linkshell", json: true, env: { HOME: tempHome } },
      { fs: fsMock, runner, stdout: (t) => { jsonOut += t; } },
    );

    expect(status.state).toBe("stopped");
    expect(JSON.parse(jsonOut)).toMatchObject({
      platform: "linux",
      serviceName: LINUX_SERVICE_UNIT,
      installed: true,
      loaded: true,
      running: false,
      enabled: false,
      state: "stopped",
    });

    let textOut = "";
    await getServiceStatus(
      { platform: "linux", homeDir: tempHome, entryScript: "/usr/bin/linkshell", env: { HOME: tempHome } },
      { fs: fsMock, runner },
    );
    await runServiceStatus(
      { platform: "linux", homeDir: tempHome, entryScript: "/usr/bin/linkshell", json: false, env: { HOME: tempHome } },
      { fs: fsMock, runner, stdout: (t) => { textOut += t; } },
    );
    expect(textOut).toContain("Service:   linkshell-host.service");
    expect(textOut).toContain("stopped");
  });

  it("falls back to launchctl list when launchctl print is unsupported", async () => {
    const runner = vi.fn(async (_cmd: string, args: string[]): Promise<CommandResult> => {
      if (args[0] === "print") {
        return { exitCode: 1, stdout: "", stderr: "Unrecognized subcommand: print" };
      }
      return {
        exitCode: 0,
        stdout: '{\n\t"Label" = "com.bd.linkshell.cli-host";\n\t"PID" = 775;\n};\n',
        stderr: "",
      };
    });
    const status = await getServiceStatus(
      { platform: "darwin", uid: 501, homeDir: "/Users/alice", entryScript: "/usr/local/bin/linkshell", env: { HOME: "/Users/alice" } },
      { fs: { existsSync: () => true, mkdirSync: () => {}, readFileSync: () => "", writeFileSync: () => {}, rmSync: () => {} }, runner },
    );
    expect(status).toEqual({
      platform: "darwin",
      serviceName: MACOS_SERVICE_LABEL,
      filePath: "/Users/alice/Library/LaunchAgents/com.bd.linkshell.cli-host.plist",
      installed: true,
      loaded: true,
      running: true,
      enabled: true,
      pid: 775,
      state: "running",
    });
  });

  it("wires install-service, uninstall-service, and service-status under `linkshell host` in CLI index", () => {
    const loader = createRequire(import.meta.url).resolve("tsx");
    const indexPath = fileURLToPath(new URL("../src/index.ts", import.meta.url));
    const tempHome = makeTempDir("lsh-svc-cli-");
    const customLinks = join(tempHome, "custom-linkshell");
    const cliEnv = { ...process.env, HOME: tempHome, USERPROFILE: tempHome, LINKSHELL_HOME: customLinks };

    const helpOut = execFileSync(process.execPath, ["--import", loader, indexPath, "host", "--help"], {
      encoding: "utf8",
      timeout: 15_000,
    });
    expect(helpOut).toContain("install-service");
    expect(helpOut).toContain("uninstall-service");
    expect(helpOut).toContain("service-status");

    const installDryRun = execFileSync(
      process.execPath,
      ["--import", loader, indexPath, "host", "install-service", "--dry-run", "--gateway", "wss://gw.example"],
      { encoding: "utf8", timeout: 15_000, env: cliEnv },
    );
    expect(installDryRun).toContain("Dry run");
    expect(installDryRun).toContain("wss://gw.example");
    expect(installDryRun).toContain(customLinks);
    expect(existsSync(customLinks)).toBe(false);

    const uninstallDryRun = execFileSync(
      process.execPath,
      ["--import", loader, indexPath, "host", "uninstall-service", "--dry-run"],
      { encoding: "utf8", timeout: 15_000, env: cliEnv },
    );
    expect(uninstallDryRun).toContain("Dry run");

    const statusJsonOut = execFileSync(
      process.execPath,
      ["--import", loader, indexPath, "host", "service-status", "--json"],
      { encoding: "utf8", timeout: 15_000, env: cliEnv },
    );
    const parsed = JSON.parse(statusJsonOut) as { platform: string; installed: boolean; serviceName: string };
    expect(parsed.platform).toBe(process.platform);
    expect(parsed.installed).toBe(false);

    // Ensure a stray test file was not created in tempHome
    writeFileSync(join(tempHome, ".keep"), "");
    expect(existsSync(join(tempHome, ".keep"))).toBe(true);
  });

  it("parses locale-safe systemctl --user show properties, handles linger enable/banner, readiness timeout, and Linux failure hints", async () => {
    const props = parseSystemdShowProperties(
      "LoadState=loaded\nActiveState=active\nSubState=running\nUnitFileState=enabled\nMainPID=5150\nExecMainStatus=0\n",
    );
    expect(props).toMatchObject({ LoadState: "loaded", ActiveState: "active", MainPID: "5150" });

    const unit = "/home/alice/.config/systemd/user/linkshell-host.service";
    const parsed = parseLinuxSystemdShowStatus(
      true,
      {
        exitCode: 0,
        stdout: "LoadState=loaded\nActiveState=active\nSubState=running\nUnitFileState=enabled\nMainPID=5150\nExecMainStatus=0\n",
        stderr: "",
      },
      unit,
      false,
    );
    expect(parsed).toEqual({
      platform: "linux",
      serviceName: LINUX_SERVICE_UNIT,
      filePath: unit,
      installed: true,
      loaded: true,
      running: true,
      enabled: true,
      pid: 5150,
      linger: false,
      state: "running",
    });

    // Linger fallback to /var/lib/systemd/linger/<user> when loginctl fails
    expect(
      await checkLinuxLinger({
        user: "alice",
        runner: async () => ({ exitCode: 1, stdout: "", stderr: "no loginctl" }),
        fs: { existsSync: (p) => p === "/var/lib/systemd/linger/alice" },
      }),
    ).toBe(true);

    // Linger denied during runInstallService prints actionable sudo loginctl enable-linger banner
    const tempHome = makeTempDir("lsh-svc-linger-");
    let out = "";
    const runner = vi.fn(async (cmd: string, args: string[]): Promise<CommandResult> => {
      if (cmd === "systemctl" && args[1] === "is-active") return { exitCode: 3, stdout: "inactive\n", stderr: "" };
      if (cmd === "loginctl" && args[0] === "show-user") return { exitCode: 0, stdout: "no\n", stderr: "" };
      if (cmd === "loginctl" && args[0] === "enable-linger") return { exitCode: 1, stdout: "", stderr: "Access denied" };
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    await runInstallService(
      { platform: "linux", homeDir: tempHome, user: "alice", entryScript: "/usr/bin/linkshell", env: { HOME: tempHome } },
      { runner, stopExistingHost: async () => false, waitForHostReady: async () => true, stdout: (t) => { out += t; } },
    );
    expect(out).toContain("sudo loginctl enable-linger alice");

    // Readiness wait timeout surfaces clear journalctl guidance
    await expect(
      runInstallService(
        { platform: "linux", homeDir: tempHome, user: "alice", entryScript: "/usr/bin/linkshell", env: { HOME: tempHome } },
        { runner, stopExistingHost: async () => false, waitForHostReady: async () => false, stdout: () => {} },
      ),
    ).rejects.toThrow(/journalctl --user -u linkshell-host\.service/);

    // Clear Linux systemd failure hints
    expect(
      formatCommandFailure(
        { command: "systemctl", args: ["--user", "daemon-reload"] },
        { exitCode: 1, stdout: "", stderr: "Failed to connect to bus: No medium found" },
      ),
    ).toContain("XDG_RUNTIME_DIR");

    expect(
      formatCommandFailure(
        { command: "systemctl", args: ["--user", "daemon-reload"] },
        { exitCode: 1, stdout: "", stderr: "System has not been booted with systemd as init system" },
      ),
    ).toContain("linkshell host --daemon");
  });

  it("stops and restarts systemd-managed host services cleanly while refreshing changed unit files", async () => {
    const tempHome = makeTempDir("lsh-svc-lifecycle-");
    const unitPath = join(tempHome, ".config", "systemd", "user", LINUX_SERVICE_UNIT);
    const files = new Map<string, string>([
      [
        unitPath,
        '[Unit]\nDescription=LinkShell Host\n\n[Service]\nExecStart=/old/node /old/index.js host --_foreground-host\nEnvironment="LINKSHELL_GATEWAY=wss://self.example"\n',
      ],
    ]);
    const fsMock: ServiceFs = {
      existsSync: (p) => files.has(p),
      mkdirSync: () => {},
      readFileSync: (p) => files.get(p) ?? "",
      writeFileSync: (p, data) => { files.set(p, data); },
      rmSync: (p) => { files.delete(p); },
    };
    const calls: string[] = [];
    const runner = vi.fn(async (cmd: string, args: string[]): Promise<CommandResult> => {
      calls.push(`${cmd} ${args.join(" ")}`);
      if (cmd === "systemctl" && args[1] === "show") {
        return {
          exitCode: 0,
          stdout: "LoadState=loaded\nActiveState=active\nSubState=running\nUnitFileState=enabled\nMainPID=2222\nExecMainStatus=0\n",
          stderr: "",
        };
      }
      if (cmd === "loginctl") return { exitCode: 0, stdout: "yes\n", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    expect(extractGatewayFromServiceFile("linux", files.get(unitPath)!)).toBe("wss://self.example");

    const restartOutcome = await restartManagedHostService(
      {
        platform: "linux",
        homeDir: tempHome,
        nodePath: "/new/node",
        execArgv: [],
        entryScript: "/new/index.js",
        env: { HOME: tempHome, PATH: "/new:/usr/bin" },
      },
      { fs: fsMock, runner, waitForHostReady: async () => true },
    );
    expect(restartOutcome).toBe("restarted");
    expect(files.get(unitPath)).toContain("ExecStart=/new/node /new/index.js host --_foreground-host");
    expect(files.get(unitPath)).toContain('Environment="LINKSHELL_GATEWAY=wss://self.example"');
    expect(calls).toContain("systemctl --user daemon-reload");
    expect(calls).toContain("systemctl --user restart linkshell-host.service");

    calls.length = 0;
    const stopOutcome = await stopManagedHostService(
      { platform: "linux", homeDir: tempHome, entryScript: "/new/index.js", env: { HOME: tempHome } },
      { fs: fsMock, runner },
    );
    expect(stopOutcome).toBe("stopped");
    expect(calls).toContain("systemctl --user stop linkshell-host.service");

    // Gateway systemd unit planning
    const gwPlan = planInstallGatewayService({
      platform: "linux",
      homeDir: "/home/alice",
      nodePath: "/usr/bin/node",
      execArgv: [],
      entryScript: "/usr/lib/linkshell/index.js",
      port: 9000,
      host: "127.0.0.1",
      env: { HOME: "/home/alice", PATH: "/usr/bin" },
    });
    expect(gwPlan.serviceName).toBe(LINUX_GATEWAY_SERVICE_UNIT);
    expect(gwPlan.fileContent).toContain("gateway --_foreground-gw --port 9000 --host 127.0.0.1");
    expect(gwPlan.fileContent).toContain("KillMode=mixed");
    const gwUninstall = planUninstallGatewayService({
      platform: "linux",
      homeDir: "/home/alice",
      entryScript: "/usr/lib/linkshell/index.js",
      env: { HOME: "/home/alice" },
    });
    expect(gwUninstall.serviceName).toBe(LINUX_GATEWAY_SERVICE_UNIT);
  });
});
