import { useMemo, useRef, useState, useCallback } from "react";
import { FloatingPanel } from "./FloatingPanel";
import type { AgentConversation, AgentCapabilitiesPayload, AgentStatus } from "../lib/types";
import { attentionStatus } from "../lib/agent-presence";
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
import { buildProviderOrganization, bucketDefaultCwd, folderLabel } from "../lib/conversation-organization";

// Tree: Device → Provider → native bucket (Codex workspace / Claude group / folder).

function ConversationRowMenu({
  open,
  confirmDelete,
  archived,
  onToggle,
  onClose,
  onRename,
  onArchive,
  onDelete,
}: {
  open: boolean;
  confirmDelete: boolean;
  archived: boolean;
  onToggle: () => void;
  onClose: () => void;
  onRename: () => void;
  onArchive: () => void;
  onDelete: () => void;
}) {
  const btnRef = useRef<HTMLButtonElement | null>(null);
  return (
    <>
      <button
        ref={btnRef}
        onClick={(e) => {
          e.stopPropagation();
          onToggle();
        }}
        className={`absolute right-1.5 top-1.5 cursor-pointer rounded-md p-1 text-content-faint transition-colors hover:bg-surface-overlay hover:text-content-primary ${
          open ? "opacity-100" : "opacity-0 group-hover:opacity-100"
        }`}
        title="更多操作"
        aria-label="更多操作"
      >
        <IconDots size={14} />
      </button>
      <FloatingPanel
        open={open}
        anchorRef={btnRef}
        placement="bottom-end"
        onClose={onClose}
        className="overflow-hidden rounded-lg border border-border bg-surface py-1 shadow-xl"
        minWidth={160}
      >
        <button
          onClick={onRename}
          className="flex w-full cursor-pointer items-center gap-2 px-3 py-2.5 text-left text-2xs text-content-secondary transition-colors hover:bg-surface-overlay"
        >
          <IconPencil size={13} /> 改名
        </button>
        <button
          onClick={onArchive}
          className="flex w-full cursor-pointer items-center gap-2 px-3 py-2.5 text-left text-2xs text-content-secondary transition-colors hover:bg-surface-overlay"
        >
          <IconArchive size={13} /> {archived ? "取消归档" : "归档"}
        </button>
        <button
          onClick={onDelete}
          className="flex w-full cursor-pointer items-center gap-2 px-3 py-2.5 text-left text-2xs text-danger transition-colors hover:bg-danger/10"
        >
          <IconTrash size={13} /> {confirmDelete ? "确认从列表移除？" : "从列表移除"}
        </button>
      </FloatingPanel>
    </>
  );
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

function providerLabel(id: string): string {
  switch (id) {
    case "claude":
      return "Claude";
    case "codex":
      return "Codex";
    case "gemini":
      return "Gemini";
    case "copilot":
      return "Copilot";
    case "opencode":
      return "OpenCode";
    case "cursor":
      return "Cursor";
    case "grok":
      return "Grok";
    case "kimi":
      return "Kimi";
    default:
      return id;
  }
}

function AttentionBadge({ status }: { status: AgentStatus }) {
  const badge = status === "unavailable"
    ? { text: "不可用", className: "border-border bg-surface-overlay text-content-faint" }
    : attentionStatus(status);
  if (!badge) return null;
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${badge.className}`}>
      {badge.pulsing && (
        <span className="h-1.5 w-1.5 rounded-full bg-current animate-pulse-dot" />
      )}
      {badge.text}
    </span>
  );
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
  // Also hide <synthetic> model conversations (internal Claude heuristics, not
  // real user sessions) — they clutter "最近会话" with unusable entries.
  const [showArchived, setShowArchived] = useState(false);
  const archivedCount = useMemo(
    () => conversations.filter((c) => c.archived).length,
    [conversations],
  );
  const filterConversation = useCallback((c: AgentConversation) => {
    if (c.archived && !showArchived) return false;
    if (c.model === "<synthetic>") return false;
    return true;
  }, [showArchived]);
  const visibleConversations = useMemo(
    () => conversations.filter(filterConversation),
    [conversations, filterConversation],
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
  const tree = useMemo(() => buildProviderOrganization(visibleConversations), [visibleConversations]);

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
                    <AttentionBadge status={externalAgentStatus} />
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
                      <AttentionBadge status={c.status} />
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
          tree.map((providerNode) => {
            const pKey = `prov:${providerNode.provider}`;
            const pCollapsed = collapsed.has(pKey);
            const count = providerNode.buckets.reduce((n, b) => n + b.conversations.length, 0);
            return (
              <div key={providerNode.provider} className="py-1">
                <div className="flex items-center gap-1">
                  <button onClick={() => toggle(pKey)} className="tree-row flex-1">
                    {pCollapsed ? (
                      <IconChevronRight size={12} className="shrink-0 text-content-faint" />
                    ) : (
                      <IconChevronDown size={12} className="shrink-0 text-content-faint" />
                    )}
                    <ProviderIcon provider={providerNode.provider} size={13} />
                    <span className="text-[13px] font-medium text-content-secondary">
                      {providerLabel(providerNode.provider)}
                    </span>
                    <span className="text-2xs text-content-faint">({count})</span>
                  </button>
                  <button
                    onClick={() => onNewConversation(providerNode.provider)}
                    className="cursor-pointer rounded-lg p-1.5 text-content-faint transition-colors hover:bg-surface-overlay hover:text-accent"
                    title={`新建 ${providerLabel(providerNode.provider)} 对话`}
                    aria-label="新建对话"
                  >
                    <IconPlus size={13} />
                  </button>
                </div>
                {!pCollapsed &&
                  providerNode.buckets.map((bucket) => {
                    const bKey = `bucket:${providerNode.provider}:${bucket.key}`;
                    const bCollapsed = collapsed.has(bKey);
                    return (
                      <div key={bucket.key} className="pl-3">
                        <div className="flex items-center gap-1">
                        <button
                          onClick={() => toggle(bKey)}
                          className="tree-row flex-1"
                          title={bucket.kind === "workspace" ? "多项目工作区" : bucket.label}
                        >
                          {bCollapsed ? (
                            <IconChevronRight size={12} className="shrink-0 text-content-faint" />
                          ) : (
                            <IconChevronDown size={12} className="shrink-0 text-content-faint" />
                          )}
                          <IconFolder size={13} className="shrink-0 text-content-faint" />
                          <span className="truncate text-2xs font-semibold uppercase tracking-wider text-content-faint">
                            {bucket.label}
                          </span>
                          {bucket.kind === "workspace" && (
                            <span className="shrink-0 rounded bg-surface-overlay px-1 text-[10px] text-content-faint">
                              工作区
                            </span>
                          )}
                        </button>
                        {bucket.kind !== "workspace" && (
                          <button
                            onClick={() => onNewConversation(providerNode.provider, bucketDefaultCwd(bucket))}
                            className="cursor-pointer rounded-lg p-1.5 text-content-faint transition-colors hover:bg-surface-overlay hover:text-accent"
                            title="在此分组新建对话"
                            aria-label="新建对话"
                          >
                            <IconPlus size={13} />
                          </button>
                        )}
                        </div>
                        {!bCollapsed &&
                          bucket.conversations.map((c) => {
                            // Prefer a real title; else the first message preview
                            // (ChatGPT-style); else a short id. Never blank.
                            const name =
                              (c.title && c.title.trim()) ||
                              (c.lastMessagePreview && c.lastMessagePreview.trim().slice(0, 40)) ||
                              `对话 ${c.id.slice(-6)}`;
                            const isRenaming = renamingId === c.id;
                            const isMenuOpen = menuOpenId === c.id;
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
                                    <AttentionBadge status={c.status} />
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

                              {!isRenaming && (
                                <ConversationRowMenu
                                  open={isMenuOpen}
                                  confirmDelete={confirmDeleteId === c.id}
                                  archived={!!c.archived}
                                  onToggle={() => {
                                    setConfirmDeleteId(null);
                                    setMenuOpenId(isMenuOpen ? null : c.id);
                                  }}
                                  onClose={closeMenu}
                                  onRename={() => startRename(c)}
                                  onArchive={() => {
                                    store.setConversationArchived(c.id, !c.archived);
                                    closeMenu();
                                  }}
                                  onDelete={() => {
                                    if (confirmDeleteId === c.id) {
                                      store.deleteConversation(c.id);
                                      closeMenu();
                                    } else {
                                      setConfirmDeleteId(c.id);
                                    }
                                  }}
                                />
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
