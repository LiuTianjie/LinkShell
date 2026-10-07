import { createConnection } from "node:net";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { PreviewFrameDecoder } from "@linkshell/wire";
import { ComputerPreviews, ComputerPreviewServer } from "../src/computer-preview.js";
import { codexPreview } from "../src/drivers/codex/computer-preview.js";

const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
async function waitFor(check: () => boolean) {
  const end = Date.now() + 3000;
  while (!check()) { if (Date.now() > end) throw new Error("timeout"); await new Promise(resolve => setTimeout(resolve, 10)); }
}
async function fixture() {
  const db = new Map<string, string>();
  const frames = new ComputerPreviews({ load: id => db.get(id), save: (id, data) => { db.set(id, data); }, exists: id => id === "one" || id === "two", log: () => {} });
  cleanup.push(() => frames.stop());
  const png = await sharp({ create: { width: 1600, height: 1000, channels: 3, background: "#123456" } }).png().toBuffer();
  const input = { sourceId: "first", target: "tab:1", capturedAt: 123, dataUrl: `data:image/png;base64,${png.toString("base64")}` };
  return { db, frames, input };
}
describe("independent computer preview", () => {
  it("keeps continuous frames independent of repeated tool history and stops capture when unwatched", async () => {
    const db = new Map<string, string>();
    let emit: ((url: string) => void) | undefined, starts = 0, stops = 0;
    const frames = new ComputerPreviews({ load: id => db.get(id), save: (id, data) => { db.set(id, data); }, exists: () => true, log: () => {}, capture: async (_, receive) => { starts++; emit = receive; return () => { stops++; }; } });
    cleanup.push(() => frames.stop());
    const { input } = await fixture();
    const initial = { ...input, capture: { bundleId: "com.google.Chrome" as const, title: "Page" } };
    await frames.put("one", initial);
    expect(starts).toBe(0);
    const old = frames.get("one")!.id;
    const stop = frames.subscribe("one", () => {});
    expect(starts).toBe(1);
    const picture = await sharp({ create: { width: 64, height: 32, channels: 3, background: "#abcdef" } }).png().toBuffer();
    emit!(`data:image/png;base64,${picture.toString("base64")}`);
    await waitFor(() => frames.get("one")!.id !== old);
    const live = frames.get("one")!.id;
    await frames.put("one", initial);
    await frames.put("one", { ...initial, sourceId: "another-tool" });
    expect(frames.get("one")!.id).toBe(live);
    stop(); expect(stops).toBe(1);
    const restored = new ComputerPreviews({ load: id => db.get(id), save: () => {}, exists: () => true, log: () => {} });
    cleanup.push(() => restored.stop());
    expect(restored.get("one")!.id).toBe(live);
  });
  it("starts native capture without a chat image and restores its target before a first frame", async () => {
    const db = new Map<string, string>();
    let emit: ((url: string) => void) | undefined;
    const create = () => new ComputerPreviews({ load: id => db.get(id), save: (id, data) => { db.set(id, data); }, exists: () => true, log: () => {}, capture: async (_, receive) => { emit = receive; return () => {}; } });
    const frames = create(); cleanup.push(() => frames.stop());
    const item = { id: "native", type: "mcpToolCall", server: "cua_repl", result: { content: [{ type: "text", text: 'Window: "QA", App: Simulator.\n0 standard window' }], _meta: { "codex/toolSurface": { kind: "computerUse", app: { kind: "appId", appId: "com.apple.iphonesimulator" } } } } };
    const input = codexPreview(item)!;
    expect(input).toMatchObject({ capture: { bundleId: "com.apple.iphonesimulator", title: "QA", app: true } });
    expect(input.dataUrl).toBeUndefined();
    await frames.put("one", input);
    expect(frames.get("one")).toBeUndefined();
    const restored = create(); cleanup.push(() => restored.stop());
    restored.subscribe("one", () => {});
    expect(emit).toBeTypeOf("function");
    const { input: picture } = await fixture(); emit!(picture.dataUrl);
    await waitFor(() => !!restored.get("one"));
    expect(restored.get("one")!.target).toBe('["app","com.apple.iphonesimulator"]');
    await restored.put("one", { ...input, sourceId: "next", capture: { bundleId: "com.apple.iphonesimulator", app: true } });
    expect(JSON.parse(db.get("one")!).capture.title).toBe("QA");
    item.result.content[0]!.text = 'arbitrary body Window: "Other", App: Simulator.';
    expect(codexPreview(item)?.capture?.title).toBeUndefined();
  });
  it("contains capture failures and preserves the saved frame", async () => {
    const { input } = await fixture();
    const problems: string[] = [];
    const frames = new ComputerPreviews({ load: () => undefined, save: () => {}, exists: () => true, log: text => problems.push(text), capture: async () => { throw new Error("capture failed"); } });
    cleanup.push(() => frames.stop());
    await frames.put("one", { ...input, capture: { bundleId: "com.google.Chrome", title: "Page" } });
    const original = frames.get("one")!.id;
    const stop = frames.subscribe("one", () => {});
    await waitFor(() => problems.length === 1);
    expect(frames.get("one")!.id).toBe(original);
    stop();
  });
  it("reads the desktop surface even when no chat image was returned", () => {
    const item = { id: "call", type: "mcpToolCall", server: "cua_repl", result: { content: [], _meta: { "codex/toolSurface": { kind: "browserUse", backend: "chrome", browserId: "1", screenshot: { tabId: 12, url: "data:image/jpeg;base64,YWJj" } } } } };
    expect(codexPreview(item, 123)).toMatchObject({ sourceId: "call", capturedAt: 123, target: '["chrome","1",12]' });
    expect(codexPreview({ ...item, server: "other" })).toBeUndefined();
    expect(codexPreview({ ...item, result: { content: [{ type: "image", data: "YWJj" }] } })).toBeUndefined();
    item.result._meta["codex/toolSurface"].screenshot.url = "https://example.com/a.jpg";
    expect(codexPreview(item)).toBeUndefined();
  });
  it("bounds pictures, deduplicates pixels and restores them from durable state", async () => {
    const { frames, db, input } = await fixture();
    let updates = 0;
    frames.subscribe("one", () => updates++);
    await frames.put("one", input);
    const frame = frames.get("one")!;
    expect(frame).toMatchObject({ width: 480, height: 300, mimeType: "image/webp" });
    expect(frame.bytes.length).toBeLessThan(48 * 1024);
    await frames.put("one", { ...input, sourceId: "second" });
    expect(updates).toBe(1);
    expect(frames.get("two")).toBeUndefined();
    const restored = new ComputerPreviews({ load: id => db.get(id), save: () => {}, exists: () => true, log: () => {} });
    cleanup.push(() => restored.stop());
    expect(restored.get("one")?.id).toBe(frame.id);
    expect(Buffer.from(restored.get("one")!.bytes)).toEqual(Buffer.from(frame.bytes));
    await frames.put("one", { ...input, sourceId: "invalid", dataUrl: "data:image/png;base64,YWJj" });
    expect(frames.get("one")?.id).toBe(frame.id);
  });
  it("authenticates the socket, sends one frame until ack, and restores after reopening", async () => {
    const { frames, input } = await fixture();
    await frames.put("one", input);
    const server = new ComputerPreviewServer(frames); cleanup.push(() => server.stop());
    const grant = await server.open("one");
    const bad = createConnection(grant.port, "127.0.0.1"); cleanup.push(() => bad.destroy());
    let badClosed = false, leaked = 0;
    bad.on("data", chunk => { leaked += chunk.length; }); bad.on("close", () => { badClosed = true; });
    bad.write('{"token":"wrong"}\n');
    await waitFor(() => badClosed); expect(leaked).toBe(0);
    const socket = createConnection(grant.port, "127.0.0.1"); cleanup.push(() => socket.destroy());
    const decoder = new PreviewFrameDecoder(); const ids: string[] = [], times: number[] = [];
    socket.on("data", chunk => { for (const frame of decoder.push(chunk)) { ids.push(frame.id); times.push(Date.now()); } });
    socket.write(JSON.stringify({ token: grant.token }) + "\n");
    await waitFor(() => ids.length === 1);
    await frames.put("one", { ...input, sourceId: "new", target: "tab:2" });
    await new Promise(resolve => setTimeout(resolve, 300)); expect(ids).toHaveLength(1);
    socket.write("ack\n"); await waitFor(() => ids.length === 2);
    expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(1950);
    socket.write("ack\n"); socket.destroy();
    const again = await server.open("one");
    const reopened = createConnection(again.port, "127.0.0.1"); cleanup.push(() => reopened.destroy());
    const second = new PreviewFrameDecoder(); let restored = "";
    reopened.on("data", chunk => { restored = second.push(chunk)[0]?.id ?? restored; });
    reopened.write(JSON.stringify({ token: again.token }) + "\n");
    await waitFor(() => !!restored); expect(restored).toBe(ids[1]);
  });
});
