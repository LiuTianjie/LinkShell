import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HostStore } from "../src/store.js";
import { TerminalManager } from "../src/terminals.js";

let home: string, store: HostStore, manager: TerminalManager | undefined;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "lsh-checkpoint-")); store = new HostStore(join(home,"state.db"));
  store.saveTerminal({ id: "ended", cwd: home, title: "shell", cols: 80, rows: 24, createdAt: 1, activeAt: 1, exitCode: 0, ended: true, buffer: "" });
});
afterEach(() => { vi.restoreAllMocks(); manager?.stop(); manager = undefined; store.close(); rmSync(home,{recursive:true,force:true}); });
const attach = () => manager!.attach("ended", () => {}, undefined, "frames-v1", undefined, true);

it("compacts old recordings once and reads only the checkpoint tail after an interrupted save", () => {
  store.appendTerminalFrame("ended",1,80,24,Array.from({length:3000}, (_, i) => `old-${i}\r\n`).join(""));
  manager = new TerminalManager({},store);
  const first = attach(); expect(first.state).toBeDefined(); expect(first.recording).toBeUndefined();
  expect(store.terminalSnapshot("ended")!.data).not.toContain("old-10\r");
  const read = vi.spyOn(store,"terminalFrames");
  attach(); expect(read).not.toHaveBeenCalled();
  store.appendTerminalFrame("ended",2,80,24,"tail-after-checkpoint");
  const second = attach();
  expect(read).toHaveBeenCalledOnce(); expect(read).toHaveBeenCalledWith("ended",1,2);
  expect(manager.state("ended",second.state!.snapshotId,0).data).toContain("tail-after-checkpoint");
});

it("transfers a fixed state in bounded chunks without splitting a Unicode character", () => {
  const data = "x".repeat(256 * 1024 - 1) + "😀tail";
  store.appendTerminalFrame("ended",1,80,24,"");
  store.saveTerminalSnapshot("ended",{frame:1,cols:80,rows:24,data});
  manager = new TerminalManager({},store);
  const result = attach(); const id = result.state!.snapshotId;
  const first = manager.state("ended",id,0);
  expect(first.done).toBe(false); expect(first.data).toHaveLength(256 * 1024 - 1);
  store.saveTerminalSnapshot("ended",{frame:1,cols:80,rows:24,data:"different"});
  const second = manager.state("ended",id,first.nextOffset);
  expect(second.done).toBe(true); expect(first.data + second.data).toBe(data);
  const now = Date.now(); vi.spyOn(Date,"now").mockReturnValue(now + 121000);
  expect(() => manager!.state("ended",id,0)).toThrow("过期");
});
