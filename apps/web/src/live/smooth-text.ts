import { useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * A streaming reply arrives in bursts: a network chunk is often hundreds of characters, then
 * nothing for a while. Shown as it arrives, the text jumps. This releases it at a rate that
 * follows the backlog (Codex's buffer, read from its desktop app): every 50 ms step the rate
 * moves halfway toward 1.5× the backlog when it is small and 1/1.2 of it when it is large, so a
 * burst drains smoothly over the next frames and a long one speeds up instead of lagging.
 * Times are in seconds.
 */
export class SmoothRelease {
  private rate = 1;
  private shown: number;
  private target: number;
  private lastArrival?: number;
  private lastDrain?: number;
  private carry = 0;

  /** `floor`: the shortest gap an arrival rate is measured over (Codex's default, 10 s). */
  constructor(length: number, private readonly floor = 10) { this.shown = length; this.target = length; }

  get length() { return this.shown; }
  get pending() { return this.shown < this.target; }

  /** The text is now `length` long. A shorter text is a new reply: it shows as it is. */
  arrive(length: number, now: number): void {
    if (length < this.target) { this.reset(length); return; }
    const added = length - this.target;
    this.target = length;
    if (added <= 0) return;
    this.rate = this.lastArrival === undefined ? added : Math.max(1, 0.1 * (added / Math.max(now - this.lastArrival, this.floor)) + 0.9 * this.rate);
    this.lastArrival = now;
  }

  /** What has been released by `now`. */
  drain(now: number): number {
    const elapsed = this.lastDrain === undefined ? 0 : now - this.lastDrain;
    this.lastDrain = now;
    const backlog = this.target - this.shown;
    for (let step = 0; step < (elapsed + this.carry) / 0.05; step++) {
      if (backlog && backlog < this.rate * 1.5) this.rate = (backlog + this.rate * 1.5) / 2;
      if (backlog > this.rate / 1.2) this.rate = (backlog + this.rate / 1.2) / 2;
    }
    this.rate = Math.max(1, this.rate);
    const amount = elapsed * this.rate + this.carry;
    const whole = Math.floor(amount);
    this.carry = amount - whole;
    if (whole >= 1) this.shown = Math.min(this.shown + whole, this.target);
    if (this.shown === this.target) { this.lastDrain = undefined; this.carry = 0; }
    return this.shown;
  }

  /** Everything at once (the reply ended, or no one is watching). */
  flush(): number { this.shown = this.target; this.lastDrain = undefined; this.carry = 0; return this.shown; }

  private reset(length: number): void {
    this.rate = 1; this.carry = 0; this.lastArrival = undefined; this.lastDrain = undefined;
    this.target = length; this.shown = length;
  }
}

/** Never cut inside a surrogate pair. */
function safeEnd(text: string, end: number): number {
  if (end <= 0 || end >= text.length) return Math.max(0, Math.min(end, text.length));
  const code = text.charCodeAt(end);
  return code >= 0xdc00 && code <= 0xdfff ? end + 1 : end;
}

const seconds = () => performance.now() / 1000;

/**
 * The text to draw for a reply: released smoothly while it streams, whole once it ends. Text
 * already there when it mounts (history, a reopened session) shows at once. While the window
 * is hidden nothing is drawn, so it is all there when it shows again.
 */
export function useSmoothText(text: string, streaming: boolean): string {
  const release = useRef<SmoothRelease>(null);
  release.current ??= new SmoothRelease(text.length);
  const [, publish] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const frame = useRef(0);
  const wasStreaming = useRef(streaming);

  useLayoutEffect(() => {
    const buffer = release.current!;
    const resuming = streaming && !wasStreaming.current;
    wasStreaming.current = streaming;
    buffer.arrive(text.length, seconds());
    if (!streaming || document.hidden || resuming) {
      const before = buffer.length;
      buffer.flush();
      clearTimeout(timer.current);
      timer.current = undefined;
      cancelAnimationFrame(frame.current);
      frame.current = 0;
      // A reconnect replaces cached text with a snapshot before paint, even if the
      // remote turn is still running. Only subsequent live chunks are smoothed.
      if (streaming && buffer.length !== before) publish((value) => value + 1);
      return;
    }
    const tick = () => {
      timer.current = undefined;
      const before = buffer.length;
      const after = document.hidden ? buffer.flush() : buffer.drain(seconds());
      if (after !== before && !frame.current) frame.current = requestAnimationFrame(() => { frame.current = 0; publish((value) => value + 1); });
      if (buffer.pending) timer.current = setTimeout(tick, 50);
    };
    if (timer.current === undefined) tick();
  }, [text, streaming]);

  useEffect(() => () => { clearTimeout(timer.current); cancelAnimationFrame(frame.current); }, []);

  if (!streaming) return text;
  return text.slice(0, safeEnd(text, release.current.length));
}

/**
 * Markdown split where a new top-level block starts (a blank line outside a fence), so blocks
 * that are finished keep their rendering and only the last one is parsed again as it grows.
 */
export function markdownBlocks(text: string): string[] {
  // Reference links and footnotes are defined anywhere and used anywhere: never split those.
  if (/^ {0,3}\[[^\]]+\]:/m.test(text)) return [text];
  const lines = text.split("\n");
  const blocks: string[] = [];
  let current: string[] = [];
  let fence: { char: string; length: number } | undefined;
  // Lists, quotes, tables and indented code can span blank lines; a split there would change them.
  const joined = (line: string | undefined) => !!line && /^(\s{2,}|\t|\s{0,3}([-*+]|\d{1,9}[.)])(\s|$)|\s{0,3}>|\s*\|)/.test(line);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = { char: marker[0]!, length: marker.length };
      else if (marker[0] === fence.char && marker.length >= fence.length && /^ {0,3}[`~]+\s*$/.test(line)) fence = undefined;
    }
    current.push(line);
    if (fence || line.trim() !== "" || index === lines.length - 1) continue;
    const before = [...current].reverse().find((one) => one.trim() !== "");
    const after = lines.slice(index + 1).find((one) => one.trim() !== "");
    if (!before || !after || joined(before) || joined(after)) continue;
    blocks.push(current.join("\n") + "\n");
    current = [];
  }
  if (current.length) blocks.push(current.join("\n"));
  return blocks.filter((block) => block !== "");
}
