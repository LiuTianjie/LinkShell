import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import { DesktopIcon, type DesktopIconName } from "../icons";
import { Badge } from "./Badge";
import { cn } from "./utils";

export type TabsVariant = "underline" | "segmented";

interface TabsContextValue {
  baseId: string;
  value: string;
  setValue: (next: string) => void;
  orientation: "horizontal" | "vertical";
  variant: TabsVariant;
  activationMode: "automatic" | "manual";
}

const TabsContext = createContext<TabsContextValue | null>(null);

export interface TabsProps extends HTMLAttributes<HTMLDivElement> {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  orientation?: "horizontal" | "vertical";
  variant?: TabsVariant;
  activationMode?: "automatic" | "manual";
}

export function Tabs({
  value: controlledValue,
  defaultValue = "",
  onValueChange,
  orientation = "horizontal",
  variant = "underline",
  activationMode = "automatic",
  className,
  children,
  ...props
}: TabsProps) {
  const rawId = useId();
  const baseId = `ls-tabs-${rawId.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const [uncontrolledValue, setUncontrolledValue] = useState(defaultValue);
  const isControlled = controlledValue !== undefined;
  const value = isControlled ? controlledValue : uncontrolledValue;
  const onValueChangeRef = useRef(onValueChange);
  onValueChangeRef.current = onValueChange;

  const setValue = useCallback(
    (next: string) => {
      if (!isControlled) {
        setUncontrolledValue(next);
      }
      onValueChangeRef.current?.(next);
    },
    [isControlled],
  );

  const ctx = useMemo<TabsContextValue>(
    () => ({
      baseId,
      value,
      setValue,
      orientation,
      variant,
      activationMode,
    }),
    [baseId, value, setValue, orientation, variant, activationMode],
  );

  return (
    <TabsContext.Provider value={ctx}>
      <div
        data-orientation={orientation}
        data-variant={variant}
        className={cn("ls-tabs", className)}
        {...props}
      >
        {children}
      </div>
    </TabsContext.Provider>
  );
}

export interface TabListProps extends HTMLAttributes<HTMLDivElement> {
  label?: string;
}

export function TabList({
  label,
  className,
  children,
  onKeyDown,
  ...props
}: TabListProps) {
  const ctx = useContext(TabsContext);
  if (!ctx) {
    throw new Error("<TabList> must be used inside <Tabs>");
  }

  const listRef = useRef<HTMLDivElement | null>(null);
  const focusgroupAttr =
    ctx.orientation === "vertical"
      ? "tablist vertical nomemory"
      : "tablist nomemory";

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label={label}
      aria-orientation={ctx.orientation}
      focusgroup={focusgroupAttr}
      data-variant={ctx.variant}
      className={cn("ls-tab-list", className)}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (
          event.defaultPrevented ||
          event.metaKey ||
          event.ctrlKey ||
          event.altKey ||
          !listRef.current
        ) {
          return;
        }

        const tabs = Array.from(
          listRef.current.querySelectorAll<HTMLButtonElement>(
            '[role="tab"]:not(:disabled)',
          ),
        );
        if (tabs.length === 0) return;

        const prevKey =
          ctx.orientation === "vertical" ? "ArrowUp" : "ArrowLeft";
        const nextKey =
          ctx.orientation === "vertical" ? "ArrowDown" : "ArrowRight";

        const active = document.activeElement as HTMLButtonElement | null;
        const currentIndex = active ? tabs.indexOf(active) : -1;
        let targetTab: HTMLButtonElement | undefined;

        if (event.key === nextKey) {
          event.preventDefault();
          const idx =
            currentIndex < 0 ? 0 : (currentIndex + 1) % tabs.length;
          targetTab = tabs[idx];
        } else if (event.key === prevKey) {
          event.preventDefault();
          const idx =
            currentIndex <= 0 ? tabs.length - 1 : currentIndex - 1;
          targetTab = tabs[idx];
        } else if (event.key === "Home") {
          event.preventDefault();
          targetTab = tabs[0];
        } else if (event.key === "End") {
          event.preventDefault();
          targetTab = tabs[tabs.length - 1];
        }

        if (targetTab) {
          targetTab.focus({ preventScroll: true });
          const nextVal = targetTab.dataset.tabValue;
          if (ctx.activationMode === "automatic" && nextVal !== undefined) {
            ctx.setValue(nextVal);
          }
        }
      }}
      {...props}
    >
      {children}
    </div>
  );
}

export interface TabProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "value"> {
  value: string;
  icon?: DesktopIconName | ReactNode;
  count?: number | string;
}

export function Tab({
  value,
  icon,
  count,
  disabled = false,
  className,
  children,
  onClick,
  ...props
}: TabProps) {
  const ctx = useContext(TabsContext);
  if (!ctx) {
    throw new Error("<Tab> must be used inside <Tabs>");
  }

  const isSelected = ctx.value === value;
  const tabId = `${ctx.baseId}-tab-${value}`;
  const panelId = `${ctx.baseId}-panel-${value}`;

  return (
    <button
      id={tabId}
      type="button"
      role="tab"
      aria-selected={isSelected}
      aria-controls={panelId}
      tabIndex={isSelected ? 0 : -1}
      focusgroupstart={isSelected ? "" : undefined}
      disabled={disabled}
      data-tab-value={value}
      className={cn("ls-tab", className)}
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented || disabled) return;
        ctx.setValue(value);
      }}
      {...props}
    >
      {icon ? (
        <span className="ls-tab__icon" aria-hidden="true">
          {typeof icon === "string" ? (
            <DesktopIcon name={icon as DesktopIconName} size="sm" />
          ) : (
            icon
          )}
        </span>
      ) : null}
      <span className="ls-tab__label">{children}</span>
      {count !== undefined ? (
        <Badge
          variant="count"
          tone={isSelected ? "accent" : "neutral"}
          className="ls-tab__count"
        >
          {count}
        </Badge>
      ) : null}
    </button>
  );
}

export interface TabPanelProps extends HTMLAttributes<HTMLDivElement> {
  value: string;
  /**
   * Retains DOM & rendering cache (`content-visibility: hidden`) across tab switches
   * (`faster-spa-view-transitions`) so xterm/Diff/Preview/Fusion never reset state.
   */
  keepMounted?: boolean;
  /**
   * Uses `hidden="until-found"` + `beforematch` so `⌘F`/`Ctrl+F` searches inactive tab panels (`tabs`).
   */
  searchableWhenHidden?: boolean;
}

export function TabPanel({
  value,
  keepMounted = true,
  searchableWhenHidden = false,
  className,
  children,
  ...props
}: TabPanelProps) {
  const ctx = useContext(TabsContext);
  if (!ctx) {
    throw new Error("<TabPanel> must be used inside <Tabs>");
  }

  const panelRef = useRef<HTMLDivElement | null>(null);
  const isSelected = ctx.value === value;
  const tabId = `${ctx.baseId}-tab-${value}`;
  const panelId = `${ctx.baseId}-panel-${value}`;

  useEffect(() => {
    const el = panelRef.current;
    if (!el || !searchableWhenHidden) return undefined;
    const onBeforeMatch = () => {
      ctx.setValue(value);
    };
    el.addEventListener("beforematch", onBeforeMatch);
    return () => el.removeEventListener("beforematch", onBeforeMatch);
  }, [ctx, searchableWhenHidden, value]);

  // React 19 treats JSX `hidden` as boolean (`hidden=""`); set `"until-found"` via `setAttribute`.
  useLayoutEffect(() => {
    const el = panelRef.current;
    if (!el || !searchableWhenHidden) return;
    if (!isSelected) {
      el.setAttribute("hidden", "until-found");
    } else {
      el.removeAttribute("hidden");
    }
  }, [isSelected, searchableWhenHidden]);

  if (!isSelected && !keepMounted && !searchableWhenHidden) {
    return null;
  }

  return (
    <div
      ref={panelRef}
      id={panelId}
      role="tabpanel"
      aria-labelledby={tabId}
      aria-hidden={!isSelected && !searchableWhenHidden ? true : undefined}
      tabIndex={isSelected ? 0 : -1}
      data-inactive={!isSelected && !searchableWhenHidden ? "true" : undefined}
      className="ls-tab-panel"
      {...props}
    >
      {/* MWG `tabs`: padding, borders, margins & backgrounds live on inner wrapper, NEVER on `[hidden="until-found"]` host. */}
      <div className={cn("ls-tab-panel__inner", className)}>{children}</div>
    </div>
  );
}
