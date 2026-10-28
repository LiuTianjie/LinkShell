import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HostStore } from "../src/store.js";
import { TerminalManager } from "../src/terminals.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

function setup() {
  const home = mkdtempSync(join(tmpdir(), "lsh-session-term-"));
  const store = new HostStore(join(home, "state.db"));
  const env = { PATH: process.env.PATH, HOME: home, SHELL: "/bin/sh", ENV: "", PS1: "$ " };
  const open = () => {
    const manager = new TerminalManager(env, store);
    cleanup.push(async () => manager.stop());
    return manager;
  };
  cleanup.push(async () => {
    store.close();
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return { home, store, open };
}

async function until(check: () => boolean, ms = 5000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("session terminals", () => {
  it("carry their session and close when their shell exits, instead of staying as history", async () => {
    const { home, open } = setup();
    const manager = open();
    const closed: string[] = [];
    manager.onChange((terminal, gone) => { if (gone) closed.push(terminal.id); });
    const terminal = manager.create({ cwd: home, cols: 80, rows: 24, sessionId: "codex:abc" });
    expect(terminal.sessionId).toBe("codex:abc");
    expect(manager.list().map((entry) => entry.sessionId)).toEqual(["codex:abc"]);
    manager.input(terminal.id, "exit\n");
    await until(() => manager.list().length === 0);
    expect(closed).toEqual([terminal.id]);
  });

  it("keeps a plain terminal that exits as history", async () => {
    const { home, open } = setup();
    const manager = open();
    const terminal = manager.create({ cwd: home, cols: 80, rows: 24 });
    manager.input(terminal.id, "exit\n");
    await until(() => manager.list()[0]?.exitCode != null);
    expect(manager.list()).toHaveLength(1);
  });

  it("closes only that session's terminals when it goes", () => {
    const { home, open } = setup();
    const manager = open();
    const mine = manager.create({ cwd: home, cols: 80, rows: 24, sessionId: "codex:one" });
    const other = manager.create({ cwd: home, cols: 80, rows: 24, sessionId: "codex:two" });
    const plain = manager.create({ cwd: home, cols: 80, rows: 24 });
    manager.closeForSession("codex:one");
    expect(manager.list().map((entry) => entry.id).sort()).toEqual([other.id, plain.id].sort());
    expect(manager.list().some((entry) => entry.id === mine.id)).toBe(false);
  });

  it("drops a session's terminal the host stopped under, but keeps a plain one as interrupted", () => {
    const { home, open } = setup();
    const first = open();
    first.create({ cwd: home, cols: 80, rows: 24, sessionId: "codex:abc" });
    const plain = first.create({ cwd: home, cols: 80, rows: 24 });
    first.stop();
    const second = open();
    const listed = second.list();
    expect(listed.map((entry) => entry.id)).toEqual([plain.id]);
    expect(listed[0]!.interrupted).toBe(true);
  });
});
