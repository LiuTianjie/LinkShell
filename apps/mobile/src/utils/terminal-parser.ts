import type { QuickAction } from "../native/LiveActivity";

export type TerminalStatus = "thinking" | "outputting" | "waiting" | "idle" | "tool_use" | "error";

interface ParseResult {
  status: TerminalStatus;
  lastLine: string;
  contextLines: string;
  quickActions: QuickAction[];
  provider: "claude" | "codex" | "unknown";
}

// ── Claude Code patterns ──────────────────────────────────────────

const CLAUDE_THINKING_PATTERNS = [
  /⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏/,     // braille spinner
  /Thinking\.\.\./i,
  /thinking/i,
  /⏳/,
  /Claude is thinking/i,
  /\.\.\.\s*$/,                        // trailing dots (thinking indicator)
];

const CLAUDE_TOOL_USE_PATTERNS = [
  /Reading file/i,
  /Editing file/i,
  /Writing to/i,
  /Running:/i,
  /Searching/i,
  /Creating/i,
  /\$ .+/,                             // shell command being executed
  /─.*Tool.*─/i,                       // tool use separator
];

const CLAUDE_PERMISSION_PATTERNS = [
  /Allow once/i,
  /Allow always/i,
  /Deny/i,
  /Do you want to allow/i,
  /wants to (run|execute|read|write|edit|create|delete)/i,
  /\(y\/n\)/i,
  /\[Y\/n\]/i,
  /\[y\/N\]/i,
  /\(yes\/no\)/i,
  /bypass permissions/i,
];

const CLAUDE_WAITING_PATTERNS = [
  />\s*$/,                             // Claude prompt
  /❯\s*$/,                            // fancy prompt
  /\$\s*$/,                           // shell prompt
  /waiting for input/i,
  /Press Enter/i,
  /Type .* to continue/i,
];

const CLAUDE_ERROR_PATTERNS = [
  /Error:/i,
  /error\[/,                           // Rust-style errors
  /FAILED/,
  /panic:/i,
  /Traceback/i,
  /Exception:/i,
  /✗|✘|❌/,
];

// ── Codex patterns ────────────────────────────────────────────────

const CODEX_THINKING_PATTERNS = [
  /Thinking\.\.\./i,
  /Processing/i,
  /Generating/i,
];

const CODEX_APPROVAL_PATTERNS = [
  /approve|deny|skip/i,
  /\[a\]pprove/i,
  /\[d\]eny/i,
  /\[s\]kip/i,
  /sandbox execution/i,
];

// ── General patterns ──────────────────────────────────────────────

const GENERAL_YN_PATTERNS = [
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
  /Overwrite/i,
];

const GENERAL_INPUT_PATTERNS = [
  /\$ $/,
  /> $/,
  /❯ $/,
  />>> $/,
  /\.\.\. $/,
];

// ── Helpers ───────────────────────────────────────────────────────

function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[\x20-\x3f]*[0-9;]*[a-zA-Z]/g, "")
    .replace(/\x1b\][^\x07]*\x07/g, "")
    .replace(/\x1b\(B/g, "")
    .replace(/\x1b[=>]/g, "");
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + "…";
}

function detectProvider(text: string): "claude" | "codex" | "unknown" {
  if (/claude/i.test(text) || /anthropic/i.test(text)) return "claude";
  if (/codex/i.test(text) || /openai/i.test(text)) return "codex";
  return "unknown";
}

function testAny(patterns: RegExp[], text: string): boolean {
  return patterns.some((p) => p.test(text));
}

// ── Main parser ───────────────────────────────────────────────────

export function parseTerminalOutput(rawChunks: string[]): ParseResult {
  const recentText = stripAnsi(rawChunks.slice(-15).join(""));
  const lines = recentText.split("\n").filter((l) => l.trim().length > 0);
  const lastLine = lines.length > 0 ? lines[lines.length - 1]!.trim() : "";
  const lastFewLines = lines.slice(-8).join("\n");
  const provider = detectProvider(recentText);

  const quickActions: QuickAction[] = [];
  let status: TerminalStatus = "idle";
  let contextLines = "";

  // Helper: extract context lines for waiting states
  const buildContext = () => lines.slice(-5).filter((l) => l.length > 2 && !/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏\s]+$/.test(l)).map((l) => truncate(l, 80)).join("\n");

  // 1. Claude permission requests (highest priority — needs user action)
  if (testAny(CLAUDE_PERMISSION_PATTERNS, lastFewLines)) {
    status = "waiting";
    contextLines = buildContext();
    if (/Allow once/i.test(lastFewLines) || /bypass permissions/i.test(lastFewLines)) {
      quickActions.push(
        { label: "Allow", input: "y", needsInput: false },
        { label: "Deny", input: "n", needsInput: false },
      );
    } else {
      quickActions.push(
        { label: "Yes", input: "y\n", needsInput: false },
        { label: "No", input: "n\n", needsInput: false },
      );
    }
    return { status, lastLine: truncate(lastLine, 120), contextLines, quickActions, provider };
  }

  // 2. Codex approval requests
  if (testAny(CODEX_APPROVAL_PATTERNS, lastFewLines)) {
    status = "waiting";
    contextLines = buildContext();
    quickActions.push(
      { label: "Approve", input: "a", needsInput: false },
      { label: "Deny", input: "d", needsInput: false },
      { label: "Skip", input: "s", needsInput: false },
    );
    return { status, lastLine: truncate(lastLine, 120), contextLines, quickActions, provider };
  }

  // 3. General Y/N prompts
  if (testAny(GENERAL_YN_PATTERNS, lastFewLines)) {
    status = "waiting";
    contextLines = buildContext();
    quickActions.push(
      { label: "Yes", input: "y\n", needsInput: false },
      { label: "No", input: "n\n", needsInput: false },
    );
    return { status, lastLine: truncate(lastLine, 120), contextLines, quickActions, provider };
  }

  // 4. Error detection
  if (testAny(CLAUDE_ERROR_PATTERNS, lastFewLines)) {
    status = "error";
    contextLines = buildContext();
    quickActions.push(
      { label: "Ctrl+C", input: "\x03", needsInput: false },
    );
    return { status, lastLine: truncate(lastLine, 120), contextLines, quickActions, provider };
  }

  // 5. Tool use detection (Claude running tools)
  if (testAny(CLAUDE_TOOL_USE_PATTERNS, lastFewLines)) {
    status = "tool_use";
    return { status, lastLine: truncate(lastLine, 120), contextLines: "", quickActions, provider };
  }

  // 6. Thinking/processing
  const thinkingPatterns = provider === "codex"
    ? [...CODEX_THINKING_PATTERNS, ...CLAUDE_THINKING_PATTERNS]
    : CLAUDE_THINKING_PATTERNS;
  if (testAny(thinkingPatterns, lastFewLines)) {
    status = "thinking";
    return { status, lastLine: truncate(lastLine, 120), contextLines: "", quickActions, provider };
  }

  // 7. Waiting for input (shell prompt visible)
  if (testAny(GENERAL_INPUT_PATTERNS, lastLine) || testAny(CLAUDE_WAITING_PATTERNS, lastLine)) {
    status = "waiting";
    return { status, lastLine: truncate(lastLine, 120), contextLines: "", quickActions, provider };
  }

  // 8. Active output
  if (rawChunks.length > 0 && rawChunks[rawChunks.length - 1]!.length > 0) {
    status = "outputting";
  }

  return { status, lastLine: truncate(lastLine, 120), contextLines: "", quickActions, provider };
}

// ── Throttled parser ──────────────────────────────────────────────

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
