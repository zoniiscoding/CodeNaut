import { Component } from "react";
import type { ErrorInfo, PropsWithChildren } from "react";

interface ErrorBoundaryState {
  hasError: boolean;
}

/**
 * Catches render-time exceptions so one failing subtree cannot blank the whole app.
 * The caught error is intentionally not rendered: it can contain component internals,
 * and untrusted repository text may appear in props.
 */
export class ErrorBoundary extends Component<PropsWithChildren, ErrorBoundaryState> {
  public override state: ErrorBoundaryState = { hasError: false };

  public static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  public override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("Codenaut render error", error, info.componentStack);
  }

  private readonly reset = (): void => {
    this.setState({ hasError: false });
  };

  public override render(): React.ReactNode {
    if (!this.state.hasError) {
      return this.props.children;
    }
    return (
      <main className="error-boundary" role="alert">
        <div className="error-boundary__panel">
          <p className="eyebrow">Something went wrong</p>
          <h1>This screen could not be displayed.</h1>
          <p>
            The rest of Codenaut is still available. Your repositories and saved chats are
            unaffected.
          </p>
          <div className="button-row">
            <button className="button button--primary" onClick={this.reset} type="button">
              Try again
            </button>
            <a className="button" href="/repositories">
              Back to repositories
            </a>
          </div>
        </div>
      </main>
    );
  }
}
