import { describe, expect, it, vi } from "vitest";
import { VoiceSession, type SpeechTransport } from "../src/lib/voice-session";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture() {
  let listener!: Parameters<SpeechTransport["subscribe"]>[0];
  const remove = vi.fn();
  const transport: SpeechTransport = {
    available: () => true,
    start: vi.fn(async () => ({ ok: true })),
    stop: vi.fn(async () => ({ text: "最终文字" })),
    cancel: vi.fn(async () => {}),
    subscribe: (events) => { listener = events; return remove; },
  };
  const events = { text: vi.fn(), level: vi.fn(), phase: vi.fn(), error: vi.fn(), send: vi.fn() };
  const session = new VoiceSession(transport, events);
  return { transport, events, session, remove, result: (text: string, isFinal = false) => listener.onResult({ text, isFinal }), error: (message: string) => listener.onError({ message }) };
}

describe("native voice input sessions", () => {
  it("does not offer a recording-only fallback when recognition is absent", async () => {
    const ui = fixture(); ui.transport.available = () => false;
    expect(await ui.session.start("")).toBe(false);
    expect(ui.transport.start).not.toHaveBeenCalled();
    expect(ui.session.phase).toBe("idle");
    expect(ui.events.error).toHaveBeenCalledOnce();
  });

  it("reports permission or unavailable-service failures without pretending to record", async () => {
    const ui = fixture(); ui.transport.start = async () => ({ ok: false, reason: "麦克风权限被拒绝" });
    expect(await ui.session.start("")).toBe(false);
    expect(ui.session.phase).toBe("idle");
    expect(ui.remove).toHaveBeenCalledOnce();
    expect(ui.events.error).toHaveBeenCalledWith("麦克风权限被拒绝");
  });

  it("waits for the final recognition result before an explicit send, without duplicating partials", async () => {
    const ui = fixture(); const final = deferred<{ text: string }>();
    ui.transport.stop = () => final.promise;
    await ui.session.start("先检查");
    ui.result("正在识"); ui.result("正在识别");
    expect(ui.events.text).toHaveBeenLastCalledWith("先检查，正在识别", "正在识别");
    const stopped = ui.session.stop(true);
    expect(ui.session.phase).toBe("stopping");
    expect(ui.events.send).not.toHaveBeenCalled();
    ui.result("最终文字", true);
    final.resolve({ text: "最终文字" });
    expect(await stopped).toBe("先检查，最终文字");
    expect(ui.events.send).toHaveBeenCalledExactlyOnceWith("先检查，最终文字");
  });

  it("keeps a naturally completed transcript as a draft and releases the microphone", async () => {
    const ui = fixture(); await ui.session.start("");
    ui.result("git status", true);
    expect(ui.events.text).toHaveBeenLastCalledWith("git status", "git status");
    expect(ui.session.phase).toBe("idle");
    expect(ui.transport.cancel).toHaveBeenCalledOnce();
    expect(ui.events.send).not.toHaveBeenCalled();
  });

  it("cancel wins against late stop results and restores the existing draft", async () => {
    const ui = fixture(); const final = deferred<{ text: string }>(); ui.transport.stop = () => final.promise;
    await ui.session.start("原有草稿"); ui.result("新内容");
    const stopped = ui.session.stop(true);
    await ui.session.cancel();
    ui.result("迟到的内容", true); final.resolve({ text: "迟到的内容" });
    expect(await stopped).toBeNull();
    expect(ui.events.text).toHaveBeenLastCalledWith("原有草稿", "");
    expect(ui.events.send).not.toHaveBeenCalled();
  });

  it("cancels a pending permission request without starting a new overlapping session", async () => {
    const ui = fixture(); const permission = deferred<{ ok: boolean }>(); let current!: () => boolean;
    ui.transport.start = (isCurrent) => { current = isCurrent; return permission.promise; };
    const first = ui.session.start("");
    await ui.session.cancel();
    expect(current()).toBe(false);
    expect(await ui.session.start("second")).toBe(false);
    permission.resolve({ ok: true });
    expect(await first).toBe(false);
    expect(ui.session.phase).toBe("idle");
    expect(ui.transport.cancel).toHaveBeenCalledTimes(2);
  });

  it("keeps recognized text on error/background cleanup, without sending or restoring old text", async () => {
    const ui = fixture(); await ui.session.start(""); ui.result("保留文字");
    ui.error("网络断开");
    expect(ui.session.phase).toBe("idle");
    expect(ui.events.error).toHaveBeenCalledWith("网络断开");
    expect(ui.events.text).toHaveBeenLastCalledWith("保留文字", "保留文字");
    await ui.session.start("保留文字"); ui.result("更多文字");
    await ui.session.cancel(false);
    expect(ui.events.text).toHaveBeenLastCalledWith("保留文字，更多文字", "更多文字");
    expect(ui.events.send).not.toHaveBeenCalled();
  });

  it("does not send an old draft when no speech was recognized", async () => {
    const ui = fixture(); ui.transport.stop = async () => ({ text: "" });
    await ui.session.start("原有草稿"); await ui.session.stop(true);
    expect(ui.events.send).not.toHaveBeenCalled();
  });

  it("does not send partial text if stopping fails before the native error event arrives", async () => {
    const ui = fixture();
    ui.transport.stop = async () => { throw new Error("识别超时"); };
    await ui.session.start(""); ui.result("尚未确认的文字");
    expect(await ui.session.stop(true)).toBeNull();
    expect(ui.events.send).not.toHaveBeenCalled();
    expect(ui.events.error).toHaveBeenCalledWith("识别超时");
    expect(ui.events.text).toHaveBeenLastCalledWith("尚未确认的文字", "尚未确认的文字");
  });
});
