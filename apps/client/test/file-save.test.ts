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
vi.mock("expo-file-system", () => {
  class Directory {
    static pickDirectoryAsync = h.pick;
    uri: string; exists = true;
    constructor(base: string, name?: string) { this.uri = name ? `${base}/${name}` : base; }
    create = h.create; delete = h.remove;
  }
  class File {
    uri: string; name: string;
    constructor(parent: { uri: string }, name: string) { this.uri = `${parent.uri}/${name}`; this.name = name; }
    // A child suffix does not turn a SAF tree URI into a document URI.
    get exists() { return !this.uri.startsWith("content:"); }
    create = h.create;
    async copy(destination: File | Directory, options?: { overwrite?: boolean }) {
      if (destination instanceof File && destination.uri.startsWith("content:")) {
        throw Object.assign(new Error("A folder with the same name already exists in the file location"), { code: "ERR_INVALID_TYPE_FILE" });
      }
      return h.copy(destination, options);
    }
    open() { return { writeBytes: h.write, close: h.close }; }
  }
  return { Paths: { cache: "file:///cache" }, Directory, File };
});
const { saveRemoteFile } = await import("../src/lib/file-save");
const { Directory } = await import("expo-file-system");
const call = vi.fn();
const link = { call } as unknown as Pick<HostLink, "call">;
const pickedUri = "content://com.android.externalstorage.documents/tree/primary%3ADownload";
beforeEach(() => {
  vi.resetAllMocks(); h.os = "ios"; h.targetExists = false;
  h.permission.mockResolvedValue({ granted: true }); h.available.mockResolvedValue(true);
  h.asset.mockResolvedValue({ id: "saved" });
  h.pick.mockResolvedValue(new Directory(pickedUri));
  h.copy.mockImplementation((_destination, options) => {
    if (h.targetExists && !options?.overwrite) {
      throw Object.assign(new Error("Destination already exists"), { code: "ERR_DESTINATION_ALREADY_EXISTS" });
    }
  });
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
it("copies into the Android SAF directory and waits before deleting the source", async () => {
  h.os = "android";
  let finish: () => void = () => {};
  h.copy.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
  const saving = saveRemoteFile(link, "C:\\work\\a.mp4", "files", {});
  void saving.catch(() => {});
  await vi.waitFor(() => expect(h.copy).toHaveBeenCalledOnce());
  expect(h.remove).not.toHaveBeenCalled();
  finish(); await expect(saving).resolves.toBe("saved");
  expect(h.copy).toHaveBeenCalledWith(expect.objectContaining({ uri: pickedUri }), { overwrite: false });
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
  expect(h.copy).toHaveBeenCalledWith(expect.objectContaining({ uri: pickedUri }), { overwrite: false });
  expect(h.remove).toHaveBeenCalledOnce();
});
it("preserves other Android export errors and removes the downloaded cache", async () => {
  h.os = "android";
  const failure = Object.assign(new Error("Storage full"), { code: "ERR_UNABLE_TO_COPY" });
  h.copy.mockRejectedValue(failure);
  await expect(saveRemoteFile(link, "/a.png", "files", {})).rejects.toBe(failure);
  expect(h.remove).toHaveBeenCalledOnce();
});
