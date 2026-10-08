import { Dialogs } from "./components/Dialogs";
import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { themeStyles } from "./theme";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <style>{themeStyles}</style>
    <Dialogs>
      <App />
    </Dialogs>
  </React.StrictMode>,
);
