import { Platform } from "react-native";
import type { Theme } from "../../../theme";
import type {
  AgentConversationRecord,
  AgentPermissionMode,
  AgentReasoningEffort,
  AgentToolCall,
} from "../types";

export type Option<T extends string> = { label: string; value?: T; image?: string };

export const EFFORT_OPTIONS: Option<AgentReasoningEffort>[] = [
  { label: "默认强度", value: undefined },
  { label: "无", value: "none" },
  { label: "极低", value: "minimal" },
  { label: "低", value: "low" },
  { label: "中", value: "medium" },
  { label: "高", value: "high" },
  { label: "超高", value: "xhigh" },
];

export const PERMISSION_OPTIONS: Option<AgentPermissionMode>[] = [
  { label: "默认权限", value: undefined, image: "hand.raised.fill" },
  { label: "只读", value: "read_only", image: "eye.fill" },
  { label: "自动审查", value: "workspace_write", image: "lock.shield.fill" },
  { label: "完全访问权限", value: "full_access", image: "lock.open.fill" },
];

export const MAX_IMAGE_ATTACHMENTS = 3;
export const MAX_IMAGE_DATA_URL_LENGTH = 4_000_000;
export const FILE_PREVIEW_MAX_BYTES = 256_000;
export const DEFAULT_OPTION_ID = "__default__";
export const MONO_FONT = Platform.select({ ios: "Menlo", android: "monospace" });

export function timelineSurface(theme: Theme): string {
  return theme.mode === "light" ? "rgba(255,255,255,0.78)" : "rgba(255,255,255,0.055)";
}

export function agentEventSurface(theme: Theme): string {
  return theme.mode === "light" ? "rgba(255,255,255,0.64)" : "rgba(255,255,255,0.038)";
}

export function agentEventBorder(theme: Theme): string {
  return theme.mode === "light" ? "rgba(60,60,67,0.13)" : "rgba(255,255,255,0.08)";
}

export function statusMeta(status: string, theme: Theme) {
  switch (status) {
    case "running":
      return { label: "运行中", color: theme.accent, bg: theme.accentLight };
    case "waiting_permission":
      return { label: "待授权", color: theme.warning, bg: theme.accentLight };
    case "error":
      return { label: "错误", color: theme.error, bg: theme.errorLight };
    case "idle":
      return { label: "空闲", color: theme.success, bg: theme.accentLight };
    default:
      return { label: "不可用", color: theme.textTertiary, bg: theme.bgInput };
  }
}

export function visibleConversationStatus(status: string | undefined, theme: Theme) {
  if (status === "running" || status === "waiting_permission" || status === "error") {
    return statusMeta(status, theme);
  }
  return null;
}

export function toolStatusMeta(status: AgentToolCall["status"], theme: Theme) {
  if (status === "running") return { label: "运行中", color: theme.accent, bg: theme.accentLight };
  if (status === "failed") return { label: "失败", color: theme.error, bg: theme.errorLight };
  if (status === "completed") {
    return {
      label: "完成",
      color: theme.success,
      bg: theme.mode === "light" ? "rgba(26, 171, 110, 0.10)" : "rgba(78, 222, 163, 0.12)",
    };
  }
  if (status === "pending") return { label: "待执行", color: theme.textTertiary, bg: theme.bgInput };
  return null;
}

export function permissionMeta(mode: AgentPermissionMode | undefined, theme: Theme) {
  if (mode === "full_access") {
    return { label: "完全访问权限", icon: "lock.open.fill", color: theme.warning, bg: theme.accentLight };
  }
  if (mode === "workspace_write") {
    return { label: "自动审查", icon: "lock.shield.fill", color: theme.accent, bg: theme.accentLight };
  }
  if (mode === "read_only") {
    return { label: "只读", icon: "eye.fill", color: theme.textSecondary, bg: theme.bgInput };
  }
  return { label: "默认权限", icon: "hand.raised.fill", color: theme.textSecondary, bg: theme.bgInput };
}

export function formatEffort(effort?: AgentReasoningEffort): string {
  if (!effort) return "默认";
  if (effort === "xhigh") return "超高";
  if (effort === "high") return "高";
  if (effort === "medium") return "中";
  if (effort === "low") return "低";
  if (effort === "minimal") return "极低";
  if (effort === "none") return "无";
  return "极低";
}

export function formatRuntime(
  model: string | undefined,
  effort: AgentReasoningEffort | undefined,
  modelOptions: Option<string>[],
): string {
  const modelLabel = modelOptions.find((item) => item.value === model)?.label ?? model ?? "默认模型";
  return `${modelLabel.replace(/^GPT-/, "")} · ${formatEffort(effort)}`;
}

export function formatModel(model: string | undefined, modelOptions: Option<string>[]): string {
  const label = modelOptions.find((item) => item.value === model)?.label ?? model ?? "默认模型";
  return label.replace(/^GPT-/, "");
}

export function permissionModeNeedsAttention(mode: AgentPermissionMode | undefined): boolean {
  return mode === "workspace_write" || mode === "full_access";
}

export function shortPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  if (parts.length <= 3) return path;
  return `…/${parts.slice(-3).join("/")}`;
}

export function displayProvider(provider: AgentConversationRecord["provider"]): string {
  if (provider === "codex") return "Codex";
  if (provider === "claude") return "Claude";
  return "Custom";
}

export function parentPath(path: string): string {
  const clean = path.replace(/\/+$/, "");
  if (!clean || clean === "/") return "/";
  const index = clean.lastIndexOf("/");
  return index <= 0 ? "/" : clean.slice(0, index);
}

export function fileName(path: string): string {
  return path.split("/").filter(Boolean).pop() || path || "/";
}

export function formatBytes(value: number | undefined): string {
  if (typeof value !== "number") return "";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

export function languageFromPath(path: string): string {
  const ext = (path.split(".").pop() || "").toLowerCase();
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "tsx",
    js: "javascript",
    jsx: "jsx",
    json: "json",
    mjs: "javascript",
    cjs: "javascript",
    css: "css",
    scss: "scss",
    html: "html",
    md: "markdown",
    yml: "yaml",
    yaml: "yaml",
    sh: "shell",
    zsh: "shell",
    bash: "shell",
    py: "python",
    rb: "ruby",
    go: "go",
    rs: "rust",
    swift: "swift",
    kt: "kotlin",
    java: "java",
    c: "c",
    h: "c",
    cpp: "cpp",
    hpp: "cpp",
    sql: "sql",
    xml: "xml",
  };
  return map[ext] ?? (ext || "text");
}

export function compactPath(value: string): string {
  const cleaned = value.trim().replace(/^["']|["']$/g, "");
  const parts = cleaned.split("/").filter(Boolean);
  if (parts.length <= 2) return cleaned;
  return parts.slice(-2).join("/");
}

export function normalizedToken(value: string | undefined): string {
  return (value ?? "").toLowerCase().replace(/[_\-\s/]+/g, "");
}

export function isEmptyActivityText(value: string | undefined): boolean {
  const text = value?.trim();
  if (!text) return true;
  if (text === "[]" || text === "{}" || text === "null" || text === "undefined") return true;
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed.length === 0;
    if (parsed && typeof parsed === "object") return Object.keys(parsed).length === 0;
  } catch {
    // Non-JSON text is real activity content.
  }
  return false;
}
