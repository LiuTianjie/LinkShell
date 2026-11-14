import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type DetailsHTMLAttributes,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import { DesktopIcon, type DesktopIconName } from "../icons";
import { CopyButton } from "./CopyButton";
import { cn } from "./utils";

export interface DisclosureProps
  extends Omit<
    DetailsHTMLAttributes<HTMLDetailsElement>,
    "onToggle" | "title"
  > {
  title: ReactNode;
  meta?: ReactNode;
  icon?: DesktopIconName | ReactNode;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  summaryClassName?: string;
  contentClassName?: string;
  children: ReactNode;
}

export function Disclosure({
  title,
  meta,
  icon,
  open: controlledOpen,
  defaultOpen = false,
  onOpenChange,
  className,
  summaryClassName,
  contentClassName,
  children,
  ...props
}: DisclosureProps) {
  const isControlled = controlledOpen !== undefined;
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const isOpen = isControlled ? controlledOpen : uncontrolledOpen;
  const detailsRef = useRef<HTMLDetailsElement | null>(null);

  return (
    <details
      ref={detailsRef}
      open={isOpen}
      className={cn("ls-disclosure", className)}
      onToggle={(event) => {
        const nextOpen = event.currentTarget.open;
        if (!isControlled) {
          setUncontrolledOpen(nextOpen);
        }
        if (nextOpen !== isOpen) {
          onOpenChange?.(nextOpen);
        }
      }}
      {...props}
    >
      <summary className={cn("ls-disclosure__summary", summaryClassName)}>
        <span className="ls-disclosure__chevron" aria-hidden="true">
          <DesktopIcon name="chevron-right" size="xs" />
        </span>
        {icon ? (
          <span className="ls-disclosure__icon" aria-hidden="true">
            {typeof icon === "string" ? (
              <DesktopIcon name={icon as DesktopIconName} size="sm" />
            ) : (
              icon
            )}
          </span>
        ) : null}
        <span className="ls-disclosure__title">{title}</span>
        {meta ? <span className="ls-disclosure__meta">{meta}</span> : null}
      </summary>
      <div className={cn("ls-disclosure__content", contentClassName)}>
        {children}
      </div>
    </details>
  );
}

export interface CollapsibleLogProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  title: ReactNode;
  /** Neutral metadata (e.g. exit code, duration, `+24 -8` diff stat — neutral ink per `#7` §1.1). */
  meta?: ReactNode;
  /** Raw text for `CopyButton` and `<pre>` rendering when `children` is omitted. */
  logText?: string;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  children?: ReactNode;
}

/**
 * Searchable collapsible agent tool / build log (`search-hidden-content` + `html` MWG guides):
 * - Uses `hidden="until-found"` when collapsed (NEVER `display: none` or `visibility: hidden`).
 * - Listens to `beforematch` so `⌘F` / `Ctrl+F` automatically expands matching tool logs.
 * - Sets `tabIndex={0}` on scrollable `<pre>` regions for keyboard reachability.
 */
export function CollapsibleLog({
  title,
  meta,
  logText,
  open: controlledOpen,
  defaultOpen = false,
  onOpenChange,
  className,
  children,
  ...props
}: CollapsibleLogProps) {
  const contentId = useId();
  const isControlled = controlledOpen !== undefined;
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const isOpen = isControlled ? controlledOpen : uncontrolledOpen;
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const onOpenChangeRef = useRef(onOpenChange);
  onOpenChangeRef.current = onOpenChange;

  const updateOpen = (next: boolean) => {
    if (!isControlled) {
      setUncontrolledOpen(next);
    }
    onOpenChangeRef.current?.(next);
  };

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return undefined;
    const onBeforeMatch = () => {
      if (!isControlled) {
        setUncontrolledOpen(true);
      }
      onOpenChangeRef.current?.(true);
    };
    el.addEventListener("beforematch", onBeforeMatch);
    return () => el.removeEventListener("beforematch", onBeforeMatch);
  }, [isControlled]);

  // React 19 coerces JSX `hidden` prop to boolean `""`; use `setAttribute` so Chromium & tests receive `"until-found"`.
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    if (!isOpen) {
      el.setAttribute("hidden", "until-found");
    } else {
      el.removeAttribute("hidden");
    }
  }, [isOpen]);

  return (
    <div
      className={cn("ls-collapsible-log", className)}
      data-open={isOpen ? "true" : undefined}
      {...props}
    >
      <div className="ls-collapsible-log__header">
        <button
          type="button"
          aria-expanded={isOpen}
          aria-controls={contentId}
          className="ls-collapsible-log__trigger"
          onClick={() => updateOpen(!isOpen)}
        >
          <span className="ls-collapsible-log__chevron" aria-hidden="true">
            <DesktopIcon name="chevron-right" size="xs" />
          </span>
          <span className="ls-collapsible-log__title">{title}</span>
          {meta ? (
            <span className="ls-collapsible-log__meta">{meta}</span>
          ) : null}
        </button>
        {logText !== undefined ? (
          <CopyButton
            value={logText}
            revealOnHover
            className="ls-collapsible-log__copy"
          />
        ) : null}
      </div>

      {/* MWG `search-hidden-content`: NO `display: none` or `visibility: hidden` on `[hidden="until-found"]`! */}
      <div
        ref={bodyRef}
        id={contentId}
        className="ls-collapsible-log__panel"
      >
        <div className="ls-collapsible-log__inner">
          {children ?? (
            <pre tabIndex={0} className="ls-collapsible-log__pre">
              {logText}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}
