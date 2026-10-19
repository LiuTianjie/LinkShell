import { beforeEach, expect, it, vi } from "vitest";
import type { HostLink } from "@linkshell/client-core";

const h = vi.hoisted(() => ({
  os: "ios", permission: vi.fn(), asset: vi.fn(), share: vi.fn(), available: vi.fn(), pick: vi.fn(),
  write: vi.fn(), close: vi.fn(), copy: vi.fn(), remove: vi.fn(), create: vi.fn(), targetExists: false,
}));
vi.mock("react-native", () => ({ Platform: { get OS() { return h.os; } } }));
vi.mock("expo-crypto", () => ({ randomUUID: () => "unique" }));
vi.mock("expo-media-library", () => ({ Asset: { create: h.asset }, requestPermissionsAsync: h.permission }));
vi.mock("expo-sharing", () => ({ shareAsync: h.share, isAvailableAsync: h.available }));
vi.mock("expo-file-system", () => ({
  Paths: { cache: "file:///cache" },
  Directory: class {
    static pickDirectoryAsync = h.pick;
    uri: string; exists = true;
    constructor(base: string, name: string) { this.uri = `${base}/${name}`; }
    create = h.create; delete = h.remove;
  },
  File: class {
    uri: string; name: string;
    constructor(parent: { uri: string }, name: string) { this.uri = `${parent.uri}/${name}`; this.name = name; }
    get exists() { return this.uri.startsWith("content:") && h.targetExists; }
    create = h.create; copy = h.copy;
    open() { return { writeBytes: h.write, close: h.close }; }
  },
}));
const { saveRemoteFile } = await import("../src/lib/file-save");
const call = vi.fn();
const link = { call } as unknown as Pick<HostLink, "call">;
beforeEach(() => {
  vi.resetAllMocks(); h.os = "ios"; h.targetExists = false;
  h.permission.mockResolvedValue({ granted: true }); h.available.mockResolvedValue(true);
  h.asset.mockResolvedValue({ id: "saved" });
  h.pick.mockResolvedValue({ uri: "content://folder" });
  call.mockResolvedValue({ size: 3, revision: "one", data: "AP+A", nextOffset: 3, done: true });
});
it("asks only for write access, saves exact media bytes, closes the file, then removes cache", async () => {
  await expect(saveRemoteFile(link, "/media/电影.mov", "photos", {})).resolves.toBe("saved");
  expect(h.permission).toHaveBeenCalledWith(true, []);
  expect(h.write).toHaveBeenCalledWith(new Uint8Array([0, 255, 128]));
  expect(h.asset).toHaveBeenCalledWith("file:///cache/file-download-unique/电影.mov");
  expect(h.close.mock.invocationCallOrder[0]).toBeLessThan(h.asset.mock.invocationCallOrder[0]!);
  expect(h.remove.mock.invocationCallOrder[0]).toBeGreaterThan(h.asset.mock.invocationCallOrder[0]!);
});
it("does not download when album permission is denied", async () => {
  h.permission.mockResolvedValue({ granted: false });
  await expect(saveRemoteFile(link, "/a.jpg", "photos", {})).rejects.toThrow("权限");
  expect(call).not.toHaveBeenCalled(); expect(h.asset).not.toHaveBeenCalled();
});
it("offers saving as a file when the album rejects the media and cleans its cache", async () => {
  h.asset.mockRejectedValue(new Error("unsupported media"));
  await expect(saveRemoteFile(link, "/a.mkv", "photos", {})).rejects.toThrow("保存到文件");
  expect(h.remove).toHaveBeenCalledOnce();
});
it("does not mistake an iOS share sheet dismissal for a confirmed save", async () => {
  await expect(saveRemoteFile(link, "/a.png", "files", {})).resolves.toBe("shared");
  expect(h.share).toHaveBeenCalledWith(expect.stringMatching(/\/a\.png$/), { dialogTitle: "保存到文件" });
  expect(h.permission).not.toHaveBeenCalled(); expect(h.remove).toHaveBeenCalledOnce();
});
it("cleans partial downloads and never exports them", async () => {
  call.mockRejectedValue(new Error("offline"));
  await expect(saveRemoteFile(link, "/a.png", "photos", {})).rejects.toThrow("offline");
  expect(h.close).toHaveBeenCalledOnce(); expect(h.remove).toHaveBeenCalledOnce();
  expect(h.asset).not.toHaveBeenCalled(); expect(h.share).not.toHaveBeenCalled();
});
it("copies to the chosen Android folder and waits before deleting the source", async () => {
  h.os = "android";
  let finish: () => void = () => {};
  h.copy.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
  const saving = saveRemoteFile(link, "C:\\work\\a.mp4", "files", {});
  await vi.waitFor(() => expect(h.copy).toHaveBeenCalledOnce());
  expect(h.remove).not.toHaveBeenCalled();
  finish(); await expect(saving).resolves.toBe("saved");
  expect(h.copy).toHaveBeenCalledWith(expect.objectContaining({ uri: "content://folder/a.mp4" }));
  expect(h.remove).toHaveBeenCalledOnce(); expect(h.share).not.toHaveBeenCalled();
});
it("cancels the Android picker without starting a download", async () => {
  h.os = "android"; h.pick.mockRejectedValue({ code: "ERR_PICKER_CANCELLED" });
  await expect(saveRemoteFile(link, "/a.png", "files", {})).rejects.toMatchObject({ name: "AbortError" });
  expect(call).not.toHaveBeenCalled();
});
it("preserves an existing Android file", async () => {
  h.os = "android"; h.targetExists = true;
  await expect(saveRemoteFile(link, "/a.png", "files", {})).rejects.toThrow("同名文件");
  expect(h.copy).not.toHaveBeenCalled(); expect(h.remove).toHaveBeenCalledOnce();
});
