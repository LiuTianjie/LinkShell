import type { SessionConfigOption, SessionSummary } from "@linkshell/wire";
import { Brain, ChevronDown, Cpu, FolderGit2, Settings2, ShieldCheck } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useActions, useJob } from "./common";

const ICONS: Partial<Record<SessionConfigOption["category"], ReactNode>> = {
  mode: <ShieldCheck />,
  model: <Cpu />,
  effort: <Brain />,
};

/**
 * The settings people change mid-conversation, on the composer itself: mode, model and effort,
 * each a menu of its values, the way Codex and Claude's desktop apps put them under the prompt.
 * Everything else stays in the settings panel.
 */
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
  const shown = (["mode", "model", "effort"] as const)
    .map((category) => config.find((option) => option.category === category && option.type !== "boolean" && option.values.length > 1))
    .filter((option): option is SessionConfigOption => !!option);
  return (
    <>
      {shown.map((option) => {
        const current = option.values.find((value) => value.value === option.current);
        return (
          <DropdownMenu key={option.id}>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="plain"
                className="composer-chip"
                data-category={option.category}
                // Running without asking is worth seeing at a glance.
                data-risky={option.category === "mode" && /bypass|full|yolo|never/i.test(option.current) ? "" : undefined}
                disabled={disabled || job.busy}
                title={`${option.name}：${current?.name ?? option.current}`}
              >
                {ICONS[option.category]}
                <span>{current?.name ?? option.current}</span>
                <ChevronDown className="composer-chip-caret" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="composer-chip-menu" side="top" align="start" sideOffset={8}>
              <DropdownMenuLabel>{option.name}</DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={option.current}
                onValueChange={(value) => void job.run(() => actions.setConfig(session.id, option.id, value))}
              >
                {option.values.map((value) => (
                  <DropdownMenuRadioItem key={value.value} value={value.value}>
                    <span className="composer-chip-option">
                      <span>{value.group ? `${value.group} · ${value.name}` : value.name}</span>
                      {value.description && <small>{value.description}</small>}
                    </span>
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={openSettings}>
                <Settings2 />全部会话设置
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        );
      })}
      {!shown.length && (
        <Button variant="ghost" size="plain" className="composer-chip" title="模型与权限" onClick={openSettings}>
          <Settings2 />
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
      <FolderGit2 />
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
