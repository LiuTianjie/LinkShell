import type { HTMLAttributes } from "react";
import { cn } from "./utils";

export type StatusDotTone =
  | "online"
  | "ok"
  | "running"
  | "waiting"
  | "danger"
  | "error"
  | "idle"
  | "offline"
  | "neutral";

export interface StatusDotProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: StatusDotTone;
  size?: "sm" | "md";
  /** Accessible label when the dot conveys status without adjacent text. */
  label?: string;
}

export function StatusDot({
  tone = "neutral",
  size = "sm",
  label,
  className,
  ...props
}: StatusDotProps) {
  const normalizedTone =
    tone === "online"
      ? "ok"
      : tone === "error"
        ? "danger"
        : tone === "offline" || tone === "idle"
          ? "neutral"
          : tone;

  return (
    <span
      className={cn("ls-status-dot", className)}
      data-tone={normalizedTone}
      data-size={size}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      {...props}
    />
  );
}
