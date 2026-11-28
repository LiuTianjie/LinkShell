import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { getDesktopCapability } from "./bridge";
import { handleAccountOAuthCallback } from "./core";
import { App, resolveStoredAppearance } from "./App";
import { applyDesktopAppearance } from "./theme";
import "./styles/index.css";

// Capture `#desktop=<capability>` and apply initial theme synchronously before first paint.
const desktopCapability = getDesktopCapability();
applyDesktopAppearance(resolveStoredAppearance());

// OAuth popup callbacks forward their authorization code over BroadcastChannel without booting the workspace.
const handledOAuthPopup = !desktopCapability && handleAccountOAuthCallback();

const container = document.getElementById("root");
if (container && !handledOAuthPopup) {
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
