import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FUSION_FILE_CLIPBOARD_CHUNK_BYTES, FUSION_MAX_FILE_CLIPBOARD } from "@linkshell/wire";
import { RTCPeerConnection, useH264, type RTCDataChannel } from "werift";
import { FusionNodeRemote, resolveSafeClipFilePath } from "../src/fusion/remote.js";
import { SIMULATED_APP, SimulatedFusionPlatform } from "../src/fusion/simulated.js";
import { connectFusion, type FusionConnection, type FusionMessage } from "../src/fusion/wire.js";

const hasFfmpeg = (() => {
  try { return execFileSync(process.env.LINKSHELL_FFMPEG || "ffmpeg", ["-hide_banner", "-encoders"], { encoding: "utf8" }).includes("libx264"); }
  catch { return false; }
})();

/** Plays a local computer: the protocol over the real TLS-PSK connection, werift for the pictures. */
class Local {
  readonly messages: FusionMessage[] = [];
  readonly connection: FusionConnection;
  readonly pc = new RTCPeerConnection({ codecs: { video: [useH264()] } });
  readonly channels = new Map<string, RTCDataChannel>();
  readonly packets = new Map<string, Buffer[]>();
  readonly seqs = new Map<string, number[]>();
  private waiters: Array<{ match: (m: FusionMessage) => boolean; resolve: (m: FusionMessage) => void }> = [];
  private midToKey = new Map<string, string>();

  constructor(port: number, token: string, extra: Record<string, unknown> = {}) {
    this.connection = connectFusion("127.0.0.1", port, token);
    this.connection.onReady = () => this.connection.send({
      t: "hello", proto: 2, token, platform: "macos", features: ["clipboard", "keys"],
      displays: [{ frame: { x: 0, y: 0, w: 1512, h: 982 }, visible: { x: 0, y: 38, w: 1512, h: 944 }, scale: 2, hz: 120 }], ...extra,
    });
    this.connection.onMessage = (m) => this.receive(m);
    this.pc.onIceCandidate.subscribe((c) => { if (c) this.connection.send({ t: "rtc", m: { t: "ice", ...c.toJSON() } }); });
    this.pc.onDataChannel.subscribe((channel) => this.channels.set(channel.label, channel));
    this.pc.onTransceiverAdded.subscribe((transceiver) => {
      transceiver.onTrack.subscribe((track) => track.onReceiveRtp.subscribe((rtp) => {
        const key = this.midToKey.get(transceiver.mid ?? "") ?? `mid:${transceiver.mid}`;
        const list = this.packets.get(key) ?? [];
        list.push(rtp.payload);
        this.packets.set(key, list);
        const mid = `mid:${transceiver.mid}`;
        this.seqs.set(mid, [...(this.seqs.get(mid) ?? []).slice(-200), rtp.header.sequenceNumber]);
      }));
    });
  }

  private receive(m: FusionMessage): void {
    this.messages.push(m);
    if (m.t === "rtc") void this.rtc(m.m as Record<string, unknown>);
    for (const waiter of [...this.waiters]) {
      if (waiter.match(m)) { this.waiters.splice(this.waiters.indexOf(waiter), 1); waiter.resolve(m); }
    }
  }

  private async rtc(m: Record<string, unknown>): Promise<void> {
    if (m.t === "streams") for (const s of m.streams as Array<{ k: string; mid: string }>) this.midToKey.set(s.mid, s.k);
    if (m.t === "offer") {
      await this.pc.setRemoteDescription({ type: "offer", sdp: m.sdp as string });
      const answer = await this.pc.createAnswer();
      await this.pc.setLocalDescription(answer);
      this.connection.send({ t: "rtc", m: { t: "answer", sdp: this.pc.localDescription?.sdp } });
    }
    if (m.t === "ice") await this.pc.addIceCandidate({ candidate: m.candidate as string, sdpMid: m.sdpMid as string, sdpMLineIndex: m.sdpMLineIndex as number }).catch(() => undefined);
  }

  next(match: (m: FusionMessage) => boolean, timeoutMs = 10_000): Promise<FusionMessage> {
    const seen = this.messages.find(match);
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for a message")), timeoutMs);
      this.waiters.push({ match, resolve: (m) => { clearTimeout(timer); resolve(m); } });
    });
  }

  close(): void { this.connection.close(); void this.pc.close(); }
}

describe("Fusion remote in the host (simulated platform)", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

  it("tells an old local computer to upgrade, and spends the token", async () => {
    const remote = new FusionNodeRemote(new SimulatedFusionPlatform(), { log: () => {}, port: 0 });
    cleanups.push(() => remote.stop());
    const port = await remote.issue("tok-old", []);
    const local = new Local(port, "tok-old", { proto: 1 });
    cleanups.push(() => local.close());
    const bye = await local.next((m) => m.t === "bye");
    expect(bye.reason).toBe("proto");
  });

  it.skipIf(!hasFfmpeg)("shakes hands, lists apps, opens a window, sends its pictures with the crop metadata, and takes input by stream", async () => {
    const platform = new SimulatedFusionPlatform();
    const remote = new FusionNodeRemote(platform, { log: () => {}, port: 0 });
    cleanups.push(() => remote.stop());
    const port = await remote.issue("tok-1", []);
    const local = new Local(port, "tok-1");
    cleanups.push(() => local.close());

    const welcome = await local.next((m) => m.t === "welcome");
    expect(welcome).toMatchObject({ proto: 2, platform: "windows", resumed: false });
    const apps = await local.next((m) => m.t === "apps");
    expect(apps.apps).toEqual([expect.objectContaining({ app: SIMULATED_APP, system: false })]);
    const ready = await local.next((m) => m.t === "ready");
    expect(ready.displays).toEqual([{ index: 0, frame: { x: 0, y: 0, w: 1920, h: 1080 } }]);

    local.connection.send({ t: "launch", app: SIMULATED_APP });
    const wopen = await local.next((m) => m.t === "wopen");
    expect(wopen).toMatchObject({ app: SIMULATED_APP, stream: `w${wopen.id}`, chrome: { style: "windows" } });
    expect((wopen.frame as { w: number }).w).toBe(800);

    // The window's stream is mapped, and its packets carry our SEI.
    await local.next((m) => m.t === "rtc" && (m.m as { t: string }).t === "streams" && JSON.stringify(m.m).includes(`"w${wopen.id}"`));
    const deadline = Date.now() + 15_000;
    let sei = false;
    while (Date.now() < deadline && !sei) {
      await new Promise((r) => setTimeout(r, 200));
      sei = (local.packets.get(`w${wopen.id}`) ?? []).some((payload) => payload.includes("LinkShellFusion1"));
    }
    expect(sei).toBe(true);

    // Input names its window; the remote hands it to that window.
    const input = local.channels.get("input");
    expect(input).toBeDefined();
    local.connection.send({ t: "rtc", m: { t: "control" } });
    const control = await local.next((m) => m.t === "rtc" && (m.m as { t: string }).t === "control");
    expect(control.m).toMatchObject({ trusted: true });
    const stream = `w${wopen.id}`;
    input!.send(JSON.stringify({ t: "down", b: "left", n: 1, stream, k: stream, i: 1 }));
    input!.send(JSON.stringify({ t: "down", b: "left", n: 1, stream: "w999999", i: 2 }));
    // A key keeps its name: the window is named in `stream`, not over the key's `k`.
    input!.send(JSON.stringify({ t: "key", k: "return", stream, i: 3 }));
    // 0.10.106 named the window in `k`: its clicks still arrive.
    input!.send(JSON.stringify({ t: "up", b: "left", n: 1, k: stream, i: 4 }));
    await new Promise((r) => setTimeout(r, 300));
    expect(platform.inputs).toEqual([
      { target: { window: wopen.id }, event: { t: "down", b: "left", n: 1, i: 1 } },
      { target: { window: wopen.id }, event: { t: "key", k: "return", i: 3 } },
      { target: { window: wopen.id }, event: { t: "up", b: "left", n: 1, i: 4 } },
    ]);

    // A resize from the local side reaches the window, and the next layout acknowledges it.
    local.connection.send({ t: "place", id: wopen.id, seq: 1, frame: { x: 200, y: 100, w: 640, h: 480 }, resize: true });
    const layout = await local.next((m) => m.t === "layout" && (m.windows as Array<{ ack?: number; frame: { w: number } }>).some((w) => w.ack === 1 && w.frame.w === 640));
    expect(layout).toBeDefined();

    // Closing it there closes it here.
    local.connection.send({ t: "wclose.req", id: wopen.id });
    await local.next((m) => m.t === "wclose" && m.id === wopen.id);
    await local.next((m) => m.t === "app.exited" && m.app === SIMULATED_APP);

    // The next window reuses that transceiver, and its RTP numbering goes on from where it was.
    const midOf = (key: string) => [...local.messages].reverse().flatMap((m) => (m.t === "rtc" && (m.m as { t: string }).t === "streams" ? (m.m as { streams: Array<{ k: string; mid: string }> }).streams : [])).find((s) => s.k === key)?.mid;
    const firstMid = midOf(`w${wopen.id}`)!;
    const lastSeq = local.seqs.get(`mid:${firstMid}`)!.at(-1)!;
    local.connection.send({ t: "launch", app: SIMULATED_APP });
    const second = await local.next((m) => m.t === "wopen" && m.id !== wopen.id);
    await local.next((m) => m.t === "rtc" && (m.m as { t: string }).t === "streams" && JSON.stringify(m.m).includes(`"w${second.id}"`));
    expect(midOf(`w${second.id}`)).toBe(firstMid);
    const resumed = await (async () => {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const seqs = local.seqs.get(`mid:${firstMid}`)!;
        const next = seqs.find((seq) => ((seq - lastSeq) & 0xffff) > 0 && ((seq - lastSeq) & 0xffff) < 4096);
        if (next !== undefined) return next;
        await new Promise((r) => setTimeout(r, 200));
      }
      return undefined;
    })();
    expect(resumed).toBeDefined();
  }, 60_000);

  it("sends a window that has stopped changing to a receiver that connects afterwards", async () => {
    // Windows.Graphics.Capture sends a frame per change: a still window's encoder says nothing
    // more, and the receiver must get the key picture and what followed it all the same.
    const nal = (type: number, text: string) => Buffer.concat([Buffer.from([0, 0, 0, 1, type]), Buffer.from(text)]);
    class StillPlatform extends SimulatedFusionPlatform {
      windowVideo(_id: number, _canvas: { w: number; h: number }, _fps: number, _bitrate: number, onUnit: (unit: Buffer, key: boolean) => void): { stop(): void } {
        onUnit(Buffer.concat([nal(0x67, "sps"), nal(0x68, "pps"), nal(0x65, "KEY-PICTURE")]), true);
        onUnit(nal(0x41, "DELTA-ONE"), false);
        onUnit(nal(0x41, "DELTA-TWO"), false);
        return { stop() {} };
      }
      monitorVideo(): { stop(): void } { return { stop() {} }; }
    }
    const platform = new StillPlatform();
    const remote = new FusionNodeRemote(platform, { log: () => {}, port: 0 });
    cleanups.push(() => remote.stop());
    const port = await remote.issue("still-token", []);
    const local = new Local(port, "still-token");
    cleanups.push(() => local.close());
    await local.next((m) => m.t === "ready");
    local.connection.send({ t: "launch", app: SIMULATED_APP });
    const wopen = await local.next((m) => m.t === "wopen");
    const got = (text: string) => (local.packets.get(`w${wopen.id}`) ?? []).some((payload) => payload.includes(text));
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && !(got("KEY-PICTURE") && got("DELTA-TWO"))) await new Promise((r) => setTimeout(r, 100));
    expect(["LinkShellFusion1", "KEY-PICTURE", "DELTA-ONE", "DELTA-TWO"].map(got)).toEqual([true, true, true, true]);
    // In the encoder's order: the key picture first.
    const order = (local.packets.get(`w${wopen.id}`) ?? []).map((payload) => ["KEY-PICTURE", "DELTA-ONE", "DELTA-TWO"].find((text) => payload.includes(text))).filter(Boolean);
    expect(order.slice(0, 3)).toEqual(["KEY-PICTURE", "DELTA-ONE", "DELTA-TWO"]);
  }, 30_000);

  it("shows a new session nothing an earlier session launched", async () => {
    const platform = new SimulatedFusionPlatform();
    const remote = new FusionNodeRemote(platform, { log: () => {}, port: 0 });
    cleanups.push(() => remote.stop());
    const first = new Local(await remote.issue("tok-a", []), "tok-a");
    cleanups.push(() => first.close());
    await first.next((m) => m.t === "ready");
    first.connection.send({ t: "launch", app: SIMULATED_APP });
    await first.next((m) => m.t === "wopen");
    const second = new Local(await remote.issue("tok-b", []), "tok-b");
    cleanups.push(() => second.close());
    expect((await first.next((m) => m.t === "bye")).reason).toBe("replaced");
    await second.next((m) => m.t === "ready");
    await new Promise((r) => setTimeout(r, 800));
    expect(second.messages.some((m) => m.t === "wopen")).toBe(false);
  });

  it("shares the clipboard, text and pictures, once the user has been in a window", async () => {
    const platform = new SimulatedFusionPlatform();
    const remote = new FusionNodeRemote(platform, { log: () => {}, port: 0 });
    cleanups.push(() => remote.stop());
    const local = new Local(await remote.issue("tok-clip", []), "tok-clip");
    cleanups.push(() => local.close());
    expect((await local.next((m) => m.t === "welcome")).features).toContain("clipboard");
    await local.next((m) => m.t === "ready");
    local.connection.send({ t: "launch", app: SIMULATED_APP });
    const opened = await local.next((m) => m.t === "wopen");
    // Before the user has been in a window, neither side's clipboard is the other's.
    local.connection.send({ t: "clip", text: "too early" });
    platform.copy({ text: "also too early" });
    await new Promise((r) => setTimeout(r, 200));
    expect(platform.clipboard).toBeUndefined();
    expect(local.messages.some((m) => m.t === "clip")).toBe(false);
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    local.connection.send({ t: "focus", id: opened.id });
    local.connection.send({ t: "clip", text: "from the Mac", png: png.toString("base64") });
    await vi.waitFor(() => expect(platform.clipboard?.text).toBe("from the Mac"));
    expect(platform.clipboard?.png?.equals(png)).toBe(true);
    platform.copy({ text: "from Windows", png });
    const clip = await local.next((m) => m.t === "clip");
    expect(clip.text).toBe("from Windows");
    expect(clip.png).toBe(png.toString("base64"));
    // More than the frame is made for stays where it is.
    local.connection.send({ t: "clip", text: "x".repeat((8 << 20) + 1) });
    await new Promise((r) => setTimeout(r, 300));
    expect(platform.clipboard?.text).toBe("from the Mac");
  }, 30_000);

  it("keeps an app fused across a Profile Picker → main window handoff, and ignores unauthenticated probes", async () => {
    class HandoffPlatform extends SimulatedFusionPlatform {
      private currentWindows: Array<{ id: number; pid: number; app: string; title: string; rect: { x: number; y: number; w: number; h: number }; monitor: number; popup: boolean }> = [];
      private onChange?: (w: typeof this.currentWindows) => void;
      readonly fusedNow = new Set<string>();
      override watch(onWindows: (w: typeof this.currentWindows) => void): void {
        this.onChange = onWindows;
        onWindows(this.currentWindows.filter((w) => this.fusedNow.has(w.app)));
      }
      override setFused(apps: string[]): void {
        this.fusedNow.clear();
        for (const app of apps) this.fusedNow.add(app);
        this.onChange?.(this.currentWindows.filter((w) => this.fusedNow.has(w.app)));
      }
      override async launch(app: string): Promise<void> {
        this.currentWindows = [{ id: 5001, pid: 42, app, title: "选择 Chrome 用户资料", rect: { x: 100, y: 100, w: 720, h: 520 }, monitor: 0, popup: false }];
        this.onChange?.(this.currentWindows.filter((w) => this.fusedNow.has(w.app)));
      }
      setWindows(next: typeof this.currentWindows): void {
        this.currentWindows = next;
        this.onChange?.(this.currentWindows.filter((w) => this.fusedNow.has(w.app)));
      }
      override windowVideo(): { stop(): void } { return { stop() {} }; }
      override monitorVideo(): { stop(): void } { return { stop() {} }; }
    }

    const platform = new HandoffPlatform();
    const remote = new FusionNodeRemote(platform, { log: () => {}, port: 0 });
    cleanups.push(() => remote.stop());
    const port = await remote.issue("tok-handoff", []);
    const local = new Local(port, "tok-handoff");
    cleanups.push(() => local.close());
    await local.next((m) => m.t === "ready");

    local.connection.send({ t: "launch", app: SIMULATED_APP });
    const picker = await local.next((m) => m.t === "wopen" && m.id === 5001);
    expect(picker.title).toBe("选择 Chrome 用户资料");

    // An unauthenticated TLS probe connects and drops without `hello`: active `fused` must survive.
    const stray = connectFusion("127.0.0.1", port, "tok-handoff");
    await new Promise<void>((resolve) => { stray.onReady = () => { stray.close(); resolve(); }; stray.onClose = () => resolve(); });
    await new Promise((r) => setTimeout(r, 80));
    expect(platform.fusedNow.has(SIMULATED_APP)).toBe(true);

    // Picker closes on its own after profile selection; 350 ms later the profile browser window opens.
    platform.setWindows([]);
    await local.next((m) => m.t === "wclose" && m.id === 5001);
    await new Promise((r) => setTimeout(r, 350));
    expect(local.messages.some((m) => m.t === "app.exited")).toBe(false);

    platform.setWindows([{ id: 5002, pid: 42, app: SIMULATED_APP, title: "新标签页 - Google Chrome", rect: { x: 120, y: 80, w: 1280, h: 820 }, monitor: 0, popup: false }]);
    const browserWin = await local.next((m) => m.t === "wopen" && m.id === 5002);
    expect(browserWin).toMatchObject({ id: 5002, app: SIMULATED_APP, title: "新标签页 - Google Chrome" });
    expect(local.messages.some((m) => m.t === "app.exited")).toBe(false);
  });

  it("relays chunked file-clipboard transfers, enforces 50 MiB cap, rejects path traversal, and cleans staging on abort/disconnect", async () => {
    expect(resolveSafeClipFilePath("/tmp/stage", 0, "../../etc/passwd")).toBeNull();
    expect(resolveSafeClipFilePath("/tmp/stage", 0, "sub\\evil.txt")).toBeNull();
    expect(resolveSafeClipFilePath("/tmp/stage", 0, "valid-name.txt")).toContain("valid-name.txt");

    const platform = new SimulatedFusionPlatform();
    const remote = new FusionNodeRemote(platform, { log: () => {}, port: 0 });
    cleanups.push(() => remote.stop());
    const local = new Local(await remote.issue("tok-files", []), "tok-files", {
      features: ["clipboard", "file-clipboard", "keys"],
    });
    cleanups.push(() => local.close());

    const welcome = await local.next((m) => m.t === "welcome");
    expect(welcome.features).toContain("clipboard");
    expect(welcome.features).toContain("file-clipboard");
    await local.next((m) => m.t === "ready");
    local.connection.send({ t: "launch", app: SIMULATED_APP });
    const opened = await local.next((m) => m.t === "wopen");
    local.connection.send({ t: "focus", id: opened.id });

    // 1. Incoming path-traversal filename is rejected and staged files are cleaned up.
    local.connection.send({
      t: "clip.file.start",
      transferId: "t-traversal",
      files: [{ index: 0, name: "../escape.txt", size: 4 }],
      totalBytes: 4,
    });
    const badEnd = await local.next((m) => m.t === "clip.file.end" && m.transferId === "t-traversal");
    expect(badEnd.ok).toBe(false);
    expect(platform.clipboard?.files).toBeUndefined();

    // 2. Incoming multi-chunk valid transfer stages files safely and delivers paths to platform clipboard.
    const bigPayload = Buffer.alloc(FUSION_FILE_CLIPBOARD_CHUNK_BYTES + 123, 0x41);
    const secondPayload = Buffer.from("hello-file-2");
    local.connection.send({
      t: "clip.file.start",
      transferId: "t-ok",
      files: [
        { index: 0, name: "big.bin", size: bigPayload.length },
        { index: 1, name: "note.txt", size: secondPayload.length },
      ],
      totalBytes: bigPayload.length + secondPayload.length,
    });
    local.connection.send({
      t: "clip.file.chunk",
      transferId: "t-ok",
      index: 0,
      seq: 0,
      data: bigPayload.subarray(0, FUSION_FILE_CLIPBOARD_CHUNK_BYTES).toString("base64"),
    });
    local.connection.send({
      t: "clip.file.chunk",
      transferId: "t-ok",
      index: 0,
      seq: 1,
      data: bigPayload.subarray(FUSION_FILE_CLIPBOARD_CHUNK_BYTES).toString("base64"),
    });
    local.connection.send({
      t: "clip.file.chunk",
      transferId: "t-ok",
      index: 1,
      seq: 0,
      data: secondPayload.toString("base64"),
    });
    local.connection.send({ t: "clip.file.end", transferId: "t-ok", ok: true });

    await vi.waitFor(() => expect(platform.clipboard?.files).toHaveLength(2));
    const stagedFiles = platform.clipboard!.files!;
    const stageRoot = dirname(dirname(stagedFiles[0]!));
    expect(readFileSync(stagedFiles[0]!).equals(bigPayload)).toBe(true);
    expect(readFileSync(stagedFiles[1]!, "utf8")).toBe("hello-file-2");

    // 3. Outgoing multi-chunk file clipboard sends start -> chunks -> end; >50 MiB batch is skipped.
    const outDir = mkdtempSync(join(tmpdir(), "lsh-fusion-out-"));
    try {
      const outPath = join(outDir, "outgoing.bin");
      const outBytes = Buffer.alloc(FUSION_FILE_CLIPBOARD_CHUNK_BYTES + 42, 0x62);
      writeFileSync(outPath, outBytes);
      platform.copy({ files: [outPath] });

      const startMsg = await local.next((m) => m.t === "clip.file.start");
      const outTid = startMsg.transferId as string;
      expect(startMsg.totalBytes).toBe(outBytes.length);
      const endMsg = await local.next((m) => m.t === "clip.file.end" && m.transferId === outTid);
      expect(endMsg.ok).toBe(true);
      const chunks = local.messages.filter((m) => m.t === "clip.file.chunk" && m.transferId === outTid);
      expect(chunks).toHaveLength(2);
      const reassembled = Buffer.concat(chunks.map((c) => Buffer.from(c.data as string, "base64")));
      expect(reassembled.equals(outBytes)).toBe(true);

      // Oversized file (>50 MiB) must not start a transfer.
      const hugePath = join(outDir, "huge.bin");
      const { truncateSync } = await import("node:fs");
      writeFileSync(hugePath, "");
      truncateSync(hugePath, FUSION_MAX_FILE_CLIPBOARD + 1);
      const countBefore = local.messages.filter((m) => m.t === "clip.file.start").length;
      platform.copy({ files: [hugePath] });
      await new Promise((r) => setTimeout(r, 150));
      expect(local.messages.filter((m) => m.t === "clip.file.start").length).toBe(countBefore);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }

    // 4. Aborted incoming transfer & session disconnect clean up staging directories.
    local.connection.send({
      t: "clip.file.start",
      transferId: "t-abort",
      files: [{ index: 0, name: "abort.txt", size: 5 }],
      totalBytes: 5,
    });
    local.connection.send({ t: "clip.file.end", transferId: "t-abort", ok: false });
    await new Promise((r) => setTimeout(r, 80));

    local.connection.send({ t: "bye", reason: "done" });
    await vi.waitFor(() => expect(existsSync(stageRoot)).toBe(false));
  }, 30_000);
});
