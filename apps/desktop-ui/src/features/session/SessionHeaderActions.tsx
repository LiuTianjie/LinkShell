import { useEffect, useMemo, useState } from "react";
import { emptyView, userMessageText } from "@linkshell/client-core";
import type { GitInfo } from "@linkshell/wire";
import {
  confirmAndDeleteSession,
  reportDesktopError,
  resolveTargetPlatform,
  revealInFilesLabel,
  routerStore,
  sessionTitle,
  useActiveDesktopPlatform,
  useI18n,
  useT,
  type SessionActionDialogs,
} from "@/core";
import { DesktopIcon } from "@/icons";
import {
  Badge,
  Button,
  IconButton,
  Menu,
  MenuItem,
  MenuSeparator,
  Popover,
  PopoverContent,
  PopoverTrigger,
  useDialogs,
  usePopoverClose,
} from "@/primitives";
import {
  isLocalDesktopConnection,
  sessionKeyOf,
  sessionUiStore,
  useClientSelector,
  useSessionConnection,
  useSessionCopy,
} from "./session-helpers";

type OutlineFilter = "all" | "questions" | "approvals" | "errors";

interface OutlineEntry {
  id: string;
  kind: "question" | "approval" | "error";
  label: string;
}

export interface SessionHeaderActionsProps {
  computerKey: string;
  sessionId: string;
}

export function SessionHeaderActions({
  computerKey,
  sessionId,
}: SessionHeaderActionsProps) {
  const t = useT();
  const { locale } = useI18n();
  const activePlatform = useActiveDesktopPlatform();
  const copy = useSessionCopy();
  const dialogs = useDialogs();
  const connection = useSessionConnection(computerKey);
  const sessionKey = sessionKeyOf(computerKey, sessionId);

  const online = useClientSelector(connection, (s) => s.status === "online", false);
  const machinePlatform = useClientSelector(
    connection,
    (s) => s.machine?.platform,
    connection?.computer.machine.platform,
  );
  const session = useClientSelector(
    connection,
    (s) => s.sessions[sessionId],
    undefined,
  );
  const view = useClientSelector(
    connection,
    (s) => s.views[sessionId],
    undefined,
  );

  const [gitInfo, setGitInfo] = useState<GitInfo | undefined>();
  useEffect(() => {
    if (!connection || !online || !session?.cwd) {
      setGitInfo(undefined);
      return;
    }
    let alive = true;
    void connection.store
      .getState()
      .gitInfo(session.cwd)
      .then((info) => {
        if (alive) setGitInfo(info);
      })
      .catch(() => {
        if (alive) setGitInfo(undefined);
      });
    return () => {
      alive = false;
    };
  }, [connection, online, session?.cwd]);

  const [outlineFilter, setOutlineFilter] = useState<OutlineFilter>("all");

  const safeView = view ?? emptyView(sessionId);
  const outlineEntries = useMemo<OutlineEntry[]>(() => {
    const list: OutlineEntry[] = [];
    for (const item of safeView.items) {
      if (item.kind === "user") {
        const text = userMessageText(item.blocks).trim();
        if (text) {
          list.push({
            id: item.id,
            kind: "question",
            label: text.slice(0, 90),
          });
        }
      } else if (item.kind === "permission-result") {
        list.push({
          id: item.id,
          kind: "approval",
          label: item.title,
        });
      } else if (item.kind === "error") {
        list.push({
          id: item.id,
          kind: "error",
          label: item.message,
        });
      }
    }
    for (const perm of safeView.permissions) {
      list.push({
        id: perm.requestId,
        kind: perm.questions?.length ? "question" : "approval",
        label: perm.title,
      });
    }
    return list;
  }, [safeView.items, safeView.permissions]);

  const filteredOutline = useMemo(() => {
    if (outlineFilter === "all") return outlineEntries;
    if (outlineFilter === "questions") {
      return outlineEntries.filter((e) => e.kind === "question");
    }
    if (outlineFilter === "approvals") {
      return outlineEntries.filter((e) => e.kind === "approval");
    }
    return outlineEntries.filter((e) => e.kind === "error");
  }, [outlineEntries, outlineFilter]);

  if (!connection || !session) {
    return <div className="ls-session-header-actions" />;
  }

  const isLocal = isLocalDesktopConnection(connection);
  const branchName = session.worktree?.branch ?? gitInfo?.branch;
  const driver = safeView.driver ?? session.driver;

  const openPathWith = async (
    app: "cursor" | "vscode" | "zed" | "reveal" | "terminal",
  ) => {
    try {
      await connection.link.call("desktop.openPath", {
        path: session.cwd,
        app,
      });
    } catch (error) {
      reportDesktopError(error);
    }
  };

  const copyClipboard = async (val: string) => {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      await navigator.clipboard.writeText(val);
    }
  };

  const handleRename = async () => {
    const next = await dialogs.prompt(
      t("desktop.menu.rename"),
      sessionTitle(session),
    );
    if (next !== null && next.trim()) {
      try {
        await connection.store.getState().rename(session.id, next.trim());
      } catch (error) {
        reportDesktopError(error);
      }
    }
  };

  const handleFork = async (inNewWorktree: boolean) => {
    try {
      const forked = await connection.store
        .getState()
        .forkSession(session.id, { worktree: inNewWorktree });
      routerStore.getState().openSession(computerKey, forked.id);
    } catch (error) {
      reportDesktopError(error);
    }
  };

  const handleDelete = async () => {
    const actionDialogs: SessionActionDialogs = {
      confirm: dialogs.confirm,
      prompt: (title, initialValue) => dialogs.prompt(title, initialValue),
      choose: <T extends string>(
        message: string,
        choices: { value: T; label: string; destructive?: boolean }[],
      ) => dialogs.choose(message, choices) as Promise<T | null>,
    };
    try {
      const deleted = await confirmAndDeleteSession(
        session,
        connection.store.getState(),
        actionDialogs,
        locale,
      );
      if (deleted) {
        routerStore.getState().navigate({ kind: "home" });
      }
    } catch (error) {
      reportDesktopError(error);
    }
  };

  return (
    <div className="ls-session-header-actions">
      {/* Handoff takeover action when session is driven by local desktop terminal */}
      {driver === "desktop" && (
        <Button
          variant="secondary"
          size="sm"
          disabled={!online}
          onClick={() => void connection.store.getState().takeover(session.id)}
        >
          {t("desktop.composer.takeover")}
        </Button>
      )}

      {/* Turn Outline Popover (`全部 | 提问 | 审批 | 报错`) */}
      <Popover>
        <PopoverTrigger>
          <button
            type="button"
            data-variant="ghost"
            data-size="icon-sm"
            className="ls-btn"
            aria-label={copy.turnOutlineLabel}
            title={copy.turnOutlineLabel}
          >
            <DesktopIcon name="list-checks" size="sm" />
          </button>
        </PopoverTrigger>
        <PopoverContent placement="bottom-end" className="ls-outline-popover">
          <OutlinePopoverBody
            filter={outlineFilter}
            onFilterChange={setOutlineFilter}
            entries={filteredOutline}
            sessionKey={sessionKey}
          />
        </PopoverContent>
      </Popover>

      {/* Session `•••` Overflow Menu */}
      <Menu
        placement="bottom-end"
        trigger={
          <IconButton
            icon="more-horizontal"
            size="icon-sm"
            label={copy.moreSessionActions}
            title={copy.moreSessionActions}
            hideTooltip
          />
        }
      >
        <MenuItem
          icon="edit"
          disabled={!online}
          onSelect={() => void handleRename()}
        >
          {t("desktop.menu.rename")}
        </MenuItem>
        <MenuSeparator />
        <MenuItem
          icon="session-fork"
          disabled={!online}
          onSelect={() => void handleFork(false)}
        >
          {t(
            session.worktree
              ? "desktop.menu.forkSameWorktree"
              : "desktop.menu.forkHere",
          )}
        </MenuItem>
        {Boolean(gitInfo) && !session.worktree && (
          <MenuItem
            icon="worktree"
            disabled={!online}
            onSelect={() => void handleFork(true)}
          >
            {t("desktop.menu.forkNewWorktree")}
          </MenuItem>
        )}
        <MenuSeparator />
        {driver === "remote" && (
          <>
            <MenuItem
              icon="terminal"
              disabled={!online}
              onSelect={() => void connection.store.getState().release(session.id)}
            >
              {t("desktop.composer.releaseToDesktop")}
            </MenuItem>
            <MenuSeparator />
          </>
        )}
        {isLocal && (
          <>
            <MenuItem icon="code" onSelect={() => void openPathWith("cursor")}>
              {copy.openInCursor}
            </MenuItem>
            <MenuItem icon="code" onSelect={() => void openPathWith("vscode")}>
              {copy.openInVsCode}
            </MenuItem>
            <MenuItem icon="code" onSelect={() => void openPathWith("zed")}>
              {copy.openInZed}
            </MenuItem>
            <MenuItem icon="folder-open" onSelect={() => void openPathWith("reveal")}>
              {revealInFilesLabel(
                locale,
                resolveTargetPlatform(machinePlatform, activePlatform),
              )}
            </MenuItem>
            <MenuItem icon="terminal" onSelect={() => void openPathWith("terminal")}>
              {copy.openInTerminal}
            </MenuItem>
            <MenuSeparator />
          </>
        )}
        <MenuItem
          icon="search"
          shortcut="Mod+F"
          onSelect={() => sessionUiStore.getState().toggleSearch(sessionKey)}
        >
          {copy.findInSession}
        </MenuItem>
        {branchName && (
          <MenuItem
            icon={session.worktree ? "worktree" : "git-branch"}
            onSelect={() => void copyClipboard(branchName)}
          >
            {copy.copyBranch}
          </MenuItem>
        )}
        <MenuItem
          icon="copy"
          onSelect={() => void copyClipboard(sessionTitle(session))}
        >
          {t("desktop.menu.copyTitle")}
        </MenuItem>
        <MenuItem
          icon="copy"
          onSelect={() => void copyClipboard(session.cwd)}
        >
          {t("desktop.menu.copyCwd")}
        </MenuItem>
        <MenuItem
          icon="copy"
          onSelect={() => void copyClipboard(session.id)}
        >
          {t("desktop.menu.copyId")}
        </MenuItem>
        <MenuSeparator />
        <MenuItem
          icon={session.archived ? "archive-restore" : "archive"}
          disabled={!online}
          onSelect={() =>
            void connection.store
              .getState()
              .archive(session.id, !session.archived)
          }
        >
          {t(session.archived ? "desktop.menu.unarchive" : "desktop.menu.archive")}
        </MenuItem>
        <MenuItem
          icon="trash"
          destructive
          disabled={!online || session.state === "running"}
          onSelect={() => void handleDelete()}
        >
          {t("desktop.menu.deletePermanent")}
        </MenuItem>
      </Menu>
    </div>
  );
}

function OutlinePopoverBody({
  filter,
  onFilterChange,
  entries,
  sessionKey,
}: {
  filter: OutlineFilter;
  onFilterChange: (next: OutlineFilter) => void;
  entries: readonly OutlineEntry[];
  sessionKey: string;
}) {
  const t = useT();
  const closePopover = usePopoverClose();

  const filters: { id: OutlineFilter; label: string }[] = [
    { id: "all", label: t("desktop.timeline.outlineAll") },
    { id: "questions", label: t("desktop.timeline.outlineQuestions") },
    { id: "approvals", label: t("desktop.timeline.outlineApprovals") },
    { id: "errors", label: t("desktop.timeline.outlineErrors") },
  ];

  return (
    <div>
      <div className="ls-outline-filters">
        {filters.map((f) => (
          <Button
            key={f.id}
            size="sm"
            variant={filter === f.id ? "secondary" : "ghost"}
            onClick={() => onFilterChange(f.id)}
          >
            {f.label}
          </Button>
        ))}
      </div>

      <div className="ls-outline-list">
        {entries.length === 0 ? (
          <div style={{ padding: 14, fontSize: 12, color: "var(--ls-fg-3)", textAlign: "center" }}>
            —
          </div>
        ) : (
          entries.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className="ls-outline-item"
              onClick={() => {
                sessionUiStore.getState().requestScrollToItem(sessionKey, entry.id);
                closePopover?.();
              }}
            >
              <Badge
                tone={
                  entry.kind === "error"
                    ? "danger"
                    : entry.kind === "approval"
                      ? "waiting"
                      : "neutral"
                }
              >
                {entry.kind === "error"
                  ? t("desktop.timeline.outlineErrors")
                  : entry.kind === "approval"
                    ? t("desktop.timeline.outlineApprovals")
                    : t("desktop.timeline.outlineQuestions")}
              </Badge>
              <span
                style={{
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {entry.label}
              </span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
