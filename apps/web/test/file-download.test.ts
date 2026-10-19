import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { HostLink } from "@linkshell/client-core";
import { saveRemoteFile } from "../src/live/file-download";

const response = { size: 3, revision: "one", data: "AP+A", nextOffset: 3, done: true };
const call = vi.fn();
const link = { call } as unknown as Pick<HostLink, "call">;
const writer = { write: vi.fn(), close: vi.fn(), abort: vi.fn() };
const createWritable = vi.fn();
const picker = vi.fn();
beforeEach(() => {
  vi.resetAllMocks();
  call.mockResolvedValue(response);
  createWritable.mockResolvedValue(writer);
  picker.mockResolvedValue({ createWritable });
  writer.abort.mockResolvedValue(undefined);
  vi.stubGlobal("window", { showSaveFilePicker: picker });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

it("opens a destination before the network request and commits only complete bytes", async () => {
  await expect(saveRemoteFile(link, "C:\\media\\电影.mp4", {})).resolves.toBe("saved");
  expect(picker).toHaveBeenCalledWith({ suggestedName: "电影.mp4" });
  expect(picker.mock.invocationCallOrder[0]).toBeLessThan(call.mock.invocationCallOrder[0]!);
  expect(writer.write).toHaveBeenCalledWith(new Uint8Array([0, 255, 128]));
  expect(writer.close).toHaveBeenCalledOnce();
  expect(writer.abort).not.toHaveBeenCalled();
});
it("leaves the destination untouched when selection is cancelled", async () => {
  picker.mockRejectedValue(Object.assign(new Error("cancel"), { name: "AbortError" }));
  await expect(saveRemoteFile(link, "/a.jpg", {})).rejects.toMatchObject({ name: "AbortError" });
  expect(call).not.toHaveBeenCalled();
});
it("aborts a partial file on transport failure", async () => {
  call.mockResolvedValueOnce({ ...response, size: 6, done: false }).mockRejectedValueOnce(new Error("offline"));
  await expect(saveRemoteFile(link, "/a.mp4", {})).rejects.toThrow("offline");
  expect(writer.abort).toHaveBeenCalledOnce();
  expect(writer.close).not.toHaveBeenCalled();
});
it("cancels before committing the stream", async () => {
  const controller = new AbortController();
  writer.write.mockImplementation(() => { controller.abort(); });
  await expect(saveRemoteFile(link, "/a.mp4", { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
  expect(writer.abort).toHaveBeenCalledOnce();
  expect(writer.close).not.toHaveBeenCalled();
});
it("downloads exact bytes with the original filename without a streaming picker and releases its URL", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("window", {});
  const anchor = { href: "", download: "", click: vi.fn(), remove: vi.fn() };
  vi.stubGlobal("document", { createElement: () => anchor, body: { appendChild: vi.fn() } });
  const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:test");
  const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  await expect(saveRemoteFile(link, "/picture.png", {})).resolves.toBe("downloaded");
  expect(anchor.download).toBe("picture.png");
  expect(new Uint8Array(await (create.mock.calls[0]![0] as Blob).arrayBuffer())).toEqual(new Uint8Array([0, 255, 128]));
  expect(anchor.click).toHaveBeenCalledOnce();
  expect(anchor.remove).toHaveBeenCalledOnce();
  vi.runAllTimers();
  expect(revoke).toHaveBeenCalledWith("blob:test");
});
