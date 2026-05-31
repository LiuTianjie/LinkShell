import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Session } from "../lib/supabase";
import { getValidSession } from "../lib/supabase";
import { loadGatewayConfig } from "../lib/gateway-config";
import { useWorkspace } from "../hooks/useWorkspace";
import { TimelineItemView, DiffViewer, TurnActivityGroup, isActivityItem, isQueuedItem, QueuedMessages, SubagentDetailView, type SubagentDetail } from "../components/TimelineItemView";
import { Composer, type PendingImage } from "../components/Composer";
import { TerminalPanel } from "../components/TerminalPanel";
import { ConversationTree } from "../components/ConversationTree";
import { ControlToolbar } from "../components/ControlToolbar";
import { FileBrowser } from "../components/FileBrowser";
import { FolderPicker } from "../components/FolderPicker";
import { IconChevronRight, IconChevronLeft, IconClose, IconPlug, IconMenu, BrandLogo } from "../components/icons";
import { ThemeToggle } from "../components/ThemeToggle";
import { useIsMobile } from "../hooks/useMediaQuery";
import type { ConnectionStatus, AgentTimelineItem } from "../lib/types";

function statusLabel(status: ConnectionStatus): { text: string; color: string } {
  if (status === "connected") return { text: "已连接", color: "text-success" };
  if (status === "connecting" || status === "reconnecting" || status === "claiming")
    return { text: "连接中", color: "text-warning" };
  if (status === "host_disconnected") return { text: "主机离线", color: "text-warning" };
  if (status.startsWith("error")) return { text: "错误", color: "text-danger" };
  return { text: "未连接", color: "text-content-muted" };
}

type RightPanel = "none" | "terminal" | "files";

export function AgentConsolePage({
  sessionId,
  session,
  onBack,
}: {
  sessionId: string;
  session: Session | null;
  onBack: () => void;
}) {
  const config = useMemo(() => loadGatewayConfig(), []);
  // The store resolves a fresh JWT per (re)connect via getValidSession; nothing
  // to thread here. session prop is kept for the header (email / pro badge).
  void session;
  const { store, snapshot } = useWorkspace(config, sessionId);
  const isMobile = useIsMobile();
  const [rightPanel, setRightPanel] = useState<RightPanel>("none");
  // Mobile-only: the conversation tree opens as a full-screen overlay drawer
  // (no split pane on phones). Desktop uses sidebarCollapsed/width instead.
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  // The file-change item whose diff is shown in the right-side drawer (null = closed).
  const [diffItem, setDiffItem] = useState<AgentTimelineItem | null>(null);
  // The sub-agent whose read-only detail is shown in the right drawer (null = closed).
  const [agentDetail, setAgentDetail] = useState<SubagentDetail | null>(null);
  // When set, the folder picker is open for this provider (awaiting a cwd choice
  // before the conversation is actually created).
  const [pendingProvider, setPendingProvider] = useState<string | null>(null);
  // Sidebar width + collapsed state, persisted across sessions.
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    const v = Number(localStorage.getItem("linkshell_sidebar_w"));
    return v >= 180 && v <= 520 ? v : 256;
  });
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(
    () => localStorage.getItem("linkshell_sidebar_collapsed") === "1",
  );
  const draggingRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const toggleSidebar = () => {
    setSidebarCollapsed((c) => {
      localStorage.setItem("linkshell_sidebar_collapsed", c ? "0" : "1");
      return !c;
    });
  };

  // Drag-to-resize the sidebar (pointer events on a thin handle).
  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    draggingRef.current = true;
    const onMove = (ev: PointerEvent) => {
      if (!draggingRef.current) return;
      const w = Math.min(520, Math.max(180, ev.clientX));
      setSidebarWidth(w);
    };
    const onUp = () => {
      draggingRef.current = false;
      localStorage.setItem("linkshell_sidebar_w", String(sidebarWidthRef.current));
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };
  // Keep latest width in a ref so the pointerup handler persists the final value.
  const sidebarWidthRef = useRef(sidebarWidth);
  sidebarWidthRef.current = sidebarWidth;

  const activeId = snapshot.activeConversationId;
  const timeline = activeId ? snapshot.timelines.get(activeId) ?? [] : [];
  const activeConversation = snapshot.conversations.find((c) => c.id === activeId);
  const providers = snapshot.capabilities?.providers ?? [];
  const activeCapability = activeConversation
    ? providers.find((p) => p.id === activeConversation.provider)
    : undefined;
  const running = activeConversation?.status === "running";
  const historyState = activeId ? snapshot.history.get(activeId) : undefined;

  // Refs for scroll anchoring. prevScrollHeightRef preserves the viewport when
  // older history is prepended; atBottomRef tracks whether to stick to bottom.
  const prevHeightRef = useRef(0);
  const atBottomRef = useRef(true);

  // Track whether the user is near the bottom (so streaming sticks) and trigger
  // loading older history when they scroll near the top.
  const handleTimelineScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (el.scrollTop < 60 && activeId && historyState?.hasMore && !historyState.loading) {
      prevHeightRef.current = el.scrollHeight;
      store.loadOlderHistory(activeId);
    }
  };

  // After each timeline change: if older items were prepended (scrollHeight grew
  // while loading history), keep the viewport pinned; otherwise stick to bottom
  // when the user was already there. useLayoutEffect avoids a visible jump.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (prevHeightRef.current > 0) {
      el.scrollTop = el.scrollHeight - prevHeightRef.current;
      prevHeightRef.current = 0;
    } else if (atBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [timeline.length, activeId]);

  // New conversation: pick a working directory first, unless one was supplied
  // (e.g. the "+" on an existing folder in the tree reuses that folder's cwd).
  const handleNewConversation = (provider: string, cwd?: string) => {
    if (cwd) {
      createConversation(provider, cwd);
    } else {
      setPendingProvider(provider);
    }
  };

  const createConversation = (provider: string, cwd: string) => {
    const cap = providers.find((p) => p.id === provider);
    const id = store.openConversation({
      provider: provider as never,
      cwd,
      model: cap?.defaultModel,
    });
    store.setActiveConversation(id);
    setPendingProvider(null);
  };

  const handleSend = (text: string, images: PendingImage[]) => {
    if (!activeId) return;
    store.sendPrompt({
      conversationId: activeId,
      text,
      images: images.map((i) => ({ data: i.data, mimeType: i.mimeType })),
      model: activeConversation?.model,
      reasoningEffort: activeConversation?.reasoningEffort,
      permissionMode: activeConversation?.permissionMode,
      collaborationMode: activeConversation?.collaborationMode,
    });
  };

  const st = statusLabel(snapshot.status);
  const deviceLabel = `CLI 设备 · ${sessionId.slice(0, 8)}`;

  return (
    <div className="flex h-screen h-[100dvh] flex-col">
      {/* Top bar */}
      <header className="flex items-center justify-between border-b border-border px-4 py-2">
        <div className="flex items-center gap-3">
          {isMobile && (
            <button
              onClick={() => setMobileNavOpen(true)}
              className="codex-btn-ghost px-2 py-1.5"
              aria-label="打开会话列表"
            >
              <IconMenu size={17} />
            </button>
          )}
          <button onClick={onBack} className="codex-btn-ghost text-2xs" aria-label="返回会话列表">
            ← 会话
          </button>
          <span className={`flex items-center gap-1 text-2xs ${st.color}`}>
            <span className="h-1.5 w-1.5 rounded-full bg-current" />
            {st.text}
          </span>
          {snapshot.lastError && (
            <span className="text-2xs text-danger" title={snapshot.lastError.message}>
              {snapshot.lastError.code}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <ThemeToggle />
          <button
            onClick={() => setRightPanel((v) => (v === "files" ? "none" : "files"))}
            className={rightPanel === "files" ? "codex-btn-primary text-2xs" : "codex-btn-outline text-2xs"}
          >
            文件
          </button>
          <button
            onClick={() => setRightPanel((v) => (v === "terminal" ? "none" : "terminal"))}
            className={rightPanel === "terminal" ? "codex-btn-primary text-2xs" : "codex-btn-outline text-2xs"}
          >
            终端
          </button>
        </div>
      </header>

      <div className="relative flex min-h-0 flex-1">
        {/* Host offline → full-body blocker guiding reconnection (no session ops). */}
        {snapshot.status === "host_disconnected" && (
          <div className="absolute inset-0 z-40 flex items-center justify-center bg-canvas/80 backdrop-blur-sm">
            <div className="codex-card-raised mx-4 flex max-w-sm flex-col items-center gap-3 px-6 py-8 text-center animate-fade-in">
              <span className="flex h-12 w-12 items-center justify-center rounded-full bg-warning/15 text-warning">
                <IconPlug size={24} />
              </span>
              <h2 className="text-base font-semibold text-content-primary">主机已离线</h2>
              <p className="text-sm leading-relaxed text-content-muted">
                与该会话的主机连接已断开。请确认主机上的{" "}
                <code className="font-mono text-accent">linkshell</code> 仍在运行。正在自动尝试重新连接…
              </p>
              <button onClick={onBack} className="codex-btn-outline mt-1 text-2xs">
                返回会话列表
              </button>
            </div>
          </div>
        )}
        {/* Tree sidebar — desktop: collapsible + drag-resizable split pane.
            Mobile: a full-screen overlay drawer (no split). */}
        {isMobile ? (
          mobileNavOpen && (
            <div className="absolute inset-0 z-30 flex animate-fade-in">
              <aside className="flex w-[82%] max-w-xs flex-col border-r border-border bg-surface shadow-2xl animate-drawer-in">
                <div className="flex items-center border-b border-border px-3 py-2">
                  <span className="text-2xs font-semibold uppercase tracking-wide text-content-muted">
                    会话
                  </span>
                </div>
                <div className="min-h-0 flex-1">
                  <ConversationTree
                    deviceLabel={deviceLabel}
                    conversations={snapshot.conversations}
                    capabilities={snapshot.capabilities}
                    activeConversationId={activeId}
                    onSelect={(id) => { store.setActiveConversation(id); setMobileNavOpen(false); }}
                    onNewConversation={(p, cwd) => { setMobileNavOpen(false); handleNewConversation(p, cwd); }}
                  />
                </div>
              </aside>
              {/* Scrim closes the drawer */}
              <button
                className="flex-1 bg-canvas/60 backdrop-blur-sm"
                onClick={() => setMobileNavOpen(false)}
                aria-label="关闭"
              />
            </div>
          )
        ) : sidebarCollapsed ? (
          <div className="flex w-9 shrink-0 flex-col items-center border-r border-border bg-surface py-2">
            <button
              onClick={toggleSidebar}
              className="cursor-pointer rounded-md p-1.5 text-content-muted transition-colors hover:bg-surface-overlay hover:text-content-primary"
              title="展开侧边栏"
              aria-label="展开侧边栏"
            >
              <IconChevronRight size={16} />
            </button>
          </div>
        ) : (
          <aside
            className="relative flex shrink-0 flex-col border-r border-border bg-surface"
            style={{ width: sidebarWidth }}
          >
            <div className="flex items-center justify-between border-b border-border px-2 py-1">
              <span className="pl-1 text-2xs font-semibold uppercase tracking-wide text-content-muted">
                会话
              </span>
              <button
                onClick={toggleSidebar}
                className="cursor-pointer rounded-md p-1 text-content-muted transition-colors hover:bg-surface-overlay hover:text-content-primary"
                title="收起侧边栏"
                aria-label="收起侧边栏"
              >
                <IconChevronLeft size={15} />
              </button>
            </div>
            <div className="min-h-0 flex-1">
              <ConversationTree
                deviceLabel={deviceLabel}
                conversations={snapshot.conversations}
                capabilities={snapshot.capabilities}
                activeConversationId={activeId}
                onSelect={(id) => store.setActiveConversation(id)}
                onNewConversation={handleNewConversation}
              />
            </div>
            {/* Drag handle */}
            <div
              onPointerDown={startResize}
              className="absolute right-0 top-0 h-full w-1 cursor-col-resize bg-transparent transition-colors hover:bg-accent-dim/50"
              title="拖动调整宽度"
            />
          </aside>
        )}

        {/* Main: turn-log */}
        <main className="flex min-w-0 flex-1 flex-col">
          {!activeId || !activeConversation ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
              <BrandLogo size={44} className="opacity-40" />
              <p className="text-[15px] leading-7 text-content-muted">
                {isMobile ? "点击左上角菜单选择对话，或新建一个开始" : "从左侧选择一个对话，或新建一个开始"}
              </p>
            </div>
          ) : (
            <>
              <div
                ref={scrollRef}
                onScroll={handleTimelineScroll}
                className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-4 py-8"
              >
                <div className="mx-auto flex w-full min-w-0 max-w-3xl flex-col gap-6">
                {historyState?.loading && (
                  <p className="text-center text-2xs text-content-muted">加载更早的消息…</p>
                )}
                {(() => {
                  // Group consecutive activity items (tools/commands/files/
                  // thinking) per the Codex rollup model. Non-activity items
                  // (messages/permissions/plans/errors) render standalone. Only
                  // the LAST group, while the turn is running, shows inline;
                  // finished groups collapse into a one-line summary.
                  type Unit =
                    | { k: "item"; item: AgentTimelineItem }
                    | { k: "group"; key: string; items: AgentTimelineItem[] };
                  const units: Unit[] = [];
                  let buf: AgentTimelineItem[] = [];
                  const flush = () => {
                    if (buf.length) {
                      units.push({ k: "group", key: `grp-${buf[0].id}`, items: buf });
                      buf = [];
                    }
                  };
                  for (const it of timeline) {
                    if (isQueuedItem(it)) continue; // shown floating above composer
                    if (isActivityItem(it)) buf.push(it);
                    else {
                      flush();
                      units.push({ k: "item", item: it });
                    }
                  }
                  flush();
                  let lastGroup = -1;
                  units.forEach((u, i) => {
                    if (u.k === "group") lastGroup = i;
                  });
                  return units.map((u, i) =>
                    u.k === "item" ? (
                      <div key={u.item.id} className="min-w-0 animate-fade-in">
                        <TimelineItemView
                          item={u.item}
                          canSteer={activeConversation.provider === "codex" && running}
                          onPermission={(requestId, outcome, optionId) =>
                            store.respondPermission(activeId, requestId, outcome, optionId)
                          }
                          onStructuredInput={(requestId, answers) =>
                            store.respondStructuredInput(activeId, requestId, answers)
                          }
                          onSendQueued={(itemId) => store.sendQueuedFollowUp(activeId, itemId, "new_turn")}
                          onSteerQueued={(itemId) => store.sendQueuedFollowUp(activeId, itemId, "steer")}
                          onDiscardQueued={(itemId) => store.discardQueuedFollowUp(activeId, itemId)}
                          onOpenDiff={(it) => { setDiffItem(it); setRightPanel("none"); }}
                          onOpenAgent={(detail) => { setAgentDetail(detail); setDiffItem(null); setRightPanel("none"); }}
                        />
                      </div>
                    ) : (
                      <div key={u.key} className="min-w-0 animate-fade-in">
                        <TurnActivityGroup
                          items={u.items}
                          live={running && i === lastGroup}
                          onOpenDiff={(it) => { setDiffItem(it); setRightPanel("none"); }}
                          onOpenAgent={(detail) => { setAgentDetail(detail); setDiffItem(null); setRightPanel("none"); }}
                        />
                      </div>
                    ),
                  );
                })()}
                {timeline.length === 0 && (
                  <p className="py-12 text-center text-sm text-content-muted">发送第一条指令…</p>
                )}
                </div>
              </div>
              <div className="mx-auto w-full min-w-0 max-w-3xl px-4 pb-4">
                <QueuedMessages
                  items={timeline.filter(isQueuedItem)}
                  canSteer={activeConversation.provider === "codex" && running}
                  onSend={(itemId) => store.sendQueuedFollowUp(activeId, itemId, "new_turn")}
                  onSteer={(itemId) => store.sendQueuedFollowUp(activeId, itemId, "steer")}
                  onDiscard={(itemId) => store.discardQueuedFollowUp(activeId, itemId)}
                />
                <ControlToolbar
                  conversation={activeConversation}
                  capability={activeCapability}
                  onChange={(patch) => store.updateConversationSettings(activeId, patch)}
                />
                <Composer
                  disabled={snapshot.status !== "connected"}
                  running={running}
                  supportsImages={activeCapability?.supportsImages}
                  commands={activeCapability?.commands}
                  onSend={handleSend}
                  onCancel={() => store.cancel(activeId)}
                  onExecuteCommand={(commandId, args) => store.executeCommand(activeId, commandId, args)}
                />
              </div>
            </>
          )}
        </main>

        {/* Right panel: subagent / diff drawer takes priority, then terminal/files.
            Desktop = split pane (border + percentage width); mobile = full-screen
            overlay above the turn-log (split panes are unusable on a phone). */}
        {(() => {
          // Shared wrapper classes: overlay on mobile, bordered split pane on desktop.
          const drawer = (desktopWidth: string) =>
            isMobile
              ? "absolute inset-0 z-30 flex flex-col bg-canvas animate-fade-in"
              : `flex ${desktopWidth} flex-col border-l border-border`;
          if (agentDetail) {
            return (
              <aside className={drawer("w-[42%]")}>
                <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
                  <span className="text-2xs font-semibold uppercase tracking-wide text-content-muted">
                    子 Agent
                  </span>
                  <button
                    onClick={() => setAgentDetail(null)}
                    className="codex-btn-ghost px-2 py-1.5"
                    aria-label="关闭"
                  >
                    <IconClose size={15} />
                  </button>
                </div>
                <div className="min-h-0 flex-1">
                  <SubagentDetailView detail={agentDetail} />
                </div>
              </aside>
            );
          }
          if (diffItem) {
            return (
              <aside className={drawer("w-[46%]")}>
                <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
                  <span className="text-2xs font-semibold uppercase tracking-wide text-content-muted">
                    文件差异
                  </span>
                  <button
                    onClick={() => setDiffItem(null)}
                    className="codex-btn-ghost px-2 py-1.5"
                    aria-label="关闭差异"
                  >
                    <IconClose size={15} />
                  </button>
                </div>
                <div className="min-h-0 flex-1">
                  <DiffViewer item={diffItem} />
                </div>
              </aside>
            );
          }
          if (rightPanel === "terminal") {
            return (
              <aside className={drawer("w-[44%]")}>
                {isMobile && (
                  <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
                    <span className="text-2xs font-semibold uppercase tracking-wide text-content-muted">终端</span>
                    <button onClick={() => setRightPanel("none")} className="codex-btn-ghost px-2 py-1.5" aria-label="关闭终端">
                      <IconClose size={15} />
                    </button>
                  </div>
                )}
                <div className="min-h-0 flex-1">
                  <TerminalPanel
                    bridge={store.client}
                    onNewTerminal={() => store.client.spawnTerminal(activeConversation?.cwd || ".")}
                  />
                </div>
              </aside>
            );
          }
          if (rightPanel === "files") {
            return (
              <aside className={drawer("w-[40%]")}>
                <FileBrowser
                  store={store}
                  initialPath={activeConversation?.cwd || "."}
                  onClose={() => setRightPanel("none")}
                />
              </aside>
            );
          }
          return null;
        })()}
      </div>

      {/* Folder picker shown before a new conversation is created. */}
      {pendingProvider && (
        <FolderPicker
          store={store}
          initialPath={activeConversation?.cwd || "."}
          providerLabel={providers.find((p) => p.id === pendingProvider)?.label ?? pendingProvider}
          onCancel={() => setPendingProvider(null)}
          onConfirm={(cwd) => createConversation(pendingProvider, cwd)}
        />
      )}


      {/* Transient notices (model/effort/permission changes, info, warnings). */}
      {snapshot.notices.length > 0 && (
        <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-80 flex-col gap-2">
          {snapshot.notices.map((n) => (
            <button
              key={n.id}
              onClick={() => store.dismissNotice(n.id)}
              className={`codex-card-raised pointer-events-auto animate-fade-in cursor-pointer px-3 py-2 text-left ${
                n.kind === "warning" ? "border-warning/40" : ""
              }`}
            >
              <p className="flex items-center gap-1.5 text-xs font-medium text-content-primary">
                <span
                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                    n.kind === "warning" ? "bg-warning" : "bg-accent"
                  }`}
                />
                {n.title}
              </p>
              {n.detail && <p className="mt-0.5 pl-3 text-2xs text-content-muted">{n.detail}</p>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
