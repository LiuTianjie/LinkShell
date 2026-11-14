import { createConnection, type Socket } from "node:net";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it } from "vitest";
import { FusionShare } from "../src/fusion.js";

type Access = { recording: boolean | null; control: boolean | null; app?: string };

/** Plays LinkShell --fusion-remote: dials the parent socket and answers each token with a port. */
function fakeRemote(options: { answer?: boolean } = {}) {
  const seen: { args: string[]; tokens: string[]; socket?: Socket } = { args: [], tokens: [] };
  const launch = (_app: string, args: string[]) => {
    seen.args = args;
    const sock = args[args.indexOf("--parent-sock") + 1]!;
    const socket = createConnection(sock);
    seen.socket = socket;
    socket.write(`${JSON.stringify({ t: "hello", pid: 1 })}\n`);
    let port = 50_000;
    createInterface({ input: socket }).on("line", (line) => {
      const message = JSON.parse(line) as { t: string; token: string };
      if (message.t !== "token") return;
      seen.tokens.push(message.token);
      if (options.answer !== false) socket.write(`${JSON.stringify({ t: "ready", port: port++, pid: 1 })}\n`);
    });
  };
  return { seen, launch };
}

function share(access: Access, launch: (app: string, args: string[]) => void, extra: Record<string, unknown> = {}) {
  return new FusionShare(() => undefined, { access: async () => ({ supported: true, ffmpeg: true, ...access }) as never }, () => [], () => undefined, {
    launch,
    app: () => "/Applications/LinkShell.app",
    supported: () => true,
    home: () => "/tmp/linkshell-home",
    ...extra,
  });
}

describe("FusionShare", () => {
  const shares: FusionShare[] = [];
  afterEach(() => {
    for (const s of shares.splice(0)) s.stop();
  });

  it("never puts the token on the remote's command line and hands out a fresh token per start", async () => {
    const remote = fakeRemote();
    const fusion = share({ recording: true, control: true }, remote.launch);
    shares.push(fusion);
    const first = await fusion.start();
    const second = await fusion.start();
    expect(first.token).not.toBe(second.token);
    expect(remote.seen.tokens).toEqual([first.token, second.token]);
    expect(remote.seen.args.join(" ")).not.toContain(first.token);
    expect(remote.seen.args).not.toContain("--token");
    expect(remote.seen.args).toContain("--home");
    expect(first.port).toBe(50_000);
    expect(second.port).toBe(50_001);
  });

  it("shares one answer between concurrent starts so the token is not rotated under the first caller", async () => {
    const remote = fakeRemote();
    const fusion = share({ recording: true, control: true }, remote.launch);
    shares.push(fusion);
    const [a, b] = await Promise.all([fusion.start(), fusion.start()]);
    expect(a.token).toBe(b.token);
    expect(remote.seen.tokens).toHaveLength(1);
  });

  it("refuses to start without Accessibility on the remote, not only without Screen Recording", async () => {
    const remote = fakeRemote();
    const fusion = share({ recording: true, control: false }, remote.launch);
    shares.push(fusion);
    await expect(fusion.start()).rejects.toThrow(/辅助功能/);
    const noRecording = share({ recording: false, control: true }, remote.launch);
    shares.push(noRecording);
    await expect(noRecording.start()).rejects.toThrow(/屏幕录制/);
    expect(remote.seen.tokens).toHaveLength(0);
  });

  it("stop() during a start rejects it at once instead of after the 15 s timeout", async () => {
    const fusion = share({ recording: true, control: true }, () => undefined, { startTimeoutMs: 60_000 });
    shares.push(fusion);
    const started = fusion.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const at = Date.now();
    fusion.stop();
    await expect(started).rejects.toThrow(/停止/);
    expect(Date.now() - at).toBeLessThan(1_000);
  });

  it("stop() while waiting for the remote's answer rejects the pending start", async () => {
    const remote = fakeRemote({ answer: false });
    const fusion = share({ recording: true, control: true }, remote.launch, { readyTimeoutMs: 60_000 });
    shares.push(fusion);
    const started = fusion.start();
    while (remote.seen.tokens.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    fusion.stop();
    await expect(started).rejects.toThrow();
  });

  it("a remote that exits before answering fails the start with a clear message", async () => {
    const remote = fakeRemote({ answer: false });
    const fusion = share({ recording: true, control: true }, remote.launch, { readyTimeoutMs: 60_000 });
    shares.push(fusion);
    const started = fusion.start();
    while (remote.seen.tokens.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    remote.seen.socket?.destroy();
    await expect(started).rejects.toThrow(/意外退出/);
  });
});
