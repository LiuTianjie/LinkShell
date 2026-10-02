import { Script } from "node:vm";
import { describe, expect, it } from "vitest";
import { inputEvent } from "../src/input.js";
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
