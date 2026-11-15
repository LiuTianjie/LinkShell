import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { RTCPeerConnection, useH264, type RTCDataChannel } from "werift";
import { FusionNodeRemote } from "../src/fusion/remote.js";
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
    input!.send(JSON.stringify({ t: "down", b: "left", n: 1, k: `w${wopen.id}`, i: 1 }));
    input!.send(JSON.stringify({ t: "down", b: "left", n: 1, k: "w999999", i: 2 }));
    await new Promise((r) => setTimeout(r, 300));
    expect(platform.inputs).toEqual([{ target: { window: wopen.id }, event: { t: "down", b: "left", n: 1, i: 1 } }]);

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
});
