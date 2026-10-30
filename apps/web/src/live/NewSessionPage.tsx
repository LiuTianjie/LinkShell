import { useEffect, useRef, useState } from "react";
import type { AgentInfo, SessionSummary } from "@linkshell/wire";
import { ArrowUp, Check, ChevronDown, Cpu, FolderOpen, GitBranch, LoaderCircle } from "lucide-react";
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
import { configToCreate, creationOptions, modelName, modelToCreate, useAgentModels } from "./agent-models";
import { NewSessionConfig } from "./NewSessionConfig";
import { Files } from "./Files";
import { useStore } from "zustand";
import { engine } from "./engine";
import { computerName, computerNames } from "./computer-names";

const usableAgent = (entry: AgentInfo) =>
  entry.installed && !entry.problem && entry.auth?.state !== "missing" && entry.tier !== "terminal";

/**
 * A new session on the desktop, as Codex starts a thread: an empty conversation with the
 * composer in the middle. What is chosen before writing (the agent, its model, where it works,
 * its own worktree) are the composer's pills; Enter starts it.
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
  // Picked per agent: choosing another agent starts from that agent's own default.
  const [picked, setPicked] = useState<{ store: typeof store; agent: string; model: string }>();
  const [configPick, setConfigPick] = useState<{ store: typeof store; key: string; values: Record<string, string> }>();
  const [modelsRevision, setModelsRevision] = useState(0);
  const input = useRef<HTMLTextAreaElement>(null);
  // The agent list arrives after the page: choose the first usable one once it does.
  useEffect(() => {
    if (!agent && machine) setAgent(machine.agents.find(usableAgent)?.id ?? "");
  }, [machine, agent]);
  useEffect(() => { setWorktree(false); }, [cwd]);
  const git = useLoad(() => (cwd.trim() ? actions.gitInfo(cwd) : Promise.resolve(undefined)), [store, cwd]);
  const selected = machine?.agents.find((entry) => entry.id === agent);
  const usable = !!selected && usableAgent(selected);
  const pickedModel = picked?.store === store && picked.agent === agent ? picked.model : undefined;
  const models = useAgentModels(agent, cwd, online && usable, pickedModel, modelsRevision);
  const ready = online && usable && !!cwd.trim() && !job.busy && !!models && !models.error;
  const model = modelToCreate(models, pickedModel);
  const shownModel = models?.models.find((entry) => entry.value === (model ?? models.current));
  const configKey = JSON.stringify([agent, cwd.trim()]);
  const pickedConfig = configPick?.store === store && configPick.key === configKey ? configPick.values : {};
  const options = creationOptions(models?.config, pickedConfig);
  const unavailableModel = pickedModel && models && !models.error && !models.models.some((entry) => entry.value === pickedModel);
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
        // Untouched, the agent picks as it always does (its config, its default): nothing is pinned.
        model,
        config: configToCreate(models?.config, pickedConfig),
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
          <div className="new-session-bar flex-wrap">
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
            {online && usable && !models && (
              <span className="new-session-pill new-session-pill-static" role="status"><LoaderCircle className="animate-spin" /><span>正在读取模型与设置…</span></span>
            )}
            {models && !models.models.length && !models.error && (
              <Button type="button" variant="ghost" size="sm" className="new-session-pill" title="Agent 尚未提供可预选的模型；点击重新读取" disabled={job.busy} onClick={() => setModelsRevision((value) => value + 1)}>
                <Cpu />
                <span>默认模型</span>
              </Button>
            )}
            {!!models?.models.length && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button type="button" variant="ghost" size="sm" className="new-session-pill" disabled={job.busy} title={shownModel ? `模型：${shownModel.name}` : "模型"} aria-label="选择模型">
                    <Cpu />
                    <span>{shownModel ? modelName(shownModel) : "默认模型"}</span>
                    <ChevronDown className="new-session-caret" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent side="top" align="start" sideOffset={8} collisionPadding={12} className="new-session-menu">
                  <DropdownMenuLabel>模型</DropdownMenuLabel>
                  <DropdownMenuRadioGroup value={shownModel?.value ?? ""} onValueChange={(value) => setPicked({ store, agent, model: value })}>
                    {models.models.map((entry) => {
                      const name = modelName(entry);
                      // Claude's own default already reads 默认（推荐）.
                      const note = [entry.value === models.current && !name.startsWith("默认") ? "默认" : undefined, entry.description].filter(Boolean).join(" · ");
                      return (
                        <DropdownMenuRadioItem key={entry.value} value={entry.value}>
                          <span className="new-session-option">
                            <span>{name}</span>
                            {note && <small>{note}</small>}
                          </span>
                        </DropdownMenuRadioItem>
                      );
                    })}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            <NewSessionConfig options={options} disabled={job.busy} onChange={(id, value) => setConfigPick({ store, key: configKey, values: { ...pickedConfig, [id]: value } })} />
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
        {unavailableModel && <p className="new-session-note" role="status">此前选择的模型已不可用，将使用 Agent 的默认模型；也可以重新选择。</p>}
        {models?.error && (
          <div className="flex flex-col gap-2">
            <ErrorNotice error={`模型与设置加载失败：${models.error}`} />
            <Button type="button" variant="outline" size="sm" className="self-start" disabled={job.busy} onClick={() => setModelsRevision((value) => value + 1)}>重新读取模型与设置</Button>
          </div>
        )}
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
