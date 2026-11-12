import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { RpcError } from "@linkshell/wire";

const execFileAsync = promisify(execFile);

const MAX_CLIPBOARD_BYTES = 4 * 1024 * 1024;
const CLIPBOARD_TIMEOUT_MS = 4000;

export interface ClipboardRunner {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  readCommand(command: string, args: string[]): Promise<string>;
  writeCommand(command: string, args: string[], input: string): Promise<void>;
}

export interface ClipboardOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  readCommand?: (command: string, args: string[]) => Promise<string>;
  writeCommand?: (command: string, args: string[], input: string) => Promise<void>;
  runCommand?: (command: string, args: string[], stdinText?: string) => Promise<{ stdout: string }>;
}

function resolveRunner(options?: ClipboardOptions): ClipboardRunner {
  if (!options) return defaultRunner;
  const runCommand = options.runCommand;
  return {
    platform: options.platform ?? defaultRunner.platform,
    env: options.env ?? defaultRunner.env,
    readCommand:
      options.readCommand ??
      (runCommand ? async (cmd, args) => (await runCommand(cmd, args)).stdout : defaultRunner.readCommand),
    writeCommand:
      options.writeCommand ??
      (runCommand
        ? async (cmd, args, input) => {
            await runCommand(cmd, args, input);
          }
        : defaultRunner.writeCommand),
  };
}

const defaultRunner: ClipboardRunner = {
  platform: process.platform,
  env: process.env,
  async readCommand(command, args) {
    const { stdout } = await execFileAsync(command, args, {
      encoding: "utf8",
      timeout: CLIPBOARD_TIMEOUT_MS,
      maxBuffer: MAX_CLIPBOARD_BYTES,
      windowsHide: true,
      env: { ...process.env, LANG: process.env.LANG || "en_US.UTF-8" },
    });
    return stdout;
  },
  async writeCommand(command, args, input) {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(command, args, {
        stdio: ["pipe", "ignore", "pipe"],
        windowsHide: true,
        env: { ...process.env, LANG: process.env.LANG || "en_US.UTF-8" },
      });
      let settled = false;
      let stderr = "";
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          child.kill("SIGKILL");
          reject(new Error("clipboard write timed out"));
        }
      }, CLIPBOARD_TIMEOUT_MS);
      timer.unref();
      child.stderr?.on("data", (chunk: Buffer) => {
        if (stderr.length < 512) stderr += chunk.toString("utf8");
      });
      child.once("error", (error) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(error);
        }
      });
      child.once("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(stderr.trim() || `${command} exited with code ${code ?? "null"}`));
      });
      child.stdin.on("error", () => {});
      child.stdin.end(input, "utf8");
    });
  },
};

function linuxReadCandidates(env: NodeJS.ProcessEnv): Array<[string, string[]]> {
  const wayland: [string, string[]] = ["wl-paste", ["--no-newline"]];
  const xclip: [string, string[]] = ["xclip", ["-selection", "clipboard", "-o"]];
  const xsel: [string, string[]] = ["xsel", ["--clipboard", "--output"]];
  return env.WAYLAND_DISPLAY ? [wayland, xclip, xsel] : [xclip, xsel, wayland];
}

function linuxWriteCandidates(env: NodeJS.ProcessEnv): Array<[string, string[]]> {
  const wayland: [string, string[]] = ["wl-copy", []];
  const xclip: [string, string[]] = ["xclip", ["-selection", "clipboard", "-i"]];
  const xsel: [string, string[]] = ["xsel", ["--clipboard", "--input"]];
  return env.WAYLAND_DISPLAY ? [wayland, xclip, xsel] : [xclip, xsel, wayland];
}

export async function readClipboard(options?: ClipboardOptions): Promise<{ text: string }> {
  const runner = resolveRunner(options);
  if (runner.platform === "darwin") {
    try {
      const text = await runner.readCommand("/usr/bin/pbpaste", []);
      return { text };
    } catch {
      throw RpcError.app("not_supported", "无法读取电脑剪贴板");
    }
  }
  if (runner.platform === "win32") {
    try {
      const out = await runner.readCommand("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-WindowStyle",
        "Hidden",
        "-Command",
        "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Get-Clipboard -Raw",
      ]);
      // `Get-Clipboard -Raw` appends a single CRLF via Write-Output when non-empty.
      const text = out.endsWith("\r\n") ? out.slice(0, -2) : out.endsWith("\n") ? out.slice(0, -1) : out;
      return { text };
    } catch {
      throw RpcError.app("not_supported", "无法读取电脑剪贴板");
    }
  }
  if (runner.platform === "linux") {
    for (const [cmd, args] of linuxReadCandidates(runner.env)) {
      try {
        const text = await runner.readCommand(cmd, args);
        return { text };
      } catch {
        // Try next clipboard utility.
      }
    }
    throw RpcError.app("not_supported", "电脑未安装剪贴板工具（wl-clipboard 或 xclip）");
  }
  throw RpcError.app("not_supported", "当前系统不支持剪贴板同步");
}

export async function writeClipboard(text: string, options?: ClipboardOptions): Promise<{ ok: boolean }> {
  const runner = resolveRunner(options);
  if (Buffer.byteLength(text, "utf8") > MAX_CLIPBOARD_BYTES) {
    throw RpcError.app("too_large", "剪贴板文本太大（超过 4 MB）");
  }
  if (runner.platform === "darwin") {
    try {
      await runner.writeCommand("/usr/bin/pbcopy", [], text);
      return { ok: true };
    } catch {
      throw RpcError.app("not_supported", "无法写入电脑剪贴板");
    }
  }
  if (runner.platform === "win32") {
    try {
      await runner.writeCommand(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-WindowStyle",
          "Hidden",
          "-Command",
          "[Console]::InputEncoding = [System.Text.Encoding]::UTF8; $input | Set-Clipboard",
        ],
        text,
      );
      return { ok: true };
    } catch {
      throw RpcError.app("not_supported", "无法写入电脑剪贴板");
    }
  }
  if (runner.platform === "linux") {
    for (const [cmd, args] of linuxWriteCandidates(runner.env)) {
      try {
        await runner.writeCommand(cmd, args, text);
        return { ok: true };
      } catch {
        // Try next clipboard utility.
      }
    }
    throw RpcError.app("not_supported", "电脑未安装剪贴板工具（wl-clipboard 或 xclip）");
  }
  throw RpcError.app("not_supported", "当前系统不支持剪贴板同步");
}
