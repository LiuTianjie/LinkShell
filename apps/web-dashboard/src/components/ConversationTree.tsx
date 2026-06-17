import { useMemo, useRef, useState } from "react";
import type { AgentConversation, AgentCapabilitiesPayload, AgentStatus } from "../lib/types";
import type { WorkspaceStore } from "../store/workspace-store";
import {
  IconDevice,
  IconFolder,
  IconChevronRight,
  IconChevronDown,
  IconPlus,
  IconDots,
  IconPencil,
  IconArchive,
  IconTrash,
  ProviderIcon,
} from "./icons";

// Tree: Device (host) → Folder (cwd) → Provider (Claude/Codex) → Conversation.
// Within one console we're on a single CLI device, so the device is the root
// label; conversations group by cwd, then provider.

interface FolderGroup {
  cwd: string;
  label: string;
  providers: Map<string, AgentConversation[]>; // provider → conversations
}

interface ProviderGroup {
  provider: string;
  conversations: AgentConversation[];
}

function folderLabel(cwd: string): string {
  if (!cwd || cwd === "—") return "(未知目录)";
  const parts = cwd.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || cwd;
}

function conversationPriority(c: AgentConversation, activeConversationId: string | null): number {
  if (c.status === "waiting_permission") return 0;
  if (c.status === "running") return 1;
  if (c.status === "error") return 2;
  if (c.id === activeConversationId) return 3;
  return 4;
}

function compareConversations(activeConversationId: string | null) {
  return (a: AgentConversation, b: AgentConversation) => {
    const priority = conversationPriority(a, activeConversationId) - conversationPriority(b, activeConversationId);
    if (priority !== 0) return priority;
    return b.lastActivityAt - a.lastActivityAt;
  };
}

function isActiveConversation(c: AgentConversation): boolean {
  return c.status === "waiting_permission" || c.status === "running" || c.status === "error";
}

function buildTree(conversations: AgentConversation[]): FolderGroup[] {
  const byFolder = new Map<string, FolderGroup>();
  for (const c of conversations) {
    const cwd = c.cwd || "—";
    let group = byFolder.get(cwd);
    if (!group) {
      group = { cwd, label: folderLabel(cwd), providers: new Map() };
      byFolder.set(cwd, group);
    }
    const list = group.providers.get(c.provider) ?? [];
    list.push(c);
    group.providers.set(c.provider, list);
  }
  // Sort conversations newest-first within each provider.
  for (const g of byFolder.values()) {
    for (const list of g.providers.values()) {
      list.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
    }
  }
  // Folders sorted by their most-recent activity (max lastActivityAt across all
  // their conversations), newest first — so a session touched seconds ago (by
  // ANY process, since lastActivityAt comes from the transcript's mtime, not
  // just LinkShell-driven turns) floats its folder to the top. Was alphabetical,
  // which buried recently-used work.
  const folderRecency = (g: FolderGroup): number => {
    let max = 0;
    for (const list of g.providers.values()) {
      for (const c of list) max = Math.max(max, c.lastActivityAt);
    }
    return max;
  };
  return [...byFolder.values()].sort((a, b) => folderRecency(b) - folderRecency(a));
}

function sortedProviders(folder: FolderGroup): ProviderGroup[] {
  return [...folder.providers.entries()]
    .map(([provider, conversations]) => ({ provider, conversations }))
    .sort((a, b) => providerLabel(a.provider).localeCompare(providerLabel(b.provider)));
}

function providerLabel(id: string): string {
  if (id === "claude") return "Claude";
  if (id === "codex") return "Codex";
  return id;
}

function statusBadge(status: AgentStatus): { text: string; className: string; pulsing?: boolean } {
  switch (status) {
    case "running":
      return { text: "运行中", className: "border-success/30 bg-success/10 text-success", pulsing: true };
    case "waiting_permission":
      return { text: "等待授权", className: "border-warning/40 bg-warning/10 text-warning", pulsing: true };
    case "error":
      return { text: "异常", className: "border-danger/30 bg-danger/10 text-danger" };
    case "unavailable":
      return { text: "不可用", className: "border-border bg-surface-overlay text-content-faint" };
    case "idle":
    default:
      return { text: "空闲", className: "border-border bg-surface-overlay text-content-muted" };
  }
}

export interface ConversationTreeProps {
  deviceLabel: string;
  conversations: AgentConversation[];
  capabilities: AgentCapabilitiesPayload | null;
  activeConversationId: string | null;
  externalAgentStatus?: AgentStatus | null;
  externalAgentTitle?: string | null;
  externalAgentProvider?: string | null;
  store: WorkspaceStore;
  onSelect: (conversationId: string) => void;
  onNewConversation: (provider: string, cwd?: string) => void;
  onOpenExternalTerminal?: () => void;
}

export function ConversationTree({
  deviceLabel,
  conversations,
  capabilities,
  activeConversationId,
  externalAgentStatus,
  externalAgentTitle,
  externalAgentProvider,
  store,
  onSelect,
  onNewConversation,
  onOpenExternalTerminal,
}: ConversationTreeProps) {
  const providers = capabilities?.providers ?? [];
  const enabledProviders = providers.filter((p) => p.enabled);

  // Archived conversations are hidden by default; the user can reveal them.
  const [showArchived, setShowArchived] = useState(false);
  const archivedCount = useMemo(
    () => conversations.filter((c) => c.archived).length,
    [conversations],
  );
  const visibleConversations = useMemo(
    () => (showArchived ? conversations : conversations.filter((c) => !c.archived)),
    [conversations, showArchived],
  );
  const activeConversations = useMemo(
    () => visibleConversations
      .filter(isActiveConversation)
      .sort(compareConversations(activeConversationId)),
    [visibleConversations, activeConversationId],
  );
  const hasExternalActive =
    externalAgentStatus === "running" ||
    externalAgentStatus === "waiting_permission" ||
    externalAgentStatus === "error";
  const hasActiveSection = hasExternalActive || activeConversations.length > 0;
  const tree = useMemo(() => buildTree(visibleConversations), [visibleConversations]);

  // All folders/providers expanded by default; collapse state tracked by key.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggle = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });

  // Per-row "⋯" menu + inline rename + two-step delete confirm.
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  // Set when Escape cancels a rename so the ensuing blur doesn't commit it.
  const skipBlur = useRef(false);

  const closeMenu = () => {
    setMenuOpenId(null);
    setConfirmDeleteId(null);
  };

  const startRename = (c: AgentConversation) => {
    closeMenu();
    setRenamingId(c.id);
    setRenameValue((c.title && c.title.trim()) || "");
  };
  const commitRename = (c: AgentConversation) => {
    store.renameConversation(c.id, renameValue);
    setRenamingId(null);
  };

  return (
    <div className="flex h-full flex-col">
      {/* Device root */}
      <div className="flex items-center gap-2.5 border-b border-border px-3 py-3">
        <IconDevice size={14} className="shrink-0 text-content-faint" />
        <span className="truncate font-mono text-[13px] font-semibold text-content-secondary">
          {deviceLabel}
        </span>
      </div>

      {/* New conversation buttons */}
      <div className="space-y-2 border-b border-border px-3 py-3">
        <p className="text-2xs font-semibold uppercase tracking-wider text-content-faint">
          新建对话
        </p>
        {enabledProviders.length === 0 ? (
          <span className="text-2xs text-content-faint">等待能力…</span>
        ) : (
          <div className="flex flex-wrap gap-2">
            {enabledProviders.map((p) => (
              <button
                key={p.id}
                onClick={() => onNewConversation(p.id)}
                className="codex-btn-outline text-2xs"
                aria-label={`新建 ${p.label} 对话`}
              >
                <ProviderIcon provider={p.id} size={13} /> {p.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {hasActiveSection && (
        <div className="border-b border-border px-3 py-3">
          <p className="mb-2 text-2xs font-semibold uppercase tracking-wider text-content-faint">
            活跃会话
          </p>
          <div className="space-y-1">
            {hasExternalActive && externalAgentStatus && (
              <button
                key="active:external-terminal"
                onClick={onOpenExternalTerminal}
                className="flex w-full cursor-pointer items-start gap-2 rounded-lg px-2 py-2 text-left transition-colors duration-150 hover:bg-surface-overlay"
                title="打开终端面板"
              >
                <ProviderIcon provider={externalAgentProvider ?? "custom"} size={14} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="truncate text-[13px] font-medium text-content-primary">
                      {externalAgentTitle ?? "外部终端"}
                    </span>
                    {(() => {
                      const status = statusBadge(externalAgentStatus);
                      return (
                        <span className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${status.className}`}>
                          {status.pulsing && (
                            <span className="h-1.5 w-1.5 rounded-full bg-current animate-pulse-dot" />
                          )}
                          {status.text}
                        </span>
                      );
                    })()}
                  </span>
                  <span className="mt-0.5 block truncate font-mono text-2xs text-content-muted">
                    {deviceLabel}
                  </span>
                </span>
              </button>
            )}
            {activeConversations.map((c) => {
              const name =
                (c.title && c.title.trim()) ||
                (c.lastMessagePreview && c.lastMessagePreview.trim().slice(0, 40)) ||
                `对话 ${c.id.slice(-6)}`;
              const status = statusBadge(c.status);
              return (
                <button
                  key={`active:${c.id}`}
                  onClick={() => onSelect(c.id)}
                  className={`flex w-full cursor-pointer items-start gap-2 rounded-lg px-2 py-2 text-left transition-colors duration-150 hover:bg-surface-overlay ${
                    c.id === activeConversationId ? "tree-row-active" : ""
                  }`}
                  title={c.cwd}
                >
                  <ProviderIcon provider={c.provider} size={14} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="truncate text-[13px] font-medium text-content-primary">
                        {name}
                      </span>
                      <span className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${status.className}`}>
                        {status.pulsing && (
                          <span className="h-1.5 w-1.5 rounded-full bg-current animate-pulse-dot" />
                        )}
                        {status.text}
                      </span>
                    </span>
                    <span className="mt-0.5 block truncate font-mono text-2xs text-content-muted">
                      {folderLabel(c.cwd)}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Tree */}
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {tree.length === 0 ? (
          <p className="px-3 py-2 text-2xs text-content-faint">
            {showArchived || archivedCount === 0 ? "还没有对话" : "没有未归档的对话"}
          </p>
        ) : (
          tree.map((folder) => {
            const fKey = `folder:${folder.cwd}`;
            const fCollapsed = collapsed.has(fKey);
            return (
              <div key={folder.cwd} className="py-1">
                <button
                  onClick={() => toggle(fKey)}
                  className="tree-row"
                  title={folder.cwd}
                >
                  {fCollapsed ? (
                    <IconChevronRight size={12} className="shrink-0 text-content-faint" />
                  ) : (
                    <IconChevronDown size={12} className="shrink-0 text-content-faint" />
                  )}
                  <IconFolder size={13} className="shrink-0 text-content-faint" />
                  <span className="truncate text-2xs font-semibold uppercase tracking-wider text-content-faint">
                    {folder.label}
                  </span>
                </button>
                {!fCollapsed &&
                  sortedProviders(folder).map(({ provider: prov, conversations: convs }) => {
                    const pKey = `prov:${folder.cwd}:${prov}`;
                    const pCollapsed = collapsed.has(pKey);
                    return (
                      <div key={prov} className="pl-3">
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => toggle(pKey)}
                            className="tree-row flex-1"
                          >
                            {pCollapsed ? (
                              <IconChevronRight size={12} className="shrink-0 text-content-faint" />
                            ) : (
                              <IconChevronDown size={12} className="shrink-0 text-content-faint" />
                            )}
                            <ProviderIcon provider={prov} size={13} />
                            <span className="text-[13px] font-medium text-content-secondary">
                              {providerLabel(prov)}
                            </span>
                            <span className="text-2xs text-content-faint">({convs.length})</span>
                          </button>
                          <button
                            onClick={() => onNewConversation(prov, folder.cwd === "—" ? undefined : folder.cwd)}
                            className="cursor-pointer rounded-lg p-1.5 text-content-faint transition-colors hover:bg-surface-overlay hover:text-accent"
                            title="在此目录新建对话"
                            aria-label="新建对话"
                          >
                            <IconPlus size={13} />
                          </button>
                        </div>
                        {!pCollapsed &&
                          convs.map((c) => {
                            // Prefer a real title; else the first message preview
                            // (ChatGPT-style); else a short id. Never blank.
                            const name =
                              (c.title && c.title.trim()) ||
                              (c.lastMessagePreview && c.lastMessagePreview.trim().slice(0, 40)) ||
                              `对话 ${c.id.slice(-6)}`;
                            const isRenaming = renamingId === c.id;
                            const isMenuOpen = menuOpenId === c.id;
                            const status = statusBadge(c.status);
                            return (
                            <div key={c.id} className="group relative">
                              {isRenaming ? (
                                <input
                                  autoFocus
                                  value={renameValue}
                                  onChange={(e) => setRenameValue(e.target.value)}
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter") {
                                      e.preventDefault();
                                      e.currentTarget.blur();
                                    } else if (e.key === "Escape") {
                                      skipBlur.current = true;
                                      e.currentTarget.blur();
                                    }
                                  }}
                                  onBlur={() => {
                                    if (skipBlur.current) {
                                      skipBlur.current = false;
                                      setRenamingId(null);
                                      return;
                                    }
                                    commitRename(c);
                                  }}
                                  placeholder="对话名称"
                                  className="block w-full rounded-lg border border-accent bg-surface py-2 pl-7 pr-3 text-[13px] text-content-primary outline-none"
                                />
                              ) : (
                                <button
                                  onClick={() => onSelect(c.id)}
                                  className={`block w-full cursor-pointer rounded-lg py-2 pl-7 pr-9 text-left transition-colors duration-150 hover:bg-surface-overlay ${
                                    c.id === activeConversationId ? "tree-row-active" : ""
                                  }`}
                                >
                                  <p className="flex items-center gap-2">
                                    <span className="truncate text-[13px] text-content-primary">
                                      {name}
                                    </span>
                                    <span className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${status.className}`}>
                                      {status.pulsing && (
                                        <span className="h-1.5 w-1.5 rounded-full bg-current animate-pulse-dot" />
                                      )}
                                      {status.text}
                                    </span>
                                    {c.archived && (
                                      <span className="shrink-0 rounded bg-surface-overlay px-1 text-2xs text-content-faint">
                                        已归档
                                      </span>
                                    )}
                                  </p>
                                  {c.lastMessagePreview && c.lastMessagePreview.trim() !== name && (
                                    <p className="mt-0.5 truncate text-2xs text-content-muted">
                                      {c.lastMessagePreview}
                                    </p>
                                  )}
                                </button>
                              )}

                              {/* Row actions: ⋯ menu trigger (hover-revealed) */}
                              {!isRenaming && (
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setConfirmDeleteId(null);
                                    setMenuOpenId(isMenuOpen ? null : c.id);
                                  }}
                                  className={`absolute right-1.5 top-1.5 cursor-pointer rounded-md p-1 text-content-faint transition-colors hover:bg-surface-overlay hover:text-content-primary ${
                                    isMenuOpen ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                                  }`}
                                  title="更多操作"
                                  aria-label="更多操作"
                                >
                                  <IconDots size={14} />
                                </button>
                              )}

                              {isMenuOpen && (
                                <>
                                  {/* Click-away backdrop */}
                                  <button
                                    className="fixed inset-0 z-10 cursor-default"
                                    onClick={closeMenu}
                                    aria-label="关闭菜单"
                                  />
                                  <div className="absolute right-1.5 top-9 z-20 w-36 overflow-hidden rounded-lg border border-border bg-surface py-1 shadow-xl">
                                    <button
                                      onClick={() => startRename(c)}
                                      className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-2xs text-content-secondary transition-colors hover:bg-surface-overlay"
                                    >
                                      <IconPencil size={13} /> 改名
                                    </button>
                                    <button
                                      onClick={() => {
                                        store.setConversationArchived(c.id, !c.archived);
                                        closeMenu();
                                      }}
                                      className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-2xs text-content-secondary transition-colors hover:bg-surface-overlay"
                                    >
                                      <IconArchive size={13} /> {c.archived ? "取消归档" : "归档"}
                                    </button>
                                    <button
                                      onClick={() => {
                                        if (confirmDeleteId === c.id) {
                                          store.deleteConversation(c.id);
                                          closeMenu();
                                        } else {
                                          setConfirmDeleteId(c.id);
                                        }
                                      }}
                                      className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-2xs text-danger transition-colors hover:bg-danger/10"
                                    >
                                      <IconTrash size={13} />{" "}
                                      {confirmDeleteId === c.id ? "确认删除？" : "删除"}
                                    </button>
                                  </div>
                                </>
                              )}
                            </div>
                            );
                          })}
                      </div>
                    );
                  })}
              </div>
            );
          })
        )}
      </div>

      {/* Archived toggle (only when there are archived conversations) */}
      {archivedCount > 0 && (
        <button
          onClick={() => setShowArchived((v) => !v)}
          className="flex items-center gap-2 border-t border-border px-3 py-2.5 text-left text-2xs text-content-faint transition-colors hover:bg-surface-overlay hover:text-content-secondary"
        >
          <IconArchive size={13} className="shrink-0" />
          {showArchived ? "隐藏已归档" : `显示已归档 (${archivedCount})`}
        </button>
      )}
    </div>
  );
}
