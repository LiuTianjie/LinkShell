import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Script } from "node:vm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeInputApp, inputApp, InputControl, inputEvent, shippedApp, usableApp, type ControlState } from "../src/input.js";
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
      // The helper compiled here, as the host's child: what a build without the signed app runs.
      { dryRun: true, app: false },
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
    expect(states[0]).toMatchObject({ available: true, trusted: true });
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
    // Modifiers are keys too: down before what they modify, up after it, as a hand does it.
    expect(kinds).toEqual([
      "move", "moddown", "moddown", "down", "drag", "up", "modup", "modup",
      "scroll", "moddown", "keydown", "keyup", "modup", "textdown", "textup", "keydown", "keyup",
    ]);
    const plain = posted.filter((event) => event.kind !== "moddown" && event.kind !== "modup");
    const [origin, down, drag, , scroll, shortcut, , text] = plain as Record<string, number | string>[];
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

describe.skipIf(!shippedApp())("LinkShell.app as a package delivers it", () => {
  const work = mkdtempSync(join(tmpdir(), "linkshell-app-"));
  afterAll(() => {
    chmodSync(join(work, "locked"), 0o755);
    rmSync(work, { recursive: true, force: true });
  });
  const program = (app: string) => join(app, "Contents/MacOS/LinkShell");
  const status = (app: string) => JSON.parse(execFileSync(program(app), ["--status"], { encoding: "utf8" })) as { t: string };

  it("runs again after packing dropped its permission to run, signature intact", () => {
    // What `pnpm pack` leaves: every file a plain one.
    const packed = join(work, "packed/LinkShell.app");
    cpSync(shippedApp()!, packed, { recursive: true });
    chmodSync(program(packed), 0o644);
    expect(usableApp(packed, join(work, "unused/LinkShell.app"))).toBe(packed);
    expect(statSync(program(packed)).mode & 0o111).not.toBe(0);
    expect(status(packed).t).toBe("status");
    expect(() => execFileSync("/usr/bin/codesign", ["--verify", "--strict", packed])).not.toThrow();
  });

  it("uses a copy of its own where the installation can't be written to", () => {
    const locked = join(work, "locked/LinkShell.app");
    cpSync(shippedApp()!, locked, { recursive: true });
    chmodSync(program(locked), 0o644);
    // Not root's, but as good as: the program can't be made runnable where it is.
    chmodSync(join(locked, "Contents/MacOS"), 0o555);
    chmodSync(program(locked), 0o444);
    const copy = join(work, "home/LinkShell.app");
    const usable = process.getuid?.() === 0 ? copy : usableApp(locked, copy);
    // The owner can still change the mode of their own file, so either answer is a runnable app.
    expect([locked, copy]).toContain(usable);
    expect(status(usable!).t).toBe("status");
    chmodSync(join(locked, "Contents/MacOS"), 0o755);
  });
});

describe.skipIf(!shippedApp())("LinkShell.app (dry run), opened by the system as an app of its own", () => {
  const before = process.env.LINKSHELL_INPUT_DRY_RUN;
  beforeAll(() => {
    process.env.LINKSHELL_INPUT_DRY_RUN = "1";
  });
  afterAll(() => {
    closeInputApp();
    if (before === undefined) delete process.env.LINKSHELL_INPUT_DRY_RUN;
    else process.env.LINKSHELL_INPUT_DRY_RUN = before;
  });

  const until = async (done: () => boolean) => {
    const deadline = Date.now() + 15_000;
    while (!done()) {
      if (Date.now() > deadline) throw new Error("timed out");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };

  it("holds the permissions under its own name, and serves several viewers at once", async () => {
    const app = inputApp(() => {})!;
    // Not the terminal's name, nor this test runner's: its own.
    expect((await app.access()).app).toBe("LinkShell");

    const seen = { a: [] as Record<string, unknown>[], b: [] as Record<string, unknown>[] };
    const states: ControlState[] = [];
    const first = new InputControl({ state: (state) => states.push(state), cursor: () => {}, posted: (event) => seen.a.push(event) }, () => {}, { dryRun: true });
    const second = new InputControl({ state: () => {}, cursor: () => {}, posted: (event) => seen.b.push(event) }, () => {}, { dryRun: true });
    await first.start(0);
    await second.start(0);
    await until(() => states.length > 0);
    expect(states[0]).toEqual({ available: true, trusted: true, app: "LinkShell" });

    first.send({ t: "move", x: 0, y: 0 });
    first.send({ t: "down", b: "left" });
    second.send({ t: "key", k: "escape" });
    await until(() => seen.a.length === 2 && seen.b.length === 2);
    expect(seen.a.map((event) => event.kind)).toEqual(["move", "down"]);
    expect(seen.b.map((event) => event.kind)).toEqual(["keydown", "keyup"]);
    // A viewer that leaves lets go of its button; the other is untouched.
    first.stop();
    await until(() => seen.a.length === 3);
    expect(seen.a[2]).toMatchObject({ kind: "up", b: "left" });
    second.stop();
  }, 30_000);

  it("runs a capture as its own child and passes its output on", async () => {
    const app = inputApp(() => {})!;
    let said = "";
    let code: number | undefined;
    await app.capture("/bin/sh", ["-c", "printf frame-1; printf frame-2; echo oops >&2; exit 3"], {
      data: (chunk) => (said += chunk.toString()),
      exit: (status, errors) => {
        code = status;
        said += `|${errors.trim()}`;
      },
    });
    await until(() => code !== undefined);
    expect([code, said]).toEqual([3, "frame-1frame-2|oops"]);

    // One that would run for ever ends when it is told to.
    let ended = false;
    const stop = await app.capture("/bin/sh", ["-c", "echo up; sleep 60"], { data: () => stop(), exit: () => (ended = true) });
    await until(() => ended);
  }, 30_000);
});
