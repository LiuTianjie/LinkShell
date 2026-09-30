import type { SessionSummary } from "@linkshell/wire";
import type { ClientActions } from "@linkshell/client-core";
import { router } from "expo-router";
import { Alert } from "react-native";
import { sessionTitle } from "@/lib/describe";
import { haptics } from "@/lib/haptics";
import { agentLook } from "@/theme/agents";

// Rename, archive and delete, the same from a session's menu and a list row.

type Actions = Pick<ClientActions, "archive" | "deleteSession">;

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
  Alert.alert(
    `删除「${sessionTitle(session)}」？`,
    native ? `${agent} 里的这段对话也会一起删除，无法恢复。` : "会从 LinkShell 里移除，无法恢复。",
    [
      { text: "取消", style: "cancel" },
      {
        text: "删除",
        style: "destructive",
        onPress: () => {
          void actions.deleteSession(session.id).then(
            () => {
              haptics.success();
              onDeleted?.();
            },
            (reason: unknown) => failed("没能删除", reason),
          );
        },
      },
    ],
  );
}
