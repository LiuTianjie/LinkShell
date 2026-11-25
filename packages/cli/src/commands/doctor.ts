import { accessSync, closeSync, constants, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, join } from "node:path";
import { loadAuth } from "../auth.js";
import * as daemon from "../utils/daemon.js";
import { stdoutStyle } from "../utils/format.js";
import { hostRuntimeOk, resolveGateway, silenceSqliteWarning, withRunningHost } from "./host.js";

const requireFromCli = createRequire(import.meta.url);

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

const WAL_BLOAT_WARN_BYTES = 64 * 1024 * 1024;
const LOG_SIZE_WARN_BYTES = 20 * 1024 * 1024;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
}

function fileSize(path: string): number | undefined {
  try {
    return existsSync(path) ? statSync(path).size : undefined;
  } catch {
    return undefined;
  }
}

function isPidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Pure-Node PATH executable lookup (`accessSync(..., X_OK)`), replacing `which` so minimal Linux
 * containers (Alpine, Arch, distroless) work without external shell utilities.
 */
export function findExecutableInPath(
  bin: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (!bin) return undefined;
  const pathEnv = env.PATH ?? env.Path ?? "";
  const dirs = pathEnv.split(platform === "win32" ? ";" : delimiter).filter(Boolean);
  const extensions =
    platform === "win32"
      ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM")
          .split(";")
          .filter(Boolean)
          .map((ext) => (ext.startsWith(".") ? ext : `.${ext}`))
      : [""];

  for (const dir of dirs) {
    for (const ext of extensions) {
      const candidate = join(dir, platform === "win32" && !bin.toLowerCase().endsWith(ext.toLowerCase()) ? `${bin}${ext}` : bin);
      try {
        const st = statSync(candidate);
        if (!st.isFile()) continue;
        if (platform !== "win32") {
          accessSync(candidate, constants.X_OK);
        }
        return candidate;
      } catch {
        // Try next candidate.
      }
    }
  }
  return undefined;
}

/** Audits `~/.linkshell` (`0700`) and sensitive files (`0600`) on multi-user POSIX systems. */
export function auditPermissions(home: string, platform: NodeJS.Platform = process.platform): CheckResult {
  if (platform === "win32") {
    return { name: "Permissions", ok: true, detail: "managed by Windows NTFS ACLs" };
  }
  if (!existsSync(home)) {
    return { name: "Permissions", ok: true, detail: "state directory not created yet" };
  }

  const issues: string[] = [];
  try {
    const dirMode = statSync(home).mode & 0o777;
    if ((dirMode & 0o077) !== 0) {
      issues.push(`${home} is 0${dirMode.toString(8)} (expected 0700: chmod 700 "${home}")`);
    }
  } catch {}

  const privateFiles = ["auth.json", "identity.json", "paired-devices.json", "state.db", "config.json", "host.log", "gateway.log"];
  for (const file of privateFiles) {
    const full = join(home, file);
    if (!existsSync(full)) continue;
    try {
      const mode = statSync(full).mode & 0o777;
      if ((mode & 0o077) !== 0) {
        issues.push(`${file} is 0${mode.toString(8)} (expected 0600: chmod 600 "${full}")`);
      }
    } catch {}
  }

  if (issues.length > 0) {
    return {
      name: "Permissions",
      ok: false,
      detail: `overly broad permissions on multi-user host: ${issues.join("; ")}`,
    };
  }
  return { name: "Permissions", ok: true, detail: `${home} (0700) and private files (0600) ok` };
}

/** Checks `host.log` size and scans the tail for recent critical error lines. */
export function inspectHostLog(logPath: string, warnBytes = LOG_SIZE_WARN_BYTES): CheckResult | undefined {
  const size = fileSize(logPath);
  if (size === undefined) return undefined;

  let recentError: string | undefined;
  try {
    const tailBytes = Math.min(size, 8192);
    if (tailBytes > 0) {
      const fd = openSync(logPath, "r");
      try {
        const buf = Buffer.alloc(tailBytes);
        readSync(fd, buf, 0, tailBytes, size - tailBytes);
        const lines = buf.toString("utf8").split(/\r?\n/).filter(Boolean);
        for (let i = lines.length - 1; i >= 0; i -= 1) {
          const line = lines[i]!;
          if (/\b(uncaught|unhandled rejection|EADDRINUSE|EACCES|SQLITE_CORRUPT|FATAL)\b/i.test(line)) {
            recentError = line.length > 140 ? `${line.slice(0, 137)}...` : line;
            break;
          }
        }
      } finally {
        closeSync(fd);
      }
    }
  } catch {}

  if (size > warnBytes) {
    return {
      name: "Host log",
      ok: false,
      detail: `${formatBytes(size)} exceeds ${formatBytes(warnBytes)} (${logPath})${recentError ? `; recent error: ${recentError}` : ""}`,
    };
  }

  return {
    name: "Host log",
    ok: true,
    detail: recentError
      ? `${formatBytes(size)} — recent error: ${recentError}`
      : `${formatBytes(size)} (${logPath})`,
  };
}

/** Detects proxy environment variables that may affect WebSocket gateway connectivity. */
export function detectProxyEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const keys = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"];
  return keys.filter((key) => Boolean(env[key]?.trim()));
}

/** Reads `/etc/systemd/logind.conf` (and drop-ins) to check whether `KillUserProcesses=yes` is configured. */
export function inspectLogindKillUserProcesses(
  files: string[] = (() => {
    const list = ["/etc/systemd/logind.conf"];
    try {
      const dropInDir = "/etc/systemd/logind.conf.d";
      if (existsSync(dropInDir)) {
        for (const entry of readdirSync(dropInDir).sort()) {
          if (entry.endsWith(".conf")) list.push(join(dropInDir, entry));
        }
      }
    } catch {}
    return list;
  })(),
): boolean | undefined {
  let result: boolean | undefined;
  for (const file of files) {
    try {
      if (!existsSync(file)) continue;
      const content = readFileSync(file, "utf8");
      for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) continue;
        const match = /^KillUserProcesses\s*=\s*(yes|no|true|false|1|0)$/i.exec(trimmed);
        if (match?.[1]) {
          const val = match[1].toLowerCase();
          result = val === "yes" || val === "true" || val === "1";
        }
      }
    } catch {}
  }
  return result;
}

export function inspectLocalState(options: {
  home: string;
  runDir: string;
  hostSocket: string;
  hostRunning: boolean;
  walWarnBytes?: number;
}): CheckResult[] {
  const checks: CheckResult[] = [];
  const walThreshold = options.walWarnBytes ?? WAL_BLOAT_WARN_BYTES;

  const stateSize = fileSize(join(options.home, "state.db"));
  const stateWalSize = fileSize(join(options.home, "state.db-wal")) ?? 0;

  if (stateSize === undefined) {
    checks.push({ name: "Storage", ok: true, detail: "no database yet (created on first host start)" });
  } else {
    const parts: string[] = [
      `state.db ${formatBytes(stateSize)}${stateWalSize > 0 ? ` (WAL ${formatBytes(stateWalSize)})` : ""}`,
    ];
    const bloated: string[] = [];
    if (stateWalSize > walThreshold) bloated.push(`state.db-wal (${formatBytes(stateWalSize)})`);
    if (bloated.length > 0) {
      checks.push({
        name: "Storage",
        ok: false,
        detail: `${parts.join(", ")} — WAL bloat in ${bloated.join(", ")}; restart or idle host to checkpoint`,
      });
    } else {
      checks.push({ name: "Storage", ok: true, detail: parts.join(", ") });
    }
  }

  const pidPath = join(options.home, "host.pid");
  let rawPid: number | undefined;
  let pidFileExists = false;
  if (existsSync(pidPath)) {
    pidFileExists = true;
    const parsed = Number(readFileSync(pidPath, "utf8").trim());
    if (Number.isSafeInteger(parsed) && parsed > 0) rawPid = parsed;
  }
  const pidAlive = rawPid !== undefined && isPidAlive(rawPid);
  const isPipe = options.hostSocket.startsWith("\\\\.\\pipe\\");
  const socketExists = !isPipe && existsSync(options.hostSocket);
  const lockPath = join(options.runDir, "host.lock");
  const lockExists = existsSync(lockPath);

  if (options.hostRunning) {
    if (pidFileExists && !pidAlive) {
      checks.push({
        name: "Host state",
        ok: false,
        detail: `host answers on ${options.hostSocket}, but host.pid (${rawPid ?? "invalid"}) is stale`,
      });
    } else {
      checks.push({
        name: "Host state",
        ok: true,
        detail: rawPid !== undefined ? `pid ${rawPid}, socket ${options.hostSocket}` : `socket ${options.hostSocket}`,
      });
    }
  } else {
    const staleIssues: string[] = [];
    if (pidFileExists) {
      staleIssues.push(
        pidAlive
          ? `host.pid points to live pid ${rawPid} that is not answering on ${options.hostSocket}`
          : `stale host.pid (${rawPid ?? "invalid"})`,
      );
    }
    if (socketExists) {
      staleIssues.push(`stale socket ${options.hostSocket}`);
    }
    if (lockExists) {
      staleIssues.push(`stale lock ${lockPath}`);
    }
    if (staleIssues.length > 0) {
      checks.push({
        name: "Host state",
        ok: false,
        detail: `${staleIssues.join("; ")} — run: linkshell host stop && linkshell host --daemon`,
      });
    }
  }

  return checks;
}

function check(name: string, fn: () => string): CheckResult {
  try {
    return { name, ok: true, detail: fn() };
  } catch (e) {
    return { name, ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

async function checkNodePty(): Promise<CheckResult> {
  let pty: {
    spawn: (
      file: string,
      args: string[],
      options: { name?: string; cols?: number; rows?: number },
    ) => { onExit: (cb: (e: { exitCode: number }) => void) => void; kill: () => void };
  };
  try {
    // Resolve against this installation, not the user's current project.
    pty = requireFromCli("node-pty") as typeof pty;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      name: "node-pty",
      ok: false,
      detail:
        `could not load node-pty from this LinkShell installation: ${reason}. ` +
        "Reinstall linkshell-cli with the package manager you used to install it. " +
        "For a pnpm source checkout, approve node-pty build scripts and reinstall.",
    };
  }

  if (process.platform !== "win32") {
    try {
      const ptyDir = dirname(requireFromCli.resolve("node-pty/package.json"));
      const helper = join(ptyDir, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper");
      if (existsSync(helper)) {
        const mode = statSync(helper).mode & 0o777;
        if ((mode & 0o111) === 0) {
          return {
            name: "node-pty",
            ok: false,
            detail: `spawn-helper is not executable (${helper}, mode 0${mode.toString(8)}) — fix with: chmod +x "${helper}"`,
          };
        }
      }
    } catch {}

    if (existsSync("/bin/sh")) {
      try {
        await new Promise<void>((resolve, reject) => {
          const proc = pty.spawn("/bin/sh", ["-c", "true"], { name: "xterm-color", cols: 80, rows: 24 });
          const timer = setTimeout(() => {
            try { proc.kill(); } catch {}
            reject(new Error("PTY smoke test timed out after 3s"));
          }, 3_000);
          timer.unref();
          proc.onExit(({ exitCode }) => {
            clearTimeout(timer);
            if (exitCode === 0) resolve();
            else reject(new Error(`/bin/sh exited with code ${exitCode}`));
          });
        });
        return { name: "node-pty", ok: true, detail: "loaded (PTY smoke test ok)" };
      } catch (error) {
        return {
          name: "node-pty",
          ok: false,
          detail: `loaded, but PTY smoke test failed: ${error instanceof Error ? error.message : String(error)} (check /dev/pts or spawn-helper permissions)`,
        };
      }
    }
  }

  return { name: "node-pty", ok: true, detail: "loaded" };
}

async function checkSqlite(): Promise<CheckResult> {
  if (!hostRuntimeOk()) {
    return { name: "node:sqlite", ok: false, detail: `requires Node.js 22.13+ (this is ${process.version})` };
  }
  try {
    silenceSqliteWarning();
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(":memory:");
    try {
      const row = db.prepare("SELECT 1 AS ok").get() as { ok?: number } | undefined;
      if (row?.ok !== 1) throw new Error("unexpected query result");
    } finally {
      db.close();
    }
    return { name: "node:sqlite", ok: true, detail: "in-memory probe ok" };
  } catch (error) {
    return { name: "node:sqlite", ok: false, detail: `probe failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

async function checkGateway(name: string, url: string): Promise<CheckResult> {
  try {
    const httpUrl = url.replace(/\/(ws|v2\/connect)\/?$/, "").replace(/\/$/, "").replace(/^wss:/, "https:").replace(/^ws:/, "http:");
    const start = Date.now();
    const res = await fetch(`${httpUrl}/healthz`, { signal: AbortSignal.timeout(5000) });
    const latency = Date.now() - start;
    if (!res.ok) return { name, ok: false, detail: `${url}: HTTP ${res.status}` };
    return { name, ok: true, detail: `${url} answers (${latency}ms)` };
  } catch (e) {
    return { name, ok: false, detail: `${url}: ${e instanceof Error ? e.message : "unreachable"}` };
  }
}

const AGENT_INSTALL: Record<string, string> = {
  claude: "npm i -g @anthropic-ai/claude-code",
  codex: "npm i -g @openai/codex",
};

export async function runDoctor(
  version: string,
  gatewayUrl?: string,
  options: { json?: boolean } = {},
): Promise<CheckResult[]> {
  const style = stdoutStyle();
  if (!options.json) process.stdout.write("\n  LinkShell Doctor\n\n");

  const results: CheckResult[] = [];

  results.push(check("Node.js", () => {
    if (!hostRuntimeOk()) throw new Error(`v${process.versions.node} (the host needs 22.13 or newer)`);
    return `v${process.versions.node}`;
  }));

  results.push(await checkSqlite());
  results.push(await checkNodePty());

  const host = await withRunningHost(async (client) => ({
    info: await client.call("machine.info", {}),
    gateway: await client.call("gateway.status", {}),
  })).catch(() => undefined);

  if (!host) {
    results.push({ name: "Host", ok: false, detail: "not running — start it with: linkshell host --daemon" });
    // Without the host, at least say whether the two main agents are on PATH.
    for (const [bin, hint] of Object.entries(AGENT_INSTALL)) {
      const found = findExecutableInPath(bin);
      results.push({ name: `${bin} (optional)`, ok: true, detail: found ? `found (${found})` : `not installed — ${hint}` });
    }
  } else {
    results.push(
      host.info.hostVersion === version
        ? { name: "Host", ok: true, detail: `running, ${version}` }
        : {
            name: "Host",
            ok: false,
            detail: `running ${host.info.hostVersion}, but this CLI is ${version} — update it with: linkshell host restart`,
          },
    );
    // Agents as the host sees them: what the phone can actually start.
    for (const agent of host.info.agents) {
      if (!agent.installed) {
        const hint = AGENT_INSTALL[agent.id];
        if (hint) results.push({ name: `${agent.label} (optional)`, ok: true, detail: `not installed — ${hint}` });
        continue;
      }
      const signedOut = agent.auth?.state === "missing";
      const problem = agent.problem ?? (signedOut ? (agent.auth?.hint ?? "not logged in") : undefined);
      results.push({ name: agent.label, ok: !problem, detail: `v${agent.version ?? "?"}${problem ? ` — ${problem}` : ""}` });
    }
  }

  {
    const home = daemon.linkshellDir();
    let runDir = join(home, "run");
    let hostSocket = join(runDir, "host.sock");
    if (hostRuntimeOk()) {
      try {
        const { hostPaths } = await import("@linkshell/host");
        const paths = hostPaths(home);
        runDir = paths.runDir;
        hostSocket = paths.hostSocket;
      } catch {
        // Fall back to default layout when @linkshell/host is unavailable.
      }
    }
    results.push(...inspectLocalState({ home, runDir, hostSocket, hostRunning: Boolean(host) }));
    results.push(auditPermissions(home));
    const logCheck = inspectHostLog(daemon.getLogFile("host"));
    if (logCheck) results.push(logCheck);
  }

  if (process.platform === "linux") {
    try {
      const { getServiceStatus, isSystemdUserAvailable } = await import("./service.js");
      const systemdAvailable = await isSystemdUserAvailable();
      if (!systemdAvailable) {
        results.push({
          name: "systemd --user (optional)",
          ok: true,
          detail: "unavailable (container/WSL2/non-systemd) — use `linkshell host --daemon`",
        });
      } else {
        const svc = await getServiceStatus({ platform: "linux", linkshellHome: daemon.linkshellDir() });
        const killUserProcs = inspectLogindKillUserProcesses();
        const lingerText =
          svc.linger === true
            ? "linger enabled"
            : svc.linger === false
              ? `linger disabled${killUserProcs !== false ? " (SSH logout will kill user processes — run: sudo loginctl enable-linger $USER)" : " (run: sudo loginctl enable-linger $USER)"}`
              : "linger unknown";
        results.push({
          name: "systemd --user",
          ok: true,
          detail: svc.installed
            ? `${svc.state}${svc.pid ? ` (PID ${svc.pid})` : ""}, ${lingerText}`
            : `available (not installed — run: linkshell host install-service), ${lingerText}`,
        });
      }
    } catch {}
  }

  const proxyVars = detectProxyEnv();
  if (proxyVars.length > 0) {
    results.push({
      name: "Network proxy (info)",
      ok: true,
      detail: `${proxyVars.join(", ")} set — WebSocket gateway connections may bypass HTTP proxies; ensure gateway host is reachable or configure NO_PROXY for LAN/loopback`,
    });
  }

  const auth = loadAuth();
  results.push({
    name: "Account",
    ok: true,
    detail: auth?.accessToken ? `logged in as ${auth.email || auth.userId}` : "not logged in (only the official gateway needs it: linkshell login)",
  });

  if (host) {
    const gateway = host.gateway;
    if (gateway.status === "online") {
      const account = gateway.account ? `, account ${gateway.account.email ?? gateway.account.userId}` : "";
      const paired = gateway.devices.length ? `, ${gateway.devices.length} paired device(s)` : "";
      results.push({ name: "Gateway", ok: true, detail: `online ${gateway.url}${account}${paired}` });
    } else if (gateway.status === "off") {
      results.push({
        name: "Gateway",
        ok: false,
        detail: "off, so a phone can't reach this computer — linkshell login (official gateway), or linkshell host --gateway <url>",
      });
    } else {
      results.push({ name: "Gateway", ok: false, detail: `${gateway.status} ${gateway.url}${gateway.error ? ` — ${gateway.error.message}` : ""}` });
    }
  } else if (!gatewayUrl && hostRuntimeOk()) {
    const { defaultHome } = await import("@linkshell/host");
    const chosen = resolveGateway(defaultHome());
    results.push(
      chosen
        ? await checkGateway("Gateway", chosen)
        : { name: "Gateway", ok: false, detail: "none chosen — linkshell login (official gateway), or linkshell host --gateway <url>" },
    );
  }
  if (gatewayUrl) results.push(await checkGateway(host ? "Gateway (--gateway)" : "Gateway", gatewayUrl));

  if (host) {
    // Optional: a computer is ready without it, so it never fails the check.
    const { screenAccess, describeScreen } = await import("./screen.js");
    const screen = describeScreen(await screenAccess().catch(() => undefined));
    if (screen) results.push({ name: "Screen (optional)", ok: true, detail: screen });
    const { checkWifi } = await import("./wifi.js");
    const wifi = await checkWifi();
    if (wifi) results.push({ name: "Wi-Fi", ...wifi });
  } else if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    results.push({
      name: "Screen (optional)",
      ok: true,
      detail: "headless Linux (no DISPLAY/WAYLAND_DISPLAY) — screen sharing not applicable",
    });
  }

  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    process.exitCode = 1;
  }

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: failed.length === 0,
          version,
          platform: process.platform,
          checks: results,
        },
        null,
        2,
      )}\n`,
    );
    return results;
  }

  for (const r of results) {
    const icon = r.ok ? style.green("✓") : style.red("✗");
    process.stdout.write(`  ${icon} ${r.name}: ${r.detail}\n`);
  }

  process.stdout.write("\n");
  if (failed.length === 0) {
    process.stdout.write(`  ${style.green("All checks passed.")}\n\n`);
  } else {
    process.stdout.write(`  ${style.yellow(`${failed.length} issue(s) found.`)}\n\n`);
  }
  return results;
}
