import { constants, openSync, closeSync, fstatSync, readSync, realpathSync } from "node:fs";
import type { BackgroundTask } from "@linkshell/wire";
import { outputRange } from "../../task-output.js";

type Row = Record<string, unknown>;
const obj = (v: unknown): Row => v && typeof v === "object" ? v as Row : {};
const str = (v: unknown): string | undefined => typeof v === "string" ? v : undefined;
const tag = (text: string, name: string) => new RegExp(`<${name}>\\s*([\\s\\S]*?)\\s*</${name}>`).exec(text)?.[1];

/** Shell tasks are separate from Agent/Workflow runs, even when Claude repeats their notifications. */
export class ClaudeTasks {
  readonly records = new Map<string, BackgroundTask>();
  private launches = new Map<string, { kind: "shell" | "monitor"; title: string; command?: string; ts: number }>();
  private paths = new Map<string, string>();
  private pending = new Map<string, { text: string; ts: number }>();
  constructor(private readonly emit: (task: BackgroundTask) => void) {}

  observe(raw: string): void {
    let line: Row;
    try { line = obj(JSON.parse(raw)); } catch { return; }
    if (line.isSidechain) return;
    const ts = typeof line.timestamp === "number" ? line.timestamp : Date.parse(String(line.timestamp)) || Date.now();
    const content = obj(line.message).content;
    const blocks = Array.isArray(content) ? content.map(obj) : [];
    for (const block of blocks) {
      if (block.type !== "tool_use" || !str(block.id) || !["Bash", "Monitor"].includes(String(block.name))) continue;
      const input = obj(block.input);
      this.launches.set(String(block.id), { kind: block.name === "Monitor" ? "monitor" : "shell", title: str(input.description) ?? str(input.command) ?? String(block.name), command: str(input.command), ts });
    }
    const result = obj(line.toolUseResult ?? line.tool_use_result);
    const block = blocks.find((b) => b.type === "tool_result" && !b.is_error && this.launches.has(String(b.tool_use_id)));
    const call = str(block?.tool_use_id);
    const launch = call ? this.launches.get(call) : undefined;
    const id = str(result.backgroundTaskId) ?? (launch?.kind === "monitor" ? str(result.taskId) : undefined);
    if (id && call && launch && !this.records.has(id)) {
      const text = typeof block?.content === "string" ? block.content : JSON.stringify(block?.content ?? "");
      const path = /Output is being written to:\s*(\S+?\.output)(?:\s|\.|$)/.exec(text)?.[1];
      if (path) this.paths.set(id, path);
      // Fold a completion that arrived first into the initial snapshot.
      const { ts: startedAt, ...description } = launch;
      this.records.set(id, { id, ...description, startedAt, toolCallId: call, state: "running", output: !!path });
      const pending = this.pending.get(id) ?? this.pending.get(call);
      if (pending) { this.notification(pending.text, pending.ts); this.pending.delete(id); this.pending.delete(call); }
      else this.emit(this.records.get(id)!);
    }
    const stopped = str(result.task_id);
    if (stopped && result.task_type === "local_bash" && this.records.has(stopped)) this.change(stopped, { state: "stopped", endedAt: ts });
    const texts = [str(obj(line.attachment).prompt), str(line.content), str(content), ...blocks.map((b) => str(b.text))];
    for (const text of texts) if (text?.trimStart().startsWith("<task-notification>")) this.notification(text, ts);
  }

  private notification(text: string, ts: number): void {
    if (text.includes("__orphan_summary__:shell")) {
      for (const [id, task] of this.records) if (task.state === "running" && text.includes(id)) this.change(id, { state: "unknown", endedAt: ts });
      return;
    }
    const id = tag(text, "task-id");
    const call = tag(text, "tool-use-id");
    const task = (id ? this.records.get(id) : undefined) ?? [...this.records.values()].find((t) => call && t.toolCallId === call);
    if (!task) {
      if ((id && !/^[aw]/.test(id)) || (call && this.launches.has(call))) {
        this.pending.set(id ?? call!, { text, ts });
        if (this.pending.size > 1000) this.pending.delete(this.pending.keys().next().value!);
      }
      return;
    }
    const output = tag(text, "output-file");
    if (output) this.paths.set(task.id, output);
    const status = tag(text, "status");
    const state = status === "killed" || status === "stopped" ? "stopped" : status === "failed" || status === "completed" ? status : undefined;
    const summary = tag(text, "summary");
    const code = summary && /exit code\s+(-?\d+)/.exec(summary)?.[1];
    this.change(task.id, { ...(state ? { state, endedAt: task.endedAt ?? ts } : {}), ...(summary ? { summary } : {}), ...(code ? { exitCode: Number(code) } : {}), output: this.paths.has(task.id) });
  }

  private change(id: string, patch: Partial<BackgroundTask>): void {
    const old = this.records.get(id)!;
    const next = { ...old, ...patch };
    if (JSON.stringify(old) === JSON.stringify(next)) return;
    this.records.set(id, next);
    this.emit(next);
  }

  lostHolder(): void {
    for (const [id, task] of this.records) if (task.state === "running") this.change(id, { state: "unknown", endedAt: Date.now() });
  }

  output(nativeId: string, taskId: string, before: number | undefined, limit: number) {
    const path = this.paths.get(taskId);
    if (!path || !/^[\w-]+$/.test(nativeId) || !/^[\w-]+$/.test(taskId)) return undefined;
    const valid = (value: string) => value.includes("/claude-") && new RegExp(`/claude-\\d+/[^/]+/${nativeId}/tasks/${taskId}\\.output$`).test(value);
    let fd: number | undefined;
    try {
      if (!valid(path)) return undefined;
      const resolved = realpathSync(path);
      if (!valid(resolved)) return undefined;
      fd = openSync(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = fstatSync(fd);
      if (!stat.isFile()) return undefined;
      const size = stat.size;
      const end = Math.min(size, Math.max(0, before ?? size));
      const offset = Math.max(0, end - Math.max(4, Math.min(limit, 256 * 1024)) - 4);
      const buffer = Buffer.alloc(end - offset);
      const read = readSync(fd, buffer, 0, buffer.length, offset);
      const part = outputRange(buffer.subarray(0, read), undefined, limit);
      return { ...part, start: offset + part.start, size };
    } catch { return undefined; }
    finally { if (fd !== undefined) closeSync(fd); }
  }
}
