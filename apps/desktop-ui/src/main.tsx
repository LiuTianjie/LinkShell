import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { getDesktopCapability } from "./bridge";
import { App, resolveStoredAppearance } from "./App";
import { applyDesktopAppearance } from "./theme";
import "./styles/index.css";

// Capture `#desktop=<capability>` and apply initial theme synchronously before first paint.
getDesktopCapability();
applyDesktopAppearance(resolveStoredAppearance());

const container = document.getElementById("root");
if (container) {
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
