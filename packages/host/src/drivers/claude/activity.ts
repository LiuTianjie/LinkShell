import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { SessionUpdate, ToolDetail, WorkflowAgentState, WorkflowPhase, WorkflowState } from "@linkshell/wire";
import { nestUnder } from "../nesting.js";
import { transcriptLine, TranscriptTail, type TranscriptLineResult } from "./transcript.js";
import { ClaudeChildIndex, ownedFile, readClaudeTeam, type ClaudeChild } from "./children.js";

type Json = Record<string, unknown>;
const object = (value: unknown): Json | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Json : undefined;
const string = (value: unknown) => typeof value === "string" ? value : undefined;
const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
const safeId = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9_-]+$/.test(value);
const json = (text: string): Json | undefined => { try { return object(JSON.parse(text)); } catch { return undefined; } };
const timestamp = (value: unknown) => typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) || undefined : undefined;
type Detail = Extract<ToolDetail, { type: "subagent" }>;
type Emit = (update: SessionUpdate, ts?: number) => void;

interface Worker {
  id: string;
  agentId?: string;
  index?: number;
  label: string;
  prompt?: string;
  phaseId?: string;
  model?: string;
  state: WorkflowAgentState;
  inferredFailure?: boolean;
  result?: string;
  tokens?: number;
  toolCalls?: number;
  durationMs?: number;
  startedAt?: number;
  endedAt?: number;
  hasTranscript?: boolean;
  published?: string;
}

interface ChildReader { tail: TranscriptTail; revision: number }
interface Teammate extends ClaudeChild { state: WorkflowAgentState; lastTs?: number; published?: string }

interface Workflow {
  call: string;
  taskId: string;
  runId?: string;
  name: string;
  description?: string;
  state: WorkflowState;
  startedAt?: number;
  endedAt?: number;
  tokens?: number;
  durationMs?: number;
  phases: Map<string, WorkflowPhase>;
  workers: Map<string, Worker>;
  journal?: TranscriptTail;
  finalStamp?: string;
  published?: string;
}

/**
 * Follows Claude's on-disk child transcripts even while the main transcript is
 * quiet. WorkflowOutput is the SDK contract; the journal and final artifact
 * are isolated here because they are Claude Code implementation details.
 * See docs/v2/claude-activity.md for the upstream formats and evidence.
 */
export class ClaudeActivity {
  private readonly workflows = new Map<string, Workflow>();
  private readonly launches = new Map<string, { name?: string; task?: string; ts?: number }>();
  private readonly children = new Map<string, ChildReader>();
  private readonly childIndex = new ClaudeChildIndex();
  private readonly teammates = new Map<string, Teammate>();
  private readonly seen = new Set<string>();
  private observer?: TranscriptTail;
  private timer?: ReturnType<typeof setInterval>;

  constructor(private readonly options: {
    configDir?: string;
    locate: () => string | undefined;
    desktop: () => boolean;
    onUpdate: Emit;
    onLine?: (raw: string) => void;
    onError?: (error: unknown) => void;
  }) {}

  /** Called during history import, then by an independent cursor in every mode. */
  observe(raw: string): void {
    this.options.onLine?.(raw);
    const line = json(raw);
    if (!line || line.isSidechain === true) return;
    const uuid = string(line.uuid);
    if (uuid && this.seen.has(uuid)) return;
    if (uuid) this.seen.add(uuid);
    this.childIndex.observe(raw);
    const result = object(line.toolUseResult ?? line.tool_use_result);
    const content = object(line.message)?.content;
    for (const block of Array.isArray(content) ? content : []) {
      const tool = object(block);
      if (tool?.type !== "tool_use" || tool.name !== "Workflow" || !string(tool.id)) continue;
      const input = object(tool.input);
      this.launches.set(String(tool.id), { name: string(input?.name), task: string(input?.description), ts: timestamp(line.timestamp) });
    }
    if (result && !result.error && string(result.taskId) && (result.status === "async_launched" || result.status === "remote_launched")) {
      const blocks = Array.isArray(content) ? content : [];
      const block = blocks.map(object).find((entry) => entry?.type === "tool_result" && !entry.is_error && string(entry.tool_use_id));
      const call = string(block?.tool_use_id);
      if (call && !this.workflows.has(call)) {
        const candidate = string(result.runId) ?? (string(result.transcriptDir) ? basename(string(result.transcriptDir)!) : undefined);
        const launch = this.launches.get(call);
        this.workflows.set(call, {
          call, taskId: string(result.taskId)!, runId: safeId(candidate) && candidate.startsWith("wf_") ? candidate : undefined,
          name: string(result.workflowName) ?? launch?.name ?? "工作流", description: launch?.task ?? string(result.summary), state: "running",
          startedAt: launch?.ts ?? timestamp(line.timestamp), phases: new Map(), workers: new Map(),
        });
      }
    }
    // Notifications persist in both current SDK and interactive CLI transcripts.
    const attachment = object(line.attachment);
    const texts = [string(attachment?.prompt), string(line.content), typeof content === "string" ? content : undefined,
      ...(Array.isArray(content) ? content.map((block) => string(object(block)?.text)) : [])];
    for (const text of texts) {
      if (!text?.trimStart().startsWith("<task-notification>")) continue;
      const call = /<tool-use-id>\s*([^<\s]+)\s*<\/tool-use-id>/.exec(text)?.[1];
      const task = /<task-id>\s*([^<\s]+)\s*<\/task-id>/.exec(text)?.[1];
      this.updateState(call, task, /<status>\s*([^<\s]+)\s*<\/status>/.exec(text)?.[1], timestamp(line.timestamp));
    }
    if (line.type === "system" && (line.subtype === "task_notification" || line.subtype === "task_updated")) {
      this.updateState(string(line.tool_use_id), string(line.task_id), line.status ?? object(line.patch)?.status, timestamp(line.timestamp));
    }
    if (line.type === "system" && line.subtype === "task_progress") {
      const run = [...this.workflows.values()].find((entry) => entry.call === line.tool_use_id || entry.taskId === line.task_id);
      const usage = object(line.usage);
      if (run) {
        run.tokens = number(usage?.total_tokens) ?? run.tokens;
        run.durationMs = number(usage?.duration_ms) ?? run.durationMs;
        this.readProgress(run, line.workflow_progress);
      }
    }
  }

  private updateState(call: string | undefined, task: string | undefined, value: unknown, ts?: number): void {
    const workflow = (call ? this.workflows.get(call) : undefined) ?? (task ? [...this.workflows.values()].find((entry) => entry.taskId === task) : undefined);
    const state = value === "killed" ? "stopped" : value;
    if (!workflow || !["running", "paused", "completed", "failed", "stopped"].includes(String(state))) return;
    workflow.state = state as WorkflowState;
    if (state !== "running" && state !== "paused") workflow.endedAt = ts ?? workflow.endedAt ?? Date.now();
    else workflow.endedAt = undefined;
  }

  followFrom(offset: number): void {
    this.observer = new TranscriptTail({ locate: this.options.locate, offset, onLine: (raw) => this.observe(raw) });
  }

  start(): void {
    this.timer ??= setInterval(() => {
      try { this.poll(); } catch (error) { this.options.onError?.(error); }
    }, 400);
    this.timer.unref?.();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  isRunning(call: string): boolean {
    if ([...this.teammates.values()].some((agent) => agent.call === call && active(agent.state))) return true;
    return [...this.workflows.values()].some((run) => run.call === call
      ? run.state === "running" || run.state === "paused" || [...run.workers.values()].some((worker) => active(worker.state))
      : [...run.workers.values()].some((worker) => worker.agentId && this.workerCall(run, worker) === call && active(worker.state)));
  }

  hasRunningTeammates(): boolean {
    return [...this.teammates.values()].some((agent) => active(agent.state));
  }

  lostHolder(): void {
    for (const agent of this.teammates.values()) {
      if (!active(agent.state)) continue;
      agent.state = "unknown";
      this.publishTeammate(agent);
    }
  }

  poll(): void {
    this.observer?.poll();
    const transcript = this.options.locate();
    if (!transcript) return;
    const sessionDir = transcript.replace(/\.jsonl$/, "");
    const dir = join(sessionDir, "subagents");
    for (const file of files(dir)) {
      if (!file.startsWith("agent-") || !file.endsWith(".jsonl")) continue;
      const path = join(dir, file);
      if (!ownedFile(sessionDir, path)) continue;
      const metaPath = path.replace(/\.jsonl$/, ".meta.json");
      const meta = ownedFile(sessionDir, metaPath) ? readJson(metaPath) : undefined;
      const linked = this.childIndex.children.get(file.slice(6, -6));
      const parent = linked?.call ?? string(meta?.toolUseId);
      if (!parent) continue;
      let teammate = this.teammates.get(parent);
      if (!teammate && linked?.teammate) {
        teammate = { ...linked, state: "running", lastTs: linked.ts };
        this.teammates.set(parent, teammate);
      }
      const agent = teammate;
      this.child(path, parent, () => this.options.desktop(), agent ? (line, parsed) => {
        if (!parsed.updates.length) return;
        agent.model ??= string(object(line.message)?.model);
        agent.lastTs = parsed.ts ?? agent.lastTs;
        // A teammate can receive another assignment after its previous turn ended.
        // Only the transcript's turn outcome proves completion, never message prose.
        agent.state = "running";
        for (const update of parsed.updates) {
          if (update.sessionUpdate !== "ls_turn" || update.state !== "ended") continue;
          agent.state = update.stopReason === "cancelled" ? "stopped" : update.stopReason === "end_turn" ? "completed" : "failed";
        }
        if (line.isApiErrorMessage === true) agent.state = "failed";
      } : undefined).tail.poll();
    }
    // The launch can precede the first child file. It is already running then.
    for (const linked of this.childIndex.children.values()) {
      if (!linked.teammate || this.teammates.has(linked.call)) continue;
      const agent: Teammate = { ...linked, state: "running", lastTs: linked.ts };
      this.teammates.set(linked.call, agent);
    }
    const teams = new Map<string, ReturnType<typeof readClaudeTeam>>();
    for (const agent of this.teammates.values()) {
      if (active(agent.state) && this.options.configDir && agent.teamName && agent.teammateId && agent.ts !== undefined) {
        if (!teams.has(agent.teamName)) teams.set(agent.teamName, readClaudeTeam(this.options.configDir, basename(sessionDir), agent.teamName));
        const team = teams.get(agent.teamName);
        // The lead can stay open (or be resumed via ACP) after its members exit.
        // An older roster may simply predate the spawn. Absence is not success.
        if (team && team.updatedAt > agent.ts && !team.members.has(agent.teammateId)) agent.state = "unknown";
        // Whole-team cleanup is distinct from a config file mid-rewrite. Allow
        // startup and buffered transcript writes to settle before losing liveness.
        if (team === null && Date.now() - (agent.lastTs ?? agent.ts) > 5_000) agent.state = "unknown";
      }
      this.publishTeammate(agent);
    }
    for (const workflow of this.workflows.values()) this.pollWorkflow(sessionDir, workflow);
  }

  private publishTeammate(agent: Teammate): void {
    const detail: Detail = { type: "subagent", action: "spawn", name: agent.name, task: agent.task,
      agentType: agent.agentType, model: agent.model, state: agent.state };
    const snapshot = JSON.stringify(detail);
    if (snapshot === agent.published) return;
    const running = active(agent.state);
    this.options.onUpdate({ sessionUpdate: "tool_call_update", toolCallId: agent.call,
      status: running ? "in_progress" : agent.state === "failed" ? "failed" : "completed", detail,
      // Clear the old host's mistakenly saved "Spawned successfully" result.
      content: [] }, agent.lastTs);
    this.options.onUpdate({ sessionUpdate: "ls_turn", parentToolCallId: agent.call, state: running ? "started" : "ended",
      stopReason: running ? undefined : agent.state === "stopped" ? "cancelled" : agent.state === "failed" ? "error" : "end_turn" }, agent.lastTs);
    agent.published = snapshot;
  }

  private child(path: string, parent: string, enabled: () => boolean, metadata?: (line: Json, parsed: TranscriptLineResult) => void): ChildReader {
    let reader = this.children.get(path);
    if (!reader) {
      const hidden = new Set<string>();
      const seen = new Set<string>();
      const tail = new TranscriptTail({ locate: () => path, offset: 0, onLine: (raw) => {
        const parsed = transcriptLine(raw, { sidechain: true, hidden, seen });
        const line = metadata ? json(raw) : undefined;
        if (line) metadata?.(line, parsed);
        // Lifecycle still follows disk while ACP owns the conversation, but
        // the child text must come from only one stream across handoff.
        if (!enabled()) return;
        if (parsed.updates.length) reader!.revision += 1;
        for (const update of parsed.updates) {
          const nested = "parentToolCallId" in update && update.parentToolCallId ? update : nestUnder(update, parent);
          if (nested) this.options.onUpdate(nested, parsed.ts);
        }
      } });
      reader = { tail, revision: 0 };
      this.children.set(path, reader);
    }
    return reader;
  }

  private pollWorkflow(sessionDir: string, run: Workflow): void {
    const emit = this.options.onUpdate;
    const runDir = run.runId ? join(sessionDir, "subagents", "workflows", run.runId) : undefined;
    if (runDir) {
      const path = join(runDir, "journal.jsonl");
      if (ownedFile(sessionDir, path)) {
        run.journal ??= new TranscriptTail({ locate: () => path, offset: 0, onLine: (raw) => {
          const event = json(raw);
          if (!event || !safeId(event.agentId) || (event.type !== "started" && event.type !== "result")) return;
          let worker = run.workers.get(event.agentId);
          if (!worker) {
            worker = { id: event.agentId, agentId: event.agentId, label: string(event.label) ?? event.agentId, state: "running", startedAt: timestamp(event.ts) };
            run.workers.set(worker.id, worker);
          }
          if (event.type === "result") {
            // null can mean either cancellation or an API failure. Only an explicit
            // agent status can distinguish them; neither is a successful result.
            if (worker.inferredFailure && event.result != null) { worker.state = "completed"; worker.inferredFailure = false; }
            else if (worker.state !== "failed" && worker.state !== "stopped") worker.state = event.result == null ? "unknown" : "completed";
            worker.result = typeof event.result === "string" ? event.result : event.result == null ? undefined : JSON.stringify(event.result);
            worker.endedAt = timestamp(event.ts);
          }
        } });
        run.journal.poll();
      }
      this.readFinal(sessionDir, run);
    }
    const terminal = run.state !== "running" && run.state !== "paused";
    let childChanged = false;
    // Announce parents before children, and finish them only after their last output.
    if (!run.published) {
      emit({ sessionUpdate: "tool_call", toolCallId: run.call, title: `Workflow: ${run.name}`, kind: "other", status: "in_progress", detail: this.detail(run) }, run.startedAt);
    }
    for (const worker of run.workers.values()) {
      // Live progress may precede Claude assigning an id. It can be shown in the
      // roster, but has no transcript address until the provider supplies one.
      if (!worker.agentId) continue;
      const call = this.workerCall(run, worker);
      const describe = (): Detail => ({ type: "subagent", action: "spawn", agentType: run.phases.get(worker.phaseId ?? "")?.title ?? "工作流 Agent", task: worker.prompt ?? worker.label, model: worker.model, state: worker.state });
      if (!worker.published) emit({ sessionUpdate: "tool_call", toolCallId: call, parentToolCallId: run.call, title: worker.label, kind: "other", status: "in_progress", detail: describe() }, worker.startedAt ?? run.startedAt);
      const childPath = runDir ? join(runDir, `agent-${worker.agentId}.jsonl`) : undefined;
      let revision = 0;
      if (childPath && ownedFile(sessionDir, childPath)) {
        const child = this.child(childPath, call, () => true, (line) => {
          worker.hasTranscript = true;
          const message = object(line.message);
          worker.startedAt ??= timestamp(line.timestamp);
          worker.model ??= string(message?.model);
          if (line.isApiErrorMessage === true && active(worker.state)) {
            worker.state = "failed";
            worker.inferredFailure = true;
            worker.endedAt = timestamp(line.timestamp);
          } else if (worker.inferredFailure && line.isApiErrorMessage !== true && (line.type === "assistant" || line.type === "user")) {
            // A later successful retry replaces an error at the previous tail.
            worker.state = "running";
            worker.inferredFailure = false;
            worker.endedAt = undefined;
          }
          if (line.type !== "user" || line.isMeta === true) return;
          const content = message?.content;
          const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((block) => string(object(block)?.text) ?? "").join("\n") : "";
          if (text.trim()) {
            worker.prompt ??= text.trim();
            if (worker.label === worker.agentId) worker.label = text.trim().slice(0, 2000);
          }
        });
        child.tail.poll();
        revision = child.revision;
      }
      if (runDir && !worker.model) {
        const metaPath = join(runDir, `agent-${worker.agentId}.meta.json`);
        if (ownedFile(sessionDir, metaPath)) worker.model = string(readJson(metaPath)?.model);
      }
      const detail = describe();
      // A stopped run can still have live processes. Keep watching each worker
      // until its own progress, journal or transcript proves its outcome.
      const status = worker.state === "failed" ? "failed" : active(worker.state) || worker.state === "pending" ? "in_progress" : "completed";
      const snapshot = JSON.stringify([detail, status, worker.result, revision]);
      if (snapshot !== worker.published) {
        childChanged = true;
        emit({ sessionUpdate: "tool_call_update", toolCallId: call, parentToolCallId: run.call, status, detail,
          content: worker.result ? [{ type: "content", content: { type: "text", text: worker.result } }] : undefined }, worker.endedAt ?? run.endedAt);
        emit({ sessionUpdate: "ls_turn", state: status === "in_progress" ? "started" : "ended", parentToolCallId: call,
          stopReason: status === "in_progress" ? undefined : worker.state === "stopped" ? "cancelled" : status === "failed" ? "error" : "end_turn" }, worker.endedAt ?? run.endedAt);
        worker.published = snapshot;
      }
    }
    const detail = this.detail(run);
    const snapshot = JSON.stringify(detail);
    if (snapshot !== run.published || (terminal && childChanged)) {
      emit({ sessionUpdate: "tool_call_update", toolCallId: run.call, detail, status: !terminal ? "in_progress" : run.state === "failed" ? "failed" : "completed" }, run.endedAt);
      emit({ sessionUpdate: "ls_turn", parentToolCallId: run.call, state: terminal ? "ended" : "started", stopReason: terminal ? run.state === "completed" ? "end_turn" : run.state === "stopped" ? "cancelled" : "error" : undefined }, run.endedAt ?? run.startedAt);
      run.published = snapshot;
    }
  }

  private detail(run: Workflow): Detail {
    return { type: "subagent", action: "spawn", agentType: "工作流", task: run.description ?? run.name,
      workflow: { runId: run.runId, name: run.name, state: run.state, started: [...run.workers.values()].filter((worker) => worker.state !== "pending").length,
        completed: [...run.workers.values()].filter((worker) => worker.state === "completed").length,
        tokens: run.tokens, durationMs: run.durationMs, startedAt: run.startedAt, endedAt: run.endedAt,
        phases: [...run.phases.values()].sort((a, b) => a.order - b.order),
        agents: [...run.workers.values()].map((worker) => ({ id: worker.id, title: worker.label, state: worker.state,
          toolCallId: worker.hasTranscript ? this.workerCall(run, worker) : undefined,
          phaseId: worker.phaseId, model: worker.model, tokens: worker.tokens, toolCalls: worker.toolCalls,
          durationMs: worker.durationMs, startedAt: worker.startedAt, endedAt: worker.endedAt, result: worker.result?.slice(0, 2000) })),
      } };
  }

  private workerCall(run: Workflow, worker: Worker): string { return `workflow:${run.runId ?? run.call}:${worker.agentId}`; }

  private phase(run: Workflow, index: number | undefined, title: string | undefined): string | undefined {
    if (index === undefined && !title) return undefined;
    const named = title ? [...run.phases.values()].filter((phase) => phase.title === title) : [];
    const id = index !== undefined ? `phase:${index}` : named.length === 1 ? named[0]!.id : `title:${title}`;
    if (index !== undefined && title && run.phases.has(`title:${title}`)) {
      run.phases.delete(`title:${title}`);
      for (const worker of run.workers.values()) if (worker.phaseId === `title:${title}`) worker.phaseId = id;
    }
    const old = run.phases.get(id);
    run.phases.set(id, { id, title: title ?? old?.title ?? `阶段 ${index}`, order: index ?? old?.order ?? run.phases.size + 1 });
    return id;
  }

  /** This undeclared Claude field also appears as workflowProgress in the final artifact. */
  private readProgress(run: Workflow, value: unknown): void {
    if (!Array.isArray(value)) return;
    for (const entry of value) {
      const row = object(entry);
      if (!row) continue;
      if (row.type === "workflow_phase") { this.phase(run, number(row.index), string(row.title)); continue; }
      if (row.type !== "workflow_agent") continue;
      const agentId = safeId(row.agentId) ? row.agentId : undefined;
      const index = number(row.index);
      if (!agentId && index === undefined) continue;
      const provisional = index === undefined ? undefined : [...run.workers.values()].find((worker) => worker.index === index);
      const id = agentId ?? provisional?.id ?? `pending:${index}`;
      const existing = run.workers.get(id);
      const worker: Worker = existing ?? provisional ?? { id, label: agentId ?? `Agent ${(index ?? 0) + 1}`, state: "pending" };
      if (provisional && provisional.id !== id) {
        run.workers.delete(provisional.id);
        if (existing) {
          existing.phaseId ??= provisional.phaseId;
          existing.model ??= provisional.model;
        }
      }
      worker.id = id;
      worker.agentId = agentId ?? worker.agentId;
      worker.index = index ?? worker.index;
      worker.label = string(row.label) ?? worker.label;
      const reported = agentState(row.state);
      if (reported) { worker.state = reported; worker.inferredFailure = false; }
      worker.phaseId = this.phase(run, number(row.phaseIndex), string(row.phaseTitle)) ?? worker.phaseId;
      worker.model = string(row.model) ?? worker.model;
      worker.tokens = number(row.tokens) ?? worker.tokens;
      worker.toolCalls = number(row.toolCalls) ?? worker.toolCalls;
      worker.durationMs = number(row.durationMs) ?? worker.durationMs;
      worker.result = string(row.resultPreview) ?? worker.result;
      worker.startedAt = number(row.startedAt) ?? worker.startedAt;
      if (!active(worker.state) && worker.state !== "pending" && worker.startedAt !== undefined && worker.durationMs !== undefined) worker.endedAt = worker.startedAt + worker.durationMs;
      run.workers.set(id, worker);
    }
  }

  private readFinal(sessionDir: string, run: Workflow): void {
    const path = join(sessionDir, "workflows", `${run.runId}.json`);
    if (!ownedFile(sessionDir, path)) return;
    const stat = statSync(path);
    const stamp = `${stat.size}:${stat.mtimeMs}`;
    if (run.finalStamp === stamp) return;
    const final = readJson(path);
    if (!final || final.runId !== run.runId) return;
    run.finalStamp = stamp;
    run.name = string(final.workflowName) ?? run.name;
    run.description = string(final.summary) ?? run.description;
    run.startedAt = number(final.startTime) ?? run.startedAt;
    run.tokens = number(final.totalTokens);
    run.durationMs = number(final.durationMs);
    const endedAt = timestamp(final.timestamp) ?? (run.startedAt !== undefined && run.durationMs !== undefined ? run.startedAt + run.durationMs : stat.mtimeMs);
    this.updateState(run.call, undefined, final.status, endedAt);
    this.readProgress(run, final.workflowProgress);
  }
}

function active(state: WorkflowAgentState): boolean { return state === "running" || state === "paused"; }

function agentState(value: unknown): WorkflowAgentState | undefined {
  switch (value) {
    case "pending": case "queued": return "pending";
    case "running": case "active": return "running";
    case "paused": case "blocked": return "paused";
    case "done": case "completed": case "complete": return "completed";
    case "failed": case "error": return "failed";
    case "stopped": case "killed": case "cancelled": return "stopped";
    default: return undefined;
  }
}

function files(path: string): string[] {
  try { return readdirSync(path); } catch { return []; }
}

function readJson(path: string): Json | undefined {
  try { return statSync(path).size <= 16 * 1024 * 1024 ? json(readFileSync(path, "utf8")) : undefined; } catch { return undefined; }
}
