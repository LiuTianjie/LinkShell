import { execSync } from "node:child_process";
import { loadConfig, getConfigPath } from "../config.js";

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

async function checkGateway(url: string): Promise<CheckResult> {
  try {
    const httpUrl = url.replace(/\/ws\/?$/, "").replace(/^wss:/, "https:").replace(/^ws:/, "http:");
    const start = Date.now();
    const res = await fetch(`${httpUrl}/healthz`, { signal: AbortSignal.timeout(5000) });
    const latency = Date.now() - start;
    if (!res.ok) return { name: "Gateway", ok: false, detail: `HTTP ${res.status}` };
    return { name: "Gateway", ok: true, detail: `reachable (${latency}ms)` };
  } catch (e) {
    return { name: "Gateway", ok: false, detail: e instanceof Error ? e.message : "unreachable" };
  }
}

export async function runDoctor(gatewayUrl?: string): Promise<void> {
  const config = loadConfig();
  const gateway = gatewayUrl ?? config.gateway;

  process.stdout.write("\n  LinkShell Doctor\n\n");

  const results: CheckResult[] = [];

  // Node.js version
  results.push(check("Node.js", () => {
    const ver = process.versions.node;
    const major = Number(ver.split(".")[0]);
    if (major < 18) throw new Error(`v${ver} (need >= 18)`);
    return `v${ver}`;
  }));

  // node-pty
  results.push(check("node-pty", () => {
    try {
      execSync("node -e \"require('node-pty')\"", { timeout: 5000, stdio: "pipe" });
      return "loaded";
    } catch {
      throw new Error("native module not built — run: pnpm approve-builds && pnpm install --force");
    }
  }));

  // Claude CLI
  const claudePath = which("claude");
  if (claudePath) {
    results.push(check("Claude CLI", () => {
      const ver = execSync("claude --version 2>&1", { encoding: "utf8", timeout: 5000 }).trim();
      return `${ver} (${claudePath})`;
    }));
  } else {
    results.push({ name: "Claude CLI", ok: false, detail: "not found — npm i -g @anthropic-ai/claude-code" });
  }

  // Codex CLI
  const codexPath = which("codex");
  if (codexPath) {
    results.push(check("Codex CLI", () => `found (${codexPath})`));
  } else {
    results.push({ name: "Codex CLI", ok: false, detail: "not found — npm i -g @openai/codex" });
  }

  // Config
  results.push(check("Config", () => {
    const path = getConfigPath();
    const cfg = loadConfig();
    const keys = Object.keys(cfg).filter((k) => cfg[k as keyof typeof cfg] !== undefined);
    if (keys.length === 0) return `${path} (empty — run: linkshell setup)`;
    return `${path} (${keys.join(", ")})`;
  }));

  // Gateway
  if (gateway) {
    results.push(await checkGateway(gateway));
  } else {
    results.push({ name: "Gateway", ok: false, detail: "no gateway configured — run: linkshell setup" });
  }

  // Print results
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
