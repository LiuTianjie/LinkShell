import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { windowsPipe } from "../src/local-transport.js";
import { WindowsFrameSplitter, windowsProfile } from "../src/windows-screen.js";
import { startHost, isHostRunning } from "../src/host.js";
import { connectHost } from "../src/rpc/client.js";
import { CodexAppServer } from "../src/drivers/codex/app-server.js";
import { probeAgent } from "../src/process.js";
import { TerminalManager } from "../src/terminals.js";
import { resolveExecutable } from "../src/drivers/claude/driver.js";

describe("Windows paths and frames", () => {
  it("normalizes equivalent home paths and separates independent installations", () => {
    expect(windowsPipe("C:\\Users\\测试\\LinkShell", "host")).toBe(windowsPipe("c:/users/测试/LinkShell/", "host"));
    expect(windowsPipe("C:\\one", "host")).not.toBe(windowsPipe("C:\\two", "host"));
    expect(windowsPipe("C:\\" + "长目录".repeat(100), "host").length).toBeLessThan(80);
  });
  it("reassembles fragmented screen frames and rejects unbounded lengths", () => {
    const frame = Buffer.from([255, 216, 10, 20, 255, 217]);
    const header = Buffer.alloc(4); header.writeUInt32LE(frame.length);
    const wire = Buffer.concat([header, frame, header, frame]);
    const frames: Buffer[] = [], parser = new WindowsFrameSplitter();
    for (const byte of wire) parser.push(Buffer.from([byte]), frame => frames.push(frame));
    expect(frames).toEqual([frame, frame]);
    expect(() => new WindowsFrameSplitter().push(Buffer.from([255, 255, 255, 255]), () => {})).toThrow(/length/);
  });
  it("uses JPEG profiles with receiver limits and lowers quality without exceeding selected width", () => {
    expect(windowsProfile(0)).toMatchObject({ fps: 30, width: 1920 });
    expect(windowsProfile(0, 2560)).toMatchObject({ fps: 30, width: 2560 });
    expect(windowsProfile(1, 1280)).toMatchObject({ fps: 24, width: 1280 });
    expect(windowsProfile(3, 1920, 12)).toMatchObject({ fps: 12, width: 1024 });
    expect(windowsProfile(100, 9999).quality).toBeLessThan(windowsProfile(0).quality);
    expect(windowsProfile(0, 9999).width).toBe(3840);
  });
});

describe.skipIf(process.platform !== "win32")("Windows host integration", () => {
  const cleanup: (() => unknown)[] = [];
  afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
  function temporary() {
    const home = mkdtempSync(join(tmpdir(), "linkshell-中文 空格-"));
    cleanup.push(() => rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
    return home;
  }
  it("resolves native Claude and npm JS entry points with case-insensitive Windows PATH", () => {
    const home = temporary(), env = { Path: home, PATHEXT: ".EXE;.CMD" };
    writeFileSync(join(home, "claude.exe"), "fixture");
    expect(resolveExecutable("claude", env)?.toLowerCase()).toBe(join(home, "claude.exe").toLowerCase());
    rmSync(join(home, "claude.exe")); writeFileSync(join(home, "claude.cmd"), "@echo off");
    const module = join(home, "node_modules/@anthropic-ai/claude-code");
    mkdirSync(module, { recursive: true }); writeFileSync(join(module, "cli.js"), "");
    expect(resolveExecutable("claude", env)).toBe(join(module, "cli.js"));
  });
  it("runs SQLite over a named pipe, rejects a second host, and stops cleanly", async () => {
    const home = temporary();
    let shutdown = false;
    // Use Windows' own modules, not a test runner's injected PowerShell module path.
    const env = { ...process.env, PSModulePath: join(process.env.SystemRoot ?? "C:\\Windows", "System32/WindowsPowerShell/v1.0/Modules") };
    delete env.PSExecutionPolicyPreference;
    const host = await startHost({ home, version: "windows-test", env, drivers: () => [], iceServers: false, log: () => {}, shutdown: () => { shutdown = true; } });
    cleanup.push(() => host.stop());
    const client = await connectHost(host.paths.hostSocket);
    cleanup.push(() => client.close());
    expect(await isHostRunning(host.paths.hostSocket)).toBe(true);
    expect((await client.call("machine.info", {})).platform).toBe("win32");
    await expect(startHost({ home, version: "duplicate", drivers: () => [] })).rejects.toThrow(/already running/);
    await expect(client.call("desktop.shutdown", { pid: process.pid + 1 })).rejects.toThrow(/改变/);
    await client.call("desktop.shutdown", { pid: process.pid });
    await expect.poll(() => shutdown).toBe(true);
  }, 30_000);
  it("runs PowerShell through ConPTY with Unicode paths and releases its working directory", async () => {
    const home = temporary();
    const terminals = new TerminalManager(process.env);
    cleanup.push(() => terminals.stop());
    // Non-interactive input avoids loading the developer's PSReadLine/profile in a regression test.
    const script = "[Console]::WriteLine('READY'); while (($line = [Console]::ReadLine()) -ne $null) { if ($line -eq 'exit') { break }; [Console]::WriteLine('WINDOWS_' + $line) }";
    const terminal = terminals.create({ cwd: home, cols: 80, rows: 24, launch: { command: "powershell.exe", args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")] } });
    let output = "";
    terminals.attach(terminal.id, (_seq, data) => { output += data; });
    terminals.input(terminal.id, "PTY_OK\r\n");
    await expect.poll(() => output, { timeout: 10_000 }).toContain("WINDOWS_PTY_OK");
    terminals.resize(terminal.id, 100, 30);
    terminals.input(terminal.id, "exit\r\n");
    await expect.poll(() => terminals.list().find(t => t.id === terminal.id)?.exitCode, { timeout: 10_000 }).toBe(0);
    terminals.close(terminal.id);
  }, 30_000);
  it("launches npm-style cmd shims and uses Codex JSONL with notifications and approvals", async () => {
    const home = temporary();
    const script = join(home, "fixture.cjs"), command = join(home, "agent.cmd");
    writeFileSync(command, `@echo off\r\n"${process.execPath}" "%~dp0fixture.cjs" %*\r\n`);
    writeFileSync(script, `
      if (process.argv.includes('--version')) { console.log('codex-cli 1.0.0'); process.exit(); }
      if (process.argv.includes('features')) process.exit();
      require('node:readline').createInterface({input:process.stdin}).on('line', line => {
        const m = JSON.parse(line);
        if (m.method === 'initialized') return;
        if (m.method === 'echo') {
          console.log(JSON.stringify({method:'notice',params:{ok:true}}));
          console.log(JSON.stringify({id:'approval',method:'approve',params:{}}));
        }
        if (m.id === 'approval') return;
        console.log(JSON.stringify({id:m.id,result:m.method === 'echo' ? m.params : m.method === 'pid' ? process.pid : {}}));
      });
    `);
    expect((await probeAgent(command, ["--version"])).stdout).toContain("1.0.0");
    const notifications: string[] = [], requests: string[] = [];
    const server = new CodexAppServer({ command, socketPath: windowsPipe(home, "codex"), clientVersion: "test", log: () => {}, onDown: () => {}, onNotification: method => notifications.push(method), onRequest: method => { requests.push(method); return { decision: "accept" }; } });
    cleanup.push(() => server.stop());
    await server.start();
    expect(await server.request("echo", { text: '中文 & "quoted" %PATH%' })).toEqual({ text: '中文 & "quoted" %PATH%' });
    await expect.poll(() => notifications).toContain("notice");
    await expect.poll(() => requests).toContain("approve");
    const pid = await server.request<number>("pid", {});
    await server.stop();
    await expect.poll(() => { try { process.kill(pid, 0); return true; } catch { return false; } }).toBe(false);
  }, 30_000);
});
