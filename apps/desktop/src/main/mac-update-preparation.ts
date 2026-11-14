interface Preparation {
  prepare(): Promise<unknown>;
  recover(): Promise<unknown>;
  resume(): void;
  failed(message: string): void;
  /** The progress line's words in the page's language; Chinese when not given. */
  text?: { paused(reason: string): string; recover(reason: string): string; retry: string };
}

const ZH_TEXT = {
  paused: (why: string) => `更新已暂停：${why}。`,
  recover: (why: string) => `服务恢复需要处理：${why}。`,
  retry: "可点击下载并更新重试。",
};

const reason = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Sparkle must keep waiting until this app's Host is confirmed stopped. */
export function macUpdatePreparation(actions: Preparation): () => Promise<void> {
  let pending: Promise<void> | undefined;
  const prepare = async () => {
    try { await actions.prepare(); }
    catch (error) {
      const text = actions.text ?? ZH_TEXT;
      let message = text.paused(reason(error));
      // A timed-out command may have stopped the Host before it could report success.
      try { await actions.recover(); }
      catch (recovery) { message += text.recover(reason(recovery)); }
      actions.failed(`${message}${text.retry}`);
      return;
    }
    actions.resume();
  };
  return () => pending ??= prepare().finally(() => { pending = undefined; });
}
