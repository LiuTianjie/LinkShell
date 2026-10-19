import { z } from "zod";
import type { StreamProfile } from "./input.js";
import { rung } from "./screen-pacer.js";

export const SCREEN_RETAIN_MS = 120_000;

// URL defaults are permissive for older clients. Stateful changes must be complete and valid
// before they can release input or change capture on a live connection.
export const screenConfiguration = z.object({
  t: z.literal("screen.configure"),
  requestId: z.number().int().nonnegative().safe(),
  display: z.number().int().nonnegative().safe(),
  width: z.union([z.literal("native").transform(() => 3840), z.number(), z.string().regex(/^\d+$/).transform(Number)])
    .pipe(z.number().int().min(640).max(3840)),
  maxFps: z.union([z.literal(30), z.literal(60), z.literal(120)]).optional(),
  paused: z.boolean(),
});

export type ScreenConfiguration = Omit<z.infer<typeof screenConfiguration>, "t" | "requestId">;

export function fallbackProfile(level: number, configuration?: Pick<ScreenConfiguration, "width" | "maxFps">): StreamProfile {
  const profile = rung(level);
  return { ...profile, width: Math.floor(Math.min(profile.width, configuration?.width ?? profile.width) / 2) * 2, fps: Math.min(profile.fps, configuration?.maxFps ?? profile.fps) };
}

/** Mirrors the helper's even-pixel capture size; dimensions come from the current display list. */
export function fallbackSize(display: { w?: number; h?: number }, profile: StreamProfile): { width: number; height: number } {
  if (!display.w || !display.h) throw new Error("无法读取当前屏幕尺寸，请重新连接");
  const width = Math.floor(Math.min(display.w, profile.width) / 2) * 2;
  return { width, height: Math.max(2, Math.round(display.h * width / display.w / 2) * 2) };
}
