import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startHost, type RunningHost } from "../src/host.js";
import { connectHost, type HostClient } from "../src/rpc/client.js";

const running: { host: RunningHost; home: string; clients: HostClient[] }[] = [];

afterEach(async () => {
  for (const { host, home, clients } of running.splice(0)) {
    for (const client of clients) client.close();
    await host.stop();
    rmSync(home, { recursive: true, force: true });
  }
});

async function setup() {
  const home = mkdtempSync(join(tmpdir(), "lsh-term-"));
  // A plain, fast shell: HOME points at an empty directory so no user rc files run.
  const env = { PATH: process.env.PATH, HOME: home, SHELL: "/bin/sh", ENV: "", PS1: "$ ", BASH_SILENCE_DEPRECATION_WARNING: "1" };
  const host = await startHost({ home, version: "test", env, drivers: () => [], log: () => {} });
  const entry = { host, home, clients: [] as HostClient[] };
  running.push(entry);
  const connect = async () => {
    const client = await connectHost(host.paths.hostSocket);
    entry.clients.push(client);
    let output = "";
    let lastSeq = 0;
    client.on("terminal.output", ({ seq, data }) => {
      output += data;
      lastSeq = seq;
    });
    return { client, output: () => output, lastSeq: () => lastSeq };
  };
  return { host, home, connect };
}

async function until(check: () => boolean | Promise<boolean>, ms = 5000) {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("terminals", () => {
  it("runs any command and streams its output", async () => {
    const { connect, home } = await setup();
    const a = await connect();
    const changes: string[] = [];
    a.client.on("terminal.changed", ({ terminal, closed }) => changes.push(closed ? "closed" : terminal.id));
    const { terminal } = await a.client.call("terminals.create", { cwd: home, cols: 100, rows: 30 });
    expect(terminal).toMatchObject({ cwd: home, cols: 100, rows: 30 });
    await a.client.call("terminals.attach", { terminalId: terminal.id });
    await a.client.call("terminals.input", { terminalId: terminal.id, data: "echo linkshell-$((6*7))\n" });
    await until(() => a.output().includes("linkshell-42"));
    expect((await a.client.call("terminals.list", {})).terminals.map((t) => t.id)).toEqual([terminal.id]);

    await a.client.call("terminals.resize", { terminalId: terminal.id, cols: 60, rows: 20 });
    await a.client.call("terminals.input", { terminalId: terminal.id, data: "stty size\n" });
    await until(() => a.output().includes("20 60"));

    await a.client.call("terminals.close", { terminalId: terminal.id });
    await until(() => changes.includes("closed"));
    expect((await a.client.call("terminals.list", {})).terminals).toEqual([]);
  });

  it("keeps running while no one watches, and catches a device up", async () => {
    const { connect } = await setup();
    const a = await connect();
    const { terminal } = await a.client.call("terminals.create", {});
    await a.client.call("terminals.attach", { terminalId: terminal.id });
    // Octal escapes: the output ("first") never appears in the typed command, so
    // matching it can't be fooled by the echo, however the prompt interleaves.
    await a.client.call("terminals.input", { terminalId: terminal.id, data: "printf 'f\\151rst\\n'\n" });
    await until(() => a.output().includes("first"));
    const seen = a.lastSeq();
    a.client.close();

    // The phone is away; the shell keeps working.
    const b = await connect();
    await b.client.call("terminals.input", { terminalId: terminal.id, data: "printf 'wh\\151le-away\\n'\n" });

    // Back with what it had: only the missed output, no redraw.
    let caughtUp = await b.client.call("terminals.attach", { terminalId: terminal.id, fromSeq: seen });
    const deadline = Date.now() + 5000;
    while (!caughtUp.replay.includes("while-away") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 30));
      caughtUp = await b.client.call("terminals.attach", { terminalId: terminal.id, fromSeq: seen });
    }
    expect(caughtUp.reset).toBe(false);
    expect(caughtUp.replay).toContain("while-away");
    expect(caughtUp.replay).not.toContain("f\\151rst");

    // A new device gets the whole screen history.
    const c = await connect();
    const fresh = await c.client.call("terminals.attach", { terminalId: terminal.id });
    expect(fresh.reset).toBe(true);
    expect(fresh.replay).toContain("first");
    expect(fresh.replay).toContain("while-away");
  });

  it("opens on the screen as it is, not the bytes that drew it", async () => {
    const { connect } = await setup();
    const a = await connect();
    const { terminal } = await a.client.call("terminals.create", { cols: 80, rows: 24 });
    await a.client.call("terminals.attach", { terminalId: terminal.id });
    // A progress line redrawn in place, the way prompts and spinners redraw.
    // Octal escapes keep "loading" out of the typed command, so only the output can contain it.
    await a.client.call("terminals.input", {
      terminalId: terminal.id,
      data: "printf 'l\\157ading 10%%\\rl\\157ading 99%%\\rdone-%s-now      \\n' ok\n",
    });
    await until(() => a.output().includes("done-ok-now"));
    // The raw stream drew every frame…
    expect(a.output()).toContain("loading 10%\r");

    const b = await connect();
    const fresh = await b.client.call("terminals.attach", { terminalId: terminal.id });
    expect(fresh.reset).toBe(true);
    expect(fresh.replay).toContain("done-ok-now");
    // …the snapshot has only what's left on screen.
    expect(fresh.replay).not.toContain("loading");
  });

  it("types a start command once the shell is ready, so it shows once", async () => {
    const { connect, home } = await setup();
    const a = await connect();
    const { terminal } = await a.client.call("terminals.create", { cwd: home, command: "printf 'st\\141rted\\n'", cols: 80, rows: 24 });
    await a.client.call("terminals.attach", { terminalId: terminal.id });
    await until(() => a.output().includes("started"));
    const screen = (await a.client.call("terminals.attach", { terminalId: terminal.id })).replay;
    expect(screen.split("printf 'st\\141rted").length - 1).toBe(1);
  });

  it("reports when the shell exits", async () => {
    const { connect } = await setup();
    const a = await connect();
    let exitCode: number | null | undefined;
    a.client.on("terminal.changed", ({ terminal }) => {
      if (terminal.exitCode !== undefined) exitCode = terminal.exitCode;
    });
    const { terminal } = await a.client.call("terminals.create", {});
    await a.client.call("terminals.input", { terminalId: terminal.id, data: "exit 3\n" });
    await until(() => exitCode !== undefined);
    expect(exitCode).toBe(3);
    await expect(a.client.call("terminals.input", { terminalId: terminal.id, data: "x" })).rejects.toThrow();
  });

  it("runs a start command, and keeps ended terminals readable, across host restarts", async () => {
    const home = mkdtempSync(join(tmpdir(), "lsh-term-hist-"));
    const env = { PATH: process.env.PATH, HOME: home, SHELL: "/bin/sh", ENV: "", PS1: "$ ", BASH_SILENCE_DEPRECATION_WARNING: "1" };
    const first = await startHost({ home, version: "test", env, drivers: () => [], log: () => {} });
    const c1 = await connectHost(first.paths.hostSocket);
    let output = "";
    c1.on("terminal.output", ({ data }) => (output += data));
    const { terminal: done } = await c1.call("terminals.create", { cwd: home, command: "echo from-command-$((2+3)); exit 0" });
    const { terminal: running } = await c1.call("terminals.create", { cwd: home, command: "printf 'st\\151ll-running\\n'" });
    await c1.call("terminals.attach", { terminalId: running.id });
    await until(() => output.includes("still-running"));
    await until(async () => (await c1.call("terminals.list", {})).terminals.find((t) => t.id === done.id)?.exitCode === 0);
    const history = await c1.call("terminals.attach", { terminalId: done.id });
    expect(history.replay).toContain("from-command-5");
    expect(history.terminal.command).toContain("from-command");
    c1.close();
    await first.stop();

    const second = await startHost({ home, version: "test", env, drivers: () => [], log: () => {} });
    const c2 = await connectHost(second.paths.hostSocket);
    const { terminals } = await c2.call("terminals.list", {});
    expect(terminals.find((t) => t.id === done.id)).toMatchObject({ exitCode: 0 });
    expect(terminals.find((t) => t.id === running.id)).toMatchObject({ interrupted: true });
    expect((await c2.call("terminals.attach", { terminalId: running.id })).replay).toContain("still-running");
    await c2.call("terminals.close", { terminalId: done.id });
    expect((await c2.call("terminals.list", {})).terminals.map((t) => t.id)).toEqual([running.id]);
    c2.close();
    await second.stop();
    rmSync(home, { recursive: true, force: true });
  });
});
