import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeInputApp, inputApp, InputControl, shippedApp, unpackedApp, type ControlState } from "../src/input.js";

// LinkShell.app itself (apps/mac), as the host uses it. Skipped where it hasn't been built
// (`pnpm --filter @linkshell/mac build`, on a Mac). Nothing here posts an event to the system.

describe.skipIf(!shippedApp())("LinkShell.app's program as the host's own child (dry run: events are reported, not posted)", () => {
  function start() {
    const posted: Record<string, unknown>[] = [];
    const states: ControlState[] = [];
    let wake = () => {};
    const control = new InputControl(
      { state: (state) => (states.push(state), wake()), cursor: () => {}, posted: (event) => (posted.push(event), wake()) },
      () => {},
      // Not opened by the system: what the host falls back to when the app can't be.
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

  it("turns a viewer's events into the system's", async () => {
    const { control, posted, states, until } = start();
    await control.start(0);
    await until(() => states.length > 0);
    expect(states[0]).toMatchObject({ available: true, trusted: true });

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
  afterAll(() => rmSync(work, { recursive: true, force: true }));
  // A package can't carry the app as it is (no links, no permission to run): it carries this archive of it.
  const archive = join(work, "LinkShell.app.tar.gz");
  beforeAll(() => {
    execFileSync("/usr/bin/tar", ["-czf", archive, "-C", join(shippedApp()!, ".."), "LinkShell.app"]);
  });

  it("is unpacked once, whole: it runs, and its signature holds", () => {
    const at = join(work, "home/LinkShell.app");
    expect(unpackedApp(archive, at)).toBe(at);
    const status = JSON.parse(execFileSync(join(at, "Contents/MacOS/LinkShell"), ["--status"], { encoding: "utf8" })) as { t: string; video: boolean };
    expect(status).toMatchObject({ t: "status", video: true });
    expect(() => execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", at])).not.toThrow();
    // Asked again, the same one: nothing is unpacked twice.
    const unpackedAt = statSync(at).ino;
    expect(unpackedApp(archive, at)).toBe(at);
    expect(statSync(at).ino).toBe(unpackedAt);
  }, 60_000);

  it("replaces the app of another version where it is, so the system knows it for the same app", () => {
    const at = join(work, "upgrade/LinkShell.app");
    mkdirSync(join(at, "Contents/MacOS"), { recursive: true });
    writeFileSync(join(at, "Contents/MacOS/LinkShell"), "#!/bin/sh\necho old\n", { mode: 0o755 });
    writeFileSync(`${at}.unpacked`, "the hash of an older archive");
    expect(unpackedApp(archive, at)).toBe(at);
    expect(() => execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", at])).not.toThrow();
    // Nothing of the old one, or of the unpacking, is left beside it.
    expect(readdirSync(join(work, "upgrade")).sort()).toEqual(["LinkShell.app", "LinkShell.app.unpacked"]);
  }, 60_000);

  it("is no app at all when the archive is not one", () => {
    const broken = join(work, "broken.tar.gz");
    writeFileSync(broken, "not an archive");
    expect(unpackedApp(broken, join(work, "none/LinkShell.app"))).toBeUndefined();
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

  it("lists the displays, and encodes one for a pipe: whole frames, a keyframe first and when asked, a new generation with a new size", async () => {
    const app = inputApp(() => {})!;
    const displays = await app.displays();
    expect(displays.length).toBeGreaterThan(0);
    expect(displays.filter((display) => display.main).length).toBe(1);
    // Recording needs the system's permission for LinkShell: without it there is nothing more to see here.
    if (!(await app.access()).recording) return;

    const frames: { key: boolean; generation: number; nal: number }[] = [];
    let ended: string | undefined;
    const stream = await app.stream(
      displays[0]!.screen,
      { width: 640, fps: 10, bitrate: 300_000, ceiling: 400_000 },
      {
        // The first unit's type, after its start code: 7 (parameters) opens a keyframe, 1 is a frame built on the one before.
        frame: (unit, key, generation) => frames.push({ key, generation, nal: unit[unit[2] === 1 ? 3 : 4]! & 0x1f }),
        exit: (error) => (ended = error ?? "ended"),
      },
    );
    await until(() => frames.length >= 1);
    expect(frames[0]).toMatchObject({ key: true, generation: 0, nal: 7 });

    const before = frames.length;
    stream.key();
    await until(() => frames.slice(before).some((frame) => frame.key));

    stream.set({ width: 480, fps: 10, bitrate: 200_000, ceiling: 300_000 });
    await until(() => frames.some((frame) => frame.generation === 1));
    // The new size begins with a keyframe, and nothing of the old one comes after it.
    const first = frames.findIndex((frame) => frame.generation === 1);
    expect(frames[first]!.key).toBe(true);
    expect(frames.slice(first).every((frame) => frame.generation === 1)).toBe(true);

    stream.end();
    const after = frames.length;
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(frames.length).toBe(after);
    expect(ended).toBeUndefined();
  }, 30_000);
});
