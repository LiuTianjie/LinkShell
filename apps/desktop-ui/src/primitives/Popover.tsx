import {
  cloneElement,
  createContext,
  isValidElement,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type HTMLAttributes,
  type ReactElement,
  type ReactNode,
} from "react";
import { registerOverlayOpen } from "../bridge/top-layer-registry";
import { cn, mergeRefs, toCssAnchorName } from "./utils";

export type PopoverPlacement =
  | "bottom-start"
  | "bottom"
  | "bottom-end"
  | "top-start"
  | "top"
  | "top-end"
  | "right-start"
  | "left-start";

interface PopoverContextValue {
  popoverId: string;
  anchorName: `--${string}`;
  open: boolean;
  setOpen: (next: boolean) => void;
  triggerRef: React.RefObject<HTMLElement | null>;
  contentRef: React.RefObject<HTMLDivElement | null>;
  useNativePopoverApi: boolean;
}

const PopoverContext = createContext<PopoverContextValue | null>(null);

function hasNativePopoverMethods(el: HTMLElement | null): boolean {
  return Boolean(el && typeof el.showPopover === "function");
}

export interface PopoverProps {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: ReactNode;
}

export function Popover({
  open: controlledOpen,
  defaultOpen = false,
  onOpenChange,
  children,
}: PopoverProps) {
  const rawId = useId();
  const popoverId = `ls-pop-${rawId.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const anchorName = toCssAnchorName(rawId, "ls-pop");
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : uncontrolledOpen;

  const triggerRef = useRef<HTMLElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const onOpenChangeRef = useRef(onOpenChange);
  onOpenChangeRef.current = onOpenChange;

  const useNativePopoverApi =
    typeof HTMLElement !== "undefined" &&
    typeof HTMLElement.prototype.showPopover === "function";

  const setOpen = useCallback(
    (next: boolean) => {
      if (!isControlled) {
        setUncontrolledOpen(next);
      }
      onOpenChangeRef.current?.(next);
    },
    [isControlled],
  );

  // Register open `popover="auto"` with `TopLayerRegistry` so macOS Metal screen yields (`@host-bridge` §4.2).
  useEffect(() => {
    if (!open) return undefined;
    return registerOverlayOpen(popoverId);
  }, [open, popoverId]);

  // Synchronize imperative Popover API with controlled/uncontrolled React state.
  useEffect(() => {
    const el = contentRef.current;
    if (!el || !hasNativePopoverMethods(el)) return;
    const currentlyOpen = el.matches(":popover-open");
    if (open && !currentlyOpen) {
      try {
        if (triggerRef.current) {
          el.showPopover({ source: triggerRef.current });
        } else {
          el.showPopover();
        }
      } catch {
        // Ignore InvalidStateError when detached.
      }
    } else if (!open && currentlyOpen) {
      try {
        el.hidePopover();
      } catch {
        // Ignore InvalidStateError.
      }
    }
  }, [open]);

  // Fallback light-dismiss & Escape ONLY for test environments (`jsdom`) lacking native Popover API.
  useEffect(() => {
    if (!open || useNativePopoverApi) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (contentRef.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        triggerRef.current?.focus({ preventScroll: true });
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open, setOpen, useNativePopoverApi]);

  const ctx = useMemo<PopoverContextValue>(
    () => ({
      popoverId,
      anchorName,
      open,
      setOpen,
      triggerRef,
      contentRef,
      useNativePopoverApi,
    }),
    [popoverId, anchorName, open, setOpen, useNativePopoverApi],
  );

  return (
    <PopoverContext.Provider value={ctx}>{children}</PopoverContext.Provider>
  );
}

export interface PopoverTriggerProps {
  children: ReactElement;
}

export function PopoverTrigger({ children }: PopoverTriggerProps) {
  const ctx = useContext(PopoverContext);
  if (!ctx) {
    throw new Error("<PopoverTrigger> must be used inside <Popover>");
  }

  if (!isValidElement(children)) {
    return children;
  }

  const childProps = children.props as Record<string, unknown>;
  const childRef = childProps.ref as React.Ref<HTMLElement> | undefined;
  const prevOnClick = childProps.onClick as
    | ((e: React.MouseEvent<HTMLElement>) => void)
    | undefined;
  const prevStyle =
    (childProps.style as React.CSSProperties | undefined) ?? {};

  return cloneElement(children as ReactElement<Record<string, unknown>>, {
    ref: mergeRefs(ctx.triggerRef, childRef),
    "aria-expanded": ctx.open,
    "aria-controls": ctx.popoverId,
    style: { ...prevStyle, anchorName: ctx.anchorName },
    // Do NOT combine `popovertarget` and `commandfor` (`declarative-dialog-popover-control`).
    onClick: (event: React.MouseEvent<HTMLElement>) => {
      prevOnClick?.(event);
      if (event.defaultPrevented) return;
      ctx.setOpen(!ctx.open);
    },
  });
}

export interface PopoverContentProps extends HTMLAttributes<HTMLDivElement> {
  placement?: PopoverPlacement;
  matchTriggerWidth?: boolean;
}

export function PopoverContent({
  placement = "bottom-start",
  matchTriggerWidth = false,
  className,
  style,
  children,
  ...props
}: PopoverContentProps) {
  const ctx = useContext(PopoverContext);
  if (!ctx) {
    throw new Error("<PopoverContent> must be used inside <Popover>");
  }

  return (
    <div
      ref={ctx.contentRef}
      id={ctx.popoverId}
      popover={ctx.useNativePopoverApi ? "auto" : undefined}
      data-placement={placement}
      data-state={ctx.open ? "open" : "closed"}
      data-match-width={matchTriggerWidth ? "true" : undefined}
      style={
        {
          positionAnchor: ctx.anchorName,
          ...style,
        } as React.CSSProperties
      }
      className={cn("ls-popover", className)}
      onToggle={(event) => {
        const nextState = (event as unknown as { newState?: string }).newState;
        if (nextState === "open") {
          ctx.setOpen(true);
        } else if (nextState === "closed") {
          ctx.setOpen(false);
        }
      }}
      {...props}
    >
      {ctx.open ? children : null}
    </div>
  );
}

export function usePopoverClose(): () => void {
  const ctx = useContext(PopoverContext);
  return useCallback(() => {
    ctx?.setOpen(false);
  }, [ctx]);
}
