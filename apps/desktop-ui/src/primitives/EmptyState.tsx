import type { HTMLAttributes, ReactNode } from "react";
import { DesktopIcon, type DesktopIconName } from "../icons";
import { cn } from "./utils";

export interface EmptyStateProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  icon?: DesktopIconName;
  iconNode?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  hint?: ReactNode;
  compact?: boolean;
}

export function EmptyState({
  icon,
  iconNode,
  title,
  description,
  actions,
  hint,
  compact = false,
  className,
  ...props
}: EmptyStateProps) {
  return (
    <div
      className={cn("ls-empty-state", className)}
      data-compact={compact || undefined}
      {...props}
    >
      {iconNode || icon ? (
        <div className="ls-empty-state__icon" aria-hidden="true">
          {iconNode ?? (icon ? <DesktopIcon name={icon} size="xl" /> : null)}
        </div>
      ) : null}
      <h3 className="ls-empty-state__title">{title}</h3>
      {description ? (
        <p className="ls-empty-state__description">{description}</p>
      ) : null}
      {actions ? <div className="ls-empty-state__actions">{actions}</div> : null}
      {hint ? <div className="ls-empty-state__hint">{hint}</div> : null}
    </div>
  );
}
