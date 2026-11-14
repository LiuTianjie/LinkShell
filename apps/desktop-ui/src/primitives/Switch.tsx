import {
  forwardRef,
  useId,
  type InputHTMLAttributes,
  type ReactNode,
} from "react";
import { Tooltip } from "./Tooltip";
import { cn } from "./utils";

export interface SwitchProps
  extends Omit<
    InputHTMLAttributes<HTMLInputElement>,
    "type" | "role" | "size" | "onChange"
  > {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label?: ReactNode;
  description?: ReactNode;
  size?: "sm" | "md";
  disabledReason?: ReactNode;
}

/**
 * Semantic Switch (`switch` MWG guide):
 * `<input type="checkbox" switch>` is Safari-only and unsupported in Chromium 152,
 * so we use `<input type="checkbox" role="switch">` with `appearance: none` and `999px` pill track.
 */
export const Switch = forwardRef<HTMLInputElement, SwitchProps>(
  function Switch(
    {
      checked,
      onCheckedChange,
      label,
      description,
      size = "md",
      disabled = false,
      disabledReason,
      className,
      id,
      ...props
    },
    ref,
  ) {
    const generatedId = useId();
    const inputId = id ?? `ls-switch-${generatedId.replace(/[^a-zA-Z0-9_-]/g, "")}`;
    const descId = description ? `${inputId}-desc` : undefined;

    const inputEl = (
      <input
        ref={ref}
        id={inputId}
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        aria-describedby={descId}
        data-size={size}
        className={cn("ls-switch", !label && className)}
        onChange={(event) => {
          onCheckedChange(event.target.checked);
        }}
        {...props}
      />
    );

    const wrappedInput =
      disabled && disabledReason ? (
        <Tooltip content={disabledReason} wrapDisabled>
          {inputEl}
        </Tooltip>
      ) : (
        inputEl
      );

    if (!label && !description) {
      return wrappedInput;
    }

    return (
      <div
        className={cn("ls-switch-row", className)}
        data-disabled={disabled ? "true" : undefined}
      >
        <div className="ls-switch-row__text">
          {label ? (
            <label htmlFor={inputId} className="ls-switch-row__label">
              {label}
            </label>
          ) : null}
          {description ? (
            <p id={descId} className="ls-switch-row__desc">
              {description}
            </p>
          ) : null}
        </div>
        {wrappedInput}
      </div>
    );
  },
);
