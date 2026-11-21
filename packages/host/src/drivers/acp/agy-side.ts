import { accessSync, constants, existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";
import { trackChild } from "../../children.js";
import { spawnAgent, stopAgent } from "../../process.js";
import type { SideOutput, SideRequest } from "../types.js";

const SIDE_INSTRUCTIONS = [
  "You are answering a side question about the user's main coding session.",
  "Stay strictly read-only: do NOT edit, create, or delete files, do NOT run mutating commands, and do NOT modify git state.",
  "Answer concisely and directly in the user's language based on the session context and workspace files.",
].join(" ");

const MAX_CONTEXT_CHARS = 12_000;
const MAX_LINE_CHARS = 1_200;

function isExecutable(filePath: string): boolean {
  try {
    accessSync(filePath, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Resolves an installed `agy` CLI binary from explicit env, PATH, or `~/.local/bin/agy`. */
export function resolveAgyBinary(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const explicit = env.LINKSHELL_AGY_PATH?.trim();
  if (explicit && isExecutable(explicit)) return explicit;
  const pathVar = env.PATH ?? "";
  const names = process.platform === "win32" ? ["agy.exe", "agy.cmd", "agy"] : ["agy"];
  for (const name of names) {
    if (isAbsolute(name) && isExecutable(name)) return name;
    for (const dir of pathVar.split(delimiter)) {
      if (!dir) continue;
      const candidate = join(dir, name);
      if (isExecutable(candidate)) return candidate;
    }
  }
  if (process.platform !== "win32" && env.PATH !== "") {
    const home = env.HOME || homedir();
    const localBin = join(home, ".local", "bin", "agy");
    if (isExecutable(localBin)) return localBin;
  }
  return undefined;
}

function stripTags(raw: string): string {
  const userMatch = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i.exec(raw);
  const text = userMatch ? userMatch[1]! : raw.replace(/<(?:ADDITIONAL_METADATA|USER_SETTINGS_CHANGE|SYSTEM_MESSAGE|CONTEXT_SUMMARY|EPILOGUE)>[\s\S]*?<\/(?:ADDITIONAL_METADATA|USER_SETTINGS_CHANGE|SYSTEM_MESSAGE|CONTEXT_SUMMARY|EPILOGUE)>/gi, "");
  return text.replace(/\s+/g, " ").trim();
}

/** Reads the tail of an Antigravity / AGY transcript into compact context lines for a side question. */
export function readRecentTranscriptContext(nativeId: string, env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HOME || homedir();
  const roots = [
    env.ANTIGRAVITY_APP_DATA_DIR?.trim(),
    join(home, ".gemini", "antigravity-cli"),
    join(home, ".gemini", "antigravity"),
  ].filter((entry): entry is string => Boolean(entry));

  let transcriptPath: string | undefined;
  for (const root of roots) {
    const logs = join(root, "brain", nativeId, ".system_generated", "logs");
    for (const name of ["transcript.jsonl", "transcript_full.jsonl"]) {
      const candidate = join(logs, name);
      if (existsSync(candidate)) {
        transcriptPath = candidate;
        break;
      }
    }
    if (transcriptPath) break;
  }
  if (!transcriptPath) return "";

  let raw: string;
  try {
    raw = readFileSync(transcriptPath, "utf8");
  } catch {
    return "";
  }

  const lines = raw.split("\n").filter((line) => line.trim());
  const turns: string[] = [];
  for (const line of lines.slice(-80)) {
    let step: { type?: string; content?: string };
    try {
      step = JSON.parse(line) as { type?: string; content?: string };
    } catch {
      continue;
    }
    if (typeof step.content !== "string" || !step.content.trim()) continue;
    if (step.type === "USER_INPUT") {
      const cleaned = stripTags(step.content);
      if (cleaned) turns.push(`User: ${cleaned.slice(0, MAX_LINE_CHARS)}`);
    } else if (step.type === "PLANNER_RESPONSE") {
      const cleaned = stripTags(step.content);
      if (cleaned) turns.push(`Assistant: ${cleaned.slice(0, MAX_LINE_CHARS)}`);
    }
  }

  let total = 0;
  const kept: string[] = [];
  for (let i = turns.length - 1; i >= 0; i--) {
    const entry = turns[i]!;
    if (total + entry.length > MAX_CONTEXT_CHARS && kept.length > 0) break;
    kept.unshift(entry);
    total += entry.length + 1;
  }
  return kept.join("\n");
}

function buildInitialSidePrompt(context: string, request: SideRequest): string {
  const parts: string[] = [SIDE_INSTRUCTIONS];
  if (context) {
    parts.push(`--- Main session context (read-only reference) ---\n${context}\n--- End main session context ---`);
  }
  if (request.history.length > 0) {
    const prior = request.history.map((turn) => `Q: ${turn.question}\nA: ${turn.answer}`).join("\n\n");
    parts.push(`--- Earlier side conversation ---\n${prior}\n--- End earlier side conversation ---`);
  }
  parts.push(`Side question:\n${request.question}`);
  return parts.join("\n\n");
}

interface StreamJsonEvent {
  event?: string;
  conversation_id?: string;
  step_update?: {
    conversation_id?: string;
    step_type?: string;
    state?: string;
    text_delta?: string;
    tool_name?: string;
    tool_summary?: string;
    error?: string;
  };
  result?: {
    conversation_id?: string;
    status?: string;
    response?: string;
    error?: string;
  };
}

/**
 * Manages read-only side conversations powered by `agy --output-format stream-json --sandbox`.
 * Keeps ephemeral side conversation IDs hidden from session discovery and removes them on close.
 */
export class AgySideRunner {
  private readonly sideConversations = new Map<string, string>();
  private readonly hiddenIds = new Set<string>();

  constructor(
    private readonly getCommand: () => string | undefined,
    private readonly getEnv: () => NodeJS.ProcessEnv,
    private readonly log?: (message: string) => void,
  ) {}

  isHiddenSideSession(nativeId: string): boolean {
    return this.hiddenIds.has(nativeId);
  }

  available(): boolean {
    return Boolean(this.getCommand());
  }

  async ask(
    nativeId: string,
    request: SideRequest,
    out: SideOutput,
    signal: AbortSignal,
    model?: string,
  ): Promise<void> {
    const command = this.getCommand();
    if (!command) throw new Error("未检测到 agy CLI，无法开启旁支对话");

    const env = this.getEnv();
    const key = `${nativeId}\n${request.sideId}`;
    const existingConv = this.sideConversations.get(key);
    const prompt = existingConv
      ? request.question
      : buildInitialSidePrompt(readRecentTranscriptContext(nativeId, env), request);

    const args = [
      "--output-format",
      "stream-json",
      "--disable-slash-commands",
      "--sandbox",
      ...(existingConv ? ["--conversation", existingConv] : []),
      ...(model ? ["--model", model] : []),
      `-p=${prompt}`,
    ];

    const grouped = process.platform !== "win32";
    const child = spawnAgent(command, args, {
      cwd: request.cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: grouped,
    });
    trackChild(child, "agent", command, args, grouped);

    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-4000);
    });

    const onAbort = () => {
      void stopAgent(child, { group: grouped });
    };
    signal.addEventListener("abort", onAbort, { once: true });

    let streamedText = false;
    let resultText: string | undefined;
    let resultError: string | undefined;
    let recordedConv = existingConv;

    const rl = createInterface({ input: child.stdout! });
    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) return;
      let parsed: StreamJsonEvent;
      try {
        parsed = JSON.parse(trimmed) as StreamJsonEvent;
      } catch {
        return;
      }
      const convId = parsed.conversation_id ?? parsed.step_update?.conversation_id ?? parsed.result?.conversation_id;
      if (convId && !recordedConv) {
        recordedConv = convId;
        this.sideConversations.set(key, convId);
        this.hiddenIds.add(convId);
      }
      if (parsed.event === "step_update" && parsed.step_update) {
        const update = parsed.step_update;
        if (typeof update.text_delta === "string" && update.text_delta.length > 0) {
          streamedText = true;
          out.text(update.text_delta);
        } else if (update.tool_summary || update.tool_name) {
          out.activity(update.tool_summary || update.tool_name || "处理中");
        }
      } else if (parsed.event === "result" && parsed.result) {
        if (typeof parsed.result.response === "string" && parsed.result.response.trim()) {
          resultText = parsed.result.response;
        }
        if (parsed.result.status === "ERROR" || parsed.result.error) {
          resultError = parsed.result.error || "旁支对话执行失败";
        }
      }
    });

    try {
      const exitCode = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) => resolve(code));
      });
      rl.close();
      if (signal.aborted) return;
      if (resultError) throw new Error(resultError);
      if (exitCode !== 0 && !streamedText && !resultText) {
        const detail = stderr.trim().split("\n").at(-1)?.trim();
        throw new Error(detail || `agy 旁支对话退出（${exitCode ?? "unknown"}）`);
      }
      if (!streamedText && resultText) out.text(resultText);
    } catch (error) {
      rl.close();
      if (signal.aborted) return;
      this.sideConversations.delete(key);
      this.log?.(`[agy] side error: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  async close(nativeId: string, sideId: string): Promise<void> {
    const key = `${nativeId}\n${sideId}`;
    const convId = this.sideConversations.get(key);
    this.sideConversations.delete(key);
    if (!convId) return;
    // Remove ephemeral side-chat files created by LinkShell so they don't linger in agy's store.
    const home = this.getEnv().HOME || homedir();
    const cliDir = join(home, ".gemini", "antigravity-cli");
    for (const target of [
      join(cliDir, "conversations", `${convId}.db`),
      join(cliDir, "brain", convId),
    ]) {
      try {
        if (existsSync(target)) rmSync(target, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors
      }
    }
  }
}
