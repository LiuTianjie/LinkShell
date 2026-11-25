// @vitest-environment jsdom
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createStore } from "zustand/vanilla";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientActions, ClientState, HostLink } from "@linkshell/client-core";
import type { SessionSummary } from "@linkshell/wire";
import {
  DESKTOP_LOCAL,
  I18nProvider,
  composerPastedDrafts,
  createPastedBlock,
  diffReviewSessionKey,
  diffReviewStore,
  draftKeyFor,
  engine,
  managementStore,
  markdownBlocks,
  normalizeDiffReviewSessionKey,
  normalizeReviewPath,
  resetDesktopStorageForTests,
  routerStore,
  setDesktopLocalePreference,
  type Computer,
  type Connection,
} from "../src/core";
import {
  DESKTOP_SHORTCUTS,
  formatShortcut,
  matchesShortcut,
} from "../src/bridge/shortcuts";
import { DialogProvider } from "../src/primitives";
import { DiffBlock, DiffStatBadge } from "../src/features/session/DiffBlock";
import { detectAtFileMention } from "../src/features/session/session-helpers";
import { CommandCenter, fuzzyMatchScore } from "../src/features/shell/CommandCenter";
import { FileViewerTabPanel } from "../src/features/inspector/FileViewerTabPanel";
import { FilesPanel } from "../src/features/inspector/FilesPanel";
import {
  disposeTerminalStagesForComputer,
  getTerminalStageController,
  resetTerminalStagesForTests,
} from "../src/features/inspector/terminal-runtime";
import { createFusionController } from "../src/core/fusion-store";
import { SystemHostModal } from "../src/features/system/SystemHostModal";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function makeSession(index: number, overrides: Partial<SessionSummary> = {}): SessionSummary {
  const now = 1_700_000_000_000 + index * 1000;
  return {
    id: `sess-${index}`,
    agent: "codex",
    cwd: `/repo/project-${index % 5}`,
    title: `Session #${index}`,
    state: "idle",
    archived: false,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeConnection(
  sessions: Record<string, SessionSummary>,
  rpcCall?: (method: string, params: unknown) => Promise<unknown>,
  computerKey = DESKTOP_LOCAL,
): Connection {
  const computer: Computer = {
    key: computerKey,
    gateway: computerKey,
    machine: {
      id: `machine-${computerKey}`,
      name: computerKey === DESKTOP_LOCAL ? "MacBook Pro" : `Host ${computerKey}`,
      platform: "darwin",
      online: true,
      via: "paired",
    },
  };
  const store = createStore<ClientState & ClientActions>(() => ({
    status: "online",
    statusDetail: undefined,
    machine: {
      machineId: computer.machine.id,
      hostname: computer.machine.name,
      platform: "darwin",
      home: "/Users/dev",
      agents: [],
      protocol: 2,
      hostVersion: "0.0.0-test",
    },
    sessions,
    sessionsLoaded: true,
    sessionsError: undefined,
    sessionsNextBefore: undefined,
    archivedNextBefore: undefined,
    views: {},
    terminals: [],
    ports: [],
    worktrees: [],
    refresh: vi.fn(async () => {}),
    loadMoreSessions: vi.fn(async () => {}),
    loadArchived: vi.fn(async () => {}),
    openSession: vi.fn(async () => {}),
    closeSession: vi.fn(),
    loadEarlier: vi.fn(async () => false),
    sendPrompt: vi.fn(async () => {}),
    cancelSession: vi.fn(async () => {}),
    respondPermission: vi.fn(async () => {}),
    respondQuestion: vi.fn(async () => {}),
    archiveSession: vi.fn(async () => {}),
    deleteSession: vi.fn(async () => {}),
    renameSession: vi.fn(async () => {}),
    setSessionConfig: vi.fn(async () => {}),
    setSessionModel: vi.fn(async () => {}),
    gitInfo: vi.fn(async () => undefined),
  })) as unknown as Connection["store"];

  const link = {
    call: vi.fn(async (method: string, params: unknown) => {
      if (rpcCall) return rpcCall(method, params);
      return {};
    }),
  } as unknown as HostLink;

  return {
    computer,
    store,
    link,
    streams: {} as Connection["streams"],
    direct: false,
    close: vi.fn(),
  } as unknown as Connection;
}

describe("Track 5 Desktop UI upgrades & regression guards", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    resetDesktopStorageForTests({});
    setDesktopLocalePreference("zh");
    diffReviewStore.setState({ bySession: {} });
    composerPastedDrafts.getState().resetCache();
    routerStore.getState().setCommandCenterOpen(false);
    resetTerminalStagesForTests();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);

    if (typeof ResizeObserver === "undefined") {
      globalThis.ResizeObserver = class {
        observe() {}
        unobserve() {}
        disconnect() {}
      } as unknown as typeof ResizeObserver;
    }
    if (typeof HTMLDialogElement !== "undefined") {
      HTMLDialogElement.prototype.showModal = function showModal() {
        this.open = true;
      };
      HTMLDialogElement.prototype.close = function close() {
        this.open = false;
      };
    }
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
    routerStore.getState().setCommandCenterOpen(false);
    vi.restoreAllMocks();
  });

  it("unifies diff review store keys (canonical computerKey:sessionId + legacy newline migration) and repo-relative paths", () => {
    const canonical = diffReviewSessionKey(DESKTOP_LOCAL, "sess-42");
    expect(canonical).toBe(`${DESKTOP_LOCAL}:sess-42`);
    expect(normalizeDiffReviewSessionKey(`${DESKTOP_LOCAL}\nsess-42`)).toBe(canonical);
    expect(normalizeReviewPath("/Users/dev/repo/src/app.ts", "/Users/dev/repo")).toBe("src/app.ts");
    expect(normalizeReviewPath("C:\\work\\repo\\src\\index.ts", "C:\\work\\repo")).toBe("src/index.ts");

    diffReviewStore.getState().addComment({
      sessionKey: `${DESKTOP_LOCAL}\nsess-42`,
      path: normalizeReviewPath("/Users/dev/repo/src/app.ts", "/Users/dev/repo"),
      side: "new",
      startLine: 12,
      endLine: 12,
      snippet: "const ok = true;",
      comment: "Rename variable",
    });

    const comments = diffReviewStore.getState().bySession[canonical] ?? [];
    expect(comments).toHaveLength(1);
    expect(comments[0]?.path).toBe("src/app.ts");
    expect(comments[0]?.comment).toBe("Rename variable");
  });

  it("renders DiffBlock split mode as a single <table> per hunk, allows comments on context lines, and omits +0/-0 DiffStat noise", async () => {
    await act(async () => {
      root.render(
        <I18nProvider>
          <DiffStatBadge added={4} removed={0} />
          <DiffStatBadge added={0} removed={3} />
          <DiffBlock
            change={{
              type: "diff",
              path: "/repo/src/demo.ts",
              oldText: "const a = 1;\nconst b = 2;\nconst c = 3;\n",
              newText: "const a = 1;\nconst b = 20;\nconst c = 3;\n",
            }}
            computerKey={DESKTOP_LOCAL}
            sessionId="sess-split"
            cwd="/repo"
          />
        </I18nProvider>,
      );
    });

    const statBadges = Array.from(host.querySelectorAll(".ls-diff-stat"));
    expect(statBadges[0]?.textContent).toBe("+4");
    expect(statBadges[1]?.textContent).toBe("−3");

    // Switch DiffBlock to split mode via its accessible label
    const splitBtn = host.querySelector<HTMLButtonElement>('button[aria-label*="并排"]');
    expect(splitBtn).toBeTruthy();
    await act(async () => {
      splitBtn!.click();
    });

    // Single <table> per hunk (not two independent left/right tables)
    const tables = host.querySelectorAll("table.ls-diff-split-table");
    expect(tables).toHaveLength(1);

    // Context line ("const a = 1;") must expose a working + comment button in split mode
    const contextRow = Array.from(tables[0]!.querySelectorAll("tr")).find((tr) =>
      tr.textContent?.includes("const a = 1;"),
    );
    expect(contextRow).toBeTruthy();
    const addCommentBtn = contextRow!.querySelector<HTMLButtonElement>(".ls-diff-comment-btn");
    expect(addCommentBtn).toBeTruthy();

    await act(async () => {
      addCommentBtn!.click();
    });

    const textarea = host.querySelector<HTMLTextAreaElement>(".ls-diff-comment-input");
    expect(textarea).toBeTruthy();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(textarea, "Check context invariant");
      textarea!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const submitBtn = Array.from(
      host.querySelectorAll<HTMLButtonElement>(".ls-diff-comment-actions button"),
    ).find((btn) => !btn.disabled && btn.textContent?.includes("添加"));
    expect(submitBtn).toBeTruthy();
    await act(async () => {
      submitBtn!.click();
    });

    const canonical = diffReviewSessionKey(DESKTOP_LOCAL, "sess-split");
    const saved = diffReviewStore.getState().bySession[canonical] ?? [];
    expect(saved).toHaveLength(1);
    expect(saved[0]?.path).toBe("src/demo.ts");
    expect(saved[0]?.comment).toBe("Check context invariant");
  });

  it("virtualizes large files (>400 lines) in FileViewerTabPanel and reads only once per path", async () => {
    const bigContent = Array.from({ length: 1200 }, (_, i) => `export const line_${i + 1} = ${i + 1};`).join("\n");
    const readSpy = vi.fn(async (method: string) => {
      if (method === "fs.read") {
        return {
          kind: "text",
          path: "/repo/big.ts",
          text: bigContent,
          size: bigContent.length,
          truncated: false,
          nextOffset: undefined,
          modifiedAt: 1000,
        };
      }
      return {};
    });
    const conn = makeConnection({}, readSpy);

    await act(async () => {
      root.render(
        <I18nProvider>
          <DialogProvider>
            <FileViewerTabPanel
              computerKey={DESKTOP_LOCAL}
              sessionId="sess-1"
              connection={conn}
              online
              cwd="/repo"
              filePath="/repo/big.ts"
            />
          </DialogProvider>
        </I18nProvider>,
      );
    });

    const scroller = host.querySelector<HTMLElement>(".inspector-source-scroll");
    expect(scroller?.dataset.virtualized).toBe("true");
    const renderedLines = host.querySelectorAll(".inspector-source-line");
    expect(renderedLines.length).toBeGreaterThan(0);
    // Windowed rendering mounts only the visible viewport + overscan, not all 1,200 lines.
    expect(renderedLines.length).toBeLessThan(200);
    expect(readSpy.mock.calls.filter(([m]) => m === "fs.read")).toHaveLength(1);
  });

  it("parses large markdown documents linearly in markdownBlocks without O(N^2) stalls", () => {
    const doc = Array.from({ length: 1000 }, (_, i) =>
      i % 20 === 0
        ? `## Section ${i}\n\n\`\`\`ts\nconst x${i} = ${i};\n\`\`\`\n`
        : `- item ${i} value`,
    ).join("\n");
    const start = performance.now();
    const blocks = markdownBlocks(doc);
    const elapsed = performance.now() - start;
    expect(blocks.length).toBeGreaterThan(40);
    expect(elapsed).toBeLessThan(250);
  });

  it("uses Ctrl on Linux/Windows and ⌘ on macOS for shortcut formatting & matching", () => {
    expect(formatShortcut(DESKTOP_SHORTCUTS.palette, "macos")).toBe("⌘K");
    expect(formatShortcut(DESKTOP_SHORTCUTS.palette, "linux")).toBe("Ctrl+K");
    expect(formatShortcut(DESKTOP_SHORTCUTS.palette, "windows")).toBe("Ctrl+K");

    const ctrlK = new KeyboardEvent("keydown", { key: "k", code: "KeyK", ctrlKey: true });
    const metaK = new KeyboardEvent("keydown", { key: "k", code: "KeyK", metaKey: true });
    expect(matchesShortcut(ctrlK, DESKTOP_SHORTCUTS.palette, "linux")).toBe(true);
    expect(matchesShortcut(metaK, DESKTOP_SHORTCUTS.palette, "linux")).toBe(false);
    expect(matchesShortcut(metaK, DESKTOP_SHORTCUTS.palette, "macos")).toBe(true);
  });

  it("searches beyond 24 sessions in CommandCenter with fuzzy camelCase scoring, approval/triage priority, and Ctrl badges on Linux", async () => {
    expect(fuzzyMatchScore("cc", "CommandCenter")).toBeGreaterThan(
      fuzzyMatchScore("cc", "abc_def_c"),
    );
    expect(fuzzyMatchScore("xyz", "CommandCenter")).toBe(-1);

    const sessions: Record<string, SessionSummary> = {};
    for (let i = 1; i <= 35; i++) {
      sessions[`sess-${i}`] = makeSession(i, {
        title: i === 35 ? "NeedleThirtyFive" : `Task ${i}`,
        state: i === 30 ? "waiting" : "idle",
        permission:
          i === 30
            ? {
                id: "perm-30",
                toolCallId: "tc-30",
                title: "Approve deploy",
                options: [],
              }
            : undefined,
      });
    }
    const conn = makeConnection(sessions);
    engine.state.setState({
      computers: [conn.computer],
      connection: conn,
      ready: true,
    });
    routerStore.getState().setCommandCenterOpen(true);

    await act(async () => {
      root.render(
        <I18nProvider>
          <CommandCenter
            onRequestNewSession={() => {}}
            platformOverride="linux"
          />
        </I18nProvider>,
      );
    });

    // Approval/triage session #30 should surface even with 35 sessions.
    expect(host.textContent).toContain("Task 30");

    // Search for session #35 (well past the old 24-session cap)
    const searchInput = host.querySelector<HTMLInputElement>("input.ls-cc-input, input[type='text'], input");
    expect(searchInput).toBeTruthy();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(searchInput, "NeedleThirtyFive");
      searchInput!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(host.textContent).toContain("NeedleThirtyFive");
    expect(host.textContent).not.toContain("⌘K");
  });

  it("persists composer pastedBlocks across session switches and parses @file mentions stably", () => {
    const keyA = draftKeyFor(DESKTOP_LOCAL, "sess-a");
    const keyB = draftKeyFor(DESKTOP_LOCAL, "sess-b");
    const block = createPastedBlock("x".repeat(40_000));
    composerPastedDrafts.getState().update(keyA, [block]);
    composerPastedDrafts.getState().update(keyB, []);

    expect(composerPastedDrafts.getState().read(keyA)).toHaveLength(1);
    expect(composerPastedDrafts.getState().read(keyA)[0]?.text).toBe(block.text);
    expect(composerPastedDrafts.getState().read(keyB)).toHaveLength(0);

    // Mid-token caret replaces the entire @path token and rejects @@
    expect(detectAtFileMention("inspect @src/app.ts please", 16)).toEqual({
      start: 8,
      end: 19,
      query: "src/app",
    });
    expect(detectAtFileMention("@@invalid", 9)).toBeNull();
  });

  it("disposes terminal stage controllers per computer cleanly", () => {
    const controller = getTerminalStageController("remote-mac", "term-1");
    expect(controller).toBeTruthy();
    const disposeSpy = vi.spyOn(controller, "disposeAll");
    disposeTerminalStagesForComputer("remote-mac");
    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });

  it("continues subsequent Fusion icon batches even when an earlier batch fails", async () => {
    const bundles = Array.from({ length: 60 }, (_, i) => `com.example.app${i}`);
    let calls = 0;
    const controller = createFusionController({
      invoke: async (method, params) => {
        if (method === "fusionIcons") {
          calls++;
          const batch = (params as { bundles: string[] }).bundles;
          if (calls === 1) throw new Error("transient batch 1 failure");
          return {
            icons: Object.fromEntries(
              batch.map((b) => [b, { dataUrl: `data:image/png;base64,AAA_${b}`, fetchedAt: 1 }]),
            ),
          };
        }
        return {};
      },
    });

    await controller.loadFusionIcons("remote-mac", "remote-mac", bundles);
    expect(calls).toBe(2);
    const icons = controller.store.getState().byComputer["remote-mac"]?.icons ?? {};
    expect(Object.keys(icons).length).toBe(12);
  });

  it("uses valid WCAG focus outlines across desktop-ui CSS and localized search-clear ARIA label in FilesPanel", async () => {
    const stylesDir = resolve(process.cwd(), "src/styles");
    const cssFiles = readdirSync(stylesDir).filter((f) => f.endsWith(".css"));
    for (const file of cssFiles) {
      const css = readFileSync(resolve(stylesDir, file), "utf8");
      expect(css, `${file} must not use invalid box-shadow token in outline:`).not.toMatch(
        /outline:\s*var\(--ls-focus-ring\)/,
      );
    }

    const conn = makeConnection({}, async (method) => {
      if (method === "fs.list") return { path: "/repo", entries: [] };
      if (method === "fs.projectFiles") return { files: ["src/index.ts"] };
      return {};
    });
    await act(async () => {
      root.render(
        <I18nProvider>
          <DialogProvider>
            <FilesPanel
              computerKey={DESKTOP_LOCAL}
              sessionId="sess-1"
              connection={conn}
              online
              cwd="/repo"
              onOpenFile={() => {}}
            />
          </DialogProvider>
        </I18nProvider>,
      );
    });
    const searchInput = host.querySelector<HTMLInputElement>('.ls-files-search input[type="search"]');
    expect(searchInput).toBeTruthy();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(searchInput, "index");
      searchInput!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const clearBtn = host.querySelector<HTMLButtonElement>(".ls-files-search button");
    expect(clearBtn).toBeTruthy();
    expect(clearBtn!.getAttribute("aria-label")).not.toContain("评论");
    expect(clearBtn!.getAttribute("aria-label")).toContain("搜索");
  });

  it("displays an error alert in SystemHostModal when a confirmed host action fails", async () => {
    const prevBridge = window.linkshellDesktop;
    window.linkshellDesktop = {
      shell: "electron",
      platform: "darwin",
      appearance: () => "dark",
      visible: () => true,
      postMessage(message: Record<string, unknown>) {
        if (message.action === "invoke" && typeof message.id === "string") {
          const id = message.id;
          const method = String(message.method ?? "");
          if (method === "action") {
            queueMicrotask(() => {
              window.dispatchEvent(
                new CustomEvent("linkshell-desktop-reply", {
                  detail: { id, error: "LaunchAgent stop timed out" },
                }),
              );
            });
          } else {
            queueMicrotask(() => {
              window.dispatchEvent(
                new CustomEvent("linkshell-desktop-reply", {
                  detail: {
                    id,
                    result: {
                      status: "running",
                      healthy: true,
                      version: "1.0.0",
                      gateway: "wss://gateway.itool.tech",
                      pairedDevices: [],
                      permissions: { screenRecording: true, accessibility: true },
                    },
                  },
                }),
              );
            });
          }
        }
      },
    };

    try {
      managementStore.setState({
        snapshot: {
          status: "running",
          healthy: true,
          version: "1.0.0",
          gateway: "wss://gateway.itool.tech",
          pairedDevices: [],
          permissions: { screenRecording: true, accessibility: true },
        } as unknown as NonNullable<ReturnType<typeof managementStore.getState>["snapshot"]>,
      });
      routerStore.getState().openSystemModal("overview");

      await act(async () => {
        root.render(
          <I18nProvider>
            <DialogProvider>
              <SystemHostModal />
            </DialogProvider>
          </I18nProvider>,
        );
      });

      const stopBtn = Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find((btn) =>
        btn.textContent?.includes("停止"),
      );
      expect(stopBtn).toBeTruthy();
      await act(async () => {
        stopBtn!.click();
      });

      // Confirm in the stacked AlertDialog (the second open <dialog>)
      const dialogs = Array.from(document.querySelectorAll<HTMLDialogElement>("dialog"));
      const alertDialog = dialogs[dialogs.length - 1];
      const confirmBtn = Array.from(alertDialog?.querySelectorAll<HTMLButtonElement>("button") ?? []).find(
        (btn) => btn.textContent?.includes("停止") || btn.textContent?.includes("确认"),
      );
      expect(confirmBtn).toBeTruthy();
      await act(async () => {
        confirmBtn!.click();
        await new Promise((r) => setTimeout(r, 10));
      });

      const alert = document.querySelector('[role="alert"]');
      expect(alert?.textContent).toContain("LaunchAgent stop timed out");
    } finally {
      routerStore.getState().closeSystemModal();
      window.linkshellDesktop = prevBridge;
    }
  });
});
