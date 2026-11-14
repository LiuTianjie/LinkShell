export {
  ALL_DESKTOP_ICON_GLYPHS,
  DESKTOP_ICON_METRICS,
  DESKTOP_ICON_NAMES,
  DesktopIcon,
  resolveIconMetrics,
  type DesktopIconName,
  type DesktopIconProps,
  type DesktopIconSize,
} from "./DesktopIcon";

export { DOMAIN_ICON_GLYPHS, type DomainIconName } from "./glyphs-domain";
export { UI_ICON_GLYPHS, type UiIconName } from "./glyphs-ui";

export {
  AgentMark,
  normalizeAgentMarkKey,
  type AgentMarkProps,
} from "./AgentMark";

export {
  SubagentGlyph,
  subagentGlyphIndex,
  type SubagentGlyphProps,
  type SubagentSeed,
} from "./SubagentGlyph";

export { renderTrustedSvg, scopeSvgPaintIds } from "./svg-ast";
