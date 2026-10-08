import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import ws from "../../../packages/host/node_modules/ws/index.js";
const { WebSocketServer } = ws;
import { startGateway } from "../../../packages/gateway/src/serve.js";
import { startHost } from "../../../packages/host/src/host.js";
import type {
  AgentDriver,
  DriverHost,
  DiscoveredSession,
  HistoryItem,
} from "../../../packages/host/src/drivers/types.js";
import type {
  ContentBlock,
  GoalChange,
  SessionGoal,
} from "../../../packages/wire/src/index.js";

const home = mkdtempSync(join(tmpdir(), "lsh-web-test-"));
const project = join(home, "project");
mkdirSync(project);
writeFileSync(
  join(project, "hello.ts"),
  'export const message = "LinkShell web test";\n',
);
writeFileSync(
  join(project, "package.json"),
  '{"name":"web-fixture","private":true}\n',
);
const previews = createServer((req, res) => {
  if (req.url === "/api") {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, via: "encrypted-host-stream" }));
    return;
  }
  if (req.url === "/hello.js") {
    res.setHeader("content-type", "application/javascript");
    res.end(
      'document.querySelector("#js").textContent = "外部脚本加载成功"; fetch("/api").then(r=>r.json()).then(r=>document.querySelector("#api").textContent = r.via); const ws=new WebSocket(location.origin.replace("http","ws")+"/echo"); ws.onopen=()=>ws.send("WebSocket 回显成功");ws.onmessage=e=>document.querySelector("#ws").textContent=e.data;',
    );
    return;
  }
  res.setHeader("content-type", "text/html");
  res.end(
    '<!doctype html><html><head><title>隔离端口测试</title><style>body{font:18px system-ui;padding:32px;background:#eef2ff}p{padding:12px;background:white;border-radius:12px}</style></head><body><h1>隔离端口预览</h1><p id="js">等待脚本</p><p id="api">等待 API</p><p id="ws">等待 WebSocket</p><script src="/hello.js"></script></body></html>',
  );
});
const wss = new WebSocketServer({ server: previews });
wss.on("connection", (socket) =>
  socket.on("message", (bytes) => socket.send(bytes.toString())),
);
await new Promise<void>((resolve) =>
  previews.listen(5182, "127.0.0.1", resolve),
);
class Fixture implements AgentDriver {
  id = "codex";
  label = "Codex（隔离联调）";
  tier = "multi_client" as const;
  capabilities = {
    interrupt: true,
    steer: true,
    permissions: true,
    images: true,
    fork: true,
    models: true,
    modes: true,
  };
  host!: DriverHost;
  goalValue: SessionGoal | null = null;
  sessions: DiscoveredSession[] = [
    {
      nativeId: "fixture",
      cwd: project,
      title: "网页功能联调 · 测试会话",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
  ];
  async start(host: DriverHost) {
    this.host = host;
    return this.status();
  }
  async stop() {}
  status() {
    return { installed: true, version: "fixture" };
  }
  async authStatus() {
    return { state: "ok" as const, method: "isolated-fixture" };
  }
  async listSessions() {
    return this.sessions;
  }
  async createSession({ cwd }: { cwd: string }) {
    const session = {
      nativeId: randomUUID(),
      cwd,
      title: "新建测试会话",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.sessions.push(session);
    return session;
  }
  async fork(_id: string, { cwd }: { cwd: string }) {
    return this.createSession({ cwd });
  }
  async attach(): Promise<HistoryItem[]> {
    return [
      {
        itemId: "initial",
        updates: [
          {
            sessionUpdate: "available_commands_update",
            availableCommands: [
              { name: "mcp", description: "查看 MCP 服务" },
              { name: "apps", description: "查看应用" },
              { name: "compact", description: "压缩上下文" },
              { name: "goal", description: "持续目标" },
              { name: "test-skill", description: "测试动态技能" },
              { name: "ask-test", description: "测试权限问答" },
            ],
          },
          {
            sessionUpdate: "ls_config",
            options: [
              {
                id: "model",
                name: "模型",
                category: "model",
                current: "fixture-model",
                values: [
                  { value: "fixture-model", name: "Fixture" },
                  { value: "fixture-fast", name: "Fixture Fast" },
                ],
              },
              {
                id: "mode",
                name: "权限模式",
                category: "mode",
                current: "default",
                values: [
                  { value: "default", name: "默认" },
                  { value: "plan", name: "计划" },
                ],
              },
            ],
          },
          {
            sessionUpdate: "agent_message_chunk",
            messageId: "welcome",
            content: {
              type: "text",
              text: "这是独立的浏览器联调环境。可以测试 **斜杠命令、MCP、权限问答、文件与终端**，不会调用真实 Agent。",
            },
          },
          { sessionUpdate: "ls_turn", state: "ended", stopReason: "end_turn" },
        ],
      },
    ];
  }
  async detach() {}
  async prompt(id: string, content: ContentBlock[], clientMessageId: string) {
    const text = content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    const emit = (update: Parameters<DriverHost["update"]>[2]) =>
      this.host.update(this.id, id, update);
    emit({
      sessionUpdate: "user_message_chunk",
      messageId: clientMessageId,
      content: { type: "text", text },
    });
    if (text === "/mcp" || text === "/apps")
      emit({
        sessionUpdate: "ls_notice",
        level: "info",
        title: text,
        detail:
          text === "/mcp"
            ? "fixture-tools · 2 个工具 · 已授权"
            : "fixture-app · 已启用",
      });
    else if (text === "/ask-test")
      emit({
        sessionUpdate: "ls_permission",
        requestId: randomUUID(),
        title: "选择测试结果",
        options: [{ optionId: "skip", name: "跳过", kind: "reject_once" }],
        questions: [
          {
            id: "choice",
            text: "选择一个选项",
            kind: "choice",
            required: true,
            options: [
              { value: "yes", label: "继续验证" },
              { value: "no", label: "停止验证" },
            ],
            other: true,
          },
        ],
      });
    else {
      emit({ sessionUpdate: "ls_turn", state: "started" });
      emit({
        sessionUpdate: "tool_call",
        toolCallId: randomUUID(),
        title: "fixture-tools · echo",
        kind: "other",
        status: "completed",
        detail: { type: "mcp", server: "fixture-tools", tool: "echo" },
        content: [
          {
            type: "content",
            content: {
              type: "text",
              text: "MCP 工具结果已通过真实加密通道返回。",
            },
          },
        ],
      });
      emit({
        sessionUpdate: "agent_message_chunk",
        messageId: randomUUID(),
        content: { type: "text", text: `收到：${text}\n\n联调完成。` },
      });
      emit({
        sessionUpdate: "ls_turn",
        state: "ended",
        stopReason: "end_turn",
      });
    }
    return "started" as const;
  }
  async cancel(id: string) {
    this.host.update(this.id, id, {
      sessionUpdate: "ls_turn",
      state: "ended",
      stopReason: "cancelled",
    });
  }
  async respondPermission(id: string, requestId: string, optionId: string) {
    this.host.update(this.id, id, {
      sessionUpdate: "ls_permission_resolved",
      requestId,
      optionId,
    });
  }
  async answerQuestion(id: string, requestId: string) {
    this.host.update(this.id, id, {
      sessionUpdate: "ls_permission_resolved",
      requestId,
    });
    this.host.update(this.id, id, {
      sessionUpdate: "ls_notice",
      level: "info",
      title: "测试答案已接收",
    });
  }
  async setConfig(id: string, optionId: string, value: string) {
    this.host.update(this.id, id, {
      sessionUpdate: "ls_config",
      options: [
        {
          id: optionId,
          name: optionId,
          category: "model",
          current: value,
          values: [
            { value: "fixture-model", name: "Fixture" },
            { value: "fixture-fast", name: "Fixture Fast" },
          ],
        },
      ],
    });
  }
  async goal(id: string, change: GoalChange) {
    if (change.action === "set")
      this.goalValue = {
        objective: change.objective,
        status: "active",
        tokenBudget: change.tokenBudget,
      };
    if (change.action === "clear") this.goalValue = null;
    if (this.goalValue && change.action === "pause")
      this.goalValue.status = "paused";
    if (this.goalValue && change.action === "resume")
      this.goalValue.status = "active";
    this.host.update(this.id, id, {
      sessionUpdate: "ls_goal",
      goal: this.goalValue,
    });
    return this.goalValue;
  }
}
const gateway = await startGateway({
  port: 5181,
  host: "127.0.0.1",
  databasePath: join(home, "relay.db"),
});
const host = await startHost({
  home: join(home, "host"),
  version: "web-fixture",
  drivers: () => [new Fixture()],
  iceServers: false,
  env: {
    PATH: process.env.PATH,
    HOME: home,
    SHELL: "/bin/sh",
    ENV: "",
    PS1: "$ ",
  },
  gateway: { url: "ws://127.0.0.1:5181", name: "Web Test Host（隔离测试）" },
  log: () => {},
});
const offer = await host.gateway!.startPairing();
process.stdout.write(
  JSON.stringify({
    gateway: "ws://127.0.0.1:5181",
    code: offer.code,
    project,
    previewPort: 5182,
    home,
  }) + "\n",
);
async function stop() {
  await host.stop();
  await gateway.close();
  wss.close();
  previews.close();
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  process.exit(0);
}
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
