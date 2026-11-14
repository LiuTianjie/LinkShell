import type { CSSProperties, SVGProps } from "react";
import { DOMAIN_ICON_GLYPHS, type DomainIconName } from "./glyphs-domain";
import { UI_ICON_GLYPHS, type UiIconName } from "./glyphs-ui";

export const ALL_DESKTOP_ICON_GLYPHS = {
  ...DOMAIN_ICON_GLYPHS,
  ...UI_ICON_GLYPHS,
} as const;

export type DesktopIconName = DomainIconName | UiIconName;
export type DesktopIconSize = "xs" | "sm" | "md" | "lg" | "xl";

export const DESKTOP_ICON_NAMES = Object.freeze(
  Object.keys(ALL_DESKTOP_ICON_GLYPHS) as DesktopIconName[],
);

/**
 * Optical size and stroke calibration matrix:
 * Smaller glyphs open counter-spaces with slightly firmer strokes; larger display
 * marks refine stroke weight so empty-state icons never look heavy or cartoonish.
 */
export const DESKTOP_ICON_METRICS: Record<
  DesktopIconSize,
  { readonly px: number; readonly strokeWidth: number }
> = {
  xs: { px: 12, strokeWidth: 2.0 },
  sm: { px: 16, strokeWidth: 1.75 },
  md: { px: 18, strokeWidth: 1.65 },
  lg: { px: 20, strokeWidth: 1.55 },
  xl: { px: 28, strokeWidth: 1.4 },
};

export function resolveIconMetrics(size: DesktopIconSize | number = "sm"): {
  px: number;
  strokeWidth: number;
} {
  if (typeof size === "string") {
    return DESKTOP_ICON_METRICS[size];
  }
  const px = Math.max(10, Math.round(size));
  const strokeWidth =
    px <= 13 ? 2.0 : px <= 16 ? 1.75 : px <= 18 ? 1.65 : px <= 22 ? 1.55 : 1.4;
  return { px, strokeWidth };
}

export interface DesktopIconProps
  extends Omit<SVGProps<SVGSVGElement>, "name" | "children"> {
  name: DesktopIconName;
  size?: DesktopIconSize | number;
  className?: string;
  title?: string;
  style?: CSSProperties;
}

export function DesktopIcon({
  name,
  size = "sm",
  className,
  title,
  style,
  ...rest
}: DesktopIconProps) {
  const { px, strokeWidth } = resolveIconMetrics(size);
  const glyph = ALL_DESKTOP_ICON_GLYPHS[name];
  const classes = [
    "ls-desktop-icon",
    name === "spinner" ? "ls-icon-spin" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  const hasTitle = Boolean(title && title.trim().length > 0);

  return (
    <svg
      viewBox="0 0 24 24"
      width={px}
      height={px}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      focusable="false"
      role={hasTitle ? "img" : undefined}
      aria-label={hasTitle ? title : undefined}
      aria-hidden={hasTitle ? undefined : "true"}
      data-icon={name}
      data-icon-size={typeof size === "string" ? size : `${px}`}
      className={classes}
      style={{ flexShrink: 0, ...style }}
      {...rest}
    >
      {hasTitle ? <title>{title}</title> : null}
      {glyph}
    </svg>
  );
}
