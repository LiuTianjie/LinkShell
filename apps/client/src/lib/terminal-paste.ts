import type { TerminalKeyModifiers } from "../../modules/link-terminal/src";

export const TERMINAL_PASTE_MAX_CHUNK_LENGTH = 65_536;

/**
 * Strips C0 control characters (except \t, \n, \r) and normalizes CRLF to CR
 * so clipboard pastes cannot inject unexpected control codes into the PTY.
 */
export function sanitizeTerminalPasteText(text: string): string {
  if (!text) return "";
  return text
    .replace(/\r\n/g, "\r")
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

/**
 * Splits sanitized paste text into 64 KiB chunks without splitting UTF-16 surrogate pairs.
 */
export function chunkTerminalPasteText(
  text: string,
  maxChunkLength = TERMINAL_PASTE_MAX_CHUNK_LENGTH,
): string[] {
  const sanitized = sanitizeTerminalPasteText(text);
  if (!sanitized) return [];
  const limit = Math.max(16, maxChunkLength);
  const chunks: string[] = [];
  let offset = 0;
  while (offset < sanitized.length) {
    let end = Math.min(sanitized.length, offset + limit);
    if (end < sanitized.length && /[\uD800-\uDBFF]/.test(sanitized[end - 1]!)) {
      end -= 1;
    }
    chunks.push(sanitized.slice(offset, end));
    offset = end;
  }
  return chunks;
}

/**
 * Strips ANSI/VT escape sequences and resolves carriage-return overwrites so
 * recent terminal output can be cleanly attached or sent to an Agent session.
 */
export function cleanTerminalOutputForAgent(raw: string, maxLines = 80): string {
  if (!raw) return "";
  const withoutOsc = raw
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/\x1bP[\s\S]*?\x1b\\/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b[@-_]/g, "");

  const logicalLines: string[] = [];
  for (const rawLine of withoutOsc.split("\n")) {
    // Handle carriage-return progress-bar overwrites within a line
    const segments = rawLine.split("\r");
    let current = "";
    for (const seg of segments) {
      if (!seg) continue;
      current = seg + current.slice(seg.length);
    }
    // eslint-disable-next-line no-control-regex
    const cleaned = current.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "").trimEnd();
    logicalLines.push(cleaned);
  }

  while (logicalLines.length > 0 && logicalLines[logicalLines.length - 1] === "") {
    logicalLines.pop();
  }
  while (logicalLines.length > 0 && logicalLines[0] === "") {
    logicalLines.shift();
  }

  return logicalLines.slice(-maxLines).join("\n");
}

/**
 * Encodes terminal keys and modifiers into VT sequences when either using
 * one-shot JS modifiers (ctrl / alt / cmd) or running on a fallback view.
 */
export function encodeTerminalKeySequence(
  name: string,
  modifiers: TerminalKeyModifiers & { cmd?: boolean } = {},
): string | undefined {
  if (modifiers.cmd) {
    const lower = name.toLowerCase();
    if (lower === "k") return "\x0c"; // Cmd+K -> Clear screen (Ctrl+L)
    if (lower === "c") return "\x03"; // Cmd+C -> SIGINT
    if (lower === "d") return "\x04"; // Cmd+D -> EOF
    if (lower === "z") return "\x1a"; // Cmd+Z -> SIGTSTP
    if (lower === "a") return "\x01"; // Start of line
    if (lower === "e") return "\x05"; // End of line
    if (lower === "u") return "\x15"; // Kill line backward
    if (lower === "left") return "\x01";
    if (lower === "right") return "\x05";
    if (lower === "backspace") return "\x15";
  }

  const special: Record<string, string> = {
    enter: modifiers.shift ? "\x1b[13;2u" : "\r",
    escape: "\x1b",
    tab: modifiers.shift ? "\x1b[Z" : "\t",
    up: "\x1b[A",
    down: "\x1b[B",
    right: "\x1b[C",
    left: "\x1b[D",
    backspace: "\x7f",
    home: "\x1b[H",
    end: "\x1b[F",
    pageUp: "\x1b[5~",
    pageDown: "\x1b[6~",
  };

  if (special[name]) {
    const seq = special[name]!;
    return modifiers.alt && !seq.startsWith("\x1b") ? `\x1b${seq}` : seq;
  }

  if (name.length === 1) {
    let ch = modifiers.shift ? name.toUpperCase() : name;
    if (modifiers.ctrl) {
      const code = ch.toUpperCase().charCodeAt(0);
      if (code >= 64 && code <= 95) {
        ch = String.fromCharCode(code - 64);
      } else if (ch === " ") {
        ch = "\x00";
      }
    }
    return modifiers.alt ? `\x1b${ch}` : ch;
  }

  return undefined;
}
