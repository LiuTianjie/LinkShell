import { Button } from "@/components/ui/button";

export function ScreenConnectionLoading({ preparing, slow, error, retry }: {
  preparing: boolean;
  slow: boolean;
  error?: string;
  retry: () => void;
}) {
  return (
    <div className="screen-start screen-connecting" data-failed={!!error}>
      <div className="screen-connecting-art" aria-hidden="true">
        <div className="screen-connecting-monitor" />
        <div className="screen-connecting-stand" />
      </div>
      <div role="status" aria-live="polite" aria-atomic="true">
        <h3>{error ? "暂时无法打开画面" : preparing ? "正在准备屏幕" : "正在连接电脑"}</h3>
        <p>{error || (slow ? "这次连接耗时较长。可以继续等待，或重新连接。" : preparing ? "电脑已响应，正在打开画面。" : "正在建立屏幕连接，画面会自动显示。")}</p>
      </div>
      {!error && <div className="screen-connecting-steps" aria-hidden="true">
        <span data-active={!preparing}>连接电脑</span><i /><span data-active={preparing}>接收画面</span><i /><span>显示桌面</span>
      </div>}
      {(error || slow) && <Button variant="outline" onClick={retry}>重新连接</Button>}
    </div>
  );
}
