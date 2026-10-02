// Opens the built LinkShell.app the way the host does (/usr/bin/open … --args --connect <socket>)
// and talks to it over that socket. The app's first message is `status`. Shared by the tools here.

import { execFile, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

export const APP = join(dirname(fileURLToPath(import.meta.url)), "../build/LinkShell.app");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The processes with this socket in their arguments: the app this script opened, and no other. */
function pidsOf(path) {
  try {
    return execFileSync("/bin/ps", ["-axo", "pid=,command="], { encoding: "utf8" })
      .split("\n")
      .filter((line) => line.includes(path) && line.includes("/Contents/MacOS/LinkShell"))
      .map((line) => Number(line.trim().split(/\s+/)[0]));
  } catch {
    return [];
  }
}

/**
 * Opens the app with a socket of its own and waits for it to connect.
 * `on(type, handler)` hears its messages ("*" for all of them), `send` writes one, and `close`
 * ends the socket and waits for the app to go, as it must.
 */
export async function launch(flags = [], { app = APP } = {}) {
  if (!existsSync(app)) throw new Error(`${app} is not built: node scripts/build-app.mjs`);
  const path = join(tmpdir(), `linkshell-tools-${process.pid}-${randomBytes(4).toString("hex")}.sock`);
  const handlers = new Map();
  const socket = await new Promise((resolve, reject) => {
    const server = createServer();
    const fail = (error) => {
      clearTimeout(timer);
      server.close();
      rmSync(path, { force: true });
      reject(error);
    };
    const timer = setTimeout(() => fail(new Error("LinkShell.app did not connect within 15 seconds")), 15_000);
    server.once("error", fail);
    server.once("connection", (connection) => {
      clearTimeout(timer);
      server.close();
      resolve(connection);
    });
    server.listen(path, () => {
      chmodSync(path, 0o600);
      // Opened by the system, not started as a child: that is what makes the recording LinkShell's.
      execFile("/usr/bin/open", ["-n", "-g", "-a", app, "--args", "--connect", path, ...flags], (error) => {
        if (error) fail(new Error(`LinkShell.app could not be opened: ${error.message}`));
      });
    });
  });
  const [pid] = pidsOf(path);
  rmSync(path, { force: true });
  let gone = false;
  socket.on("error", () => {});
  socket.on("close", () => (gone = true));
  createInterface({ input: socket }).on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    for (const handler of [...(handlers.get(message.t) ?? []), ...(handlers.get("*") ?? [])]) handler(message);
  });

  return {
    pid,
    path,
    on(type, handler) {
      handlers.set(type, [...(handlers.get(type) ?? []), handler]);
    },
    /** The next message of a type, or an error after `timeout` milliseconds. */
    next(type, timeout = 10_000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no ${type} within ${timeout} ms`)), timeout);
        const handler = (message) => {
          clearTimeout(timer);
          handlers.set(type, (handlers.get(type) ?? []).filter((other) => other !== handler));
          resolve(message);
        };
        this.on(type, handler);
      });
    },
    send(message) {
      if (!gone) socket.write(`${JSON.stringify(message)}\n`);
    },
    /** Percent of one core since the last call (from the process's CPU time), and what ps says. */
    cpu: (() => {
      let last;
      return () => {
        if (!pid) return {};
        let said;
        try {
          said = execFileSync("/bin/ps", ["-o", "%cpu=,time=", "-p", String(pid)], { encoding: "utf8" }).trim();
        } catch {
          return {};
        }
        const [percent, time] = said.split(/\s+/);
        const parts = time.split(":").map(Number);
        const used = parts.reduce((total, part) => total * 60 + part, 0);
        const now = performance.now() / 1000;
        const average = last ? ((used - last.used) / (now - last.at)) * 100 : undefined;
        last = { used, at: now };
        return { ps: Number(percent), average };
      };
    })(),
    /** Ends the socket; true when the app went with it (it has two seconds). */
    async close() {
      socket.end();
      for (let waited = 0; waited < 2000; waited += 100) {
        if (pidsOf(path).length === 0) return true;
        await sleep(100);
      }
      // Still there, though the socket closing ends the app. Only ever this script's own app.
      for (const left of pidsOf(path)) {
        try {
          process.kill(left, "SIGKILL");
        } catch {
          // Gone in between.
        }
      }
      return false;
    },
  };
}
