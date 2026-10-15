import type { SessionSummary, TerminalInfo } from "@linkshell/wire";
import { describe, expect, it, vi } from "vitest";

const saved = new Map<string, string>();
vi.mock("expo-sqlite/kv-store", () => ({
  default: {
    getItemSync: (key: string) => saved.get(key) ?? null,
    setItemSync: (key: string, value: string) => saved.set(key, value),
  },
}));
vi.mock("expo-audio", () => ({
  AudioModule: { AudioRecorder: class {} },
  RecordingPresets: { HIGH_QUALITY: {} },
  setAudioModeAsync: vi.fn(),
  setIsAudioActiveAsync: vi.fn(),
}));
vi.mock("react-native", () => ({
  Platform: { OS: "ios", select: (obj: Record<string, unknown>) => obj.ios ?? obj.default },
}));
vi.mock("expo-haptics", () => ({
  impactAsync: vi.fn(),
  notificationAsync: vi.fn(),
  selectionAsync: vi.fn(),
  ImpactFeedbackStyle: {},
  NotificationFeedbackType: {},
}));
vi.mock("../src/lib/client", () => ({
  useConnection: vi.fn(),
}));
vi.mock("../modules/link-layout", () => ({
  startNativeSpeech: vi.fn(),
  stopNativeSpeech: vi.fn(),
  cancelNativeSpeech: vi.fn(),
  subscribeNativeSpeech: vi.fn(() => () => {}),
  setNativeShortcutItems: vi.fn(),
  syncNativeLiveActivity: vi.fn(),
  endNativeLiveActivity: vi.fn(),
  isNativeLiveActivityAvailable: vi.fn(),
}));

const { mergeVoiceTranscript, normalizeDecibels } = await import("../src/lib/voice-input");
const {
  addTerminalSnippet,
  DEFAULT_TERMINAL_SNIPPETS,
  removeTerminalSnippet,
  resetTerminalSnippets,
  swipeKeySteps,
} = await import("../src/lib/terminal-snippets");
const {
  chunkTerminalPasteText,
  cleanTerminalOutputForAgent,
  encodeTerminalKeySequence,
  sanitizeTerminalPasteText,
} = await import("../src/lib/terminal-paste");
const {
  buildIOSShortcutItems,
  buildLiveActivityPayload,
  classifySessionPhase,
  clearSessionSnooze,
  isSessionPinned,
  isSessionSnoozed,
  phasePriority,
  snoozeSession,
  toggleSessionPinned,
} = await import("../src/lib/session-attention");

function makeSession(overrides: Partial<SessionSummary>): SessionSummary {
  return {
    id: "s-1",
    nativeId: "n-1",
    agent: "claude",
    cwd: "/Users/test/linkshell",
    state: "idle",
    archived: false,
    createdAt: 1000,
    updatedAt: 2000,
    lastSeq: 1,
    pendingPermissions: 0,
    ...overrides,
  };
}

describe("voice input helpers", () => {
  it("merges recognized speech with Chinese or English punctuation cleanly", () => {
    expect(mergeVoiceTranscript("", "帮我跑一下测试")).toBe("帮我跑一下测试");
    expect(mergeVoiceTranscript("先看下日志", "再修这个 bug")).toBe("先看下日志，再修这个 bug");
    expect(mergeVoiceTranscript("run", "pnpm test")).toBe("run pnpm test");
  });

  it("normalizes decibel readings into [0.08, 1]", () => {
    expect(normalizeDecibels(undefined)).toBe(0.08);
    expect(normalizeDecibels(-60)).toBe(0.08);
    expect(normalizeDecibels(0)).toBe(1);
    expect(normalizeDecibels(-25)).toBeGreaterThan(0.4);
  });
});

describe("terminal snippets, paste chunking, output cleaning, and touchpad gestures", () => {
  it("calculates discrete cursor/history steps from touch delta", () => {
    expect(swipeKeySteps(5, 16)).toBe(0);
    expect(swipeKeySteps(35, 16)).toBe(2);
    expect(swipeKeySteps(-35, 16)).toBe(-2);
  });

  it("persists custom terminal snippets and restores defaults", () => {
    resetTerminalSnippets();
    const added = addTerminalSnippet({ command: "git log -n 5", label: "git log" });
    expect(saved.get("terminal.snippets.v1")).toContain("git log -n 5");
    removeTerminalSnippet(added.id);
    expect(DEFAULT_TERMINAL_SNIPPETS.length).toBeGreaterThanOrEqual(6);
  });

  it("sanitizes C0 control chars and splits large pastes without breaking surrogate pairs", () => {
    expect(sanitizeTerminalPasteText("echo hi\r\n\x03rm -rf")).toBe("echo hi\rrm -rf");
    const emojiText = "abcdefghijklmno🚀pqrstuvwxyz";
    const chunks = chunkTerminalPasteText(emojiText, 16);
    expect(chunks.join("")).toBe(emojiText);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(16);
    }
  });

  it("cleans ANSI escape sequences and carriage-return overwrites for AI context", () => {
    const raw = "\x1b]0;zsh\x07\x1b[32mBuilding...\rDone!      \x1b[0m\n\x1b[31mError: failed\x1b[0m\n";
    expect(cleanTerminalOutputForAgent(raw)).toBe("Done!\nError: failed");
  });

  it("encodes ctrl, alt, and cmd terminal key sequences", () => {
    expect(encodeTerminalKeySequence("c", { ctrl: true })).toBe("\x03");
    expect(encodeTerminalKeySequence("b", { alt: true })).toBe("\x1bb");
    expect(encodeTerminalKeySequence("k", { cmd: true })).toBe("\x0c");
    expect(encodeTerminalKeySequence("left", { cmd: true })).toBe("\x01");
  });
});

describe("session attention hierarchy, pin/snooze, and iOS Live Activities", () => {
  it("prioritizes waiting_for_approval and waiting_for_input ahead of failed and running", () => {
    const idle = makeSession({ id: "idle", state: "idle" });
    const running = makeSession({ id: "run", state: "running", updatedAt: 5000 });
    const failed = makeSession({ id: "err", state: "error", updatedAt: 4000 });
    const waiting = makeSession({
      id: "wait",
      state: "waiting",
      updatedAt: 3000,
      permission: {
        requestId: "r1",
        title: "运行 pnpm test",
        options: [],
      },
    });

    expect(phasePriority(classifySessionPhase(waiting))).toBe(0);
    expect(phasePriority(classifySessionPhase(failed))).toBe(1);
    expect(phasePriority(classifySessionPhase(running))).toBe(2);
    expect(phasePriority(classifySessionPhase(idle))).toBe(3);
    expect(classifySessionPhase(running, false)).toBe("stale");

    const payload = buildLiveActivityPayload("MacBook-Pro", [idle, running, failed, waiting], [], true);
    expect(payload.active).toBe(true);
    expect(payload.phase).toBe("waiting_for_approval");
    expect(payload.waitingCount).toBe(1);
    expect(payload.runningCount).toBe(1);
    expect(payload.failedCount).toBe(1);
    expect(payload.deepLink).toBe("linkshell:///session/wait");
  });

  it("wakes a snoozed session immediately if it needs attention or starts running", () => {
    const now = 10_000;
    snoozeSession("s-snooze", 60_000, now);
    const idle = makeSession({ id: "s-snooze", state: "idle" });
    expect(isSessionSnoozed(idle, now + 1000)).toBe(true);

    const urgent = makeSession({ id: "s-snooze", state: "waiting" });
    expect(isSessionSnoozed(urgent, now + 1000)).toBe(false);

    clearSessionSnooze("s-snooze");
    expect(isSessionSnoozed(idle, now + 1000)).toBe(false);
  });

  it("pins sessions and builds iOS Home Screen Quick Actions with New Session first", () => {
    const s1 = makeSession({ id: "s-1", title: "重构网关", updatedAt: 1000 });
    const s2 = makeSession({ id: "s-2", title: "修复语音", updatedAt: 2000 });
    toggleSessionPinned("s-1");
    expect(isSessionPinned("s-1")).toBe(true);

    const shortcuts = buildIOSShortcutItems([s1, s2]);
    expect(shortcuts[0]?.href).toBe("/new");
    expect(shortcuts[1]?.href).toBe("/session/s-1");
    expect(shortcuts[2]?.href).toBe("/session/s-2");

    const term: TerminalInfo = {
      id: "t-1",
      title: "pnpm test",
      cwd: "/Users/test/linkshell",
      cols: 80,
      rows: 24,
      createdAt: 1000,
      activeAt: 3000,
    };
    const termPayload = buildLiveActivityPayload("Mac", [], [term], false);
    expect(termPayload.active).toBe(true);
    expect(termPayload.phase).toBe("stale");
  });
});
