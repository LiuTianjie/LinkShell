import { createHash, randomBytes } from "node:crypto";
import { previewApp, type HelperApp } from "./input.js";
import type { PreviewCaptureTarget } from "./computer-preview.js";

/** The helper instance belongs exclusively to previews, never to screen sharing or input. */
export class MacPreviewCapture {
  private app?: HelperApp;
  private opening?: Promise<HelperApp>;
  private users = 0;
  constructor(private readonly log: (message: string) => void) {}

  private getApp(): Promise<HelperApp> {
    return this.opening ??= (async () => {
      const app = previewApp(this.log);
      if (!app) throw new Error("当前电脑没有窗口采集组件");
      this.app = app;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const status = await Promise.race([app.access(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("窗口采集组件启动超时")), 8000); })]);
        if (!status.recording) throw new Error("电脑未允许 LinkShell 录制屏幕");
        if (!status.preview) throw new Error("请更新电脑端窗口采集组件");
        return app;
      } catch (error) { app.close(); this.app = undefined; this.opening = undefined; throw error; }
      finally { if (timer) clearTimeout(timer); }
    })();
  }

  async capture(target: PreviewCaptureTarget, frame: (dataUrl: string) => void, failed: () => void = () => {}): Promise<() => void> {
    if (this.users >= 4) throw new Error("同时观看的窗口预览已达上限");
    this.users++;
    let released = false;
    const release = () => {
      if (released) return; released = true; this.users--;
      if (!this.users) { this.app?.close(); this.app = undefined; this.opening = undefined; }
    };
    try {
      const app = await this.getApp();
      const id = randomBytes(12).toString("hex");
      let last = "", problem = "";
      await app.preview(id, target, message => {
        if (released) return;
        if (message.t === "preview.frame" && typeof message.data === "string" && message.data.length <= 256 * 1024) {
          const hash = createHash("sha256").update(message.data).digest("hex");
          if (last === hash) return;
          last = hash; frame(`data:image/jpeg;base64,${message.data}`);
        } else if (message.t === "preview.paused" && typeof message.error === "string" && problem !== message.error) {
          problem = message.error; this.log(`[computer-preview] ${problem}`);
        } else if (message.t === "gone") { this.log("[computer-preview] capture process ended; last frame retained"); release(); failed(); }
      });
      return () => { app.endPreview(id); release(); };
    } catch (error) { release(); throw error; }
  }
}
