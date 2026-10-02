import type { SessionSummary, TerminalInfo } from "@linkshell/wire";
import { agentLook } from "@/theme/agents";
import { plainPreview, sessionTitle } from "./describe";

// Searching the home page: sessions and terminals are found by what their rows say.

/** The words of a search, lower-cased. Something is found when every one of them is in it somewhere. */
export function searchWords(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

function found(words: string[], texts: (string | undefined)[]): boolean {
  const text = texts.filter(Boolean).join("\n").toLowerCase();
  return words.every((word) => text.includes(word));
}

/**
 * By its title, the last thing said in it, its project (the whole path, so a
 * folder above it finds it too), the branch it works on and its agent.
 */
export function sessionMatches(session: SessionSummary, words: string[]): boolean {
  return found(words, [
    sessionTitle(session),
    session.preview && plainPreview(session.preview),
    // A session in a worktree belongs to the project the worktree was made from.
    session.worktree?.source ?? session.cwd,
    session.worktree?.branch,
    agentLook(session.agent).name,
  ]);
}

/** By the command it was started with, what runs in it now, and its directory. */
export function terminalMatches(terminal: TerminalInfo, words: string[]): boolean {
  return found(words, [terminal.command, terminal.title, terminal.cwd, "终端"]);
}
