import React from 'react';

interface Props {
  children: React.ReactNode;
  fallbackTitle?: string;
}

interface State {
  error: Error | null;
}

// Catches render errors in its subtree so one broken component can't white-screen
// the whole app. Shows a small recoverable message instead.
export default class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('ErrorBoundary caught an error:', error, info);
  }

  handleReset = () => this.setState({ error: null });

  render() {
    if (this.state.error) {
      return (
        <div className="flex min-h-72 items-center justify-center p-6">
          <div className="max-w-lg rounded-2xl border border-red-200 bg-red-50 p-6 text-center">
            <h3 className="mb-2 text-lg font-bold text-gray-900">{this.props.fallbackTitle ?? 'Something went wrong'}</h3>
            <p className="mb-4 text-xs leading-relaxed text-gray-600">{this.state.error.message}</p>
            <button
              onClick={this.handleReset}
              className="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-500"
            >
              Try again
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
