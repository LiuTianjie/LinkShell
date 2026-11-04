import crossSpawn from "cross-spawn";
import { execFile, type ChildProcess, type SpawnOptions } from "node:child_process";
import { join } from "node:path";

/** Windows npm shims need cmd.exe quoting; raw shell:true would reinterpret user arguments. */
export const spawnAgent = (command: string, args: string[], options: SpawnOptions = {}) =>
  crossSpawn(command, args, { windowsHide: true, ...options });

/** Ends a child's whole process tree on Windows, where a signal reaches only the shim (cmd.exe) itself. */
export function killTreeOnWindows(pid: number): void {
  execFile(join(process.env.SystemRoot || "C:\\Windows", "System32/taskkill.exe"), ["/pid", String(pid), "/T", "/F"], { windowsHide: true, timeout: 5000 }, () => {});
}

/**
 * npm's Windows shim owns a cmd.exe parent; killing only that parent leaks the agent.
 * `group`: the child leads its own process group (spawned `detached`), and the
 * whole group is ended, so what the agent started itself does not outlive it.
 */
export async function stopAgent(child: ChildProcess, options: { group?: boolean } = {}): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (options.group && process.platform !== "win32") return stopGroup(child, child.pid);
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

async function stopGroup(child: ChildProcess, pid: number): Promise<void> {
  const signal = (name: NodeJS.Signals | 0) => {
    try {
      process.kill(-pid, name);
      return true;
    } catch {
      return false;
    }
  };
  const running = () => child.exitCode === null && child.signalCode === null;
  if (!signal("SIGTERM")) child.kill("SIGTERM");
  // The leader may exit first while the rest of its group (say, the CLI an
  // adapter drives) is still writing out its state: the group gets the same three seconds.
  const deadline = Date.now() + 3000;
  while (running() || signal(0)) {
    if (Date.now() >= deadline) {
      // A group id is not reused while any member lives, so this still reaches only ours.
      signal("SIGKILL");
      if (running()) child.kill("SIGKILL");
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (running()) await new Promise<void>((resolve) => { child.once("exit", () => resolve()); setTimeout(resolve, 1000).unref(); });
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
