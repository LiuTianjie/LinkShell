import "./styles.css";
import { Dialogs } from "./components/Dialogs";
import React from "react";
import { TooltipProvider } from "./components/ui/tooltip";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { themeStyles } from "./theme";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <style>{themeStyles}</style>
    <TooltipProvider delayDuration={350}>
      <Dialogs>
        <App />
      </Dialogs>
    </TooltipProvider>
  </React.StrictMode>,
);
