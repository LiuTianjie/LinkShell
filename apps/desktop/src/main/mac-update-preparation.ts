interface Preparation {
  prepare(): Promise<unknown>;
  recover(): Promise<unknown>;
  resume(): void;
  failed(message: string): void;
}

const reason = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Sparkle must keep waiting until this app's Host is confirmed stopped. */
export function macUpdatePreparation(actions: Preparation): () => Promise<void> {
  let pending: Promise<void> | undefined;
  const prepare = async () => {
    try { await actions.prepare(); }
    catch (error) {
      let message = `更新已暂停：${reason(error)}。`;
      // A timed-out command may have stopped the Host before it could report success.
      try { await actions.recover(); }
      catch (recovery) { message += `服务恢复需要处理：${reason(recovery)}。`; }
      actions.failed(`${message}可点击下载并更新重试。`);
      return;
    }
    actions.resume();
  };
  return () => pending ??= prepare().finally(() => { pending = undefined; });
}
