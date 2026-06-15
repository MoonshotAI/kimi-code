import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error?: Error;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  override componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("[Kimi Webview] React render error:", error, info.componentStack);
  }

  private handleReload = () => {
    window.location.reload();
  };

  override render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }
      return (
        <div className="flex flex-col items-center justify-center h-screen px-6 text-center text-foreground">
          <div className="text-base font-semibold mb-2">Kimi Code webview 遇到了问题</div>
          <div className="text-xs text-muted-foreground mb-4 max-w-md">
            渲染过程发生异常，导致页面空白。点击下方按钮可重新加载。
          </div>
          {this.state.error && (
            <pre className="text-[10px] text-left bg-muted p-3 rounded mb-4 max-w-md max-h-40 overflow-auto whitespace-pre-wrap">
              {this.state.error.message}
            </pre>
          )}
          <button
            type="button"
            onClick={this.handleReload}
            className="px-3 py-1.5 text-xs font-medium rounded border border-border bg-background hover:bg-muted transition-colors"
          >
            重新加载
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
