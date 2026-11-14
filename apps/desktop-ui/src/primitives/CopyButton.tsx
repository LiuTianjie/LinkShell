import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
} from "react";
import { DesktopIcon } from "../icons";
import { cn } from "./utils";

export interface CopyButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "value" | "onCopy"> {
  value: string | (() => string);
  label?: string;
  copiedLabel?: string;
  /**
   * Hides with `opacity: 0` ONLY (never `display: none` or `visibility: hidden`)
   * so keyboard `Tab` reaches it and parent `:hover` / `:focus-within` reveals it (`copy-button`, `natural-interactions`).
   */
  revealOnHover?: boolean;
  showText?: boolean;
  size?: "sm" | "md";
  onCopied?: (copiedValue: string) => void;
}

export function CopyButton({
  value,
  label = "复制",
  copiedLabel = "已复制",
  revealOnHover = false,
  showText = false,
  size = "sm",
  disabled = false,
  className,
  onClick,
  onCopied,
  ...props
}: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
      }
    };
  }, []);

  const handleCopy = useCallback(async () => {
    const text = typeof value === "function" ? value() : value;
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      }
      setCopied(true);
      onCopied?.(text);
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
      }
      // `#7` §1.1: `ok` green is strictly 1-second transient success feedback.
      timerRef.current = setTimeout(() => {
        setCopied(false);
        timerRef.current = null;
      }, 1000);
    } catch {
      // Clipboard write may fail if denied; leave resting state intact.
    }
  }, [value, onCopied]);

  return (
    <span
      className={cn("ls-copy-wrap", className)}
      data-reveal={revealOnHover ? "hover" : undefined}
    >
      <button
        type="button"
        disabled={disabled}
        aria-label={showText ? undefined : label}
        data-copied={copied ? "true" : undefined}
        data-size={size}
        data-icon-only={!showText ? "true" : undefined}
        className="ls-copy-btn"
        onClick={(event) => {
          onClick?.(event);
          if (event.defaultPrevented || disabled) return;
          void handleCopy();
        }}
        {...props}
      >
        <span className="ls-copy-btn__icon" aria-hidden="true">
          <DesktopIcon name={copied ? "check" : "copy"} size="sm" />
        </span>
        {showText ? (
          <span className="ls-copy-btn__label">
            {copied ? copiedLabel : label}
          </span>
        ) : null}
      </button>

      {/* MWG `copy-button`: live region MUST sit OUTSIDE `<button>` and stay empty until copied! */}
      <span
        role="status"
        aria-live="polite"
        className={cn("ls-copy-status", showText && "ls-sr-only")}
      >
        {copied ? copiedLabel : ""}
      </span>
    </span>
  );
}
