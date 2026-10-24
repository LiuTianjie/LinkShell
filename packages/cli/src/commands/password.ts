import { RpcError } from "@linkshell/wire";
import { linkshellDir } from "../utils/daemon.js";
import { assertHostRuntime, withRunningHost } from "./host.js";

/** Reads a line without echoing it; from a pipe, just the first line. */
function readHidden(prompt: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    return new Promise((resolve) => {
      let text = "";
      stdin.setEncoding("utf8");
      stdin.on("data", (chunk) => (text += chunk));
      stdin.on("end", () => resolve(text.split(/\r?\n/)[0] ?? ""));
    });
  }
  process.stdout.write(prompt);
  return new Promise((resolve, reject) => {
    let value = "";
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const done = (result?: string) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      process.stdout.write("\n");
      if (result === undefined) reject(new Error("cancelled"));
      else resolve(result);
    };
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\u0003") return done();
        if (char === "\r" || char === "\n") return done(value);
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
        else if (char >= " ") value += char;
      }
    };
    stdin.on("data", onData);
  });
}

function unknownMethod(error: unknown): boolean {
  return error instanceof RpcError && error.code === -32601;
}

/** Applies the change through the running host, or writes it for the next start. */
async function apply(password: string | undefined): Promise<"live" | "restart" | "file"> {
  try {
    const result = await withRunningHost((client) => client.call("access.set", password ? { password } : {}));
    if (result) return "live";
  } catch (error) {
    if (!unknownMethod(error)) throw error;
    // A host from before access passwords: it reads the file only when it starts.
    const host = await import("@linkshell/host");
    host.writeAccessPassword(linkshellDir(), password);
    return "restart";
  }
  const host = await import("@linkshell/host");
  host.writeAccessPassword(linkshellDir(), password);
  return "file";
}

export async function runPassword(action: "status" | "set" | "remove"): Promise<void> {
  assertHostRuntime();
  const host = await import("@linkshell/host");
  if (action === "status") {
    const live = await withRunningHost((client) => client.call("access.status", {})).catch(() => undefined);
    const enabled = live?.password ?? new host.AccessControl(linkshellDir()).enabled;
    process.stdout.write(
      enabled
        ? "  Access password: on. Other devices must enter it before they can open this computer.\n  Change it: linkshell password set   Remove it: linkshell password remove\n"
        : "  Access password: off. Devices on your account or paired with this computer open it directly.\n  Set one: linkshell password set\n",
    );
    return;
  }
  let password: string | undefined;
  if (action === "set") {
    try {
      password = await readHidden("  New access password (at least 4 characters): ");
      if (password.length < 4 || password.length > 128) throw new Error("The password must be 4 to 128 characters.");
      if (process.stdin.isTTY && (await readHidden("  Enter it again: ")) !== password) throw new Error("The two entries don't match.");
    } catch (error) {
      if (error instanceof Error && error.message === "cancelled") return;
      throw error;
    }
  }
  const how = await apply(password);
  const what = password ? "Access password set." : "Access password removed.";
  const when =
    how === "live"
      ? password ? " Devices connected now will be asked for it." : ""
      : how === "restart"
        ? " Restart the host to apply it: linkshell host stop && linkshell host --daemon"
        : " It applies when the host starts.";
  process.stdout.write(`  ${what}${when}\n`);
}
