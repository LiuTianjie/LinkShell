import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentInfo, SessionSummary } from "@linkshell/wire";
import { ArrowUp, Check, ChevronDown, FolderOpen, GitBranch, LoaderCircle, MessageSquarePlus, Plus } from "lucide-react";
import type { Command } from "../../../client/src/lib/commands";
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
import { MAX_ATTACHMENT_LABEL } from "./attachments";
import {
  ComposerBox,
  buildComposerContentBlocks,
  filesNeedUpload,
  type ComposerBoxHandle,
  type ComposerSubmitPayload,
} from "./ComposerBox";
import { finishComposerSend } from "./composer-draft";
import { SessionConfigIcon } from "./ComposerControls";
import { NewSessionConfig } from "./NewSessionConfig";
import { Files } from "./Files";
import { useStore } from "zustand";
import { engine } from "./engine";
import { computerName, computerNames } from "./computer-names";
import { sessionPreferences } from "./session-preferences";

export const NEW_SESSION_COMMANDS: Command[] = [
  { name: "plan", description: "进入计划模式" },
  { name: "init", description: "生成项目说明（CLAUDE.md / AGENTS.md）" },
  { name: "review", description: "审查改动" },
  { name: "security-review", description: "安全审查" },
  { name: "goal", description: "管理持续目标" },
];

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
  const { store, link } = useConnection();
  const engineState = useStore(engine.state);
  const names = useStore(computerNames.store);
  const job = useJob();
  const remembered = sessionPreferences.read(machine?.machineId);
  const [agentPick, setAgentPick] = useState<{ machineId?: string; agent: string }>();
  const preferredAgent = agentPick?.machineId === machine?.machineId ? agentPick?.agent ?? remembered.agent : remembered.agent;
  const agent = machine?.agents.find((entry) => entry.id === preferredAgent && usableAgent(entry))?.id ?? machine?.agents.find(usableAgent)?.id ?? "";
  const setAgent = (value: string) => { setAgentPick({ machineId: machine?.machineId, agent: value }); sessionPreferences.remember(machine?.machineId, value); };
  const [directory, setCwd] = useState(initialDirectory);
  const cwd = directory ?? machine?.home ?? "";
  const quick = !!machine?.home && cwd === machine.home;
  const [worktree, setWorktree] = useState(false);
  const [browse, setBrowse] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  // Explicit choices are checked against this computer's current agent capabilities.
  const [picked, setPicked] = useState<{ store: typeof store; agent: string; model: string }>();
  const [configPick, setConfigPick] = useState<{ store: typeof store; key: string; values: Record<string, string> }>();
  const [modelsRevision, setModelsRevision] = useState(0);
  const composerRef = useRef<ComposerBoxHandle>(null);
  const uploadCacheRef = useRef(new WeakMap<File, string>());
  useEffect(() => { setWorktree(false); }, [cwd]);
  const git = useLoad(() => (cwd.trim() ? actions.gitInfo(cwd) : Promise.resolve(undefined)), [store, cwd]);
  const selected = machine?.agents.find((entry) => entry.id === agent);
  const usable = !!selected && usableAgent(selected);
  const pickedModel = picked?.store === store && picked.agent === agent ? picked.model : remembered.agents[agent]?.model;
  const models = useAgentModels(agent, cwd, online && usable, pickedModel, modelsRevision);
  const ready = online && usable && !!cwd.trim() && !job.busy && !!models && !models.error;
  const model = modelToCreate(models, pickedModel);
  const shownModel = models?.models.find((entry) => entry.value === (model ?? models.current));
  const configKey = JSON.stringify([agent, cwd.trim()]);
  const rememberedConfig = remembered.agents[agent]?.config;
  const pickedConfig = useMemo(
    () => ({
      ...rememberedConfig,
      ...(configPick?.store === store && configPick.key === configKey ? configPick.values : {}),
    }),
    [configKey, configPick, rememberedConfig, store],
  );
  const options = useMemo(() => creationOptions(models?.config, pickedConfig), [models?.config, pickedConfig]);
  const unavailableModel = pickedModel && models && !models.error && !models.models.some((entry) => entry.value === pickedModel);
  const project = projects.find((entry) => entry.cwd === cwd);
  const place = quick ? "快速会话" : project?.name ?? (cwd.split(/[\\/]/).filter(Boolean).pop() || cwd || "选择目录");
  const computer = engineState.connection?.computer;

  const updateConfigOption = useCallback(
    (id: string, value: string) => {
      setConfigPick({ store, key: configKey, values: { ...pickedConfig, [id]: value } });
      sessionPreferences.remember(machine?.machineId, agent, { config: { [id]: value } });
    },
    [agent, configKey, machine?.machineId, pickedConfig, store],
  );

  const handleShortcutPicker = useCallback(
    (category: "model" | "mode" | "effort") => {
      if (job.busy) return;
      if (category === "model") {
        if (models?.models.length) setModelMenuOpen(true);
        else setModelsRevision((value) => value + 1);
        return;
      }
      const option = options.find((entry) => entry.category === category);
      if (!option || option.values.length < 2) return;
      const currentIndex = option.values.findIndex((entry) => entry.value === option.current);
      const next = option.values[(currentIndex + 1) % option.values.length];
      if (next) updateConfigOption(option.id, next.value);
    },
    [job.busy, models?.models.length, options, updateConfigOption],
  );

  const start = (payload: ComposerSubmitPayload) => {
    if (!ready) return;
    const trimmedCwd = cwd.trim();
    const useWorktree = worktree && !!git.value;
    void job.run(async () => {
      if (useWorktree && filesNeedUpload(payload.files, selected?.capabilities)) {
        const createdSession = await actions.createSession({
          agent,
          cwd: trimmedCwd,
          worktree: true,
          model,
          config: configToCreate(models?.config, pickedConfig),
        });
        const content = await buildComposerContentBlocks({
          text: payload.text,
          files: payload.files,
          pastedTexts: payload.pastedTexts,
          blocks: payload.blocks,
          capabilities: selected?.capabilities,
          uploadDir: createdSession.cwd,
          uploadCache: uploadCacheRef.current,
          callUpload: (dir, name, data) => link.call("fs.upload", { dir, name, data }),
        });
        if (content.length > 0) {
          await finishComposerSend(actions.send(createdSession.id, content), payload.clear);
        } else {
          payload.clear();
        }
        created(createdSession);
        return;
      }
      const content = await buildComposerContentBlocks({
        text: payload.text,
        files: payload.files,
        pastedTexts: payload.pastedTexts,
        blocks: payload.blocks,
        capabilities: selected?.capabilities,
        uploadDir: trimmedCwd,
        uploadCache: uploadCacheRef.current,
        callUpload: (dir, name, data) => link.call("fs.upload", { dir, name, data }),
      });
      const createdSession = await actions.createSession({
        agent,
        cwd: trimmedCwd,
        worktree: useWorktree,
        // Untouched, the agent picks as it always does (its config, its default): nothing is pinned.
        model,
        config: configToCreate(models?.config, pickedConfig),
        prompt: content.length ? content : undefined,
      });
      payload.clear();
      created(createdSession);
    });
  };

  return (
    <div className="new-session-page">
      <AgentInteractions agent={agent} />
      <div className="new-session-stage">
        <h1>{computer ? `在 ${computerName(computer, names)} 上开始` : "新建会话"}</h1>
        <ComposerBox
          ref={composerRef}
          variant="new-session"
          cwd={cwd}
          online={online}
          busy={job.busy}
          disabled={job.busy}
          autoFocus
          rows={3}
          ariaLabel="任务描述"
          placeholder="描述要完成的工作，或者直接开始…"
          commands={NEW_SESSION_COMMANDS}
          onCancel={cancel}
          onShortcutPicker={handleShortcutPicker}
          onSubmit={start}
          toolbar={({ openFilePicker }) => (
            <>
              <div className="new-session-controls">
                <Button
                  type="button"
                  variant="toolbar"
                  size="sm"
                  className="new-session-pill new-session-attach"
                  disabled={job.busy}
                  aria-label="添加图片或文件"
                  title={`添加图片或文件（≤${MAX_ATTACHMENT_LABEL}，也可粘贴或拖入）`}
                  onClick={openFilePicker}
                >
                  <Plus />
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button type="button" variant="toolbar" size="sm" className="new-session-pill" disabled={job.busy} aria-label="选择 Agent">
                      {selected && <AgentMark agent={selected.id} />}
                      <span>{selected?.label ?? "选择 Agent"}</span>
                      <ChevronDown data-icon="inline-end" className="new-session-caret" />
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
                  <Button type="button" variant="toolbar" size="sm" className="new-session-pill" aria-label="重新读取默认模型" title="Agent 尚未提供可预选的模型；点击重新读取" disabled={job.busy} onClick={() => setModelsRevision((value) => value + 1)}>
                    <SessionConfigIcon category="model" />
                    <span>默认模型</span>
                  </Button>
                )}
                {!!models?.models.length && (
                  <DropdownMenu open={modelMenuOpen} onOpenChange={setModelMenuOpen}>
                    <DropdownMenuTrigger asChild>
                      <Button type="button" variant="toolbar" size="sm" className="new-session-pill" disabled={job.busy} title={shownModel ? `模型：${shownModel.name}` : "模型"} aria-label="选择模型">
                        <SessionConfigIcon category="model" />
                        <span>{shownModel ? modelName(shownModel) : "默认模型"}</span>
                        <ChevronDown data-icon="inline-end" className="new-session-caret" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent side="top" align="start" sideOffset={8} collisionPadding={12} className="new-session-menu">
                      <DropdownMenuLabel>模型</DropdownMenuLabel>
                      <DropdownMenuRadioGroup value={shownModel?.value ?? ""} onValueChange={(value) => { setPicked({ store, agent, model: value }); sessionPreferences.remember(machine?.machineId, agent, { model: value }); }}>
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
                <NewSessionConfig options={options} disabled={job.busy} onChange={updateConfigOption} />
              </div>
              <Button type="submit" size="icon" className="send-button" disabled={!ready} aria-label="开始会话" title="开始 · Enter（Shift Enter 换行）">
                {job.busy ? <LoaderCircle className="animate-spin" /> : <ArrowUp />}
              </Button>
            </>
          )}
        />
        {/* Where the work happens sits under the box, as in Codex; the box holds who answers and how. */}
        <div className="new-session-place">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="toolbar" size="sm" className="new-session-pill" disabled={job.busy} title={cwd} aria-label="选择工作目录">
                <FolderOpen data-icon="inline-start" />
                <span>{place}</span>
                <ChevronDown data-icon="inline-end" className="new-session-caret" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="start" sideOffset={8} collisionPadding={12} className="new-session-menu">
              <DropdownMenuItem disabled={!machine?.home} onSelect={() => setCwd(undefined)}>
                <MessageSquarePlus data-icon="inline-start" />
                <span className="new-session-option"><span>快速会话</span><small>无需选择项目，在个人目录中开始</small></span>
                {quick && <Check className="ml-auto" />}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
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
                <FolderOpen data-icon="inline-start" />浏览电脑上的目录…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {git.value && (
            <Button
              type="button"
              variant="toolbar"
              size="sm"
              className="new-session-pill"
              data-active={worktree || undefined}
              aria-pressed={worktree}
              aria-label={worktree ? "独立 worktree" : "当前分支"}
              disabled={job.busy}
              title="基于当前 Git 仓库创建独立工作目录"
              onClick={() => setWorktree((value) => !value)}
            >
              <GitBranch data-icon="inline-start" />
              <span>{worktree ? "独立 worktree" : "当前分支"}</span>
            </Button>
          )}
        </div>
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
          <Files start={cwd} directoriesOnly onPick={(path) => { setCwd(path); setBrowse(false); composerRef.current?.focus(); }} />
        </Modal>
      )}
    </div>
  );
}
