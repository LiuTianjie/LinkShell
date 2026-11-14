import { useId, useMemo, type CSSProperties } from "react";
import { agentMarks } from "../../../client/src/theme/agent-marks";
import { resolveIconMetrics, type DesktopIconSize } from "./DesktopIcon";
import { renderTrustedSvg } from "./svg-ast";

const AGENT_KEY_ALIASES: Record<string, string> = {
  claude: "claude",
  "claude-code": "claude",
  anthropic: "claude",
  codex: "codex",
  "codex-cli": "codex",
  openai: "codex",
  gemini: "gemini",
  "gemini-cli": "gemini",
  google: "gemini",
  cursor: "cursor",
  "cursor-agent": "cursor",
  opencode: "opencode",
  copilot: "copilot",
  "github-copilot": "copilot",
  grok: "grok",
  xai: "grok",
  antigravity: "antigravity",
  agy: "antigravity",
};

export function normalizeAgentMarkKey(agent: string): string {
  const cleaned = agent.trim().toLowerCase();
  return AGENT_KEY_ALIASES[cleaned] ?? cleaned;
}

function adaptAgentGlyphMarkup(
  rawSvg: string,
  full: boolean,
  inkColor: string,
): string {
  let svg = rawSvg.replaceAll("currentColor", inkColor);
  if (full) {
    // Strip opaque white app-icon backing rect on full marks so bare desktop glyphs float cleanly
    svg = svg
      .replace(/<path[^>]*fill="#fff"[^>]*><\/path>/gi, "")
      .replace(/<path[^>]*fill="#fff"[^>]*\/>/gi, "")
      .replaceAll("#1E1E2E", inkColor);
  }
  return svg;
}

export interface AgentMarkProps {
  agent: string;
  size?: DesktopIconSize | number;
  className?: string;
  variant?: "glyph" | "tile";
  style?: CSSProperties;
}

/**
 * Official agent brand mark (`apps/client/src/theme/agent-marks.ts`), rendered as an inline
 * theme-reactive SVG with `useId()`-scoped gradient definitions and a clean monogram fallback
 * for custom ACP agents.
 */
export function AgentMark({
  agent,
  size = "md",
  className,
  variant = "glyph",
  style,
}: AgentMarkProps) {
  const { px } = resolveIconMetrics(size);
  const instanceId = useId();
  const normalized = normalizeAgentMarkKey(agent);
  const mark = agentMarks[normalized];

  const rendered = useMemo(() => {
    if (!mark) return null;
    const svgSize = variant === "tile" && !mark.full ? Math.round(px * 0.72) : px;
    const lightInk = variant === "tile" ? (mark.fg?.light ?? "#14161a") : "#14161a";
    const darkInk = variant === "tile" ? (mark.fg?.dark ?? "#eceef2") : "#eceef2";

    const lightMarkup =
      variant === "tile"
        ? mark.svg.replaceAll("currentColor", lightInk)
        : adaptAgentGlyphMarkup(mark.svg, mark.full, lightInk);
    const darkMarkup =
      variant === "tile"
        ? mark.svg.replaceAll("currentColor", darkInk)
        : adaptAgentGlyphMarkup(mark.svg, mark.full, darkInk);

    return {
      light: renderTrustedSvg(lightMarkup, `ls-agent-${instanceId}-l`, {
        width: svgSize,
        height: svgSize,
        focusable: "false",
        "aria-hidden": "true",
      }),
      dark: renderTrustedSvg(darkMarkup, `ls-agent-${instanceId}-d`, {
        width: svgSize,
        height: svgSize,
        focusable: "false",
        "aria-hidden": "true",
      }),
    };
  }, [mark, px, variant, instanceId]);

  const classes = ["ls-agent-mark", `ls-agent-${normalized}`, className ?? ""]
    .filter(Boolean)
    .join(" ");

  if (!mark || !rendered) {
    const initial = (agent.trim()[0] ?? "A").toUpperCase();
    return (
      <span
        aria-hidden="true"
        data-agent={normalized}
        className={classes}
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          inlineSize: px,
          blockSize: px,
          borderRadius: Math.max(4, Math.round(px * 0.22)),
          backgroundColor: "var(--ls-inset)",
          border: "1px solid var(--ls-border-strong)",
          color: "var(--ls-fg-2)",
          fontSize: Math.max(9, Math.round(px * 0.56)),
          fontWeight: 600,
          lineHeight: 1,
          flexShrink: 0,
          userSelect: "none",
          ...style,
        }}
      >
        {initial}
      </span>
    );
  }

  const tileBackground =
    variant === "tile" && mark.bg
      ? `light-dark(${mark.bg.light}, ${mark.bg.dark})`
      : undefined;

  return (
    <span
      aria-hidden="true"
      data-agent={normalized}
      data-variant={variant}
      className={classes}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        inlineSize: px,
        blockSize: px,
        borderRadius: variant === "tile" ? Math.max(4, Math.round(px * 0.22)) : undefined,
        backgroundColor: tileBackground,
        overflow: variant === "tile" && mark.full ? "clip" : undefined,
        flexShrink: 0,
        ...style,
      }}
    >
      <span className="ls-theme-light">{rendered.light}</span>
      <span className="ls-theme-dark">{rendered.dark}</span>
    </span>
  );
}
