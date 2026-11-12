import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

/**
 * `LinkShellNative.node` (apps/mac, product LinkShellNative): permissions, the login item and
 * Sparkle, under this bundle's own identity. Values cross as JSON text.
 *
 * AppKit/Metal present shared IOSurfaces; a separate helper process owns WebRTC/VideoToolbox.
 */
interface Raw {
  screenStart(handle: Buffer, helper: string, message: string, callback: (json: string) => void): void;
  screenMessage(message: string): void;
  screenVisible(visible: boolean): void;
  screenStop(): void;
  setImmersiveFullScreen?(enabled: boolean): void;
  permissions(): string;
  loginItem(): string;
  setLoginItem(enabled: boolean): string;
  openLoginItems(): void;
  updaterStart(callback: (json: string) => void, channel: string): boolean;
  updaterCheck(): void;
  updaterInstall(): void;
  updaterPrepared(): void;
  updaterChannel(channel: string): void;
}

export interface NativeModule {
  screenStart(handle: Buffer, helper: string, message: Record<string, unknown>, callback: (event: Record<string, unknown>) => void): void;
  screenMessage(message: Record<string, unknown>): void;
  screenVisible(visible: boolean): void;
  screenStop(): void;
  setImmersiveFullScreen(enabled: boolean): void;
  permissions(): { recording: boolean; control: boolean };
  loginItem(): { enabled: boolean; approval: boolean };
  /** Why it could not be changed, or undefined. */
  setLoginItem(enabled: boolean): string | undefined;
  openLoginItems(): void;
  updaterStart(callbacks: { event(name: string, detail: Record<string, unknown>): void }, channel: string): boolean;
  updaterCheck(): void;
  updaterInstall(): void;
  /** Sparkle waits on the CLI preparing the Host before it relaunches; this ends that wait. */
  updaterPrepared(): void;
  updaterChannel(channel: string): void;
}

const value = (json: string): unknown => (JSON.parse(json) as { v: unknown }).v;

function wrap(raw: Raw): NativeModule {
  return {
    screenStart: (handle, helper, message, callback) => raw.screenStart(handle, helper, JSON.stringify(message), (json) => callback(value(json) as Record<string, unknown>)),
    screenMessage: (message) => raw.screenMessage(JSON.stringify(message)),
    screenVisible: (visible) => raw.screenVisible(visible),
    screenStop: () => raw.screenStop(),
    setImmersiveFullScreen: (enabled) => raw.setImmersiveFullScreen?.(enabled),
    permissions: () => value(raw.permissions()) as { recording: boolean; control: boolean },
    loginItem: () => value(raw.loginItem()) as { enabled: boolean; approval: boolean },
    setLoginItem: (enabled) => raw.setLoginItem(enabled) || undefined,
    openLoginItems: () => raw.openLoginItems(),
    updaterStart: (callbacks, channel) => raw.updaterStart((json) => {
      const event = value(json) as { name?: string; detail?: Record<string, unknown> } | null;
      if (event?.name) callbacks.event(event.name, event.detail ?? {});
    }, channel),
    updaterCheck: () => raw.updaterCheck(),
    updaterInstall: () => raw.updaterInstall(),
    updaterPrepared: () => raw.updaterPrepared(),
    updaterChannel: (channel) => raw.updaterChannel(channel),
  };
}

let loaded: NativeModule | null | undefined;

export function native(bundle: string | undefined, appPath: string): NativeModule | undefined {
  if (loaded !== undefined) return loaded ?? undefined;
  const candidates = [
    bundle && join(bundle, "Contents/Frameworks/LinkShellNative.node"),
    process.env.LINKSHELL_NATIVE_MODULE,
    join(appPath, "native/LinkShellNative.node"),
  ].filter((path): path is string => !!path && existsSync(path));
  const require = createRequire(import.meta.url);
  for (const path of candidates) {
    try { loaded = wrap(require(path) as Raw); return loaded; }
    catch (error) { console.error(`[native] ${path}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  loaded = null;
  return undefined;
}
