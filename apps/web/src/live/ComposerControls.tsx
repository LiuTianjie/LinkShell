import { displayModelName, type SessionConfigOption, type SessionSummary } from "@linkshell/wire";
import { ChevronDown, Folder, Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Icon } from "../icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useActions, useJob } from "./common";

/** Keep settings recognisable in both the new-session form and an existing conversation. */
export function SessionConfigIcon({ category, value = "" }: { category: SessionConfigOption["category"]; value?: string }) {
  const name = category === "model" ? "model"
    : category === "effort" ? "effort"
    : /plan/i.test(value) ? "plan"
    : /bypass|full|yolo|never/i.test(value) ? "unlocked" : "shield";
  return <Icon name={name} data-icon="inline-start" />;
}

/** Settings outside model, effort and mode that shipped drivers report, by id or by English name. */
const OPTION_NAMES: Record<string, string> = {
  plan: "计划模式",
  "plan mode": "计划模式",
  fast: "快速模式",
  "fast mode": "快速模式",
  agent: "Agent 角色",
  "approval policy": "审批策略",
  approval_policy: "审批策略",
  sandbox: "沙盒",
  "sandbox mode": "沙盒模式",
};

export function sessionConfigLabel(option: SessionConfigOption): string {
  if (option.category === "model") return "模型";
  if (option.category === "effort") return "推理强度";
  const known = OPTION_NAMES[option.id] ?? OPTION_NAMES[option.name.trim().toLowerCase()];
  if (known) return known;
  return option.category === "mode" ? "权限模式" : option.name;
}

/** What those settings say about themselves, in Chinese; an agent's own wording stays as given. */
const OPTION_DESCRIPTIONS: Record<string, string> = {
  "faster responses on supported models": "在支持的模型上回复更快，额度消耗更多",
  "main-thread agent persona": "主对话使用的 Agent 角色",
  "session permission mode": "会话的权限模式",
  "available effort levels for this model": "这个模型可选的推理强度",
  "ai model to use": "使用的模型",
};
export function optionDescription(text: string): string {
  const trimmed = text.trim();
  // Claude appends why fast mode is unavailable: "… — not available on the free plan".
  const [head, reason] = trimmed.split(/\s+—\s+/, 2);
  const base = OPTION_DESCRIPTIONS[(head ?? trimmed).toLowerCase()];
  if (!base) return text;
  return reason ? `${base}（${FAST_MODE_REASONS[reason.toLowerCase()] ?? reason}）` : base;
}
const FAST_MODE_REASONS: Record<string, string> = {
  "not available on the free plan": "免费套餐不可用",
  "requires extra usage to be enabled for this account": "需要为账号开启额外用量",
  "not available for the selected model": "当前模型不支持",
  "not available on this api provider": "当前 API 服务商不支持",
  "disabled by environment configuration": "已被环境配置关闭",
  "eligibility could not be verified (network error)": "网络错误，无法确认是否可用",
};

/**
 * The settings people change mid-conversation, on the composer itself: mode, model and effort,
 * each a menu of its values, the way Codex and Claude's desktop apps put them under the prompt.
 * Everything else stays in the settings panel.
 */
/**
 * Agents name their modes, models and efforts in English. The common ones read in Chinese here;
 * anything else is shown as the agent says it.
 */
const VALUE_NAMES: Record<string, string> = {
  "default": "默认",
  "default (recommended)": "默认（推荐）",
  "bypass permissions": "免确认",
  "bypasspermissions": "免确认",
  "accept edits": "自动接受编辑",
  "acceptedits": "自动接受编辑",
  "plan": "计划模式",
  "plan mode": "计划模式",
  "read only": "只读",
  "read-only": "只读",
  "auto": "自动",
  "full access": "完全访问",
  "full-access": "完全访问",
  "ask": "每次询问",
  "manual": "每次询问",
  "minimal": "最少",
  "low": "低",
  "medium": "中",
  "high": "高",
  "xhigh": "很高",
  "max": "最高",
  "ultra": "极高",
  "none": "关闭",
  "on": "开",
  "off": "关",
  "custom": "自定义",
  // Gemini's approval modes.
  "auto edit": "自动编辑",
  "yolo": "全部自动批准",
};
export function valueName(name: string): string {
  return VALUE_NAMES[name.trim().toLowerCase()] ?? displayModelName(name);
}

/** What Claude's and Codex's permission modes say they do, in Chinese; anything else as given. */
const DESCRIPTIONS: Record<string, string> = {
  "always ask before making changes": "改动前都先问你",
  "automatically accept all file edits": "文件改动自动接受，其他操作仍会问你",
  "create a plan before making changes": "先出计划，确认后再动手",
  "claude handles permission decisions": "由 Claude 判断哪些操作需要问你",
  "accepts all permissions": "所有操作都不再询问",
  "can read files; asks before editing or running commands": "可以读文件，编辑或运行命令前会问你",
  "edits and runs commands in the workspace; asks before anything else": "在工作区内编辑和运行命令，其他操作会问你",
  "edits and runs anything without asking": "编辑和运行任何东西都不问",
  "discuss and plan first; no changes until the plan is agreed": "先讨论和计划，计划确认前不做改动",
  "set in codex's own config": "按 Codex 自己的配置",
  "standard claude code agent": "标准的 Claude Code Agent",
  // Codex's reasoning efforts.
  "fast responses with lighter reasoning": "回复快，思考较浅",
  "balances speed and reasoning depth for everyday tasks": "兼顾速度和思考深度，适合日常任务",
  "greater reasoning depth for complex problems": "思考更深，适合复杂问题",
  "extra high reasoning depth for complex problems": "思考很深，适合复杂问题",
  "maximum reasoning depth for the hardest problems": "最深的思考，适合最难的问题",
  "maximum reasoning with automatic task delegation": "最深的思考，并自动分派子任务",
  // Gemini's approval modes.
  "prompts for approval": "每次操作前询问",
  "auto-approves edit tools": "自动批准编辑，其他操作仍会询问",
  "auto-approves all tools": "自动批准所有操作",
  "read-only mode": "只读，先出计划",
};
export function valueDescription(text: string): string {
  return DESCRIPTIONS[text.trim().toLowerCase()] ?? text;
}

export function ComposerConfig({
  session,
  config,
  disabled,
  openSettings,
}: {
  session: SessionSummary;
  config: SessionConfigOption[];
  disabled: boolean;
  openSettings: () => void;
}) {
  const actions = useActions();
  const job = useJob();
  const shown = (["model", "effort", "mode"] as const)
    .map((category) => config.find((option) => option.category === category && option.type !== "boolean" && option.values.length > 1))
    .filter((option): option is SessionConfigOption => !!option);
  return (
    <>
      {shown.map((option) => {
        const current = option.values.find((value) => value.value === option.current);
        const label = sessionConfigLabel(option);
        return (
          <DropdownMenu key={option.id}>
            <DropdownMenuTrigger asChild>
              <Button
                variant="toolbar"
                size="sm"
                className="composer-chip"
                data-category={option.category}
                // Running without asking is worth seeing at a glance.
                data-risky={option.category === "mode" && /bypass|full|yolo|never/i.test(option.current) ? "" : undefined}
                disabled={disabled || job.busy}
                aria-label={`${label}：${valueName(current?.name ?? option.current)}`}
                title={`${label}：${valueName(current?.name ?? option.current)}`}
              >
                <SessionConfigIcon category={option.category} value={option.current} />
                <span>{valueName(current?.name ?? option.current)}</span>
                <ChevronDown data-icon="inline-end" className="composer-chip-caret" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="composer-chip-menu" side="top" align="start" sideOffset={8}>
              <DropdownMenuLabel>{label}</DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={option.current}
                onValueChange={(value) => void job.run(() => actions.setConfig(session.id, option.id, value))}
              >
                {option.values.map((value) => (
                  <DropdownMenuRadioItem key={value.value} value={value.value}>
                    <span className="composer-chip-option">
                      <span>{value.group ? `${value.group} · ${valueName(value.name)}` : valueName(value.name)}</span>
                      {value.description && <small>{valueDescription(value.description)}</small>}
                    </span>
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuItem onSelect={openSettings}>
                  <Settings2 data-icon="inline-start" />全部会话设置
                </DropdownMenuItem>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        );
      })}
      {!shown.length && (
        <Button variant="toolbar" size="sm" className="composer-chip" title="模型与权限" onClick={openSettings}>
          <Settings2 data-icon="inline-start" />
          <span>{session.model ?? "模型与权限"}</span>
        </Button>
      )}
    </>
  );
}

/** Where the work happens: the project, and the worktree's branch when the session has its own. */
export function ComposerPlace({ session }: { session: SessionSummary }) {
  const project = session.worktree?.source ?? session.cwd;
  const name = project.split(/[\\/]/).filter(Boolean).pop() ?? project;
  return (
    <span className="composer-place" title={session.cwd}>
      <Folder aria-hidden />
      <span>{name}</span>
      {session.worktree && <span className="composer-place-branch">{session.worktree.branch}</span>}
    </span>
  );
}

/** Context used, as a ring that fills; the numbers on hover. */
export function ContextRing({ used, window }: { used: number; window: number }) {
  const ratio = Math.min(1, Math.max(0, used / window));
  const radius = 7;
  const length = 2 * Math.PI * radius;
  const format = (value: number) => (value >= 1000 ? `${Math.round(value / 100) / 10}K` : String(value));
  return (
    <span
      className="context-ring"
      data-level={ratio > 0.9 ? "high" : ratio > 0.7 ? "warm" : undefined}
      title={`上下文 ${Math.round(ratio * 100)}% · ${format(used)} / ${format(window)} Token`}
      aria-label={`上下文已用 ${Math.round(ratio * 100)}%`}
    >
      <svg viewBox="0 0 18 18" width="18" height="18" aria-hidden>
        <circle cx="9" cy="9" r={radius} />
        <circle cx="9" cy="9" r={radius} strokeDasharray={`${length * ratio} ${length}`} transform="rotate(-90 9 9)" />
      </svg>
      <span>{Math.round(ratio * 100)}%</span>
    </span>
  );
}
