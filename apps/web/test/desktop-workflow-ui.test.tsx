import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createStore } from "zustand/vanilla";
import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  const loc = { origin: "http://127.0.0.1:41414", hash: "", pathname: "/", search: "", protocol: "http:" };
  if (typeof globalThis.location === "undefined") {
    vi.stubGlobal("location", loc);
  }
  if (typeof globalThis.document === "undefined") {
    vi.stubGlobal("document", Object.assign(new EventTarget(), { documentElement: { dataset: {}, hasAttribute: () => false }, querySelector: () => null }));
  }
  if (typeof globalThis.window === "undefined") {
    vi.stubGlobal(
      "window",
      Object.assign(new EventTarget(), {
        location: loc,
        __LINKSHELL_CONFIG__: { desktop: true },
      }),
    );
  }
});

import { diffLines } from "@linkshell/client-core";
import type { ProjectSummary, SessionSummary } from "@linkshell/wire";
import { buildCommandSessionEntries } from "../src/components/CommandCenter";
import { Dialogs } from "../src/components/Dialogs";
import {
  orderedComputerSessionTargets,
  stepSessionTarget,
} from "../src/components/DesktopShell";
import { Runtime } from "../src/live/common";
import {
  LARGE_PASTE_CHARS,
  buildComposerContentBlocks,
  filesNeedUpload,
  isImeComposing,
  supportsFieldSizingContent,
} from "../src/live/ComposerBox";
import type { Computer, Connection } from "../src/live/engine";
import { Worktrees } from "../src/live/Panels";
import { DiffView, highlightSearchText, pairSplitLines } from "../src/live/Timeline";

function makeSession(partial: Partial<SessionSummary> & { id: string }): SessionSummary {
  return {
    agent: "codex",
    cwd: "/work/app",
    state: "idle",
    archived: false,
    createdAt: 100,
    updatedAt: 100,
    ...partial,
  } as SessionSummary;
}

function makeComputer(key: string, name: string): Computer {
  return {
    key,
    gateway: "https://gateway.example",
    machine: {
      id: `machine-${key}`,
      name,
      signKey: `sign-${key}`,
      boxKey: `box-${key}`,
      online: true,
    },
  } as unknown as Computer;
}

describe("Logical session stepping (⌘⇧[ / ⌘⇧])", () => {
  it("walks project groups and parent->child families without duplicating active sessions", () => {
    const projects: ProjectSummary[] = [
      { cwd: "/work/alpha", name: "alpha" } as ProjectSummary,
      { cwd: "/work/beta", name: "beta" } as ProjectSummary,
    ];
    const sessions: SessionSummary[] = [
      makeSession({ id: "a-1", cwd: "/work/alpha", state: "running", createdAt: 300, updatedAt: 500 }),
      makeSession({ id: "a-2", cwd: "/work/alpha", state: "idle", createdAt: 200, updatedAt: 200 }),
      makeSession({ id: "b-1", cwd: "/work/beta", state: "waiting", createdAt: 400, updatedAt: 600 }),
    ];

    const targets = orderedComputerSessionTargets("desktop:local", projects, sessions);
    expect(targets.map((entry) => entry.sessionId)).toEqual(["b-1", "a-1", "a-2"]);

    // Stepping forward from b-1 -> a-1 -> a-2 -> wraps cleanly back to b-1 (never jumps back into 活跃会话).
    expect(stepSessionTarget(targets, { computerKey: "desktop:local", sessionId: "b-1" }, 1)?.sessionId).toBe("a-1");
    expect(stepSessionTarget(targets, { computerKey: "desktop:local", sessionId: "a-1" }, 1)?.sessionId).toBe("a-2");
    expect(stepSessionTarget(targets, { computerKey: "desktop:local", sessionId: "a-2" }, 1)?.sessionId).toBe("b-1");
    expect(stepSessionTarget(targets, { computerKey: "desktop:local", sessionId: "b-1" }, -1)?.sessionId).toBe("a-2");
  });
});

describe("Multi-computer CommandCenter session indexing", () => {
  it("indexes non-archived sessions across all connected computers with cwd and preview metadata", () => {
    const mac = makeComputer("desktop:local", "Mac Studio");
    const linux = makeComputer("remote:linux", "Devbox");

    const entries = buildCommandSessionEntries(
      [
        {
          computer: mac,
          selected: true,
          state: {
            status: "online",
            sessionsLoaded: true,
            projects: [],
            sessions: {
              s1: makeSession({
                id: "s1",
                title: "Fix IPC startup",
                cwd: "/Users/dev/linkshell",
                preview: "reportDesktopRendererReady handshake",
                updatedAt: 200,
              }),
              archived1: makeSession({
                id: "archived1",
                archived: true,
                updatedAt: 999,
              }),
            },
          } as never,
        },
        {
          computer: linux,
          selected: false,
          state: {
            status: "online",
            sessionsLoaded: true,
            projects: [],
            sessions: {
              s2: makeSession({
                id: "s2",
                title: "Train worker",
                cwd: "/srv/ml-pipeline",
                preview: "CUDA batch throughput",
                updatedAt: 500,
              }),
            },
          } as never,
        },
      ],
      undefined,
      {},
    );

    expect(entries.map((entry) => entry.key)).toEqual(["remote:linux:s2", "desktop:local:s1"]);
    expect(entries[0]!.searchValue).toContain("/srv/ml-pipeline");
    expect(entries[0]!.searchValue).toContain("CUDA batch throughput");
    expect(entries[1]!.searchValue).toContain("/Users/dev/linkshell");
    expect(entries[1]!.searchValue).toContain("reportDesktopRendererReady handshake");
  });
});

describe("ComposerBox paste, IME composition & field-sizing helpers", () => {
  it("guards Enter submit against CJK IME composition (isComposing and keyCode 229)", () => {
    expect(LARGE_PASTE_CHARS).toBe(32_768);
    expect(isImeComposing({ isComposing: false, keyCode: 13 })).toBe(false);
    expect(isImeComposing({ isComposing: true, keyCode: 13 })).toBe(true);
    expect(isImeComposing({ isComposing: false, keyCode: 229 })).toBe(true);
    expect(isImeComposing({ nativeEvent: { isComposing: true, keyCode: 13 } })).toBe(true);
    expect(isImeComposing({ nativeEvent: { isComposing: false, keyCode: 229 } })).toBe(true);
  });

  it("gates JS scrollHeight fallback behind CSS.supports('field-sizing', 'content')", () => {
    const originalCss = globalThis.CSS;
    try {
      vi.stubGlobal("CSS", { supports: (prop: string, val: string) => prop === "field-sizing" && val === "content" });
      expect(supportsFieldSizingContent()).toBe(true);

      vi.stubGlobal("CSS", { supports: () => false });
      expect(supportsFieldSizingContent()).toBe(false);
    } finally {
      vi.stubGlobal("CSS", originalCss);
    }
  });

  it("packages large pasted text attachments alongside typed text and uploaded files", async () => {
    const bigLog = "x".repeat(LARGE_PASTE_CHARS + 128);
    const pdfFile = new File(["hello-pdf"], "spec.pdf", { type: "application/pdf" });
    expect(filesNeedUpload([pdfFile], { images: true })).toBe(true);

    const uploadCalls: Array<{ dir: string; name: string }> = [];
    const blocks = await buildComposerContentBlocks({
      text: "Please analyze this log and spec",
      files: [],
      pastedTexts: [{ id: "paste-1", text: bigLog }],
      uploadDir: "/work/app",
      callUpload: async (dir, name) => {
        uploadCalls.push({ dir, name });
        return { path: `${dir}/${name}` };
      },
    });

    expect(uploadCalls).toHaveLength(0);
    expect(blocks).toEqual([
      { type: "text", text: "Please analyze this log and spec" },
      { type: "text", text: bigLog },
    ]);
  });
});

describe("Split diff view, search highlighting & Worktree actions", () => {
  it("pairs modified hunks side-by-side in DiffView split mode", () => {
    const lines = diffLines("const a = 1;\nconst keep = true;\n", "const a = 2;\nconst b = 3;\nconst keep = true;\n");
    const pairs = pairSplitLines(lines);
    expect(pairs).toHaveLength(3);
    expect(pairs[0]?.left?.kind).toBe("del");
    expect(pairs[0]?.right?.kind).toBe("add");
    expect(pairs[1]?.left).toBeUndefined();
    expect(pairs[1]?.right?.kind).toBe("add");
    expect(pairs[2]?.left?.kind).toBe("same");
    expect(pairs[2]?.right?.kind).toBe("same");

    const html = renderToStaticMarkup(
      createElement(DiffView, {
        lines,
        viewMode: "split",
        comments: { 0: "Check old value" },
        onSelectLine: () => {},
      }),
    );
    expect(html).toContain("diff-view-split");
    expect(html).toContain("diff-split-row");
    expect(html).toContain("Check old value");
  });

  it("wraps case-insensitive search matches in <mark class='timeline-search-hit'>", () => {
    const html = renderToStaticMarkup(
      createElement("div", null, highlightSearchText("Error in SessionPortPreview port 3000", "sessionportpreview")),
    );
    expect(html).toContain('<mark class="timeline-search-hit">SessionPortPreview</mark>');
  });

  it("renders 新建会话, 打开终端, and 浏览文件 actions on Worktrees rows when callbacks are provided", () => {
    const connection = {
      store: createStore(() => ({
        status: "online",
        worktrees: () => Promise.resolve([]),
      })),
      link: {},
    } as unknown as Connection;
    const markup = renderToStaticMarkup(
      createElement(
        Dialogs,
        null,
        createElement(
          Runtime.Provider,
          { value: connection },
          createElement(Worktrees, {
            initialEntries: [
              {
                repo: "/repo",
                path: "/repo/.linkshell-worktrees/feat-ui",
                branch: "feat/ui",
                base: "main",
                dirty: true,
                ahead: 1,
                sessions: [],
              },
            ],
            onNewSession: () => {},
            onOpenTerminal: () => {},
            onBrowseFiles: () => {},
          }),
        ),
      ),
    );
    expect(markup).toContain("feat/ui");
    expect(markup).toContain("新建会话");
    expect(markup).toContain("打开终端");
    expect(markup).toContain("浏览文件");
  });
});

describe("Visual system & performance CSS rules", () => {
  it("keeps conversation.css and desktop-session.css inside @layer components with explicit textarea sizing and no 10px/half-px fonts", () => {
    const conversationCss = readFileSync(new URL("../src/styles/conversation.css", import.meta.url), "utf8");
    const desktopSessionCss = readFileSync(new URL("../src/styles/desktop-session.css", import.meta.url), "utf8");

    expect(conversationCss).toContain("@layer components");
    expect(desktopSessionCss).toContain("@layer components");
    expect(conversationCss).toContain("content-visibility: auto;");
    expect(conversationCss).toContain("contain-intrinsic-size: auto none auto 120px;");
    expect(conversationCss).toContain("field-sizing: content;");
    expect(conversationCss).toContain("width: 100%;");
    expect(conversationCss).toContain("height: auto;");
    expect(desktopSessionCss).toContain("width: 100%; height: auto;");

    for (const css of [conversationCss, desktopSessionCss]) {
      expect(css).not.toMatch(/font-size:\s*10px\b/);
      expect(css).not.toMatch(/font-size:\s*\d+\.5px\b/);
    }
  });
});
