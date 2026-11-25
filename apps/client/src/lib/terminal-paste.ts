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
 * Splits raw already-encoded terminal data (e.g. Ghostty bracketed paste output) into
 * 64 KiB chunks without stripping escape sequences or splitting UTF-16 surrogate pairs.
 */
export function chunkRawTerminalData(
  data: string,
  maxChunkLength = TERMINAL_PASTE_MAX_CHUNK_LENGTH,
): string[] {
  if (!data) return [];
  const limit = Math.max(16, maxChunkLength);
  if (data.length <= limit) return [data];
  const chunks: string[] = [];
  let offset = 0;
  while (offset < data.length) {
    let end = Math.min(data.length, offset + limit);
    if (end < data.length && /[\uD800-\uDBFF]/.test(data[end - 1]!)) {
      end -= 1;
    }
    // Keep a trailing bracketed-paste end sequence (`\x1b[201~`) intact in a single chunk.
    const bracketEnd = data.lastIndexOf("\x1b[201~");
    if (bracketEnd > offset && bracketEnd < end && end < bracketEnd + 6) {
      end = bracketEnd;
    }
    chunks.push(data.slice(offset, end));
    offset = end;
  }
  return chunks;
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
  return chunkRawTerminalData(sanitized, maxChunkLength);
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

const VT_INPUT_TO_KEY_NAME: Record<string, string> = {
  "\x7f": "backspace",
  "\b": "backspace",
  "\x1b[A": "up",
  "\x1bOA": "up",
  "\x1b[B": "down",
  "\x1bOB": "down",
  "\x1b[C": "right",
  "\x1bOC": "right",
  "\x1b[D": "left",
  "\x1bOD": "left",
  "\x1b[H": "home",
  "\x1bOH": "home",
  "\x1b[F": "end",
  "\x1bOF": "end",
  "\x1b[5~": "pageUp",
  "\x1b[6~": "pageDown",
};

/** Maps a raw VT sequence from `onInput` (e.g. keyboard backspace/arrows) to a logical Ghostty key name. */
export function terminalKeyNameFromInput(data: string): string | undefined {
  return VT_INPUT_TO_KEY_NAME[data];
}

/**
 * Encodes terminal keys and modifiers into VT sequences when either using
 * one-shot JS modifiers (ctrl / alt / cmd) or running on a fallback view.
 */
export function encodeTerminalKeySequence(
  name: string,
  modifiers: TerminalKeyModifiers & { cmd?: boolean } = {},
): string | undefined {
  const normalized = VT_INPUT_TO_KEY_NAME[name] ?? name;

  if (modifiers.cmd) {
    const lower = normalized.toLowerCase();
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

  const csiModifier =
    1 + (modifiers.shift ? 1 : 0) + (modifiers.alt ? 2 : 0) + (modifiers.ctrl ? 4 : 0);

  const csiCursorFinal: Record<string, string> = {
    up: "A",
    down: "B",
    right: "C",
    left: "D",
    home: "H",
    end: "F",
  };
  if (csiCursorFinal[normalized]) {
    const final = csiCursorFinal[normalized]!;
    return csiModifier > 1 ? `\x1b[1;${csiModifier}${final}` : `\x1b[${final}`;
  }

  const csiTildeCode: Record<string, number> = {
    pageUp: 5,
    pageDown: 6,
  };
  if (csiTildeCode[normalized] !== undefined) {
    const code = csiTildeCode[normalized]!;
    return csiModifier > 1 ? `\x1b[${code};${csiModifier}~` : `\x1b[${code}~`;
  }

  const special: Record<string, string> = {
    enter: modifiers.shift ? "\x1b[13;2u" : "\r",
    escape: "\x1b",
    tab: modifiers.shift ? "\x1b[Z" : "\t",
    backspace: "\x7f",
  };

  if (special[normalized]) {
    const seq = special[normalized]!;
    return modifiers.alt && !seq.startsWith("\x1b") ? `\x1b${seq}` : seq;
  }

  if (normalized.length === 1) {
    let ch = modifiers.shift ? normalized.toUpperCase() : normalized;
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
