import {
  forwardRef,
  useCallback,
  useId,
  useRef,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type TextareaHTMLAttributes,
} from "react";
import { DesktopIcon, type DesktopIconName } from "../icons";
import { cn, isImeComposing } from "./utils";

export interface FieldProps extends HTMLAttributes<HTMLDivElement> {
  label?: ReactNode;
  htmlFor?: string;
  description?: ReactNode;
  error?: ReactNode;
}

export function Field({
  label,
  htmlFor,
  description,
  error,
  className,
  children,
  ...props
}: FieldProps) {
  return (
    <div className={cn("ls-field", className)} {...props}>
      {label ? (
        <label htmlFor={htmlFor} className="ls-field__label">
          {label}
        </label>
      ) : null}
      {children}
      {description && !error ? (
        <p className="ls-field__desc">{description}</p>
      ) : null}
      {error ? (
        <p role="alert" className="ls-field__error">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export interface InputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "size"> {
  size?: "sm" | "md" | "lg";
  leadingIcon?: DesktopIconName | ReactNode;
  trailingSlot?: ReactNode;
  /** IME-safe Enter callback (`ime-safe-enter-submit`). */
  onEnterSubmit?: (event: ReactKeyboardEvent<HTMLInputElement>) => void;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  {
    size = "md",
    leadingIcon,
    trailingSlot,
    onEnterSubmit,
    onKeyDown,
    className,
    disabled,
    ...props
  },
  forwardedRef,
) {
  const innerRef = useRef<HTMLInputElement | null>(null);
  const setRefs = useCallback(
    (node: HTMLInputElement | null) => {
      innerRef.current = node;
      if (typeof forwardedRef === "function") {
        forwardedRef(node);
      } else if (forwardedRef) {
        forwardedRef.current = node;
      }
    },
    [forwardedRef],
  );

  const hasAffix = Boolean(leadingIcon) || Boolean(trailingSlot);

  const inputNode = (
    <input
      ref={setRefs}
      disabled={disabled}
      data-size={size}
      className={cn("ls-input", !hasAffix && className)}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (event.defaultPrevented || !onEnterSubmit) return;
        if (event.key === "Enter" && !isImeComposing(event)) {
          onEnterSubmit(event);
        }
      }}
      {...props}
    />
  );

  if (!hasAffix) {
    return inputNode;
  }

  const isInteractiveChild = (target: EventTarget | null): boolean => {
    if (!(target instanceof Element)) return false;
    return Boolean(
      target.closest(
        'input, button, a, select, textarea, [role="button"], .ls-input-wrap__trailing',
      ),
    );
  };

  const handleShellMouseDown = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (disabled || isInteractiveChild(event.target)) return;
    event.preventDefault();
    innerRef.current?.focus();
  };

  const handleShellClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (disabled || isInteractiveChild(event.target)) return;
    innerRef.current?.focus();
  };

  return (
    <div
      className={cn("ls-input-wrap", className)}
      data-size={size}
      data-disabled={disabled ? "true" : undefined}
      onMouseDown={handleShellMouseDown}
      onClick={handleShellClick}
    >
      {leadingIcon ? (
        <span className="ls-input-wrap__leading" aria-hidden="true">
          {typeof leadingIcon === "string" ? (
            <DesktopIcon name={leadingIcon as DesktopIconName} size="sm" />
          ) : (
            leadingIcon
          )}
        </span>
      ) : null}
      {inputNode}
      {trailingSlot ? (
        <span className="ls-input-wrap__trailing">{trailingSlot}</span>
      ) : null}
    </div>
  );
});

export interface AutoGrowTextareaProps
  extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  /**
   * IME-safe Enter handler (`ime-safe-enter-submit`): fires on bare `Enter` (without `Shift`)
   * ONLY when `!isImeComposing(event)`.
   */
  onEnterSubmit?: (event: ReactKeyboardEvent<HTMLTextAreaElement>) => void;
}

/**
 * Native CSS auto-growing `<textarea>` (`form-fields-automatically-fit-contents` + `ime-safe-enter-submit`):
 * Uses `field-sizing: content` paired with explicit `width: 100%` so horizontal width stays locked
 * while vertical block-size grows cleanly up to `max-block-size` with zero `scrollHeight` layout thrashing.
 */
export const AutoGrowTextarea = forwardRef<
  HTMLTextAreaElement,
  AutoGrowTextareaProps
>(function AutoGrowTextarea(
  { onEnterSubmit, onKeyDown, className, ...props },
  ref,
) {
  return (
    <textarea
      ref={ref}
      className={cn("ls-autogrow-textarea", className)}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (event.defaultPrevented || !onEnterSubmit) return;
        if (
          event.key === "Enter" &&
          !event.shiftKey &&
          !isImeComposing(event)
        ) {
          onEnterSubmit(event);
        }
      }}
      {...props}
    />
  );
});

export interface PairingCodeInputProps
  extends Omit<
    InputHTMLAttributes<HTMLInputElement>,
    "value" | "onChange" | "type" | "maxLength"
  > {
  value: string;
  onValueChange: (code: string) => void;
  label?: ReactNode;
  onComplete?: (code: string) => void;
}

/**
 * Single 6-digit pairing input (`forms` MWG guide):
 * NEVER splits a 6-digit code across 6 separate `<input>` boxes that hijack focus.
 */
export const PairingCodeInput = forwardRef<
  HTMLInputElement,
  PairingCodeInputProps
>(function PairingCodeInput(
  {
    value,
    onValueChange,
    label,
    onComplete,
    className,
    id,
    placeholder = "000000",
    ...props
  },
  ref,
) {
  const generatedId = useId();
  const inputId = id ?? `ls-pair-${generatedId.replace(/[^a-zA-Z0-9_-]/g, "")}`;

  const inputEl = (
    <input
      ref={ref}
      id={inputId}
      type="text"
      inputMode="numeric"
      pattern="[0-9]{6}"
      maxLength={6}
      autoComplete="one-time-code"
      spellCheck={false}
      value={value}
      placeholder={placeholder}
      className={cn("ls-input ls-pairing-code-input", className)}
      onChange={(event) => {
        const digits = event.target.value.replace(/\D+/g, "").slice(0, 6);
        onValueChange(digits);
        if (digits.length === 6) {
          onComplete?.(digits);
        }
      }}
      {...props}
    />
  );

  if (!label) {
    return inputEl;
  }

  return (
    <Field label={label} htmlFor={inputId}>
      {inputEl}
    </Field>
  );
});
