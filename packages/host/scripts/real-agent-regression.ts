import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyToolchain } from "../test/real-agents/toolchain.js";
import { verifyReport } from "./real-agent-report.js";

const hostDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const reportDirectory = resolve(process.env.LINKSHELL_REAL_AGENT_REPORT_DIR ?? join(hostDirectory, "build/real-agents"));
mkdirSync(reportDirectory, { recursive: true });
const reportPath = join(reportDirectory, "vitest.json");
for (const name of ["vitest.json", "summary.json", "versions.json"]) rmSync(join(reportDirectory, name), { force: true });
// A short canonical path also fits Darwin's Unix socket length limit.
const root = realpathSync(mkdtempSync("/tmp/ls-ci-"));
let child: ChildProcess | undefined;
const kill = () => { if (child?.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch {} } };
const interrupted = () => { kill(); };
process.once("SIGTERM", interrupted); process.once("SIGINT", interrupted);
let timer: ReturnType<typeof setTimeout> | undefined;
try {
  const versions = verifyToolchain();
  writeFileSync(join(reportDirectory, "versions.json"), JSON.stringify({ versions, node: process.version, platform: process.platform, arch: process.arch }, null, 2));
  console.log("Real-agent toolchain:", versions);
  const require = createRequire(import.meta.url);
  child = spawn(process.execPath, [join(dirname(require.resolve("vitest/package.json")), "vitest.mjs"), "run", "--config", "vitest.real-agents.config.ts", "--reporter=default", "--reporter=json", `--outputFile.json=${reportPath}`], {
    cwd: hostDirectory, detached: true, stdio: "inherit", env: { ...process.env, LINKSHELL_REAL_AGENT_ROOT: root },
  });
  timer = setTimeout(kill, 5 * 60_000);
  const code = await new Promise<number | null>((resolve, reject) => { child!.once("error", reject); child!.once("close", resolve); });
  if (code !== 0) throw new Error(`Real-agent process failed (${code ?? "signal/timeout"})`);
  const contracts = verifyReport(JSON.parse(readFileSync(reportPath, "utf8")));
  writeFileSync(join(reportDirectory, "summary.json"), JSON.stringify({ success: true, contracts, versions }, null, 2));
  console.log(`Verified ${contracts.length}/${contracts.length} real-agent contracts; reports: ${reportDirectory}`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  writeFileSync(join(reportDirectory, "summary.json"), JSON.stringify({ success: false, error: message }, null, 2));
  console.error(message); process.exitCode = 1;
} finally {
  clearTimeout(timer); kill(); rmSync(root, { recursive: true, force: true });
  process.off("SIGTERM", interrupted); process.off("SIGINT", interrupted);
}
