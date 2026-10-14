export const screenWidths = ["auto", "1280", "1920", "2560", "native"] as const;
export const screenRates = ["30", "60", "120"] as const;
/** What "auto" resolves to: the widths a stage is measured against. */
const fittedWidths = ["1280", "1920", "2560"] as const;
export type ScreenPreferences = {
  /** A stored choice, "auto" included; `screenQuery` is given the resolved one. */
  width: string;
  maxFps: string;
  codec: "auto" | "h264";
  mode: string;
};

export function screenPreferences(
  read: (key: string) => string | undefined,
): ScreenPreferences {
  const width = read("linkshell.screen.width");
  const rate = read("linkshell.screen.maxFps");
  const mode = read("linkshell.screen.mode");
  return {
    width: screenWidths.includes(width as (typeof screenWidths)[number])
      ? width!
      : "auto",
    maxFps: screenRates.includes(rate as (typeof screenRates)[number])
      ? rate!
      : // 60 a second already reads as smooth; the bits the other 60 would have
        // taken go into each frame instead, where they show as sharper text.
        "60",
    codec: read("linkshell.screen.codec") === "h264" ? "h264" : "auto",
    mode: mode && ["view", "trackpad", "touch"].includes(mode) ? mode : "view",
  };
}

/**
 * The narrowest track that still covers the stage's own pixels. Anything wider
 * is spent on pixels the stage cannot show, and at a given bitrate every extra
 * pixel is a softer one: under pressure the sender keeps the frame rate by
 * shrinking the picture, so an oversized track arrives small and is scaled up.
 */
export function autoScreenWidth(stage: {
  width: number;
  ratio: number;
}): string {
  // Past 2× the extra pixels cost more in bitrate than they return in detail.
  const ratio = Math.min(Math.max(stage.ratio || 1, 1), 2);
  const target = Math.max(stage.width, 0) * ratio;
  return fittedWidths.find((width) => Number(width) >= target) ?? "2560";
}

// File playback support does not imply that the browser can receive H.265 over RTP.
export function screenQuery(
  token: string,
  display: number,
  view: ScreenPreferences,
  codecs: readonly { mimeType: string }[],
): string {
  const query = new URLSearchParams({
    token,
    display: String(display),
    width: view.width,
    maxFps: view.maxFps,
    mode: view.mode,
  });
  if (
    view.codec === "auto" &&
    codecs.some((codec) => codec.mimeType.toLowerCase() === "video/h265")
  )
    query.set("codec", "hevc");
  return `?${query}`;
}
