import { PreviewFrameDecoder, type PreviewFrame } from "@linkshell/wire";
import type { HostLink } from "./host-link.js";
import type { HostStream, HostStreams } from "./streams.js";

/** An independent bulk subscription. Closing it never closes the agent session. */
export class ComputerPreviewSubscription {
  private stream?: HostStream;
  private generation = 0;
  private stopped = false;
  private retry?: ReturnType<typeof setTimeout>;
  private readonly remove: (() => void)[];
  private last?: string;
  constructor(private readonly link: HostLink, private readonly streams: HostStreams, private readonly sessionId: string, private readonly onFrame: (frame: PreviewFrame) => void, after?: string) {
    this.last = after;
    this.remove = [
      link.onStatus(status => { if (status === "online") this.open(); else this.drop(); }),
      streams.onPath(path => { if (path === "direct" && !this.stream?.direct) this.open(); }),
    ];
    if (link.status === "online") this.open();
  }
  private drop(): void {
    this.generation++;
    if (this.retry) clearTimeout(this.retry);
    this.retry = undefined;
    const stream = this.stream; this.stream = undefined; stream?.close();
  }
  private open(): void {
    if (this.stopped || this.link.status !== "online") return;
    this.drop();
    const generation = this.generation;
    const decoder = new PreviewFrameDecoder();
    const lost = () => {
      if (this.stopped || generation !== this.generation) return;
      this.drop();
      this.retry = setTimeout(() => this.open(), 3000);
    };
    void this.link.call("sessions.preview", { sessionId: this.sessionId, direct: this.streams.path === "direct" }).then(async grant => {
      if (this.stopped || generation !== this.generation) return;
      const stream = await this.streams.open(grant.port, {
        data: bytes => {
          if (this.stopped || generation !== this.generation) return;
          try {
            for (const frame of decoder.push(bytes)) {
              this.last = frame.id; this.onFrame(frame);
              this.stream?.write(new TextEncoder().encode("ack\n"));
            }
          } catch { lost(); }
        },
        closed: lost,
      });
      if (this.stopped || generation !== this.generation) { stream.close(); return; }
      this.stream = stream;
      stream.write(new TextEncoder().encode(JSON.stringify({ token: grant.token, after: this.last, direct: stream.direct }) + "\n"));
    }).catch(error => {
      // An older host has no preview endpoint. Revisit it on the next connection.
      if (error?.code !== -32601) lost();
    });
  }
  close(): void { this.stopped = true; this.drop(); for (const remove of this.remove) remove(); }
}
