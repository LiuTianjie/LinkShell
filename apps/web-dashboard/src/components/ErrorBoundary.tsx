// Top-level error boundary: a render error anywhere in the tree would otherwise
// blank the whole page (especially bad inside the mobile WebView, where the
// user can't open devtools). Catches it and offers reload — plus a close button
// back to the native host when embedded.

import { Component, type ReactNode } from "react";
import { isEmbedded, postRequestCloseToHost } from "../lib/embed";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error): void {
    console.error("[ErrorBoundary]", error);
  }

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 px-6">
        <div className="text-lg font-medium text-content-primary">页面出错了</div>
        <div className="max-w-md break-all text-center font-mono text-xs text-content-muted">
          {this.state.error.message}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="codex-btn-primary"
            onClick={() => window.location.reload()}
          >
            重新加载
          </button>
          {isEmbedded() && (
            <button
              type="button"
              className="codex-btn-outline"
              onClick={() => postRequestCloseToHost()}
            >
              关闭
            </button>
          )}
        </div>
      </div>
    );
  }
}
