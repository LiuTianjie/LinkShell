import { RpcError } from "@linkshell/wire";
import { linkshellDir } from "../utils/daemon.js";
import { readHidden as readHiddenInput } from "../utils/format.js";
import { assertHostRuntime, silenceSqliteWarning, withRunningHost } from "./host.js";

/** Reads a line without echoing it; from a pipe, just the first line. */
export function readHidden(prompt: string): Promise<string> {
  return readHiddenInput(prompt, { output: process.stdout });
}

function unknownMethod(error: unknown): boolean {
  return error instanceof RpcError && error.code === -32601;
}

/** Applies the change through the running host, or writes it for the next start. */
export async function applyAccessPassword(password: string | undefined): Promise<"live" | "restart" | "file"> {
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

/** Whether this computer has an access password: the running host's answer, else the file. */
export async function accessPasswordEnabled(options?: { live?: boolean }): Promise<boolean> {
  if (options?.live !== false) {
    const live = await withRunningHost((client) => client.call("access.status", {})).catch(() => undefined);
    if (live) return live.password;
  }
  const host = await import("@linkshell/host");
  return new host.AccessControl(linkshellDir()).enabled;
}

export async function runPassword(action: "status" | "set" | "remove"): Promise<void> {
  assertHostRuntime();
  silenceSqliteWarning();
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
  const how = await applyAccessPassword(password);
  const what = password ? "Access password set." : "Access password removed.";
  const when =
    how === "live"
      ? password ? " Devices connected now will be asked for it." : ""
      : how === "restart"
        ? " Restart the host to apply it: linkshell host stop && linkshell host --daemon"
        : " It applies when the host starts.";
  process.stdout.write(`  ${what}${when}\n`);
}
