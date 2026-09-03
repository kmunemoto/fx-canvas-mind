import { Component, type ErrorInfo, type ReactNode } from "react";
import { useOptionalT } from "@/lib/i18n";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
}

// A class component cannot read context through hooks, so the fallback is its
// own function component.
const ErrorFallback = () => {
  const t = useOptionalT();
  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-6">
      <div className="w-full max-w-md rounded-lg border border-border bg-card p-6 text-center space-y-3">
        <h1 className="text-lg font-semibold text-foreground">{t.errors.render}</h1>
        <p className="text-sm text-muted-foreground">{t.errors.renderBody}</p>
      </div>
    </div>
  );
};

class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = {
    hasError: false,
  };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("ErrorBoundary caught:", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return <ErrorFallback />;
    }

    return this.props.children;
  }
}

export default ErrorBoundary;