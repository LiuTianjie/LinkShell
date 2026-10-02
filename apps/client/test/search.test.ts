import type { SessionSummary, TerminalInfo } from "@linkshell/wire";
import { describe, expect, it } from "vitest";
import { searchWords, sessionMatches, terminalMatches } from "@/lib/search";

const session = (fields: Partial<SessionSummary>): SessionSummary => ({
  id: "claude:1",
  agent: "claude",
  nativeId: "1",
  cwd: "/Users/me/code/linkshell",
  state: "idle",
  pendingPermissions: 0,
  createdAt: 0,
  updatedAt: 0,
  lastSeq: 0,
  archived: false,
  ...fields,
});
const terminal = (fields: Partial<TerminalInfo>): TerminalInfo => ({ id: "t1", cwd: "/Users/me/code/site", title: "zsh", cols: 80, rows: 24, createdAt: 0, activeAt: 0, ...fields });

const finds = (query: string, target: SessionSummary) => sessionMatches(target, searchWords(query));

describe("searching the home page", () => {
  it("splits a search into words, whatever the case and spacing", () => {
    expect(searchWords("  Fix   PAIR\thang ")).toEqual(["fix", "pair", "hang"]);
    expect(searchWords("   ")).toEqual([]);
  });

  it("finds a session by its title, in any case, and by part of a word", () => {
    const target = session({ title: "Fix linkshell pair hanging" });
    expect(finds("pair", target)).toBe(true);
    expect(finds("HANG", target)).toBe(true);
    expect(finds("unpair", target)).toBe(false);
  });

  it("finds a session by the last thing said in it, as the row shows it", () => {
    const target = session({ title: "配对", preview: "已经修好了 **`linkshell pair`**，见 [说明](https://example.com/notes)" });
    expect(finds("修好", target)).toBe(true);
    expect(finds("linkshell pair", target)).toBe(true);
    // What the preview hides (a link's address) isn't something the user saw.
    expect(finds("example.com", target)).toBe(false);
  });

  it("finds a session by its project, a folder above it, its branch and its agent", () => {
    const target = session({ agent: "codex", title: "重构", cwd: "/Users/me/.linkshell/worktrees/x1", worktree: { branch: "ls/refactor-store", source: "/Users/me/code/linkshell" } });
    expect(finds("linkshell", target)).toBe(true);
    expect(finds("code", target)).toBe(true);
    expect(finds("refactor-store", target)).toBe(true);
    expect(finds("Codex", target)).toBe(true);
    expect(finds("claude", target)).toBe(false);
    // The worktree's own directory is LinkShell's business, not the project's name.
    expect(finds("worktrees", target)).toBe(false);
  });

  it("needs every word, wherever each one is", () => {
    const target = session({ agent: "codex", title: "修复配对", cwd: "/Users/me/code/linkshell" });
    expect(finds("codex 配对", target)).toBe(true);
    expect(finds("linkshell 修复 codex", target)).toBe(true);
    expect(finds("codex 屏幕", target)).toBe(false);
  });

  it("finds a session nobody has named yet by the name the list gives it", () => {
    expect(finds("新会话", session({}))).toBe(true);
  });

  it("finds a terminal by its command, what runs in it, its directory, or for being one", () => {
    const target = terminal({ command: "pnpm dev", title: "node" });
    expect(terminalMatches(target, searchWords("pnpm"))).toBe(true);
    expect(terminalMatches(target, searchWords("node"))).toBe(true);
    expect(terminalMatches(target, searchWords("site"))).toBe(true);
    expect(terminalMatches(target, searchWords("终端"))).toBe(true);
    expect(terminalMatches(target, searchWords("vim"))).toBe(false);
  });
});
