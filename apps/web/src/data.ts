export type Status = "waiting" | "running" | "done";
export interface Task {
  id: string;
  title: string;
  project: string;
  agent: "Claude" | "Codex";
  status: Status;
  detail: string;
  time: string;
}
export const initialTasks: Task[] = [
  {
    id: "auth",
    title: "完善登录续期与断线恢复",
    project: "linkshell",
    agent: "Claude",
    status: "waiting",
    detail: "等待确认 · 执行连接恢复测试",
    time: "刚刚",
  },
  {
    id: "web",
    title: "搭建网页端的会话工作区",
    project: "linkshell",
    agent: "Codex",
    status: "running",
    detail: "正在调整会话布局与响应式样式",
    time: "2 分钟前",
  },
  {
    id: "search",
    title: "优化文档搜索的键盘导航",
    project: "itool",
    agent: "Claude",
    status: "running",
    detail: "正在检查焦点切换与快捷键",
    time: "8 分钟前",
  },
  {
    id: "billing",
    title: "修复订阅页面的状态显示",
    project: "itool",
    agent: "Codex",
    status: "done",
    detail: "已完成 · 3 个文件变更",
    time: "32 分钟前",
  },
  {
    id: "docs",
    title: "补充自托管网关部署说明",
    project: "linkshell",
    agent: "Claude",
    status: "done",
    detail: "已完成 · 1 个文件变更",
    time: "1 小时前",
  },
];
export const statusLabels: Record<Status, string> = {
  waiting: "需要你",
  running: "进行中",
  done: "已完成",
};
export const fileNames = [
  "src/auth/session.ts",
  "src/connection/retry.ts",
  "test/session.test.ts",
];
