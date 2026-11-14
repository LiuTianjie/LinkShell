import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ClientState } from "@linkshell/client-core";
import type { AgentInfo, GitInfo, ProjectSummary } from "@linkshell/wire";
import {
  configToCreate,
  creationOptions,
  draftKeyFor,
  finishComposerSend,
  modelToCreate,
  reportDesktopError,
  routerStore,
  sessionPreferences,
  useAgentModels,
  useComposerDraft,
  useT,
  type PastedTextBlock,
} from "@/core";
import { AgentMark, DesktopIcon } from "@/icons";
import {
  ErrorBoundary,
  Menu,
  MenuLabel,
  MenuRadioGroup,
  MenuRadioItem,
  Tooltip,
} from "@/primitives";
import { ApprovalCard } from "./ApprovalQuestionCards";
import { ComposerBox } from "./ComposerBox";
import { DirectoryPickerDialog } from "./DirectoryPickerDialog";
import {
  NEW_SESSION_COMMANDS,
  attachmentsNeedUpload,
  basenameOfPath,
  buildPromptContentBlocks,
  configCategoryIcon,
  configOptionDisplayLabel,
  configValueDisplayName,
  formatModelOptionLabel,
  parseSlashCommandInput,
  revokeAttachmentPreviews,
  shortenHomePath,
  useClientSelector,
  useSessionConnection,
  useSessionCopy,
  type ComposerAttachment,
} from "./session-helpers";

const EMPTY_PROJECTS: ProjectSummary[] = [];
const EMPTY_INTERACTIONS: ClientState["interactions"] = {};

function isUsableAgent(entry: AgentInfo): boolean {
  return (
    entry.installed &&
    !entry.problem &&
    entry.auth?.state !== "missing" &&
    entry.tier !== "terminal"
  );
}

export interface NewSessionWorkspaceProps {
  computerKey: string;
  initialCwd?: string;
}

export function NewSessionWorkspace({
  computerKey,
  initialCwd,
}: NewSessionWorkspaceProps) {
  const t = useT();
  const copy = useSessionCopy();
  const connection = useSessionConnection(computerKey);

  const online = useClientSelector(connection, (s) => s.status === "online", false);
  const machine = useClientSelector(connection, (s) => s.machine, undefined);
  const projects = useClientSelector(connection, (s) => s.projects, EMPTY_PROJECTS);
  const interactionsMap = useClientSelector(
    connection,
    (s) => s.interactions,
    EMPTY_INTERACTIONS,
  );

  const remembered = useMemo(
    () => sessionPreferences.read(machine?.machineId),
    [machine?.machineId],
  );

  const [agentOverride, setAgentOverride] = useState<{
    machineId?: string;
    agent: string;
  }>();

  const preferredAgentId =
    agentOverride?.machineId === machine?.machineId
      ? agentOverride?.agent ?? remembered.agent
      : remembered.agent;

  const selectedAgent =
    machine?.agents.find((a) => a.id === preferredAgentId && isUsableAgent(a)) ??
    machine?.agents.find(isUsableAgent) ??
    machine?.agents[0];

  const agentId = selectedAgent?.id ?? "";
  const usable = Boolean(selectedAgent && isUsableAgent(selectedAgent));

  const selectAgent = (nextAgentId: string) => {
    setAgentOverride({ machineId: machine?.machineId, agent: nextAgentId });
    sessionPreferences.remember(machine?.machineId, nextAgentId);
  };

  const [explicitCwd, setExplicitCwd] = useState<string | undefined>(initialCwd);
  useEffect(() => {
    if (initialCwd !== undefined) {
      setExplicitCwd(initialCwd);
    }
  }, [initialCwd]);

  const cwd = explicitCwd ?? machine?.home ?? projects[0]?.cwd ?? "";

  const [worktree, setWorktree] = useState(false);
  const [dirDialogOpen, setDirDialogOpen] = useState(false);
  const [gitInfo, setGitInfo] = useState<GitInfo | undefined>();

  useEffect(() => {
    setWorktree(false);
  }, [cwd]);

  useEffect(() => {
    const trimmed = cwd.trim();
    if (!connection || !online || !trimmed) {
      setGitInfo(undefined);
      return;
    }
    let alive = true;
    void connection.store
      .getState()
      .gitInfo(trimmed)
      .then((info) => {
        if (alive) setGitInfo(info);
      })
      .catch(() => {
        if (alive) setGitInfo(undefined);
      });
    return () => {
      alive = false;
    };
  }, [connection, cwd, online]);

  const [pickedModelState, setPickedModelState] = useState<{
    agent: string;
    model: string;
  }>();
  const [pickedConfigState, setPickedConfigState] = useState<{
    key: string;
    values: Record<string, string>;
  }>();
  const [modelsRevision, setModelsRevision] = useState(0);

  const pickedModel =
    pickedModelState?.agent === agentId
      ? pickedModelState.model
      : remembered.agents[agentId]?.model;

  const listedModels = useAgentModels(
    connection?.store,
    agentId,
    cwd,
    online && usable,
    pickedModel,
    modelsRevision,
  );

  const validatedModel = modelToCreate(listedModels, pickedModel);
  const shownModel = listedModels?.models.find(
    (entry) => entry.value === (validatedModel ?? listedModels.current),
  );

  const configScopeKey = JSON.stringify([agentId, cwd.trim()]);
  const rememberedConfig = remembered.agents[agentId]?.config;
  const effectivePickedConfig = useMemo(
    () => ({
      ...rememberedConfig,
      ...(pickedConfigState?.key === configScopeKey ? pickedConfigState.values : {}),
    }),
    [configScopeKey, pickedConfigState, rememberedConfig],
  );

  const options = useMemo(
    () => creationOptions(listedModels?.config, effectivePickedConfig),
    [effectivePickedConfig, listedModels?.config],
  );

  const modeOption = useMemo(
    () => options.find((opt) => opt.category === "mode"),
    [options],
  );

  const updateConfigOption = useCallback(
    (optionId: string, value: string) => {
      setPickedConfigState({
        key: configScopeKey,
        values: { ...effectivePickedConfig, [optionId]: value },
      });
      sessionPreferences.remember(machine?.machineId, agentId, {
        config: { [optionId]: value },
      });
    },
    [agentId, configScopeKey, effectivePickedConfig, machine?.machineId],
  );

  const handleCycleMode = useCallback(() => {
    if (!modeOption || modeOption.values.length < 2) return;
    const currentIdx = modeOption.values.findIndex((v) => v.value === modeOption.current);
    const next = modeOption.values[(currentIdx + 1) % modeOption.values.length];
    if (next) updateConfigOption(modeOption.id, next.value);
  }, [modeOption, updateConfigOption]);

  // Composer draft & attachments
  const draftKey = draftKeyFor(computerKey, "new");
  const { text, setText, clearSubmitted } = useComposerDraft(draftKey);
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [pastedBlocks, setPastedBlocks] = useState<PastedTextBlock[]>([]);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | undefined>();

  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  useEffect(
    () => () => {
      revokeAttachmentPreviews(attachmentsRef.current);
    },
    [],
  );

  const preSessionInteractions = agentId ? (interactionsMap[agentId] ?? []) : [];

  /**
   * CRITICAL E2E & UX INVARIANT (`apps/windows/scripts/model-ui-e2e.mjs`):
   * `button[aria-label="开始会话"]` MUST be enabled even when `textarea[aria-label="任务描述"]`
   * is empty! When prompt + attachments + pastedBlocks are empty, `createSession` is called with
   * `prompt: undefined` (omitted) and ZERO `sessions.send` / `sessions.prompt` calls!
   */
  const canStartSession =
    Boolean(connection) &&
    online &&
    usable &&
    Boolean(cwd.trim()) &&
    !creating;

  const handleStartSession = async () => {
    if (!connection || !canStartSession) return;
    setCreateError(undefined);

    const parsedCmd =
      attachments.length === 0 && pastedBlocks.length === 0
        ? parseSlashCommandInput(text)
        : null;
    if (
      parsedCmd &&
      (parsedCmd.name === "clear" || parsedCmd.name === "reset" || parsedCmd.name === "new") &&
      !parsedCmd.rest
    ) {
      clearSubmitted(text);
      return;
    }

    const trimmedCwd = cwd.trim();
    const useWorktree = worktree && Boolean(gitInfo);
    const submittedText = text;
    const currentAttachments = attachments;
    const currentPasted = pastedBlocks;
    const hasPromptContent =
      Boolean(submittedText.trim()) ||
      currentAttachments.length > 0 ||
      currentPasted.length > 0;

    setCreating(true);
    try {
      const configPayload = configToCreate(listedModels?.config, effectivePickedConfig);

      // Two-step creation when starting in a new git worktree AND non-image attachments need uploading
      // so uploaded files land inside the newly created worktree rather than polluting the source checkout.
      if (useWorktree && hasPromptContent && attachmentsNeedUpload(currentAttachments)) {
        const created = await connection.store.getState().createSession({
          agent: agentId,
          cwd: trimmedCwd,
          worktree: true,
          model: validatedModel,
          config: configPayload,
        });
        const uploadDir = `${created.cwd.replace(/[\\/]+$/, "")}/.linkshell/uploads`;
        const blocks = await buildPromptContentBlocks({
          text: submittedText,
          pastedBlocks: currentPasted,
          attachments: currentAttachments,
          cwd: created.cwd,
          uploadFile: ({ name, data }) =>
            connection.link.call("fs.upload", { dir: uploadDir, name, data }),
        });
        if (blocks.length > 0) {
          const delivery = connection.store.getState().send(created.id, blocks);
          await finishComposerSend(delivery, () => {
            clearSubmitted(submittedText);
            revokeAttachmentPreviews(currentAttachments);
            setAttachments([]);
            setPastedBlocks([]);
          });
        }
        routerStore.getState().openSession(computerKey, created.id);
        return;
      }

      let promptBlocks = undefined;
      if (hasPromptContent) {
        const uploadDir = `${trimmedCwd.replace(/[\\/]+$/, "")}/.linkshell/uploads`;
        const built = await buildPromptContentBlocks({
          text: submittedText,
          pastedBlocks: currentPasted,
          attachments: currentAttachments,
          cwd: trimmedCwd,
          uploadFile: ({ name, data }) =>
            connection.link.call("fs.upload", { dir: uploadDir, name, data }),
        });
        if (built.length > 0) promptBlocks = built;
      }

      const created = await connection.store.getState().createSession({
        agent: agentId,
        cwd: trimmedCwd,
        ...(promptBlocks ? { prompt: promptBlocks } : {}),
        ...(useWorktree ? { worktree: true } : {}),
        ...(validatedModel ? { model: validatedModel } : {}),
        ...(configPayload ? { config: configPayload } : {}),
      });

      if (hasPromptContent) {
        clearSubmitted(submittedText);
        revokeAttachmentPreviews(currentAttachments);
        setAttachments([]);
        setPastedBlocks([]);
      }

      routerStore.getState().openSession(computerKey, created.id);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      setCreateError(msg);
      reportDesktopError(error);
    } finally {
      setCreating(false);
    }
  };

  const recentProjects = useMemo(() => projects.slice(0, 6), [projects]);

  return (
    <div className="ls-new-session">
      <ErrorBoundary resetKeys={[computerKey, cwd]}>
      <div className="ls-new-session-stage">
        <header className="ls-new-session-hero">
          <h1 className="ls-new-session-heading">{copy.newSessionHeading}</h1>
          <p className="ls-new-session-subheading">{copy.newSessionSubheading}</p>
        </header>

        {/* Agent selector cards */}
        {machine && machine.agents.length > 0 ? (
          <div className="ls-agent-grid" role="radiogroup" aria-label={t("desktop.composer.agent")}>
            {machine.agents.map((entry) => {
              const entryUsable = isUsableAgent(entry);
              const isSelected = entry.id === agentId;
              const statusNote = !entry.installed
                ? copy.agentUnavailable
                : entry.auth?.state === "missing"
                  ? entry.auth.hint || copy.agentUnavailable
                  : entry.problem || entry.version || entry.tier;
              return (
                <button
                  key={entry.id}
                  type="button"
                  role="radio"
                  aria-checked={isSelected}
                  disabled={!entryUsable}
                  className="ls-agent-card"
                  data-selected={isSelected}
                  onClick={() => selectAgent(entry.id)}
                >
                  <AgentMark agent={entry.id} size="md" />
                  <span style={{ minWidth: 0 }}>
                    <span className="ls-agent-card-name" style={{ display: "block" }}>
                      {entry.label}
                    </span>
                    <span className="ls-agent-card-meta" style={{ display: "block" }}>
                      {statusNote}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        ) : (
          <div style={{ fontSize: 13, color: "var(--ls-fg-3)" }}>
            {online ? copy.noAgentsInstalled : copy.connectingComputer}
          </div>
        )}

        {/* Pre-session ACP auth / elicitation cards */}
        {connection &&
          preSessionInteractions.map((interaction) => (
            <ApprovalCard
              key={interaction.requestId}
              permission={interaction}
              connection={connection}
              agent={agentId}
              cwd={cwd}
            />
          ))}

        {/* Working directory & Git worktree bar */}
        <div className="ls-new-session-target-row">
          <button
            type="button"
            className="ls-target-pill"
            onClick={() => setDirDialogOpen(true)}
            title={cwd}
          >
            <DesktopIcon name="folder-open" size="xs" />
            <span className="ls-target-pill-path">
              {shortenHomePath(cwd, machine?.home) || copy.selectDirectory}
            </span>
            <DesktopIcon name="chevron-down" size="xs" />
          </button>

          {gitInfo && (
            <>
              <span className="ls-session-branch-chip" title={gitInfo.root}>
                <DesktopIcon name="git-branch" size="xs" />
                <span>{gitInfo.branch ?? gitInfo.head ?? "HEAD"}</span>
              </span>

              <Tooltip
                content={gitInfo.dirty ? copy.worktreeHintDirty : copy.worktreeHintClean}
              >
                <button
                  type="button"
                  className="ls-target-pill"
                  data-active={worktree}
                  aria-pressed={worktree}
                  onClick={() => setWorktree((v) => !v)}
                >
                  <DesktopIcon name="worktree" size="xs" />
                  <span>{t("desktop.composer.startInWorktree")}</span>
                </button>
              </Tooltip>
            </>
          )}
        </div>

        {/* Recent projects quick pills */}
        {recentProjects.length > 0 && (
          <div className="ls-new-session-target-row" aria-label={copy.recentProjects}>
            {recentProjects.map((proj) => {
              const active = proj.cwd === cwd;
              return (
                <button
                  key={proj.cwd}
                  type="button"
                  className="ls-composer-chip"
                  style={
                    active
                      ? {
                          color: "var(--ls-fg)",
                          borderColor: "var(--ls-border-strong)",
                          background: "var(--ls-fill-strong)",
                        }
                      : undefined
                  }
                  onClick={() => setExplicitCwd(proj.cwd)}
                  title={proj.cwd}
                >
                  <DesktopIcon name="folder" size="xs" />
                  <span>{proj.name || basenameOfPath(proj.cwd)}</span>
                </button>
              );
            })}
          </div>
        )}

        {/* Codex-grade Composer Stage */}
        <ComposerBox
          value={text}
          onChange={setText}
          placeholder={copy.composerPlaceholder}
          textareaAriaLabel={copy.taskLabel}
          disabled={!online || !usable || creating}
          connection={connection}
          cwd={cwd}
          commands={NEW_SESSION_COMMANDS}
          attachments={attachments}
          onAddAttachments={(added) => setAttachments((prev) => [...prev, ...added])}
          onRemoveAttachment={(id) =>
            setAttachments((prev) => {
              const found = prev.find((a) => a.id === id);
              if (found) revokeAttachmentPreviews([found]);
              return prev.filter((a) => a.id !== id);
            })
          }
          pastedBlocks={pastedBlocks}
          onAddPastedBlock={(block) => setPastedBlocks((prev) => [...prev, block])}
          onExpandPastedBlock={(id) => {
            const found = pastedBlocks.find((b) => b.id === id);
            if (!found) return;
            setPastedBlocks((prev) => prev.filter((b) => b.id !== id));
            setText((curr) => (curr ? `${curr}\n${found.text}` : found.text));
          }}
          onRemovePastedBlock={(id) =>
            setPastedBlocks((prev) => prev.filter((b) => b.id !== id))
          }
          onSubmit={() => void handleStartSession()}
          onCycleMode={modeOption ? handleCycleMode : undefined}
          autoFocus
          leftControls={
            <>
              {/* Mandatory E2E Model Picker:
                  button[aria-label="选择模型"] -> .new-session-menu[data-state="open"] [role="menuitemradio"] -> .new-session-option > span */}
              {online && usable && !listedModels && (
                <span className="ls-composer-chip" role="status">
                  <DesktopIcon name="spinner" size="xs" />
                  <span>{copy.loadingModels}</span>
                </span>
              )}

              {listedModels && listedModels.models.length === 0 && !listedModels.error && (
                <button
                  type="button"
                  className="ls-composer-chip"
                  disabled={creating}
                  title={copy.refreshModels}
                  onClick={() => setModelsRevision((v) => v + 1)}
                >
                  <DesktopIcon name="sparkles" size="xs" />
                  <span>{copy.defaultModel}</span>
                </button>
              )}

              {Boolean(listedModels && listedModels.models.length > 0) && (
                <Menu
                  className="new-session-menu"
                  placement="top-start"
                  trigger={
                    <button
                      type="button"
                      className="ls-composer-chip"
                      aria-label="选择模型"
                      disabled={creating}
                    >
                      {agentId ? (
                        <AgentMark agent={agentId} size="xs" />
                      ) : (
                        <DesktopIcon name="sparkles" size="xs" />
                      )}
                      <span>
                        {shownModel ? formatModelOptionLabel(shownModel) : copy.defaultModel}
                      </span>
                      <DesktopIcon name="chevron-down" size="xs" />
                    </button>
                  }
                >
                  <MenuLabel>{t("desktop.composer.model")}</MenuLabel>
                  <MenuRadioGroup
                    value={shownModel?.value ?? ""}
                    onValueChange={(value) => {
                      setPickedModelState({ agent: agentId, model: value });
                      sessionPreferences.remember(machine?.machineId, agentId, {
                        model: value,
                      });
                    }}
                  >
                    {listedModels!.models.map((entry) => {
                      const label = formatModelOptionLabel(entry);
                      const note = [
                        entry.value === listedModels!.current && !label.startsWith("默认")
                          ? "默认"
                          : undefined,
                        entry.description,
                      ]
                        .filter(Boolean)
                        .join(" · ");
                      return (
                        <MenuRadioItem key={entry.value} value={entry.value}>
                          <span className="new-session-option ls-composer-chip-option">
                            <span>{label}</span>
                            {note && <small className="ls-composer-chip-desc">{note}</small>}
                          </span>
                        </MenuRadioItem>
                      );
                    })}
                  </MenuRadioGroup>
                </Menu>
              )}

              {/* Pre-session Mode & Reasoning Effort pickers */}
              {options.map((option) => (
                <Menu
                  key={option.id}
                  className="new-session-menu"
                  placement="top-start"
                  trigger={
                    <button
                      type="button"
                      className="ls-composer-chip"
                      data-category={option.category}
                      disabled={creating}
                      aria-label={option.name}
                    >
                      <DesktopIcon
                        name={configCategoryIcon(option.category, option.current)}
                        size="xs"
                      />
                      <span>{configOptionDisplayLabel(option)}</span>
                      <DesktopIcon name="chevron-down" size="xs" />
                    </button>
                  }
                >
                  <MenuRadioGroup
                    value={option.current}
                    onValueChange={(val) => updateConfigOption(option.id, val)}
                  >
                    {option.values.map((entry) => (
                      <MenuRadioItem key={entry.value} value={entry.value}>
                        <span className="new-session-option ls-composer-chip-option">
                          <span>{configValueDisplayName(option, entry)}</span>
                          {entry.description && (
                            <small className="ls-composer-chip-desc">{entry.description}</small>
                          )}
                        </span>
                      </MenuRadioItem>
                    ))}
                  </MenuRadioGroup>
                </Menu>
              ))}
            </>
          }
          rightControls={
            <Tooltip content={copy.startSessionLabel}>
              <button
                type="button"
                className="ls-composer-send-btn"
                aria-label="开始会话"
                disabled={!canStartSession}
                onClick={() => void handleStartSession()}
              >
                {creating ? (
                  <DesktopIcon name="spinner" size="sm" />
                ) : (
                  <DesktopIcon name="arrow-up" size="sm" />
                )}
              </button>
            </Tooltip>
          }
        />

        {listedModels?.error && (
          <div style={{ fontSize: 12, color: "var(--ls-danger)" }} role="alert">
            {listedModels.error}
          </div>
        )}

        {createError && (
          <div style={{ fontSize: 12, color: "var(--ls-danger)" }} role="alert">
            {createError}
          </div>
        )}
      </div>
      </ErrorBoundary>

      <DirectoryPickerDialog
        open={dirDialogOpen}
        onOpenChange={setDirDialogOpen}
        connection={connection}
        initialPath={cwd}
        onSelect={(pickedPath) => setExplicitCwd(pickedPath)}
      />
    </div>
  );
}
