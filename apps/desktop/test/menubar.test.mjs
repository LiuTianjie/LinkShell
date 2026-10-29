import { test } from "node:test";
import assert from "node:assert/strict";
import { connect } from "node:net";
import { MenuBar, menuBarEvents } from "../dist/main/menubar.js";

test("reads whole lines only, and only the events it knows", () => {
  const { events, rest } = menuBarEvents('{"t":"click","id":"open"}\nnot json\n{"t":"click"}\n{"t":"reopen"}\n{"t":"cli');
  assert.deepEqual(events, [{ t: "click", id: "open" }, { t: "reopen" }]);
  assert.equal(rest, '{"t":"cli');
});

/** Plays the Swift `--menubar` process: connects, and hands back what it is sent. */
function menuBarProcess(path) {
  const socket = connect(path);
  const lines = [];
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    buffer += chunk;
    const parts = buffer.split("\n");
    buffer = parts.pop();
    lines.push(...parts.map((line) => JSON.parse(line)));
  });
  return { socket, lines };
}

const until = async (check, ms = 3000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

test("has the system open the menu bar process, sends it the menu, and hears its clicks", async () => {
  const launched = [];
  const events = [];
  const bar = new MenuBar("/Applications/LinkShell.app", (event) => events.push(event), () => {}, (bundle, socket) => launched.push({ bundle, socket }));
  bar.show("LinkShell", [{ id: "open", label: "打开 LinkShell" }, { separator: true }]);
  bar.start();
  try {
    await until(() => launched.length === 1);
    assert.deepEqual(launched[0], { bundle: "/Applications/LinkShell.app", socket: bar.path });

    const agent = menuBarProcess(bar.path);
    await until(() => agent.lines.length === 1);
    assert.deepEqual(agent.lines[0], { t: "menu", tooltip: "LinkShell", items: [{ id: "open", label: "打开 LinkShell" }, { separator: true }] });
    // A change reaches it as it happens.
    bar.show("LinkShell", [{ id: "quit", label: "退出 LinkShell 界面" }]);
    await until(() => agent.lines.length === 2);
    assert.deepEqual(agent.lines[1].items, [{ id: "quit", label: "退出 LinkShell 界面" }]);

    // A line may arrive in pieces.
    agent.socket.write('{"t":"click",');
    agent.socket.write('"id":"open"}\n{"t":"reopen"}\n');
    await until(() => events.length === 2);
    assert.deepEqual(events, [{ t: "click", id: "open" }, { t: "reopen" }]);

    // Gone (quit from Activity Monitor): opened again.
    agent.socket.destroy();
    await until(() => launched.length === 2);
  } finally {
    bar.stop();
  }
});

test("stopping ends the menu bar process and opens no other", async () => {
  const launched = [];
  const bar = new MenuBar("/Applications/LinkShell.app", () => {}, () => {}, () => launched.push(1));
  bar.start();
  await until(() => launched.length === 1);
  const agent = menuBarProcess(bar.path);
  await until(() => agent.lines.length === 1);
  const closed = new Promise((resolve) => agent.socket.on("close", resolve));
  bar.stop();
  await closed;
  await new Promise((resolve) => setTimeout(resolve, 1300));
  assert.equal(launched.length, 1);
});
