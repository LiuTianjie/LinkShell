import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RpcError,
  methods,
  type ContentBlock,
  type SessionSummary,
} from "@linkshell/wire";
import {
  LSA_ENTITLEMENT_METADATA,
  LSA_ROTATION_TOKEN_CAP,
  LsaService,
  LsaStore,
  createLsaService,
  evaluateLsaEntitlement,
  lsaDatabasePath,
  lsaHandlers,
  normalizeGitRemote,
  type LsaFollowup,
  type LsaHostAdapter,
} from "../src/lsa/index.js";

describe("LinkShell Agent (LSA) Phase 1 Steward", () => {
  let homeDir: string;
  let nowMs: number;
  const services: LsaService[] = [];

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), "lsh-lsa-test-"));
    nowMs = 1_760_000_000_000;
  });

  afterEach(() => {
    while (services.length > 0) {
      services.pop()?.close();
    }
    rmSync(homeDir, { recursive: true, force: true });
  });

  function track(service: LsaService): LsaService {
    services.push(service);
    return service;
  }

  function createMockSession(
    id: string,
    cwd: string,
    agent = "codex",
    worktree = false,
  ): SessionSummary {
    return {
      id,
      agent,
      nativeId: id,
      cwd: worktree ? `${cwd}/.worktrees/${id}` : cwd,
      ...(worktree ? { worktree: { branch: `linkshell/${id}`, source: cwd } } : {}),
      state: "running",
      pendingPermissions: 0,
      createdAt: nowMs,
      updatedAt: nowMs,
      lastSeq: 1,
      archived: false,
    };
  }

  it("creates deterministic SQLite tables in <linkshellHome>/lsa.db and survives reopen", async () => {
    const first = track(
      createLsaService({
        home: homeDir,
        initialEpoch: 3,
        now: () => nowMs,
      }),
    );

    const task = await first.workDispatch({
      title: "Fix Safari click handler",
      goal: "Investigate and fix login button click handler in Safari",
      cwd: "/work/web",
      agent: "claude",
      worktree: true,
      acceptanceChecks: ["cmd:pnpm test", "file:src/login.tsx"],
      startSession: false,
    });
    first.memorySave({
      scope: "project:web",
      key: "safari-quirk",
      content: "Safari mobile requires cursor:pointer or button element for touch delegation.",
      tags: ["safari", "ios", "login"],
    });
    const followup = first.followupSchedule({
      taskId: task.id,
      note: "Check production error rate tomorrow morning",
      dueAt: nowMs + 3_600_000,
    });
    const rot = first.checkRotation(165_000, 200_000, {
      idle: true,
      note: "Handing off after login task setup",
    });
    expect(rot.rotated).toBe(true);
    expect(rot.currentGeneration).toBe(2);

    first.close();

    // Verify raw SQLite schema tables & columns directly in <linkshellHome>/lsa.db
    const rawDb = new DatabaseSync(lsaDatabasePath(homeDir));
    const tableNames = (
      rawDb
        .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view')")
        .all() as { name: string }[]
    ).map((r) => r.name);
    expect(tableNames).toEqual(
      expect.arrayContaining([
        "lsa_tasks",
        "lsa_memories",
        "lsa_followups",
        "lsa_generations",
      ]),
    );
    const taskColumns = (
      rawDb.prepare("PRAGMA table_info(lsa_tasks)").all() as { name: string }[]
    ).map((c) => c.name);
    expect(taskColumns).toEqual(
      expect.arrayContaining([
        "id",
        "title",
        "goal",
        "status",
        "cwd",
        "worktree",
        "agent",
        "session_id",
        "controller_epoch",
        "acceptance_json",
        "verification_summary",
        "created_at",
        "updated_at",
      ]),
    );
    rawDb.close();

    // Reopen service on the same <linkshellHome>/lsa.db and verify full state recovery
    const reopened = track(
      createLsaService({
        home: homeDir,
        now: () => nowMs + 1000,
      }),
    );
    expect(reopened.getControllerEpoch()).toBe(3);
    expect(reopened.currentGeneration().generation).toBe(2);

    const inspected = await reopened.workInspect(task.id);
    expect(inspected.task.title).toBe("Fix Safari click handler");
    expect(inspected.task.status).toBe("queued");
    expect(inspected.task.controllerEpoch).toBe(3);
    expect(inspected.task.worktree).toBe(true);
    expect(inspected.task.acceptanceChecks).toEqual(["cmd:pnpm test", "file:src/login.tsx"]);
    expect(inspected.followups.map((f) => f.id)).toEqual([followup.id]);

    const memHits = reopened.memorySearch({ query: "touch delegation", scope: "project:web" });
    expect(memHits).toHaveLength(1);
    expect(memHits[0]?.key).toBe("safari-quirk");

    const gen1 = reopened.store.getGeneration(1);
    expect(gen1?.tokenEstimate).toBe(165_000);
    expect(gen1?.endedAt).toBe(nowMs);
    expect(gen1?.handoffSummary).toContain(task.id);
  });

  it("ranks candidate project directories via fleetLocate by repo name, git remote, and recent sessions", async () => {
    expect(normalizeGitRemote("git@github.com:LiuTianjie/LinkShell.git")).toBe(
      "github.com/LiuTianjie/LinkShell",
    );
    expect(normalizeGitRemote("https://github.com/LiuTianjie/itool-tech.git")).toBe(
      "github.com/LiuTianjie/itool-tech",
    );

    const adapter: LsaHostAdapter = {
      machineId: () => "mac-mini-1",
      listProjects: () => [
        {
          cwd: "/Users/dev/itool-tech",
          name: "itool-tech",
          createdAt: nowMs - 86_400_000 * 30,
          lastActiveAt: nowMs - 86_400_000 * 2,
          sessionCount: 4,
        },
        {
          cwd: "/Users/dev/claude-remote",
          name: "claude-remote",
          createdAt: nowMs - 86_400_000 * 60,
          lastActiveAt: nowMs - 600_000, // active 10 min ago
          sessionCount: 12,
        },
        {
          cwd: "/Users/dev/archive-notes",
          name: "archive-notes",
          createdAt: nowMs - 86_400_000 * 90,
          lastActiveAt: nowMs - 86_400_000 * 45,
          sessionCount: 1,
        },
      ],
      gitInfo: (cwd) => {
        if (cwd.endsWith("claude-remote")) {
          return {
            root: cwd,
            branch: "main",
            dirty: true,
            remote: "git@github.com:LiuTianjie/LinkShell.git",
          };
        }
        if (cwd.endsWith("itool-tech")) {
          return {
            root: cwd,
            branch: "main",
            dirty: false,
            remote: "https://github.com/LiuTianjie/itool-tech.git",
          };
        }
        return undefined;
      },
    };

    const service = track(createLsaService({ home: homeDir, adapter, now: () => nowMs }));

    // Match by git remote slug ("linkshell") even though folder is named "claude-remote"
    const byRemote = await service.fleetLocate("linkshell");
    expect(byRemote.length).toBeGreaterThanOrEqual(1);
    expect(byRemote[0]?.cwd).toBe("/Users/dev/claude-remote");
    expect(byRemote[0]?.remote).toBe("github.com/LiuTianjie/LinkShell");
    expect(byRemote[0]?.recommendWorktree).toBe(true); // dirty tree -> recommend worktree

    // Match by exact directory name ("itool-tech")
    const byName = await service.fleetLocate("itool-tech");
    expect(byName[0]?.cwd).toBe("/Users/dev/itool-tech");
    expect(byName[0]?.recommendWorktree).toBe(false);

    // Empty query ranks all projects with recent active project first
    const allRanked = await service.fleetLocate("");
    expect(allRanked.map((c) => c.name)).toEqual([
      "claude-remote",
      "itool-tech",
      "archive-notes",
    ]);
  });

  it("enforces monotonic controllerEpoch and blocks stale epochs or hijacked sessions from mutating tasks", async () => {
    const prompts: Array<{ sessionId: string; text: string }> = [];
    const cancelled: string[] = [];
    const hijackedSessions = new Set<string>();
    let seq = 0;

    const adapter: LsaHostAdapter = {
      createSession: async ({ agent, cwd, worktree }) => {
        seq += 1;
        return createMockSession(`${agent}:sess-${seq}`, cwd, agent, Boolean(worktree));
      },
      promptSession: async ({ sessionId, content }) => {
        const text = content.map((b: ContentBlock) => (b.type === "text" ? b.text : "")).join("\n");
        prompts.push({ sessionId, text });
        return "started";
      },
      cancelSession: async (sessionId) => {
        cancelled.push(sessionId);
      },
      isSessionHijacked: (sessionId) => hijackedSessions.has(sessionId),
    };

    const service = track(
      createLsaService({
        home: homeDir,
        adapter,
        initialEpoch: 2,
        now: () => nowMs,
      }),
    );

    // Dispatch with stale epoch (< 2) is immediately rejected
    await expect(
      service.workDispatch({
        goal: "Stale dispatch",
        cwd: "/work/repo",
        controllerEpoch: 1,
      }),
    ).rejects.toMatchObject({ appCode: "fenced" });

    // Dispatch with higher epoch (4) monotonically advances controllerEpoch to 4
    const taskEpoch4 = await service.workDispatch({
      goal: "Upgrade auth middleware",
      cwd: "/work/repo",
      agent: "codex",
      worktree: true,
      controllerEpoch: 4,
    });
    expect(service.getControllerEpoch()).toBe(4);
    expect(taskEpoch4.status).toBe("running");
    expect(taskEpoch4.sessionId).toBe("codex:sess-1");
    expect(taskEpoch4.worktreePath).toBe("/work/repo/.worktrees/codex:sess-1");

    // Steering with matching epoch 4 works
    const steered = await service.workSteer({
      taskId: taskEpoch4.id,
      instruction: "Also add rate-limit headers",
      controllerEpoch: 4,
    });
    expect(steered.status).toBe("running");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.text).toContain("rate-limit headers");

    // Steering with stale callerEpoch 3 is rejected without touching session
    await expect(
      service.workSteer({
        taskId: taskEpoch4.id,
        instruction: "Malicious stale steer",
        controllerEpoch: 3,
      }),
    ).rejects.toMatchObject({ appCode: "fenced" });
    expect(prompts).toHaveLength(1);

    // Simulate desktop takeover / session hijack -> blocks steer & decide on hijacked session
    hijackedSessions.add("codex:sess-1");
    await expect(
      service.workSteer({
        taskId: taskEpoch4.id,
        instruction: "Do not interrupt desktop user",
      }),
    ).rejects.toMatchObject({ appCode: "fenced" });
    expect((await service.workInspect(taskEpoch4.id)).hijacked).toBe(true);
    hijackedSessions.delete("codex:sess-1");

    // Advance host epoch to 5 (new controller takes over) -> old epoch-4 task is fenced
    expect(service.advanceControllerEpoch(5)).toBe(5);
    expect((await service.workInspect(taskEpoch4.id)).fenced).toBe(true);

    await expect(
      service.workSteer({
        taskId: taskEpoch4.id,
        instruction: "Stale controller epoch 4 steer",
      }),
    ).rejects.toMatchObject({ appCode: "fenced" });

    await expect(
      service.workDecide({
        taskId: taskEpoch4.id,
        decision: "cancel",
      }),
    ).rejects.toMatchObject({ appCode: "fenced" });
    expect(cancelled).toHaveLength(0);

    // Post-turn hook also refuses to mutate or auto-steer fenced tasks
    const fencedTurn = await service.onSessionTurnEnded("codex:sess-1", { exitCode: 1 });
    expect(fencedTurn.action).toBe("fenced");
    expect(prompts).toHaveLength(1);
  });

  it("runs post-turn automated acceptance verification with bounded auto-steer retries and workDecide transitions", async () => {
    const repoDir = join(homeDir, "sample-project");
    mkdirSync(join(repoDir, "src"), { recursive: true });

    let testExitCode = 1;
    let gitDirty = true;
    const promptsSent: string[] = [];

    const adapter: LsaHostAdapter = {
      createSession: async ({ agent, cwd }) => createMockSession(`${agent}:worker-1`, cwd, agent),
      promptSession: async ({ content }) => {
        promptsSent.push(
          content.map((b: ContentBlock) => (b.type === "text" ? b.text : "")).join("\n"),
        );
        return "started";
      },
      runCommand: async (command) => ({
        exitCode: testExitCode,
        stdout: testExitCode === 0 ? `PASS ${command}` : "",
        stderr: testExitCode === 0 ? "" : `FAIL ${command}: assertion error`,
      }),
      gitInfo: (cwd) => ({
        root: cwd,
        branch: "linkshell/fix-auth",
        dirty: gitDirty,
        changedFiles: gitDirty ? ["src/auth.ts"] : [],
      }),
    };

    const service = track(
      createLsaService({
        home: homeDir,
        adapter,
        defaultMaxRetries: 2,
        now: () => (nowMs += 1_000),
      }),
    );

    const task = await service.workDispatch({
      goal: "Create src/auth.ts, ensure tests pass, and commit cleanly",
      cwd: repoDir,
      acceptanceChecks: [
        "exit:0",
        "cmd:vitest run",
        "file:src/auth.ts",
        "clean_diff",
        "output:READY_FOR_REVIEW",
      ],
    });
    expect(task.status).toBe("running");

    // Turn 1 ends: file missing, test Exit 1, dirty tree -> Auto-steer retry 1/2
    const turn1 = await service.onSessionTurnEnded("codex:worker-1", {
      exitCode: 0,
      finalMessage: "Initial draft written.",
    });
    expect(turn1.action).toBe("auto_retried");
    expect(turn1.passed).toBe(false);
    expect(turn1.task?.status).toBe("running");
    expect(turn1.task?.retryCount).toBe(1);
    expect(promptsSent).toHaveLength(1);
    expect(promptsSent[0]).toContain("Retry 1/2");

    // Turn 2 ends: agent creates file, but tests still fail -> Auto-steer retry 2/2
    writeFileSync(join(repoDir, "src", "auth.ts"), "export const ok = true;\n");
    const turn2 = await service.onSessionTurnEnded("codex:worker-1", {
      exitCode: 0,
      finalMessage: "Added src/auth.ts.",
    });
    expect(turn2.action).toBe("auto_retried");
    expect(turn2.task?.retryCount).toBe(2);
    expect(promptsSent).toHaveLength(2);

    // Turn 3 ends: retries exhausted (2/2) while clean_diff still dirty -> transitions to waiting_decision!
    testExitCode = 0;
    const turn3 = await service.onSessionTurnEnded("codex:worker-1", {
      exitCode: 0,
      finalMessage: "Tests pass now! READY_FOR_REVIEW",
    });
    expect(turn3.action).toBe("waiting_decision");
    expect(turn3.task?.status).toBe("waiting_decision");
    expect(promptsSent).toHaveLength(2); // Did NOT exceed maxRetries!

    // Owner decides "retry" with feedback -> resumes running and sends retry instruction
    const retriedByOwner = await service.workDecide({
      taskId: task.id,
      decision: "retry",
      feedback: "Commit the remaining working tree changes so git status is clean.",
    });
    expect(retriedByOwner.status).toBe("running");
    expect(retriedByOwner.retryCount).toBe(3);
    expect(promptsSent).toHaveLength(3);
    expect(promptsSent[2]).toContain("Commit the remaining working tree changes");

    // Turn 4 ends: all 5 checks pass -> automatically transitions to completed!
    gitDirty = false;
    const turn4 = await service.onSessionTurnEnded("codex:worker-1", {
      exitCode: 0,
      finalMessage: "Committed cleanly. READY_FOR_REVIEW",
    });
    expect(turn4.action).toBe("completed");
    expect(turn4.passed).toBe(true);
    expect(turn4.task?.status).toBe("completed");
    expect(turn4.checks.every((c) => c.passed === true)).toBe(true);

    // Also verify path traversal inside `file:` check is deterministically blocked
    const traversalTask = await service.workDispatch({
      goal: "Attempt path escape check",
      cwd: repoDir,
      maxRetries: 0,
      acceptanceChecks: ["file:../../etc/passwd"],
    });
    // Patch distinct session so it resolves unambiguously
    service.store.updateTask(traversalTask.id, { sessionId: "codex:traversal-sess" });
    const traversalOutcome = await service.onSessionTurnEnded("codex:traversal-sess", {
      exitCode: 0,
    });
    expect(traversalOutcome.passed).toBe(false);
    expect(traversalOutcome.action).toBe("waiting_decision");
    expect(traversalOutcome.checks[0]?.evidence).toContain("Blocked path traversal");
  });

  it("rotates steward context at 70% window or 160k token cap ONLY at safe idle boundaries", async () => {
    const service = track(createLsaService({ home: homeDir, now: () => (nowMs += 500) }));

    await service.workDispatch({
      title: "Ongoing migration",
      goal: "Migrate billing webhook",
      cwd: "/work/billing",
      startSession: false,
    });
    service.followupSchedule({
      note: "Verify Stripe/Creem webhook logs",
      dueAt: nowMs + 60_000,
    });
    service.memorySave({
      key: "billing-db",
      content: "Billing tables live in itool_licensing schema.",
      tags: ["billing"],
    });

    // 1. Below both 70% (140k of 200k) and 160k -> no rotation
    const below = service.checkRotation(100_000, 200_000);
    expect(below.rotated).toBe(false);
    expect(below.shouldRotate).toBe(false);
    expect(below.currentGeneration).toBe(1);
    expect(service.currentGeneration().tokenEstimate).toBe(100_000);

    // 2. Reaches 70% of 200k window (140,000 tokens), BUT steward is mid-turn (unsafe boundary) -> deferred!
    service.setStewardBusy(true);
    const deferredBusy = service.checkRotation(140_000, 200_000);
    expect(deferredBusy.rotated).toBe(false);
    expect(deferredBusy.shouldRotate).toBe(true);
    expect(deferredBusy.deferred).toBe(true);
    expect(deferredBusy.reason).toBe("busy_unsafe_boundary");
    expect(service.currentGeneration().generation).toBe(1);

    // 3. Reaches safe idle boundary -> rotates generation 1 -> 2 at 70% threshold!
    service.setStewardBusy(false);
    const rotated70 = service.checkRotation(140_000, 200_000, {
      note: "Safe point after billing planning",
    });
    expect(rotated70.rotated).toBe(true);
    expect(rotated70.reason).toBe("window_70_percent");
    expect(rotated70.previousGeneration).toBe(1);
    expect(rotated70.currentGeneration).toBe(2);
    expect(rotated70.handoff?.activeTasks).toHaveLength(1);
    expect(rotated70.handoff?.pendingFollowups).toHaveLength(1);
    expect(rotated70.handoff?.recentMemories[0]?.key).toBe("billing-db");

    // 4. On a 1M context window (70% = 700k), 160,000 absolute cap triggers first!
    const deferredExplicit = service.checkRotation(LSA_ROTATION_TOKEN_CAP, 1_000_000, {
      idle: false,
    });
    expect(deferredExplicit.rotated).toBe(false);
    expect(deferredExplicit.deferred).toBe(true);

    const rotated160k = service.checkRotation(LSA_ROTATION_TOKEN_CAP, 1_000_000, {
      idle: true,
    });
    expect(rotated160k.rotated).toBe(true);
    expect(rotated160k.reason).toBe("token_cap_160k");
    expect(rotated160k.previousGeneration).toBe(2);
    expect(rotated160k.currentGeneration).toBe(3);

    const history = service.listGenerations();
    expect(history.map((g) => g.generation)).toEqual([3, 2, 1]);
    expect(history[1]?.handoffSummary).toBeTruthy();
    expect(history[2]?.handoffSummary).toBeTruthy();
  });

  it("supports FTS5 trigram + short-keyword memory search, scope isolation, and due followups polling", () => {
    const dueBatches: LsaFollowup[][] = [];
    const service = track(
      createLsaService({
        home: homeDir,
        now: () => nowMs,
        onFollowupDue: (batch) => dueBatches.push(batch),
      }),
    );

    service.memorySave({
      scope: "private",
      key: "deploy-flow",
      content: "使用 luma deploy 发布网关与官网镜像，切勿跳过镜像构建步骤",
      tags: ["deploy", "luma"],
    });
    service.memorySave({
      scope: "private",
      key: "ci-matrix",
      content: "CI runs pnpm build and vitest on Linux Node 22",
      tags: ["ci", "linux"],
    });
    service.memorySave({
      scope: "group:team-alpha",
      key: "team-convention",
      content: "Always open draft PRs for frontend changes",
      tags: ["pr", "frontend"],
    });

    // CJK 3+ char FTS5 trigram match
    const cjkHits = service.memorySearch({ query: "镜像构建", scope: "private" });
    expect(cjkHits).toHaveLength(1);
    expect(cjkHits[0]?.key).toBe("deploy-flow");

    // 2-char short query ("CI") via LIKE keyword match + tag filter
    const shortHits = service.memorySearch({ query: "CI", scope: "private", tags: ["linux"] });
    expect(shortHits).toHaveLength(1);
    expect(shortHits[0]?.key).toBe("ci-matrix");

    // Scope isolation: group scope does not leak private memories
    expect(service.memorySearch({ query: "luma", scope: "group:team-alpha" })).toHaveLength(0);

    // Oversized memory is rejected cleanly
    expect(() =>
      service.memorySave({
        key: "too-big",
        content: "x".repeat(200),
        maxChars: 100,
      }),
    ).toThrowError(RpcError);

    // Followups: schedule two (one due now+10s, one due now+60s)
    const f1 = service.followupSchedule({
      note: "Ping reviewer about Safari fix",
      dueAt: nowMs + 10_000,
    });
    const f2 = service.followupSchedule({
      note: "Check nightly benchmark",
      dueAt: nowMs + 60_000,
    });

    expect(service.pollDueFollowups(nowMs + 5_000)).toEqual([]);
    expect(dueBatches).toHaveLength(0);

    // At T+15s, only f1 triggers
    const triggered1 = service.pollDueFollowups(nowMs + 15_000);
    expect(triggered1.map((f) => f.id)).toEqual([f1.id]);
    expect(triggered1[0]?.status).toBe("triggered");
    expect(triggered1[0]?.triggeredAt).toBe(nowMs + 15_000);
    expect(dueBatches).toHaveLength(1);

    // Polling again at T+20s is idempotent (f1 does NOT fire twice!)
    expect(service.pollDueFollowups(nowMs + 20_000)).toEqual([]);

    // Completing f1 sets done=true; polling at T+70s triggers f2
    const completedF1 = service.followupComplete(f1.id);
    expect(completedF1.done).toBe(true);

    const triggered2 = service.pollDueFollowups(nowMs + 70_000);
    expect(triggered2.map((f) => f.id)).toEqual([f2.id]);
  });

  it("enforces Yearly-tier entitlement helper & gate for multi-machine and external channels, and validates all lsa.* wire RPC schemas", async () => {
    expect(LSA_ENTITLEMENT_METADATA.requiresYearlyTier).toBe(true);
    expect(evaluateLsaEntitlement({ active: true, tier: "monthly" }, "local").allowed).toBe(true);
    expect(
      evaluateLsaEntitlement({ active: true, tier: "monthly" }, "multi_machine").allowed,
    ).toBe(false);
    expect(
      evaluateLsaEntitlement({ active: true, tier: "yearly" }, "multi_machine").allowed,
    ).toBe(true);
    expect(
      evaluateLsaEntitlement({ active: true, tier: "monthly", isTrial: true }, "channel").allowed,
    ).toBe(true);

    let currentEntitlement = { active: true, tier: "monthly", isTrial: false };
    const gateSpy = vi.fn((ctx) => evaluateLsaEntitlement(currentEntitlement, ctx.mode));

    const service = track(
      createLsaService({
        home: homeDir,
        machineId: () => "host-local",
        entitlementGate: gateSpy,
        adapter: {
          machineId: () => "host-local",
          listProjects: () => [
            {
              cwd: "/work/linkshell",
              name: "linkshell",
              createdAt: nowMs - 10_000,
              lastActiveAt: nowMs,
              sessionCount: 3,
            },
          ],
          createSession: async ({ agent, cwd }) => createMockSession(`${agent}:rpc-1`, cwd, agent),
          promptSession: async () => "started",
          cancelSession: async () => {},
        },
        now: () => nowMs,
      }),
    );

    // Monthly user blocked on multi-machine & Feishu channel dispatch
    await expect(
      service.workDispatch({
        goal: "Run build on remote Linux server",
        cwd: "/work/linkshell",
        targetMachineId: "host-remote-linux",
      }),
    ).rejects.toMatchObject({ appCode: "membership_required" });

    await expect(
      service.workDispatch({
        goal: "Fix bug from Feishu group mention",
        cwd: "/work/linkshell",
        channel: "feishu",
      }),
    ).rejects.toMatchObject({ appCode: "membership_required" });

    // Upgrade to yearly -> multi-machine & external channel succeed
    currentEntitlement = { active: true, tier: "yearly", isTrial: false };
    const remoteTask = await service.workDispatch({
      goal: "Run build on remote Linux server",
      cwd: "/work/linkshell",
      targetMachineId: "host-remote-linux",
      startSession: false,
    });
    expect(remoteTask.status).toBe("queued");

    // Exercise all 7 `lsa.*` RPC handlers and validate outputs against `@linkshell/wire` Zod schemas!
    const rpc = lsaHandlers(service);

    const dispatched = await rpc["lsa.dispatch"]({
      goal: "Fix linkshell mobile header spacing",
      acceptanceChecks: ["exit:0"],
    });
    expect(() => methods["lsa.dispatch"].result.parse(dispatched)).not.toThrow();
    expect(dispatched.task.cwd).toBe("/work/linkshell"); // Auto-located via fleetLocate!

    const steered = await rpc["lsa.steer"]({
      taskId: dispatched.task.id,
      instruction: "Check iOS safe area insets too",
    });
    expect(() => methods["lsa.steer"].result.parse(steered)).not.toThrow();

    const listed = await rpc["lsa.tasks"]({ status: "running" });
    expect(() => methods["lsa.tasks"].result.parse(listed)).not.toThrow();
    expect(listed.tasks.some((t) => t.id === dispatched.task.id)).toBe(true);

    const memSaved = await rpc["lsa.memories"]({
      op: "save",
      key: "header-spacing",
      content: "Use safe-area-context top inset on iOS",
      tags: ["ios", "ui"],
    });
    expect(() => methods["lsa.memories"].result.parse(memSaved)).not.toThrow();
    expect(memSaved.memories[0]?.key).toBe("header-spacing");

    const fuScheduled = await rpc["lsa.followups"]({
      op: "schedule",
      taskId: dispatched.task.id,
      note: "Verify screenshot on iPhone SE",
      dueAt: nowMs + 5_000,
    });
    expect(() => methods["lsa.followups"].result.parse(fuScheduled)).not.toThrow();
    expect(fuScheduled.followups).toHaveLength(1);

    const status = await rpc["lsa.status"]({ query: "linkshell" });
    expect(() => methods["lsa.status"].result.parse(status)).not.toThrow();
    expect(status.requiresYearlyTier).toBe(true);
    expect(status.candidates?.[0]?.cwd).toBe("/work/linkshell");

    const decided = await rpc["lsa.decide"]({
      taskId: dispatched.task.id,
      decision: "accept",
      feedback: "Looks clean!",
    });
    expect(() => methods["lsa.decide"].result.parse(decided)).not.toThrow();
    expect(decided.task.status).toBe("completed");

    // Ensure direct LsaStore construction also works cleanly
    const standaloneStore = new LsaStore(":memory:");
    expect(standaloneStore.getControllerEpoch()).toBe(1);
    standaloneStore.close();
  });
});
