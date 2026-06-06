import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
import { PortPreview } from "../components/PortPreview";
import { IconChevronRight, IconChevronLeft, IconClose, IconPlug, IconMenu, BrandLogo } from "../components/icons";
import { ThemeToggle } from "../components/ThemeToggle";
import { isEmbedded } from "../lib/embed";
import { CommandPalette, type PaletteAction } from "../components/CommandPalette";
import { useIsMobile } from "../hooks/useMediaQuery";
import type { ConnectionStatus, AgentTimelineItem } from "../lib/types";
import { IconSearch, IconPlus, IconStop, IconTerminal, IconFolder, IconGlobe, ProviderIcon } from "../components/icons";

function statusLabel(status: ConnectionStatus): { text: string; color: string } {
  if (status === "connected") return { text: "已连接", color: "text-success" };
  if (status === "connecting" || status === "reconnecting" || status === "claiming")
    return { text: "连接中", color: "text-warning" };
  if (status === "host_disconnected") return { text: "主机离线", color: "text-warning" };
  if (status.startsWith("error")) return { text: "错误", color: "text-danger" };
  return { text: "未连接", color: "text-content-muted" };
}

// Lightweight AnimatedPresence: mounts children with an enter animation, then
// when `show` becomes false applies an exit animation and waits for
// animationend before unmounting. Keeps panel transitions smooth.
function useAnimatedPresence(show: boolean, animIn: string, animOut: string) {
  const [state, setState] = useState<{ render: boolean; className: string }>(
    () => ({ render: show, className: show ? animIn : "" }),
  );
  const prevShow = useRef(show);

  useEffect(() => {
    if (show && !prevShow.current) {
      setState({ render: true, className: animIn });
    } else if (!show && prevShow.current) {
      setState({ render: true, className: animOut });
    }
    prevShow.current = show;
  }, [show, animIn, animOut]);

  const onAnimationEnd = useCallback(() => {
    if (!prevShow.current) {
      setState({ render: false, className: "" });
    }
  }, []);

  return { render: state.render, className: state.className, onAnimationEnd };
}

// Does a timeline item match a free-text search query? Looks across message
// text, command, tool name/io, and changed file paths so search is useful for
// both conversation and activity items.
function itemMatchesQuery(item: AgentTimelineItem, q: string): boolean {
  const needle = q.toLowerCase();
  const haystacks = [
    item.text,
    item.commandExecution?.command,
    item.commandExecution?.output,
    item.toolCall?.name,
    item.toolCall?.input,
    item.toolCall?.output,
    item.fileChange?.summary,
    ...(item.fileChange?.entries?.map((e) => e.path) ?? []),
    item.error,
  ];
  return haystacks.some((h) => typeof h === "string" && h.toLowerCase().includes(needle));
}

type RightPanel = "none" | "files" | "preview";

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
  // Embedded in the mobile app's WebView: the native shell owns the theme, so
  // hide the web theme toggle (it would fight the app's setting).
  const embedded = useMemo(() => isEmbedded(), []);
  // The store resolves a fresh JWT per (re)connect via getValidSession; nothing
  // to thread here. session prop is kept for the header (email / pro badge).
  void session;
  const { store, snapshot } = useWorkspace(config, sessionId);
  const isMobile = useIsMobile();
  const [rightPanel, setRightPanel] = useState<RightPanel>("none");
  // Terminal as a bottom slide-out panel (VS Code-style), toggled by Cmd+J
  // or the header button. Height is persisted in localStorage and resizable
  // via a drag handle on the top edge.
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [terminalClosing, setTerminalClosing] = useState(false);
  const [terminalHeight, setTerminalHeight] = useState<number>(() => {
    const v = Number(localStorage.getItem("linkshell_terminal_h"));
    return v >= 120 && v <= 600 ? v : 320;
  });
  const terminalDraggingRef = useRef(false);
  const terminalHeightRef = useRef(terminalHeight);
  terminalHeightRef.current = terminalHeight;
  // Keep terminalOpen in a ref so toggleTerminal is stable and safe in the
  // keyboard handler's empty-deps useEffect.
  const terminalOpenRef = useRef(terminalOpen);
  terminalOpenRef.current = terminalOpen;

  // Toggle the terminal bottom panel. Closing animates out (slide-down)
  // before unmounting; opening mounts + slides up immediately.
  const toggleTerminal = useCallback(() => {
    if (terminalOpenRef.current) {
      setTerminalClosing(true);
    } else {
      setTerminalOpen(true);
    }
  }, []);
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
  // Edit-and-resend: bumping the nonce injects text into the composer.
  const [seed, setSeed] = useState<{ text: string; nonce: number }>({ text: "", nonce: 0 });
  // In-conversation search (Cmd/Ctrl+F): a flat filtered view of the timeline.
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  // Command palette (Cmd/Ctrl+K).
  const [paletteOpen, setPaletteOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  // Sidebar width + collapsed state, persisted across sessions.
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    const v = Number(localStorage.getItem("linkshell_sidebar_w"));
    return v >= 180 && v <= 520 ? v : 256;
  });
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(
    () => localStorage.getItem("linkshell_sidebar_collapsed") === "1",
  );
  // Right panel (terminal/diff/files/subagent) width, persisted. Resizes from
  // its LEFT edge, so it grows as the handle is dragged toward the canvas.
  const [rightPanelWidth, setRightPanelWidth] = useState<number>(() => {
    const v = Number(localStorage.getItem("linkshell_rightpanel_w"));
    return v >= 320 && v <= 1100 ? v : 560;
  });
  const draggingRef = useRef(false);
  const rightDraggingRef = useRef(false);
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

  // Drag-to-resize the right panel from its LEFT edge. Width grows as the
  // handle moves toward the canvas, so width = viewport - pointerX.
  const rightPanelWidthRef = useRef(rightPanelWidth);
  rightPanelWidthRef.current = rightPanelWidth;
  const startRightResize = (e: React.PointerEvent) => {
    e.preventDefault();
    rightDraggingRef.current = true;
    const onMove = (ev: PointerEvent) => {
      if (!rightDraggingRef.current) return;
      const w = Math.min(1100, Math.max(320, window.innerWidth - ev.clientX));
      setRightPanelWidth(w);
    };
    const onUp = () => {
      rightDraggingRef.current = false;
      localStorage.setItem("linkshell_rightpanel_w", String(rightPanelWidthRef.current));
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  // Drag-to-resize the bottom terminal panel from its TOP edge. Height
  // grows as the handle is dragged upward (pointerY decreases).
  const startTerminalResize = (e: React.PointerEvent) => {
    e.preventDefault();
    terminalDraggingRef.current = true;
    const startY = e.clientY;
    const startH = terminalHeightRef.current;
    const onMove = (ev: PointerEvent) => {
      if (!terminalDraggingRef.current) return;
      const h = Math.min(600, Math.max(120, startH + (startY - ev.clientY)));
      setTerminalHeight(h);
    };
    const onUp = () => {
      terminalDraggingRef.current = false;
      localStorage.setItem("linkshell_terminal_h", String(terminalHeightRef.current));
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const activeId = snapshot.activeConversationId;
  const timeline = activeId ? snapshot.timelines.get(activeId) ?? [] : [];
  const activeConversation = snapshot.conversations.find((c) => c.id === activeId);
  const providers = snapshot.capabilities?.providers ?? [];
  const activeCapability = activeConversation
    ? providers.find((p) => p.id === activeConversation.provider)
    : undefined;
  const running = activeConversation?.status === "running";
  const historyState = activeId ? snapshot.history.get(activeId) : undefined;

  // Last user message in this conversation — recalled by ↑ in an empty composer.
  const lastUserText = useMemo(() => {
    for (let i = timeline.length - 1; i >= 0; i--) {
      const it = timeline[i];
      if (it.role === "user" && it.text) return it.text;
    }
    return undefined;
  }, [timeline]);

  // Edit-and-resend: load a prior message back into the composer for editing.
  const handleEditMessage = (text: string) => {
    setSeed((s) => ({ text, nonce: s.nonce + 1 }));
  };

  // Plan mode: once the agent finishes a planning turn (we're in plan mode,
  // idle, and the latest item is the agent's, not the user's), surface a
  // one-click "execute" affordance. Executing reuses the existing mode-switch
  // path: send an instruction with collaborationMode "default", which exits
  // plan mode and tells the agent to proceed. The user can instead just keep
  // typing in the composer to refine the plan.
  const planReady = useMemo(() => {
    if (activeConversation?.collaborationMode !== "plan") return false;
    if (running || activeConversation?.status === "waiting_permission") return false;
    const last = [...timeline].reverse().find((i) => !isQueuedItem(i));
    return last != null && last.role !== "user";
  }, [activeConversation?.collaborationMode, activeConversation?.status, running, timeline]);

  const handleExecutePlan = () => {
    if (!activeId) return;
    store.sendPrompt({
      conversationId: activeId,
      text: "请按上面的计划开始执行。",
      collaborationMode: "default",
      model: activeConversation?.model,
      reasoningEffort: activeConversation?.reasoningEffort,
      permissionMode: activeConversation?.permissionMode,
    });
  };

  // Global shortcuts: Cmd/Ctrl+Shift+P (or Cmd/Ctrl+K) opens the command
  // palette to search conversations + run actions; Cmd/Ctrl+F opens
  // in-conversation search (preventDefault stops the browser's own find bar).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.shiftKey && e.key.toLowerCase() === "p") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      } else if (mod && !e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      } else if (mod && !e.shiftKey && e.key.toLowerCase() === "j") {
        e.preventDefault();
        toggleTerminal();
      } else if (mod && !e.shiftKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setSearchOpen(true);
        requestAnimationFrame(() => searchInputRef.current?.focus());
      } else if (e.key === "Escape") {
        setSearchOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Reset search when switching conversations.
  useEffect(() => {
    setSearchOpen(false);
    setSearchQuery("");
  }, [activeId]);

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

  // Stable spawn-terminal callback. TerminalPanel keys an effect on this prop,
  // so an inline closure (new identity every render) would make it re-subscribe
  // and re-request the terminal list on every streaming re-render. Depend on the
  // cwd STRING, not the conversation object (whose identity changes each notify).
  const activeCwd = activeConversation?.cwd;
  const handleNewTerminal = useCallback(() => {
    store.client.spawnTerminal(activeCwd || ".");
  }, [store, activeCwd]);

  // Command-palette actions: new conversation per enabled provider, jump to any
  // existing conversation, and the common turn/panel actions.
  const enabledProviders = providers.filter((p) => p.enabled);
  const paletteActions = useMemo<PaletteAction[]>(() => {
    const actions: PaletteAction[] = [];
    for (const p of enabledProviders) {
      actions.push({
        id: `new-${p.id}`,
        label: `新建 ${p.label} 对话`,
        group: "新建",
        keywords: `new conversation ${p.id}`,
        icon: <IconPlus size={15} />,
        run: () => handleNewConversation(p.id),
      });
    }
    for (const c of snapshot.conversations.filter((c) => !c.archived)) {
      const name =
        (c.title && c.title.trim()) ||
        (c.lastMessagePreview && c.lastMessagePreview.trim().slice(0, 40)) ||
        `对话 ${c.id.slice(-6)}`;
      actions.push({
        id: `conv-${c.id}`,
        label: name,
        group: "对话",
        hint: c.cwd ? c.cwd.split("/").slice(-1)[0] : undefined,
        keywords: `${c.provider} ${c.cwd ?? ""}`,
        icon: <ProviderIcon provider={c.provider} size={15} />,
        run: () => store.setActiveConversation(c.id),
      });
    }
    if (activeId && running) {
      actions.push({
        id: "cancel",
        label: "停止当前回合",
        group: "操作",
        keywords: "cancel stop interrupt",
        icon: <IconStop size={15} />,
        run: () => store.cancel(activeId),
      });
    }
    if (activeId) {
      actions.push({
        id: "search",
        label: "在对话中搜索",
        group: "操作",
        hint: "⌘F",
        keywords: "search find filter",
        icon: <IconSearch size={15} />,
        run: () => {
          setSearchOpen(true);
          requestAnimationFrame(() => searchInputRef.current?.focus());
        },
      });
    }
    actions.push(
      {
        id: "panel-terminal",
        label: "切换终端",
        group: "操作",
        hint: "⌘J",
        keywords: "terminal shell",
        icon: <IconTerminal size={15} />,
        run: toggleTerminal,
      },
      {
        id: "panel-files",
        label: "打开文件浏览器",
        group: "操作",
        keywords: "files browse",
        icon: <IconFolder size={15} />,
        run: () => setRightPanel((v) => (v === "files" ? "none" : "files")),
      },
      {
        id: "panel-preview",
        label: "打开端口预览",
        group: "操作",
        keywords: "preview port browser localhost tunnel",
        icon: <IconGlobe size={15} />,
        run: () => setRightPanel((v) => (v === "preview" ? "none" : "preview")),
      },
    );
    return actions;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabledProviders, snapshot.conversations, activeId, running]);

  return (
    <div className="flex h-[100dvh] flex-col overflow-hidden">
      {/* Top bar. pt safe-area inset so it clears the notch / status bar. */}
      <header
        className="flex items-center justify-between border-b border-border px-4 py-2"
        style={{ paddingTop: "max(0.5rem, env(safe-area-inset-top))" }}
      >
        <div className="flex min-w-0 items-center gap-3">
          {isMobile && (
            <button
              onClick={() => setMobileNavOpen(true)}
              className="codex-btn-ghost px-2 py-1.5"
              aria-label="打开会话列表"
            >
              <IconMenu size={17} />
            </button>
          )}
          <button onClick={onBack} className="codex-btn-ghost shrink-0 text-2xs" aria-label="返回会话列表">
            ← 会话
          </button>
          <span className={`flex shrink-0 items-center gap-1 text-2xs ${st.color}`}>
            <span className="h-1.5 w-1.5 rounded-full bg-current" />
            {st.text}
          </span>
          {snapshot.lastError && (
            <button
              onClick={() => store.dismissError()}
              className="min-w-0 truncate rounded-full border border-danger/30 bg-danger/10 px-2 py-0.5 text-2xs text-danger"
              title={`${snapshot.lastError.message}（点击关闭）`}
            >
              {snapshot.lastError.code}
            </button>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            onClick={() => {
              if (!activeId) return;
              setSearchOpen(true);
              requestAnimationFrame(() => searchInputRef.current?.focus());
            }}
            disabled={!activeId}
            className="codex-btn-ghost px-2 py-1.5 disabled:opacity-40"
            title="在对话中搜索 (⌘/Ctrl+F)"
            aria-label="在对话中搜索"
          >
            <IconSearch size={16} />
          </button>
          {!embedded && <ThemeToggle />}
          <button
            onClick={() => setRightPanel((v) => (v === "preview" ? "none" : "preview"))}
            className={`cursor-pointer rounded-md p-1.5 transition-colors ${rightPanel === "preview" ? "bg-accent-dim text-white" : "text-content-muted hover:bg-surface-overlay hover:text-content-primary"}`}
            title="端口预览"
            aria-label="端口预览"
          >
            <IconGlobe size={16} />
          </button>
          <button
            onClick={() => setRightPanel((v) => (v === "files" ? "none" : "files"))}
            className={`cursor-pointer rounded-md p-1.5 transition-colors ${rightPanel === "files" ? "bg-accent-dim text-white" : "text-content-muted hover:bg-surface-overlay hover:text-content-primary"}`}
            title="文件"
            aria-label="文件"
          >
            <IconFolder size={16} />
          </button>
          <button
            onClick={toggleTerminal}
            className={`cursor-pointer rounded-md p-1.5 transition-colors ${terminalOpen ? "bg-accent-dim text-white" : "text-content-muted hover:bg-surface-overlay hover:text-content-primary"}`}
            title="终端 (⌘J)"
            aria-label="终端"
          >
            <IconTerminal size={16} />
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
                    store={store}
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
                store={store}
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
              {/* In-conversation search bar (Cmd/Ctrl+F). */}
              {searchOpen && (
                <div className="flex items-center gap-2 border-b border-border bg-surface px-4 py-2">
                  <IconSearch size={15} className="shrink-0 text-content-faint" />
                  <input
                    ref={searchInputRef}
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    onKeyDown={(e) => e.key === "Escape" && (setSearchOpen(false), setSearchQuery(""))}
                    placeholder="在此对话中搜索…"
                    className="min-w-0 flex-1 bg-transparent text-sm text-content-primary placeholder-content-muted outline-none"
                  />
                  <button
                    onClick={() => { setSearchOpen(false); setSearchQuery(""); }}
                    className="codex-btn-ghost px-2 py-1"
                    aria-label="关闭搜索"
                  >
                    <IconClose size={14} />
                  </button>
                </div>
              )}
              <div
                ref={scrollRef}
                onScroll={handleTimelineScroll}
                className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-4 py-8"
              >
                <div className="mx-auto flex w-full min-w-0 max-w-3xl flex-col gap-6">
                {historyState?.loading && (
                  <p className="text-center text-2xs text-content-muted">加载更早的消息…</p>
                )}
                {searchOpen && searchQuery.trim() ? (
                  // Search results: flat, chronological, every matching item.
                  (() => {
                    const q = searchQuery.trim();
                    const matches = timeline.filter((it) => !isQueuedItem(it) && itemMatchesQuery(it, q));
                    if (matches.length === 0) {
                      return <p className="py-12 text-center text-sm text-content-muted">没有匹配「{q}」的消息</p>;
                    }
                    return (
                      <>
                        <p className="text-center text-2xs text-content-faint">{matches.length} 条匹配</p>
                        {matches.map((it) => (
                          <div key={it.id} className="min-w-0 animate-fade-in">
                            <TimelineItemView
                              item={it}
                              canSteer={false}
                              onPermission={(requestId, outcome, optionId) =>
                                store.respondPermission(activeId, requestId, outcome, optionId)
                              }
                              onStructuredInput={(requestId, answers) =>
                                store.respondStructuredInput(activeId, requestId, answers)
                              }
                              onOpenDiff={(d) => { setDiffItem(d); setRightPanel("none"); }}
                              onOpenAgent={(detail) => { setAgentDetail(detail); setDiffItem(null); setRightPanel("none"); }}
                              onEditMessage={handleEditMessage}
                              highlightQuery={q}
                            />
                          </div>
                        ))}
                      </>
                    );
                  })()
                ) : (() => {
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
                          onEditMessage={handleEditMessage}
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
                {timeline.length === 0 &&
                  (activeConversation?.lastMessagePreview || historyState?.loading ? (
                    // Existing conversation whose transcript is still loading
                    // (we switched to it instantly; history streams in after).
                    <div className="flex flex-col items-center gap-2 py-16 text-content-muted">
                      <span className="h-5 w-5 animate-spin rounded-full border-2 border-content-faint border-t-accent" />
                      <p className="text-sm">加载对话记录…</p>
                    </div>
                  ) : (
                    <p className="py-12 text-center text-sm text-content-muted">发送第一条指令…</p>
                  ))}
                </div>
              </div>
              <div className="mx-auto w-full min-w-0 max-w-3xl px-4 pb-4">
                {planReady && (
                  <div className="mb-2 flex items-center gap-3 rounded-xl border border-accent-dim/40 bg-surface px-3.5 py-2.5 animate-slide-in">
                    <span className="min-w-0 flex-1 text-sm text-content-secondary">
                      计划已就绪。执行它，或在下方继续补充。
                    </span>
                    <button onClick={handleExecutePlan} className="codex-btn-primary shrink-0 text-xs">
                      执行计划
                    </button>
                  </div>
                )}
                <QueuedMessages
                  items={timeline.filter(isQueuedItem)}
                  canSteer={activeConversation.provider === "codex" && running}
                  onSend={(itemId) => store.sendQueuedFollowUp(activeId, itemId, "new_turn")}
                  onSteer={(itemId) => store.sendQueuedFollowUp(activeId, itemId, "steer")}
                  onDiscard={(itemId) => store.discardQueuedFollowUp(activeId, itemId)}
                />
                <Composer
                  disabled={snapshot.status !== "connected"}
                  running={running}
                  supportsImages={activeCapability?.supportsImages}
                  commands={activeCapability?.commands}
                  conversationId={activeId}
                  lastUserText={lastUserText}
                  cwd={activeConversation.cwd}
                  onBrowse={(path) => store.browse(path, true)}
                  seedText={seed}
                  controls={
                    <ControlToolbar
                      conversation={activeConversation}
                      capability={activeCapability}
                      onChange={(patch) => store.updateConversationSettings(activeId, patch)}
                    />
                  }
                  onSend={handleSend}
                  onCancel={() => store.cancel(activeId)}
                  onExecuteCommand={(commandId, args) => store.executeCommand(activeId, commandId, args)}
                />
              </div>
              {/* Terminal bottom panel — the whole chat surface (timeline +
                   composer) sits above this panel, so opening it pushes the
                   input upward instead of leaving the composer in front of the
                   terminal. */}
              {(terminalOpen || terminalClosing) && (
                <div
                  className={`relative shrink-0 overflow-hidden border-t border-border bg-surface ${
                    terminalClosing ? "animate-panel-out-down" : "animate-panel-in-up"
                  }`}
                  style={{ height: terminalHeight }}
                  onAnimationEnd={() => {
                    if (terminalClosing) {
                      setTerminalClosing(false);
                      setTerminalOpen(false);
                    }
                  }}
                >
                  {/* Drag handle on top edge */}
                  <div
                    onPointerDown={startTerminalResize}
                    className="absolute left-0 right-0 top-0 z-10 h-1 cursor-row-resize bg-transparent transition-colors hover:bg-accent-dim/50"
                    title="拖动调整终端高度"
                  />
                  <TerminalPanel
                    bridge={store.client}
                    onNewTerminal={handleNewTerminal}
                  />
                </div>
              )}
            </>
          )}
        </main>

        {/* Right panel: subagent / diff drawer takes priority, then files / preview.
            Desktop = drag-resizable split pane (border + persisted px width) with
            a slide-in/out transition; mobile = full-screen overlay. */}
        {(() => {
          // Compute the panel's content first; wrap once below so the resize
          // handle + sizing logic isn't duplicated across every branch.
          let content: React.ReactNode = null;
          if (agentDetail) {
            content = (
              <>
                <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
                  <span className="text-2xs font-semibold uppercase tracking-wide text-content-muted">
                    子 Agent
                  </span>
                  <button onClick={() => setAgentDetail(null)} className="codex-btn-ghost px-2 py-1.5" aria-label="关闭">
                    <IconClose size={15} />
                  </button>
                </div>
                <div className="min-h-0 flex-1">
                  <SubagentDetailView detail={agentDetail} />
                </div>
              </>
            );
          } else if (diffItem) {
            content = (
              <>
                <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
                  <span className="text-2xs font-semibold uppercase tracking-wide text-content-muted">
                    文件差异
                  </span>
                  <button onClick={() => setDiffItem(null)} className="codex-btn-ghost px-2 py-1.5" aria-label="关闭差异">
                    <IconClose size={15} />
                  </button>
                </div>
                <div className="min-h-0 flex-1">
                  <DiffViewer item={diffItem} />
                </div>
              </>
            );
          } else if (rightPanel === "files") {
            content = (
              <FileBrowser
                store={store}
                initialPath={activeConversation?.cwd || "."}
                onClose={() => setRightPanel("none")}
              />
            );
          } else if (rightPanel === "preview") {
            content = (
              <PortPreview
                gatewayUrl={config.httpUrl}
                sessionId={sessionId}
                initialAuthToken={session?.accessToken ?? null}
                isMobile={isMobile}
                onClose={() => setRightPanel("none")}
                onAnnotate={(text) => {
                  // Load the element annotation into the composer (not auto-sent)
                  // so the user can add intent before sending it to the agent.
                  setSeed((s) => ({ text, nonce: s.nonce + 1 }));
                  if (isMobile) setRightPanel("none");
                }}
              />
            );
          }

          // Persist the last visible content so we can play the exit animation
          // on it before unmounting. Without this the panel vanishes instantly.
          const lastContentRef = useRef<React.ReactNode>(null);
          if (content !== null) lastContentRef.current = content;

          const rightShow = content !== null;
          const rightAnim = useAnimatedPresence(rightShow, "animate-panel-in-right", "animate-panel-out-right");
          if (!rightAnim.render && !rightShow) return null;

          const displayContent = rightShow ? content : lastContentRef.current;

          // Mobile: full-screen overlay.
          if (isMobile) {
            return (
              <aside
                className={`absolute inset-0 z-30 flex flex-col bg-canvas ${rightAnim.className || "animate-fade-in"}`}
                onAnimationEnd={rightAnim.onAnimationEnd}
              >
                {displayContent}
              </aside>
            );
          }
          // Desktop: bordered split pane with a left-edge drag handle.
          return (
            <aside
              className={`relative flex shrink-0 flex-col border-l border-border ${rightAnim.className}`}
              style={{ width: rightPanelWidth }}
              onAnimationEnd={rightAnim.onAnimationEnd}
            >
              <div
                onPointerDown={startRightResize}
                className="absolute left-0 top-0 z-10 h-full w-1 cursor-col-resize bg-transparent transition-colors hover:bg-accent-dim/50"
                title="拖动调整宽度"
              />
              {displayContent}
            </aside>
          );
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

      {/* Command palette (⌘/Ctrl+K): fuzzy-search conversations + actions. */}
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} actions={paletteActions} />
    </div>
  );
}
