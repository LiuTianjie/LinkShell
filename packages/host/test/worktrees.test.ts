import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ContentBlock, SessionUpdate } from "@linkshell/wire";
import type { AgentDriver, DiscoveredSession, DriverHost, ForkOptions } from "../src/drivers/types.js";
import { SessionHub } from "../src/hub.js";
import { HostStore } from "../src/store.js";
import { createWorktree, gitBranch, gitInfo, removeWorktree, worktreeState } from "../src/worktrees.js";

// Sessions in git worktrees, and forks: against a real repository.

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

let dir: string;
let repo: string;
let home: string;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "lsh-wt-")));
  repo = join(dir, "shop");
  home = join(dir, "linkshell-home");
  mkdirSync(join(repo, "packages", "api"), { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@example.com");
  git(repo, "config", "user.name", "T");
  writeFileSync(join(repo, "README.md"), "shop\n");
  writeFileSync(join(repo, "packages", "api", "index.ts"), "export {};\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "first");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("worktrees", () => {
  it("says what git knows about a directory", async () => {
    const head = git(repo, "rev-parse", "--short", "HEAD");
    expect(await gitInfo(join(repo, "packages", "api"))).toEqual({ root: repo, branch: "main", head, dirty: false });
    expect(await gitBranch(join(repo, "packages", "api"))).toBe("main");
    writeFileSync(join(repo, "notes.txt"), "wip");
    expect((await gitInfo(repo))?.dirty).toBe(true);
    expect(await gitInfo(dir)).toBeUndefined();
    expect(await gitBranch(dir)).toBeUndefined();
    // On a detached HEAD there is no branch: the commit says where it is.
    git(repo, "checkout", "-q", "--detach");
    expect(await gitInfo(repo)).toMatchObject({ branch: undefined, head });
    expect(await gitBranch(repo)).toBe(head);
    // A repository without a commit yet still has a branch.
    const fresh = join(dir, "fresh");
    mkdirSync(fresh);
    git(fresh, "init", "-q", "-b", "trunk");
    expect(await gitInfo(fresh)).toMatchObject({ branch: "trunk", head: undefined });
    expect(await gitBranch(fresh)).toBe("trunk");
  });

  it("makes a checkout on its own branch at the last commit, outside the project, and removes it", async () => {
    writeFileSync(join(repo, "notes.txt"), "uncommitted, stays behind");
    const made = await createWorktree(join(repo, "packages", "api"), home, "Fix the 登录 bug!");
    expect(made.path.startsWith(join(home, "worktrees", "shop", "fix-the-bug-"))).toBe(true);
    expect(made.branch).toBe(`linkshell/${made.path.split("/").pop()}`);
    // The session works at the same place inside the new checkout.
    expect(made.cwd).toBe(join(made.path, "packages", "api"));
    expect(existsSync(join(made.cwd, "index.ts"))).toBe(true);
    expect(existsSync(join(made.path, "notes.txt"))).toBe(false);
    expect(git(made.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(made.branch);
    expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");

    expect(await worktreeState(made.path, made.base)).toEqual({ dirty: false, ahead: 0 });
    writeFileSync(join(made.cwd, "new.ts"), "x");
    expect(await worktreeState(made.path, made.base)).toEqual({ dirty: true, ahead: 0 });
    git(made.path, "add", "-A");
    git(made.path, "commit", "-q", "-m", "work");
    expect(await worktreeState(made.path, made.base)).toEqual({ dirty: false, ahead: 1 });

    await removeWorktree(made);
    expect(existsSync(made.path)).toBe(false);
    expect(git(repo, "branch", "--list", made.branch)).toBe("");
    expect(git(repo, "worktree", "list").split("\n")).toHaveLength(1);
  });

  it("refuses outside a repository", async () => {
    await expect(createWorktree(dir, home, "x")).rejects.toMatchObject({ appCode: "not_a_repo" });
  });
});

class ForkingDriver implements AgentDriver {
  readonly id = "fake";
  readonly label = "Fake";
  readonly tier = "multi_client" as const;
  readonly capabilities = { interrupt: true, steer: false, permissions: true, images: false, fork: true, models: false, modes: false };
  host!: DriverHost;
  created: string[] = [];
  forks: (ForkOptions & { nativeId: string })[] = [];
  deleted: string[] = [];
  constructor(private readonly cwd: string) {}
  async start(host: DriverHost) {
    this.host = host;
    return { installed: true, version: "1.0" };
  }
  async stop() {}
  status() {
    return { installed: true, version: "1.0" };
  }
  async listSessions(): Promise<DiscoveredSession[]> {
    return [{ nativeId: "s1", cwd: this.cwd, title: "Checkout flow", createdAt: 1, updatedAt: 1 }];
  }
  async createSession(options: { cwd: string }) {
    this.created.push(options.cwd);
    return { nativeId: `new${this.created.length}`, cwd: options.cwd, createdAt: 2, updatedAt: 2 };
  }
  async fork(nativeId: string, options: ForkOptions) {
    this.forks.push({ nativeId, ...options });
    return { nativeId: `fork${this.forks.length}`, cwd: options.cwd, createdAt: 3, updatedAt: 3 };
  }
  async attach() {
    return [];
  }
  async detach() {}
  async prompt(_nativeId: string, _content: ContentBlock[]) {
    return "started" as const;
  }
  async cancel() {}
  async respondPermission() {}
  async delete(nativeId: string) {
    this.deleted.push(nativeId);
  }
  emit(update: SessionUpdate) {
    this.host.update(this.id, "s1", update);
  }
}

describe("sessions in worktrees, and forks", () => {
  let store: HostStore;
  let driver: ForkingDriver;
  let hub: SessionHub;

  beforeEach(async () => {
    store = new HostStore(join(dir, "state.db"));
    driver = new ForkingDriver(join(repo, "packages", "api"));
    hub = new SessionHub(store, [driver], () => {}, home);
    await hub.start();
  });

  afterEach(() => store.close());

  it("starts a session in a new worktree, shown under its project, and cleans up when it is deleted unchanged", async () => {
    const project = join(repo, "packages", "api");
    const session = await hub.createSession({ agent: "fake", cwd: project, worktree: true, prompt: [{ type: "text", text: "Speed up checkout" }] });
    expect(session.cwd.startsWith(join(home, "worktrees", "shop", "speed-up-checkout-"))).toBe(true);
    expect(session.cwd.endsWith(join("packages", "api"))).toBe(true);
    expect(session.worktree).toEqual({ branch: expect.stringMatching(/^linkshell\/speed-up-checkout-/), source: project });
    expect(driver.created).toEqual([session.cwd]);
    // One project, two sessions: the worktree is not a project of its own.
    expect(await hub.listProjects()).toMatchObject([{ cwd: project, sessionCount: 2, branch: "main" }]);
    const [worktree] = await hub.listWorktrees();
    expect(worktree).toMatchObject({ source: project, sessions: [session.id], dirty: false, ahead: 0 });

    // In use: can't be removed from under the session.
    await expect(hub.removeWorktree(worktree!.path)).rejects.toMatchObject({ appCode: "busy" });
    await hub.delete(session.id);
    expect(existsSync(worktree!.path)).toBe(false);
    expect(await hub.listWorktrees()).toEqual([]);
  });

  it("keeps a worktree with work in it when its session is deleted, until told to remove it", async () => {
    const session = await hub.createSession({ agent: "fake", cwd: repo, worktree: true });
    writeFileSync(join(session.cwd, "feature.ts"), "wip");
    await hub.delete(session.id);
    const [left] = await hub.listWorktrees();
    expect(left).toMatchObject({ sessions: [], dirty: true });
    expect(existsSync(left!.path)).toBe(true);
    await expect(hub.removeWorktree(left!.path)).rejects.toMatchObject({ appCode: "dirty", message: expect.stringContaining("未提交的改动") });
    await hub.removeWorktree(left!.path, true);
    expect(existsSync(left!.path)).toBe(false);

    const again = await hub.createSession({ agent: "fake", cwd: repo, worktree: true });
    writeFileSync(join(again.cwd, "feature.ts"), "wip");
    await hub.delete(again.id, "remove");
    expect(await hub.listWorktrees()).toEqual([]);
  });

  it("refuses a worktree outside a repository, without creating a session", async () => {
    await expect(hub.createSession({ agent: "fake", cwd: dir, worktree: true })).rejects.toMatchObject({ appCode: "not_a_repo" });
    expect(driver.created).toEqual([]);
  });

  it("forks a session whole or through a turn, in place or into a worktree", async () => {
    await hub.subscribe("fake:s1", 0, { event: () => {} });
    const say = (n: number) => {
      driver.emit({ sessionUpdate: "user_message_chunk", messageId: `u${n}`, content: { type: "text", text: `q${n}` } });
      driver.emit({ sessionUpdate: "ls_turn", state: "started" });
      driver.emit({ sessionUpdate: "tool_call", toolCallId: `t${n}`, title: "Read", kind: "read", status: "completed" });
      driver.emit({ sessionUpdate: "agent_message_chunk", messageId: `a${n}`, content: { type: "text", text: `r${n}` } });
      driver.emit({ sessionUpdate: "ls_turn", state: "ended", stopReason: "end_turn" });
    };
    say(1);
    say(2);
    say(3);
    const project = join(repo, "packages", "api");

    const whole = await hub.fork("fake:s1");
    expect(whole).toMatchObject({ id: "fake:fork1", cwd: project, title: "Checkout flow" });
    expect(whole.worktree).toBeUndefined();
    expect(driver.forks[0]).toEqual({ nativeId: "s1", cwd: project, sourceCwd: project, upTo: undefined });

    // From a reply, or a tool call, in the second turn.
    await hub.fork("fake:s1", { itemId: "a2" });
    expect(driver.forks[1]!.upTo).toEqual({ itemId: "a2", turn: 2 });
    await hub.fork("fake:s1", { itemId: "t3" });
    expect(driver.forks[2]!.upTo).toEqual({ itemId: "t3", turn: 3 });
    await expect(hub.fork("fake:s1", { itemId: "nope" })).rejects.toMatchObject({ appCode: "not_found" });

    // Into a worktree: its own checkout, same project.
    const isolated = await hub.fork("fake:s1", { itemId: "a1", worktree: true });
    expect(isolated.worktree).toMatchObject({ source: project });
    expect(driver.forks[3]).toMatchObject({ sourceCwd: project, cwd: isolated.cwd, upTo: { turn: 1 } });
    expect(existsSync(join(isolated.cwd, "index.ts"))).toBe(true);
    // A fork of that fork into another worktree branches from the project again, not from inside the worktree.
    const second = await hub.fork(isolated.id, { worktree: true });
    expect(second.worktree).toMatchObject({ source: project });
    expect(second.cwd).not.toBe(isolated.cwd);
    expect(await hub.listProjects()).toMatchObject([{ cwd: project, sessionCount: 6, branch: "main" }]);
  });
});
