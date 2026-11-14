import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createStore } from "zustand/vanilla";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  emptyView,
  type ClientActions,
  type ClientState,
  type SessionView,
} from "@linkshell/client-core";
import type {
  MethodResult,
  PendingPermissionSummary,
  SessionSummary,
} from "@linkshell/wire";
import {
  DESKTOP_LOCAL,
  composerDrafts,
  diffReviewStore,
  draftKeyFor,
  engine,
  routerStore,
  type Computer,
  type Connection,
} from "../src/core";
import { DialogProvider } from "../src/primitives";
import {
  INSPECTOR_OPEN_FILE_EVENT,
  NewSessionWorkspace,
  SessionHeaderActions,
  SessionWorkspace,
  sessionKeyOf,
  sessionUiStore,
} from "../src/features/session";
import { resolveFileHrefTarget } from "../src/features/session/session-helpers";
import {
  inspectorTabsStore,
  resetInspectorTabsForTests,
} from "../src/features/inspector";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function createMockConnection(overrides?: {
  state?: Partial<ClientState>;
  actions?: Partial<ClientActions>;
  rpcCall?: (method: string, params: unknown) => Promise<unknown>;
}) {
  const computer: Computer = {
    key: DESKTOP_LOCAL,
    gateway: DESKTOP_LOCAL,
    machine: {
      id: "machine-local-1",
      name: "MacBook Pro",
      platform: "darwin",
      online: true,
      via: "paired",
    },
  };

  const agentModelsSpy = vi.fn(
    async (
      _agent: string,
      _cwd?: string,
      model?: string,
    ): Promise<MethodResult<"agents.models">> => ({
      current: "gpt-5.3-codex",
      models: [
        {
          value: "gpt-5.3-codex",
          name: "GPT-5.3-Codex",
          description: "Balanced coding model",
        },
        {
          value: "gpt-5.4-pro",
          name: "GPT-5.4-Pro",
          description: "Deep reasoning model",
        },
      ],
      config: [
        {
          id: "mode",
          name: "Permission Mode",
          category: "mode",
          current: "auto",
          values: [
            { value: "auto", name: "Auto" },
            { value: "plan", name: "Plan Mode" },
          ],
        },
        {
          id: "effort",
          name: "Effort",
          category: "effort",
          current: model === "gpt-5.4-pro" ? "high" : "medium",
          values: [
            { value: "low", name: "low" },
            { value: "medium", name: "medium" },
            { value: "high", name: "high" },
          ],
        },
      ],
    }),
  );

  const createSessionSpy = vi.fn(
    async (input: Parameters<ClientActions["createSession"]>[0]): Promise<SessionSummary> => ({
      id: `${input.agent}:thread-101`,
      agent: input.agent,
      nativeId: "thread-101",
      cwd: input.cwd,
      state: "idle",
      pendingPermissions: 0,
      model: input.model,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
      lastSeq: 0,
      archived: false,
    }),
  );

  const sendSpy = vi.fn<ClientActions["send"]>(async () => "started");
  const setConfigSpy = vi.fn<ClientActions["setConfig"]>(async () => {});
  const respondSpy = vi.fn<ClientActions["respond"]>(async () => {});
  const answerSpy = vi.fn<ClientActions["answer"]>(async () => {});
  const answerAsyncSpy = vi.fn<ClientActions["answerAsync"]>(async () => {});
  const cancelSpy = vi.fn<ClientActions["cancel"]>(async () => {});
  const sendQueuedNowSpy = vi.fn<ClientActions["sendQueuedNow"]>(async () => {});
  const takeQueuedSpy = vi.fn<ClientActions["takeQueued"]>(async () => [
    { type: "text", text: "queued text back" },
  ]);
  const unqueueSpy = vi.fn<ClientActions["unqueue"]>(async () => true);

  const store = createStore<ClientState & ClientActions>(() => ({
    status: "online",
    machine: {
      machineId: "machine-local-1",
      hostname: "MacBook Pro",
      platform: "darwin",
      hostVersion: "2.5.0",
      protocol: 4,
      home: "/Users/dev",
      agents: [
        {
          id: "codex",
          label: "Codex",
          tier: "handoff",
          installed: true,
          version: "0.99.0",
          capabilities: { models: true, modes: true },
        },
        {
          id: "claude",
          label: "Claude Code",
          tier: "handoff",
          installed: true,
          version: "1.0.20",
          capabilities: { models: true, modes: true },
        },
      ],
    },
    sessions: {},
    sessionsLoaded: true,
    notices: {},
    interactions: {},
    projects: [
      {
        cwd: "/Users/dev/linkshell",
        name: "linkshell",
        lastActiveAt: 1_700_000_000_000,
        sessionCount: 4,
        branch: "main",
      },
    ],
    views: {},
    open: {},
    ready: {},
    loadingEarlier: {},
    subagents: {},
    workflows: {},
    tasks: {},
    subagentViews: {},
    outbox: {},
    queueing: {},
    promptProgress: {},
    sides: {},
    dismissNotice: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    unlock: vi.fn(async () => {}),
    refresh: vi.fn(async () => {}),
    openSession: vi.fn(),
    closeSession: vi.fn(),
    send: sendSpy,
    retry: vi.fn(async () => {}),
    discard: vi.fn(),
    respond: respondSpy,
    answer: answerSpy,
    answerAsync: answerAsyncSpy,
    cancel: cancelSpy,
    takeover: vi.fn(async () => {}),
    release: vi.fn(async () => {}),
    setConfig: setConfigSpy,
    agentModels: agentModelsSpy,
    createSession: createSessionSpy,
    forkSession: vi.fn(async () => ({
      id: "codex:forked-1",
      agent: "codex",
      nativeId: "forked-1",
      cwd: "/Users/dev/linkshell",
      state: "idle",
      pendingPermissions: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastSeq: 0,
      archived: false,
    })),
    gitInfo: vi.fn(async () => ({
      root: "/Users/dev/linkshell",
      branch: "feat/desktop",
      head: "a1b2c3d",
      dirty: false,
    })),
    listWorktrees: vi.fn(async () => []),
    removeWorktree: vi.fn(async () => {}),
    unqueue: unqueueSpy,
    takeQueued: takeQueuedSpy,
    sendQueuedNow: sendQueuedNowSpy,
    reorderQueue: vi.fn(async () => {}),
    archive: vi.fn(async () => {}),
    rename: vi.fn(async () => {}),
    deleteSession: vi.fn(async () => {}),
    loadArchived: vi.fn(async () => {}),
    loadMoreSessions: vi.fn(async () => {}),
    loadEarlier: vi.fn(async () => false),
    loadTasks: vi.fn(async () => []),
    loadTaskOutput: vi.fn(async () => ({ text: "", start: 0, size: 0 })),
    stopTask: vi.fn(async () => {}),
    loadSubagents: vi.fn(async () => []),
    openSubagent: vi.fn(async () => true),
    closeSubagent: vi.fn(),
    loadImage: vi.fn(async () => "data:image/png;base64,AAAA"),
    loadSides: vi.fn(async () => []),
    askSide: vi.fn(async () => ({ id: "s1", question: "q", answer: "a", streaming: false, createdAt: 0 })),
    cancelSide: vi.fn(async () => {}),
    closeSide: vi.fn(async () => {}),
    ...overrides?.state,
    ...overrides?.actions,
  }));

  const linkCallSpy = vi.fn(async (method: string, params: unknown) => {
    if (overrides?.rpcCall) return overrides.rpcCall(method, params);
    if (method === "fs.projectFiles") {
      return {
        files: [
          { path: "/Users/dev/linkshell/src/App.tsx", relativePath: "src/App.tsx" },
        ],
        truncated: false,
      };
    }
    if (method === "fs.list") {
      return {
        path: "/Users/dev",
        home: "/Users/dev",
        entries: [{ name: "linkshell", path: "/Users/dev/linkshell", project: true }],
      };
    }
    return { ok: true };
  });

  const acquireSpy = vi.fn(() => () => {});

  const connection = {
    computer,
    store,
    link: {
      status: "online",
      call: linkCallSpy,
      reconnectNow: vi.fn(),
    },
    streams: {
      start: vi.fn(),
      stop: vi.fn(),
      connect: vi.fn(),
    },
    sessions: {
      acquire: acquireSpy,
      evict: vi.fn(),
      close: vi.fn(),
    },
  } as unknown as Connection;

  engine.state.setState({
    computers: [computer],
    localComputer: computer,
    connection,
    ready: true,
  });

  return {
    connection,
    store,
    spies: {
      agentModelsSpy,
      createSessionSpy,
      sendSpy,
      setConfigSpy,
      respondSpy,
      answerSpy,
      answerAsyncSpy,
      cancelSpy,
      sendQueuedNowSpy,
      takeQueuedSpy,
      unqueueSpy,
      linkCallSpy,
      acquireSpy,
    },
  };
}

async function flushAsync() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe("Slice 2B-2: New Session, Streaming Timeline, Approvals/Questions & Codex-Grade Composer", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    composerDrafts.getState().resetCache();
    sessionUiStore.setState({ byKey: {} });
    diffReviewStore.setState({ bySession: {} });
    routerStore.getState().navigate({ kind: "home" }, { replace: true });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    engine.state.setState({ connection: undefined, computers: [], localComputer: undefined });
  });

  it("enforces `@layer components`, zero `!important`, `field-sizing: content`, `content-visibility: auto`, and scroll-state container queries in session.css", () => {
    const css = readFileSync(
      resolve(__dirname, "../src/styles/session.css"),
      "utf8",
    );
    expect(css).toContain("@layer components");
    expect(css).not.toContain("!important");
    expect(css).not.toContain("overflow: hidden");
    expect(css).not.toContain("border-inline-start: 3px solid var(--ls-waiting)");
    expect(css).not.toContain(".ls-approval-subtitle");
    expect(css).toContain('.ls-jump-bottom-btn[data-visible="false"]');
    expect(css).toContain("field-sizing: content");
    expect(css).toContain("content-visibility: auto");
    expect(css).toContain("contain-intrinsic-size: auto 72px");
    expect(css).toContain("container-type: scroll-state");
    expect(css).toContain("scroll-state(scrollable: bottom)");
  });

  it("renders cleanly on cold boot when `connection` is undefined without `useSyncExternalStore` infinite-loop warnings", async () => {
    engine.state.setState({
      computers: [],
      localComputer: undefined,
      connection: undefined,
      ready: false,
    });

    await act(async () => {
      root.render(
        <DialogProvider>
          <NewSessionWorkspace computerKey={DESKTOP_LOCAL} />
          <SessionHeaderActions computerKey={DESKTOP_LOCAL} sessionId="codex:cold-1" />
          <SessionWorkspace computerKey={DESKTOP_LOCAL} sessionId="codex:cold-1" />
        </DialogProvider>,
      );
    });
    await flushAsync();

    expect(container.querySelector(".ls-new-session")).not.toBeNull();
    expect(container.querySelector(".ls-session-workspace")).not.toBeNull();
  });

  it("satisfies the Windows/Desktop E2E New Session contract: model picker preview RPC, identical model labels, native contextmenu preserved, and empty-prompt session start with zero prompt RPCs", async () => {
    const { spies } = createMockConnection();

    await act(async () => {
      root.render(
        <DialogProvider>
          <NewSessionWorkspace
            computerKey={DESKTOP_LOCAL}
            initialCwd="/Users/dev/linkshell"
          />
        </DialogProvider>,
      );
    });
    await flushAsync();

    // 1. Queries `agents.models` on mount
    expect(spies.agentModelsSpy).toHaveBeenCalledWith(
      "codex",
      "/Users/dev/linkshell",
      undefined,
    );

    // 2. Model picker button `button[aria-label="选择模型"]` opens `.new-session-menu[data-state="open"]`
    const modelBtn = container.querySelector<HTMLButtonElement>(
      'button[aria-label="选择模型"]',
    );
    expect(modelBtn).not.toBeNull();

    await act(async () => {
      modelBtn!.click();
    });

    const menuItems = [
      ...document.querySelectorAll<HTMLElement>(
        '.new-session-menu[data-state="open"] [role="menuitemradio"]',
      ),
    ];
    expect(menuItems).toHaveLength(2);
    const optionLabels = menuItems.map(
      (el) => el.querySelector(".new-session-option > span")?.textContent,
    );
    expect(optionLabels).toEqual(["GPT-5.3 Codex", "GPT-5.4 Pro"]);

    // 3. Selecting GPT-5.4-Pro triggers `agents.models` preview with `model: "gpt-5.4-pro"`
    await act(async () => {
      menuItems[1]!.click();
    });
    await flushAsync();

    expect(spies.agentModelsSpy).toHaveBeenLastCalledWith(
      "codex",
      "/Users/dev/linkshell",
      "gpt-5.4-pro",
    );

    // 4. Textarea `textarea[aria-label="任务描述"]` is empty and preserves native contextmenu
    const promptTextarea = container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="任务描述"]',
    );
    expect(promptTextarea).not.toBeNull();
    expect(promptTextarea!.value).toBe("");

    const ctxEvent = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    promptTextarea!.dispatchEvent(ctxEvent);
    expect(ctxEvent.defaultPrevented).toBe(false);

    // 5. `button[aria-label="开始会话"]` is enabled with empty prompt and omits `prompt` (zero send RPCs!)
    const startBtn = container.querySelector<HTMLButtonElement>(
      'button[aria-label="开始会话"]',
    );
    expect(startBtn).not.toBeNull();
    expect(startBtn!.disabled).toBe(false);

    await act(async () => {
      startBtn!.click();
    });
    await flushAsync();

    expect(spies.createSessionSpy).toHaveBeenCalledTimes(1);
    const createCallArg = spies.createSessionSpy.mock.calls[0]![0];
    expect(createCallArg.agent).toBe("codex");
    expect(createCallArg.cwd).toBe("/Users/dev/linkshell");
    expect(createCallArg.model).toBe("gpt-5.4-pro");
    expect("prompt" in createCallArg).toBe(false);
    expect(spies.sendSpy).not.toHaveBeenCalled();

    // Navigates routerStore to the newly created session
    expect(routerStore.getState().activeRoute).toEqual({
      kind: "session",
      computerKey: DESKTOP_LOCAL,
      sessionId: "codex:thread-101",
    });
  });

  it("satisfies Session Composer model chip E2E selector, CJK IME guard, draft preservation on send failure, and busy queue/steer controls", async () => {
    const sessionId = "codex:thread-202";
    const sessionSummary: SessionSummary = {
      id: sessionId,
      agent: "codex",
      nativeId: "thread-202",
      cwd: "/Users/dev/linkshell",
      state: "running",
      pendingPermissions: 0,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
      lastSeq: 5,
      archived: false,
      queue: [
        {
          clientMessageId: "q-1",
          text: "Run typecheck afterwards",
          images: 0,
        },
      ],
    };

    const view: SessionView = {
      ...emptyView(sessionId),
      state: "running",
      turnActive: true,
      turnStartedAt: Date.now() - 5000,
      usage: {
        usedTokens: 42_000,
        contextWindow: 200_000,
      },
      config: [
        {
          id: "model",
          name: "Model",
          category: "model",
          current: "gpt-5.4-pro",
          values: [
            { value: "gpt-5.3-codex", name: "GPT-5.3-Codex" },
            { value: "gpt-5.4-pro", name: "GPT-5.4-Pro" },
          ],
        },
      ],
    };

    const { spies, store } = createMockConnection({
      state: {
        sessions: { [sessionId]: sessionSummary },
        views: { [sessionId]: view },
        ready: { [sessionId]: true },
      },
    });

    await act(async () => {
      root.render(
        <DialogProvider>
          <SessionWorkspace computerKey={DESKTOP_LOCAL} sessionId={sessionId} />
        </DialogProvider>,
      );
    });
    await flushAsync();

    expect(spies.acquireSpy).toHaveBeenCalledWith(sessionId);

    // 1. Composer model chip E2E selector `button.composer-chip[data-category="model"]`
    const chipBtn = container.querySelector<HTMLButtonElement>(
      'button.composer-chip[data-category="model"]',
    );
    expect(chipBtn).not.toBeNull();

    await act(async () => {
      chipBtn!.click();
    });

    const chipRows = [
      ...document.querySelectorAll<HTMLElement>(
        '.composer-chip-menu[data-state="open"] [role="menuitemradio"]',
      ),
    ];
    expect(chipRows).toHaveLength(2);
    expect(
      chipRows.map((r) => r.querySelector(".composer-chip-option > span")?.textContent),
    ).toEqual(["GPT-5.3 Codex", "GPT-5.4 Pro"]);
    expect(chipRows[1]!.getAttribute("aria-checked")).toBe("true");

    await act(async () => {
      chipRows[0]!.click();
    });
    await flushAsync();

    expect(spies.setConfigSpy).toHaveBeenCalledWith(sessionId, "model", "gpt-5.3-codex");
    expect(spies.sendSpy).not.toHaveBeenCalled();

    // 2. CJK IME composition guard: Enter while composing MUST NOT submit
    const draftKey = draftKeyFor(DESKTOP_LOCAL, sessionId);
    act(() => {
      composerDrafts.getState().update(draftKey, "修复登录状态");
    });
    await flushAsync();

    const textarea = container.querySelector<HTMLTextAreaElement>(".ls-composer-textarea")!;
    expect(textarea.value).toBe("修复登录状态");

    await act(async () => {
      const imeEnter = new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
        isComposing: true,
      });
      textarea.dispatchEvent(imeEnter);
    });
    expect(spies.sendSpy).not.toHaveBeenCalled();

    // 3. Draft preservation when Host delivery returns `"failed"`
    spies.sendSpy.mockResolvedValueOnce("failed");
    await act(async () => {
      const realEnter = new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      });
      textarea.dispatchEvent(realEnter);
    });
    await flushAsync();

    expect(spies.sendSpy).toHaveBeenCalledTimes(1);
    // Draft MUST still be preserved!
    expect(composerDrafts.getState().read(draftKey)).toBe("修复登录状态");
    // ...and it is the only copy: the store's failed entry is discarded so a second Enter can't deliver twice,
    // and no outbox "发送失败" bar competes with the composer.
    const failedId = spies.sendSpy.mock.calls[0]![2]?.clientMessageId;
    expect(failedId).toEqual(expect.any(String));
    expect(store.getState().discard).toHaveBeenCalledWith(failedId);
    expect(container.querySelector(".ls-composer-send-error")?.textContent).toMatch(/输入和附件已保留|text and attachments are kept/);

    // 4. Busy steer button (`now: true`) clears draft when delivery succeeds
    spies.sendSpy.mockResolvedValueOnce("steered");
    const steerBtn = [...container.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === "插话" || b.textContent?.trim() === "Steer",
    );
    expect(steerBtn).toBeDefined();

    await act(async () => {
      steerBtn!.click();
    });
    await flushAsync();

    expect(spies.sendSpy).toHaveBeenLastCalledWith(
      sessionId,
      [{ type: "text", text: "修复登录状态" }],
      { now: true, clientMessageId: expect.any(String) },
    );
    expect(composerDrafts.getState().read(draftKey)).toBe("");

    // 5. Queued follow-up bar renders `Run typecheck afterwards` with `立即发送`
    expect(container.textContent).toContain("Run typecheck afterwards");
  });

  it("enforces ApprovalCard button order (`拒绝 -> 允许 -> 始终允许 -> 停止`), Question validation, neutral tool failure ink vs ErrorCard, `hidden=until-found`, and Diff review batch submission", async () => {
    const sessionId = "claude:session-303";
    const sessionSummary: SessionSummary = {
      id: sessionId,
      agent: "claude",
      nativeId: "session-303",
      cwd: "/Users/dev/linkshell",
      state: "waiting",
      pendingPermissions: 2,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
      lastSeq: 12,
      archived: false,
    };

    // Intentionally scrambled permission options to verify canonical ordering (`拒绝 -> 允许 -> 总是允许 -> 拒绝并停止`)
    const bashApproval: PendingPermissionSummary = {
      requestId: "perm-bash-1",
      title: "Run rm -rf dist",
      detail: "rm -rf dist && pnpm build",
      options: [
        { optionId: "always", name: "Always Allow", kind: "allow_always" },
        { optionId: "cancel", name: "Stop", kind: "reject_always" },
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        { optionId: "deny", name: "Deny", kind: "reject_once" },
      ],
    };

    const questionRequest: PendingPermissionSummary = {
      requestId: "perm-q-2",
      title: "Please answer the following questions.",
      options: [{ optionId: "skip", name: "Skip", kind: "reject_once" }],
      questions: [
        {
          id: "auth_mode",
          header: "Auth",
          text: "Which auth flow should we wire?",
          kind: "choice",
          required: true,
          options: [
            { value: "oauth", label: "OAuth 2.0 PKCE (Recommended)", description: "Standard flow" },
            { value: "pat", label: "Personal Access Token" },
          ],
        },
      ],
    };

    const view: SessionView = {
      ...emptyView(sessionId),
      state: "waiting",
      items: [
        {
          kind: "agent",
          id: "msg-1",
          text: "Inspect [App.tsx](src/App.tsx#L14) and run:\n```ts\nconst x = 42;\n```",
          streaming: false,
          ts: 1_700_000_000_100,
        },
        {
          kind: "tool",
          id: "tool-fail-1",
          title: "Run tests",
          name: "Bash",
          toolKind: "execute",
          status: "failed",
          rawInput: { command: "pnpm test" },
          rawOutput: { exitCode: 1 },
          content: [],
          output: "1 failing spec",
          ts: 1_700_000_000_200,
        },
        {
          kind: "tool",
          id: "tool-diff-1",
          title: "Edit src/App.tsx",
          name: "Edit",
          toolKind: "edit",
          status: "completed",
          content: [
            {
              type: "diff",
              path: "src/App.tsx",
              oldText: "const oldVal = 1;\n",
              newText: "const oldVal = 1;\nconst addedVal = 2;\n",
            },
          ],
          output: "",
          ts: 1_700_000_000_300,
        },
        {
          kind: "error",
          id: "err-1",
          code: "rate_limit",
          message: "429 Too Many Requests",
          ts: 1_700_000_000_400,
        },
      ],
      permissions: [bashApproval, questionRequest],
    };

    const { spies } = createMockConnection({
      state: {
        sessions: { [sessionId]: sessionSummary },
        views: { [sessionId]: view },
        ready: { [sessionId]: true },
      },
    });

    const inspectorEvents: unknown[] = [];
    const onOpenFile = (e: Event) => inspectorEvents.push((e as CustomEvent).detail);
    window.addEventListener(INSPECTOR_OPEN_FILE_EVENT, onOpenFile);

    try {
      await act(async () => {
        root.render(
          <DialogProvider>
            <SessionHeaderActions computerKey={DESKTOP_LOCAL} sessionId={sessionId} />
            <SessionWorkspace computerKey={DESKTOP_LOCAL} sessionId={sessionId} />
          </DialogProvider>,
        );
      });
      await flushAsync();

      // 1. ApprovalCard button order is strictly `拒绝 -> 允许 -> 总是允许 -> 拒绝并停止`, with zero redundant subtitle
      const approvalCards = container.querySelectorAll<HTMLElement>(".ls-approval-card");
      expect(approvalCards).toHaveLength(2);
      expect(container.querySelector(".ls-approval-subtitle")).toBeNull();
      const firstCardButtons = [
        ...approvalCards[0]!.querySelectorAll<HTMLButtonElement>(
          ".ls-approval-actions button",
        ),
      ];
      expect(firstCardButtons.map((b) => b.textContent?.trim())).toEqual([
        "拒绝",
        "允许",
        "总是允许",
        "拒绝并停止",
      ]);

      await act(async () => {
        firstCardButtons[1]!.click(); // Click `允许`
      });
      expect(spies.respondSpy).toHaveBeenCalledWith(sessionId, "perm-bash-1", "allow");

      // 2. Codex/Claude-Code QuestionCard: numbered 1..N keycaps, sr-only native radios, neutral `推荐` pill, and keyboard `1`–`9` quick-select
      const secondCard = approvalCards[1]!;
      expect(secondCard.textContent).toContain("OAuth 2.0 PKCE");
      expect(secondCard.textContent).not.toContain("(Recommended)");
      expect(secondCard.querySelector(".ls-question-recommended-pill")).not.toBeNull();

      const keycaps = [
        ...secondCard.querySelectorAll<HTMLElement>(".ls-question-keycap"),
      ];
      expect(keycaps.map((el) => el.textContent?.trim())).toEqual(["1", "2"]);

      // Keyboard `2` quick-selects the 2nd option when focused inside the question card
      await act(async () => {
        secondCard.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "2",
            bubbles: true,
            cancelable: true,
          }),
        );
      });
      const optionRows = secondCard.querySelectorAll<HTMLElement>(".ls-question-option");
      expect(optionRows[1]?.getAttribute("data-checked")).toBe("true");

      // Clicking radio `0` (or its `<label>`) selects `oauth`
      const radios = secondCard.querySelectorAll<HTMLInputElement>('input[type="radio"]');
      expect(radios.length).toBeGreaterThanOrEqual(2);
      expect(radios[0]?.classList.contains("ls-sr-only")).toBe(true);
      await act(async () => {
        radios[0]!.click();
      });
      expect(optionRows[0]?.getAttribute("data-checked")).toBe("true");

      const submitBtn = [
        ...secondCard.querySelectorAll<HTMLButtonElement>(".ls-approval-actions button"),
      ].at(-1)!;
      expect(submitBtn.disabled).toBe(false);
      await act(async () => {
        submitBtn.click();
      });
      expect(spies.answerSpy).toHaveBeenCalledWith(sessionId, "perm-q-2", [
        { id: "auth_mode", values: ["oauth"], other: undefined },
      ]);

      // 3. Folded step summary uses neutral ink (`（1 次工具未成功）`, `data-agent-failed` absent), while ErrorCard has `.ls-error-card`
      const failureNote = container.querySelector(".ls-step-failure-note");
      expect(failureNote?.textContent).toBe("（1 次工具未成功）");
      expect(failureNote?.getAttribute("data-agent-failed")).toBeNull();
      expect(container.querySelectorAll(".ls-error-card")).toHaveLength(1);

      // Expand folded step run to inspect individual `ToolCallRow` (`hidden="until-found"`) and `DiffBlock`
      const stepBtn = container.querySelector<HTMLButtonElement>(".ls-step-summary-btn");
      expect(stepBtn).not.toBeNull();
      await act(async () => {
        stepBtn!.click();
      });

      const hiddenUntilFound = container.querySelector('[hidden="until-found"]');
      expect(hiddenUntilFound).not.toBeNull();

      // Dispatching `beforematch` expands the collapsed tool output
      await act(async () => {
        hiddenUntilFound!.dispatchEvent(new Event("beforematch", { bubbles: true }));
      });
      expect(hiddenUntilFound!.getAttribute("hidden")).toBeNull();

      // 4. Markdown code fence `<pre tabIndex={0}>` and file link -> Inspector `files` tab
      const codePre = container.querySelector<HTMLPreElement>(".ls-code-pre");
      expect(codePre).not.toBeNull();
      expect(codePre!.tabIndex).toBe(0);

      const fileLink = container.querySelector<HTMLAnchorElement>(".ls-markdown a");
      expect(fileLink).not.toBeNull();
      await act(async () => {
        fileLink!.click();
      });
      expect(routerStore.getState().inspectorTab).toBe("files");
      expect(inspectorEvents).toEqual([
        {
          computerKey: DESKTOP_LOCAL,
          sessionId,
          path: "/Users/dev/linkshell/src/App.tsx",
          line: 14,
        },
      ]);

      // 5. DiffStat shows `+1` and omits `-0`; SessionComposer omits duplicate diff status pill & branch pill; line review comment batches into SessionComposer
      const diffStat = container.querySelector(".ls-diff-stat");
      expect(diffStat?.textContent).toBe("+1");
      expect(container.querySelector(".ls-status-pill--diff")).toBeNull();
      expect(container.querySelector(".ls-composer-branch-pill")).toBeNull();

      const sessionKey = sessionKeyOf(DESKTOP_LOCAL, sessionId);
      act(() => {
        diffReviewStore.getState().addComment({
          sessionKey,
          path: "src/App.tsx",
          side: "new",
          startLine: 2,
          endLine: 2,
          excerpt: "const addedVal = 2;",
          comment: "Rename to `nextCount` for clarity",
        });
      });
      await flushAsync();

      const reviewBar = container.querySelector(".ls-composer-review-bar");
      expect(reviewBar).not.toBeNull();
      const sendReviewBtn = reviewBar!.querySelectorAll("button")[1]!;
      await act(async () => {
        sendReviewBtn.click();
      });
      await flushAsync();

      expect(spies.sendSpy).toHaveBeenCalledTimes(1);
      expect(spies.sendSpy.mock.calls[0]![1][0]).toMatchObject({
        type: "text",
        text: expect.stringContaining("Rename to `nextCount` for clarity"),
      });

      // 6. SessionHeaderActions stays Paseo-clean (no duplicate Terminal/Inspector/Find buttons)
      //    and moves `findInSession` (`会话内查找`) into the `[•••]` Session overflow Menu right above `copyTitle`
      const headerActions = container.querySelector(".ls-session-header-actions")!;
      expect(headerActions).not.toBeNull();
      expect(
        headerActions.querySelector(
          'button[aria-label="会话内查找"], button[aria-label="Find in session"], button[aria-label="切换底部终端"], button[aria-label="切换右侧检查器"]',
        ),
      ).toBeNull();

      const overflowTrigger = headerActions.querySelector<HTMLButtonElement>(
        'button[aria-label="更多会话操作"], button[aria-label="Session actions"]',
      );
      expect(overflowTrigger).not.toBeNull();
      await act(async () => {
        overflowTrigger!.click();
      });

      const openMenuItems = [
        ...headerActions.querySelectorAll<HTMLButtonElement>(
          '.ls-menu-popover[data-state="open"] [role="menuitem"]',
        ),
      ];
      const findMenuIdx = openMenuItems.findIndex(
        (item) =>
          item.textContent?.includes("会话内查找") ||
          item.textContent?.includes("Find in session"),
      );
      expect(findMenuIdx).toBeGreaterThanOrEqual(0);
      expect(openMenuItems[findMenuIdx + 1]?.textContent).toMatch(/复制|Copy/i);

      await act(async () => {
        openMenuItems[findMenuIdx]!.click();
      });
      expect(container.querySelector(".ls-session-find-bar")).not.toBeNull();
    } finally {
      window.removeEventListener(INSPECTOR_OPEN_FILE_EVENT, onOpenFile);
    }
  });

  it("prevents useSessionConnection computer-switch ping-pong, opens subagent tabs in Right Side Panel, toggles inline ErrorTurnCard details, and declutters SessionHeaderActions topbar", async () => {
    resetInspectorTabsForTests();
    routerStore.setState({ inspectorOpen: false, inspectorTab: "new-tab" });

    const localRig = createMockConnection();
    const remoteComputer: Computer = {
      key: "wss://gateway.itool.tech#pack-host",
      gateway: "wss://gateway.itool.tech",
      machine: {
        id: "machine-remote-pack",
        name: "打包机",
        platform: "darwin",
        online: true,
        via: "paired",
      },
    };
    const remoteRig = createMockConnection();
    const remoteConn: Connection = {
      ...remoteRig.connection,
      computer: remoteComputer,
    };

    const selectSpy = vi.spyOn(engine, "select").mockImplementation((comp) => {
      engine.state.setState({
        connection: comp.key === remoteComputer.key ? remoteConn : localRig.connection,
      });
      return comp.key === remoteComputer.key ? remoteConn : localRig.connection;
    });

    engine.state.setState({
      computers: [localRig.connection.computer, remoteComputer],
      localComputer: localRig.connection.computer,
      connection: remoteConn,
    });

    // 1. Mount NewSessionWorkspace bound to `打包机`, then click `本机` (`engine.select(local)`):
    //    `useSessionConnection` MUST NOT snap `engine.state.connection` back to `打包机`!
    await act(async () => {
      root.render(
        <DialogProvider>
          <NewSessionWorkspace computerKey={remoteComputer.key} />
        </DialogProvider>,
      );
    });
    await flushAsync();
    selectSpy.mockClear();

    await act(async () => {
      engine.select(localRig.connection.computer);
    });
    await flushAsync();

    expect(engine.state.getState().connection?.computer.key).toBe(DESKTOP_LOCAL);
    expect(
      selectSpy.mock.calls.some((call) => call[0]?.key === remoteComputer.key),
    ).toBe(false);

    // 2. Render SessionWorkspace + SessionHeaderActions with a spawned subagent & ErrorTurnCard
    const session: SessionSummary = {
      id: "codex:s-wave2",
      agent: "codex",
      nativeId: "native-wave2",
      cwd: "/Users/dev/linkshell",
      title: "Wave 2 Session",
      state: "idle",
      driver: "remote",
      pendingPermissions: 0,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_010_000,
      lastSeq: 10,
      archived: false,
    };
    const view: SessionView = {
      ...emptyView(session.id),
      ready: true,
      items: [
        {
          id: "sub-call-42",
          kind: "tool",
          title: "Spawn verifier",
          status: "in_progress",
          content: [],
          detail: {
            type: "subagent",
            action: "spawn",
            name: "verifier-worker",
            agentType: "codex",
            task: "Verify Windows & macOS parity",
            state: "running",
          },
          sub: {
            ...emptyView("sub-42"),
            items: [],
          },
        },
        {
          id: "err-1",
          kind: "error",
          code: "turn_failed",
          message: "Rate limit exceeded on upstream provider\nRetry after 12s",
        },
      ],
    };

    const sessionRig = createMockConnection({
      state: {
        sessions: { [session.id]: session },
        views: { [session.id]: view },
        ready: { [session.id]: true },
      },
    });
    engine.state.setState({
      computers: [sessionRig.connection.computer],
      localComputer: sessionRig.connection.computer,
      connection: sessionRig.connection,
    });

    await act(async () => {
      root.render(
        <DialogProvider>
          <div>
            <SessionHeaderActions
              computerKey={DESKTOP_LOCAL}
              sessionId={session.id}
            />
            <SessionWorkspace
              computerKey={DESKTOP_LOCAL}
              sessionId={session.id}
            />
          </div>
        </DialogProvider>,
      );
    });
    await flushAsync();

    // 3. SessionHeaderActions omits `.ls-session-branch-chip` and standalone `在编辑器中打开` in topbar,
    //    moving editor launchers & `复制分支名` cleanly into `[⋯ 更多]` menu!
    const headerActions = container.querySelector(".ls-session-header-actions")!;
    expect(headerActions.querySelector(".ls-session-branch-chip")).toBeNull();
    expect(headerActions.textContent).not.toContain("在编辑器中打开");
    expect(headerActions.textContent).not.toContain("交还桌面终端");

    const moreBtn = headerActions.querySelector<HTMLButtonElement>(
      'button[aria-label="更多会话操作"], button[aria-label="Session actions"]',
    )!;
    await act(async () => {
      moreBtn.click();
    });
    const menuText =
      headerActions.querySelector('.ls-menu-popover[data-state="open"]')
        ?.textContent ?? "";
    expect(menuText).toContain("Cursor");
    expect(menuText).toMatch(/复制分支名|Copy branch name/i);

    // 4. ErrorTurnCard uses quiet `.ls-error-card__toggle` (`查看详情` / `收起详情`)
    const errCard = container.querySelector(".ls-error-card")!;
    expect(errCard.querySelector(".ls-collapsible-log")).toBeNull();
    const toggleErrBtn = errCard.querySelector<HTMLButtonElement>(
      ".ls-error-card__toggle",
    )!;
    expect(toggleErrBtn).not.toBeNull();
    expect(errCard.querySelector("pre.ls-tool-pre")).toBeNull();
    await act(async () => {
      toggleErrBtn.click();
    });
    expect(errCard.querySelector("pre.ls-tool-pre")?.textContent).toContain(
      "Retry after 12s",
    );

    // 5. Clicking SubagentSpawnCard opens `subagent:sub-call-42` tab in Right Side Panel (`data-tab-open="true"`)
    const subCardHead = container.querySelector<HTMLElement>(
      ".ls-subagent-card__head",
    )!;
    expect(subCardHead).not.toBeNull();
    await act(async () => {
      subCardHead.click();
    });
    expect(routerStore.getState().inspectorOpen).toBe(true);
    const scopeKey = `${DESKTOP_LOCAL}::${session.id}`;
    expect(inspectorTabsStore.getState().byScope[scopeKey]?.activeId).toBe(
      "subagent:sub-call-42",
    );
    expect(
      container
        .querySelector(".ls-subagent-card")
        ?.getAttribute("data-tab-open"),
    ).toBe("true");

    // 6. Clicking `[• 1 子代理]` pill in SessionComposer also opens/focuses `subagent:sub-call-42`!
    await act(async () => {
      routerStore.getState().toggleInspector(false);
    });
    const subPill = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".ls-status-pill"),
    ).find((b) => /子代理|subagent/i.test(b.textContent ?? ""))!;
    expect(subPill).not.toBeNull();
    await act(async () => {
      subPill.click();
    });
    expect(routerStore.getState().inspectorOpen).toBe(true);
    expect(inspectorTabsStore.getState().byScope[scopeKey]?.activeId).toBe(
      "subagent:sub-call-42",
    );

    selectSpy.mockRestore();
    resetInspectorTabsForTests();
  });

  it("omits redundant plan task pill above SessionComposer, renders single-line .ls-composer-popup-cmd for slash commands, and opens dedicated file tabs on file:///vscode:///bare Markdown citations (#86, #91, #93)", async () => {
    resetInspectorTabsForTests();
    routerStore.setState({ inspectorOpen: false, inspectorTab: "new-tab" });

    const sessionId = "claude:session-citations";
    const sessionSummary: SessionSummary = {
      id: sessionId,
      agent: "claude",
      nativeId: "session-citations",
      cwd: "/Users/dev/bidai-expo",
      state: "idle",
      pendingPermissions: 0,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_010_000,
      lastSeq: 8,
      archived: false,
    };

    const view: SessionView = {
      ...emptyView(sessionId),
      ready: true,
      commands: [
        {
          name: "figma:figma-code-connect",
          hint: "<component>",
          description: "Connect Figma components to production source files",
        },
      ],
      items: [
        {
          kind: "plan",
          id: "plan-1",
          entries: [
            { content: "Inspect SDK error handler", status: "pending" },
            { content: "Patch host services", status: "pending" },
            { content: "Run test suite", status: "pending" },
          ],
          ts: 1_700_000_000_100,
        },
        {
          kind: "agent",
          id: "msg-cite-1",
          text: [
            "Updated [error-message.ts](file:///Users/dev/bidai-expo/packages/sdk/error-message.ts#L42C5),",
            "[host-services.ts](vscode://file/Users/dev/bidai-expo/src/host-services.ts:189:12),",
            "and bare [error-message.ts](error-message.ts).",
          ].join(" "),
          streaming: false,
          ts: 1_700_000_000_200,
        },
      ],
    };

    createMockConnection({
      state: {
        sessions: { [sessionId]: sessionSummary },
        views: { [sessionId]: view },
        ready: { [sessionId]: true },
      },
    });

    await act(async () => {
      root.render(
        <DialogProvider>
          <SessionWorkspace computerKey={DESKTOP_LOCAL} sessionId={sessionId} />
        </DialogProvider>,
      );
    });
    await flushAsync();

    // 1. Even with a 0/3 pending `plan` item in the timeline, `[ 0/3 任务 ]` pill is 100% gone above SessionComposer!
    expect(container.querySelector(".ls-composer-status-pills")).toBeNull();

    // 2. Typing `/fig` renders single-line `.ls-composer-popup-cmd` + `.ls-composer-popup-hint` + `.ls-composer-popup-meta`
    const draftKey = draftKeyFor(DESKTOP_LOCAL, sessionId);
    act(() => {
      composerDrafts.getState().update(draftKey, "/fig");
    });
    await flushAsync();

    const textarea = container.querySelector<HTMLTextAreaElement>(".ls-composer-textarea")!;
    act(() => {
      textarea.focus();
      textarea.setSelectionRange(4, 4);
      textarea.dispatchEvent(new Event("select", { bubbles: true }));
    });
    await flushAsync();

    const popupCmd = container.querySelector<HTMLElement>(".ls-composer-popup-cmd");
    expect(popupCmd).not.toBeNull();
    expect(popupCmd?.getAttribute("title")).toBe("/figma:figma-code-connect");
    expect(popupCmd?.textContent).toContain("/figma:figma-code-connect");
    expect(container.querySelector(".ls-composer-popup-hint")?.textContent).toBe("<component>");
    expect(container.querySelector(".ls-composer-popup-meta")?.textContent).toContain(
      "Connect Figma components",
    );

    // 3. All 3 Markdown file citation formats (`file://#L42C5`, `vscode://file/...:189:12`, bare `error-message.ts`)
    //    render real clickable `<a class="ls-md-file-link">` anchors and open dedicated `kind: "file"` tabs even when Inspector starts closed!
    const fileLinks = [
      ...container.querySelectorAll<HTMLAnchorElement>(".ls-markdown a.ls-md-file-link"),
    ];
    expect(fileLinks).toHaveLength(3);

    // Click #1 (`file:///Users/dev/bidai-expo/packages/sdk/error-message.ts#L42C5`) while `inspectorOpen === false`
    expect(routerStore.getState().inspectorOpen).toBe(false);
    await act(async () => {
      fileLinks[0]!.click();
    });
    const scopeKey = `${DESKTOP_LOCAL}::${sessionId}`;
    expect(routerStore.getState().inspectorOpen).toBe(true);
    expect(inspectorTabsStore.getState().byScope[scopeKey]?.activeId).toBe(
      "file:/Users/dev/bidai-expo/packages/sdk/error-message.ts",
    );
    expect(
      inspectorTabsStore
        .getState()
        .byScope[scopeKey]?.tabs.find(
          (t) => t.id === "file:/Users/dev/bidai-expo/packages/sdk/error-message.ts",
        )?.lineSpec,
    ).toBe("/Users/dev/bidai-expo/packages/sdk/error-message.ts#L42");

    // Click #2 (`vscode://file/Users/dev/bidai-expo/src/host-services.ts:189:12`) -> opens a 2nd dedicated file tab!
    await act(async () => {
      fileLinks[1]!.click();
    });
    expect(inspectorTabsStore.getState().byScope[scopeKey]?.activeId).toBe(
      "file:/Users/dev/bidai-expo/src/host-services.ts",
    );
    expect(
      inspectorTabsStore
        .getState()
        .byScope[scopeKey]?.tabs.find(
          (t) => t.id === "file:/Users/dev/bidai-expo/src/host-services.ts",
        )?.lineSpec,
    ).toBe("/Users/dev/bidai-expo/src/host-services.ts#L189");

    // Click #3 (`[error-message.ts](error-message.ts)`) -> resolves relative to `cwd`
    await act(async () => {
      fileLinks[2]!.click();
    });
    expect(inspectorTabsStore.getState().byScope[scopeKey]?.activeId).toBe(
      "file:/Users/dev/bidai-expo/error-message.ts",
    );

    resetInspectorTabsForTests();
  });

  function runningSession(id: string, overrides?: Partial<SessionSummary>): SessionSummary {
    return {
      id,
      agent: "codex",
      nativeId: id.split(":")[1] ?? id,
      cwd: "/Users/dev/linkshell",
      state: "running",
      pendingPermissions: 0,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
      lastSeq: 3,
      archived: false,
      ...overrides,
    };
  }

  it("shows async questions once: on the session for newer hosts, on the agent's message only for older ones", async () => {
    const sessionId = "codex:async-1";
    const question = { id: "q-1", title: "Which database?", options: ["Postgres", "SQLite"] };
    const view: SessionView = {
      ...emptyView(sessionId),
      items: [
        { kind: "agent", id: "msg-q", text: "Working on it", questions: [question], streaming: false, ts: 1 },
      ],
    };
    const { store } = createMockConnection({
      state: {
        sessions: { [sessionId]: runningSession(sessionId, { asyncQuestions: [question] }) },
        views: { [sessionId]: view },
        ready: { [sessionId]: true },
      },
    });

    await act(async () => {
      root.render(
        <DialogProvider>
          <SessionWorkspace computerKey={DESKTOP_LOCAL} sessionId={sessionId} />
        </DialogProvider>,
      );
    });
    await flushAsync();
    expect(container.querySelectorAll(".ls-async-question-card")).toHaveLength(1);

    // An older host (no `asyncQuestions` on the summary): the message carries it, still once.
    await act(async () => {
      store.setState({ sessions: { [sessionId]: runningSession(sessionId) } });
    });
    await flushAsync();
    expect(container.querySelectorAll(".ls-async-question-card")).toHaveLength(1);
  });

  it("shows a loading state until the history snapshot is ready, then the empty state", async () => {
    const sessionId = "codex:loading-1";
    const { store } = createMockConnection({
      state: {
        sessions: { [sessionId]: runningSession(sessionId, { state: "idle" }) },
        views: { [sessionId]: emptyView(sessionId) },
      },
    });
    await act(async () => {
      root.render(
        <DialogProvider>
          <SessionWorkspace computerKey={DESKTOP_LOCAL} sessionId={sessionId} />
        </DialogProvider>,
      );
    });
    await flushAsync();
    const empty = () => container.querySelector(".ls-timeline-empty")?.textContent ?? "";
    expect(empty()).toMatch(/正在加载会话记录|Loading conversation/);

    await act(async () => {
      store.setState({ ready: { [sessionId]: true }, promptProgress: { [sessionId]: { clientMessageId: "c", phase: "starting", afterSeq: 0 } } });
    });
    await flushAsync();
    expect(empty()).toMatch(/会话已就绪|Session ready/);
    expect(container.querySelector(".ls-live-label")?.textContent).toMatch(/正在启动智能体|Starting the agent/);
  });

  it("keeps the textarea usable offline, gates only sending with a message, and stops the turn on Esc (never while composing)", async () => {
    const sessionId = "codex:offline-1";
    const { spies, store } = createMockConnection({
      state: {
        status: "offline",
        sessions: { [sessionId]: runningSession(sessionId) },
        views: { [sessionId]: { ...emptyView(sessionId), turnActive: true, state: "running" } },
        ready: { [sessionId]: true },
      },
    });
    await act(async () => {
      root.render(
        <DialogProvider>
          <SessionWorkspace computerKey={DESKTOP_LOCAL} sessionId={sessionId} />
        </DialogProvider>,
      );
    });
    await flushAsync();

    const textarea = container.querySelector<HTMLTextAreaElement>(".ls-composer-textarea")!;
    expect(textarea.disabled).toBe(false);
    act(() => {
      composerDrafts.getState().update(draftKeyFor(DESKTOP_LOCAL, sessionId), "继续");
    });
    await flushAsync();
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    await flushAsync();
    expect(spies.sendSpy).not.toHaveBeenCalled();
    expect(container.querySelector(".ls-composer-send-error")?.textContent).toMatch(/会话连接正在恢复|Reconnecting/);
    expect(composerDrafts.getState().read(draftKeyFor(DESKTOP_LOCAL, sessionId))).toBe("继续");

    await act(async () => {
      store.setState({ status: "online" });
    });
    await flushAsync();
    await act(async () => {
      textarea.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true, isComposing: true }),
      );
    });
    expect(spies.cancelSpy).not.toHaveBeenCalled();
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(spies.cancelSpy).toHaveBeenCalledWith(sessionId);
  });

  it("uploads files the agent can't take inline into the session directory as resource links, once per file, with a long timeout", async () => {
    const sessionId = "codex:attach-1";
    const { spies } = createMockConnection({
      state: {
        sessions: { [sessionId]: runningSession(sessionId, { state: "idle" }) },
        views: { [sessionId]: emptyView(sessionId) },
        ready: { [sessionId]: true },
      },
      rpcCall: async (method, params) => {
        if (method === "fs.upload") {
          const { dir, name } = params as { dir: string; name: string };
          return { path: `${dir}/${name}`, size: 5 };
        }
        return { ok: true };
      },
    });
    spies.sendSpy.mockResolvedValueOnce("failed").mockResolvedValueOnce("started");

    await act(async () => {
      root.render(
        <DialogProvider>
          <SessionWorkspace computerKey={DESKTOP_LOCAL} sessionId={sessionId} />
        </DialogProvider>,
      );
    });
    await flushAsync();

    const input = container.querySelector<HTMLInputElement>('.ls-composer-box input[type="file"]')!;
    const file = new File(["notes"], "notes.txt", { type: "text/plain" });
    // jsdom's File has no arrayBuffer(); Chromium's does.
    Object.defineProperty(file, "arrayBuffer", {
      value: async () => new TextEncoder().encode("notes").buffer,
    });
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flushAsync();
    expect(container.querySelector(".ls-attachment-pill")?.textContent).toContain("notes.txt");

    const sendButton = () =>
      [...container.querySelectorAll<HTMLButtonElement>(".ls-composer-send-btn")].at(-1)!;
    await act(async () => {
      sendButton().click();
    });
    await flushAsync();
    // The failed send keeps the attachment; sending again must not upload the same file twice.
    expect(container.querySelector(".ls-attachment-pill")).not.toBeNull();
    await act(async () => {
      sendButton().click();
    });
    await flushAsync();

    const uploads = spies.linkCallSpy.mock.calls.filter(([method]) => method === "fs.upload");
    expect(uploads).toHaveLength(1);
    expect(uploads[0]![1]).toMatchObject({ dir: "/Users/dev/linkshell", name: "notes.txt" });
    expect((uploads[0] as unknown[])[2]).toBe(180_000);
    expect(spies.sendSpy).toHaveBeenLastCalledWith(
      sessionId,
      [{ type: "resource_link", uri: "/Users/dev/linkshell/notes.txt", name: "notes.txt" }],
      { now: false, clientMessageId: expect.any(String) },
    );
    expect(container.querySelector(".ls-attachment-pill")).toBeNull();
  });

  it("follows the newest message again when the person sends after reading back", async () => {
    const sessionId = "codex:follow-1";
    const view: SessionView = {
      ...emptyView(sessionId),
      items: [{ kind: "agent", id: "msg-1", text: "Earlier answer", streaming: false, ts: 1 }],
    };
    const { spies } = createMockConnection({
      state: {
        sessions: { [sessionId]: runningSession(sessionId, { state: "idle" }) },
        views: { [sessionId]: view },
        ready: { [sessionId]: true },
      },
    });
    await act(async () => {
      root.render(
        <DialogProvider>
          <SessionWorkspace computerKey={DESKTOP_LOCAL} sessionId={sessionId} />
        </DialogProvider>,
      );
    });
    await flushAsync();

    const scroller = container.querySelector<HTMLDivElement>(".ls-timeline-scroller")!;
    let top = 0;
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, get: () => 2000 });
    Object.defineProperty(scroller, "clientHeight", { configurable: true, get: () => 500 });
    Object.defineProperty(scroller, "scrollTop", {
      configurable: true,
      get: () => top,
      set: (value: number) => {
        top = Math.min(value, 1500);
      },
    });

    // The person scrolls up: the jump pill appears and new content no longer pulls the view down.
    await act(async () => {
      scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -200, bubbles: true }));
      top = 300;
      scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    expect(container.querySelector(".ls-jump-bottom-btn")?.getAttribute("data-visible")).toBe("true");

    act(() => {
      composerDrafts.getState().update(draftKeyFor(DESKTOP_LOCAL, sessionId), "下一步");
    });
    await flushAsync();
    const textarea = container.querySelector<HTMLTextAreaElement>(".ls-composer-textarea")!;
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    await flushAsync();

    expect(spies.sendSpy).toHaveBeenCalledTimes(1);
    expect(top).toBe(1500);
    expect(container.querySelector(".ls-jump-bottom-btn")?.getAttribute("data-visible")).toBe("false");
  });

  it("keeps only the newest wrap-up's replies active, sends once, and shows app actions as chips", async () => {
    const sessionId = "claude:wrap-1";
    const wrapItem = (id: string) => ({
      kind: "tool" as const,
      id,
      title: "wrap_up",
      name: "mcp__ccd_session__wrap_up",
      status: "completed" as const,
      detail: { type: "mcp" as const, server: "ccd_session", tool: "wrap_up" },
      rawInput: {
        recap: "Done",
        actions: [{ label: "Ship it", message: "Please ship" }, { action: "commit" }],
      },
      content: [],
      output: "",
      ts: 1,
    });
    const view: SessionView = {
      ...emptyView(sessionId),
      items: [
        wrapItem("wrap-old"),
        { kind: "user", id: "u-1", blocks: [{ type: "text", text: "thanks" }], ts: 2 },
        wrapItem("wrap-new"),
      ],
    };
    const { spies } = createMockConnection({
      state: {
        sessions: { [sessionId]: runningSession(sessionId, { agent: "claude", state: "idle" }) },
        views: { [sessionId]: view },
        ready: { [sessionId]: true },
      },
    });
    await act(async () => {
      root.render(
        <DialogProvider>
          <SessionWorkspace computerKey={DESKTOP_LOCAL} sessionId={sessionId} />
        </DialogProvider>,
      );
    });
    await flushAsync();

    const replyButtons = [...container.querySelectorAll<HTMLButtonElement>(".ls-wrap-up-actions button")];
    expect(replyButtons).toHaveLength(1);
    expect(container.querySelectorAll(".ls-wrap-up-chip").length).toBe(3);
    await act(async () => {
      replyButtons[0]!.click();
    });
    await flushAsync();
    expect(spies.sendSpy).toHaveBeenCalledWith(sessionId, [{ type: "text", text: "Please ship" }]);
    expect(replyButtons[0]!.disabled).toBe(true);
  });

  it("resolves Windows file:// (2-slash & 3-slash), vscode://file, backslash relative paths, and extensionless scripts in resolveFileHrefTarget", () => {
    expect(resolveFileHrefTarget("file://C:/Users/dev/a.ts#L12")).toEqual({
      path: "C:/Users/dev/a.ts",
      line: 12,
      endLine: undefined,
    });
    expect(
      resolveFileHrefTarget("file:///C:/Users/dev/a.ts#L12-L20"),
    ).toEqual({
      path: "C:/Users/dev/a.ts",
      line: 12,
      endLine: 20,
    });
    expect(resolveFileHrefTarget("file:///C:\\Users\\dev\\a.ts:15:3")).toEqual({
      path: "C:\\Users\\dev\\a.ts",
      line: 15,
      endLine: undefined,
    });
    expect(
      resolveFileHrefTarget("vscode://file/C:/Users/dev/a.ts:8:2"),
    ).toEqual({
      path: "C:/Users/dev/a.ts",
      line: 8,
      endLine: undefined,
    });
    expect(
      resolveFileHrefTarget("vscode://file/c%3A/Users/dev/a.ts:9"),
    ).toEqual({
      path: "c:/Users/dev/a.ts",
      line: 9,
      endLine: undefined,
    });
    expect(resolveFileHrefTarget(".\\src\\main.ts", "C:\\repo")).toEqual({
      path: "C:\\repo\\src\\main.ts",
      line: undefined,
      endLine: undefined,
    });
    expect(resolveFileHrefTarget("src/a.ts", "C:\\repo")).toEqual({
      path: "C:\\repo\\src\\a.ts",
      line: undefined,
      endLine: undefined,
    });
    expect(resolveFileHrefTarget("scripts\\build")).toEqual({
      path: "scripts\\build",
      line: undefined,
      endLine: undefined,
    });
  });
});
