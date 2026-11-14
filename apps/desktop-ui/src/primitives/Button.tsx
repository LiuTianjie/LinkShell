import {
  forwardRef,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";
import { DesktopIcon, type DesktopIconName } from "../icons";
import { Kbd } from "./Kbd";
import { Tooltip, type TooltipPlacement } from "./Tooltip";
import { cn } from "./utils";

export type ButtonVariant =
  | "primary"
  | "secondary"
  | "outline"
  | "ghost"
  | "subtle"
  | "danger"
  | "danger-ghost";

export type ButtonSize =
  | "xs"
  | "sm"
  | "md"
  | "lg"
  | "icon-sm"
  | "icon"
  | "composer-action";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a crisp stroke spinner while preserving resting button width (`#7` §5.1). */
  loading?: boolean;
  /** Optional text replacement while loading (e.g. `"连接中…"` in Fusion Mode). */
  loadingLabel?: ReactNode;
  leadingIcon?: DesktopIconName | ReactNode;
  trailingIcon?: DesktopIconName | ReactNode;
  shortcut?: string;
  /** Tooltip shown when the button is enabled. */
  tooltip?: ReactNode;
  /**
   * Explains why a disabled control is unavailable via a `popover="hint"` tooltip (`#7` §5.1).
   */
  disabledReason?: ReactNode;
  tooltipPlacement?: TooltipPlacement;
}

function renderButtonIcon(
  icon: DesktopIconName | ReactNode | undefined,
  size: ButtonSize,
): ReactNode {
  if (!icon) return null;
  if (typeof icon === "string") {
    const iconSize = size === "xs" ? "xs" : "sm";
    return <DesktopIcon name={icon as DesktopIconName} size={iconSize} />;
  }
  return icon;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    {
      variant = "secondary",
      size = "md",
      type = "button",
      loading = false,
      loadingLabel,
      leadingIcon,
      trailingIcon,
      shortcut,
      tooltip,
      disabledReason,
      tooltipPlacement = "bottom",
      disabled,
      className,
      children,
      onClick,
      ...props
    },
    ref,
  ) {
    const normalizedVariant = variant === "outline" ? "secondary" : variant;
    const isDisabled = Boolean(disabled || loading);
    const preserveHiddenContentWidth = loading && loadingLabel === undefined;
    const isIconSize =
      size === "icon-sm" || size === "icon" || size === "composer-action";

    const buttonEl = (
      <button
        ref={ref}
        type={type}
        disabled={isDisabled}
        aria-busy={loading || undefined}
        data-variant={normalizedVariant}
        data-size={size}
        data-loading={loading ? "true" : undefined}
        className={cn("ls-btn", className)}
        onClick={(event) => {
          if (isDisabled) {
            event.preventDefault();
            return;
          }
          onClick?.(event);
        }}
        {...props}
      >
        {loading && loadingLabel !== undefined ? (
          <span className="ls-btn__body">
            <span className="ls-btn__spinner ls-btn__spinner--inline" aria-hidden="true" />
            <span className="ls-btn__label">{loadingLabel}</span>
          </span>
        ) : (
          <>
            <span
              className="ls-btn__body"
              data-hidden-keep-width={preserveHiddenContentWidth ? "true" : undefined}
            >
              {leadingIcon ? (
                <span className="ls-btn__icon" aria-hidden="true">
                  {renderButtonIcon(leadingIcon, size)}
                </span>
              ) : null}
              {children !== undefined && children !== null ? (
                <span className="ls-btn__label">{children}</span>
              ) : null}
              {trailingIcon ? (
                <span className="ls-btn__icon" aria-hidden="true">
                  {renderButtonIcon(trailingIcon, size)}
                </span>
              ) : null}
              {shortcut && !isIconSize ? (
                <Kbd shortcut={shortcut} className="ls-btn__kbd" />
              ) : null}
            </span>
            {preserveHiddenContentWidth ? (
              <span className="ls-btn__spinner-overlay" aria-hidden="true">
                <span className="ls-btn__spinner" />
              </span>
            ) : null}
          </>
        )}
      </button>
    );

    const activeTooltip = disabled && disabledReason ? disabledReason : tooltip;
    if (activeTooltip) {
      return (
        <Tooltip
          content={activeTooltip}
          shortcut={disabled && disabledReason ? undefined : shortcut}
          placement={tooltipPlacement}
          wrapDisabled={isDisabled}
        >
          {buttonEl}
        </Tooltip>
      );
    }

    return buttonEl;
  },
);

export interface IconButtonProps
  extends Omit<ButtonProps, "children" | "leadingIcon" | "trailingIcon" | "size"> {
  icon: DesktopIconName | ReactNode;
  label: string;
  size?: "icon-sm" | "icon" | "composer-action";
  hideTooltip?: boolean;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  function IconButton(
    {
      icon,
      label,
      size = "icon-sm",
      variant = "ghost",
      tooltip,
      hideTooltip = false,
      ...props
    },
    ref,
  ) {
    return (
      <Button
        ref={ref}
        variant={variant}
        size={size}
        aria-label={label}
        leadingIcon={icon}
        tooltip={hideTooltip ? undefined : (tooltip ?? label)}
        {...props}
      />
    );
  },
);
