import {
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type HTMLAttributes,
  type ReactElement,
  type ReactNode,
} from "react";
import { Kbd } from "./Kbd";
import { cn, mergeRefs, toCssAnchorName } from "./utils";

export type TooltipPlacement = "top" | "bottom" | "left" | "right";

export interface TooltipProps {
  content?: ReactNode;
  shortcut?: string;
  placement?: TooltipPlacement;
  delayMs?: number;
  /**
   * Forces an inline-flex wrapper around disabled controls so hover & keyboard focus
   * still explain why the control is unavailable (`#7` §5.1).
   */
  wrapDisabled?: boolean;
  className?: string;
  children: ReactElement;
}

function supportsInterestInvoker(): boolean {
  return (
    typeof HTMLButtonElement !== "undefined" &&
    "interestForElement" in HTMLButtonElement.prototype
  );
}

export function Tooltip({
  content,
  shortcut,
  placement = "bottom",
  delayMs = 320,
  wrapDisabled,
  className,
  children,
}: TooltipProps) {
  const rawId = useId();
  const tooltipId = `ls-tip-${rawId.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const anchorName = toCssAnchorName(rawId, "ls-tip");
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const anchorRef = useRef<HTMLElement | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [fallbackOpen, setFallbackOpen] = useState(false);

  const childProps = isValidElement(children)
    ? (children.props as Record<string, unknown>)
    : {};
  const childIsDisabled = Boolean(
    wrapDisabled || childProps.disabled || childProps["aria-disabled"] === true,
  );
  const isNativeInterestTag =
    isValidElement(children) &&
    (children.type === "button" || children.type === "a");
  const useDeclarativeInterest =
    !childIsDisabled && isNativeInterestTag && supportsInterestInvoker();

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const showHint = useCallback((immediate = false) => {
    clearTimer();
    const run = () => {
      const pop = popoverRef.current;
      const src = anchorRef.current;
      if (!pop) return;
      if (typeof pop.showPopover === "function") {
        try {
          if (src) {
            pop.showPopover({ source: src });
          } else {
            pop.showPopover();
          }
        } catch {
          // Ignore InvalidStateError if already open or detached.
        }
      }
      setFallbackOpen(true);
    };
    if (immediate || delayMs <= 0) {
      run();
    } else {
      timerRef.current = setTimeout(run, delayMs);
    }
  }, [clearTimer, delayMs]);

  const hideHint = useCallback(() => {
    clearTimer();
    const pop = popoverRef.current;
    if (pop && typeof pop.hidePopover === "function") {
      try {
        pop.hidePopover();
      } catch {
        // Ignore InvalidStateError if already closed.
      }
    }
    setFallbackOpen(false);
  }, [clearTimer]);

  useEffect(() => {
    return () => {
      clearTimer();
    };
  }, [clearTimer]);

  useEffect(() => {
    if (!fallbackOpen) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        hideHint();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [fallbackOpen, hideHint]);

  if (content === null || content === undefined || content === false || content === "") {
    return children;
  }

  const tooltipBubble = (
    <div
      ref={popoverRef}
      id={tooltipId}
      popover="hint"
      role="tooltip"
      data-placement={placement}
      data-state={fallbackOpen ? "open" : "closed"}
      data-open={fallbackOpen ? "true" : undefined}
      style={
        useDeclarativeInterest
          ? undefined
          : ({ positionAnchor: anchorName } as React.CSSProperties)
      }
      className={cn("ls-tooltip", className)}
    >
      <span className="ls-tooltip__text">{content}</span>
      {shortcut ? <Kbd shortcut={shortcut} className="ls-tooltip__kbd" /> : null}
    </div>
  );

  if (childIsDisabled) {
    const clonedDisabled = isValidElement(children)
      ? cloneElement(children as ReactElement<HTMLAttributes<HTMLElement>>, {
          style: {
            ...((childProps.style as React.CSSProperties | undefined) ?? {}),
            pointerEvents: "none",
          },
        })
      : children;

    return (
      <>
        <span
          ref={anchorRef as React.RefObject<HTMLSpanElement | null>}
          className="ls-tooltip-disabled-anchor"
          tabIndex={0}
          aria-describedby={fallbackOpen ? tooltipId : undefined}
          style={{ anchorName } as React.CSSProperties}
          onPointerEnter={() => showHint(false)}
          onPointerLeave={hideHint}
          onFocus={() => showHint(true)}
          onBlur={hideHint}
        >
          {clonedDisabled}
        </span>
        {tooltipBubble}
      </>
    );
  }

  if (useDeclarativeInterest && isValidElement(children)) {
    const existingAria = childProps["aria-describedby"] as string | undefined;
    const mergedAria = existingAria ? `${existingAria} ${tooltipId}` : tooltipId;
    const childRef = childProps.ref as React.Ref<HTMLElement> | undefined;

    return (
      <>
        {cloneElement(
          children as ReactElement<Record<string, unknown>>,
          {
            ref: mergeRefs(anchorRef, childRef),
            interestfor: tooltipId,
            "aria-describedby": mergedAria,
          },
        )}
        {tooltipBubble}
      </>
    );
  }

  if (isValidElement(children)) {
    const childRef = childProps.ref as React.Ref<HTMLElement> | undefined;
    const prevPointerEnter = childProps.onPointerEnter as
      | ((e: React.PointerEvent<HTMLElement>) => void)
      | undefined;
    const prevPointerLeave = childProps.onPointerLeave as
      | ((e: React.PointerEvent<HTMLElement>) => void)
      | undefined;
    const prevFocus = childProps.onFocus as
      | ((e: React.FocusEvent<HTMLElement>) => void)
      | undefined;
    const prevBlur = childProps.onBlur as
      | ((e: React.FocusEvent<HTMLElement>) => void)
      | undefined;
    const existingStyle =
      (childProps.style as React.CSSProperties | undefined) ?? {};

    return (
      <>
        {cloneElement(children as ReactElement<Record<string, unknown>>, {
          ref: mergeRefs(anchorRef, childRef),
          "aria-describedby": fallbackOpen
            ? tooltipId
            : (childProps["aria-describedby"] as string | undefined),
          style: { ...existingStyle, anchorName },
          onPointerEnter: (e: React.PointerEvent<HTMLElement>) => {
            prevPointerEnter?.(e);
            showHint(false);
          },
          onPointerLeave: (e: React.PointerEvent<HTMLElement>) => {
            prevPointerLeave?.(e);
            hideHint();
          },
          onFocus: (e: React.FocusEvent<HTMLElement>) => {
            prevFocus?.(e);
            showHint(true);
          },
          onBlur: (e: React.FocusEvent<HTMLElement>) => {
            prevBlur?.(e);
            hideHint();
          },
        })}
        {tooltipBubble}
      </>
    );
  }

  return children;
}
