import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
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
  SessionUpdate,
  EditorRequest,
  EditorResult,
} from "../../../packages/wire/src/index.js";
import { questionReplies } from "../../../packages/wire/src/index.js";

const home = mkdtempSync(join(tmpdir(), "lsh-web-test-"));
const project = join(home, "project");
const portalProject = join(
  home,
  "workspaces",
  "客户端体验验收",
  "customer-portal-with-a-long-project-name",
);
const notesProject = join(home, "workspaces", "研究笔记");
for (const path of [
  project,
  join(project, "src", "components"),
  join(project, "docs", "体验验收"),
  join(project, "logs"),
  join(project, "empty-directory"),
  portalProject,
  notesProject,
])
  mkdirSync(path, { recursive: true });
writeFileSync(
  join(project, "hello.ts"),
  'export const message = "LinkShell web test";\n',
);
writeFileSync(
  join(project, "package.json"),
  '{"name":"web-fixture","private":true}\n',
);
writeFileSync(
  join(project, "src", "components", "SessionSummary.ts"),
  [
    'export type SessionState = "idle" | "running" | "waiting";',
    "",
    "export interface SessionSummary {",
    "  id: string;",
    "  title: string;",
    "  state: SessionState;",
    "  updatedAt: number;",
    "}",
    "",
    "export function sortSessions(sessions: SessionSummary[]) {",
    "  return [...sessions].sort((a, b) => b.updatedAt - a.updatedAt);",
    "}",
    "",
  ].join("\n"),
);
const acceptanceMarkdown = [
  "# 浏览器工作区验收记录",
  "",
  "> 此文件位于临时目录，所有修改和测试只影响隔离环境。",
  "",
  "## 检查范围",
  "",
  "- [x] 文件浏览与中文路径",
  "- [ ] 窄屏布局与长内容",
  "- [ ] 键盘导航和错误恢复",
  "",
  "| 页面 | 重点 | 状态 |",
  "| --- | --- | --- |",
  "| 聊天列表 | 长标题、项目路径、状态分组 | 待验收 |",
  "| 聊天详情 | Markdown、代码、工具输出、审批 | 待验收 |",
  "| 终端 | 输入、回放、缩放和多标签 | 待验收 |",
  "",
  "```typescript",
  'const greeting = "你好，LinkShell";',
  "console.log(greeting);",
  "```",
  "",
].join("\n");
writeFileSync(join(project, "README.md"), acceptanceMarkdown);
writeFileSync(
  join(project, "docs", "体验验收", "检查清单.md"),
  acceptanceMarkdown,
);
writeFileSync(
  join(project, "logs", "long-output.txt"),
  Array.from(
    { length: 6000 },
    (_, index) =>
      `${String(index + 1).padStart(4, "0")}  浏览器工作区日志：中文、空格与长内容分页读取，保留当前滚动位置。 request=fixture-${index + 1}`,
  ).join("\n") + "\n",
);
writeFileSync(join(project, ".fixture-config.json"), '{"isolated":true}\n');
writeFileSync(
  join(portalProject, "README.md"),
  "# 客户端工作区\n\n用于验证较长项目路径与中文目录。\n",
);
writeFileSync(
  join(notesProject, "设计讨论.md"),
  "# 设计讨论\n\n保留信息密度，同时确保键盘和窄屏交互可用。\n",
);
// Real commits let the normal Host worktree RPC run without touching a user's repository.
const git = (args: string[]) =>
  execFileSync("git", ["-C", project, ...args], {
    stdio: "pipe",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  });
git(["init", "--initial-branch=main"]);
git(["add", "."]);
git([
  "-c",
  "user.name=LinkShell Fixture",
  "-c",
  "user.email=fixture@localhost",
  "-c",
  "commit.gpgSign=false",
  "-c",
  "core.hooksPath=/dev/null",
  "commit",
  "-m",
  "fixture: isolated workspace",
]);

const now = Date.now();
const richResponse = [
  "已整理浏览器工作区的检查清单。这里的内容用于验证排版与交互，**并不表示生产环境已经验收通过**。",
  "",
  "### 本次检查",
  "",
  "| 模块 | 交互路径 | 需要观察的状态 |",
  "| --- | --- | --- |",
  "| 聊天列表 | 搜索 → 筛选 → 打开会话 | 长标题截断、分组、当前行与空结果 |",
  "| 聊天详情 | 阅读历史 → 复制代码 → 打开文件 | 滚动位置、代码横向溢出、返回最新 |",
  "| 终端 | 新建 → 输入 → 切换标签 → 刷新 | 焦点、输入、回放、断线恢复 |",
  "",
  "```typescript",
  'type ConnectionState = "connecting" | "connected" | "disconnected";',
  "",
  "export function connectionLabel(state: ConnectionState): string {",
  '  return { connecting: "连接中", connected: "已连接", disconnected: "连接已断开" }[state];',
  "}",
  "```",
  "",
  `可以打开 [会话摘要代码](${join(project, "src", "components", "SessionSummary.ts")}:10)、[验收清单](${join(project, "docs", "体验验收", "检查清单.md")}) 和 [长日志第 4200 行](${join(project, "logs", "long-output.txt")}:4200)。`,
  "",
  "> 阅读较早内容时，新消息不应该把页面强制拉回底部；只有主动返回最新后才恢复跟随。",
  "",
  "- [x] 准备隔离文件与真实 Git 项目",
  "- [ ] 检查深浅主题及 390px 窄屏",
  "- [ ] 检查加载、失败、空内容和键盘导航",
  "",
  "连续中文长内容：聊天详情页需要同时处理说明文字、代码、文件引用和工具输出。即使消息很长，段落仍应保持易读，操作按钮应可以发现，工具栏不能遮挡正文。浏览历史时应保留阅读位置，输入法组合期间不能意外提交，也不能因为侧栏打开就让输入区越出视口。",
].join("\n");
const seedSessions: DiscoveredSession[] = [
  {
    nativeId: "fixture",
    cwd: project,
    title: "网页工作区 · 完整交互验收",
    preview: "Markdown、代码、文件引用和工具输出，逐项检查真实交互。",
    createdAt: now - 3_600_000,
    updatedAt: now - 60_000,
  },
  {
    nativeId: "fixture-running",
    cwd: project,
    title: "检查长会话的历史滚动与连接恢复",
    preview: "正在检查终端回放和浏览器工作区的状态变化。",
    createdAt: now - 7_200_000,
    updatedAt: now - 120_000,
  },
  {
    nativeId: "fixture-approval",
    cwd: portalProject,
    title: "执行工作区检查前，确认本次访问范围",
    preview: "一个模拟审批请求，便于检查聊天列表与详情的处理入口。",
    createdAt: now - 86_400_000,
    updatedAt: now - 180_000,
  },
  {
    nativeId: "fixture-questions",
    cwd: portalProject,
    title:
      "客户服务工作区体验完善：长项目名称、中文目录以及窄屏下的信息层级和操作可发现性",
    preview: "需要你补充验收优先级；其他检查可以继续进行。",
    createdAt: now - 172_800_000,
    updatedAt: now - 240_000,
  },
  {
    nativeId: "fixture-history",
    cwd: project,
    title: "整理界面细节与实现记录",
    preview: "保留多轮历史，检查向上阅读和返回最新。",
    createdAt: now - 259_200_000,
    updatedAt: now - 3_600_000,
  },
  {
    nativeId: "fixture-error",
    cwd: notesProject,
    title: "连接中断后的恢复说明",
    preview: "模拟一次 Agent 失败，用于检查错误提示和继续输入。",
    createdAt: now - 345_600_000,
    updatedAt: now - 7_200_000,
  },
  {
    nativeId: "fixture-archived",
    cwd: notesProject,
    title: "已归档 · 第一轮设计讨论",
    preview: "用于检查归档列表、详情打开和恢复会话。",
    createdAt: now - 604_800_000,
    updatedAt: now - 518_400_000,
    archived: true,
  },
];

function seedHistory(id: string): SessionUpdate[] {
  const message = (
    messageId: string,
    role: "user" | "agent",
    text: string,
  ): SessionUpdate => ({
    sessionUpdate: "ls_message",
    messageId,
    role,
    content: [{ type: "text", text }],
  });
  if (id === "fixture-history") {
    return Array.from({ length: 16 }, (_, index) => [
      message(
        `history-user-${index}`,
        "user",
        `第 ${index + 1} 轮：继续检查聊天详情与文件导航的使用体验。`,
      ),
      message(
        `history-agent-${index}`,
        "agent",
        `检查记录 ${index + 1}\n\n用户在较早的对话里查找上下文时，页面应保留阅读位置。工具输出收起后仍需显示名称与结果；展开时长行应在容器内滚动。切换会话后需要正确恢复输入草稿。\n\n${index % 4 === 0 ? richResponse : "这条消息用于验证多轮内容的阅读节奏和消息间距。"}`,
      ),
    ]).flat();
  }
  if (id !== "fixture") {
    const session = seedSessions.find((entry) => entry.nativeId === id);
    return [
      message(
        `${id}-intro`,
        "agent",
        session?.preview ?? "这是新建的隔离测试会话，可以输入消息继续验证。",
      ),
    ];
  }
  return [
    message(
      "initial-user",
      "user",
      "请认真检查整个浏览器工作区，聊天列表、聊天详情、终端以及其他所有页面都要清晰、完整且易用。",
    ),
    {
      sessionUpdate: "plan",
      entries: [
        {
          content: "检查页面结构、导航和主题一致性",
          priority: "high",
          status: "completed",
        },
        {
          content: "验证聊天、终端、文件与工作树的真实操作",
          priority: "high",
          status: "in_progress",
        },
        {
          content: "记录仍需真实 Agent 和公网验证的边界",
          priority: "medium",
          status: "pending",
        },
      ],
    },
    {
      sessionUpdate: "tool_call",
      toolCallId: "fixture-inspect",
      title: "读取工作区文件与目录",
      kind: "read",
      status: "completed",
      locations: [
        {
          path: join(project, "src", "components", "SessionSummary.ts"),
          line: 10,
        },
      ],
      content: [
        {
          type: "content",
          content: {
            type: "text",
            text: "README.md\nsrc/components/SessionSummary.ts\ndocs/体验验收/检查清单.md\nlogs/long-output.txt\n\n已读取 4 个文件。此结果是模拟 Agent 输出，文件本身真实存在。",
          },
        },
      ],
    },
    {
      sessionUpdate: "tool_call",
      toolCallId: "fixture-diff",
      title: "展示会话标签修改",
      kind: "edit",
      status: "completed",
      content: [
        {
          type: "diff",
          path: join(project, "hello.ts"),
          oldText: 'export const message = "LinkShell web test";\n',
          newText: 'export const message = "LinkShell 浏览器工作区";\n',
        },
      ],
    },
    message("fixture-rich-response", "agent", richResponse),
    {
      sessionUpdate: "usage_update",
      usedTokens: 18420,
      contextWindow: 128000,
      tokens: { totalTokens: 18420, inputTokens: 15100, outputTokens: 3320 },
    },
  ];
}
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
  readonly behavior = {
    desktop: "multi_client",
    history: "native-snapshot",
    turnCompletion: "native-events",
    busyInput: "concurrent-prompt",
    fork: "native-turn",
    detach: "local-only",
  } as const;
  private rejectedAnswer = false;
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
  goals = new Map<string, SessionGoal>();
  sessions: DiscoveredSession[] = seedSessions.map((session) => ({
    ...session,
  }));
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
  async attach(id: string): Promise<HistoryItem[]> {
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
              { name: "async-test", description: "测试异步问答及失败重试" },
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
          ...seedHistory(id),
          { sessionUpdate: "ls_turn", state: "ended", stopReason: "end_turn" },
        ],
      },
    ];
  }
  async seedLiveStates() {
    // Import through the same attach/update path as a real driver; no database-only statuses.
    for (const session of this.sessions) {
      if (!session.archived) await this.host.follow(this.id, session.nativeId);
    }
    const emit = (id: string, update: SessionUpdate) =>
      this.host.update(this.id, id, update);
    emit("fixture-running", { sessionUpdate: "ls_turn", state: "started" });
    emit("fixture-running", {
      sessionUpdate: "tool_call",
      toolCallId: "fixture-running-check",
      title: "检查终端回放与连接状态",
      kind: "execute",
      status: "in_progress",
      content: [
        {
          type: "content",
          content: {
            type: "text",
            text: "模拟长时间运行的检查，便于观察进行中状态。可以点击停止结束本轮。",
          },
        },
      ],
    });
    emit("fixture-approval", { sessionUpdate: "ls_turn", state: "started" });
    emit("fixture-approval", {
      sessionUpdate: "ls_permission",
      requestId: "fixture-permission",
      title: "允许读取隔离工作区的验收文件？",
      detail: `这是模拟 Agent 审批；不会执行额外命令。目标目录：${portalProject}`,
      tool: {
        title: "读取验收文件",
        kind: "read",
        locations: [{ path: join(portalProject, "README.md") }],
      },
      options: [
        { optionId: "allow", name: "允许本次", kind: "allow_once" },
        { optionId: "reject", name: "拒绝", kind: "reject_once" },
      ],
    });
    emit("fixture-questions", { sessionUpdate: "ls_turn", state: "started" });
    emit("fixture-questions", {
      sessionUpdate: "agent_message_chunk",
      messageId: "fixture-question-message",
      content: {
        type: "text",
        text: "继续检查前，请补充这一轮的验收重点。模拟检查会保持进行中，可以逐个回答，也可以稍后再答。",
      },
    });
    emit("fixture-questions", {
      sessionUpdate: "ls_message_done",
      messageId: "fixture-question-message",
      role: "agent",
      questions: [
        {
          id: "fixture-question-priority",
          title: "优先检查哪类体验？",
          options: ["键盘与输入", "长内容与窄屏", "连接恢复"],
        },
        {
          id: "fixture-question-notes",
          title: "还有需要特别检查的内容吗？",
          options: [],
        },
      ],
    });
    emit("fixture-error", {
      sessionUpdate: "ls_error",
      code: "fixture_connection_lost",
      message: "模拟 Agent 连接中断。真实 Host 和加密通道仍正常。",
      hint: "可以发送一条新消息，验证会话恢复到可继续使用的状态。",
    });
    emit("fixture-error", {
      sessionUpdate: "ls_turn",
      state: "ended",
      stopReason: "error",
    });
  }
  async detach() {}
  async prompt(id: string, content: ContentBlock[], clientMessageId: string) {
    const text = content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    if (
      !this.rejectedAnswer &&
      questionReplies(text)?.some((reply) => reply.answer === "完整验证")
    ) {
      this.rejectedAnswer = true;
      throw new Error("模拟回答失败，请重试");
    }
    const emit = (update: Parameters<DriverHost["update"]>[2]) =>
      this.host.update(this.id, id, update);
    if (questionReplies(text)) {
      emit({
        sessionUpdate: "user_message_chunk",
        messageId: `local-${clientMessageId}`,
        content: { type: "text", text },
      });
      return "started" as const;
    }
    emit({
      sessionUpdate: "ls_message",
      messageId: `local-${clientMessageId}`,
      role: "user",
      content: [{ type: "text", text }],
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
    else if (text === "/async-test") {
      const messageId = randomUUID();
      emit({ sessionUpdate: "ls_turn", state: "started" });
      emit({
        sessionUpdate: "agent_message_chunk",
        messageId,
        content: { type: "text", text: "异步问答联调：选项、自由输入和跳过。" },
      });
      emit({
        sessionUpdate: "ls_message_done",
        messageId,
        role: "agent",
        questions: [
          {
            id: randomUUID(),
            title: "选择测试方式",
            options: ["快速验证", "完整验证"],
          },
          { id: randomUUID(), title: "补充说明", options: [] },
          { id: randomUUID(), title: "可跳过的问题", options: ["继续"] },
        ],
      });
    } else if (text === "/ask-test")
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
    if (requestId === "fixture-permission") {
      this.host.update(this.id, id, {
        sessionUpdate: "ls_notice",
        level: "info",
        title: optionId === "allow" ? "模拟审批已允许" : "模拟审批已拒绝",
      });
      this.host.update(this.id, id, {
        sessionUpdate: "ls_turn",
        state: "ended",
        stopReason: "end_turn",
      });
    }
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
    let goalValue = this.goals.get(id) ?? null;
    if (change.action === "set")
      goalValue = {
        objective: change.objective,
        status: "active",
        tokenBudget: change.tokenBudget,
      };
    if (change.action === "clear") goalValue = null;
    if (goalValue && change.action === "pause") goalValue.status = "paused";
    if (goalValue && change.action === "resume") goalValue.status = "active";
    if (goalValue) this.goals.set(id, goalValue);
    else this.goals.delete(id);
    this.host.update(this.id, id, {
      sessionUpdate: "ls_goal",
      goal: goalValue,
    });
    return goalValue;
  }
  async rename(id: string, title: string) {
    const session = this.sessions.find((entry) => entry.nativeId === id);
    if (session) session.title = title;
  }
  async archive(id: string, archived: boolean) {
    const session = this.sessions.find((entry) => entry.nativeId === id);
    if (session) session.archived = archived;
  }
  async delete(id: string) {
    this.sessions = this.sessions.filter((entry) => entry.nativeId !== id);
    this.goals.delete(id);
  }
}
class EditorFixture extends Fixture {
  id = "fixture-editor";
  label = "文件编辑（隔离联调）";
  capabilities = {
    interrupt: true,
    steer: true,
    permissions: true,
    images: true,
    fork: true,
    models: true,
    modes: true,
    acp: true,
  };
  sessions: DiscoveredSession[] = [];
  private editors = new Map<string, string>();
  async editor(input: EditorRequest): Promise<EditorResult> {
    if (input.operation === "open") {
      const path = realpathSync(input.path!);
      if (!path.startsWith(realpathSync(home) + "/"))
        throw new Error("测试编辑器只允许访问临时目录");
      const editorId = randomUUID();
      this.editors.set(editorId, path);
      return { editorId, path, text: readFileSync(path, "utf8"), version: 1 };
    }
    const path = this.editors.get(input.editorId ?? "");
    if (!path) throw new Error("测试编辑会话已关闭");
    if (input.operation === "close") {
      this.editors.delete(input.editorId!);
      return {};
    }
    if (input.operation === "save") {
      writeFileSync(path, input.text ?? "");
      return { editorId: input.editorId, path, text: input.text, version: 2 };
    }
    return { suggestions: [] };
  }
}
const gateway = await startGateway({
  port: 5181,
  host: "127.0.0.1",
  databasePath: join(home, "relay.db"),
});
const fixture = new Fixture();
const host = await startHost({
  home: join(home, "host"),
  version: "web-fixture",
  drivers: () => [fixture, new EditorFixture()],
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
await fixture.seedLiveStates();
const worktreeSession = await host.hub.fork("codex:fixture", {
  worktree: true,
});
await host.hub.rename(worktreeSession.id, "独立工作树 · 对照检查");
const offer = await host.gateway!.startPairing();
process.stdout.write(
  JSON.stringify({
    gateway: "ws://127.0.0.1:5181",
    code: offer.code,
    project,
    projects: [project, portalProject, notesProject],
    worktree: worktreeSession.cwd,
    sessions: fixture.sessions.map(({ nativeId, title, archived }) => ({
      id: `codex:${nativeId}`,
      title,
      archived: archived ?? false,
    })),
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
