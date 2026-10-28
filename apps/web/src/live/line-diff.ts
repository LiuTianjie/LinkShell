// The diff lives in client-core, so a folded run's "+N −M" counts the lines its opened diffs show.
export { diffLines, diffStat, hunks, parsePatch, type DiffHunk, type DiffLine } from "@linkshell/client-core";
