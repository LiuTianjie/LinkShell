import crossSpawn from "cross-spawn";
import { execFile, type ChildProcess, type SpawnOptions } from "node:child_process";
import { join } from "node:path";

/** Windows npm shims need cmd.exe quoting; raw shell:true would reinterpret user arguments. */
export const spawnAgent = (command: string, args: string[], options: SpawnOptions = {}) =>
  crossSpawn(command, args, { windowsHide: true, ...options });

/** npm's Windows shim owns a cmd.exe parent; killing only that parent leaks the agent. */
export async function stopAgent(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    await new Promise<void>(resolve => {
      execFile(join(process.env.SystemRoot || "C:\\Windows", "System32/taskkill.exe"), ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: 5000 }, () => {
        if (child.exitCode === null && child.signalCode === null) child.kill();
        resolve();
      });
    });
    return;
  }
  await new Promise<void>(resolve => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 3000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
    child.kill("SIGTERM");
  });
}

export function probeAgent(command: string, args: string[], options: { env?: NodeJS.ProcessEnv; timeout?: number } = {}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawnAgent(command, args, { env: options.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", finished = false;
    const finish = (error?: Error, terminate = false) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      const settle = () => { if (error) reject(Object.assign(error, { stdout, stderr })); else resolve({ stdout, stderr }); };
      if (terminate) void stopAgent(child).finally(settle); else settle();
    };
    const timer = setTimeout(() => finish(new Error(`${command} timed out`), true), options.timeout ?? 15_000);
    const read = (buffer: Buffer, which: "stdout" | "stderr") => {
      if (which === "stdout") stdout += buffer.toString(); else stderr += buffer.toString();
      if (stdout.length + stderr.length > 4 * 1024 * 1024) finish(new Error(`${command} produced too much output`), true);
    };
    child.stdout!.on("data", data => read(data, "stdout"));
    child.stderr!.on("data", data => read(data, "stderr"));
    child.once("error", finish);
    child.once("close", code => finish(code === 0 ? undefined : new Error(`${command} exited ${code}`)));
  });
}
