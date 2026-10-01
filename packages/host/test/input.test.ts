import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Script } from "node:vm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InputControl, inputEvent, type ControlState } from "../src/input.js";
import { viewerPage } from "../src/screen-viewer.js";

describe("what a viewer may send", () => {
  it("is pointer, button, wheel, key and text events, and nothing else", () => {
    expect(inputEvent.safeParse({ t: "move", x: 0.5, y: 1 }).success).toBe(true);
    expect(inputEvent.safeParse({ t: "down", b: "left", n: 2, m: ["cmd", "shift"] }).success).toBe(true);
    expect(inputEvent.safeParse({ t: "scroll", dx: 0, dy: -12 }).success).toBe(true);
    expect(inputEvent.safeParse({ t: "key", k: "return" }).success).toBe(true);
    expect(inputEvent.safeParse({ t: "text", s: "你好" }).success).toBe(true);
    // Off the display, an unknown button or modifier, something that is not an event.
    expect(inputEvent.safeParse({ t: "move", x: 1.2, y: 0 }).success).toBe(false);
    expect(inputEvent.safeParse({ t: "down", b: "middle" }).success).toBe(false);
    expect(inputEvent.safeParse({ t: "key", k: "c", m: ["hyper"] }).success).toBe(false);
    expect(inputEvent.safeParse({ t: "exec", s: "rm -rf" }).success).toBe(false);
  });
});

describe("the viewer page", () => {
  it("is a page whose script parses, with the stream and the controls in it", () => {
    const page = viewerPage();
    const script = /<script>([\s\S]*)<\/script>/.exec(page)![1]!;
    expect(() => new Script(script)).not.toThrow();
    expect(() => JSON.parse(/<script type="application\/json" id="icons">([\s\S]*?)<\/script>/.exec(page)![1]!)).not.toThrow();
    expect(page).toContain("VideoDecoder");
    for (const id of ["stage", "screen", "pointer", "bar", "menu", "keys", "typing", "shortcut", "mode", "keyboard", "fit", "rotate", "full", "hide"]) expect(page).toContain(`id="${id}"`);
  });
});

const hasSwift = (() => {
  if (process.platform !== "darwin") return false;
  try {
    execFileSync("/usr/bin/xcode-select", ["-p"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasSwift)("the input helper (dry run: events are reported, not posted)", () => {
  const home = mkdtempSync(join(tmpdir(), "linkshell-input-"));
  const before = process.env.LINKSHELL_HOME;
  beforeAll(() => {
    process.env.LINKSHELL_HOME = home;
  });
  afterAll(() => {
    if (before === undefined) delete process.env.LINKSHELL_HOME;
    else process.env.LINKSHELL_HOME = before;
    rmSync(home, { recursive: true, force: true });
  });

  function start() {
    const posted: Record<string, unknown>[] = [];
    const states: ControlState[] = [];
    let wake = () => {};
    const control = new InputControl(
      { state: (state) => (states.push(state), wake()), cursor: () => {}, posted: (event) => (posted.push(event), wake()) },
      () => {},
      { dryRun: true },
    );
    const until = async (done: () => boolean) => {
      const deadline = Date.now() + 5000;
      while (!done()) {
        if (Date.now() > deadline) throw new Error("timed out");
        await new Promise<void>((resolve) => {
          wake = resolve;
          setTimeout(resolve, 100);
        });
      }
    };
    return { control, posted, states, until };
  }

  it("is built once, and turns a viewer's events into the system's", async () => {
    const { control, posted, states, until } = start();
    await control.start(0);
    await until(() => states.length > 0);
    expect(states[0]).toEqual({ available: true, trusted: true });
    expect(readdirSync(join(home, "bin"))).toEqual([expect.stringMatching(/^input-[0-9a-f]{12}$/)]);

    control.send({ t: "move", x: 0, y: 0 });
    control.send({ t: "down", b: "left", n: 2, m: ["cmd", "shift"] });
    // With the button down a move is a drag.
    control.send({ t: "move", x: 1, y: 1 });
    control.send({ t: "up", b: "left", n: 2 });
    control.send({ t: "scroll", dx: 3, dy: -40 });
    control.send({ t: "key", k: "c", m: ["cmd"] });
    control.send({ t: "text", s: "你好 😀" });
    // Not events: dropped before they reach the helper.
    control.send({ t: "key", k: "c", m: ["hyper"] });
    control.send("move");
    control.send({ t: "key", k: "escape" });
    await until(() => posted.some((event) => event.kind === "keyup" && event.k === "escape"));

    const kinds = posted.map((event) => event.kind);
    expect(kinds).toEqual(["move", "down", "drag", "up", "scroll", "keydown", "keyup", "textdown", "textup", "keydown", "keyup"]);
    const [origin, down, drag, , scroll, shortcut, , text] = posted as Record<string, number | string>[];
    expect([origin!.x, origin!.y]).toEqual([0, 0]);
    // ⌘ and ⇧, a double click.
    expect([down!.n, down!.flags]).toEqual([2, 0x100000 | 0x20000]);
    expect(drag!.x as number).toBeGreaterThan(100);
    expect([scroll!.dx, scroll!.dy]).toEqual([3, -40]);
    expect([shortcut!.code, shortcut!.flags]).toEqual([8, 0x100000]);
    expect(text!.s).toBe("你好 😀");
    control.stop();
  }, 120_000);

  it("lets go of a held button when the viewer leaves", async () => {
    const { control, posted, states, until } = start();
    await control.start(0);
    await until(() => states.length > 0);
    control.send({ t: "down", b: "left" });
    await until(() => posted.length === 1);
    control.stop();
    await until(() => posted.length === 2);
    expect(posted[1]).toMatchObject({ kind: "up", b: "left" });
  }, 30_000);
});
