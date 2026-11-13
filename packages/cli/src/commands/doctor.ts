import { execSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { loadAuth } from "../auth.js";
import * as daemon from "../utils/daemon.js";
import { hostRuntimeOk, resolveGateway, withRunningHost } from "./host.js";

const requireFromCli = createRequire(import.meta.url);

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

const WAL_BLOAT_WARN_BYTES = 64 * 1024 * 1024;

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
  const lsaSize = fileSize(join(options.home, "lsa.db"));
  const lsaWalSize = fileSize(join(options.home, "lsa.db-wal")) ?? 0;

  if (stateSize === undefined && lsaSize === undefined) {
    checks.push({ name: "Storage", ok: true, detail: "no database yet (created on first host start)" });
  } else {
    const parts: string[] = [];
    const bloated: string[] = [];
    if (stateSize !== undefined) {
      parts.push(`state.db ${formatBytes(stateSize)}${stateWalSize > 0 ? ` (WAL ${formatBytes(stateWalSize)})` : ""}`);
      if (stateWalSize > walThreshold) bloated.push(`state.db-wal (${formatBytes(stateWalSize)})`);
    }
    if (lsaSize !== undefined) {
      parts.push(`lsa.db ${formatBytes(lsaSize)}${lsaWalSize > 0 ? ` (WAL ${formatBytes(lsaWalSize)})` : ""}`);
      if (lsaWalSize > walThreshold) bloated.push(`lsa.db-wal (${formatBytes(lsaWalSize)})`);
    }
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

function which(bin: string): string | undefined {
  try {
    return execSync(`which ${bin}`, { encoding: "utf8", timeout: 5000 }).trim() || undefined;
  } catch {
    return undefined;
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

export async function runDoctor(version: string, gatewayUrl?: string): Promise<void> {
  process.stdout.write("\n  LinkShell Doctor\n\n");

  const results: CheckResult[] = [];

  results.push(check("Node.js", () => {
    if (!hostRuntimeOk()) throw new Error(`v${process.versions.node} (the host needs 22.13 or newer)`);
    return `v${process.versions.node}`;
  }));

  results.push(check("node-pty", () => {
    try {
      // Resolve against this installation, not the user's current project.
      requireFromCli("node-pty");
      return "loaded";
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `could not load node-pty from this LinkShell installation: ${reason}. ` +
        "Reinstall linkshell-cli with the package manager you used to install it. " +
        "For a pnpm source checkout, approve node-pty build scripts and reinstall.",
        { cause: error },
      );
    }
  }));

  const host = await withRunningHost(async (client) => ({
    info: await client.call("machine.info", {}),
    gateway: await client.call("gateway.status", {}),
  })).catch(() => undefined);

  if (!host) {
    results.push({ name: "Host", ok: false, detail: "not running — start it with: linkshell host --daemon" });
    // Without the host, at least say whether the two main agents are on the PATH.
    for (const [bin, hint] of Object.entries(AGENT_INSTALL)) {
      const path = which(bin);
      results.push({ name: `${bin} (optional)`, ok: true, detail: path ? `found (${path})` : `not installed — ${hint}` });
    }
  } else {
    results.push(
      host.info.hostVersion === version
        ? { name: "Host", ok: true, detail: `running, ${version}` }
        : {
            name: "Host",
            ok: false,
            detail: `running ${host.info.hostVersion}, but this CLI is ${version} — update it with: linkshell host stop && linkshell host --daemon`,
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
  }

  for (const r of results) {
    const icon = r.ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
    process.stdout.write(`  ${icon} ${r.name}: ${r.detail}\n`);
  }

  const failed = results.filter((r) => !r.ok);
  process.stdout.write("\n");
  if (failed.length === 0) {
    process.stdout.write("  \x1b[32mAll checks passed.\x1b[0m\n\n");
  } else {
    process.stdout.write(`  \x1b[33m${failed.length} issue(s) found.\x1b[0m\n\n`);
  }
}
