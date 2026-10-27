import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

/**
 * `LinkShellNative.node` (apps/mac, product LinkShellNative): permissions, the login item and
 * Sparkle, under this bundle's own identity. Values cross as JSON text.
 *
 * The remote screen is not native here: Chromium's libwebrtc and WebRTC.framework share
 * Objective-C class names and cannot live in one process. The page receives it with Chromium.
 */
interface Raw {
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
