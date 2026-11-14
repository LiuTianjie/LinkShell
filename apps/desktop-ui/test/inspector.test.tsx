import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStore } from "zustand/vanilla";
import type {
  ClientActions,
  ClientState,
  ClientStore,
  HostLink,
  HostStreams,
  SessionView,
} from "@linkshell/client-core";
import type {
  BackgroundTask,
  DirectoryEntry,
  GitDiffFile,
  McpApp,
  PortInfo,
  SessionGoal,
  SessionSummary,
  SideChat,
  SubagentInfo,
  TerminalInfo,
  WorktreeEntry,
} from "@linkshell/wire";
import { RpcError } from "@linkshell/wire";
import { setDesktopLocalePreference, I18nProvider } from "../src/core/i18n";
import { diffReviewStore } from "../src/core/line-diff";
import { engine } from "../src/core/engine";
import { routerStore } from "../src/core/router-store";
import { resetDesktopStorageForTests } from "../src/core/storage";
import { hasUnsavedWork } from "../src/core/unsaved-work";
import type { Computer, Connection } from "../src/core/connections";
import {
  BottomTerminalDock,
  InspectorWorkbench,
  StandaloneToolWorkspace,
  openInspectorTab,
  resetInspectorTabsForTests,
} from "../src/features/inspector";
import {
  sessionChangesFromView,
  toRepoRelativePath,
} from "../src/features/inspector/ChangesPanel";
import { appendPreviewError } from "../src/core/port-tabs";
import { applySetCookie } from "../src/features/inspector/PreviewPanel";
import {
  buildCompactChangeTree,
  formatCompactStat,
  resolveFileExtBadge,
} from "../src/features/inspector/file-ext-badge";
import {
  findTerminalUrls,
  getTerminalStageController,
  resetTerminalStagesForTests,
  shellQuotePath,
} from "../src/features/inspector/terminal-runtime";
import {
  closeActiveInspectorTab,
  cycleInspectorTab,
  getInspectorScopeTabs,
  openFileTabInInspector,
  requestCloseInspectorTab,
} from "../src/features/inspector/inspector-tabs-store";
import { DialogProvider } from "../src/primitives";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

interface MockConnectionRig {
  connection: Connection;
  store: ClientStore;
  callSpy: ReturnType<typeof vi.fn>;
  sendSpy: ReturnType<typeof vi.fn>;
  stopTaskSpy: ReturnType<typeof vi.fn>;
  loadTaskOutputSpy: ReturnType<typeof vi.fn>;
  askSideSpy: ReturnType<typeof vi.fn>;
  openSubagentSpy: ReturnType<typeof vi.fn>;
  closeSubagentSpy: ReturnType<typeof vi.fn>;
  removeWorktreeSpy: ReturnType<typeof vi.fn>;
  emitNotification: (method: string, payload: unknown) => void;
  /** Fires the link's `onOnline` listeners, as a reconnect does. */
  goOnline: () => void;
}

function createMockConnectionRig(overrides?: {
  computerKey?: string;
  sessionId?: string;
  sessionAgent?: string;
  cwd?: string;
  platform?: string;
  view?: SessionView;
  gitFiles?: GitDiffFile[];
  dirEntries?: DirectoryEntry[];
  fileContents?: Record<string, { kind: "text" | "binary"; text?: string; size: number }>;
  terminals?: TerminalInfo[];
  ports?: PortInfo[];
  subagents?: SubagentInfo[];
  tasks?: Record<string, BackgroundTask>;
  sides?: SideChat[];
  mcpApps?: McpApp[];
  worktrees?: WorktreeEntry[];
  goal?: SessionGoal | null;
}): MockConnectionRig {
  const computerKey = overrides?.computerKey ?? "comp-local";
  const sessionId = overrides?.sessionId ?? "sess-1";
  const cwd = overrides?.cwd ?? "/Users/dev/project";

  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  let termCounter = (overrides?.terminals?.length ?? 0) + 1;
  const liveTerminals: TerminalInfo[] = [...(overrides?.terminals ?? [])];
  let currentGoal: SessionGoal | null = overrides?.goal ?? null;
  const currentWorktrees: WorktreeEntry[] = [...(overrides?.worktrees ?? [])];

  const sendSpy = vi.fn(async (_sid: string, _blocks: unknown[]) => undefined);
  const stopTaskSpy = vi.fn(async (_sid: string, _tid: string) => undefined);
  const loadTaskOutputSpy = vi.fn(
    async (_sid: string, _tid: string, _before?: number) => ({
      text: "vite v6.0.0 building for production...\n✓ built in 412ms\n",
      start: 0,
      size: 58,
    }),
  );
  const askSideSpy = vi.fn(async (_sid: string, text: string) => ({
    sideId: "side-new",
    createdAt: Date.now(),
    running: false,
    revision: 1,
    messages: [
      { id: "m1", role: "user" as const, text },
      { id: "m2", role: "assistant" as const, text: "Side answer ready." },
    ],
  }));
  const openSubagentSpy = vi.fn(async (_sid: string, _toolCallId: string) => undefined);
  const closeSubagentSpy = vi.fn((_sid: string, _toolCallId: string) => undefined);
  const removeWorktreeSpy = vi.fn(async (path: string, _force?: boolean) => {
    const idx = currentWorktrees.findIndex((w) => w.path === path);
    if (idx >= 0) currentWorktrees.splice(idx, 1);
  });

  const callSpy = vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
    switch (method) {
      case "git.diff":
        return {
          branch: "feat/workbench",
          files: overrides?.gitFiles ?? [],
        };
      case "git.commit":
        return {
          sha: "abcdef1234567890",
          branch: "feat/workbench",
          summary: String(params.message ?? ""),
        };
      case "git.revertFile":
        return { ok: true };
      case "fs.list":
        return {
          path: String(params.path || cwd),
          parent: "/Users/dev",
          home: "/Users/dev",
          entries: overrides?.dirEntries ?? [],
        };
      case "fs.projectFiles":
        return { files: [], truncated: false };
      case "fs.search":
        return { entries: [], truncated: false };
      case "fs.read": {
        const path = String(params.path ?? "");
        const found = overrides?.fileContents?.[path] ?? {
          kind: "text" as const,
          text: "line 1\nconst answer = 42;\nexport default answer;\n",
          size: 49,
        };
        return {
          path,
          size: found.size,
          modifiedAt: Date.now(),
          kind: found.kind,
          text: found.text,
          truncated: false,
        };
      }
      case "fs.write":
        return { ok: true };
      case "desktop.openPath":
        return { ok: true };
      case "terminals.list":
        return { terminals: [...liveTerminals] };
      case "terminals.create": {
        const id = `term-${termCounter++}`;
        const created: TerminalInfo = {
          id,
          cwd: String(params.cwd ?? cwd),
          sessionId: typeof params.sessionId === "string" ? params.sessionId : undefined,
          cols: 80,
          rows: 24,
          createdAt: Date.now(),
          activeAt: Date.now(),
          title: `zsh (${id})`,
        };
        liveTerminals.push(created);
        return { terminal: created };
      }
      case "terminals.attach":
        return {
          terminal:
            liveTerminals.find((t) => t.id === params.terminalId) ?? {
              id: String(params.terminalId),
              cwd,
              cols: 80,
              rows: 24,
              createdAt: Date.now(),
            },
          replay: `$ echo ready-${String(params.terminalId)}\r\nready-${String(params.terminalId)}\r\n`,
          reset: true,
          seq: 1,
        };
      case "terminals.detach":
      case "terminals.input":
      case "terminals.resize":
      case "terminals.close":
        return {};
      case "ports.list":
        return { ports: overrides?.ports ?? [] };
      case "sessions.goal": {
        const change = params.change as
          | { action: "get" }
          | { action: "set"; objective: string }
          | { action: "pause" }
          | { action: "resume" }
          | { action: "clear" };
        if (change.action === "set") {
          currentGoal = {
            objective: change.objective,
            status: "active",
            iterations: 1,
            tokensUsed: 1200,
          };
        } else if (change.action === "pause" && currentGoal) {
          currentGoal = { ...currentGoal, status: "paused" };
        } else if (change.action === "resume" && currentGoal) {
          currentGoal = { ...currentGoal, status: "active" };
        } else if (change.action === "clear") {
          currentGoal = null;
        }
        return { goal: currentGoal };
      }
      case "sessions.cancelSubagent":
        return {};
      case "mcp.apps":
        return { apps: overrides?.mcpApps ?? [] };
      case "mcp.resource":
        return {
          mimeType: "text/html;profile=mcp-app",
          text: "<html><head></head><body><main id='mcp-app-root'>Inspector MCP Ready</main></body></html>",
          meta: {
            ui: {
              csp: {
                connectDomains: ["https://api.example.com"],
              },
            },
          },
        };
      case "mcp.call":
        return {
          content: [{ type: "text", text: "Tool result ok" }],
        };
      default:
        return {};
    }
  });

  const sessionSummary: SessionSummary = {
    id: sessionId,
    agent: overrides?.sessionAgent ?? "codex",
    nativeId: sessionId,
    cwd,
    title: "Workbench Feature Session",
    state: "idle",
    pendingPermissions: 0,
    lastSeq: 5,
    archived: false,
    createdAt: Date.now() - 10_000,
    updatedAt: Date.now(),
  };

  const defaultView: SessionView =
    overrides?.view ??
    ({
      items: [
        {
          kind: "tool",
          id: "call-edit-1",
          title: "Edit src/app.ts",
          toolKind: "edit",
          status: "completed",
          content: [
            {
              type: "diff",
              path: "src/app.ts",
              oldText: "const count = 1;\n",
              newText: "const count = 2;\nexport const ready = true;\n",
            },
          ],
          output: "",
          ts: Date.now(),
        },
      ],
      state: "idle",
      pendingPermissions: [],
      configOptions: [],
    } as unknown as SessionView);

  const store = createStore<ClientState & ClientActions>(() => ({
    status: "online",
    error: undefined,
    machine: {
      machineId: "mach-1",
      hostname: "Studio-Mac",
      platform: overrides?.platform ?? "darwin",
      hostVersion: "2.0.0",
      protocol: 3,
      home: overrides?.platform === "win32" ? "C:\\Users\\dev" : "/Users/dev",
      agents: [{ id: "codex", name: "Codex", installed: true }],
    },
    sessions: { [sessionId]: sessionSummary },
    views: { [sessionId]: defaultView },
    subagentViews: {},
    subagents: { [sessionId]: overrides?.subagents ?? [] },
    tasks: { [sessionId]: overrides?.tasks ?? {} },
    sides: { [sessionId]: overrides?.sides ?? [] },
    projects: [],
    send: sendSpy,
    gitInfo: vi.fn(async () => ({ branch: "feat/workbench" })),
    loadTasks: vi.fn(async () => Object.values(overrides?.tasks ?? {})),
    loadTaskOutput: loadTaskOutputSpy,
    stopTask: stopTaskSpy,
    loadSubagents: vi.fn(async () => overrides?.subagents ?? []),
    openSubagent: openSubagentSpy,
    closeSubagent: closeSubagentSpy,
    loadSides: vi.fn(async () => overrides?.sides ?? []),
    askSide: askSideSpy,
    cancelSide: vi.fn(async () => undefined),
    closeSide: vi.fn(async () => undefined),
    listWorktrees: vi.fn(async () => [...currentWorktrees]),
    removeWorktree: removeWorktreeSpy,
    openSession: vi.fn(),
  } as unknown as ClientState & ClientActions)) as unknown as ClientStore;

  const computer: Computer = {
    key: computerKey,
    gateway: "local",
    machine: {
      id: "mach-1",
      name: "Studio-Mac",
      platform: overrides?.platform ?? "darwin",
      signKey: "pk",
      boxKey: "bk",
      online: true,
      via: "paired",
    },
  };

  const onlineListeners = new Set<() => void>();
  const link = {
    call: callSpy,
    onOnline: (fn: () => void) => {
      onlineListeners.add(fn);
      return () => {
        onlineListeners.delete(fn);
      };
    },
    on: (method: string, fn: (payload: unknown) => void) => {
      let set = listeners.get(method);
      if (!set) {
        set = new Set();
        listeners.set(method, set);
      }
      set.add(fn);
      return () => {
        set?.delete(fn);
      };
    },
  } as unknown as HostLink;

  const connection: Connection = {
    computer,
    link,
    streams: {} as HostStreams,
    store,
    sessions: {
      acquire: () => () => undefined,
      close: () => undefined,
    } as unknown as Connection["sessions"],
  };

  engine.state.setState({
    computers: [computer],
    localComputer: computer,
    connection,
    ready: true,
  });

  return {
    connection,
    store,
    callSpy,
    sendSpy,
    stopTaskSpy,
    loadTaskOutputSpy,
    askSideSpy,
    openSubagentSpy,
    closeSubagentSpy,
    removeWorktreeSpy,
    goOnline() {
      for (const fn of [...onlineListeners]) fn();
    },
    emitNotification(method, payload) {
      for (const fn of listeners.get(method) ?? []) {
        fn(payload);
      }
    },
  };
}

async function flushAsync(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 15));
  });
}

describe("Phase 2B Slice 3: Inspector Workbench, Atomic Dockable Terminal & Standalone Tools", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    resetDesktopStorageForTests();
    setDesktopLocalePreference("zh");
    diffReviewStore.setState({ bySession: {} });
    resetTerminalStagesForTests();
    resetInspectorTabsForTests();
    routerStore.setState({
      inspectorOpen: true,
      inspectorTab: "new-tab",
      inspectorTabRequestSeq: 0,
      inspectorWidth: 420,
      bottomDockOpen: false,
      bottomDockHeight: 240,
    });
    window.__LINKSHELL_CONFIG__ = {
      desktop: true,
      desktopPlatform: "darwin",
      previewOrigin: "http://127.0.0.1:41999",
    };

    if (!HTMLElement.prototype.scrollIntoView) {
      HTMLElement.prototype.scrollIntoView = () => undefined;
    }

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    resetTerminalStagesForTests();
    resetInspectorTabsForTests();
    container.remove();
    delete window.__LINKSHELL_CONFIG__;
    vi.restoreAllMocks();
  });

  it("enforces CSS @layer components, content-visibility virtualization, and zero banned icon/UI imports", () => {
    const cssPath = resolve(__dirname, "../src/styles/inspector.css");
    const cssText = readFileSync(cssPath, "utf8");
    expect(cssText.trimStart().startsWith("@layer components {")).toBe(true);
    expect(cssText).not.toContain("!important");
    expect(cssText).not.toMatch(/\bscale\(/);
    expect(cssText).not.toContain("overflow: hidden");
    expect(cssText).toContain("content-visibility: hidden");
    expect(cssText).toContain("content-visibility: auto");
    expect(cssText).toContain("contain-intrinsic-size: auto 96px");
    expect(cssText).toContain("@container inspector-pane (max-width: 480px)");
    expect(cssText).toContain(
      '.inspector-tabs .ls-tab:not([aria-selected="true"]) .inspector-tab-title',
    );
    expect(cssText).toContain("inset-inline-start: 0;");
    expect(cssText).not.toContain("inset-inline-start: -3px");

    // Paseo compact folder tree & extension badge helpers
    expect(
      toRepoRelativePath(
        "/Users/dev/claude-remote/apps/desktop-ui/src/theme.ts",
        "/Users/dev/claude-remote",
      ),
    ).toBe("apps/desktop-ui/src/theme.ts");
    expect(formatCompactStat(42)).toBe("42");
    expect(formatCompactStat(1920)).toBe("1.9k");
    expect(resolveFileExtBadge("packages/website/src/atoms.tsx")).toEqual({
      label: "TSX",
      tone: "tsx",
    });
    expect(resolveFileExtBadge("styles/mockup.css")).toEqual({
      label: "CSS",
      tone: "css",
    });
    const tree = buildCompactChangeTree([
      {
        key: "k1",
        path: "packages/website/src/atoms.tsx",
        added: 55,
        removed: 18,
      },
      {
        key: "k2",
        path: "packages/website/src/chat.tsx",
        added: 145,
        removed: 12,
      },
    ]);
    expect(tree).toHaveLength(1);
    expect(tree[0]!.kind).toBe("folder");
    if (tree[0]!.kind === "folder") {
      expect(tree[0]!.label).toBe("packages/website/src");
      expect(tree[0]!.added).toBe(200);
      expect(tree[0]!.removed).toBe(30);
    }

    const inspectorDir = resolve(__dirname, "../src/features/inspector");
    const sourceFiles = readdirSync(inspectorDir).filter((f) =>
      /\.(ts|tsx)$/.test(f),
    );
    expect(sourceFiles.length).toBeGreaterThanOrEqual(9);
    for (const file of sourceFiles) {
      const src = readFileSync(resolve(inspectorDir, file), "utf8");
      expect(src).not.toContain("lucide-react");
      expect(src).not.toContain("@radix-ui/");
      expect(src).not.toContain("@floating-ui/");
      expect(src).not.toContain("dangerouslySetInnerHTML");
    }
  });

  it("renders Antigravity/Codex browser-style .ls-inspector-header, InspectorNewTabView 2x3 tools grid + port shortcut + environment strip, keepMounted tabs, width toggle, and tab close", async () => {
    createMockConnectionRig({
      mcpApps: [
        {
          server: "linear",
          tool: "board",
          title: "Linear Board",
          resourceUri: "ui://linear/board",
          entrypoints: ["thread"],
        },
      ],
    });

    await act(async () => {
      root.render(
        <I18nProvider>
          <DialogProvider>
            <InspectorWorkbench
              computerKey="comp-local"
              sessionId="sess-1"
              cwd="/Users/dev/project"
            />
          </DialogProvider>
        </I18nProvider>,
      );
    });
    await flushAsync();

    const header = container.querySelector<HTMLElement>(
      "header.chrome-bar.desktop-inspector-header.ls-inspector-header",
    )!;
    expect(header).not.toBeNull();

    const tablist = header.querySelector<HTMLElement>('[role="tablist"]')!;
    expect(tablist.getAttribute("focusgroup")).toBe("tablist nomemory");

    // Cold boot opens `new-tab` (`新标签页`) with Row 1 pill search, Row 2 2x3 tools grid,
    // Row 3 omitted (0 subagents), and Row 4 borderless environment strip
    const initialTabs = Array.from(
      tablist.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
    );
    expect(initialTabs.map((t) => t.dataset.tabValue)).toEqual(["new-tab"]);

    const newTabView = container.querySelector<HTMLElement>(
      '[data-testid="inspector-new-tab"]',
    )!;
    expect(newTabView).not.toBeNull();
    const searchInput = newTabView.querySelector<HTMLInputElement>(
      'input[type="search"]',
    )!;
    expect(searchInput.placeholder).toBe("搜索文件或输入端口 / 网址");
    expect(searchInput.placeholder).not.toContain("…");

    // Row 3 `子代理` must NOT render an empty box when subagents count is 0, while `MCP 插件` renders direct 1-click rows!
    expect(
      newTabView.querySelector('[data-testid="inspector-newtab-subagents"]'),
    ).toBeNull();
    expect(newTabView.textContent).not.toContain("子代理");
    expect(
      newTabView.querySelector(
        '[data-testid="inspector-newtab-mcp"] .ls-newtab__subagent-row',
      )?.textContent,
    ).toContain("Linear Board");

    // Row 4 `环境与上下文` shows Studio-Mac, folder basename, and git branch
    expect(newTabView.textContent).toContain("Studio-Mac");
    expect(newTabView.textContent).toContain("project");
    expect(newTabView.textContent).toContain("feat/workbench");

    // Row 2 2x3 `工具` grid has 6 cards; `变更` card shows +2 -1 tabular stat
    const toolCards = Array.from(
      newTabView.querySelectorAll<HTMLButtonElement>(".ls-newtab__tool-card"),
    );
    expect(toolCards).toHaveLength(6);
    expect(toolCards[0]!.textContent).toContain("变更");
    expect(toolCards[0]!.textContent).toContain("+2");
    expect(toolCards[0]!.textContent).toContain("-1");

    // Clicking `变更` opens `changes` tab with `.inspector-diff-stat-pill`
    await act(async () => {
      toolCards[0]!.click();
    });
    await flushAsync();

    let tabs = Array.from(tablist.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    expect(tabs.map((t) => t.dataset.tabValue)).toEqual(["changes"]);
    const statPill = tabs[0]!.querySelector<HTMLElement>(".inspector-diff-stat-pill")!;
    expect(statPill).not.toBeNull();
    expect(statPill.hasAttribute("data-tabular")).toBe(true);
    expect(statPill.textContent).toBe("+2-1");

    const changesPanelEl = container.querySelector<HTMLElement>(
      '[role="tabpanel"][data-tab-kind="changes"]',
    )!;
    expect(changesPanelEl.getAttribute("data-inactive")).toBeNull();

    // Clicking `[+]` outside tablist opens `new-tab` while keeping `changes` mounted (`data-inactive="true"`)
    const plusBtn = header.querySelector<HTMLButtonElement>(
      'button[aria-label="新标签页"]',
    )!;
    expect(plusBtn).not.toBeNull();
    await act(async () => {
      plusBtn.click();
    });
    expect(changesPanelEl.isConnected).toBe(true);
    expect(changesPanelEl.getAttribute("data-inactive")).toBe("true");

    // Typing `3000` in pill search and submitting replaces `new-tab` with `ports` tab!
    const freshSearch = container.querySelector<HTMLInputElement>(
      '[data-testid="inspector-new-tab"] input[type="search"]',
    )!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(freshSearch, "3000");
      freshSearch.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      freshSearch.form!.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    await flushAsync();

    tabs = Array.from(tablist.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    expect(tabs.map((t) => t.dataset.tabValue)).toEqual(["changes", "ports"]);

    // Header actions: width toggle `[⤢]` (380 <-> 580) and close panel `[◨]`
    const widenBtn = header.querySelector<HTMLButtonElement>(
      'button[aria-label="加宽面板"]',
    )!;
    expect(widenBtn).not.toBeNull();
    await act(async () => {
      widenBtn.click();
    });
    expect(routerStore.getState().inspectorWidth).toBe(580);

    const narrowBtn = header.querySelector<HTMLButtonElement>(
      'button[aria-label="恢复面板宽度"]',
    )!;
    expect(narrowBtn).not.toBeNull();
    await act(async () => {
      narrowBtn.click();
    });
    expect(routerStore.getState().inspectorWidth).toBe(380);

    // Closing open tabs via `.ls-inspector-tab__close` restores `new-tab` when last tab closes
    for (const tabEl of Array.from(
      tablist.querySelectorAll<HTMLElement>(".ls-inspector-tab__close"),
    )) {
      await act(async () => {
        tabEl.click();
      });
    }
    tabs = Array.from(tablist.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    expect(tabs.map((t) => t.dataset.tabValue)).toEqual(["new-tab"]);

    // Open `terminal` tab -> dock-to-bottom button renders on header
    await act(async () => {
      openInspectorTab("comp-local", "sess-1", {
        id: "terminal",
        kind: "terminal",
      });
    });
    await flushAsync();
    expect(
      header.querySelector('button[aria-label="停靠到底部终端栏"]'),
    ).not.toBeNull();

    const collapseBtn = header.querySelector<HTMLButtonElement>(
      'button[aria-label="显示或隐藏右侧面板"]',
    )!;
    expect(collapseBtn).not.toBeNull();
    await act(async () => {
      collapseBtn.click();
    });
    expect(routerStore.getState().inspectorOpen).toBe(false);
  });

  it("ChangesPanel supports session/git mode, unified/split diff, inline line review -> Agent, git.commit, and destructive git.revertFile guard", async () => {
    const rig = createMockConnectionRig({
      gitFiles: [
        {
          path: "/Users/dev/project/apps/desktop-ui/src/git-changed.ts",
          status: "modified",
          oldText: "export const a = 1;\n",
          newText: "export const a = 2;\n",
          additions: 1,
          deletions: 1,
        },
      ],
    });
    openInspectorTab("comp-local", "sess-1", { id: "changes", kind: "changes" });

    await act(async () => {
      root.render(
        <I18nProvider>
          <DialogProvider>
            <InspectorWorkbench
              computerKey="comp-local"
              sessionId="sess-1"
              cwd="/Users/dev/project"
            />
          </DialogProvider>
        </I18nProvider>,
      );
    });
    await flushAsync();

    // Single merged top header row (zero stacked .inspector-paseo-summarybar clutter)
    expect(container.querySelector(".inspector-paseo-branchbar")).not.toBeNull();
    expect(container.querySelector(".inspector-paseo-summarybar")).toBeNull();
    expect(container.querySelector(".inspector-commit-bar")).toBeNull();

    // Switch Unified -> Split diff view
    const splitBtn = container.querySelector<HTMLButtonElement>(
      'button[aria-label="并排视图"]',
    )!;
    await act(async () => {
      splitBtn.click();
    });
    expect(container.querySelector(".inspector-diff-split-row")).not.toBeNull();

    // Add inline line review comment and 1-click send to Agent
    const addCommentBtn = container.querySelector<HTMLButtonElement>(
      ".inspector-diff-comment-btn",
    )!;
    await act(async () => {
      addCommentBtn.click();
    });

    const commentBox = container.querySelector<HTMLTextAreaElement>(
      ".inspector-review-box textarea",
    )!;
    expect(commentBox).not.toBeNull();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      setter?.call(commentBox, "请保持向后兼容导出");
      commentBox.dispatchEvent(new Event("input", { bubbles: true }));
      commentBox.dispatchEvent(new Event("change", { bubbles: true }));
    });

    const sendReviewBtn = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".inspector-review-box button"),
    ).find((b) => b.textContent?.includes("发送批注给 Agent"))!;
    await act(async () => {
      sendReviewBtn.click();
    });
    await flushAsync();

    expect(rig.sendSpy).toHaveBeenCalledTimes(1);
    expect(String(rig.sendSpy.mock.calls[0]?.[1]?.[0]?.text)).toContain(
      "请保持向后兼容导出",
    );

    // Switch to Git Working Tree mode -> repo-relative tree + filename-first diff card header
    const gitModeBtn = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Git 工作区"]',
    )!;
    await act(async () => {
      gitModeBtn.click();
    });
    const treeEl = container.querySelector<HTMLElement>(
      '.inspector-change-tree[role="tree"]',
    )!;
    expect(treeEl).not.toBeNull();
    expect(treeEl.textContent).toContain("apps/desktop-ui/src");
    expect(treeEl.textContent).not.toContain("Users/dev/project");
    expect(
      container.querySelector(".inspector-diff-card__basename")?.textContent,
    ).toBe("git-changed.ts");
    expect(
      container.querySelector(".inspector-diff-card__dir")?.textContent,
    ).toBe("apps/desktop-ui/src");
    expect(
      container.querySelector('.inspector-ext-badge[data-ext-tone="ts"]')
        ?.textContent,
    ).toBe("TS");

    // Open collapsible commit tray via single-row header commit button and run git.commit
    const commitToggleBtn = container.querySelector<HTMLButtonElement>(
      'button[data-commit-toggle="true"]',
    )!;
    expect(commitToggleBtn).not.toBeNull();
    await act(async () => {
      commitToggleBtn.click();
    });

    const commitInput = container.querySelector<HTMLInputElement>(
      'input[aria-label="提交改动"]',
    )!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(commitInput, "feat: refine inspector");
      commitInput.dispatchEvent(new Event("input", { bubbles: true }));
      commitInput.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const commitBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "提交改动",
    )!;
    await act(async () => {
      commitBtn.click();
    });
    await flushAsync();
    expect(rig.callSpy).toHaveBeenCalledWith("git.commit", {
      cwd: "/Users/dev/project",
      message: "feat: refine inspector",
      stageAll: true,
    });

    // Destructive git.revertFile requires confirmation dialog before calling RPC
    const revertBtn = container.querySelector<HTMLButtonElement>(
      'button[aria-label="还原文件"]',
    )!;
    await act(async () => {
      revertBtn.click();
    });
    await flushAsync();

    expect(
      rig.callSpy.mock.calls.some((c) => c[0] === "git.revertFile"),
    ).toBe(false);

    const dialogConfirmBtn = Array.from(
      document.querySelectorAll<HTMLButtonElement>("dialog button"),
    ).find((b) => b.textContent?.trim() === "还原文件")!;
    expect(dialogConfirmBtn).not.toBeNull();
    await act(async () => {
      dialogConfirmBtn.click();
    });
    await flushAsync();

    expect(rig.callSpy).toHaveBeenCalledWith("git.revertFile", {
      cwd: "/Users/dev/project",
      path: "/Users/dev/project/apps/desktop-ui/src/git-changed.ts",
    });
  });

  it("FilesPanel renders pure full-width explorer, opens dedicated per-file tabs (FileViewerTabPanel) with #L<n>C<m> highlight, Markdown preview/source, Mod+S save, and fs.projectFiles monorepo fallback", async () => {
    const rig = createMockConnectionRig({
      dirEntries: [],
      fileContents: {
        "/Users/dev/project/README.md": {
          kind: "text",
          text: "# Hello Workbench\n\n- item one\n\n| Service | Endpoint |\n| --- | --- |\n| `@ptw/gateway` | `GET /readyz` |\n",
          size: 103,
        },
        "/Users/dev/project/src/index.ts": {
          kind: "text",
          text: "const alpha = 1;\nconst targetLine = 2;\nconst omega = 3;\n",
          size: 56,
        },
        "/Users/dev/project/packages/sdk/error-message.ts": {
          kind: "text",
          text: "export function formatSdkError(msg: string) {\n  return msg.trim();\n}\n",
          size: 69,
        },
      },
    });
    const origImpl = rig.callSpy.getMockImplementation();
    rig.callSpy.mockImplementation(async (method: string, params?: Record<string, unknown>) => {
      if (
        method === "fs.read" &&
        params?.path === "/Users/dev/project/error-message.ts"
      ) {
        throw RpcError.app("not_found", "找不到文件：/Users/dev/project/error-message.ts");
      }
      if (method === "fs.projectFiles") {
        return {
          files: [
            {
              path: "/Users/dev/project/packages/sdk/error-message.ts",
              relativePath: "packages/sdk/error-message.ts",
              isDir: false,
            },
          ],
          truncated: false,
        };
      }
      return origImpl ? origImpl(method, params as never) : {};
    });

    routerStore.setState({ inspectorTab: "files" });

    await act(async () => {
      root.render(
        <I18nProvider>
          <DialogProvider>
            <InspectorWorkbench
              computerKey="comp-local"
              sessionId="sess-1"
              cwd="/Users/dev/project"
            />
          </DialogProvider>
        </I18nProvider>,
      );
    });
    await flushAsync();

    // Pure full-width explorer (.ls-files-explorer + single .ls-files-header, zero split-pane viewer)
    expect(container.querySelector(".ls-files-explorer")).not.toBeNull();
    expect(container.querySelector(".ls-files-header")).not.toBeNull();

    // Empty directory renders interactive hidden-files toggle in EmptyState (and overflow menu)
    const emptyHiddenBtn = container.querySelector<HTMLButtonElement>(
      ".ls-files-explorer .ls-empty-state button",
    )!;
    expect(emptyHiddenBtn).not.toBeNull();
    await act(async () => {
      emptyHiddenBtn.click();
    });
    await flushAsync();
    expect(rig.callSpy).toHaveBeenCalledWith(
      "fs.list",
      expect.objectContaining({ hidden: true }),
    );

    // Jump to #L2C5 via desktop command event -> opens dedicated `file:/Users/dev/project/src/index.ts` tab!
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("linkshell-desktop-command", {
          detail: {
            command: "open-file",
            path: "/Users/dev/project/src/index.ts#L2C5",
          },
        }),
      );
    });
    await flushAsync();

    expect(
      container.querySelector(
        '[role="tab"][data-tab-id="file:/Users/dev/project/src/index.ts"]',
      ),
    ).not.toBeNull();
    expect(container.querySelector(".ls-file-tab-panel")).not.toBeNull();

    const preEl = container.querySelector<HTMLPreElement>(
      "pre.inspector-source-scroll",
    )!;
    expect(preEl).not.toBeNull();
    expect(preEl.tabIndex).toBe(0);
    const line2 = preEl.querySelector<HTMLElement>('[data-line-number="2"]')!;
    expect(line2.getAttribute("data-highlighted")).toBe("true");

    // Enter edit mode -> registerUnsavedWork -> save with Meta+S
    const editBtn = Array.from(container.querySelectorAll("button")).find(
      (b) =>
        b.getAttribute("aria-label") === "编辑" ||
        b.textContent?.trim() === "编辑",
    )!;
    expect(editBtn).toBeDefined();
    await act(async () => {
      editBtn.click();
    });

    const editorArea = container.querySelector<HTMLTextAreaElement>(
      "textarea.inspector-editor-textarea",
    )!;
    expect(hasUnsavedWork()).toBe(false);

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      setter?.call(editorArea, "const alpha = 100;\n");
      editorArea.dispatchEvent(new Event("input", { bubbles: true }));
      editorArea.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(hasUnsavedWork()).toBe(true);

    await act(async () => {
      editorArea.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "s",
          metaKey: true,
          bubbles: true,
        }),
      );
    });
    await flushAsync();

    expect(rig.callSpy).toHaveBeenCalledWith(
      "fs.write",
      expect.objectContaining({
        path: "/Users/dev/project/src/index.ts",
        text: "const alpha = 100;\n",
      }),
    );
    expect(hasUnsavedWork()).toBe(false);

    // Open Markdown file in a second dedicated file tab -> both index.ts and README.md tabs coexist!
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("linkshell-desktop-command", {
          detail: {
            command: "open-file",
            path: "/Users/dev/project/README.md",
          },
        }),
      );
    });
    await flushAsync();

    expect(
      container.querySelector(
        '[role="tab"][data-tab-id="file:/Users/dev/project/src/index.ts"]',
      ),
    ).not.toBeNull();
    expect(
      container.querySelector(
        '[role="tab"][data-tab-id="file:/Users/dev/project/README.md"]',
      ),
    ).not.toBeNull();

    const activeFilePanel = Array.from(
      container.querySelectorAll<HTMLElement>(".ls-file-tab-panel"),
    ).at(-1)!;
    expect(
      activeFilePanel.querySelector(".inspector-markdown-body.ls-markdown h1")?.textContent,
    ).toBe("Hello Workbench");
    expect(
      activeFilePanel.querySelector(
        ".inspector-markdown-body.ls-markdown .ls-md-table-wrap table",
      ),
    ).not.toBeNull();
    const sourceToggleBtn = Array.from(
      activeFilePanel.querySelectorAll<HTMLButtonElement>(".inspector-segmented-btn"),
    ).find((b) => b.textContent?.trim() === "源码")!;
    await act(async () => {
      sourceToggleBtn.click();
    });
    expect(activeFilePanel.querySelector("pre.inspector-source-scroll")).not.toBeNull();

    // A stale path is reported as missing; a same-named file is only offered, never opened silently
    // (the old test expected the silent swap, which was the bug).
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("linkshell-desktop-command", {
          detail: {
            command: "open-file",
            path: "/Users/dev/project/error-message.ts#L2",
          },
        }),
      );
    });
    await flushAsync();
    expect(rig.callSpy).toHaveBeenCalledWith(
      "fs.projectFiles",
      expect.objectContaining({
        cwd: "/Users/dev/project",
        query: "error-message.ts",
      }),
    );
    expect(container.textContent).not.toContain("formatSdkError");
    expect(container.textContent).toContain("找不到文件");
    const openOther = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("改为打开 packages/sdk/error-message.ts"),
    )!;
    expect(openOther).toBeDefined();
    await act(async () => {
      openOther.click();
    });
    await flushAsync();
    expect(container.textContent).toContain("formatSdkError");
  });

  it("atomically reparents live terminal DOM via Element.prototype.moveBefore between InspectorWorkbench and BottomTerminalDock without losing xterm state, and enforces 4-tab LRU", async () => {
    const rig = createMockConnectionRig({
      terminals: [
        {
          id: "term-1",
          cwd: "/Users/dev/project",
          sessionId: "sess-1",
          cols: 80,
          rows: 24,
          createdAt: Date.now(),
          activeAt: Date.now(),
          title: "main-shell",
        },
      ],
    });

    // Install real Chromium 152 strict moveBefore spy: throws HierarchyRequestError DOMException
    // if called when either `this` or `node` is disconnected!
    const moveBeforeSpy = vi.fn(function <T extends Node>(
      this: Element,
      node: T,
      child: Node | null,
    ): T {
      if (!node.isConnected || !this.isConnected) {
        throw new DOMException(
          "Failed to execute 'moveBefore' on 'Element': The node to be moved is not in a document.",
          "HierarchyRequestError",
        );
      }
      return this.insertBefore(node, child);
    });
    Element.prototype.moveBefore = moveBeforeSpy;

    await act(async () => {
      openInspectorTab("comp-local", "sess-1", {
        id: "terminal",
        kind: "terminal",
      });
      root.render(
        <I18nProvider>
          <DialogProvider>
            <div className="test-shell">
              <InspectorWorkbench
                computerKey="comp-local"
                sessionId="sess-1"
                cwd="/Users/dev/project"
              />
              <BottomTerminalDock
                computerKey="comp-local"
                sessionId="sess-1"
                cwd="/Users/dev/project"
              />
            </div>
          </DialogProvider>
        </I18nProvider>,
      );
    });
    await flushAsync();

    // Verify no duplicate concurrent terminals.list race on initial mount
    expect(
      rig.callSpy.mock.calls.filter((c) => c[0] === "terminals.list").length,
    ).toBe(1);

    // Select Terminal tab in InspectorWorkbench
    const termTab = container.querySelector<HTMLButtonElement>(
      '[role="tab"][data-tab-value="terminal"]',
    )!;
    await act(async () => {
      termTab.click();
    });
    await flushAsync();

    const inspectorStageBefore = container.querySelector<HTMLElement>(
      "aside.inspector-workbench .inspector-terminal-stage",
    )!;
    const hostNodeBefore = inspectorStageBefore.querySelector<HTMLElement>(
      '[data-terminal-id="term-1"]',
    )!;
    expect(inspectorStageBefore).not.toBeNull();
    expect(hostNodeBefore).not.toBeNull();
    expect(hostNodeBefore.textContent).toContain("ready-term-1");

    // Stream an incremental output chunk before docking to bottom
    await act(async () => {
      rig.emitNotification("terminal.output", {
        terminalId: "term-1",
        seq: 2,
        data: "live-before-reparent\n",
      });
    });
    await flushAsync();
    expect(hostNodeBefore.textContent).toContain("live-before-reparent");

    const callsBeforeDock = moveBeforeSpy.mock.calls.length;

    // Toggle BottomTerminalDock OPEN -> live stage moves atomically into BottomTerminalDock!
    await act(async () => {
      routerStore.getState().toggleBottomDock(true);
    });
    await flushAsync();

    expect(moveBeforeSpy.mock.calls.length).toBeGreaterThan(callsBeforeDock);

    const bottomStage = container.querySelector<HTMLElement>(
      "section.inspector-bottom-dock .inspector-terminal-stage",
    )!;
    const hostNodeInBottom = bottomStage.querySelector<HTMLElement>(
      '[data-terminal-id="term-1"]',
    )!;

    // Exact same DOM node references & scrollback text preserved!
    expect(bottomStage).toBe(inspectorStageBefore);
    expect(hostNodeInBottom).toBe(hostNodeBefore);
    expect(hostNodeInBottom.textContent).toContain("ready-term-1");
    expect(hostNodeInBottom.textContent).toContain("live-before-reparent");

    // Live Light <-> Dark theme sync updates terminal theme immediately (#104 §2.2)
    const prevRootTheme = document.documentElement.dataset.theme;
    const screenMirror = hostNodeInBottom.querySelector<HTMLElement>(
      ".xterm-headless-screen",
    )!;
    expect(screenMirror).not.toBeNull();
    await act(async () => {
      document.documentElement.dataset.theme = "light";
      await Promise.resolve();
    });
    expect(screenMirror.dataset.terminalTheme).toBe("light");
    expect(screenMirror.style.backgroundColor).toBe("rgb(251, 252, 253)");
    await act(async () => {
      document.documentElement.dataset.theme = "dark";
      await Promise.resolve();
    });
    expect(screenMirror.dataset.terminalTheme).toBe("dark");
    expect(screenMirror.style.backgroundColor).toBe("rgb(9, 10, 13)");
    if (prevRootTheme === undefined) {
      delete document.documentElement.dataset.theme;
    } else {
      document.documentElement.dataset.theme = prevRootTheme;
    }

    // Font size + / - buttons clamp within 10..24px
    const largerBtn = container.querySelector<HTMLButtonElement>(
      'section.inspector-bottom-dock button[aria-label="放大字号"]',
    )!;
    await act(async () => {
      largerBtn.click();
    });
    expect(container.querySelector("section.inspector-bottom-dock")?.textContent).toContain(
      "14px",
    );

    // Create 4 more terminals (total 5) -> 1st warm terminal is LRU-evicted and detached on host
    const newTermBtn = container.querySelector<HTMLButtonElement>(
      'section.inspector-bottom-dock button[aria-label="新建终端"]',
    )!;
    for (let i = 0; i < 4; i++) {
      await act(async () => {
        newTermBtn.click();
      });
      await flushAsync();
    }
    expect(rig.callSpy).toHaveBeenCalledWith("terminals.detach", {
      terminalId: "term-1",
    });

    // Toggle BottomTerminalDock CLOSED -> stage moves atomically back to Right Inspector!
    const callsBeforeReturn = moveBeforeSpy.mock.calls.length;
    await act(async () => {
      routerStore.getState().toggleBottomDock(false);
    });
    await flushAsync();

    expect(moveBeforeSpy.mock.calls.length).toBeGreaterThan(callsBeforeReturn);
    const inspectorStageAfter = container.querySelector<HTMLElement>(
      "aside.inspector-workbench .inspector-terminal-stage",
    )!;
    expect(inspectorStageAfter).toBe(inspectorStageBefore);
  });

  it("PreviewPanel renders Launcher + single-bar Active Preview across 9+ ports, bridges openRemotePortExternal IPC, captures runtime errors, and sends fix prompt in 1 click", async () => {
    const ninePorts = Array.from({ length: 9 }, (_, i) => ({
      port: i === 0 ? 5173 : 8000 + i,
      process: i === 0 ? "vite" : `node-${i}`,
      http: true,
      title: i === 0 ? "Vite App" : `Service ${i}`,
      cwd: "/Users/dev/project",
    }));
    const rig = createMockConnectionRig({
      ports: ninePorts,
    });

    const bridgeMessages: Record<string, unknown>[] = [];
    const prevBridge = window.linkshellDesktop;
    window.linkshellDesktop = {
      shell: "electron",
      platform: "darwin",
      postMessage(msg: Record<string, unknown>) {
        bridgeMessages.push(msg);
        if (
          msg.action === "invoke" &&
          msg.method === "openRemotePortExternal" &&
          typeof msg.id === "string"
        ) {
          const params = (msg.params as Record<string, unknown>) ?? {};
          queueMicrotask(() => {
            window.dispatchEvent(
              new CustomEvent("linkshell-desktop-reply", {
                detail: {
                  id: msg.id,
                  ok: true,
                  result: {
                    url: `http://127.0.0.1:${String(params.port)}/`,
                    localPort: Number(params.port),
                  },
                },
              }),
            );
          });
        }
      },
    };

    try {
      routerStore.setState({ inspectorTab: "ports" });

      await act(async () => {
        root.render(
          <I18nProvider>
            <DialogProvider>
              <InspectorWorkbench
                computerKey="comp-local"
                sessionId="sess-1"
                cwd="/Users/dev/project"
              />
            </DialogProvider>
          </I18nProvider>,
        );
      });
      await flushAsync();

      // 1. Launcher mode shows all 9 ports cleanly with explicit `[内部预览]` + `[↗ 外部打开]` (zero .inspector-port-pills chip cloud!)
      expect(container.querySelector(".inspector-port-pills")).toBeNull();
      expect(container.querySelector(".ls-preview-launcher")).not.toBeNull();
      const portRows = container.querySelectorAll(".ls-preview-port-row");
      expect(portRows).toHaveLength(9);

      const firstExternalBtn = portRows[0]!.querySelector<HTMLButtonElement>(
        ".ls-preview-row-external-btn",
      )!;
      expect(firstExternalBtn).not.toBeNull();
      await act(async () => {
        firstExternalBtn.click();
      });
      await flushAsync();
      expect(bridgeMessages).toContainEqual(
        expect.objectContaining({
          action: "invoke",
          method: "openRemotePortExternal",
          params: {
            computerKey: "comp-local",
            port: 5173,
            path: "/",
          },
        }),
      );

      // 2. Clicking `[内部预览]` switches to single-bar Active Preview (`.ls-preview-bar` + `<Popover>` switcher + `.ls-preview-external-btn`)
      const firstPreviewBtn = portRows[0]!.querySelector<HTMLButtonElement>(
        ".ls-preview-row-open-btn",
      )!;
      expect(firstPreviewBtn).not.toBeNull();
      await act(async () => {
        firstPreviewBtn.click();
      });
      await flushAsync();

      expect(container.querySelector(".ls-preview-bar")).not.toBeNull();
      expect(container.querySelector(".ls-preview-port-trigger")).not.toBeNull();
      expect(container.querySelector(".ls-preview-external-btn")).not.toBeNull();
      expect(container.querySelector(".inspector-port-pills")).toBeNull();

      const iframe = container.querySelector<HTMLIFrameElement>(
        "iframe.inspector-preview-iframe",
      )!;
      expect(iframe).not.toBeNull();
      expect(iframe.src).toMatch(
        /^http:\/\/127\.0\.0\.1:41999\/preview\/bridge\.html#/,
      );
      const channel = iframe.dataset.previewChannel!;
      expect(channel.length).toBeGreaterThan(8);

      // 3. Simulate runtime error posted from the isolated preview origin
      await act(async () => {
        window.dispatchEvent(
          new MessageEvent("message", {
            origin: "http://127.0.0.1:41999",
            source: iframe.contentWindow,
            data: {
              channel,
              type: "preview-runtime-error",
              source: "error",
              url: "http://127.0.0.1:5173/src/App.tsx",
              message: "TypeError: Cannot read properties of undefined (reading 'map')",
              stack: "at App (src/App.tsx:18:12)",
            },
          }),
        );
      });
      await flushAsync();

      const errorBanner = container.querySelector<HTMLElement>('[role="alert"]')!;
      expect(errorBanner).not.toBeNull();
      expect(errorBanner.textContent).toContain("捕获到 1 条运行报错");

      const fixBtn = Array.from(errorBanner.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("把报错发给 Agent 修复"),
      )!;
      await act(async () => {
        fixBtn.click();
      });
      await flushAsync();

      expect(rig.sendSpy).toHaveBeenCalledTimes(1);
      const sentPrompt = String(rig.sendSpy.mock.calls[0]?.[1]?.[0]?.text);
      expect(sentPrompt).toContain("5173");
      expect(sentPrompt).toContain("Cannot read properties of undefined");
    } finally {
      window.linkshellDesktop = prevBridge;
    }
  });

  it("TasksPanel, McpAppPanel & StandaloneToolWorkspace render SubagentGlyph, until-found task logs, SEP-1865 CSP srcDoc, and clean idle worktree cleanup", async () => {
    const rig = createMockConnectionRig({
      subagents: [
        {
          toolCallId: "sub-call-1",
          nativeSessionId: "native-sub-1",
          canCancel: true,
          task: "Audit accessibility tokens",
          name: "audit-worker",
          running: true,
          startedAt: Date.now() - 2000,
        },
      ],
      tasks: {
        "task-build": {
          id: "task-build",
          kind: "shell",
          title: "pnpm build",
          command: "pnpm build",
          state: "running",
          startedAt: Date.now() - 1000,
          canStop: true,
        },
      },
      mcpApps: [
        {
          server: "figma",
          tool: "inspect",
          title: "Figma Inspector",
          resourceUri: "ui://figma/inspect",
          entrypoints: ["thread"],
        },
        {
          server: "mirror-srv",
          tool: "mirror",
          title: "StupidMirror",
          resourceUri: "ui://mirror-srv/app",
          entrypoints: ["thread"],
        },
      ],
      worktrees: [
        {
          path: "/Users/dev/.linkshell/worktrees/wt-clean",
          branch: "linkshell/clean-idle",
          source: "/Users/dev/project",
          createdAt: Date.now() - 50_000,
          sessions: [],
          dirty: false,
          ahead: 0,
        },
        {
          path: "/Users/dev/.linkshell/worktrees/wt-dirty",
          branch: "linkshell/active-dirty",
          source: "/Users/dev/project",
          createdAt: Date.now() - 20_000,
          sessions: ["sess-1"],
          dirty: true,
          ahead: 2,
        },
      ],
    });

    await act(async () => {
      root.render(
        <I18nProvider>
          <DialogProvider>
            <InspectorWorkbench
              computerKey="comp-local"
              sessionId="sess-1"
              cwd="/Users/dev/project"
            />
          </DialogProvider>
        </I18nProvider>,
      );
    });
    await flushAsync();

    // 1. On initial `new-tab`, Row 3 `子代理` is rendered because subagents.length === 1!
    const subagentRow = container.querySelector<HTMLButtonElement>(
      '[data-testid="inspector-new-tab"] .ls-newtab__subagent-row',
    )!;
    expect(subagentRow).not.toBeNull();
    expect(subagentRow.textContent).toContain("audit-worker");
    expect(subagentRow.querySelector(".ls-subagent-glyph")).not.toBeNull();

    // Row 4 `环境与上下文` triggers external editor open
    const openEditorBtn = container.querySelector<HTMLButtonElement>(
      '[data-testid="inspector-new-tab"] button[aria-label="在编辑器中打开"]',
    )!;
    expect(openEditorBtn).not.toBeNull();
    await act(async () => {
      openEditorBtn.click();
    });
    await flushAsync();
    expect(rig.callSpy).toHaveBeenCalledWith("desktop.openPath", {
      path: "/Users/dev/project",
      app: "vscode",
    });

    // Clicking the subagent row opens its dedicated `subagent:sub-call-1` tab & calls `openSubagent`!
    await act(async () => {
      subagentRow.click();
    });
    await flushAsync();
    expect(rig.openSubagentSpy).toHaveBeenCalledWith("sess-1", "sub-call-1");
    expect(container.querySelector(".ls-subagent-panel")).not.toBeNull();

    // Open `side` (`侧边问答`) tab -> sculpted `.ls-sidechat-composer-card` `<textarea>`, starter chips, IME Enter guard, and `askSide`
    await act(async () => {
      openInspectorTab("comp-local", "sess-1", { id: "side", kind: "side" });
    });
    await flushAsync();
    const sidePanel = container.querySelector<HTMLElement>(".ls-sidechat-panel")!;
    expect(sidePanel).not.toBeNull();
    expect(
      sidePanel.querySelectorAll(".ls-sidechat-starter-chip").length,
    ).toBeGreaterThanOrEqual(3);
    const sideTextarea = sidePanel.querySelector<HTMLTextAreaElement>(
      "textarea.ls-sidechat-textarea",
    )!;
    expect(sideTextarea).not.toBeNull();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      setter?.call(sideTextarea, "Explain this hook");
      sideTextarea.dispatchEvent(new Event("input", { bubbles: true }));
      sideTextarea.dispatchEvent(new Event("change", { bubbles: true }));
    });

    // CJK IME Enter (`isComposing: true`) MUST NOT submit
    await act(async () => {
      sideTextarea.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
          isComposing: true,
        }),
      );
    });
    expect(rig.askSideSpy).not.toHaveBeenCalled();

    const sideSendBtn = sidePanel.querySelector<HTMLButtonElement>(
      ".ls-sidechat-send-btn",
    )!;
    expect(sideSendBtn).not.toBeNull();
    await act(async () => {
      sideSendBtn.click();
    });
    await flushAsync();
    expect(rig.askSideSpy).toHaveBeenCalledWith(
      "sess-1",
      "Explain this hook",
      undefined,
    );

    // Open `tasks` (`后台任务`) tab -> focused `.ls-tasks-panel` + `.ls-tasks-bar`, running badge (1), and hidden="until-found" CollapsibleLog
    await act(async () => {
      openInspectorTab("comp-local", "sess-1", { id: "tasks", kind: "tasks" });
    });
    await flushAsync();
    expect(container.querySelector(".ls-tasks-panel .ls-tasks-bar")).not.toBeNull();
    const tasksTab = container.querySelector<HTMLButtonElement>(
      '[role="tab"][data-tab-value="tasks"]',
    )!;
    expect(tasksTab.textContent).toContain("1");

    const logPanel = container.querySelector<HTMLElement>(
      ".ls-collapsible-log__panel",
    )!;
    expect(logPanel.getAttribute("hidden")).toBe("until-found");

    // Expand task log -> loads output lazily
    const logTrigger = container.querySelector<HTMLButtonElement>(
      ".ls-collapsible-log__trigger",
    )!;
    await act(async () => {
      logTrigger.click();
    });
    await flushAsync();
    expect(rig.loadTaskOutputSpy).toHaveBeenCalledWith(
      "sess-1",
      "task-build",
      undefined,
    );
    expect(logPanel.getAttribute("hidden")).toBeNull();
    expect(logPanel.textContent).toContain("built in 412ms");

    // 1-click MCP Plugins in `+ 新标签页` open two separate `mcp:<key>` tabs with ZERO `.ls-mcp-bar` (#104 §2.3)
    const newTabBtn = container.querySelector<HTMLButtonElement>(
      "button.ls-inspector-newtab-btn",
    )!;
    expect(newTabBtn).not.toBeNull();
    await act(async () => {
      newTabBtn.click();
    });
    await flushAsync();

    const mcpRows1 = container.querySelectorAll<HTMLButtonElement>(
      '[data-testid="inspector-newtab-mcp"] .ls-newtab__subagent-row',
    );
    expect(mcpRows1.length).toBe(2);
    await act(async () => {
      mcpRows1[0]!.click();
    });
    await flushAsync();

    expect(container.querySelector(".ls-mcp-bar")).toBeNull();
    const mcpIframe = container.querySelector<HTMLIFrameElement>(
      "iframe.inspector-mcp-iframe",
    )!;
    expect(mcpIframe).not.toBeNull();
    expect(mcpIframe.getAttribute("sandbox")).toBe("allow-scripts allow-forms");
    expect(mcpIframe.srcdoc).toContain("Content-Security-Policy");
    expect(mcpIframe.srcdoc).toContain("https://api.example.com");
    expect(mcpIframe.srcdoc).toContain("Inspector MCP Ready");

    // Click `+` again and open the second MCP plugin (`StupidMirror`) in 1 click -> BOTH `mcp:<key>` tabs coexist!
    await act(async () => {
      newTabBtn.click();
    });
    await flushAsync();

    const mcpRows2 = container.querySelectorAll<HTMLButtonElement>(
      '[data-testid="inspector-newtab-mcp"] .ls-newtab__subagent-row',
    );
    expect(mcpRows2[1]?.textContent).toContain("StupidMirror");
    await act(async () => {
      mcpRows2[1]!.click();
    });
    await flushAsync();

    expect(container.querySelector(".ls-mcp-bar")).toBeNull();
    const openMcpTabs = Array.from(
      container.querySelectorAll<HTMLElement>('[role="tab"][data-tab-value="mcp"]'),
    ).map((el) => el.getAttribute("data-tab-id"));
    expect(openMcpTabs.length).toBe(2);
    expect(openMcpTabs[0]).not.toBe(openMcpTabs[1]);

    // Render StandaloneToolWorkspace mode="worktrees" -> unmounting InspectorWorkbench calls `closeSubagent`!
    await act(async () => {
      root.render(
        <I18nProvider>
          <DialogProvider>
            <StandaloneToolWorkspace
              mode="worktrees"
              computerKey="comp-local"
            />
          </DialogProvider>
        </I18nProvider>,
      );
    });
    await flushAsync();
    expect(rig.closeSubagentSpy).toHaveBeenCalledWith("sess-1", "sub-call-1");

    // StandaloneToolWorkspace never renders a duplicate .chrome-bar header (#30 §2)
    expect(
      container.querySelector("section.inspector-standalone .chrome-bar"),
    ).toBeNull();

    const cleanBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("清理干净的闲置 Worktree (1)"),
    )!;
    expect(cleanBtn).not.toBeNull();

    await act(async () => {
      cleanBtn.click();
    });
    await flushAsync();

    // Confirm destructive batch cleanup dialog
    const confirmCleanBtn = Array.from(
      document.querySelectorAll<HTMLButtonElement>("dialog button"),
    ).find((b) => b.textContent?.includes("清理干净的闲置 Worktree (1)"))!;
    expect(confirmCleanBtn).not.toBeNull();
    await act(async () => {
      confirmCleanBtn.click();
    });
    await flushAsync();

    expect(rig.removeWorktreeSpy).toHaveBeenCalledTimes(1);
    expect(rig.removeWorktreeSpy).toHaveBeenCalledWith(
      "/Users/dev/.linkshell/worktrees/wt-clean",
      false,
    );
    expect(container.textContent).toContain("linkshell/active-dirty");
  });

  it("defensively guards malformed {} mcp.apps host responses without crashing InspectorWorkbench", async () => {
    const rig = createMockConnectionRig();
    rig.callSpy.mockImplementation(async (method: string) => {
      if (method === "mcp.apps") return {};
      if (method === "ports.list") return {};
      if (method === "git.diff") return {};
      if (method === "fs.list") return {};
      if (method === "terminals.list") return {};
      return {};
    });

    await act(async () => {
      root.render(
        <I18nProvider>
          <DialogProvider>
            <InspectorWorkbench
              computerKey="comp-local"
              sessionId="sess-1"
              cwd="/Users/dev/project"
            />
          </DialogProvider>
        </I18nProvider>,
      );
    });
    await flushAsync();

    // Opening `mcp` tab via routerStore renders empty state without ErrorBoundary fallback
    await act(async () => {
      routerStore.getState().setInspectorTab("mcp");
    });
    await flushAsync();

    const mcpTab = container.querySelector<HTMLButtonElement>(
      '[role="tab"][data-tab-value="mcp"]',
    )!;
    expect(mcpTab).not.toBeNull();
    expect(container.querySelector(".ls-error-boundary")).toBeNull();
    expect(container.textContent).toContain("暂无可用插件或 MCP 应用");
  });

  it("resets stale directory on cwd/host switch and renders calm inline missing-directory state (zero modal alert) with Open Home fallback", async () => {
    const rig = createMockConnectionRig();
    rig.callSpy.mockImplementation(
      async (method: string, params: Record<string, unknown> = {}) => {
        if (method === "fs.list") {
          const p = String(params.path ?? "");
          if (p.includes("missing-remote-dir")) {
            throw new Error("ENOENT: no such file or directory");
          }
          return {
            path: p || "/Users/dev",
            parent: "/Users",
            home: "/Users/dev",
            entries: [
              {
                name: "index.ts",
                path: `${p || "/Users/dev"}/index.ts`,
                kind: "file",
                size: 42,
              },
            ],
          };
        }
        if (method === "git.diff") return { branch: "main", files: [] };
        if (method === "ports.list") return { ports: [] };
        if (method === "mcp.apps") return { apps: [] };
        return {};
      },
    );

    openInspectorTab("comp-local", "sess-1", { id: "files", kind: "files" });

    await act(async () => {
      root.render(
        <I18nProvider>
          <DialogProvider>
            <InspectorWorkbench
              computerKey="comp-local"
              sessionId="sess-1"
              cwd="/Users/dev/project"
            />
          </DialogProvider>
        </I18nProvider>,
      );
    });
    await flushAsync();
    expect(container.textContent).toContain("index.ts");

    // Switch session cwd to a path missing on the current host -> NO `<dialog open>` alert!
    await act(async () => {
      root.render(
        <I18nProvider>
          <DialogProvider>
            <InspectorWorkbench
              computerKey="comp-local"
              sessionId="sess-2"
              cwd="/Users/other-host/missing-remote-dir"
            />
          </DialogProvider>
        </I18nProvider>,
      );
      openInspectorTab("comp-local", "sess-2", { id: "files", kind: "files" });
    });
    await flushAsync();

    expect(document.querySelector("dialog[open]")).toBeNull();
    expect(container.textContent).toContain("当前主机不存在该目录");

    const openHomeBtn = Array.from(
      container.querySelectorAll<HTMLButtonElement>("button"),
    ).find((b) => b.textContent?.includes("打开主目录"))!;
    expect(openHomeBtn).not.toBeNull();

    await act(async () => {
      openHomeBtn.click();
    });
    await flushAsync();

    expect(rig.callSpy).toHaveBeenCalledWith("fs.list", {
      path: "/Users/dev",
      hidden: false,
      files: true,
    });
    expect(container.textContent).toContain("index.ts");
  });

  it("quotes Windows terminal paths with cmd/PowerShell double quotes, hides Xcode on Windows connections, and renders '在资源管理器中显示' with zero Finder/访达 strings", async () => {
    // 1. shellQuotePath Windows vs POSIX behavior
    expect(shellQuotePath("C:\\Users\\dev\\src\\index.ts", "win32")).toBe(
      "C:\\Users\\dev\\src\\index.ts",
    );
    expect(shellQuotePath("\\\\server\\share\\file_1.ts", "windows")).toBe(
      "\\\\server\\share\\file_1.ts",
    );
    expect(
      shellQuotePath('C:\\Program Files\\My App\\a"b.ts', "win32"),
    ).toBe('"C:\\Program Files\\My App\\a""b.ts"');
    expect(shellQuotePath("C:\\Users\\dev\\my file.txt")).toBe(
      '"C:\\Users\\dev\\my file.txt"',
    );
    expect(shellQuotePath("/Users/dev/my 'file'.txt", "darwin")).toBe(
      `'/Users/dev/my '\\''file'\\''.txt'`,
    );

    // 2. FileViewerTabPanel & FilesPanel on a Windows (`win32`) host connection
    const winRig = createMockConnectionRig({
      computerKey: "comp-win",
      sessionId: "sess-win",
      platform: "win32",
      cwd: "C:\\repo",
      fileContents: {
        "C:\\repo\\src\\main.ts": {
          kind: "text",
          text: "export const win = true;\n",
          size: 25,
        },
      },
      dirEntries: [
        { name: "main.ts", path: "C:\\repo\\src\\main.ts", file: true, size: 25 },
      ],
    });
    engine.state.setState({
      computers: [winRig.connection.computer],
      connection: winRig.connection,
    });

    openFileTabInInspector("comp-win", "sess-win", "C:\\repo\\src\\main.ts:1:1");

    await act(async () => {
      root.render(
        <I18nProvider>
          <DialogProvider>
            <InspectorWorkbench
              computerKey="comp-win"
              sessionId="sess-win"
              cwd="C:\\repo"
            />
          </DialogProvider>
        </I18nProvider>,
      );
    });
    await flushAsync();

    const openMenuTrigger = Array.from(
      container.querySelectorAll<HTMLButtonElement>(
        ".ls-file-tab-header__actions button",
      ),
    ).find((b) => b.textContent?.includes("打开"));
    expect(openMenuTrigger).toBeDefined();

    await act(async () => {
      openMenuTrigger!.click();
    });
    await flushAsync();

    const menuItemsText = Array.from(
      document.querySelectorAll('[role="menuitem"]'),
    ).map((el) => el.textContent?.trim() ?? "");

    expect(menuItemsText).toContain("VS Code");
    expect(menuItemsText).toContain("Cursor");
    expect(menuItemsText).not.toContain("Xcode");
    expect(menuItemsText).toContain("在资源管理器中显示");
    expect(menuItemsText.join(" ")).not.toContain("Finder");
    expect(menuItemsText.join(" ")).not.toContain("访达");
  });

  it("merges a file's repeated session edits into one net diff, which is what the Changes badge counts", () => {
    const tool = (id: string, content: unknown[]) => ({
      kind: "tool",
      id,
      title: id,
      toolKind: "edit",
      status: "completed",
      content,
      output: "",
      ts: Date.now(),
    });
    const view = {
      items: [
        tool("e1", [{ type: "diff", path: "src/a.ts", oldText: "a\n", newText: "b\n" }]),
        tool("e2", [{ type: "diff", path: "src/a.ts", oldText: "b\n", newText: "b\nc\n" }]),
        tool("e3", [{ type: "diff", path: "src/new.ts", newText: "x\ny\n" }]),
        tool("e4", [{ type: "diff", path: "src/same.ts", oldText: "q\n", newText: "r\n" }]),
        tool("e5", [{ type: "diff", path: "src/same.ts", oldText: "r\n", newText: "q\n" }]),
      ],
      state: "idle",
      pendingPermissions: [],
      configOptions: [],
    } as unknown as SessionView;

    const entries = sessionChangesFromView(view, "/Users/dev/project");
    // src/same.ts was changed and changed back: no net change, no entry.
    expect(entries.map((e) => e.path).sort()).toEqual(["src/a.ts", "src/new.ts"]);
    const a = entries.find((e) => e.path === "src/a.ts")!;
    expect([a.added, a.removed]).toEqual([2, 1]);
    expect(a.status).toBe("modified");
    const created = entries.find((e) => e.path === "src/new.ts")!;
    expect(created.status).toBe("added");
    expect(created.added).toBe(2);
  });

  it("re-attaches open terminals after a reconnect, resuming from the last output seq", async () => {
    const rig = createMockConnectionRig({
      terminals: [
        {
          id: "term-1",
          cwd: "/Users/dev/project",
          sessionId: "sess-1",
          cols: 80,
          rows: 24,
          createdAt: Date.now(),
          activeAt: Date.now(),
          title: "zsh",
        },
      ],
    });
    openInspectorTab("comp-local", "sess-1", { id: "terminal", kind: "terminal" });

    await act(async () => {
      root.render(
        <I18nProvider>
          <DialogProvider>
            <InspectorWorkbench computerKey="comp-local" sessionId="sess-1" cwd="/Users/dev/project" />
          </DialogProvider>
        </I18nProvider>,
      );
    });
    await flushAsync();

    const attachCalls = () =>
      rig.callSpy.mock.calls.filter(
        (c) => c[0] === "terminals.attach" && (c[1] as { terminalId?: string }).terminalId === "term-1",
      );
    expect(attachCalls()).toHaveLength(1);

    await act(async () => {
      rig.emitNotification("terminal.output", { terminalId: "term-1", seq: 7, data: "before-drop\r\n" });
    });
    await flushAsync();

    await act(async () => {
      rig.goOnline();
    });
    await flushAsync();

    expect(attachCalls()).toHaveLength(2);
    expect(attachCalls()[1]![1]).toMatchObject({ terminalId: "term-1", fromSeq: 7 });

    // Output after the re-attach reaches the screen again.
    await act(async () => {
      rig.emitNotification("terminal.output", { terminalId: "term-1", seq: 8, data: "after-reconnect" });
    });
    await flushAsync();
    expect(container.querySelector(".inspector-terminal-stage")?.textContent).toContain("after-reconnect");

    // A failed restore offers a retry instead of leaving a blank pane.
    const original = rig.callSpy.getMockImplementation()!;
    rig.callSpy.mockImplementation(async (method: string, params?: Record<string, unknown>) => {
      if (method === "terminals.attach") throw new Error("恢复失败示例");
      return original(method, params as never);
    });
    await act(async () => {
      rig.goOnline();
    });
    await flushAsync();
    const restore = container.querySelector<HTMLElement>(".inspector-terminal-restore");
    expect(restore?.dataset.state).toBe("failed");
    expect(restore?.textContent).toContain("恢复失败示例");
    rig.callSpy.mockImplementation(original);
    const retryBtn = Array.from(restore!.querySelectorAll("button")).find((b) => b.textContent?.includes("重试"))!;
    await act(async () => {
      retryBtn.click();
    });
    await flushAsync();
    expect(container.querySelector(".inspector-terminal-restore")).toBeNull();
    expect(getTerminalStageController("comp-local").store.getState().restore).toEqual({});
  });

  it("asks before closing a tab with an unsaved edit and keeps the draft across a session switch", async () => {
    createMockConnectionRig();
    openFileTabInInspector("comp-local", "sess-1", "/Users/dev/project/src/index.ts");
    const renderFor = async (sessionId: string) => {
      await act(async () => {
        root.render(
          <I18nProvider>
            <DialogProvider>
              <InspectorWorkbench computerKey="comp-local" sessionId={sessionId} cwd="/Users/dev/project" />
            </DialogProvider>
          </I18nProvider>,
        );
      });
      await flushAsync();
    };
    await renderFor("sess-1");

    const editBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "编辑",
    )!;
    await act(async () => {
      editBtn.click();
    });
    const editor = container.querySelector<HTMLTextAreaElement>("textarea.inspector-editor-textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(editor, "draft text\n");
      editor.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(hasUnsavedWork()).toBe(true);
    const tabId = "file:/Users/dev/project/src/index.ts";
    expect(container.querySelector(`.ls-inspector-tab[data-tab-id="${tabId}"]`)?.getAttribute("data-dirty")).toBe("true");

    // Switching sessions unmounts the panel; the draft and its guard survive.
    await renderFor("sess-2");
    expect(container.querySelector("textarea.inspector-editor-textarea")).toBeNull();
    expect(hasUnsavedWork()).toBe(true);
    await renderFor("sess-1");
    expect(container.querySelector<HTMLTextAreaElement>("textarea.inspector-editor-textarea")?.value).toBe("draft text\n");

    // Cancel keeps the tab.
    let closed: Promise<boolean> | undefined;
    await act(async () => {
      closed = requestCloseInspectorTab("comp-local", "sess-1", tabId);
    });
    await flushAsync();
    const cancelBtn = Array.from(document.querySelectorAll<HTMLButtonElement>("dialog button")).find(
      (b) => b.textContent?.trim() === "取消",
    )!;
    await act(async () => {
      cancelBtn.click();
    });
    expect(await closed).toBe(false);
    expect(getInspectorScopeTabs("comp-local", "sess-1").tabs.some((t) => t.id === tabId)).toBe(true);

    // Cmd+W goes through the same guard; discarding closes and releases the guard.
    let handled = false;
    await act(async () => {
      handled = closeActiveInspectorTab();
    });
    expect(handled).toBe(true);
    await flushAsync();
    const discardBtn = Array.from(document.querySelectorAll<HTMLButtonElement>("dialog button")).find(
      (b) => b.textContent?.trim() === "放弃修改",
    )!;
    await act(async () => {
      discardBtn.click();
    });
    await flushAsync();
    expect(getInspectorScopeTabs("comp-local", "sess-1").tabs.some((t) => t.id === tabId)).toBe(false);
    expect(hasUnsavedWork()).toBe(false);
  });

  it("saves through fs.write with the read revision and offers reload or overwrite on conflict", async () => {
    const rig = createMockConnectionRig();
    const original = rig.callSpy.getMockImplementation()!;
    let conflictOnce = true;
    rig.callSpy.mockImplementation(async (method: string, params?: Record<string, unknown>) => {
      if (method === "fs.read") return { ...(await original(method, params as never)), modifiedAt: 1000 };
      if (method === "fs.write" && params?.expectedModifiedAt !== undefined && conflictOnce) {
        conflictOnce = false;
        throw RpcError.app("conflict", "文件已在电脑上被修改");
      }
      if (method === "fs.write") return { path: params?.path, modifiedAt: 2000, size: 6 };
      return original(method, params as never);
    });
    openFileTabInInspector("comp-local", "sess-1", "/Users/dev/project/src/index.ts");
    await act(async () => {
      root.render(
        <I18nProvider>
          <DialogProvider>
            <InspectorWorkbench computerKey="comp-local" sessionId="sess-1" cwd="/Users/dev/project" />
          </DialogProvider>
        </I18nProvider>,
      );
    });
    await flushAsync();
    await act(async () => {
      Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.trim() === "编辑")!.click();
    });
    const editor = container.querySelector<HTMLTextAreaElement>("textarea.inspector-editor-textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(editor, "mine\n");
      editor.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      editor.dispatchEvent(new KeyboardEvent("keydown", { key: "s", metaKey: true, bubbles: true }));
    });
    await flushAsync();
    expect(rig.callSpy).toHaveBeenCalledWith(
      "fs.write",
      expect.objectContaining({ text: "mine\n", expectedModifiedAt: 1000 }),
    );
    const overwrite = Array.from(document.querySelectorAll<HTMLButtonElement>("dialog button")).find(
      (b) => b.textContent?.trim() === "覆盖保存",
    )!;
    expect(overwrite).toBeDefined();
    await act(async () => {
      overwrite.click();
    });
    await flushAsync();
    const writes = rig.callSpy.mock.calls.filter((c) => c[0] === "fs.write");
    expect(writes).toHaveLength(2);
    expect(writes[1]![1]).not.toHaveProperty("expectedModifiedAt");
    expect(hasUnsavedWork()).toBe(false);
  });

  it("hides Edit and says to update when the host has no fs.write and no agent can save", async () => {
    const rig = createMockConnectionRig();
    const original = rig.callSpy.getMockImplementation()!;
    rig.callSpy.mockImplementation(async (method: string, params?: Record<string, unknown>) => {
      if (method === "fs.write") throw RpcError.app("host_outdated", "旧", { method });
      return original(method, params as never);
    });
    openFileTabInInspector("comp-local", "sess-1", "/Users/dev/project/src/index.ts");
    await act(async () => {
      root.render(
        <I18nProvider>
          <DialogProvider>
            <InspectorWorkbench computerKey="comp-local" sessionId="sess-1" cwd="/Users/dev/project" />
          </DialogProvider>
        </I18nProvider>,
      );
    });
    await flushAsync();
    await act(async () => {
      Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.trim() === "编辑")!.click();
    });
    const editor = container.querySelector<HTMLTextAreaElement>("textarea.inspector-editor-textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(editor, "x\n");
      editor.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      editor.dispatchEvent(new KeyboardEvent("keydown", { key: "s", metaKey: true, bubbles: true }));
    });
    await flushAsync();
    // codex is installed but is not an ACP agent: no agents.editor attempt.
    expect(rig.callSpy.mock.calls.some((c) => c[0] === "agents.editor")).toBe(false);
    expect(document.querySelector("dialog[open]")?.textContent).toContain("这台电脑的 LinkShell 版本较旧，更新后才能保存");
  });

  it("keeps the preview frame and its sockets while the address is typed; Enter navigates", async () => {
    createMockConnectionRig({
      ports: [{ port: 5173, process: "vite", http: true, title: "Vite", cwd: "/Users/dev/project" }],
    });
    await act(async () => {
      root.render(
        <I18nProvider>
          <DialogProvider>
            <InspectorWorkbench computerKey="comp-local" sessionId="sess-1" cwd="/Users/dev/project" />
          </DialogProvider>
        </I18nProvider>,
      );
    });
    await flushAsync();
    const { requestOpenPortInInspector } = await import("../src/features/inspector/inspector-tabs-store");
    await act(async () => {
      requestOpenPortInInspector("comp-local", "sess-1", 5173, "/docs");
    });
    await flushAsync();

    const frame = container.querySelector<HTMLIFrameElement>("iframe.inspector-preview-iframe")!;
    expect(frame).not.toBeNull();
    const address = container.querySelector<HTMLInputElement>(".ls-preview-url-input")!;
    expect(address.value).toBe("/docs");

    const removeSpy = vi.spyOn(window, "removeEventListener");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(address, "/docs/api");
      address.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flushAsync();
    expect(removeSpy.mock.calls.filter((c) => c[0] === "message")).toHaveLength(0);
    expect(container.querySelector("iframe.inspector-preview-iframe")).toBe(frame);

    await act(async () => {
      address.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await flushAsync();
    expect(container.querySelector("iframe.inspector-preview-iframe")).not.toBe(frame);

    // "All ports" shows the list without closing the open preview.
    await act(async () => {
      container.querySelector<HTMLButtonElement>(".ls-preview-port-trigger")!.click();
    });
    await flushAsync();
    const listBtn = Array.from(document.querySelectorAll<HTMLButtonElement>(".ls-preview-popover__footer button")).find(
      (b) => b.textContent?.includes("查看全部端口列表"),
    )!;
    await act(async () => {
      listBtn.click();
    });
    await flushAsync();
    expect(container.querySelector(".ls-preview-launcher")).not.toBeNull();
    expect(container.querySelector("iframe.inspector-preview-iframe")).not.toBeNull();

    // Ctrl+Tab cycles tabs of the visible scope.
    openInspectorTab("comp-local", "sess-1", { id: "changes", kind: "changes" });
    await flushAsync();
    expect(getInspectorScopeTabs("comp-local", "sess-1").activeId).toBe("changes");
    await act(async () => {
      cycleInspectorTab(-1);
    });
    expect(getInspectorScopeTabs("comp-local", "sess-1").activeId).toBe("ports");
  });

  it("parses preview cookies with expiry, dedupes repeated preview errors and finds terminal URLs", () => {
    const jar = new Map<string, string>();
    applySetCookie(jar, "sid=abc; Path=/; HttpOnly");
    applySetCookie(jar, "theme=dark=1; Max-Age=3600");
    expect(Object.fromEntries(jar)).toEqual({ sid: "abc", theme: "dark=1" });
    applySetCookie(jar, "sid=; Expires=Thu, 01 Jan 1970 00:00:00 GMT");
    applySetCookie(jar, "theme=; Max-Age=0");
    expect(jar.size).toBe(0);

    const once = appendPreviewError([], { port: 3000, source: "error", message: "boom" });
    const twice = appendPreviewError(once, { port: 3000, source: "error", message: "boom" });
    expect(twice).toHaveLength(1);
    expect(appendPreviewError(twice, { port: 3000, source: "error", message: "other" })).toHaveLength(2);

    expect(findTerminalUrls("  ➜  Local:   http://localhost:5173/, see (https://vitejs.dev).")).toEqual([
      { start: 15, end: 36, url: "http://localhost:5173/" },
      { start: 44, end: 61, url: "https://vitejs.dev" },
    ]);
  });

});
