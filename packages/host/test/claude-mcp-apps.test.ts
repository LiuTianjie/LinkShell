import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { RpcError } from "@linkshell/wire";
import { ClaudeMcpApps, claudeMcpServers, claudeStatePath } from "../src/drivers/claude/mcp-apps.js";

const server = fileURLToPath(new URL("./fixtures/page-mcp.mjs", import.meta.url));
const made: string[] = [];
const open: ClaudeMcpApps[] = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map((apps) => apps.stop()));
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(state: object, files: Record<string, object> = {}) {
  const home = mkdtempSync(join(tmpdir(), "claude-mcp-apps-"));
  made.push(home);
  const configDir = join(home, ".claude");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(home, ".claude.json"), JSON.stringify(state));
  for (const [path, value] of Object.entries(files)) {
    mkdirSync(join(home, path, ".."), { recursive: true });
    writeFileSync(join(home, path), JSON.stringify(value));
  }
  return { home, configDir };
}

function appsFor(configDir: string, cwd: string, late: unknown[] = []) {
  const apps = new ClaudeMcpApps({
    env: () => ({ ...process.env, HOME: join(configDir, "..") }),
    configDir,
    cwdOf: () => cwd,
    lateDetail: (...args) => late.push(args),
    log: () => {},
  });
  open.push(apps);
  return apps;
}

const stdio = { command: process.execPath, args: [server] };

describe("Claude MCP Apps", () => {
  it("resolves servers the way Claude does: user, then approved project ones, minus disabled", () => {
    const { home, configDir } = setup({});
    mkdirSync(join(home, "work"));
    const cwd = join(home, "work");
    writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { approved: stdio, unapproved: stdio } }));
    const state = JSON.parse(JSON.stringify({ mcpServers: { demo: stdio }, projects: { [cwd]: { enabledMcpjsonServers: ["approved"], disabledMcpServers: ["demo"] } } }));
    writeFileSync(join(home, ".claude.json"), JSON.stringify(state));
    const servers = claudeMcpServers(claudeStatePath(configDir, {}), configDir, cwd, {});
    expect([...servers.keys()].sort()).toEqual(["approved"]);
    expect([...claudeMcpServers(claudeStatePath(configDir, {}), configDir, undefined, {}).keys()]).toEqual(["demo"]);
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { figma: { type: "http", url: "https://example.com/${PATH_PART:-mcp}" } } }));
    expect(claudeMcpServers(claudeStatePath(configDir, {}), configDir, undefined, {}).get("figma")).toEqual({ type: "http", url: "https://example.com/mcp", headers: {} });
  });

  it("lists a server's pages, reads one and lets it call only the tools pages may call", async () => {
    const { configDir } = setup({ mcpServers: { "demo.mirror": { ...stdio, env: { DEMO_MARK: "hello" } } } });
    const apps = appsFor(configDir, "/nowhere");
    const listed = await apps.apps("s1");
    // Needs an input, and states no entry point: not something to start from the menu.
    expect(listed).toEqual([
      { server: "demo.mirror", tool: "show_screen", title: "Demo Screen", description: "Shows the screen", resourceUri: "ui://demo/screen.html", entrypoints: ["thread"] },
    ]);
    const page = await apps.resource("s1", { server: "demo.mirror", uri: "ui://demo/screen.html" });
    expect(page).toMatchObject({ mimeType: "text/html;profile=mcp-app", text: "<html>hello</html>", meta: { ui: { prefersBorder: false } } });
    await expect(apps.resource("s1", { server: "demo.mirror", uri: "file:///etc/passwd" })).rejects.toMatchObject({ appCode: "invalid_params" });
    expect(await apps.call("s1", { server: "demo.mirror", tool: "screen_frame" })).toEqual({ content: [{ type: "text", text: "ran screen_frame" }], structuredContent: { tool: "screen_frame" } });
    // Claude's tool names carry the normalized server name: a card's server works too.
    expect((await apps.call("s1", { server: "demo_mirror", tool: "show_screen" })).structuredContent).toEqual({ tool: "show_screen" });
    await expect(apps.call("s1", { server: "demo.mirror", tool: "model_only" })).rejects.toMatchObject({ appCode: "forbidden" });
    await expect(apps.call("s1", { server: "demo.mirror", tool: "missing" })).rejects.toMatchObject({ appCode: "not_found" });
    await expect(apps.call("s1", { server: "other", tool: "show_screen" })).rejects.toBeInstanceOf(RpcError);
  });

  it("gives a call's card its page, late the first time its server's tools are read", async () => {
    const { configDir } = setup({ mcpServers: { "demo.mirror": stdio } });
    const late: unknown[] = [];
    const apps = appsFor(configDir, "/nowhere", late);
    const detail = { type: "mcp" as const, server: "demo_mirror", tool: "show_screen" };
    expect(apps.page("s1", "call-1", detail, "parent")).toBeUndefined();
    await expect.poll(() => late.length, { timeout: 10_000 }).toBe(1);
    expect(late[0]).toEqual(["s1", "call-1", { ...detail, app: { resourceUri: "ui://demo/screen.html" } }, "parent"]);
    // Known now: straight away, and nothing late for a tool without a page.
    expect(apps.page("s1", "call-2", detail)).toEqual({ resourceUri: "ui://demo/screen.html" });
    expect(apps.page("s1", "call-3", { ...detail, tool: "screen_frame" })).toBeUndefined();
    expect(apps.page("s1", "call-4", { ...detail, server: "unconfigured" })).toBeUndefined();
    expect(late).toHaveLength(1);
  });

  it("doesn't hold the menu for a server that is slow to start", async () => {
    const slow = { command: process.execPath, args: ["-e", "setTimeout(() => {}, 60000)"] };
    const { configDir } = setup({ mcpServers: { slow, demo: stdio } });
    const apps = new ClaudeMcpApps({ env: () => process.env, configDir, cwdOf: () => undefined, lateDetail: () => {}, log: () => {}, listWaitMs: 1500 });
    open.push(apps);
    const started = Date.now();
    expect((await apps.apps("s1")).map((app) => app.server)).toEqual(["demo"]);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("says plainly when a server can't be reached", async () => {
    const { configDir } = setup({ mcpServers: { broken: { command: join(tmpdir(), "no-such-binary"), args: [] } } });
    const apps = appsFor(configDir, "/nowhere");
    expect(await apps.apps("s1")).toEqual([]);
    await expect(apps.resource("s1", { server: "broken", uri: "ui://x" })).rejects.toMatchObject({ appCode: "agent_error", message: expect.stringContaining("连不上 MCP 服务 broken") });
  });
});
