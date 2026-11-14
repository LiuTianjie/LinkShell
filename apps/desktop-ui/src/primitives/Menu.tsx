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
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import {
  isElectronDesktop,
  showNativeContextMenu,
  type NativeContextMenuItem,
} from "../bridge/desktop-bridge";
import { registerOverlayOpen } from "../bridge/top-layer-registry";
import { DesktopIcon, type DesktopIconName } from "../icons";
import { Kbd } from "./Kbd";
import type { PopoverPlacement } from "./Popover";
import { Tooltip } from "./Tooltip";
import { cn, mergeRefs, toCssAnchorName } from "./utils";

interface MenuContextValue {
  closeMenu: () => void;
}

const MenuContext = createContext<MenuContextValue | null>(null);

function renderMenuIcon(icon?: DesktopIconName | ReactNode): ReactNode {
  if (!icon) return null;
  if (typeof icon === "string") {
    return <DesktopIcon name={icon as DesktopIconName} size="sm" />;
  }
  return icon;
}

function getEnabledMenuItems(menuEl: HTMLElement): HTMLElement[] {
  return Array.from(
    menuEl.querySelectorAll<HTMLElement>(
      '[role="menuitem"]:not(:disabled), [role="menuitemcheckbox"]:not(:disabled), [role="menuitemradio"]:not(:disabled)',
    ),
  );
}

function handleFallbackRovingKeys(
  event: ReactKeyboardEvent<HTMLElement>,
  items: HTMLElement[],
  prevKey: string,
  nextKey: string,
  wrap = true,
): void {
  if (
    event.defaultPrevented ||
    event.metaKey ||
    event.ctrlKey ||
    event.altKey ||
    items.length === 0
  ) {
    return;
  }
  // In Chromium 150+, native `focusgroup` handles roving focus natively; only step in if unhandled.
  if ("focusgroup" in HTMLElement.prototype) return;

  const active = document.activeElement as HTMLElement | null;
  const currentIndex = active ? items.indexOf(active) : -1;

  if (event.key === nextKey) {
    event.preventDefault();
    const nextIndex =
      currentIndex < 0
        ? 0
        : currentIndex + 1 < items.length
          ? currentIndex + 1
          : wrap
            ? 0
            : items.length - 1;
    items[nextIndex]?.focus();
  } else if (event.key === prevKey) {
    event.preventDefault();
    const prevIndex =
      currentIndex < 0
        ? items.length - 1
        : currentIndex - 1 >= 0
          ? currentIndex - 1
          : wrap
            ? items.length - 1
            : 0;
    items[prevIndex]?.focus();
  } else if (event.key === "Home") {
    event.preventDefault();
    items[0]?.focus();
  } else if (event.key === "End") {
    event.preventDefault();
    items[items.length - 1]?.focus();
  }
}

export interface MenuProps {
  trigger: ReactElement;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  placement?: PopoverPlacement;
  label?: string;
  className?: string;
  children: ReactNode;
}

export function Menu({
  trigger,
  open: controlledOpen,
  defaultOpen = false,
  onOpenChange,
  placement = "bottom-start",
  label,
  className,
  children,
}: MenuProps) {
  const rawId = useId();
  const popoverId = `ls-menu-${rawId.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const anchorName = toCssAnchorName(rawId, "ls-menu");
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : uncontrolledOpen;

  const triggerRef = useRef<HTMLElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const menuListRef = useRef<HTMLDivElement | null>(null);
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

  const closeMenu = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus({ preventScroll: true });
  }, [setOpen]);

  useEffect(() => {
    if (!open) return undefined;
    return registerOverlayOpen(popoverId);
  }, [open, popoverId]);

  useEffect(() => {
    const pop = popoverRef.current;
    if (!pop) return;
    if (useNativePopoverApi) {
      const isPopOpen = pop.matches(":popover-open");
      if (open && !isPopOpen) {
        try {
          if (triggerRef.current) {
            pop.showPopover({ source: triggerRef.current });
          } else {
            pop.showPopover();
          }
        } catch {
          // Ignore detached errors.
        }
      } else if (!open && isPopOpen) {
        try {
          pop.hidePopover();
        } catch {
          // Ignore already-closed errors.
        }
      }
    }
    if (open && menuListRef.current) {
      const preferred =
        menuListRef.current.querySelector<HTMLElement>("[focusgroupstart]") ??
        getEnabledMenuItems(menuListRef.current)[0];
      preferred?.focus({ preventScroll: true });
    }
  }, [open, useNativePopoverApi]);

  useEffect(() => {
    if (!open || useNativePopoverApi) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (popoverRef.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeMenu();
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open, useNativePopoverApi, setOpen, closeMenu]);

  const triggerProps = isValidElement(trigger)
    ? (trigger.props as Record<string, unknown>)
    : {};
  const triggerRefProp = triggerProps.ref as React.Ref<HTMLElement> | undefined;
  const prevOnClick = triggerProps.onClick as
    | ((e: React.MouseEvent<HTMLElement>) => void)
    | undefined;
  const prevKeyDown = triggerProps.onKeyDown as
    | ((e: React.KeyboardEvent<HTMLElement>) => void)
    | undefined;
  const prevStyle =
    (triggerProps.style as React.CSSProperties | undefined) ?? {};

  const ctx = useMemo<MenuContextValue>(() => ({ closeMenu }), [closeMenu]);

  return (
    <MenuContext.Provider value={ctx}>
      {isValidElement(trigger)
        ? cloneElement(trigger as ReactElement<Record<string, unknown>>, {
            ref: mergeRefs(triggerRef, triggerRefProp),
            "aria-haspopup": "menu",
            "aria-expanded": open,
            "aria-controls": popoverId,
            style: { ...prevStyle, anchorName },
            onClick: (event: React.MouseEvent<HTMLElement>) => {
              prevOnClick?.(event);
              if (event.defaultPrevented) return;
              setOpen(!open);
            },
            onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => {
              prevKeyDown?.(event);
              if (event.defaultPrevented) return;
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                setOpen(true);
              }
            },
          })
        : trigger}
      <div
        ref={popoverRef}
        id={popoverId}
        popover={useNativePopoverApi ? "auto" : undefined}
        data-placement={placement}
        data-state={open ? "open" : "closed"}
        style={{ positionAnchor: anchorName } as React.CSSProperties}
        className={cn("ls-popover ls-menu-popover", className)}
        onToggle={(event) => {
          const nextState = (event as unknown as { newState?: string })
            .newState;
          if (nextState === "open") setOpen(true);
          else if (nextState === "closed") setOpen(false);
        }}
      >
        {/* MWG `menu` rule: `focusgroup="menu nomemory"` MUST be nested inside `[popover]`, never on `[popover]` itself. */}
        <div
          ref={menuListRef}
          role="menu"
          aria-label={label}
          focusgroup="menu nomemory"
          className="ls-menu"
          onKeyDown={(event) => {
            if (!menuListRef.current) return;
            handleFallbackRovingKeys(
              event,
              getEnabledMenuItems(menuListRef.current),
              "ArrowUp",
              "ArrowDown",
              false,
            );
          }}
        >
          {open ? children : null}
        </div>
      </div>
    </MenuContext.Provider>
  );
}

export type NativeContextMenuOption = NativeContextMenuItem;

export interface ContextMenuProps {
  children: ReactElement;
  label?: string;
  /**
   * Optional OS-native menu builder (`invoke("contextMenu")` in Electron).
   * When provided and running inside Electron, pops a native NSMenu / Win32 menu at pointer coordinates;
   * otherwise opens the DOM Top-Layer `[popover="auto"]` menu anchored via a zero-size `position: fixed` placeholder (`menu` MWG guide).
   */
  nativeItems?: () => NativeContextMenuOption[];
  onNativeSelect?: (id: string) => void;
  menu?: ReactNode;
  className?: string;
}

export function ContextMenu({
  children,
  label,
  nativeItems,
  onNativeSelect,
  menu,
  className,
}: ContextMenuProps) {
  const rawId = useId();
  const popoverId = `ls-ctx-${rawId.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const anchorName = toCssAnchorName(rawId, "ls-ctx");
  const placeholderRef = useRef<HTMLSpanElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const menuListRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [openSeq, setOpenSeq] = useState(0);

  const useNativePopoverApi =
    typeof HTMLElement !== "undefined" &&
    typeof HTMLElement.prototype.showPopover === "function";

  const closeMenu = useCallback(() => {
    const pop = popoverRef.current;
    if (pop && useNativePopoverApi && pop.matches(":popover-open")) {
      try {
        pop.hidePopover();
      } catch {
        // Ignore.
      }
    }
    setOpen(false);
  }, [useNativePopoverApi]);

  useEffect(() => {
    if (!open) return undefined;
    return registerOverlayOpen(popoverId);
  }, [open, popoverId]);

  useEffect(() => {
    const pop = popoverRef.current;
    if (!pop) return;
    if (useNativePopoverApi) {
      if (open) {
        try {
          if (pop.matches(":popover-open")) {
            pop.hidePopover();
          }
          pop.showPopover(
            placeholderRef.current
              ? { source: placeholderRef.current }
              : undefined,
          );
        } catch {
          // Ignore detached errors.
        }
      } else if (pop.matches(":popover-open")) {
        try {
          pop.hidePopover();
        } catch {
          // Ignore already-closed errors.
        }
      }
    }
    if (open && menuListRef.current) {
      getEnabledMenuItems(menuListRef.current)[0]?.focus({
        preventScroll: true,
      });
    }
  }, [open, openSeq, useNativePopoverApi]);

  useEffect(() => {
    if (!open || useNativePopoverApi) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && popoverRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open, useNativePopoverApi]);

  const ctx = useMemo<MenuContextValue>(() => ({ closeMenu }), [closeMenu]);

  const childProps = isValidElement(children)
    ? (children.props as Record<string, unknown>)
    : {};
  const prevContextMenu = childProps.onContextMenu as
    | ((e: React.MouseEvent<HTMLElement>) => void)
    | undefined;

  return (
    <MenuContext.Provider value={ctx}>
      {isValidElement(children)
        ? cloneElement(children as ReactElement<Record<string, unknown>>, {
            onContextMenu: async (event: React.MouseEvent<HTMLElement>) => {
              prevContextMenu?.(event);
              if (event.defaultPrevented) return;
              event.preventDefault();

              if (nativeItems && (isElectronDesktop || !menu)) {
                const items = nativeItems();
                const chosen = await showNativeContextMenu(items, {
                  x: event.clientX,
                  y: event.clientY,
                });
                if (chosen) {
                  onNativeSelect?.(chosen);
                }
                return;
              }

              const placeholder = placeholderRef.current;
              if (placeholder) {
                placeholder.style.left = `${event.clientX}px`;
                placeholder.style.top = `${event.clientY}px`;
              }
              setOpen(true);
              setOpenSeq((seq) => seq + 1);
            },
          })
        : children}

      {menu ? (
        <>
          <span
            ref={placeholderRef}
            aria-hidden="true"
            className="ls-menu-point-anchor"
            style={{ anchorName } as React.CSSProperties}
          />
          <div
            ref={popoverRef}
            id={popoverId}
            popover={useNativePopoverApi ? "auto" : undefined}
            data-placement="bottom-start"
            data-state={open ? "open" : "closed"}
            style={{ positionAnchor: anchorName } as React.CSSProperties}
            className={cn("ls-popover ls-menu-popover", className)}
            onToggle={(event) => {
              const nextState = (event as unknown as { newState?: string })
                .newState;
              if (nextState === "open") setOpen(true);
              else if (nextState === "closed") setOpen(false);
            }}
          >
            <div
              ref={menuListRef}
              role="menu"
              aria-label={label}
              focusgroup="menu nomemory"
              className="ls-menu"
              onKeyDown={(event) => {
                if (!menuListRef.current) return;
                handleFallbackRovingKeys(
                  event,
                  getEnabledMenuItems(menuListRef.current),
                  "ArrowUp",
                  "ArrowDown",
                  false,
                );
              }}
            >
              {open ? menu : null}
            </div>
          </div>
        </>
      ) : null}
    </MenuContext.Provider>
  );
}

export interface MenuItemProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onSelect"> {
  icon?: DesktopIconName | ReactNode;
  shortcut?: string;
  destructive?: boolean;
  disabledReason?: ReactNode;
  keepOpen?: boolean;
  defaultFocused?: boolean;
  onSelect?: () => void;
}

export function MenuItem({
  icon,
  shortcut,
  destructive = false,
  disabled = false,
  disabledReason,
  keepOpen = false,
  defaultFocused = false,
  className,
  children,
  onClick,
  onSelect,
  ...props
}: MenuItemProps) {
  const ctx = useContext(MenuContext);

  const item = (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      focusgroupstart={defaultFocused ? "" : undefined}
      data-destructive={destructive ? "true" : undefined}
      className={cn("ls-menu__item", className)}
      onClick={(event) => {
        if (disabled) {
          event.preventDefault();
          return;
        }
        onClick?.(event);
        onSelect?.();
        if (!keepOpen) {
          ctx?.closeMenu();
        }
      }}
      {...props}
    >
      {icon ? (
        <span className="ls-menu__icon" aria-hidden="true">
          {renderMenuIcon(icon)}
        </span>
      ) : null}
      <span className="ls-menu__item-label">{children}</span>
      {shortcut ? <Kbd shortcut={shortcut} className="ls-menu__kbd" /> : null}
    </button>
  );

  if (disabled && disabledReason) {
    return (
      <Tooltip content={disabledReason} placement="right" wrapDisabled>
        {item}
      </Tooltip>
    );
  }
  return item;
}

export interface MenuCheckboxItemProps
  extends Omit<MenuItemProps, "onSelect"> {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}

export function MenuCheckboxItem({
  checked,
  onCheckedChange,
  icon,
  shortcut,
  disabled = false,
  keepOpen = false,
  className,
  children,
  ...props
}: MenuCheckboxItemProps) {
  const ctx = useContext(MenuContext);
  return (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={checked}
      disabled={disabled}
      className={cn("ls-menu__item ls-menu__item--checkable", className)}
      onClick={() => {
        if (disabled) return;
        onCheckedChange(!checked);
        if (!keepOpen) ctx?.closeMenu();
      }}
      {...props}
    >
      <span className="ls-menu__check" aria-hidden="true">
        {checked ? <DesktopIcon name="check" size="xs" /> : null}
      </span>
      {icon ? (
        <span className="ls-menu__icon" aria-hidden="true">
          {renderMenuIcon(icon)}
        </span>
      ) : null}
      <span className="ls-menu__item-label">{children}</span>
      {shortcut ? <Kbd shortcut={shortcut} className="ls-menu__kbd" /> : null}
    </button>
  );
}

interface MenuRadioGroupContextValue {
  value: string;
  onValueChange: (value: string) => void;
}

const MenuRadioContext = createContext<MenuRadioGroupContextValue | null>(null);

export interface MenuRadioGroupProps extends HTMLAttributes<HTMLDivElement> {
  value: string;
  onValueChange: (value: string) => void;
  label?: string;
}

export function MenuRadioGroup({
  value,
  onValueChange,
  label,
  className,
  children,
  ...props
}: MenuRadioGroupProps) {
  const radioCtx = useMemo(
    () => ({ value, onValueChange }),
    [value, onValueChange],
  );
  return (
    <MenuRadioContext.Provider value={radioCtx}>
      <div
        role="group"
        aria-label={label}
        className={cn("ls-menu__group", className)}
        {...props}
      >
        {children}
      </div>
    </MenuRadioContext.Provider>
  );
}

export interface MenuRadioItemProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "value"> {
  value: string;
  icon?: DesktopIconName | ReactNode;
  shortcut?: string;
  badge?: ReactNode;
  keepOpen?: boolean;
}

export function MenuRadioItem({
  value,
  icon,
  shortcut,
  badge,
  disabled = false,
  keepOpen = false,
  className,
  children,
  ...props
}: MenuRadioItemProps) {
  const menuCtx = useContext(MenuContext);
  const radioCtx = useContext(MenuRadioContext);
  const checked = radioCtx?.value === value;

  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={checked}
      focusgroupstart={checked ? "" : undefined}
      disabled={disabled}
      className={cn("ls-menu__item ls-menu__item--checkable", className)}
      onClick={() => {
        if (disabled) return;
        radioCtx?.onValueChange(value);
        if (!keepOpen) menuCtx?.closeMenu();
      }}
      {...props}
    >
      <span className="ls-menu__check" aria-hidden="true">
        {checked ? <DesktopIcon name="check" size="xs" /> : null}
      </span>
      {icon ? (
        <span className="ls-menu__icon" aria-hidden="true">
          {renderMenuIcon(icon)}
        </span>
      ) : null}
      <span className="ls-menu__item-label">{children}</span>
      {badge ? <span className="ls-menu__badge">{badge}</span> : null}
      {shortcut ? <Kbd shortcut={shortcut} className="ls-menu__kbd" /> : null}
    </button>
  );
}

export function MenuSeparator({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      role="separator"
      className={cn("ls-menu__separator", className)}
      {...props}
    />
  );
}

export function MenuLabel({
  className,
  children,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      role="presentation"
      className={cn("ls-menu__label", className)}
      {...props}
    >
      {children}
    </div>
  );
}

export interface ToolbarProps extends HTMLAttributes<HTMLDivElement> {
  label: string;
  orientation?: "horizontal" | "vertical";
}

export function Toolbar({
  label,
  orientation = "horizontal",
  className,
  children,
  onKeyDown,
  ...props
}: ToolbarProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const focusgroupAttr =
    orientation === "vertical"
      ? "toolbar vertical wrap"
      : "toolbar wrap";

  return (
    <div
      ref={ref}
      role="toolbar"
      aria-label={label}
      aria-orientation={orientation}
      focusgroup={focusgroupAttr}
      className={cn("ls-toolbar", className)}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (!ref.current) return;
        const target = event.target as HTMLElement | null;
        if (
          target &&
          (target.tagName === "INPUT" ||
            target.tagName === "TEXTAREA" ||
            target.isContentEditable)
        ) {
          return;
        }
        const items = Array.from(
          ref.current.querySelectorAll<HTMLElement>(
            'button:not(:disabled), [role="button"]:not([aria-disabled="true"]), select:not(:disabled)',
          ),
        );
        handleFallbackRovingKeys(
          event,
          items,
          orientation === "vertical" ? "ArrowUp" : "ArrowLeft",
          orientation === "vertical" ? "ArrowDown" : "ArrowRight",
          true,
        );
      }}
      {...props}
    >
      {children}
    </div>
  );
}
