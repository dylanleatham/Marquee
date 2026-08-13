import { Component, type ErrorInfo, type ReactNode } from "react";

// Failure containment for the Curator UI (issue #63). Before this, a single uncaught render
// exception in any page/component unmounted the whole tree to a blank window — no error shown, no
// recovery short of restarting the app. This boundary catches render errors, shows the message with
// a Reload action, and logs to console.error so the desktop shell's renderer-console capture records
// it. Use it twice: a full-window catch-all around <App/>, and a per-route boundary around <Routes>
// so a broken detail page keeps the header/nav and recovers on navigation.

interface Props {
  children: ReactNode;
  /** "app" fills the window (catch-all); "route" frames inside the page body (keeps header/nav). */
  variant?: "app" | "route";
  /** When this value changes, a caught error is cleared — pass the route path so navigating away
   * from a broken page recovers without a full reload. */
  resetKey?: string;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Surface to the console so the shell's console-message capture logs the stack (issue #63).
    console.error(
      "[curator-ui] render error:",
      error,
      info.componentStack ?? "",
    );
  }

  componentDidUpdate(prev: Props): void {
    if (this.state.error && prev.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    const variant = this.props.variant ?? "route";
    return (
      <div className={`error-fallback error-fallback--${variant}`} role="alert">
        <h1 className="error-fallback__title">Something broke</h1>
        <p className="error-fallback__msg">{error.message || String(error)}</p>
        <div className="error-fallback__actions">
          <button
            type="button"
            className="pp-btn"
            onClick={() => window.location.reload()}
          >
            Reload
          </button>
          <button
            type="button"
            className="pp-action"
            onClick={() => window.location.assign("/")}
          >
            Back to queue
          </button>
        </div>
      </div>
    );
  }
}
