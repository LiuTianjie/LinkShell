import { Component, type ErrorInfo, type ReactNode } from "react";
import { DesktopIcon } from "../icons";
import { Button } from "./Button";
import { cn } from "./utils";
import { getPrimitiveLabels } from "./labels";

export interface ErrorBoundaryProps {
  children: ReactNode;
  fallbackTitle?: ReactNode;
  fallbackDescription?: ReactNode;
  retryLabel?: string;
  /** Automatically clears captured error state when any key in this array changes. */
  resetKeys?: readonly unknown[];
  onReset?: () => void;
  className?: string;
}

interface ErrorBoundaryState {
  error: Error | null;
}

function keysChanged(
  prev: readonly unknown[] | undefined,
  next: readonly unknown[] | undefined,
): boolean {
  if (prev === next) return false;
  if (!prev || !next || prev.length !== next.length) return true;
  for (let i = 0; i < prev.length; i += 1) {
    if (!Object.is(prev[i], next[i])) return true;
  }
  return false;
}

/**
 * Isolates rendering exceptions inside individual desktop panes (Main Stage, Inspector,
 * Bottom Terminal Dock, Remote Screen, System Modal) so a fault never white-screens the window.
 */
export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return {
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[LinkShell ErrorBoundary]", error, info.componentStack);
  }

  override componentDidUpdate(prevProps: ErrorBoundaryProps): void {
    if (
      this.state.error !== null &&
      keysChanged(prevProps.resetKeys, this.props.resetKeys)
    ) {
      this.setState({ error: null });
    }
  }

  private readonly handleReset = (): void => {
    this.setState({ error: null });
    this.props.onReset?.();
  };

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) {
      return this.props.children;
    }

    const {
      fallbackTitle = getPrimitiveLabels().panelFailed,
      fallbackDescription,
      retryLabel = getPrimitiveLabels().retry,
      className,
    } = this.props;

    return (
      <div className={cn("ls-error-boundary", className)} role="alert">
        <div className="ls-error-boundary__card">
          <div className="ls-error-boundary__icon" aria-hidden="true">
            <DesktopIcon name="alert-circle" size="md" />
          </div>
          <h3 className="ls-error-boundary__title">{fallbackTitle}</h3>
          {fallbackDescription ? (
            <p className="ls-error-boundary__desc">{fallbackDescription}</p>
          ) : null}
          {error.message ? (
            <pre className="ls-error-boundary__detail" tabIndex={0}>
              {error.message}
            </pre>
          ) : null}
          <div className="ls-error-boundary__actions">
            <Button
              variant="secondary"
              size="sm"
              leadingIcon="refresh"
              onClick={this.handleReset}
            >
              {retryLabel}
            </Button>
          </div>
        </div>
      </div>
    );
  }
}
