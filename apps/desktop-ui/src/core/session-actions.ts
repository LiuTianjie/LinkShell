import type { ClientActions } from "@linkshell/client-core";
import type { SessionSummary } from "@linkshell/wire";
import { desktopInvoke, isElectronRuntime, showNativeContextMenu } from "../bridge/desktop-bridge";
import type { Connection } from "./connections";
import { getDesktopLocale, revealInFilesLabel, translateDesktop, type Locale } from "./i18n";
import { routerStore } from "./router-store";
import { sessionTitle } from "./session-tree";
import { DESKTOP_LOCAL, reportDesktopError } from "./storage";

export interface NativeMenuItem {
  id?: string;
  label?: string;
  type?: "separator";
  enabled?: boolean;
  checked?: boolean;
  accelerator?: string;
  submenu?: NativeMenuItem[];
}

export interface SessionActionDialogs {
  confirm(message: string, options?: { destructive?: boolean; confirmLabel?: string }): Promise<boolean>;
  prompt(title: string, initialValue?: string, submitLabel?: string): Promise<string | null>;
  choose<T extends string>(
    message: string,
    choices: { value: T; label: string; destructive?: boolean }[],
  ): Promise<T | null>;
}

const separator: NativeMenuItem = { type: "separator" };
const gitDirectories = new Map<string, Promise<boolean>>();

export function probeGitDirectory(connection: Connection, cwd: string): Promise<boolean> {
  const key = `${connection.computer.key}\n${cwd}`;
  let known = gitDirectories.get(key);
  if (!known) {
    known = connection.store
      .getState()
      .gitInfo(cwd)
      .then(
        (info) => Boolean(info),
        () => false,
      );
    gitDirectories.set(key, known);
  }
  return Promise.race([known, new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 400))]);
}

export function revealPathOnDesktop(path: string): Promise<unknown> {
  return desktopInvoke("reveal", { path }, 15_000);
}

/**
 * Turns an RPC failure into words the user can act on: known host codes get their own copy, anything
 * else keeps its message behind a localized prefix instead of surfacing raw English.
 */
export function describeActionError(error: unknown, locale: Locale = getDesktopLocale()): string {
  const data = (error as { data?: { code?: unknown } } | undefined)?.data;
  const appCode = typeof data?.code === "string" ? data.code : undefined;
  const rpcCode = (error as { code?: unknown } | undefined)?.code;
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (appCode === "wrong_password") return translateDesktop(locale, "desktop.shell.errWrongPassword");
  if (appCode === "busy") return translateDesktop(locale, "desktop.shell.errThrottled");
  if (appCode === "timeout") return translateDesktop(locale, "desktop.shell.errTimeout");
  if (appCode === "closed") return translateDesktop(locale, "desktop.shell.errDisconnected");
  if (rpcCode === -32601 || /method not found|no handler for|-32601/i.test(message)) {
    return translateDesktop(locale, "desktop.shell.errOutdated");
  }
  // Host messages are already Chinese; only foreign text needs the explanatory prefix.
  if (locale === "zh" && /[\u4e00-\u9fff]/.test(message)) return message;
  return translateDesktop(locale, "desktop.shell.errGeneric", { message });
}

export function reportActionError(error: unknown, locale?: Locale): void {
  reportDesktopError(describeActionError(error, locale));
}

/**
 * Confirms and deletes a session permanently, inspecting any exclusive dirty/ahead worktree first
 * so uncommitted work or unmerged commits are never lost accidentally. With `computerKey`, history
 * entries for the session go too, so back never lands on something that no longer exists.
 */
export async function confirmAndDeleteSession(
  session: SessionSummary,
  actions: ClientActions,
  dialogs: SessionActionDialogs,
  locale: Locale = getDesktopLocale(),
  computerKey?: string,
): Promise<boolean> {
  const title = sessionTitle(session);
  const tr = (key: Parameters<typeof translateDesktop>[1], params?: Record<string, string | number>) =>
    translateDesktop(locale, key, params);
  const confirmLabel = tr("desktop.menu.deletePermanent");
  let worktree: "keep" | "remove" | undefined;
  if (session.worktree) {
    const entries = await actions.listWorktrees();
    const entry = entries.find((candidate) => candidate.sessions.includes(session.id));
    if (entry && entry.sessions.length === 1 && (entry.dirty || entry.ahead > 0)) {
      const detail = [
        entry.ahead ? tr("desktop.shell.worktreeAhead", { count: entry.ahead }) : "",
        entry.dirty ? tr("desktop.shell.worktreeDirty") : "",
      ]
        .filter(Boolean)
        .join(tr("desktop.shell.listJoin"));
      const choice = await dialogs.choose<"keep" | "remove">(
        tr("desktop.shell.deleteConfirmWorktreeDirty", { title, detail }),
        [
          { value: "keep", label: tr("desktop.menu.keepWorktree") },
          { value: "remove", label: tr("desktop.menu.removeWorktree"), destructive: true },
        ],
      );
      if (!choice) return false;
      worktree = choice;
    } else if (
      !(await dialogs.confirm(tr("desktop.shell.deleteConfirmWorktree", { title }), {
        destructive: true,
        confirmLabel,
      }))
    ) {
      return false;
    }
  } else if (
    !(await dialogs.confirm(tr("desktop.shell.deleteConfirm", { title }), {
      destructive: true,
      confirmLabel,
    }))
  ) {
    return false;
  }
  await actions.deleteSession(session.id, worktree);
  if (computerKey) routerStore.getState().forgetSession(computerKey, session.id);
  return true;
}

export function buildSessionMenuItems(options: {
  session: SessionSummary;
  online: boolean;
  local: boolean;
  inGit: boolean;
  locale?: Locale;
}): NativeMenuItem[] {
  const { session, online, local, inGit, locale = getDesktopLocale() } = options;
  return [
    { id: "rename", label: translateDesktop(locale, "desktop.menu.rename"), enabled: online },
    separator,
    {
      label: translateDesktop(locale, "desktop.menu.fork"),
      enabled: online,
      submenu: [
        {
          id: "fork",
          label: translateDesktop(
            locale,
            session.worktree ? "desktop.menu.forkSameWorktree" : "desktop.menu.forkHere",
          ),
        },
        ...(inGit
          ? [{ id: "fork-worktree", label: translateDesktop(locale, "desktop.menu.forkNewWorktree") }]
          : []),
      ],
    },
    {
      label: translateDesktop(locale, "desktop.menu.copy"),
      submenu: [
        { id: "copy-title", label: translateDesktop(locale, "desktop.menu.copyTitle") },
        { id: "copy-cwd", label: translateDesktop(locale, "desktop.menu.copyCwd") },
        { id: "copy-id", label: translateDesktop(locale, "desktop.menu.copyId") },
      ],
    },
    ...(local ? [separator, { id: "reveal", label: revealInFilesLabel(locale) }] : []),
    separator,
    {
      id: session.archived ? "unarchive" : "archive",
      label: translateDesktop(locale, session.archived ? "desktop.menu.unarchive" : "desktop.menu.archive"),
      enabled: online,
    },
    separator,
    {
      id: "delete",
      label: translateDesktop(locale, "desktop.menu.deletePermanent"),
      enabled: online && session.state !== "running",
    },
  ];
}

export function buildProjectMenuItems(options: {
  hasLiveSessions: boolean;
  online: boolean;
  local: boolean;
  /** Generated groups (Codex chats) have no folder of their own to reveal or copy. */
  generated?: boolean;
  locale?: Locale;
}): NativeMenuItem[] {
  const { hasLiveSessions, online, local, generated = false, locale = getDesktopLocale() } = options;
  return [
    { id: "new", label: translateDesktop(locale, "desktop.menu.newInProject"), enabled: online },
    separator,
    ...(local && !generated ? [{ id: "reveal", label: revealInFilesLabel(locale) }] : []),
    ...(!generated
      ? [{ id: "copy-path", label: translateDesktop(locale, "desktop.menu.copyPath") }]
      : []),
    separator,
    {
      id: "archive-all",
      label: translateDesktop(locale, "desktop.menu.archiveAll"),
      enabled: online && hasLiveSessions,
    },
  ];
}

async function copyText(text: string): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.clipboard) {
    await navigator.clipboard.writeText(text);
  }
}

export function refreshConnectionProjects(connection: Connection | undefined): void {
  if (!connection) return;
  void connection.link
    .call("projects.list", { limit: 100 })
    .then(({ projects }) => {
      if (Array.isArray(projects)) {
        connection.store.setState({ projects });
      }
    })
    .catch(() => {
      // Best-effort refresh after archive/unarchive/delete so project counts stay fresh.
    });
}

export async function openSessionContextMenu(
  session: SessionSummary,
  context: {
    connection: Connection;
    dialogs: SessionActionDialogs;
    navigateSession: (sessionId: string) => void;
    at?: { x: number; y: number };
    locale?: Locale;
  },
): Promise<void> {
  if (!isElectronRuntime()) return;
  const actions = context.connection.store.getState();
  const online = actions.status === "online";
  const local = context.connection.computer.key === DESKTOP_LOCAL;
  const inGit = online && !session.worktree ? await probeGitDirectory(context.connection, session.cwd) : false;
  const items = buildSessionMenuItems({
    session,
    online,
    local,
    inGit,
    locale: context.locale,
  });
  const chosen = await showNativeContextMenu(items, context.at);
  if (!chosen) return;
  try {
    switch (chosen) {
      case "rename": {
        const locale = context.locale ?? getDesktopLocale();
        const nextTitle = await context.dialogs.prompt(
          translateDesktop(locale, "desktop.shell.renameSessionTitle"),
          sessionTitle(session),
          translateDesktop(locale, "desktop.shell.save"),
        );
        if (nextTitle !== null && nextTitle.trim()) {
          await actions.rename(session.id, nextTitle.trim());
        }
        return;
      }
      case "fork":
      case "fork-worktree": {
        const created = await actions.forkSession(session.id, { worktree: chosen === "fork-worktree" });
        context.navigateSession(created.id);
        return;
      }
      case "copy-title":
        await copyText(sessionTitle(session));
        return;
      case "copy-cwd":
        await copyText(session.cwd);
        return;
      case "copy-id":
        await copyText(session.id);
        return;
      case "reveal":
        await revealPathOnDesktop(session.cwd);
        return;
      case "archive":
        await actions.archive(session.id, true);
        refreshConnectionProjects(context.connection);
        return;
      case "unarchive":
        await actions.archive(session.id, false);
        refreshConnectionProjects(context.connection);
        return;
      case "delete":
        if (
          await confirmAndDeleteSession(
            session,
            actions,
            context.dialogs,
            context.locale,
            context.connection.computer.key,
          )
        ) {
          refreshConnectionProjects(context.connection);
        }
        return;
    }
  } catch (error) {
    reportActionError(error, context.locale);
  }
}

export async function openProjectContextMenu(
  project: { key: string; name: string; cwd?: string; generated?: boolean; sessions: SessionSummary[] },
  context: {
    connection: Connection;
    dialogs: SessionActionDialogs;
    openNewSession: (cwd: string) => void;
    at?: { x: number; y: number };
    locale?: Locale;
  },
): Promise<void> {
  if (!isElectronRuntime()) return;
  const actions = context.connection.store.getState();
  const online = actions.status === "online";
  const local = context.connection.computer.key === DESKTOP_LOCAL;
  const liveSessions = project.sessions.filter((session) => !session.archived);
  const generated = Boolean(project.generated);
  const projectPath = project.cwd || project.key;
  const locale = context.locale ?? getDesktopLocale();
  const items = buildProjectMenuItems({
    hasLiveSessions: liveSessions.length > 0,
    online,
    local,
    generated,
    locale,
  });
  const chosen = await showNativeContextMenu(items, context.at);
  if (!chosen) return;
  try {
    switch (chosen) {
      case "new":
        context.openNewSession(generated ? "" : projectPath);
        return;
      case "reveal":
        await revealPathOnDesktop(projectPath);
        return;
      case "copy-path":
        await copyText(projectPath);
        return;
      case "archive-all": {
        if (
          !(await context.dialogs.confirm(
            translateDesktop(locale, "desktop.shell.archiveAllConfirm", {
              name: project.name,
              count: liveSessions.length,
            }),
            { confirmLabel: translateDesktop(locale, "desktop.menu.archiveAll") },
          ))
        ) {
          return;
        }
        for (const session of liveSessions) {
          await actions.archive(session.id, true);
        }
        refreshConnectionProjects(context.connection);
        return;
      }
    }
  } catch (error) {
    reportActionError(error, locale);
  }
}
