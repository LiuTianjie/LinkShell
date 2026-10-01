import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import { loadAuth } from "../auth.js";
import { hostRuntimeOk, resolveGateway, withRunningHost } from "./host.js";

const requireFromCli = createRequire(import.meta.url);

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
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
