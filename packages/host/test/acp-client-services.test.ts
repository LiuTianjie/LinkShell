import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AcpClientServices } from "../src/drivers/acp/client-services.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "linkshell-acp-io-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "project"), extra = join(root, "extra"), outside = join(root, "outside");
  await Promise.all([cwd, extra, outside].map((path) => mkdir(path)));
  const service = new AcpClientServices({ env: process.env, scope: (id) => id === "one" || id === "two" ? { cwd, additionalDirectories: [extra] } : undefined, output: () => {} });
  cleanups.push(() => service.close());
  const call = (method: string, params: object, signal?: AbortSignal) => service.request(method, { sessionId: "one", ...params }, signal);
  return { root, cwd, extra, outside, service, call };
}

describe("ACP client file and terminal services", () => {
  it("reads exact UTF-8 lines, writes scoped files and rejects symlink escapes", async () => {
    const f = await setup(), path = join(f.cwd, "input.txt");
    await writeFile(path, "第一行\n第二行\n第三行");
    expect(await f.call("fs/read_text_file", { path, line: 2, limit: 1 })).toEqual({ content: "第二行\n" });
    const dest = join(f.extra, "nested", "output.txt");
    await f.call("fs/write_text_file", { path: dest, content: "中文写入" });
    expect(await readFile(dest, "utf8")).toBe("中文写入");
    await symlink(f.outside, join(f.cwd, "escape"));
    await expect(f.call("fs/write_text_file", { path: join(f.cwd, "escape", "new.txt"), content: "no" })).rejects.toThrow("工作目录");
    await expect(f.call("fs/read_text_file", { path, sessionId: "unknown" })).rejects.toThrow("有效的会话");
    await expect(f.call("fs/read_text_file", { path, line: 0 })).rejects.toThrow("正整数");
  });

  it("keeps terminal output bounded at UTF-8 boundaries and enforces session ownership", async () => {
    const f = await setup();
    const { terminalId } = await f.call("terminal/create", { command: process.execPath, args: ["-e", "process.stdout.write('中文'.repeat(1000))"], outputByteLimit: 11 }) as { terminalId: string };
    expect(await f.call("terminal/wait_for_exit", { terminalId })).toMatchObject({ exitCode: 0 });
    const snapshot = await f.call("terminal/output", { terminalId }) as { output: string; truncated: boolean };
    expect(snapshot.truncated).toBe(true);
    expect(Buffer.byteLength(snapshot.output)).toBeLessThanOrEqual(11);
    expect(snapshot.output).not.toContain("�");
    await expect(f.call("terminal/output", { terminalId, sessionId: "two" })).rejects.toThrow("找不到");
    await f.call("terminal/release", { terminalId });
    await expect(f.call("terminal/output", { terminalId })).rejects.toThrow("找不到");
  });

  it("cancels a wait without killing the process and releases it explicitly", async () => {
    const f = await setup();
    const { terminalId } = await f.call("terminal/create", { command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"] }) as { terminalId: string };
    const controller = new AbortController();
    const waiting = f.call("terminal/wait_for_exit", { terminalId }, controller.signal);
    const rejected = expect(waiting).rejects.toThrow("取消"); controller.abort(); await rejected;
    expect(await f.call("terminal/output", { terminalId })).not.toHaveProperty("exitStatus");
    await f.call("terminal/kill", { terminalId });
    expect(await f.call("terminal/output", { terminalId })).toHaveProperty("exitStatus");
  });

  it.skipIf(process.platform === "win32")("releases background descendants after their launcher exits", async () => {
    const f = await setup();
    const script = "const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); console.log(child.pid); child.unref();";
    const { terminalId } = await f.call("terminal/create", { command: process.execPath, args: ["-e", script] }) as { terminalId: string };
    await f.call("terminal/wait_for_exit", { terminalId });
    const { output } = await f.call("terminal/output", { terminalId }) as { output: string };
    const pid = Number(output.trim());
    expect(Number.isInteger(pid) && pid > 0).toBe(true);
    const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
    try {
      expect(alive()).toBe(true);
      await f.call("terminal/release", { terminalId });
      const deadline = Date.now() + 1500;
      while (alive() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(alive()).toBe(false);
    } finally { if (alive()) process.kill(pid, "SIGKILL"); }
  });
});
