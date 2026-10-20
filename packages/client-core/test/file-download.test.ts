import { describe, expect, it, vi } from "vitest";
import { RPC_METHOD_NOT_FOUND, RpcError } from "@linkshell/wire";
import { downloadFile, downloadName, mediaKind } from "../src/file-download.js";
import type { HostLink } from "../src/host-link.js";

function connection(...parts: unknown[]) {
  const call = vi.fn();
  for (const part of parts) call.mockResolvedValueOnce(part);
  return { call, link: { call } as unknown as Pick<HostLink, "call"> };
}
const first = { size: 4, revision: "v1", data: "AP8=", nextOffset: 2, done: false };
const last = { size: 4, revision: "v1", data: "gAE=", nextOffset: 4, done: true };

describe("original file downloads", () => {
  it("preserves arbitrary bytes, revision and progress while waiting for writes", async () => {
    const { call, link } = connection(first, last);
    const progress = vi.fn();
    const chunks: number[] = [];
    await downloadFile(link, "/video.mp4", async (bytes) => {
      expect(call).toHaveBeenCalledTimes(chunks.length === 0 ? 1 : 2);
      chunks.push(...bytes);
      await Promise.resolve();
    }, { onProgress: progress });
    expect(chunks).toEqual([0, 255, 128, 1]);
    expect(call.mock.calls[1][1]).toMatchObject({ offset: 2, revision: "v1" });
    expect(progress).toHaveBeenLastCalledWith({ received: 4, total: 4 });
  });
  it("accepts an empty file", async () => {
    const { link } = connection({ ...first, size: 0, data: "", nextOffset: 0, done: true });
    const write = vi.fn();
    await downloadFile(link, "/empty", write);
    expect(write).toHaveBeenCalledWith(new Uint8Array());
  });
  it.each([
    { ...last, revision: "v2" }, { ...last, size: 5 }, { ...last, nextOffset: 3 },
    { ...last, done: false }, { ...last, data: "", nextOffset: 2, done: false },
  ])("rejects changed or incomplete chunks: %j", async (part) => {
    const { link } = connection(first, part);
    const write = vi.fn();
    await expect(downloadFile(link, "/movie", write)).rejects.toThrow();
    expect(write).toHaveBeenCalledTimes(1);
  });
  it("cancels between chunks and does not write an in-flight response after cancellation", async () => {
    const controller = new AbortController();
    const { link, call } = connection(first, last);
    await expect(downloadFile(link, "/movie", () => controller.abort(), { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(call).toHaveBeenCalledTimes(1);
    const next = new AbortController();
    call.mockReset();
    call.mockImplementationOnce(async () => { next.abort(); return first; });
    const write = vi.fn();
    await expect(downloadFile(link, "/movie", write, { signal: next.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(write).not.toHaveBeenCalled();
  });
  it("reports old hosts, transport failures, and buffer limits without publishing a partial file", async () => {
    const { link, call } = connection();
    call.mockRejectedValueOnce(new RpcError(RPC_METHOD_NOT_FOUND, "unknown method"));
    await expect(downloadFile(link, "/movie", vi.fn())).rejects.toThrow("更新电脑端");
    call.mockRejectedValueOnce(new Error("offline"));
    await expect(downloadFile(link, "/movie", vi.fn())).rejects.toThrow("offline");
    call.mockResolvedValueOnce(first);
    const write = vi.fn();
    await expect(downloadFile(link, "/movie", write, { maxBytes: 3 })).rejects.toThrow("文件过大");
    expect(write).not.toHaveBeenCalled();
  });
  it("cancels immediately even while an RPC is waiting for an offline host", async () => {
    const { link, call } = connection();
    call.mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();
    const write = vi.fn();
    const result = downloadFile(link, "/movie", write, { signal: controller.signal });
    controller.abort();
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(write).not.toHaveBeenCalled();
  });
  it("uses local-safe names for both host path styles and offers albums only for media", () => {
    expect(downloadName("C:\\work\\测试.mp4")).toBe("测试.mp4");
    expect(downloadName("/work/../a:b.png")).toBe("a_b.png");
    expect(mediaKind("picture.HEIC")).toBe("photo");
    expect(mediaKind("video.MOV")).toBe("video");
    expect(mediaKind("drawing.svg")).toBeUndefined();
  });
});
