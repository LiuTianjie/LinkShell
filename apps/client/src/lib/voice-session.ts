export function mergeVoiceTranscript(prefix: string, transcript: string): string {
  const cleanPrefix = prefix.trimEnd();
  const cleanSpeech = transcript.trim();
  if (!cleanSpeech) return prefix;
  if (!cleanPrefix) return cleanSpeech;
  const needsSpace = /[a-zA-Z0-9]$/.test(cleanPrefix) && /^[a-zA-Z0-9]/.test(cleanSpeech);
  return `${cleanPrefix}${needsSpace ? " " : "，"}${cleanSpeech}`;
}

interface SpeechEvents {
  onResult: (event: { text: string; isFinal: boolean }) => void;
  onLevel: (event: { db: number; level: number }) => void;
  onError: (event: { message: string }) => void;
}

export interface SpeechTransport {
  available(): boolean;
  start(isCurrent: () => boolean): Promise<{ ok: boolean; reason?: string }>;
  stop(): Promise<{ text: string } | void>;
  cancel(): Promise<void>;
  subscribe(events: SpeechEvents): () => void;
}

export type VoicePhase = "idle" | "starting" | "recording" | "stopping";

/** Keep draft updates separate from the user's explicit request to send. */
export class VoiceSession {
  phase: VoicePhase = "idle";
  private generation = 0;
  private prefix = "";
  private transcript = "";
  private unsubscribe?: () => void;
  private starting?: Promise<boolean>;

  constructor(private transport: SpeechTransport, private events: {
    phase: (phase: VoicePhase) => void;
    text: (merged: string, transcript: string) => void;
    level: SpeechEvents["onLevel"];
    error: (message: string) => void;
    send: (text: string) => void;
  }) {}

  private setPhase(phase: VoicePhase) { this.phase = phase; this.events.phase(phase); }
  private close() {
    ++this.generation;
    this.unsubscribe?.(); this.unsubscribe = undefined;
    this.setPhase("idle");
  }
  private update(text: string) {
    this.transcript = text;
    this.events.text(mergeVoiceTranscript(this.prefix, text), text);
  }

  async start(prefix: string): Promise<boolean> {
    if (this.phase !== "idle" || this.starting) return false;
    if (!this.transport.available()) {
      this.events.error("当前版本未提供语音识别，请更新应用，或使用输入法的语音输入");
      return false;
    }
    this.prefix = prefix; this.transcript = "";
    const generation = ++this.generation;
    const current = () => generation === this.generation;
    this.setPhase("starting");
    this.unsubscribe = this.transport.subscribe({
      onResult: ({ text, isFinal }) => {
        if (!current()) return;
        this.update(text);
        if (isFinal && this.phase !== "stopping") {
          this.close();
          void this.transport.cancel().catch(() => {});
        }
      },
      onLevel: (event) => { if (current()) this.events.level(event); },
      onError: ({ message }) => {
        if (!current()) return;
        this.close();
        void this.transport.cancel().catch(() => {});
        this.events.error(message);
      },
    });
    this.starting = (async () => {
      try {
        const result = await this.transport.start(current);
        if (!current()) {
          await this.transport.cancel();
          return false;
        }
        if (!result.ok) {
          this.close();
          this.events.error(result.reason ?? "无法启动语音输入");
          return false;
        }
        this.setPhase("recording");
        return true;
      } catch (error) {
        if (current()) {
          this.close();
          this.events.error(error instanceof Error ? error.message : "无法启动语音输入");
        }
        await this.transport.cancel().catch(() => {});
        return false;
      }
    })();
    try { return await this.starting; } finally { this.starting = undefined; }
  }

  async stop(send = false): Promise<string | null> {
    if (this.phase === "starting") await this.starting;
    if (this.phase !== "recording") return null;
    const generation = this.generation;
    this.setPhase("stopping");
    try {
      const result = await this.transport.stop();
      if (generation !== this.generation) return null;
      if (result) this.update(result.text);
      const merged = mergeVoiceTranscript(this.prefix, this.transcript);
      const recognized = !!this.transcript.trim();
      this.close();
      if (send && recognized) this.events.send(merged);
      return merged;
    } catch (error) {
      if (generation === this.generation) {
        this.close();
        this.events.error(error instanceof Error ? error.message : "语音识别失败，请重试");
        await this.transport.cancel().catch(() => {});
      }
      return null;
    }
  }

  async cancel(restore = true) {
    if (this.phase === "idle" && !this.starting) return;
    this.close();
    if (restore) this.events.text(this.prefix, "");
    await this.transport.cancel().catch(() => {});
  }

  async appStateChanged(state: string) {
    // iOS permission prompts temporarily make the app inactive while start awaits
    // authorization. Entering the background still cancels that pending start.
    if (state === "active" || state === "inactive" && this.phase === "starting") return;
    await this.cancel(false);
  }
}
