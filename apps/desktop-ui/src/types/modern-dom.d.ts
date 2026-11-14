/* eslint-disable @typescript-eslint/no-unused-vars -- TypeScript interface merging with @types/react requires exact type parameter names (`T`). */
import "react";

declare module "react" {
  interface HTMLAttributes<T> {
    focusgroup?: string | undefined;
    focusgroupstart?: "" | boolean | undefined;
  }

  interface ButtonHTMLAttributes<T> {
    commandfor?: string | undefined;
    command?:
      | "show-modal"
      | "close"
      | "request-close"
      | "toggle-popover"
      | "show-popover"
      | "hide-popover"
      | `--${string}`
      | undefined;
    interestfor?: string | undefined;
  }

  interface AnchorHTMLAttributes<T> {
    interestfor?: string | undefined;
  }

  namespace JSX {
    interface IntrinsicElements {
      selectedcontent: React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement>,
        HTMLElement
      >;
    }
  }
}

declare global {
  interface ShowPopoverOptions {
    source?: HTMLElement;
  }

  interface TogglePopoverOptions {
    force?: boolean;
    source?: HTMLElement;
  }

  interface CommandEventInit extends EventInit {
    source?: Element | null;
    command?: string;
  }

  interface CommandEvent extends Event {
    readonly source: Element | null;
    readonly command: string;
  }

  interface HTMLElementEventMap {
    command: CommandEvent;
  }

  interface HTMLElement {
    showPopover(options?: ShowPopoverOptions): void;
    togglePopover(options?: boolean | TogglePopoverOptions): boolean;
  }

  interface HTMLDialogElement {
    closedBy: "any" | "closerequest" | "none";
  }

  interface Element {
    moveBefore<T extends Node>(movedNode: T, child: Node | null): T;
    startViewTransition(
      callbackOptions?: ViewTransitionUpdateCallback | StartViewTransitionOptions,
    ): ViewTransition;
    setHTML(input: string, options?: { sanitizer?: unknown }): void;
  }

  interface Scheduler {
    yield(): Promise<void>;
  }

  interface WindowOrWorkerGlobalScope {
    readonly scheduler?: Scheduler;
  }
}
