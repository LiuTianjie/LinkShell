import { describe, expect, it } from "vitest";
import type { ProjectSummary, SessionSummary } from "@linkshell/wire";
import {
  computerSessionTrees,
  consolidateProjectRoot,
  crossComputerProjects,
  desktopSessionTree,
} from "../session-tree";

function makeProject(
  cwd: string,
  overrides: Partial<ProjectSummary> = {},
): ProjectSummary {
  const clean = cwd.replace(/[\\/]+$/, "");
  const createdAt = overrides.createdAt ?? 1_700_000_000_000;
  const lastActiveAt = overrides.lastActiveAt ?? createdAt;
  return {
    cwd,
    name: clean.split(/[\\/]/).at(-1) || cwd,
    createdAt,
    lastActiveAt,
    sessionCount: 1,
    ...overrides,
  };
}

function makeSession(
  id: string,
  cwd: string,
  createdAt: number,
  overrides: Partial<SessionSummary> = {},
): SessionSummary {
  return {
    id,
    nativeId: id,
    agent: "claude",
    cwd,
    state: "idle",
    pendingPermissions: 0,
    createdAt,
    updatedAt: createdAt,
    lastSeq: 1,
    archived: false,
    ...overrides,
  };
}

describe("consolidateProjectRoot & desktopSessionTree smart root consolidation", () => {
  it("consolidates teachvideo/runs/20261112-.../01..11, .agents, .worktrees, and dated/shard leaves into 1 teachvideo project while keeping SessionSummary.cwd untouched", () => {
    const shards = Array.from({ length: 11 }, (_, idx) => {
      const shard = String(idx + 1).padStart(2, "0");
      return `/Users/turning4th/teachvideo/runs/20261112-basic-inequality-claude/${shard}`;
    });

    const projects: ProjectSummary[] = [
      ...shards.map((cwd, idx) =>
        makeProject(cwd, {
          createdAt: 1_700_000_000_000 + idx * 1_000,
          sessionCount: idx < 4 ? 0 : 1, // First 4 had unloaded/zero live sessions in screenshot
        }),
      ),
      makeProject("/Users/turning4th/teachvideo/.agents/skills", {
        sessionCount: 2,
      }),
      makeProject("/Users/turning4th/teachvideo/.worktrees/parallel-fix", {
        sessionCount: 1,
      }),
      makeProject("/Users/turning4th/teachvideo/20261113_trig_bench/shard-03", {
        sessionCount: 1,
      }),
      makeProject("/Users/turning4th/teachvideo/packages/renderer", {
        sessionCount: 1,
      }),
    ];

    const liveSessions: SessionSummary[] = [
      makeSession(
        "sess-shard-01",
        "/Users/turning4th/teachvideo/runs/20261112-basic-inequality-claude/01",
        1_700_000_050_000,
      ),
      makeSession(
        "sess-shard-11",
        "/Users/turning4th/teachvideo/runs/20261112-basic-inequality-claude/11",
        1_700_000_090_000,
      ),
    ];

    const tree = desktopSessionTree(projects, liveSessions);

    expect(tree.groups).toHaveLength(1);
    const group = tree.groups[0]!;
    expect(group.cwd).toBe("/Users/turning4th/teachvideo");
    expect(group.name).toBe("teachvideo");
    // 7 shards with count 1 + .agents (2) + .worktrees (1) + dated shard (1) + packages/renderer (1) = 12
    expect(group.sessionCount).toBe(12);
    expect(group.sessions).toHaveLength(2);
    // Sacred invariant: SessionSummary.cwd MUST stay untouched!
    expect(group.sessions.map((s) => s.cwd)).toEqual([
      "/Users/turning4th/teachvideo/runs/20261112-basic-inequality-claude/11",
      "/Users/turning4th/teachvideo/runs/20261112-basic-inequality-claude/01",
    ]);

    // Cross-computer view also consolidates into 1 teachvideo entry
    const cross = crossComputerProjects([
      { key: "desktop:local", projects, sessions: liveSessions },
    ]);
    expect(cross).toHaveLength(1);
    expect(cross[0]!.name).toBe("teachvideo");
  });

  it("keeps sibling repos under workspace container folders separate (~/Projects/alpha vs ~/Projects/beta, ~/Documents/GitHub/*, Windows C:\\Users\\u\\repos\\*)", () => {
    const projects: ProjectSummary[] = [
      makeProject("/Users/turning4th/Projects/alpha", { createdAt: 3_000 }),
      makeProject("/Users/turning4th/Projects/alpha/runs/01", { createdAt: 3_100 }),
      makeProject("/Users/turning4th/Projects/beta", { createdAt: 2_000 }),
      makeProject("/Users/turning4th/Documents/GitHub/repo-one", { createdAt: 1_500 }),
      makeProject("/Users/turning4th/Documents/GitHub/repo-two", { createdAt: 1_000 }),
    ];

    const tree = desktopSessionTree(projects, []);
    expect(tree.groups.map((g) => g.cwd)).toEqual([
      "/Users/turning4th/Projects/alpha",
      "/Users/turning4th/Projects/beta",
      "/Users/turning4th/Documents/GitHub/repo-one",
      "/Users/turning4th/Documents/GitHub/repo-two",
    ]);
    expect(tree.groups[0]!.sessionCount).toBe(2);

    const winAlpha = consolidateProjectRoot(
      "C:\\Users\\Alice\\Projects\\alpha\\runs\\20261114-eval\\02",
    );
    const winBeta = consolidateProjectRoot("C:\\Users\\Alice\\Projects\\beta");
    expect(winAlpha.cwd).toBe("C:\\Users\\Alice\\Projects\\alpha");
    expect(winAlpha.name).toBe("alpha");
    expect(winBeta.cwd).toBe("C:\\Users\\Alice\\Projects\\beta");
    expect(winBeta.name).toBe("beta");
  });

  it("never lets sessions in $HOME, /, /tmp, or workspace container folders swallow child repositories", () => {
    const projects: ProjectSummary[] = [
      makeProject("/Users/turning4th", { createdAt: 4_000, sessionCount: 1 }),
      makeProject("/Users/turning4th/Projects", { createdAt: 3_500, sessionCount: 1 }),
      makeProject("/Users/turning4th/claude-remote", { createdAt: 3_000, sessionCount: 5 }),
      makeProject("/Users/turning4th/teachvideo", { createdAt: 2_000, sessionCount: 3 }),
      makeProject("/tmp", { createdAt: 1_500, sessionCount: 1 }),
      makeProject("/tmp/scratch-repo", { createdAt: 1_000, sessionCount: 2 }),
    ];
    const sessions: SessionSummary[] = [
      makeSession("home-sess", "/Users/turning4th", 4_000),
      makeSession("claude-sess", "/Users/turning4th/claude-remote", 3_000),
    ];

    const tree = desktopSessionTree(projects, sessions);
    expect(tree.groups.map((g) => g.cwd)).toEqual([
      "/Users/turning4th",
      "/Users/turning4th/Projects",
      "/Users/turning4th/claude-remote",
      "/Users/turning4th/teachvideo",
      "/tmp",
      "/tmp/scratch-repo",
    ]);
  });

  it("applies Rule B (explicit ancestor root rollup) and Rule C (accurate unloaded session counts & dropping 0-session ghost groups)", () => {
    const projects: ProjectSummary[] = [
      makeProject("/Users/turning4th/claude-remote", {
        createdAt: 5_000,
        sessionCount: 8,
        branch: "main",
      }),
      makeProject("/Users/turning4th/claude-remote/apps/desktop-ui", {
        createdAt: 5_200,
        sessionCount: 3,
        branch: "feat/sub",
      }),
      // Ghost directory with 0 sessions and no live sessions -> MUST be dropped!
      makeProject("/Users/turning4th/empty-ghost-dir", {
        createdAt: 9_000,
        sessionCount: 0,
      }),
      makeProject("/Users/turning4th/teachvideo/runs/20261112-ghost/04", {
        createdAt: 8_000,
        sessionCount: 0,
      }),
    ];

    const tree = desktopSessionTree(projects, []);
    expect(tree.groups).toHaveLength(1);
    expect(tree.groups[0]!.cwd).toBe("/Users/turning4th/claude-remote");
    expect(tree.groups[0]!.branch).toBe("main");
    expect(tree.groups[0]!.sessionCount).toBe(11);
  });

  it("preserves Codex generated chat grouping (Documents/Codex/YYYY-MM-DD/<id> -> Codex Chats)", () => {
    const projects: ProjectSummary[] = [
      makeProject("/Users/turning4th/Documents/Codex/2026-11-12/chat-a", {
        createdAt: 2_000,
        sessionCount: 1,
      }),
      makeProject("/Users/turning4th/Documents/Codex/2026-11-14/chat-b", {
        createdAt: 3_000,
        sessionCount: 2,
      }),
      makeProject("/Users/turning4th/claude-remote", {
        createdAt: 1_000,
        sessionCount: 4,
      }),
    ];

    const tree = desktopSessionTree(projects, []);
    expect(tree.groups).toHaveLength(2);
    const codexGroup = tree.groups.find((g) => g.generated);
    expect(codexGroup).toBeDefined();
    expect(codexGroup!.name).toBe("Codex Chats");
    expect(codexGroup!.cwd).toBe("/Users/turning4th/Documents/Codex");
    expect(codexGroup!.sessionCount).toBe(3);
  });

  it("groups scope='all' into 电脑 → 项目 → 会话 via computerSessionTrees (local first -> online remotes -> offline with cached groups, syncing placeholders, and cross-computer waiting)", () => {
    const result = computerSessionTrees([
      {
        key: "wss://gateway.itool.tech#offline-win",
        online: false,
        loaded: true,
        orderLabel: "Win Workstation",
        projects: [
          makeProject("C:\\Users\\Alice\\Projects\\engine\\runs\\20261114-bench\\01", {
            createdAt: 2_000,
            sessionCount: 2,
          }),
        ],
        sessions: [
          makeSession(
            "win-s1",
            "C:\\Users\\Alice\\Projects\\engine\\runs\\20261114-bench\\01",
            2_500,
            { state: "waiting" },
          ),
        ],
      },
      {
        key: "wss://gateway.itool.tech#offline-empty",
        online: false,
        loaded: false,
        orderLabel: "Empty Offline Box",
        projects: [],
        sessions: [],
      },
      {
        key: "wss://gateway.itool.tech#online-syncing",
        online: true,
        loaded: false,
        orderLabel: "Air3",
        projects: [],
        sessions: [],
      },
      {
        key: "wss://gateway.itool.tech#online-loaded-empty",
        online: true,
        loaded: true,
        orderLabel: "Empty Online Box",
        projects: [
          makeProject("/Users/dev/ghost", { sessionCount: 0 }),
        ],
        sessions: [],
      },
      {
        key: "wss://gateway.itool.tech#chengdu-mini",
        online: true,
        loaded: true,
        orderLabel: "成都-mini",
        projects: [
          makeProject("/Users/mini/teachvideo/runs/20261112-eval/01", {
            createdAt: 4_000,
            sessionCount: 1,
          }),
          makeProject("/Users/mini/teachvideo/runs/20261112-eval/02", {
            createdAt: 4_100,
            sessionCount: 1,
          }),
          makeProject("/Users/mini/claude-remote", {
            createdAt: 5_000,
            sessionCount: 3,
          }),
        ],
        sessions: [
          makeSession("mini-s-old", "/Users/mini/claude-remote", 5_100),
          makeSession("mini-s-new", "/Users/mini/claude-remote", 5_900, {
            state: "waiting",
          }),
        ],
      },
      {
        key: "desktop:local",
        online: true,
        loaded: true,
        orderLabel: "这台 Mac",
        projects: [
          makeProject("/Users/turning4th/claude-remote", {
            createdAt: 6_000,
            sessionCount: 4,
          }),
        ],
        sessions: [
          makeSession("local-wait", "/Users/turning4th/claude-remote", 5_500, {
            state: "waiting",
          }),
          makeSession("local-run", "/Users/turning4th/claude-remote", 6_200, {
            state: "running",
          }),
        ],
      },
    ]);

    // 1. Computer order: desktop:local first -> online sorted by orderLabel ("Air3", "成都-mini") -> offline with groups ("Win Workstation")
    // Offline empty & online loaded with 0 non-ghost groups are excluded!
    expect(result.computers.map((c) => c.key)).toEqual([
      "desktop:local",
      "wss://gateway.itool.tech#online-syncing",
      "wss://gateway.itool.tech#chengdu-mini",
      "wss://gateway.itool.tech#offline-win",
    ]);

    // 2. Online computer still syncing metadata has `syncing: true` and 0 groups initially
    const air3 = result.computers[1]!;
    expect(air3.syncing).toBe(true);
    expect(air3.groups).toHaveLength(0);

    // 3. Projects consolidated per computer and ordered by createdAt desc; sessions ordered by createdAt desc
    const mini = result.computers[2]!;
    expect(mini.syncing).toBe(false);
    expect(mini.groups.map((g) => g.name)).toEqual(["claude-remote", "teachvideo"]);
    expect(mini.groups[0]!.sessions.map((s) => s.id)).toEqual([
      "mini-s-new",
      "mini-s-old",
    ]);
    expect(mini.groups[1]!.cwd).toBe("/Users/mini/teachvideo");
    expect(mini.groups[1]!.sessionCount).toBe(2);
    expect(mini.sessionCount).toBe(5);

    // 4. Windows offline computer consolidates shards cleanly too
    const win = result.computers[3]!;
    expect(win.groups).toHaveLength(1);
    expect(win.groups[0]!.cwd).toBe("C:\\Users\\Alice\\Projects\\engine");
    expect(win.groups[0]!.name).toBe("engine");

    // 5. Totals and cross-computer `waiting` (`待你处理`) sorted by session.createdAt desc
    expect(result.totalProjects).toBe(4); // local(1) + air3(0) + mini(2) + win(1)
    expect(result.totalSessions).toBe(11); // local(4) + air3(0) + mini(5) + win(2)
    expect(result.waiting.map((w) => [w.computerKey, w.session.id])).toEqual([
      ["wss://gateway.itool.tech#chengdu-mini", "mini-s-new"],
      ["desktop:local", "local-wait"],
      ["wss://gateway.itool.tech#offline-win", "win-s1"],
    ]);

    // 6. Live streaming token deltas within the same 1-minute bucket NEVER reorder computers, projects, or sessions
    const afterStream = computerSessionTrees([
      {
        key: "wss://gateway.itool.tech#chengdu-mini",
        online: true,
        loaded: true,
        orderLabel: "成都-mini",
        projects: [
          makeProject("/Users/mini/claude-remote", {
            createdAt: 60_000,
            lastActiveAt: 69_999,
            sessionCount: 3,
          }),
        ],
        sessions: [
          makeSession("mini-s-old", "/Users/mini/claude-remote", 60_500, {
            state: "running",
            updatedAt: 69_999,
          }),
          makeSession("mini-s-new", "/Users/mini/claude-remote", 61_000, {
            updatedAt: 62_000,
          }),
        ],
      },
      {
        key: "desktop:local",
        online: true,
        loaded: true,
        orderLabel: "这台 Mac",
        projects: [
          makeProject("/Users/turning4th/claude-remote", {
            createdAt: 6_000,
            sessionCount: 4,
          }),
        ],
        sessions: [],
      },
    ]);
    expect(afterStream.computers.map((c) => c.key)).toEqual([
      "desktop:local",
      "wss://gateway.itool.tech#chengdu-mini",
    ]);
    expect(afterStream.computers[1]!.groups[0]!.sessions.map((s) => s.id)).toEqual([
      "mini-s-new",
      "mini-s-old",
    ]);
  });
});
