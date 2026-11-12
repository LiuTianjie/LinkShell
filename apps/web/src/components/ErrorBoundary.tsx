import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";

interface ErrorBoundaryProps {
  children: ReactNode;
  resetKey?: string;
  onResetHome?: () => void;
}

interface ErrorBoundaryState {
  error?: Error;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = {};

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidUpdate(prevProps: ErrorBoundaryProps): void {
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ error: undefined });
    }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[LinkShell UI ErrorBoundary]", error, info.componentStack);
  }

  override render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="welcome-live" role="alert">
        <AlertCircle size={28} aria-hidden />
        <h1>当前视图加载遇到问题</h1>
        <p className="muted">{error.message || "页面渲染发生异常，连接与会话数据未受影响。"}</p>
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Button variant="default" size="sm" onClick={() => this.setState({ error: undefined })}>
            重试加载
          </Button>
          {this.props.onResetHome && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                this.setState({ error: undefined });
                this.props.onResetHome?.();
              }}
            >
              返回会话列表
            </Button>
          )}
        </div>
      </div>
    );
  }
}
