import type { ClientActions } from "@linkshell/client-core";
import type { SessionSummary } from "@linkshell/wire";
import type { useDialogs } from "@/components/Dialogs";
import { titleOf } from "./common";

type Dialogs = ReturnType<typeof useDialogs>;

/**
 * Deletes a session for good, after saying what goes with it: the agent's own record, and its
 * worktree when the session alone uses it (asking whether to keep the worktree when it holds
 * work: new commits or uncommitted changes). False when the person backed out.
 */
export async function confirmAndDeleteSession(session: SessionSummary, actions: ClientActions, dialogs: Dialogs): Promise<boolean> {
  let worktree: "keep" | "remove" | undefined;
  if (session.worktree) {
    const entries = await actions.listWorktrees();
    const entry = entries.find((candidate) => candidate.sessions.includes(session.id));
    if (entry && entry.sessions.length === 1 && (entry.dirty || entry.ahead > 0)) {
      const choice = await dialogs.choose(
        `删除「${titleOf(session)}」？worktree 还有${entry.ahead ? ` ${entry.ahead} 个新提交` : ""}${entry.dirty ? " 未提交改动" : ""}。Agent 原始会话记录也会删除。`,
        [
          { value: "keep", label: "保留 worktree" },
          { value: "remove", label: "一起删除改动与分支", destructive: true },
        ],
      );
      if (!choice) return false;
      worktree = choice as "keep" | "remove";
    } else if (!(await dialogs.confirm(`永久删除「${titleOf(session)}」？Agent 原始会话记录和此会话独占的干净 worktree 会一起删除。`))) {
      return false;
    }
  } else if (!(await dialogs.confirm(`永久删除「${titleOf(session)}」？Agent 原始会话记录也可能被删除。`))) {
    return false;
  }
  await actions.deleteSession(session.id, worktree);
  return true;
}
