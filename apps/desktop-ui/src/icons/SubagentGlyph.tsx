import { useId, useMemo, type CSSProperties } from "react";
import { subagentGlyphs } from "../../../client/src/theme/subagent-glyphs";
import { resolveIconMetrics, type DesktopIconSize } from "./DesktopIcon";
import { renderTrustedSvg } from "./svg-ast";

export type SubagentSeed = string | readonly [sessionId: string | undefined, toolCallId: string];

/**
 * Deterministic FNV-1a 32-bit hash matching `apps/client/src/components/subagent-glyph.tsx`
 * so the exact same spawned subagent receives the exact same geometric glyph on Desktop and iOS.
 */
export function subagentGlyphIndex(
  seed: SubagentSeed,
  toolCallId?: string,
): number {
  let identity: string;
  if (typeof seed !== "string") {
    identity = JSON.stringify([seed[0] ?? "", seed[1]]);
  } else if (toolCallId !== undefined) {
    identity = JSON.stringify([seed, toolCallId]);
  } else if (seed.startsWith("[")) {
    identity = seed;
  } else {
    identity = JSON.stringify(["", seed]);
  }

  let hash = 2166136261;
  for (let i = 0; i < identity.length; i++) {
    hash = Math.imul(hash ^ identity.charCodeAt(i), 16777619);
  }
  return (hash >>> 0) % subagentGlyphs.length;
}

export interface SubagentGlyphProps {
  seed?: SubagentSeed;
  sessionId?: string;
  toolCallId?: string;
  size?: DesktopIconSize | number;
  className?: string;
  style?: CSSProperties;
}

/**
 * Renders one of LinkShell's 16 frozen subagent geometric glyphs (`solar`..`aperture`)
 * with `useId()`-scoped SVG paint servers so multiple repeated subagents never collide in DOM `<defs>`.
 */
export function SubagentGlyph({
  seed,
  sessionId,
  toolCallId,
  size = "md",
  className,
  style,
}: SubagentGlyphProps) {
  const { px } = resolveIconMetrics(size);
  const instanceId = useId();

  const index = useMemo(() => {
    if (sessionId !== undefined || toolCallId !== undefined) {
      return subagentGlyphIndex(
        sessionId ?? "",
        toolCallId ?? (typeof seed === "string" ? seed : ""),
      );
    }
    return subagentGlyphIndex(seed ?? "");
  }, [seed, sessionId, toolCallId]);

  const entry = subagentGlyphs[index]!;

  const rendered = useMemo(
    () => ({
      light: renderTrustedSvg(entry.light, `ls-subagent-${instanceId}-l`, {
        width: px,
        height: px,
        focusable: "false",
        "aria-hidden": "true",
      }),
      dark: renderTrustedSvg(entry.dark, `ls-subagent-${instanceId}-d`, {
        width: px,
        height: px,
        focusable: "false",
        "aria-hidden": "true",
      }),
    }),
    [entry, instanceId, px],
  );

  const classes = ["ls-subagent-glyph", className ?? ""].filter(Boolean).join(" ");

  return (
    <span
      aria-hidden="true"
      data-glyph-id={entry.id}
      data-glyph-index={index}
      className={classes}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        inlineSize: px,
        blockSize: px,
        flexShrink: 0,
        ...style,
      }}
    >
      <span className="ls-theme-light">{rendered.light}</span>
      <span className="ls-theme-dark">{rendered.dark}</span>
    </span>
  );
}
