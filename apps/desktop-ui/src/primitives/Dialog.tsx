import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type DialogHTMLAttributes,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import {
  desktopPlatform,
  getActiveDesktopPlatform,
  subscribeDesktopPlatform,
} from "../bridge/desktop-bridge";
import { registerOverlayOpen } from "../bridge/top-layer-registry";
import { Button, IconButton } from "./Button";
import { cn, isImeComposing, mergeRefs } from "./utils";

export type DialogSize = "sm" | "md" | "palette" | "lg" | "system";

export interface DialogProps
  extends Omit<DialogHTMLAttributes<HTMLDialogElement>, "open" | "onClose"> {
  open: boolean;
  onOpenChange?: (open: boolean, returnValue?: string) => void;
  /**
   * When true (default for standard `Dialog`), sets `closedby="any"` so backdrop click & Esc dismiss.
   * When false (default for `AlertDialog`), sets `closedby="closerequest"` so only Esc / explicit actions dismiss.
   */
  dismissible?: boolean;
  /** Blocks both backdrop click and Esc (`closedby="none"`). */
  preventDismiss?: boolean;
  size?: DialogSize;
  /** Keep children unmounted while closed when heavy content is not needed immediately. */
  unmountWhenClosed?: boolean;
  children: ReactNode;
}

function openModalElement(el: HTMLDialogElement): void {
  if (el.open) return;
  if (typeof el.showModal === "function") {
    try {
      el.showModal();
      return;
    } catch {
      // Fallback for non-browser unit-test DOM implementations.
    }
  }
  el.setAttribute("open", "");
}

function closeModalElement(el: HTMLDialogElement, returnValue?: string): void {
  if (!el.open && !el.hasAttribute("open")) return;
  if (typeof el.close === "function") {
    try {
      el.close(returnValue);
      if (!el.open) return;
    } catch {
      // Fallback below.
    }
  }
  if (returnValue !== undefined) {
    el.returnValue = returnValue;
  }
  el.removeAttribute("open");
  el.dispatchEvent(new Event("close"));
}

export const Dialog = forwardRef<HTMLDialogElement, DialogProps>(
  function Dialog(
    {
      open,
      onOpenChange,
      dismissible = true,
      preventDismiss = false,
      size = "md",
      unmountWhenClosed = false,
      className,
      children,
      id,
      ...props
    },
    forwardedRef,
  ) {
    const generatedId = useId();
    const dialogId = id ?? `ls-dialog-${generatedId.replace(/[^a-zA-Z0-9_-]/g, "")}`;
    const internalRef = useRef<HTMLDialogElement | null>(null);
    const onOpenChangeRef = useRef(onOpenChange);
    onOpenChangeRef.current = onOpenChange;

    const closedByValue: "any" | "closerequest" | "none" = preventDismiss
      ? "none"
      : dismissible
        ? "any"
        : "closerequest";

    // Notify Native Metal `DesktopScreenSurface` whenever any modal is open (`@host-bridge` §4.2).
    useEffect(() => {
      if (!open) return undefined;
      return registerOverlayOpen(dialogId);
    }, [open, dialogId]);

    // Imperative `.showModal()` / `.close()` synchronization (`dialog` MWG rule).
    useEffect(() => {
      const el = internalRef.current;
      if (!el) return;
      if (open) {
        openModalElement(el);
      } else {
        closeModalElement(el);
      }
    }, [open]);

    // Fallback Escape & backdrop light-dismiss ONLY for non-Chromium test environments (`jsdom`)
    // lacking native `HTMLDialogElement.prototype.closedBy`.
    useEffect(() => {
      const el = internalRef.current;
      if (!open || !el || "closedBy" in el) return undefined;

      const onKeyDown = (event: KeyboardEvent) => {
        if (event.key === "Escape" && !preventDismiss) {
          event.preventDefault();
          closeModalElement(el, "");
        }
      };
      window.addEventListener("keydown", onKeyDown);
      return () => window.removeEventListener("keydown", onKeyDown);
    }, [open, preventDismiss]);

    const activePlatform = useSyncExternalStore(
      subscribeDesktopPlatform,
      getActiveDesktopPlatform,
      () => desktopPlatform,
    );
    const rootDatasetPlatform =
      typeof document !== "undefined"
        ? document.documentElement?.dataset?.platform
        : undefined;
    const dragStripPlatform =
      rootDatasetPlatform === "windows" || rootDatasetPlatform === "macos"
        ? rootDatasetPlatform
        : activePlatform;

    return (
      <dialog
        ref={mergeRefs(internalRef, forwardedRef)}
        id={dialogId}
        closedby={closedByValue}
        data-size={size}
        className={cn("ls-dialog", className)}
        onClose={(event) => {
          const el = event.currentTarget;
          const returnValue = el.returnValue ?? "";
          el.returnValue = "";
          onOpenChangeRef.current?.(false, returnValue);
        }}
        onCancel={(event) => {
          if (preventDismiss) {
            event.preventDefault();
          }
        }}
        onClick={(event) => {
          const el = event.currentTarget;
          if (!("closedBy" in el) && dismissible && !preventDismiss && event.target === el) {
            closeModalElement(el, "");
          }
        }}
        {...props}
      >
        {open && (dragStripPlatform === "windows" || dragStripPlatform === "macos") ? (
          <div className="modal-window-drag-strip" aria-hidden="true" />
        ) : null}
        {!unmountWhenClosed || open ? (
          <div className="ls-dialog__surface">{children}</div>
        ) : null}
      </dialog>
    );
  },
);

export interface DialogHeaderProps extends HTMLAttributes<HTMLDivElement> {
  onClose?: () => void;
  closeLabel?: string;
}

export function DialogHeader({
  onClose,
  closeLabel = "关闭",
  className,
  children,
  ...props
}: DialogHeaderProps) {
  return (
    <div className={cn("ls-dialog__header", className)} {...props}>
      <div className="ls-dialog__header-main">{children}</div>
      {onClose ? (
        <IconButton
          icon="close"
          label={closeLabel}
          size="icon-sm"
          variant="ghost"
          className="ls-dialog__close"
          onClick={onClose}
        />
      ) : null}
    </div>
  );
}

export function DialogTitle({
  className,
  children,
  ...props
}: HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h2 className={cn("ls-dialog__title", className)} {...props}>
      {children}
    </h2>
  );
}

export function DialogDescription({
  className,
  children,
  ...props
}: HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p className={cn("ls-dialog__description", className)} {...props}>
      {children}
    </p>
  );
}

export function DialogBody({
  className,
  children,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("ls-dialog__body", className)} {...props}>
      {children}
    </div>
  );
}

export function DialogFooter({
  className,
  children,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("ls-dialog__footer", className)} {...props}>
      {children}
    </div>
  );
}

export interface DialogChoice {
  value: string;
  label: string;
  destructive?: boolean;
}

export interface AlertDialogProps {
  open: boolean;
  onOpenChange?: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  cancelLabel?: string;
  confirmLabel?: string;
  destructive?: boolean;
  loading?: boolean;
  choices?: DialogChoice[];
  onConfirm?: () => void;
  onChoice?: (value: string) => void;
  onCancel?: () => void;
  children?: ReactNode;
}

export function AlertDialog({
  open,
  onOpenChange,
  title,
  description,
  cancelLabel = "取消",
  confirmLabel = "确认",
  destructive = false,
  loading = false,
  choices,
  onConfirm,
  onChoice,
  onCancel,
  children,
}: AlertDialogProps) {
  const titleId = useId();
  const descId = useId();

  const handleDismiss = () => {
    if (loading) return;
    onCancel?.();
    onOpenChange?.(false);
  };

  const renderedChoices: DialogChoice[] = choices ?? [
    { value: "confirmed", label: confirmLabel, destructive },
  ];

  return (
    <Dialog
      open={open}
      dismissible={false}
      preventDismiss={loading}
      size="sm"
      aria-labelledby={titleId}
      aria-describedby={description ? descId : undefined}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          onCancel?.();
        }
        onOpenChange?.(nextOpen);
      }}
    >
      <DialogHeader>
        <DialogTitle id={titleId}>{title}</DialogTitle>
        {description ? (
          <DialogDescription id={descId}>{description}</DialogDescription>
        ) : null}
      </DialogHeader>
      {children ? <DialogBody>{children}</DialogBody> : null}
      <DialogFooter>
        <Button
          variant="secondary"
          disabled={loading}
          onClick={handleDismiss}
        >
          {cancelLabel}
        </Button>
        {renderedChoices.map((choice) => (
          <Button
            key={choice.value}
            variant={choice.destructive ? "danger" : "primary"}
            loading={loading}
            onClick={() => {
              if (choices) {
                onChoice?.(choice.value);
              } else {
                onConfirm?.();
              }
            }}
          >
            {choice.label}
          </Button>
        ))}
      </DialogFooter>
    </Dialog>
  );
}

/* ============================================================================
 * Queued Imperative `DialogProvider` / `useDialogs()` (Fixes `#10` §2.1)
 * - FIFO queue ensures concurrent `confirm`/`alert`/`prompt`/`choose` never drop to `null`.
 * - Accurate context titles (never hardcoded `"上下文用量"`).
 * - IME-safe Enter handling for `prompt`.
 * ========================================================================== */

export interface AlertOptions {
  title?: string;
  actionLabel?: string;
}

export interface ConfirmOptions {
  title?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
}

export interface PromptOptions {
  title?: string;
  description?: string;
  initial?: string;
  placeholder?: string;
  submitLabel?: string;
  cancelLabel?: string;
}

export interface ChooseOptions {
  title?: string;
  cancelLabel?: string;
}

type QueuedDialogSpec =
  | {
      kind: "alert";
      title: string;
      text: string;
      actionLabel: string;
    }
  | {
      kind: "confirm";
      title: string;
      text: string;
      confirmLabel: string;
      cancelLabel: string;
      destructive: boolean;
    }
  | {
      kind: "choice";
      title: string;
      text: string;
      cancelLabel: string;
      choices: DialogChoice[];
    }
  | {
      kind: "prompt";
      title: string;
      description?: string;
      initial: string;
      placeholder?: string;
      submitLabel: string;
      cancelLabel: string;
    };

interface QueuedDialogEntry {
  id: number;
  spec: QueuedDialogSpec;
  opener: HTMLElement | null;
  resolve: (value: string | null) => void;
}

type EnqueueDialog = (spec: QueuedDialogSpec) => Promise<string | null>;

const DialogQueueContext = createContext<EnqueueDialog | null>(null);

export interface DialogsController {
  alert: (text: string, options?: AlertOptions) => Promise<string | null>;
  confirm: (text: string, options?: ConfirmOptions) => Promise<boolean>;
  choose: (
    text: string,
    choices: DialogChoice[],
    options?: ChooseOptions,
  ) => Promise<string | null>;
  prompt: (
    text: string,
    initialOrOptions?: string | PromptOptions,
    submitLabel?: string,
  ) => Promise<string | null>;
}

export function useDialogs(): DialogsController {
  const enqueue = useContext(DialogQueueContext);
  if (!enqueue) {
    throw new Error("useDialogs must be used within <DialogProvider>");
  }

  return useMemo<DialogsController>(
    () => ({
      alert: (text, options) =>
        enqueue({
          kind: "alert",
          title: options?.title ?? "提示",
          text,
          actionLabel: options?.actionLabel ?? "知道了",
        }),
      confirm: (text, options) =>
        enqueue({
          kind: "confirm",
          title: options?.title ?? "确认操作",
          text,
          confirmLabel: options?.confirmLabel ?? "确认",
          cancelLabel: options?.cancelLabel ?? "取消",
          destructive: options?.destructive ?? true,
        }).then((result) => result !== null),
      choose: (text, choices, options) =>
        enqueue({
          kind: "choice",
          title: options?.title ?? "确认操作",
          text,
          cancelLabel: options?.cancelLabel ?? "取消",
          choices,
        }),
      prompt: (text, initialOrOptions, submitLabel = "保存") => {
        if (typeof initialOrOptions === "object" && initialOrOptions !== null) {
          return enqueue({
            kind: "prompt",
            title: initialOrOptions.title ?? text,
            description: initialOrOptions.description,
            initial: initialOrOptions.initial ?? "",
            placeholder: initialOrOptions.placeholder,
            submitLabel: initialOrOptions.submitLabel ?? "保存",
            cancelLabel: initialOrOptions.cancelLabel ?? "取消",
          });
        }
        return enqueue({
          kind: "prompt",
          title: text,
          initial: initialOrOptions ?? "",
          submitLabel,
          cancelLabel: "取消",
        });
      },
    }),
    [enqueue],
  );
}

export function DialogProvider({ children }: { children: ReactNode }) {
  const nextIdRef = useRef(1);
  const queueRef = useRef<QueuedDialogEntry[]>([]);
  const activeRef = useRef<QueuedDialogEntry | null>(null);
  const [active, setActive] = useState<QueuedDialogEntry | null>(null);
  const [promptValue, setPromptValue] = useState("");
  const promptInputId = useId();
  const titleId = useId();
  const descId = useId();

  const advanceQueue = useCallback((previousOpener: HTMLElement | null) => {
    const next = queueRef.current.shift() ?? null;
    activeRef.current = next;
    if (next) {
      setPromptValue(next.spec.kind === "prompt" ? next.spec.initial : "");
      setActive(next);
      return;
    }
    setActive(null);
    if (previousOpener && previousOpener.isConnected) {
      previousOpener.focus({ preventScroll: true });
    }
  }, []);

  const finishActive = useCallback(
    (result: string | null) => {
      const current = activeRef.current;
      if (!current) return;
      activeRef.current = null;
      current.resolve(result);
      advanceQueue(current.opener);
    },
    [advanceQueue],
  );

  const enqueue = useCallback<EnqueueDialog>((spec) => {
    const opener =
      typeof document !== "undefined" &&
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;

    return new Promise<string | null>((resolve) => {
      const entry: QueuedDialogEntry = {
        id: nextIdRef.current++,
        spec,
        opener,
        resolve,
      };
      if (!activeRef.current) {
        activeRef.current = entry;
        setPromptValue(spec.kind === "prompt" ? spec.initial : "");
        setActive(entry);
      } else {
        queueRef.current.push(entry);
      }
    });
  }, []);

  useEffect(() => {
    const queue = queueRef.current;
    return () => {
      if (activeRef.current) {
        activeRef.current.resolve(null);
        activeRef.current = null;
      }
      while (queue.length > 0) {
        queue.shift()?.resolve(null);
      }
    };
  }, []);

  return (
    <DialogQueueContext.Provider value={enqueue}>
      {children}
      {active ? (
        <Dialog
          key={active.id}
          open
          dismissible={active.spec.kind === "alert"}
          size="sm"
          aria-labelledby={titleId}
          aria-describedby={descId}
          onOpenChange={(nextOpen) => {
            if (!nextOpen) {
              finishActive(null);
            }
          }}
        >
          <DialogHeader>
            <DialogTitle id={titleId}>{active.spec.title}</DialogTitle>
            {active.spec.kind !== "prompt" ? (
              <DialogDescription id={descId}>{active.spec.text}</DialogDescription>
            ) : active.spec.description ? (
              <DialogDescription id={descId}>
                {active.spec.description}
              </DialogDescription>
            ) : (
              <DialogDescription id={descId} className="ls-sr-only">
                填写后确认，取消不会修改。
              </DialogDescription>
            )}
          </DialogHeader>

          {active.spec.kind === "prompt" ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                const trimmed = promptValue.trim();
                if (!trimmed) return;
                finishActive(trimmed);
              }}
            >
              <DialogBody>
                <label htmlFor={promptInputId} className="ls-sr-only">
                  {active.spec.title}
                </label>
                <input
                  id={promptInputId}
                  type="text"
                  className="ls-input"
                  autoFocus
                  value={promptValue}
                  placeholder={active.spec.placeholder}
                  onChange={(event) => setPromptValue(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && isImeComposing(event)) {
                      event.preventDefault();
                    }
                  }}
                />
              </DialogBody>
              <DialogFooter>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => finishActive(null)}
                >
                  {active.spec.cancelLabel}
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  disabled={!promptValue.trim()}
                >
                  {active.spec.submitLabel}
                </Button>
              </DialogFooter>
            </form>
          ) : active.spec.kind === "alert" ? (
            <DialogFooter>
              <Button
                type="button"
                variant="primary"
                autoFocus
                onClick={() => finishActive("acknowledged")}
              >
                {active.spec.actionLabel}
              </Button>
            </DialogFooter>
          ) : active.spec.kind === "confirm" ? (
            <DialogFooter>
              <Button
                type="button"
                variant="secondary"
                onClick={() => finishActive(null)}
              >
                {active.spec.cancelLabel}
              </Button>
              <Button
                type="button"
                variant={active.spec.destructive ? "danger" : "primary"}
                autoFocus={!active.spec.destructive}
                onClick={() => finishActive("confirmed")}
              >
                {active.spec.confirmLabel}
              </Button>
            </DialogFooter>
          ) : (
            <DialogFooter>
              <Button
                type="button"
                variant="secondary"
                onClick={() => finishActive(null)}
              >
                {active.spec.cancelLabel}
              </Button>
              {active.spec.choices.map((choice) => (
                <Button
                  key={choice.value}
                  type="button"
                  variant={choice.destructive ? "danger" : "primary"}
                  onClick={() => finishActive(choice.value)}
                >
                  {choice.label}
                </Button>
              ))}
            </DialogFooter>
          )}
        </Dialog>
      ) : null}
    </DialogQueueContext.Provider>
  );
}

/** Alias preserving parity with existing callers. */
export const Dialogs = DialogProvider;
