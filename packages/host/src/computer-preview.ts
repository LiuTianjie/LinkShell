import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import sharp from "sharp";
import { encodePreviewFrame, PREVIEW_MAX_BYTES, previewFrameSchema, type PreviewFrame } from "@linkshell/wire";
import { z } from "zod";

export const previewCaptureSchema = z.object({ bundleId: z.string().max(256).regex(/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/), title: z.string().min(1).max(512).optional(), app: z.boolean().optional() });
export type PreviewCaptureTarget = z.infer<typeof previewCaptureSchema>;
export interface PreviewInput { sourceId: string; target: string; capturedAt: number; dataUrl?: string; capture?: PreviewCaptureTarget }
interface Saved { sourceId: string; toolSourceId?: string; target: string; frame?: PreviewFrame; relay?: PreviewFrame; capture?: PreviewCaptureTarget }
interface Persistence {
  load(sessionId: string): string | undefined;
  save(sessionId: string, value: string): void;
  exists(sessionId: string): boolean;
  log(message: string): void;
  capture?(target: PreviewCaptureTarget, frame: (dataUrl: string) => void, failed: () => void): Promise<() => void>;
}

/** One durable latest frame per session; images never enter conversation history. */
export class ComputerPreviews {
  private readonly cache = new Map<string, Saved>();
  private readonly pending = new Map<string, PreviewInput>();
  private readonly listeners = new Map<string, Set<() => void>>();
  private draining?: Promise<void>;
  private closed = false;
  private readonly captures = new Map<string, { key: string; stop?: () => void; cancelled: boolean }>();
  private readonly captureRetries = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly captureFailures = new Map<string, number>();
  constructor(private readonly persistence: Persistence) {}

  get(sessionId: string): PreviewFrame | undefined { return this.read(sessionId)?.frame; }
  getRelay(sessionId: string): PreviewFrame | undefined { return this.read(sessionId)?.relay; }
  private read(sessionId: string): Saved | undefined {
    if (!this.persistence.exists(sessionId)) return;
    const cached = this.cache.get(sessionId);
    if (cached) return cached;
    try {
      const text = this.persistence.load(sessionId);
      if (!text || text.length > 120_000) return;
      const saved = JSON.parse(text);
      if (!saved.frame && typeof saved.target === "string" && saved.target.length <= 1024 && typeof saved.sourceId === "string") {
        const entry: Saved = { sourceId: saved.sourceId, toolSourceId: saved.toolSourceId, target: saved.target, capture: previewCaptureSchema.parse(saved.capture) };
        this.remember(sessionId, entry); return entry;
      }
      const info = previewFrameSchema.parse(saved.frame);
      if (typeof saved.data !== "string" || typeof saved.sourceId !== "string") return;
      const bytes = Buffer.from(saved.data, "base64");
      if (!bytes.length || bytes.length > PREVIEW_MAX_BYTES) return;
      const relayInfo = saved.relay ? previewFrameSchema.parse(saved.relay) : info;
      const relayBytes = typeof saved.relayData === "string" ? Buffer.from(saved.relayData, "base64") : bytes;
      if (relayBytes.length > PREVIEW_MAX_BYTES) return;
      const capture = saved.capture ? previewCaptureSchema.parse(saved.capture) : undefined;
      const entry = { target: info.target, sourceId: saved.sourceId, toolSourceId: typeof saved.toolSourceId === "string" ? saved.toolSourceId : saved.sourceId, frame: { ...info, bytes }, relay: { ...relayInfo, bytes: relayBytes }, capture };
      this.remember(sessionId, entry);
      return entry;
    } catch { return; }
  }
  private remember(id: string, entry: Saved): void {
    this.cache.delete(id); this.cache.set(id, entry);
    if (this.cache.size > 128) this.cache.delete(this.cache.keys().next().value!);
  }
  put(sessionId: string, input: PreviewInput): Promise<void> {
    const previous = this.read(sessionId);
    if (!input.capture && previous?.target === input.target && previous.capture) input = { ...input, capture: previous.capture };
    if (input.capture?.app && !input.capture.title && previous?.target === input.target && previous.capture?.title) input = { ...input, capture: previous.capture };
    const sameCapture = JSON.stringify(previous?.capture) === JSON.stringify(input.capture);
    if (this.closed || !this.persistence.exists(sessionId) || ((previous?.sourceId === input.sourceId || previous?.toolSourceId === input.sourceId) && sameCapture)) return Promise.resolve();
    if (previous && !input.sourceId.startsWith("capture:") && previous.sourceId.startsWith("capture:") && sameCapture && previous.target === input.target && this.captures.has(sessionId)) {
      previous.toolSourceId = input.sourceId;
      return Promise.resolve();
    }
    if (!input.sourceId.startsWith("capture:") && previous && (!sameCapture || previous.target !== input.target)) this.endCapture(sessionId);
    if (!this.pending.has(sessionId) && this.pending.size >= 32) return Promise.resolve();
    this.pending.set(sessionId, input);
    this.draining ??= this.drain().finally(() => { this.draining = undefined; });
    return this.draining;
  }
  private async drain(): Promise<void> {
    // Only one image decode at a time. A busy source replaces its pending frame.
    while (this.pending.size && !this.closed) {
      const [id, input] = this.pending.entries().next().value!;
      this.pending.delete(id);
      try {
        if (!input.dataUrl && input.capture) {
          const previous = this.read(id);
          this.remember(id, { sourceId: input.sourceId, toolSourceId: input.sourceId, target: input.target, capture: input.capture, ...(previous?.target === input.target ? { frame: previous.frame, relay: previous.relay } : {}) });
          this.persist(id, true); this.startCapture(id);
          continue;
        }
        if (!input.dataUrl || input.dataUrl.length > 4 * 1024 * 1024 || !/^data:image\/(jpeg|png|webp);base64,/.test(input.dataUrl)) continue;
        const source = Buffer.from(input.dataUrl.slice(input.dataUrl.indexOf(",") + 1), "base64");
        const pipeline = () => sharp(source, { limitInputPixels: 16_000_000, animated: false }).rotate();
        let result = await pipeline().resize({ width: 480, height: 720, fit: "inside", withoutEnlargement: true }).webp({ quality: 60, effort: 2 }).toBuffer({ resolveWithObject: true });
        if (result.data.length > PREVIEW_MAX_BYTES) result = await pipeline().resize({ width: 320, height: 480, fit: "inside", withoutEnlargement: true }).webp({ quality: 35, effort: 2 }).toBuffer({ resolveWithObject: true });
        if (this.closed || !this.persistence.exists(id) || result.data.length > PREVIEW_MAX_BYTES) continue;
        // If a newer image arrived during decoding, publish that next instead of flashing an old image.
        if (this.pending.has(id)) continue;
        let small = await sharp(result.data).resize({ width: 320, height: 480, fit: "inside", withoutEnlargement: true }).webp({ quality: 45, effort: 2 }).toBuffer({ resolveWithObject: true });
        if (small.data.length > 16_384) small = await sharp(result.data).resize({ width: 200, height: 300, fit: "inside", withoutEnlargement: true }).webp({ quality: 30, effort: 2 }).toBuffer({ resolveWithObject: true });
        if (small.data.length > 16_384 || this.closed || !this.persistence.exists(id)) continue;
        const makeFrame = (image: typeof result): PreviewFrame => ({ id: createHash("sha256").update(input.target).update(image.data).digest("hex"), target: input.target, capturedAt: input.capturedAt, width: image.info.width, height: image.info.height, mimeType: "image/webp", bytes: image.data });
        const frame = makeFrame(result), relay = makeFrame(small), hash = frame.id;
        const changed = this.read(id)?.frame?.id !== hash;
        const toolSourceId = input.sourceId.startsWith("capture:") ? this.read(id)?.toolSourceId : input.sourceId;
        this.remember(id, { sourceId: input.sourceId, toolSourceId, target: input.target, frame, relay, capture: input.capture });
        // Continuous captures live in memory. Persist at most once every ten seconds, and when viewing ends.
        this.persist(id);
        this.startCapture(id);
        if (changed) for (const listener of this.listeners.get(id) ?? []) listener();
      } catch (error) { this.persistence.log(`[computer-preview] frame rejected: ${error instanceof Error ? error.message : String(error)}`); }
    }
  }
  subscribe(id: string, listener: () => void): () => void {
    const listeners = this.listeners.get(id) ?? new Set();
    this.listeners.set(id, listeners); listeners.add(listener);
    this.startCapture(id);
    return () => { listeners.delete(listener); if (!listeners.size) { this.listeners.delete(id); this.persist(id, true); this.endCapture(id); } };
  }
  private readonly savedAt = new Map<string, number>();
  private persist(id: string, force = false): void {
    const saved = this.cache.get(id);
    if (!saved || !this.persistence.exists(id) || (!force && saved.sourceId.startsWith("capture:") && Date.now() - (this.savedAt.get(id) ?? 0) < 10_000)) return;
    if (!saved.frame || !saved.relay) {
      this.persistence.save(id, JSON.stringify(saved)); return;
    }
    const { bytes, ...frame } = saved.frame;
    const { bytes: relayBytes, ...relay } = saved.relay;
    this.persistence.save(id, JSON.stringify({ sourceId: saved.sourceId, toolSourceId: saved.toolSourceId, capture: saved.capture, frame, relay, data: Buffer.from(bytes).toString("base64"), relayData: Buffer.from(relayBytes).toString("base64") }));
    this.savedAt.set(id, Date.now());
  }
  private startCapture(id: string): void {
    if (!this.listeners.get(id)?.size || !this.persistence.capture || this.closed || this.captureRetries.has(id)) return;
    const saved = this.read(id);
    if (!saved?.capture) { this.endCapture(id); return; }
    const key = JSON.stringify([saved.target, saved.capture]);
    if (this.captures.get(id)?.key === key) return;
    this.endCapture(id);
    const run = { key, cancelled: false } as { key: string; cancelled: boolean; stop?: () => void };
    this.captures.set(id, run);
    const failed = () => {
      if (run.cancelled || this.captures.get(id) !== run) return;
      this.endCapture(id);
      const attempts = (this.captureFailures.get(id) ?? 0) + 1;
      this.captureFailures.set(id, attempts);
      const timer = setTimeout(() => { this.captureRetries.delete(id); this.startCapture(id); }, Math.min(60_000, 15_000 * 2 ** Math.min(attempts - 1, 2)));
      timer.unref(); this.captureRetries.set(id, timer);
    };
    void this.persistence.capture(saved.capture, dataUrl => {
      if (run.cancelled || this.captures.get(id) !== run) return;
      this.captureFailures.delete(id);
      const sourceId = "capture:" + createHash("sha256").update(dataUrl).digest("hex");
      void this.put(id, { sourceId, dataUrl, target: saved.target, capture: saved.capture, capturedAt: Date.now() });
    }, failed).then(stop => { if (run.cancelled) stop(); else run.stop = stop; }).catch(error => {
      this.persistence.log(`[computer-preview] capture unavailable: ${error instanceof Error ? error.message : String(error)}`);
      failed();
    });
  }
  private endCapture(id: string): void {
    const timer = this.captureRetries.get(id); if (timer) clearTimeout(timer); this.captureRetries.delete(id);
    const run = this.captures.get(id); this.captures.delete(id);
    if (run) { run.cancelled = true; try { run.stop?.(); } catch { /* The capture is isolated. */ } }
  }
  forget(id: string): void { this.endCapture(id); this.pending.delete(id); this.cache.delete(id); this.savedAt.delete(id); this.captureFailures.delete(id); }
  async stop(): Promise<void> {
    this.closed = true; for (const id of new Set([...this.captures.keys(), ...this.captureRetries.keys()])) this.endCapture(id);
    this.pending.clear(); await this.draining;
    for (const id of this.cache.keys()) this.persist(id, true);
    this.cache.clear(); this.listeners.clear(); this.savedAt.clear(); this.captureFailures.clear();
  }
}

/** Read-only, one-use grants; existing proxy/direct transports carry these sockets. */
export class ComputerPreviewServer {
  private server?: Server;
  private opening?: Promise<number>;
  private readonly grants = new Map<string, { sessionId: string; expires: number; direct: boolean }>();
  private readonly sockets = new Set<Socket>();
  private relayNextAt = 0;
  constructor(private readonly frames: ComputerPreviews) {}
  async open(sessionId: string, direct = false): Promise<{ port: number; token: string }> {
    const port = await (this.opening ??= new Promise<number>((resolve, reject) => {
      this.server = createServer(socket => this.accept(socket));
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => resolve((this.server!.address() as { port: number }).port));
    }).catch(error => { this.opening = undefined; throw error; }));
    for (const [token, grant] of this.grants) if (grant.expires < Date.now()) this.grants.delete(token);
    if (this.grants.size >= 128) this.grants.delete(this.grants.keys().next().value!);
    const token = randomBytes(32).toString("hex");
    this.grants.set(token, { sessionId, expires: Date.now() + 30_000, direct });
    return { port, token };
  }
  private accept(socket: Socket): void {
    if (this.sockets.size >= 32) { socket.destroy(); return; }
    this.sockets.add(socket);
    let line = "", id: string | undefined, last = "", waiting = false, nextAt = 0, direct = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe: (() => void) | undefined;
    socket.setTimeout(10_000, () => socket.destroy());
    const send = () => {
      if (!id || waiting || socket.destroyed || timer) return;
      const frame = direct ? this.frames.get(id) : this.frames.getRelay(id);
      if (!frame || frame.id === last) return;
      if (!direct && frame.bytes.length > 16_384) return;
      const delay = Math.max(nextAt, direct ? 0 : this.relayNextAt) - Date.now();
      if (delay > 0) { timer = setTimeout(() => { timer = undefined; send(); }, delay); return; }
      const bytes = encodePreviewFrame(frame);
      waiting = true; last = frame.id;
      // Charge twice the payload plus envelope/ack headroom: proxy.data and the
      // encrypted gateway envelope both use base64. One bounded initial burst.
      const cost = direct ? bytes.length : bytes.length * 2 + 512;
      nextAt = Date.now() + Math.max(direct ? 250 : 2000, Math.ceil(cost / (direct ? 96_000 : 4000) * 1000));
      if (!direct) this.relayNextAt = Date.now() + Math.ceil(cost / 6000 * 1000);
      socket.setTimeout(45_000);
      socket.write(bytes);
    };
    socket.on("data", chunk => {
      line += chunk.toString("utf8");
      if (line.length > 1024) { socket.destroy(); return; }
      let end: number;
      while ((end = line.indexOf("\n")) >= 0) {
        const command = line.slice(0, end); line = line.slice(end + 1);
        if (!id) {
          try {
            const hello = JSON.parse(command);
            const grant = this.grants.get(hello.token);
            if (!grant || grant.expires < Date.now()) { socket.destroy(); return; }
            this.grants.delete(hello.token); id = grant.sessionId;
            direct = hello.direct === true && grant.direct;
            last = typeof hello.after === "string" ? hello.after.slice(0, 64) : "";
            unsubscribe = this.frames.subscribe(id, send);
            socket.setTimeout(0); send();
          } catch { socket.destroy(); return; }
        } else if (command === "ack" && waiting) {
          waiting = false; socket.setTimeout(0); send();
        } else { socket.destroy(); return; }
      }
    });
    socket.on("error", () => socket.destroy());
    socket.on("close", () => { unsubscribe?.(); if (timer) clearTimeout(timer); this.sockets.delete(socket); });
  }
  stop(): void { for (const socket of this.sockets) socket.destroy(); this.grants.clear(); this.server?.close(); this.server = undefined; this.opening = undefined; }
}
