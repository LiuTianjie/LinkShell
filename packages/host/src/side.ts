import { randomUUID } from "node:crypto";
import { RpcError, type SideChat, type SideMessage } from "@linkshell/wire";
import type { AgentDriver } from "./drivers/types.js";

/** Side conversations a session may have open at once, and how long one gets. */
const MAX_SIDES = 5;
const MAX_MESSAGES = 60;
/** An answer is cut here; a side answer is meant to be short. */
const MAX_ANSWER_CHARS = 64 * 1024;
const MAX_ACTIVITY = 40;
/** Changes while an answer is written go out at most this often. */
const EMIT_EVERY_MS = 120;

interface SideState {
  chat: SideChat;
  abort?: AbortController;
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * The side conversations of the sessions, kept in memory: they are for the
 * moment, like the agents' own (Codex's are never written to disk). Every
 * change goes to every client, as summaries do.
 */
export class SideChats {
  private readonly chats = new Map<string, Map<string, SideState>>();

  constructor(
    private readonly emit: (sessionId: string, side: SideChat, closed?: boolean) => void,
    private readonly log: (message: string) => void,
  ) {}

  list(sessionId: string): SideChat[] {
    return [...(this.chats.get(sessionId)?.values() ?? [])].map((state) => state.chat);
  }

  ask(sessionId: string, target: { driver: AgentDriver; nativeId: string; cwd: string }, sideId: string | undefined, question: string): SideChat {
    const { driver } = target;
    if (!driver.sideAsk || !driver.capabilities.side) throw RpcError.app("not_supported", `${driver.label} 没有旁支对话`);
    let sides = this.chats.get(sessionId);
    let state = sideId ? sides?.get(sideId) : undefined;
    if (sideId && !state) throw RpcError.app("not_found", "这个旁支对话已经结束");
    if (state?.abort) throw RpcError.app("busy", "上一个问题还在回答");
    if (state && state.chat.messages.length >= MAX_MESSAGES) throw RpcError.app("busy", "这个旁支对话已经很长了：关掉它，开一个新的");
    if (!state) {
      if ((sides?.size ?? 0) >= MAX_SIDES) throw RpcError.app("busy", `最多同时开 ${MAX_SIDES} 个旁支对话：先关掉一个`);
      state = { chat: { sideId: randomUUID(), createdAt: Date.now(), running: false, revision: 0, messages: [] } };
      if (!sides) this.chats.set(sessionId, (sides = new Map()));
      sides.set(state.chat.sideId, state);
    }
    const history = pairs(state.chat.messages);
    const answer: SideMessage = { id: randomUUID(), role: "assistant", text: "" };
    const abort = new AbortController();
    state.abort = abort;
    state.chat = {
      ...state.chat,
      running: true,
      messages: [...state.chat.messages, { id: randomUUID(), role: "user", text: question }, answer],
    };
    this.flush(sessionId, state);
    const current = state;
    const update = (change: (message: SideMessage) => SideMessage) => {
      const messages = current.chat.messages;
      const last = messages[messages.length - 1];
      if (!last || last.id !== answer.id) return;
      current.chat = { ...current.chat, messages: [...messages.slice(0, -1), change(last)] };
      current.timer ??= setTimeout(() => this.flush(sessionId, current), EMIT_EVERY_MS);
    };
    const out = {
      text: (delta: string) => update((message) => message.text.length >= MAX_ANSWER_CHARS ? message : { ...message, text: (message.text + delta).slice(0, MAX_ANSWER_CHARS) }),
      activity: (line: string) => update((message) => ({ ...message, activity: [...(message.activity ?? []), line.slice(0, 300)].slice(-MAX_ACTIVITY) })),
    };
    void driver.sideAsk(target.nativeId, { sideId: current.chat.sideId, cwd: target.cwd, question, history }, out, abort.signal)
      .then(() => {
        if (abort.signal.aborted) update((message) => ({ ...message, error: message.text ? undefined : "已停止" }));
        else update((message) => (message.text ? message : { ...message, error: "没有得到回答" }));
      })
      .catch((error: unknown) => {
        if (!abort.signal.aborted) this.log(`[side] ${driver.id} ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
        const reason = abort.signal.aborted ? "已停止" : error instanceof Error ? error.message : String(error);
        update((message) => ({ ...message, error: reason }));
      })
      .finally(() => {
        if (current.abort === abort) current.abort = undefined;
        current.chat = { ...current.chat, running: false };
        // Closed meanwhile: it said so already.
        if (this.chats.get(sessionId)?.get(current.chat.sideId) === current) this.flush(sessionId, current);
      });
    return state.chat;
  }

  cancel(sessionId: string, sideId: string): void {
    this.chats.get(sessionId)?.get(sideId)?.abort?.abort();
  }

  async close(sessionId: string, sideId: string, driver: AgentDriver | undefined, nativeId: string): Promise<void> {
    const sides = this.chats.get(sessionId);
    const state = sides?.get(sideId);
    if (!sides || !state) return;
    state.abort?.abort();
    clearTimeout(state.timer);
    sides.delete(sideId);
    if (sides.size === 0) this.chats.delete(sessionId);
    this.emit(sessionId, { ...state.chat, running: false }, true);
    await driver?.sideClose?.(nativeId, sideId).catch((error: unknown) => this.log(`[side] closing ${sideId}: ${String(error)}`));
  }

  /** The session is gone: so are its side conversations (the agent's end goes with it). */
  forget(sessionId: string): void {
    for (const state of this.chats.get(sessionId)?.values() ?? []) {
      state.abort?.abort();
      clearTimeout(state.timer);
    }
    this.chats.delete(sessionId);
  }

  async stop(drivers: (sessionId: string) => { driver: AgentDriver; nativeId: string } | undefined): Promise<void> {
    for (const [sessionId, sides] of [...this.chats]) {
      const target = drivers(sessionId);
      for (const sideId of [...sides.keys()]) await this.close(sessionId, sideId, target?.driver, target?.nativeId ?? "");
    }
  }

  private flush(sessionId: string, state: SideState): void {
    clearTimeout(state.timer);
    state.timer = undefined;
    state.chat = { ...state.chat, revision: state.chat.revision + 1 };
    this.emit(sessionId, state.chat);
  }
}

/** The questions asked and what came back, for agents that don't keep side history themselves. */
function pairs(messages: SideMessage[]): { question: string; answer: string }[] {
  const out: { question: string; answer: string }[] = [];
  for (let i = 0; i + 1 < messages.length; i += 2) {
    const question = messages[i]!;
    const answer = messages[i + 1]!;
    if (question.role === "user" && answer.role === "assistant" && answer.text) out.push({ question: question.text, answer: answer.text });
  }
  return out;
}
