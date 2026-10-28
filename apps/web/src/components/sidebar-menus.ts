import type { SessionSummary } from "@linkshell/wire";
import type { useDialogs } from "@/components/Dialogs";
import { titleOf } from "../live/common";
import { DESKTOP_LOCAL, desktopContextMenu, reportDesktopError, revealOnDesktop, type DesktopMenuItem, REVEAL_IN_FILES } from "../live/desktop";
import { sendDesktopCommand } from "../live/desktop-commands";
import type { Connection } from "../live/engine";
import { confirmAndDeleteSession } from "../live/session-actions";

// The sidebar's right-click menus, after Codex's (its groups, in its order), with what LinkShell
// can do: native menus at the pointer, in the Electron window only.

type Dialogs = ReturnType<typeof useDialogs>;
interface MenuContext { connection: Connection; dialogs: Dialogs; navigate: (view: string) => void; at?: { x: number; y: number } }

const separator: DesktopMenuItem = { type: "separator" };

/** Whether a directory is in a git repository, asked once per computer and directory. */
const gitDirectories = new Map<string, Promise<boolean>>();
function inGit(connection: Connection, cwd: string): Promise<boolean> {
  const key = `${connection.computer.key}\n${cwd}`;
  let known = gitDirectories.get(key);
  if (!known) {
    known = connection.store.getState().gitInfo(cwd).then((info) => !!info, () => false);
    gitDirectories.set(key, known);
  }
  // The menu doesn't wait long for it: without an answer, it leaves the worktree fork out.
  return Promise.race([known, new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 400))]);
}

const copy = (text: string) => navigator.clipboard.writeText(text);

export async function openSessionMenu(session: SessionSummary, { connection, dialogs, navigate, at }: MenuContext): Promise<void> {
  const actions = connection.store.getState();
  const online = actions.status === "online";
  const local = connection.computer.key === DESKTOP_LOCAL;
  const git = online && !session.worktree ? await inGit(connection, session.cwd) : false;
  const items: DesktopMenuItem[] = [
    { id: "rename", label: "重命名…", enabled: online },
    separator,
    {
      label: "分叉",
      enabled: online,
      submenu: [
        { id: "fork", label: session.worktree ? "在同一 worktree 中创建会话分支" : "创建会话分支" },
        ...(git ? [{ id: "fork-worktree", label: "在新 worktree 中创建会话分支" }] : []),
      ],
    },
    {
      label: "复制",
      submenu: [
        { id: "copy-title", label: "复制标题" },
        { id: "copy-cwd", label: "复制工作目录" },
        { id: "copy-id", label: "复制会话 ID" },
      ],
    },
    ...(local ? [separator, { id: "reveal", label: REVEAL_IN_FILES }] : []),
    separator,
    { id: "archive", label: "归档", enabled: online },
    separator,
    { id: "delete", label: "永久删除…", enabled: online && session.state !== "running" },
  ];
  const chosen = await desktopContextMenu(items, at);
  if (!chosen) return;
  try {
    switch (chosen) {
      case "rename": {
        const title = await dialogs.prompt("会话名称", titleOf(session));
        if (title !== null && title.trim()) await actions.rename(session.id, title.trim());
        return;
      }
      case "fork":
      case "fork-worktree": {
        const created = await actions.forkSession(session.id, { worktree: chosen === "fork-worktree" });
        navigate(created.id);
        return;
      }
      case "copy-title": return void (await copy(titleOf(session)));
      case "copy-cwd": return void (await copy(session.cwd));
      case "copy-id": return void (await copy(session.id));
      case "reveal": return void (await revealOnDesktop(session.cwd));
      case "archive": return void (await actions.archive(session.id, true));
      case "delete":
        if (await confirmAndDeleteSession(session, actions, dialogs)) navigate("home");
        return;
    }
  } catch (error) {
    reportDesktopError(error);
  }
}

export async function openProjectMenu(project: { key: string; name: string; sessions: SessionSummary[] }, { connection, dialogs, at }: MenuContext): Promise<void> {
  const actions = connection.store.getState();
  const online = actions.status === "online";
  const local = connection.computer.key === DESKTOP_LOCAL;
  const items: DesktopMenuItem[] = [
    { id: "new", label: "在此项目中新建会话", enabled: !!online },
    separator,
    ...(local ? [{ id: "reveal", label: REVEAL_IN_FILES }] : []),
    { id: "copy-path", label: "复制路径" },
    separator,
    { id: "archive-all", label: "归档全部会话…", enabled: online && project.sessions.length > 0 },
  ];
  const chosen = await desktopContextMenu(items, at);
  if (!chosen) return;
  try {
    switch (chosen) {
      case "new": return sendDesktopCommand({ command: "new-session", cwd: project.key });
      case "reveal": return void (await revealOnDesktop(project.key));
      case "copy-path": return void (await copy(project.key));
      case "archive-all": {
        const sessions = project.sessions.filter((session) => !session.archived);
        if (!(await dialogs.confirm(`归档「${project.name}」的 ${sessions.length} 个会话？之后可在已归档中找回。`))) return;
        for (const session of sessions) await actions.archive(session.id, true);
        return;
      }
    }
  } catch (error) {
    reportDesktopError(error);
  }
}
