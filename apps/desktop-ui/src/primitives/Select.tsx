import {
  forwardRef,
  useId,
  type ReactNode,
  type SelectHTMLAttributes,
} from "react";
import { DesktopIcon, type DesktopIconName } from "../icons";
import { Tooltip } from "./Tooltip";
import { cn } from "./utils";

export interface SelectOptionItem {
  value: string;
  label: string;
  description?: string;
  badge?: string;
  icon?: DesktopIconName | ReactNode;
  disabled?: boolean;
}

export interface SelectProps
  extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "size" | "onChange"> {
  value: string;
  onValueChange: (value: string) => void;
  options: SelectOptionItem[];
  label?: string;
  /** Accessible name when no visible `<label>` is rendered (e.g. composer chips). */
  ariaLabel?: string;
  size?: "sm" | "md" | "chip";
  leadingIcon?: DesktopIconName | ReactNode;
  disabledReason?: ReactNode;
  fullWidth?: boolean;
}

function renderLeadingIcon(icon?: DesktopIconName | ReactNode): ReactNode {
  if (!icon) return null;
  if (typeof icon === "string") {
    return <DesktopIcon name={icon as DesktopIconName} size="sm" />;
  }
  return icon;
}

/**
 * Native Chromium 152 customizable `<select>` (`branded-select-styling` + `animated-select-picker`):
 * Opts both `select.ls-select` and `select.ls-select::picker(select)` into `appearance: base-select`
 * while keeping standard `<option>` text children so React 19 `validateDOMNesting` emits zero warnings.
 */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  function Select(
    {
      value,
      onValueChange,
      options,
      label,
      ariaLabel,
      size = "md",
      leadingIcon,
      disabled = false,
      disabledReason,
      fullWidth = false,
      className,
      id,
      ...props
    },
    ref,
  ) {
    const generatedId = useId();
    const selectId = id ?? `ls-select-${generatedId.replace(/[^a-zA-Z0-9_-]/g, "")}`;
    const selectedOption = options.find((item) => item.value === value);
    const activeIcon = leadingIcon ?? selectedOption?.icon;

    const selectShell = (
      <span
        className={cn("ls-select-wrap", className)}
        data-size={size}
        data-disabled={disabled ? "true" : undefined}
        data-full-width={fullWidth ? "true" : undefined}
      >
        {activeIcon ? (
          <span className="ls-select-wrap__leading" aria-hidden="true">
            {renderLeadingIcon(activeIcon)}
          </span>
        ) : null}
        <select
          ref={ref}
          id={selectId}
          value={value}
          disabled={disabled}
          aria-label={label ? undefined : ariaLabel}
          data-size={size}
          data-has-leading={activeIcon ? "true" : undefined}
          data-full-width={fullWidth ? "true" : undefined}
          className="ls-select"
          onChange={(event) => {
            onValueChange(event.target.value);
          }}
          {...props}
        >
          {options.map((opt) => {
            const optionText = opt.badge
              ? `${opt.label} · ${opt.badge}`
              : opt.label;
            return (
              <option
                key={opt.value}
                value={opt.value}
                disabled={opt.disabled}
                className="ls-select__option"
              >
                {optionText}
              </option>
            );
          })}
        </select>
        <span className="ls-select-wrap__caret" aria-hidden="true">
          <DesktopIcon name="chevron-down" size="xs" />
        </span>
      </span>
    );

    const wrapped =
      disabled && disabledReason ? (
        <Tooltip content={disabledReason} wrapDisabled>
          {selectShell}
        </Tooltip>
      ) : (
        selectShell
      );

    if (!label) {
      return wrapped;
    }

    return (
      <div
        className="ls-field"
        data-full-width={fullWidth ? "true" : undefined}
      >
        <label htmlFor={selectId} className="ls-field__label">
          {label}
        </label>
        {wrapped}
      </div>
    );
  },
);
