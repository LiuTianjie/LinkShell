import { spawn, type ChildProcess } from "node:child_process";
import { platform } from "node:os";

export interface KeepAwakeHandle {
  enabled: boolean;
  stop: () => void;
}

export function shouldKeepAwake(optionEnabled: boolean | undefined): boolean {
  if (process.env.LINKSHELL_KEEP_AWAKE === "0") return false;
  if (platform() !== "darwin") return false;
  return optionEnabled !== false;
}

export function startKeepAwake(): KeepAwakeHandle {
  if (platform() !== "darwin") {
    return { enabled: false, stop: () => {} };
  }

  let child: ChildProcess | undefined;
  let stopping = false;

  try {
    child = spawn("caffeinate", ["-i", "-w", String(process.pid)], {
      stdio: "ignore",
      detached: false,
    });
  } catch (error) {
    process.stderr.write(
      `[bridge] keep-awake unavailable: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return { enabled: false, stop: () => {} };
  }

  child.on("error", (error) => {
    if (stopping) return;
    process.stderr.write(`[bridge] keep-awake unavailable: ${error.message}\n`);
  });

  child.on("exit", (code, signal) => {
    if (stopping) return;
    process.stderr.write(
      `[bridge] keep-awake stopped unexpectedly (code=${code ?? "null"}, signal=${signal ?? "null"})\n`,
    );
  });

  process.stderr.write(
    "[bridge] keep-awake enabled (macOS idle sleep prevention)\n",
  );

  return {
    enabled: true,
    stop: () => {
      stopping = true;
      if (child && !child.killed) {
        child.kill("SIGTERM");
      }
      child = undefined;
    },
  };
}
