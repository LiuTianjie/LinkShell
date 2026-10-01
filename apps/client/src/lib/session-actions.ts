import type { SessionSummary } from "@linkshell/wire";
import type { ClientActions } from "@linkshell/client-core";
import { router } from "expo-router";
import { Alert } from "react-native";
import { sessionTitle } from "@/lib/describe";
import { haptics } from "@/lib/haptics";
import { branchLabel } from "@/lib/worktree";
import { agentLook } from "@/theme/agents";

// Rename, archive and delete, the same from a session's menu and a list row.

type Actions = Pick<ClientActions, "archive" | "deleteSession" | "listWorktrees">;

function failed(title: string, reason: unknown) {
  haptics.error();
  Alert.alert(title, reason instanceof Error ? reason.message : String(reason));
}

export function renameSession(session: SessionSummary) {
  router.push({ pathname: "/rename", params: { id: session.id } });
}

export async function toggleArchived(session: SessionSummary, actions: Actions): Promise<boolean> {
  try {
    await actions.archive(session.id, !session.archived);
    haptics.success();
    return true;
  } catch (reason) {
    failed(session.archived ? "没能取消归档" : "没能归档", reason);
    return false;
  }
}

/** Where the agent keeps its own record, deleting removes it there too; says so. */
export function confirmDelete(session: SessionSummary, actions: Actions, onDeleted?: () => void) {
  const agent = agentLook(session.agent).name;
  const native = session.agent === "codex" || session.agent === "claude";
  const title = `删除「${sessionTitle(session)}」？`;
  const remove = (worktree?: "keep" | "remove") => {
    void actions.deleteSession(session.id, worktree).then(
      () => {
        haptics.success();
        onDeleted?.();
      },
      (reason: unknown) => failed("没能删除", reason),
    );
  };
  const plain = () =>
    Alert.alert(title, native ? `${agent} 里的这段对话也会一起删除，无法恢复。` : "会从 LinkShell 里移除，无法恢复。", [
      { text: "取消", style: "cancel" },
      { text: "删除", style: "destructive", onPress: () => remove() },
    ]);
  if (!session.worktree) {
    plain();
    return;
  }
  // The session has a worktree of its own: with work in it that exists nowhere
  // else, say what deleting would lose and let it be kept.
  void actions
    .listWorktrees()
    .then((worktrees) => worktrees.find((entry) => entry.sessions.includes(session.id)))
    .catch(() => undefined)
    .then((entry) => {
      if (!entry || entry.sessions.length > 1 || (!entry.dirty && entry.ahead === 0)) {
        plain();
        return;
      }
      const lost = [entry.ahead ? `${entry.ahead} 个提交` : null, entry.dirty ? "未提交的改动" : null].filter(Boolean).join(" / ");
      Alert.alert(title, `它在 worktree「${branchLabel(entry.branch, 40)}」里工作，里面还有${lost.replace(" / ", "和")}。`, [
        { text: "取消", style: "cancel" },
        { text: "保留 worktree（改动还在）", onPress: () => remove("keep") },
        { text: `一起删除（丢弃${entry.ahead ? " " : ""}${lost}）`, style: "destructive", onPress: () => remove("remove") },
      ]);
    });
}
