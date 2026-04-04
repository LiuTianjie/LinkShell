import type { QuickAction } from "../native/LiveActivity";

export type TerminalStatus = "thinking" | "outputting" | "waiting" | "idle";

interface ParseResult {
  status: TerminalStatus;
  lastLine: string;
  quickActions: QuickAction[];
}

// Patterns that indicate Claude is thinking/processing
const THINKING_PATTERNS = [
  /⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏/, // spinner characters
  /thinking/i,
  /Thinking\.\.\./,
  /⏳/,
];

// Patterns that indicate waiting for Y/N confirmation
const YN_PATTERNS = [
  /\(y\/n\)/i,
  /\[Y\/n\]/,
  /\[y\/N\]/,
  /\(yes\/no\)/i,
  /Do you want to proceed/i,
  /Are you sure/i,
  /Continue\?/i,
  /Proceed\?/i,
  /确认/,
  /是否继续/,
];

// Patterns that indicate waiting for general input
const INPUT_WAIT_PATTERNS = [
  /\$ $/,           // shell prompt
  /> $/,            // generic prompt
  /❯ $/,            // fancy prompt
  />>> $/,          // Python REPL
  /\.\.\. $/,       // continuation
];

// Strip ANSI escape codes
function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
}

export function parseTerminalOutput(rawChunks: string[]): ParseResult {
  // Take last few chunks for analysis
  const recentText = stripAnsi(rawChunks.slice(-10).join(""));
  const lines = recentText.split("\n").filter((l) => l.trim().length > 0);
  const lastLine = lines.length > 0 ? lines[lines.length - 1]!.trim() : "";
  const lastFewLines = lines.slice(-5).join("\n");

  const quickActions: QuickAction[] = [];
  let status: TerminalStatus = "idle";

  // Check for Y/N patterns first (highest priority for quick actions)
  for (const pattern of YN_PATTERNS) {
    if (pattern.test(lastFewLines)) {
      status = "waiting";
      quickActions.push(
        { label: "Yes", input: "y\n" },
        { label: "No", input: "n\n" },
      );
      return { status, lastLine: truncate(lastLine, 100), quickActions };
    }
  }

  // Check for thinking/spinner
  for (const pattern of THINKING_PATTERNS) {
    if (pattern.test(lastFewLines)) {
      status = "thinking";
      return { status, lastLine: truncate(lastLine, 100), quickActions };
    }
  }

  // Check for input prompt
  for (const pattern of INPUT_WAIT_PATTERNS) {
    if (pattern.test(lastLine)) {
      status = "waiting";
      return { status, lastLine: truncate(lastLine, 100), quickActions };
    }
  }

  // If we got recent output (within last chunk), it's outputting
  if (rawChunks.length > 0 && rawChunks[rawChunks.length - 1]!.length > 0) {
    status = "outputting";
  }

  return { status, lastLine: truncate(lastLine, 100), quickActions };
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + "…";
}

// Throttled parser that limits updates
export class ThrottledTerminalParser {
  private lastUpdate = 0;
  private pendingChunks: string[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private callback: (result: ParseResult) => void;
  private minInterval: number;

  constructor(callback: (result: ParseResult) => void, minIntervalMs = 1000) {
    this.callback = callback;
    this.minInterval = minIntervalMs;
  }

  push(chunk: string) {
    this.pendingChunks.push(chunk);
    if (this.pendingChunks.length > 100) {
      this.pendingChunks.splice(0, this.pendingChunks.length - 100);
    }

    const now = Date.now();
    if (now - this.lastUpdate >= this.minInterval) {
      this.flush();
    } else if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.flush();
      }, this.minInterval - (now - this.lastUpdate));
    }
  }

  private flush() {
    this.lastUpdate = Date.now();
    const result = parseTerminalOutput(this.pendingChunks);
    this.callback(result);
  }

  destroy() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
