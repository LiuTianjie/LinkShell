// Agents run commands through a login shell (`/bin/zsh -lc '<script>'`) and
// report that whole line. Both the host and clients show the script alone.

/**
 * Reads one POSIX shell word starting at `from`: any mix of '…', "…" and bare
 * characters, as the shell would join them. Returns the word and where it
 * ended, or undefined for an unterminated quote.
 */
function readWord(text: string, from: number): { word: string; end: number } | undefined {
  let word = "";
  let i = from;
  while (i < text.length && !/\s/.test(text[i]!)) {
    const ch = text[i]!;
    if (ch === "'") {
      const close = text.indexOf("'", i + 1);
      if (close < 0) return undefined;
      word += text.slice(i + 1, close);
      i = close + 1;
    } else if (ch === '"') {
      i += 1;
      for (;;) {
        if (i >= text.length) return undefined;
        const c = text[i]!;
        if (c === '"') break;
        if (c === "\\" && i + 1 < text.length && '"\\$`\n'.includes(text[i + 1]!)) {
          if (text[i + 1] !== "\n") word += text[i + 1];
          i += 2;
        } else {
          word += c;
          i += 1;
        }
      }
      i += 1;
    } else if (ch === "\\" && i + 1 < text.length) {
      word += text[i + 1];
      i += 2;
    } else {
      word += ch;
      i += 1;
    }
  }
  return { word, end: i };
}

/** `/bin/zsh -lc 'npm test'` → `npm test`. Anything else comes back unchanged. */
export function unwrapShellCommand(command: string): string {
  const text = command.trim();
  const prefix = /^(?:\/\S*\/)?(?:ba|z|da|k)?sh\s+-l?c\s+/.exec(text);
  if (!prefix) return command;
  const read = readWord(text, prefix[0].length);
  if (!read || text.slice(read.end).trim()) return command;
  return read.word.trim() || command;
}
