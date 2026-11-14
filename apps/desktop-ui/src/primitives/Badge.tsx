import type { HTMLAttributes, ReactNode } from "react";
import { DesktopIcon, type DesktopIconName } from "../icons";
import { StatusDot, type StatusDotTone } from "./StatusDot";
import { cn } from "./utils";

export type BadgeTone =
  | "neutral"
  | "accent"
  | "running"
  | "waiting"
  | "ok"
  | "danger";

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  /**
   * `"tag"` uses crisp `4px` nested rectangle geometry.
   * `"count"` uses `999px` pill geometry with `tabular-nums` strictly for compact numeric counts.
   */
  variant?: "tag" | "count";
  dot?: StatusDotTone;
  icon?: DesktopIconName;
  children: ReactNode;
}

export function Badge({
  tone = "neutral",
  variant = "tag",
  dot,
  icon,
  children,
  className,
  ...props
}: BadgeProps) {
  return (
    <span
      className={cn("ls-badge", className)}
      data-tone={tone}
      data-variant={variant}
      {...props}
    >
      {dot ? <StatusDot tone={dot} size="sm" /> : null}
      {icon ? <DesktopIcon name={icon} size="xs" /> : null}
      <span className="ls-badge__label">{children}</span>
    </span>
  );
}
