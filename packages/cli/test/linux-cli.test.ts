import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { constants as osConstants, tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { generateCompletion, SUPPORTED_SHELLS } from "../src/commands/completion.js";
import {
  findLanIpv4,
  formatDuration,
  isTerminalFocusSequence,
  restoreTerminal,
  signalExitCode,
  waitForKey,
} from "../src/commands/host.js";
import { parseLogService, readLastLines, runLogs } from "../src/commands/logs.js";
import { describeScreen, screenReady } from "../src/commands/screen.js";
import {
  createStyle,
  formatSshTunnelHint,
  isHeadlessSession,
  isSshSession,
  supportsColor,
} from "../src/utils/format.js";

describe("format.ts NO_COLOR / TTY / headless helpers", () => {
  it("honors NO_COLOR, FORCE_COLOR, TERM=dumb, and TTY state", () => {
    expect(supportsColor({ isTTY: true }, {})).toBe(true);
    expect(supportsColor({ isTTY: false }, {})).toBe(false);
    expect(supportsColor({ isTTY: true }, { NO_COLOR: "1" })).toBe(false);
    expect(supportsColor({ isTTY: false }, { FORCE_COLOR: "1" })).toBe(true);
    expect(supportsColor({ isTTY: true }, { FORCE_COLOR: "0" })).toBe(false);
    expect(supportsColor({ isTTY: true }, { TERM: "dumb" })).toBe(false);
    expect(supportsColor({ isTTY: true }, { NO_COLOR: "1", FORCE_COLOR: "1" })).toBe(false);

    const plain = createStyle({ isTTY: false }, {});
    expect(plain.green("ok")).toBe("ok");
    const colored = createStyle({ isTTY: true }, {});
    expect(colored.green("ok")).toBe("\x1b[32mok\x1b[0m");
  });

  it("detects SSH/headless sessions and formats SSH port-forward hints", () => {
    expect(isSshSession({ SSH_CONNECTION: "1.2.3.4 50000 5.6.7.8 22" })).toBe(true);
    expect(isSshSession({ SSH_TTY: "/dev/pts/0" })).toBe(true);
    expect(isSshSession({})).toBe(false);

    expect(isHeadlessSession({ SSH_CLIENT: "1.2.3.4 1234 22" }, "darwin")).toBe(true);
    expect(isHeadlessSession({}, "linux")).toBe(true);
    expect(isHeadlessSession({ DISPLAY: ":0" }, "linux")).toBe(false);
    expect(isHeadlessSession({ WAYLAND_DISPLAY: "wayland-0" }, "linux")).toBe(false);
    expect(isHeadlessSession({}, "darwin")).toBe(false);

    expect(formatSshTunnelHint(54321, { SSH_CONNECTION: "10.0.0.2 55555 192.168.10.20 22", USER: "dev" })).toBe(
      "ssh -L 54321:127.0.0.1:54321 dev@192.168.10.20",
    );
    expect(formatSshTunnelHint(54321, { USER: "dev" }, "build-box")).toBe(
      "ssh -L 54321:127.0.0.1:54321 dev@build-box",
    );
  });
});

describe("Linux screen diagnostics alignment", () => {
  it("reports X11/Wayland capture+control accurately instead of hardcoding macOS/ffmpeg", () => {
    expect(
      describeScreen(
        { supported: true, ffmpeg: true, recording: true, control: true, app: "dotool" },
        { platform: "linux", env: { WAYLAND_DISPLAY: "wayland-0" } },
      ),
    ).toContain("can be watched and controlled (Wayland, input: dotool)");

    expect(
      describeScreen(
        { supported: true, ffmpeg: true, recording: true, control: false },
        { platform: "linux", env: { DISPLAY: ":0" } },
      ),
    ).toContain("xdotool");

    expect(
      describeScreen(
        { supported: true, ffmpeg: false, recording: false, control: false },
        { platform: "linux", env: { WAYLAND_DISPLAY: "wayland-0" } },
      ),
    ).toContain("wf-recorder");

    expect(
      describeScreen(
        { supported: true, ffmpeg: false, recording: false, control: false },
        { platform: "linux", env: {} },
      ),
    ).toContain("headless Linux");

    expect(screenReady({ supported: true, ffmpeg: true, recording: true, control: false }, "linux")).toBe(true);
    expect(screenReady({ supported: true, ffmpeg: false, recording: false, control: false }, "linux")).toBe(false);
  });
});

describe("LAN IP filtering and terminal shim safety", () => {
  it("filters Linux container, bridge, VM, and VPN interfaces when picking LAN IPv4", () => {
    const mk = (address: string) => [
      { address, netmask: "255.255.255.0", family: "IPv4" as const, mac: "00:00:00:00:00:00", internal: false, cidr: `${address}/24` },
    ];
    expect(
      findLanIpv4({
        docker0: mk("172.17.0.1"),
        "br-abcd1234": mk("172.18.0.1"),
        veth99a: mk("10.244.0.2"),
        virbr0: mk("192.168.122.1"),
        podman0: mk("10.88.0.1"),
        cni0: mk("10.42.0.1"),
        flannel0: mk("10.244.1.0"),
        wg0: mk("10.10.0.2"),
        zt1234: mk("10.147.20.1"),
        lxdbr0: mk("10.55.0.1"),
        incusbr0: mk("10.66.0.1"),
        tailscale0: mk("100.64.1.2"),
        enp3s0: mk("192.168.1.88"),
      }),
    ).toBe("192.168.1.88");
    expect(formatDuration(90061)).toBe("1d 1h");
    expect(formatDuration(125)).toBe("2m 5s");
  });

  it("disables focus reporting and pops Kitty keyboard protocol in restoreTerminal()", () => {
    let written = "";
    restoreTerminal({ isTTY: true, write: (chunk) => { written += chunk; } });
    expect(written).toContain("\x1b[?1004l");
    expect(written).toContain("\x1b[<u");
    expect(written).toContain("\x1b[?1049l");

    let nonTty = "";
    restoreTerminal({ isTTY: false, write: (chunk) => { nonTty += chunk; } });
    expect(nonTty).toBe("");
  });

  it("ignores terminal focus-in/out sequences in waitForKey() and resolves cleanly on EOF", async () => {
    expect(isTerminalFocusSequence("\x1b[I")).toBe(true);
    expect(isTerminalFocusSequence("\x1b[O\x1b[I")).toBe(true);
    expect(isTerminalFocusSequence("a")).toBe(false);

    const stream1 = new PassThrough();
    const wait1 = waitForKey(stream1);
    stream1.write("\x1b[I");
    stream1.write("\x1b[O");
    stream1.write("k");
    expect(await wait1).toBe("k");

    const stream2 = new PassThrough();
    const wait2 = waitForKey(stream2);
    stream2.end();
    expect(await wait2).toBe("\u0003");

    expect(signalExitCode("SIGTERM")).toBe(128 + (osConstants.signals.SIGTERM ?? 15));
    expect(signalExitCode("SIGHUP")).toBe(128 + (osConstants.signals.SIGHUP ?? 1));
  });
});

describe("logs and shell completions", () => {
  it("reads the last N lines of host/gateway/upgrade logs cleanly", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lsh-logs-"));
    try {
      const logFile = join(dir, "host.log");
      writeFileSync(logFile, Array.from({ length: 120 }, (_, i) => `line-${i + 1}`).join("\n") + "\n");
      expect(readLastLines(logFile, 3)).toEqual(["line-118", "line-119", "line-120"]);
      expect(parseLogService("GATEWAY")).toBe("gateway");
      expect(() => parseLogService("invalid")).toThrow(/Invalid --service/);

      let out = "";
      await runLogs({ service: "host", lines: 2, home: dir, stdout: (c) => { out += c; }, stderr: () => {} });
      expect(out).toBe("line-119\nline-120\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("generates bash, zsh, and fish completion scripts and rejects unknown shells", () => {
    for (const shell of SUPPORTED_SHELLS) {
      const script = generateCompletion(shell);
      expect(script).toContain("linkshell");
      expect(script).toContain("install-service");
      expect(script).toContain("completion");
      expect(script).toMatch(/--email|-l email/);
    }
    expect(() => generateCompletion("powershell")).toThrow(/Unsupported shell/);
  });

  it("wires completion, logs, restart, login flags, and gateway --host in CLI index", () => {
    const loader = createRequire(import.meta.url).resolve("tsx");
    const indexPath = fileURLToPath(new URL("../src/index.ts", import.meta.url));

    const bashOut = execFileSync(process.execPath, ["--import", loader, indexPath, "completion", "bash"], {
      encoding: "utf8",
      timeout: 15_000,
    });
    expect(bashOut).toContain("_linkshell_completions");

    const badShell = spawnSync(process.execPath, ["--import", loader, indexPath, "completion", "tcsh"], {
      encoding: "utf8",
      timeout: 15_000,
    });
    expect(badShell.status).toBe(1);

    const loginHelp = execFileSync(process.execPath, ["--import", loader, indexPath, "login", "--help"], {
      encoding: "utf8",
      timeout: 15_000,
    });
    expect(loginHelp).toContain("--email");
    expect(loginHelp).toContain("--password-stdin");
    expect(loginHelp).toContain("--no-browser");

    const gwHelp = execFileSync(process.execPath, ["--import", loader, indexPath, "gateway", "--help"], {
      encoding: "utf8",
      timeout: 15_000,
    });
    expect(gwHelp).toContain("--host");
    expect(gwHelp).toContain("install-service");

    const topHelp = execFileSync(process.execPath, ["--import", loader, indexPath, "--help"], {
      encoding: "utf8",
      timeout: 15_000,
    });
    expect(topHelp).toContain("logs");
    expect(topHelp).toContain("restart");
    expect(topHelp).toContain("completion");

    // Failed login must exit with status 1, never silently exit 0.
    const failedLogin = spawnSync(process.execPath, ["--import", loader, indexPath, "login", "--password-stdin"], {
      input: "secret\n",
      encoding: "utf8",
      timeout: 15_000,
      env: { ...process.env, NO_COLOR: "1" },
    });
    expect(failedLogin.status).toBe(1);
    expect(failedLogin.stderr).toContain("--password-stdin requires --email");
  });
});
