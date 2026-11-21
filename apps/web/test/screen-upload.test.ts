import { describe, expect, it, vi } from "vitest";
import type { HostLink } from "@linkshell/client-core";
import { MAX_ATTACHMENT_BYTES } from "../src/live/attachments";
import {
  formatScreenUploadSummary,
  resolveScreenUploadDir,
  uploadScreenFiles,
} from "../src/live/screen-upload";

function mockLink(impl: (method: string, params: Record<string, unknown>) => Promise<unknown>): HostLink {
  return {
    call: vi.fn((method: string, params: Record<string, unknown>) => impl(method, params)),
  } as unknown as HostLink;
}

describe("remote screen file drop upload", () => {
  it("prefers explicit uploadDir, otherwise falls back from ~/Desktop to home", async () => {
    const direct = mockLink(async () => {
      throw new Error("should not list");
    });
    expect(await resolveScreenUploadDir(direct, "/work/repo")).toBe("/work/repo");

    const desktop = mockLink(async (method, params) => {
      expect(method).toBe("fs.list");
      return { path: params.path === "~/Desktop" ? "/Users/alice/Desktop" : "/Users/alice", entries: [] };
    });
    expect(await resolveScreenUploadDir(desktop)).toBe("/Users/alice/Desktop");

    const headless = mockLink(async (_method, params) => {
      if (params.path === "~/Desktop") throw new Error("ENOENT");
      return { path: "/home/ubuntu", entries: [] };
    });
    expect(await resolveScreenUploadDir(headless)).toBe("/home/ubuntu");
  });

  it("validates size limits up front and uploads files sequentially via fs.upload", async () => {
    vi.stubGlobal(
      "FileReader",
      class {
        result: string | null = null;
        onerror: (() => void) | null = null;
        onload: (() => void) | null = null;
        readAsDataURL(blob: Blob) {
          void blob.arrayBuffer().then((buf) => {
            this.result = `data:application/octet-stream;base64,${Buffer.from(buf).toString("base64")}`;
            this.onload?.();
          });
        }
      },
    );

    try {
      const tooBig = { name: "huge.zip", size: MAX_ATTACHMENT_BYTES + 1 } as File;
      const callLog: Array<{ method: string; params: Record<string, unknown> }> = [];
      const link = mockLink(async (method, params) => {
        callLog.push({ method, params });
        if (method === "fs.list") return { path: "/Users/alice/Desktop", entries: [] };
        return { path: `${params.dir}/${params.name}` };
      });

      await expect(uploadScreenFiles({ link, files: [tooBig] })).rejects.toThrow("超过");
      expect(callLog).toHaveLength(0);

      const fileA = new File(["hello"], "note.txt", { type: "text/plain" });
      const fileB = new File(["world"], "shot.png", { type: "image/png" });
      const progressEvents: string[] = [];
      const result = await uploadScreenFiles({
        link,
        files: [fileA, fileB],
        onProgress: (p) => progressEvents.push(`${p.done + 1}/${p.total}:${p.name}`),
      });

      expect(result).toEqual({
        dir: "/Users/alice/Desktop",
        paths: ["/Users/alice/Desktop/note.txt", "/Users/alice/Desktop/shot.png"],
      });
      expect(progressEvents).toEqual(["1/2:note.txt", "2/2:shot.png"]);
      expect(callLog.filter((entry) => entry.method === "fs.upload")).toEqual([
        {
          method: "fs.upload",
          params: { dir: "/Users/alice/Desktop", name: "note.txt", data: Buffer.from("hello").toString("base64") },
        },
        {
          method: "fs.upload",
          params: { dir: "/Users/alice/Desktop", name: "shot.png", data: Buffer.from("world").toString("base64") },
        },
      ]);
      expect(formatScreenUploadSummary(result)).toBe("已上传 2 个文件到 Desktop");
      expect(
        formatScreenUploadSummary({ dir: "/work/app", paths: ["/work/app/note.txt"] }),
      ).toBe("已上传到 app：note.txt");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
