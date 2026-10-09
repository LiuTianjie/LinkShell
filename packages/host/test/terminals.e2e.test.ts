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
    // A shell on its way out may still be writing into its home (it is the HOME of the test's shells).
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
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
  it("reattaches to the same foreground process and its in-memory state after leaving the page", async () => {
    const { connect, home } = await setup();
    const a = await connect();
    const { terminal } = await a.client.call("terminals.create", { cwd: home, cols: 80, rows: 24 });
    await a.client.call("terminals.attach", { terminalId: terminal.id, replayFormat: "frames-v1" });
    // A persistent foreground program catches both killing the PTY and silently
    // replacing it with a new shell/program during display restoration.
    const source = "let count=0;console.log('APP_READY:'+process.pid);process.stdin.on('data',()=>console.log('APP_REPLY:'+process.pid+':'+ ++count))";
    const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
    await a.client.call("terminals.input", { terminalId: terminal.id, data: `${quote(process.execPath)} -e ${quote(source)}\n` });
    await until(() => /APP_READY:(\d+)/.test(a.output()));
    const pid = a.output().match(/APP_READY:(\d+)/)![1];
    await a.client.call("terminals.input", { terminalId: terminal.id, data: "before\n" });
    await until(() => a.output().includes(`APP_REPLY:${pid}:1`));
    await a.client.call("terminals.detach", { terminalId: terminal.id });
    a.client.close();

    const b = await connect();
    const attached = await b.client.call("terminals.attach", { terminalId: terminal.id, replayFormat: "frames-v1", snapshot: true });
    expect(attached.state).toBeDefined();
    const restored = await b.client.call("terminals.state", { terminalId: terminal.id, snapshotId: attached.state!.snapshotId, offset: 0 });
    expect(restored.data).toContain(`APP_REPLY:${pid}:1`);
    expect(attached.terminal.id).toBe(terminal.id);
    expect(attached.terminal.exitCode).toBeUndefined();
    await b.client.call("terminals.input", { terminalId: terminal.id, data: "after\n" });
    await until(() => b.output().includes(`APP_REPLY:${pid}:2`));
    expect((await b.client.call("terminals.list", {})).terminals).toHaveLength(1);
  });

  it("opens a 100,000-line journal with bounded history, a stable boundary, and incremental reconnect", async () => {
    const { connect, home } = await setup();
    const a = await connect();
    const { terminal } = await a.client.call("terminals.create", { cwd: home, cols: 80, rows: 24 });
    await a.client.call("terminals.attach", { terminalId: terminal.id });
    const source = "process.stdout.write(Array.from({length:100000},(_,i)=>'bulk-'+i+'\\n').join(''))";
    await a.client.call("terminals.input", { terminalId: terminal.id, data: `'${process.execPath}' -e "${source}"\n` });
    await until(() => a.output().includes("bulk-99999"), 15000);
    const attached = await a.client.call("terminals.attach", { terminalId: terminal.id, snapshot: true, replayFormat: "frames-v1" });
    expect(attached.recording).toBeUndefined();
    expect(attached.state!.length).toBeLessThan(100000);
    expect(attached.replay).toBe("");
    const params = { terminalId: terminal.id, snapshotId: attached.state!.snapshotId, offset: 0 };
    const page = await a.client.call("terminals.state", params);
    expect(page.done).toBe(true);
    expect(page.data).toContain("bulk-99999");
    expect(page.data).not.toContain("bulk-100\r");
    await a.client.call("terminals.input", { terminalId: terminal.id, data: "printf 'af\\164er-snapshot\\n'\n" });
    await until(() => a.output().includes("after-snapshot"));
    expect(await a.client.call("terminals.state", params)).toEqual(page);
    const resumed = await a.client.call("terminals.attach", { terminalId: terminal.id, snapshot: true, replayFormat: "frames-v1", fromSeq: attached.seq, fromFrame: attached.state!.frame });
    expect(resumed.reset).toBe(false);
    expect(resumed.state).toBeUndefined();
    expect(resumed.recording!.afterFrame).toBe(attached.state!.frame);
    const delta = await a.client.call("terminals.replay", { terminalId: terminal.id, afterFrame: resumed.recording!.afterFrame, throughFrame: resumed.recording!.throughFrame });
    expect(delta.frames.map(f => f.data).join("")).toContain("after-snapshot");
    await expect(a.client.call("terminals.state", { ...params, terminalId: "wrong-terminal" })).rejects.toThrow();
  }, 20000);

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
    // The killed shell's exit isn't announced afterwards (it would reappear as "exited").
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(changes[changes.length - 1]).toBe("closed");
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
    const checkpoint = await c2.call("terminals.attach", { terminalId: running.id, snapshot: true, replayFormat: "frames-v1" });
    expect(checkpoint.recording).toBeUndefined();
    expect((await c2.call("terminals.state", { terminalId: running.id, snapshotId: checkpoint.state!.snapshotId, offset: 0 })).data).toContain("still-running");
    const recording = await c2.call("terminals.attach", { terminalId: running.id, replayFormat: "frames-v1" });
    expect(recording.recording!.throughFrame).toBeGreaterThan(0);
    const page = await c2.call("terminals.replay", { terminalId: running.id, afterFrame: 0, throughFrame: recording.recording!.throughFrame });
    expect(page.frames.map((f) => f.data).join("")).toContain("still-running");
    await c2.call("terminals.close", { terminalId: done.id });
    expect((await c2.call("terminals.list", {})).terminals.map((t) => t.id)).toEqual([running.id]);
    c2.close();
    await second.stop();
    rmSync(home, { recursive: true, force: true });
  });
  it("pages the original image and keyboard protocols with a stable attach boundary and original sizes", async () => {
    const { connect } = await setup();
    const a = await connect();
    const { terminal } = await a.client.call("terminals.create", { cols: 80, rows: 24 });
    await a.client.call("terminals.attach", { terminalId: terminal.id });
    await a.client.call("terminals.input", { terminalId: terminal.id, data: "printf '\\033[>31u\\033_Ga=T,f=24,s=1,v=1;////\\033\\\\\\n'\n" });
    await until(() => a.output().includes("\x1b_Ga=T"));
    await a.client.call("terminals.resize", { terminalId: terminal.id, cols: 40, rows: 12 });
    const snapshot = await a.client.call("terminals.attach", { terminalId: terminal.id, replayFormat: "frames-v1" });
    expect(snapshot.reset).toBe(true);
    expect(snapshot.replay).toBe("");
    expect(snapshot.recording!.afterFrame).toBe(0);
    await a.client.call("terminals.input", { terminalId: terminal.id, data: "printf 'l\\141ter-marker\\n'\n" });
    await until(() => a.output().includes("later-marker"));
    let afterFrame = 0;
    const frames: { frame: number; cols: number; rows: number; data: string }[] = [];
    while (afterFrame < snapshot.recording!.throughFrame) {
      const page = await a.client.call("terminals.replay", { terminalId: terminal.id, afterFrame, throughFrame: snapshot.recording!.throughFrame });
      frames.push(...page.frames); afterFrame = page.nextFrame;
    }
    expect(frames.map((f) => f.frame)).toEqual(frames.map((_, i) => i + 1));
    expect(frames[0]).toMatchObject({ cols: 80, rows: 24, data: "" });
    expect(frames.at(-1)).toMatchObject({ cols: 40, rows: 12 });
    const raw = frames.map((f) => f.data).join("");
    expect(raw).toContain("\x1b[>31u");
    expect(raw).toContain("\x1b_Ga=T,f=24,s=1,v=1;////\x1b\\");
    expect(raw).not.toContain("later-marker");
    const resumed = await a.client.call("terminals.attach", { terminalId: terminal.id, replayFormat: "frames-v1", fromFrame: afterFrame });
    expect(resumed.reset).toBe(false);
    expect(resumed.recording!.afterFrame).toBe(afterFrame);
    expect(resumed.recording!.throughFrame).toBeGreaterThan(afterFrame);
    const page = await a.client.call("terminals.replay", { terminalId: terminal.id, afterFrame, throughFrame: resumed.recording!.throughFrame });
    expect(page.frames.map((f) => f.data).join("")).toContain("later-marker");
    await a.client.call("terminals.close", { terminalId: terminal.id });
    await expect(a.client.call("terminals.replay", { terminalId: terminal.id, afterFrame: 0, throughFrame: 1 })).rejects.toThrow();
  });

});
