import { previewCaptureSchema, type PreviewInput } from "../../computer-preview.js";

const object = (v: unknown): Record<string, unknown> | undefined => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : undefined;

/** The desktop's preview surface, deliberately independent of chat result.content. */
export function codexPreview(raw: unknown, capturedAt = Date.now()): PreviewInput | undefined {
  const item = object(raw);
  if (item?.type !== "mcpToolCall" || typeof item.server !== "string" || !["cua_repl", "computer-use", "computer_use"].includes(item.server)) return;
  if (!Number.isFinite(capturedAt) || capturedAt < 0) return;
  const surface = object(object(object(item.result)?._meta)?.["codex/toolSurface"]);
  if (surface?.kind === "computerUse") {
    const app = object(surface.app);
    if (app?.kind !== "appId" || typeof item.id !== "string") return;
    const content = object(item.result)?.content;
    // Only the provider's anchored window header identifies a native window.
    const texts = Array.isArray(content) ? content.map(object).filter(v => v?.type === "text" && typeof v.text === "string") : [];
    const title = texts.map(v => (v!.text as string).match(/^(?:The following is a diff from the previous accessibility tree for )?Window: "([^"\n]+)"(?:, App:| with )/)?.[1]).find(Boolean);
    const capture = previewCaptureSchema.safeParse({ bundleId: app.appId, title, app: true });
    if (!capture.success) return;
    return { sourceId: item.id, target: JSON.stringify(["app", app.appId]), capturedAt, capture: capture.data };
  }
  if (surface?.kind !== "browserUse") return;
  const shot = object(surface.screenshot);
  if (typeof shot?.url !== "string" || typeof item.id !== "string") return;
  const tab = shot.tabId;
  if (typeof tab !== "string" && typeof tab !== "number") return;
  if (!/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/.test(shot.url) || shot.url.length > 4 * 1024 * 1024) return;
  const target = JSON.stringify([surface.backend, surface.browserId, tab]);
  if (target.length > 1024) return;
  const tabs = Array.isArray(surface.openTabs) ? surface.openTabs : [];
  const entry = tabs.map(object).find(entry => entry && (typeof entry.id === "string" || typeof entry.id === "number") && String(entry.id) === String(tab));
  const bundleId = surface.backend === "chrome" && surface.browserFamily === "chrome" ? "com.google.Chrome"
    : (surface.backend === "chrome" || surface.backend === "edge") && surface.browserFamily === "edge" ? "com.microsoft.edgemac" : undefined;
  const capture = previewCaptureSchema.safeParse({ bundleId, title: entry?.title });
  return { sourceId: item.id, target, capturedAt, dataUrl: shot.url, capture: capture.success ? capture.data : undefined };
}
