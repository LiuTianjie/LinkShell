import { describe, expect, it } from "vitest";
import {
  estimateModelCostUsd,
  gitDiffResultSchema,
  HOST_PROTOCOL,
  isMethodName,
  liveActivityPushToStartSchema,
  lsaMethods,
  machineMetricsSchema,
  machineMetricsSnapshotSchema,
  methods,
  notifications,
  RELAY_PATH,
  serverFrameSchema,
  usageReportSchema,
  wakeupNoticeSchema,
} from "../src/index.js";

describe("HOST_PROTOCOL & sacred invariants", () => {
  it("bumps HOST_PROTOCOL to 4 while preserving RELAY_PATH", () => {
    expect(HOST_PROTOCOL).toBe(4);
    expect(RELAY_PATH).toBe("/v2/connect");
  });
});

describe("machineMetricsSchema power and keepAwake telemetry", () => {
  const baseSample = {
    sampledAt: 1_760_000_000_000,
    sampleIntervalMs: 5000,
    cpu: { usage: 18.5, cores: 10, model: "Apple M4" },
    memory: { totalBytes: 34_359_738_368, usedBytes: 17_179_869_184, includesCache: false },
  };

  it("accepts older samples without power or keepAwake", () => {
    expect(machineMetricsSchema.safeParse(baseSample).success).toBe(true);
  });

  it("validates power (battery / AC) and keepAwake modes on snapshot and history", () => {
    const sampleWithPower = {
      ...baseSample,
      power: { onBattery: true, percent: 15, charging: false },
      keepAwake: { mode: "smart" as const, active: true, reason: "running_session" },
    };
    const parsed = machineMetricsSnapshotSchema.parse({
      ...sampleWithPower,
      history: [sampleWithPower, { ...baseSample, power: { onBattery: false, percent: null } }],
    });
    expect(parsed.power).toEqual({ onBattery: true, percent: 15, charging: false });
    expect(parsed.keepAwake).toEqual({ mode: "smart", active: true, reason: "running_session" });
    expect(parsed.history).toHaveLength(2);
  });

  it("rejects out-of-range battery percentages or invalid keepAwake modes", () => {
    expect(
      machineMetricsSchema.safeParse({
        ...baseSample,
        power: { onBattery: true, percent: 120 },
      }).success,
    ).toBe(false);
    expect(
      machineMetricsSchema.safeParse({
        ...baseSample,
        keepAwake: { mode: "forever", active: true },
      }).success,
    ).toBe(false);
  });
});

describe("usageReportSchema & estimateModelCostUsd", () => {
  it("estimates deterministic positive USD cost across Claude, GPT/Codex, Gemini, and unknown models", () => {
    expect(estimateModelCostUsd("claude-sonnet-4.5", { inputTokens: 0, outputTokens: 0 })).toBe(0);

    // Claude Sonnet: $3/M input, $15/M output, $0.30/M cache read, $3.75/M cache write
    const sonnetCost = estimateModelCostUsd("claude-sonnet-4.5", {
      inputTokens: 1_000_000,
      outputTokens: 200_000,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 100_000,
    });
    expect(sonnetCost).toBeCloseTo(3 + 3 + 0.3 + 0.375, 6);

    // GPT-5 / Codex: $1.25/M input, $10/M output, $0.125/M cache read
    const codexCost = estimateModelCostUsd("gpt-5.3-codex", {
      inputTokens: 2_000_000,
      outputTokens: 500_000,
      cacheReadTokens: 4_000_000,
    });
    expect(codexCost).toBeCloseTo(2.5 + 5 + 0.5, 6);

    // Unknown model uses fallback rate cleanly and ignores negative inputs
    expect(estimateModelCostUsd("custom-local-acp", { inputTokens: 500_000, outputTokens: 100_000 })).toBeGreaterThan(0);
    expect(estimateModelCostUsd("gpt-5", { inputTokens: -100, outputTokens: 0 })).toBe(0);
  });

  it("validates usageReportSchema with optional estimatedCostUsd and remoteStats", () => {
    const report = usageReportSchema.parse({
      generatedAt: Date.now(),
      days: 7,
      agent: "all",
      timezone: "Asia/Shanghai",
      totals: {
        records: 12,
        sessions: 3,
        inputTokens: 100_000,
        outputTokens: 25_000,
        cacheReadTokens: 400_000,
        cacheWriteTokens: 10_000,
        totalTokens: 535_000,
        estimatedCostUsd: 1.42,
      },
      daily: [],
      models: [
        {
          agent: "codex",
          model: "gpt-5.2-codex",
          records: 12,
          sessions: 3,
          inputTokens: 100_000,
          outputTokens: 25_000,
          cacheReadTokens: 400_000,
          cacheWriteTokens: 10_000,
          totalTokens: 535_000,
          estimatedCostUsd: 1.42,
        },
      ],
      estimatedCostUsd: 1.42,
      remoteStats: { remoteTurns: 18, remoteApprovals: 27 },
      warnings: [],
    });
    expect(report.totals.estimatedCostUsd).toBe(1.42);
    expect(report.remoteStats).toEqual({ remoteTurns: 18, remoteApprovals: 27 });
  });
});

describe("liveActivities.registerPushToStart & zero-plaintext wakeupNoticeSchema", () => {
  const grant = "a".repeat(64);

  it("validates push-to-start registration for iOS and Android", () => {
    const payload = {
      deviceId: "device-iphone-16",
      pushToStartToken: "apns-push-to-start-hex-token-0123456789abcdef",
      platform: "ios" as const,
      serviceUrl: "https://gateway.itool.tech/v2/live-activity",
      grant,
      expiresAt: 1_800_000_000_000,
      computerKey: "gateway:macbook-pro",
    };
    expect(liveActivityPushToStartSchema.parse(payload)).toEqual(payload);
    expect(methods["liveActivities.registerPushToStart"].params.parse(payload)).toEqual(payload);
  });

  it("validates zero-plaintext wakeup notices and strips unknown fields", () => {
    const parsed = wakeupNoticeSchema.parse({
      machineId: "machine-1",
      sessionId: "codex:thread-9",
      eventType: "approval",
      createdAt: 1_760_000_000_000,
      secretPromptShouldBeDropped: "never-sent",
    });
    expect(parsed).toEqual({
      machineId: "machine-1",
      sessionId: "codex:thread-9",
      eventType: "approval",
      createdAt: 1_760_000_000_000,
    });
    expect(notifications["liveActivities.wakeup"].safeParse(parsed).success).toBe(true);
  });
});

describe("new host RPC methods & LSA Phase 1 contracts", () => {
  it("registers all roadmap RPC methods in methods map", () => {
    const expectedMethods = [
      "liveActivities.registerPushToStart",
      "machine.keepAwake",
      "git.diff",
      "git.revertFile",
      "fs.projectFiles",
      "clipboard.read",
      "clipboard.write",
      "screen.privacy",
      "lsa.status",
      "lsa.tasks",
      "lsa.dispatch",
      "lsa.steer",
      "lsa.decide",
      "lsa.memories",
      "lsa.followups",
    ] as const;
    for (const name of expectedMethods) {
      expect(isMethodName(name)).toBe(true);
    }
  });

  it("validates git.diff, git.revertFile, fs.projectFiles, clipboard.*, and screen.privacy schemas", () => {
    expect(methods["machine.keepAwake"].params.parse({ mode: "smart" })).toEqual({ mode: "smart" });
    expect(methods["machine.keepAwake"].result.parse({ mode: "smart", active: false })).toEqual({ mode: "smart", active: false });

    const diffResult = gitDiffResultSchema.parse({
      branch: "main",
      truncated: false,
      files: [
        {
          path: "src/index.ts",
          status: "modified",
          oldText: "const a = 1;\n",
          newText: "const a = 2;\n",
          additions: 1,
          deletions: 1,
        },
        {
          path: "assets/logo.png",
          status: "untracked",
          oldText: "",
          newText: "",
          additions: 0,
          deletions: 0,
          binary: true,
        },
      ],
    });
    expect(diffResult.files).toHaveLength(2);

    expect(methods["git.revertFile"].params.parse({ cwd: "/repo", path: "src/index.ts" })).toEqual({
      cwd: "/repo",
      path: "src/index.ts",
    });
    expect(methods["git.revertFile"].result.parse({ ok: true })).toEqual({ ok: true });

    expect(
      methods["fs.projectFiles"].result.parse({
        files: [{ path: "/repo/src/app.tsx", relativePath: "src/app.tsx", isDir: false }],
        truncated: false,
      }).files[0]?.relativePath,
    ).toBe("src/app.tsx");

    expect(methods["clipboard.write"].params.parse({ text: "otp-839201" })).toEqual({ text: "otp-839201" });
    expect(methods["clipboard.read"].result.parse({ text: "otp-839201" })).toEqual({ text: "otp-839201" });

    expect(
      methods["screen.privacy"].result.parse({ curtain: true, lockOnDisconnect: true, supported: true }),
    ).toEqual({ curtain: true, lockOnDisconnect: true, supported: true });
  });

  it("validates LSA Phase 1 schemas (status, tasks, dispatch, steer, decide, memories, followups)", () => {
    const status = lsaMethods["lsa.status"].result.parse({
      enabled: true,
      controllerEpoch: 3,
      generation: 1,
      activeTasks: 1,
      waitingDecisionTasks: 0,
      dueFollowups: 1,
      requiresYearlyTier: true,
      candidates: [{ cwd: "/Users/dev/app", name: "app", score: 0.95, reason: "recent_session" }],
    });
    expect(status.requiresYearlyTier).toBe(true);

    const dispatched = lsaMethods["lsa.dispatch"].params.parse({
      goal: "Fix OAuth redirect loop and run tests",
      cwd: "/Users/dev/app",
      worktree: true,
      acceptanceChecks: ["pnpm test passes", "no TS errors"],
    });
    expect(dispatched.acceptanceChecks).toHaveLength(2);

    const task = {
      id: "lsa-task-1",
      title: "Fix OAuth redirect",
      goal: dispatched.goal,
      status: "waiting_decision" as const,
      cwd: "/Users/dev/app",
      worktree: true,
      agent: "codex",
      sessionId: "codex:th-1",
      controllerEpoch: 3,
      acceptanceChecks: ["pnpm test passes"],
      summary: "All 14 tests passed",
      createdAt: 1_760_000_000_000,
      updatedAt: 1_760_000_060_000,
    };
    expect(lsaMethods["lsa.tasks"].result.parse({ tasks: [task] }).tasks[0]?.status).toBe("waiting_decision");
    expect(lsaMethods["lsa.decide"].params.parse({ taskId: task.id, decision: "accept" }).decision).toBe("accept");
    expect(lsaMethods["lsa.steer"].params.parse({ taskId: task.id, instruction: "Also add regression test" }).taskId).toBe(task.id);

    expect(
      lsaMethods["lsa.memories"].result.parse({
        memories: [{ key: "deploy-rule", content: "Never skip docker build", tags: ["ops"], updatedAt: 1_760_000_000_000 }],
      }).memories[0]?.key,
    ).toBe("deploy-rule");

    expect(
      lsaMethods["lsa.followups"].result.parse({
        followups: [{ id: "fu-1", taskId: task.id, dueAt: 1_760_086_400_000, note: "Verify prod metrics", done: false }],
      }).followups[0]?.done,
    ).toBe(false);
  });

  it("validates sessions.get, pagination beforeId, chunked fs.upload, git.commit, desktop.openPath, and undeliverable channel", () => {
    expect(isMethodName("sessions.get")).toBe(true);
    expect(isMethodName("git.commit")).toBe(true);
    expect(isMethodName("desktop.openPath")).toBe(true);

    expect(methods["sessions.list"].params.parse({ limit: 50, before: 1000, beforeId: "codex:1" })).toEqual({
      limit: 50,
      before: 1000,
      beforeId: "codex:1",
    });
    expect(methods["sessions.list"].result.parse({ sessions: [], nextBefore: 900, nextBeforeId: "codex:0" })).toEqual({
      sessions: [],
      nextBefore: 900,
      nextBeforeId: "codex:0",
    });
    expect(methods["sessions.get"].params.parse({ sessionId: "codex:1" })).toEqual({ sessionId: "codex:1" });
    expect(methods["sessions.get"].result.parse({})).toEqual({});

    expect(
      methods["sessions.create"].params.parse({ agent: "codex", cwd: "/repo", requestId: "req-create-1" }),
    ).toEqual({ agent: "codex", cwd: "/repo", requestId: "req-create-1" });

    expect(
      methods["fs.upload"].params.parse({ dir: "/tmp", name: "video.mp4", data: "AAAA", offset: 1024, appendPath: "/tmp/video.mp4" }),
    ).toEqual({ dir: "/tmp", name: "video.mp4", data: "AAAA", offset: 1024, appendPath: "/tmp/video.mp4" });
    expect(
      methods["fs.upload"].params.safeParse({ dir: "/tmp", name: "huge.bin", data: "A".repeat(30_000_001) }).success,
    ).toBe(false);

    expect(
      methods["git.commit"].params.parse({ cwd: "/repo", message: "feat: commit from phone", stageAll: true, paths: ["src/a.ts"] }),
    ).toEqual({ cwd: "/repo", message: "feat: commit from phone", stageAll: true, paths: ["src/a.ts"] });
    expect(
      methods["git.commit"].result.parse({ sha: "abc1234", branch: "main", summary: "1 file changed" }),
    ).toEqual({ sha: "abc1234", branch: "main", summary: "1 file changed" });

    expect(methods["desktop.openPath"].params.parse({ path: "/repo", app: "cursor" })).toEqual({ path: "/repo", app: "cursor" });
    expect(methods["desktop.openPath"].result.parse({ ok: true })).toEqual({ ok: true });

    expect(
      serverFrameSchema.parse({ t: "undeliverable", to: "peer-1", reason: "offline", channel: "ch-1" }),
    ).toEqual({ t: "undeliverable", to: "peer-1", reason: "offline", channel: "ch-1" });
  });
});
