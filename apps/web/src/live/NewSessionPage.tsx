import { useEffect, useRef, useState } from "react";
import type { AgentInfo, SessionSummary } from "@linkshell/wire";
import { ArrowUp, Check, ChevronDown, FolderOpen, GitBranch, LoaderCircle } from "lucide-react";
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
import { Modal } from "./common";
import { AgentMark, ErrorNotice, useActions, useClient, useConnection, useJob, useLoad } from "./common";
import { AgentInteractions } from "./Acp";
import { Files } from "./Files";
import { useStore } from "zustand";
import { engine } from "./engine";
import { computerName, computerNames } from "./computer-names";

const usableAgent = (entry: AgentInfo) =>
  entry.installed && !entry.problem && entry.auth?.state !== "missing" && entry.tier !== "terminal";

/**
 * A new session on the desktop, as Codex starts a thread: an empty conversation with the
 * composer in the middle. What is chosen before writing (the agent, where it works, its own
 * worktree) are the composer's pills; Enter starts it.
 */
export function NewSessionPage({
  initialDirectory,
  created,
  cancel,
}: {
  initialDirectory?: string;
  created: (session: SessionSummary) => void;
  cancel: () => void;
}) {
  const machine = useClient((state) => state.machine);
  const projects = useClient((state) => state.projects);
  const online = useClient((state) => state.status === "online");
  const actions = useActions();
  const { store } = useConnection();
  const engineState = useStore(engine.state);
  const names = useStore(computerNames.store);
  const job = useJob();
  const [agent, setAgent] = useState(() => machine?.agents.find(usableAgent)?.id ?? "");
  const [cwd, setCwd] = useState(initialDirectory ?? projects[0]?.cwd ?? machine?.home ?? "");
  const [prompt, setPrompt] = useState("");
  const [worktree, setWorktree] = useState(false);
  const [browse, setBrowse] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  // The agent list arrives after the page: choose the first usable one once it does.
  useEffect(() => {
    if (!agent && machine) setAgent(machine.agents.find(usableAgent)?.id ?? "");
  }, [machine, agent]);
  useEffect(() => { setWorktree(false); }, [cwd]);
  const git = useLoad(() => (cwd.trim() ? actions.gitInfo(cwd) : Promise.resolve(undefined)), [store, cwd]);
  const selected = machine?.agents.find((entry) => entry.id === agent);
  const usable = !!selected && usableAgent(selected);
  const ready = online && usable && !!cwd.trim() && !job.busy;
  const project = projects.find((entry) => entry.cwd === cwd);
  const place = project?.name ?? (cwd.split(/[\\/]/).filter(Boolean).pop() || cwd || "选择目录");
  const computer = engineState.connection?.computer;
  const start = () => {
    if (!ready) return;
    void job.run(async () =>
      created(await actions.createSession({
        agent,
        cwd: cwd.trim(),
        worktree: worktree && !!git.value,
        prompt: prompt.trim() ? [{ type: "text", text: prompt.trim() }] : undefined,
      })),
    );
  };

  return (
    <div className="new-session-page">
      <AgentInteractions agent={agent} />
      <div className="new-session-stage">
        <h1>{computer ? `在 ${computerName(computer, names)} 上开始` : "新建会话"}</h1>
        <form
          className="new-session-composer"
          onSubmit={(event) => { event.preventDefault(); start(); }}
        >
          <textarea
            ref={input}
            autoFocus
            rows={3}
            value={prompt}
            disabled={job.busy}
            aria-label="任务描述"
            placeholder="描述要完成的工作，或者直接开始…"
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") { event.preventDefault(); cancel(); }
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); start(); }
            }}
          />
          <div className="new-session-bar">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" variant="ghost" size="sm" className="new-session-pill" disabled={job.busy} aria-label="选择 Agent">
                  {selected && <AgentMark agent={selected.id} />}
                  <span>{selected?.label ?? "选择 Agent"}</span>
                  <ChevronDown className="new-session-caret" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="top" align="start" sideOffset={8} collisionPadding={12} className="new-session-menu">
                <DropdownMenuLabel>Agent</DropdownMenuLabel>
                <DropdownMenuRadioGroup value={agent} onValueChange={setAgent}>
                  {(machine?.agents ?? []).map((entry) => (
                    <DropdownMenuRadioItem key={entry.id} value={entry.id} disabled={!usableAgent(entry)}>
                      <AgentMark agent={entry.id} />
                      <span className="new-session-option">
                        <span>{entry.label}</span>
                        {!usableAgent(entry) && (
                          <small>
                            {!entry.installed ? "未安装" : entry.auth?.state === "missing" ? "未登录" : entry.tier === "terminal" ? "请从终端打开" : entry.problem}
                          </small>
                        )}
                      </span>
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" variant="ghost" size="sm" className="new-session-pill" disabled={job.busy} title={cwd} aria-label="选择工作目录">
                  <FolderOpen />
                  <span>{place}</span>
                  <ChevronDown className="new-session-caret" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="top" align="start" sideOffset={8} collisionPadding={12} className="new-session-menu">
                <DropdownMenuLabel>最近的项目</DropdownMenuLabel>
                {projects.slice(0, 8).map((entry) => (
                  <DropdownMenuItem key={entry.cwd} onSelect={() => setCwd(entry.cwd)}>
                    <span className="new-session-option">
                      <span>{entry.name}</span>
                      <small>{entry.cwd}</small>
                    </span>
                    {entry.cwd === cwd && <Check className="ml-auto" />}
                  </DropdownMenuItem>
                ))}
                {!projects.length && <p className="new-session-menu-empty">还没有项目</p>}
                <DropdownMenuSeparator />
                <DropdownMenuItem disabled={!online} onSelect={() => setBrowse(true)}>
                  <FolderOpen />浏览电脑上的目录…
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            {git.value && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="new-session-pill"
                data-active={worktree || undefined}
                aria-pressed={worktree}
                disabled={job.busy}
                title="基于当前 Git 仓库创建独立工作目录"
                onClick={() => setWorktree((value) => !value)}
              >
                <GitBranch />
                <span>{worktree ? "独立 worktree" : "当前分支"}</span>
              </Button>
            )}
            <span className="new-session-spacer" />
            <Button type="submit" size="icon" className="send-button" disabled={!ready} aria-label="开始会话" title="开始 · Enter（Shift Enter 换行）">
              {job.busy ? <LoaderCircle className="animate-spin" /> : <ArrowUp />}
            </Button>
          </div>
        </form>
        <ErrorNotice error={job.error} />
        {!online && <p className="new-session-note" role="status">电脑连接恢复后即可开始，已写的内容会保留。</p>}
        {online && machine && !usable && <p className="new-session-note">先在「电脑与 Agent」里确认 Agent 已安装并登录。</p>}
        <p className="new-session-hint">Agent 在 <code title={cwd}>{cwd || "所选目录"}</code> 里读写文件、运行命令 · Esc 取消</p>
      </div>
      {browse && (
        <Modal title="选择工作目录" wide close={() => setBrowse(false)}>
          <Files start={cwd} directoriesOnly onPick={(path) => { setCwd(path); setBrowse(false); input.current?.focus(); }} />
        </Modal>
      )}
    </div>
  );
}
