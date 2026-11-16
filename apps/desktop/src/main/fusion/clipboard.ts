import { createHash } from "node:crypto";
import type { FusionMessage } from "./wire.js";

/** As packages/wire's FUSION_MAX_CLIPBOARD: text and picture together, before base64. */
export const MAX_CLIPBOARD_BYTES = 8 << 20;

/** What is on the clipboard now; the picture is read only when it is needed. */
export interface ClipboardSnapshot {
  text: string;
  /** The formats there: cheap to read, and different when what was copied is of another kind. */
  types: string;
  /** Marked by a password manager as not for clipboard watchers. */
  concealed: boolean;
  png(): Promise<Buffer | undefined>;
}

/** The system clipboard, as much of it as is shared: text and one picture. */
export interface ClipboardPort {
  read(): Promise<ClipboardSnapshot>;
  write(clip: { text?: string; png?: Buffer }): Promise<void>;
}

/**
 * The local half of the shared clipboard where there is no change counter to poll (Electron): what
 * is on the clipboard is looked at when one of the remote's windows takes focus, and cheaply
 * (text and formats) while one keeps it. Each copy goes once, and what the remote sent is not
 * sent back. Shared from the first focus on, as on a Mac.
 */
export class FusionClipboard {
  private armed = false;
  private glance = "";
  private sent = "";
  private work: Promise<void> = Promise.resolve();
  private waiting = 0;

  constructor(private readonly port: ClipboardPort, private readonly send: (message: FusionMessage) => void) {}

  /** One of the remote's windows took focus. */
  focused(): Promise<void> {
    this.armed = true;
    return this.run(() => this.offer(true));
  }

  /** Still in one of them: only what is cheap to read says whether to look closer. */
  tick(): Promise<void> {
    // A slow clipboard is not asked again before it has answered.
    if (!this.armed || this.waiting > 0) return this.work;
    return this.run(() => this.offer(false));
  }

  /** The remote copied something. */
  received(m: FusionMessage): Promise<void> {
    if (!this.armed) return this.work;
    const text = typeof m.text === "string" && m.text ? m.text : undefined;
    const png = typeof m.png === "string" && m.png ? Buffer.from(m.png, "base64") : undefined;
    if (!text && !png) return this.work;
    if (Buffer.byteLength(text ?? "") + (png?.length ?? 0) > MAX_CLIPBOARD_BYTES) return this.work;
    return this.run(async () => {
      await this.port.write({ ...(text ? { text } : {}), ...(png ? { png } : {}) });
      // As the clipboard gives it back, which is what the next look compares with.
      const now = await this.port.read();
      this.glance = `${now.types}\n${now.text}`;
      this.sent = digestOf(now.text, await now.png());
    });
  }

  /** One at a time, in order: a look must not see half of a write. */
  private run(step: () => Promise<void>): Promise<void> {
    this.waiting += 1;
    // Another program holding the clipboard fails a step; the next focus or copy looks again.
    this.work = this.work.then(step).catch(() => undefined).finally(() => { this.waiting -= 1; });
    return this.work;
  }

  private async offer(look: boolean): Promise<void> {
    const now = await this.port.read();
    const glance = `${now.types}\n${now.text}`;
    if (!look && glance === this.glance) return;
    this.glance = glance;
    if (now.concealed) return;
    const png = await now.png();
    const digest = digestOf(now.text, png);
    if (digest === this.sent || (!now.text && !png)) return;
    this.sent = digest;
    const size = Buffer.byteLength(now.text);
    if (size > MAX_CLIPBOARD_BYTES) return;
    const picture = png && size + png.length <= MAX_CLIPBOARD_BYTES ? png : undefined;
    if (!now.text && !picture) return;
    this.send({ t: "clip", ...(now.text ? { text: now.text } : {}), ...(picture ? { png: picture.toString("base64") } : {}) });
  }
}

function digestOf(text: string, png: Buffer | undefined): string {
  const hash = createHash("sha1").update(text).update("\0");
  if (png) hash.update(png);
  return hash.digest("hex");
}
