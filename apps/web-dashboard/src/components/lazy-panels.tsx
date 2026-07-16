// Code-splitting wrappers for the heavy right-panel components. Each panel is
// React.lazy-loaded (xterm / highlight / usage charts stay out of the main
// bundle) and pre-wrapped in Suspense with the standard spinner, so call sites
// only need to swap their import path — no JSX changes.

import { Suspense, lazy, type ComponentType } from "react";

const LazyTerminalPanel = lazy(() =>
  import("./TerminalPanel").then((m) => ({ default: m.TerminalPanel }))
);
const LazyUsageDashboard = lazy(() =>
  import("./UsageDashboard").then((m) => ({ default: m.UsageDashboard }))
);
const LazyPortPreview = lazy(() =>
  import("./PortPreview").then((m) => ({ default: m.PortPreview }))
);
const LazyFileBrowser = lazy(() =>
  import("./FileBrowser").then((m) => ({ default: m.FileBrowser }))
);

function PanelSpinner() {
  return (
    <div className="flex h-full w-full items-center justify-center">
      <span className="h-5 w-5 animate-spin rounded-full border-2 border-content-faint border-t-accent" />
    </div>
  );
}

function withSuspense<P extends object>(Lazy: ComponentType<P>) {
  return function SuspendedPanel(props: P) {
    return (
      <Suspense fallback={<PanelSpinner />}>
        <Lazy {...props} />
      </Suspense>
    );
  };
}

export const TerminalPanel = withSuspense(LazyTerminalPanel);
export const UsageDashboard = withSuspense(LazyUsageDashboard);
export const PortPreview = withSuspense(LazyPortPreview);
export const FileBrowser = withSuspense(LazyFileBrowser);
