export const screenWidths = ["1280", "1920", "2560", "native"] as const;
export const screenRates = ["30", "60", "120"] as const;
export type ScreenPreferences = {
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
      : "2560",
    maxFps: screenRates.includes(rate as (typeof screenRates)[number])
      ? rate!
      : "120",
    codec: read("linkshell.screen.codec") === "h264" ? "h264" : "auto",
    mode: mode && ["view", "trackpad", "touch"].includes(mode) ? mode : "view",
  };
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
