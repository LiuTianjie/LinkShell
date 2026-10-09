import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { PNG } from "pngjs";
import { TerminalState, TERMINAL_HISTORY_LINES } from "../src/terminal-state.js";
const states: TerminalState[] = [];
const state = (cols = 20, rows = 5) => { const t = new TerminalState(cols, rows); states.push(t); return t; };
const restore = (t: TerminalState) => { const r = state(t.cols, t.rows); r.write(t.snapshot()); return r; };
afterEach(() => { for (const t of states.splice(0)) t.dispose(); });
const image = "\x1b_Ga=T,f=32,s=1,v=1,i=123,c=2,r=2;/////w==\x1b\\";

describe("bounded Ghostty state", () => {
  it("ships the checked artifact recorded by its reproducible build manifest", () => {
    const manifest = JSON.parse(readFileSync(new URL("../native/terminal-state/manifest.json", import.meta.url), "utf8"));
    const artifact = readFileSync(new URL("../src/terminal-state.wasm.gz", import.meta.url));
    expect(createHash("sha256").update(artifact).digest("hex")).toBe(manifest.artifactSha256);
  });
  it("restores cursor, styled Unicode text, and following output", () => {
    const t = state(); t.write("\x1b[32;1m中文 👋\x1b[0m\r\nsecond\x1b[2D");
    const r = restore(t);
    expect(r.text()).toBe(t.text()); expect(r.inspect()).toEqual(t.inspect());
    t.write("OK\r\nnext"); r.write("OK\r\nnext"); expect(r.text()).toBe(t.text());
  });
  it("restores recent history with fixed size after 100,000 lines", () => {
    const t = state(80, 24);
    t.write(Array.from({length: 100_000}, (_, i) => `line-${i}\r\n`).join(""));
    const start = performance.now(), snapshot = t.snapshot();
    const r = state(80,24); r.write(snapshot);
    expect(r.text()).toContain("line-99999"); expect(r.text()).not.toContain("line-100\n");
    expect(r.text().split("\n").length).toBeLessThanOrEqual(TERMINAL_HISTORY_LINES + 24);
    expect(snapshot.length).toBeLessThan(100_000);
    console.log(`100k lines: snapshot ${snapshot.length} bytes, restore ${(performance.now()-start).toFixed(1)}ms`);
  });
  it("retains raw and PNG pictures and their positions in history", () => {
    const t = state();
    const png = PNG.sync.write({width: 1, height: 1, data: Buffer.from([255,0,0,255])}).toString("base64");
    t.write(`before\r\n${image}\r\n\x1b_Ga=T,f=100,i=124,c=2,r=2;${png}\x1b\\after\r\nmore\r\nlast`);
    const r = restore(t);
    expect(r.text()).toBe(t.text()); expect(r.inspect()).toEqual(t.inspect());
    expect(r.imageChecksum(123)).toBe(t.imageChecksum(123)); expect(r.imageChecksum(124)).toBe(t.imageChecksum(124));
    expect(r.inspect().images).toBe(2);
    expect(r.imagePosition(123)).toEqual(t.imagePosition(123));
    expect(r.imagePosition(124)).toEqual(t.imagePosition(124));
    // A new implicit placement must not replace an old restored placement.
    t.write(image); r.write(image); expect(r.inspect()).toEqual(t.inspect());
  });
  it("keeps the primary screen behind an active fullscreen program", () => {
    const t = state();t.write(`shell\r\n${image}\r\nprompt> \x1b[?1049h\x1b[Heditor\x1b[?1000h\x1b[?1006h`);
    const r = restore(t); expect(r.text()).toBe(t.text()); expect(r.inspect()).toEqual(t.inspect());
    for (const s of [t,r]) s.write("\x1b[?1049l");
    expect(r.text()).toBe(t.text()); expect(r.inspect()).toEqual(t.inspect()); expect(r.imageChecksum(123)).toBe(t.imageChecksum(123));
  });
  it("preserves soft wrapping across a later resize", () => {
    const t = state(10,5);t.write("1234567890abcdefghijKLMNOPQRSTuvwxyz");const r = restore(t);
    expect(r.text()).toBe(t.text());
    t.resize(20,5);r.resize(20,5);expect(r.text()).toBe(t.text());expect(r.inspect()).toEqual(t.inspect());
  });
  it("preserves pending wrap when output resumes at the right edge", () => {
    const t = state(10,5); t.write("1234567890"); const r = restore(t);
    t.write("X");r.write("X");expect(r.text()).toBe(t.text());expect(r.inspect()).toEqual(t.inspect());
  });
  it.each(["\x1b[38;2;255;", "\x1b]2;partial title", "\x1b("])("continues an unfinished control sequence: %j", (prefix) => {
    const t = state(); t.write("before" + prefix); const r = restore(t);
    const suffix = prefix.startsWith("\x1b[") ? "0;0mred" : prefix.startsWith("\x1b]") ? "\x07after" : "0q";
    t.write(suffix); r.write(suffix); expect(r.text()).toBe(t.text()); expect(r.inspect()).toEqual(t.inspect());
  });
  it("preserves saved cursor origin mode for later DECRC", () => {
    const t = state(20,10); t.write("\x1b[3;8r\x1b[?6h\x1b[2;3Hsaved\x1b7\x1b[?6l\x1b[Hcurrent");
    const r = restore(t); t.write("\x1b8next"); r.write("\x1b8next");
    expect(r.text()).toBe(t.text()); expect(r.inspect()).toEqual(t.inspect());
  });
  it("uses exact-recording fallback while an image is incomplete, then snapshots the completed image", () => {
    const t = state(); t.write("\x1b_Ga=T,f=32,s=1,v=1,i=123,c=2,r=2,m=1;////\x1b\\");
    expect(() => t.snapshot()).toThrow();
    t.write("\x1b_Gm=0;/w==\x1b\\"); const r = restore(t);
    expect(r.imageChecksum(123)).toBe(t.imageChecksum(123)); expect(r.inspect()).toEqual(t.inspect());
  });
  it("keeps original recordings for image geometry and implicit addressing that VT cannot portably restore", () => {
    const t = state(); t.write("\x1b_Ga=T,f=32,s=1,v=1;/////w==\x1b\\");
    expect(() => t.snapshot()).toThrow();
  });
  it("preserves keyboard protocol pushes and later pops", () => {
    const t = state(); t.write("\x1b[>1u\x1b[>3uabc"); const r = restore(t);
    expect(r.inspect()).toEqual(t.inspect());
    for (let i=0;i<3;i++) { t.write("\x1b[<1u");r.write("\x1b[<1u");expect(r.inspect().keyboard).toBe(t.inspect().keyboard); }
  });
});
