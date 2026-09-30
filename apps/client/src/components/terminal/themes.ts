import type { TerminalTheme } from "../../../modules/link-terminal/src";

// Tuned to sit with the app's palette: neutral grounds, the brand blue as the
// cursor, ANSI colours legible on both.

export const darkTerminal: TerminalTheme = {
  background: "#0e0f13",
  foreground: "#e4e4ec",
  cursor: "#7d95ff",
  selectionBackground: "rgba(125,149,255,0.32)",
  black: "#1c1d23",
  red: "#ff6b6b",
  green: "#5fd49a",
  yellow: "#f2c66d",
  blue: "#7d95ff",
  magenta: "#c6a8ff",
  cyan: "#6ed3e6",
  white: "#d6d7df",
  brightBlack: "#5c5e6b",
  brightRed: "#ff8f8f",
  brightGreen: "#86e3b5",
  brightYellow: "#f7d892",
  brightBlue: "#a2b3ff",
  brightMagenta: "#dac6ff",
  brightCyan: "#98e3f0",
  brightWhite: "#f4f4f8",
};

export const lightTerminal: TerminalTheme = {
  background: "#fbfbfd",
  foreground: "#24252e",
  cursor: "#4a6cf7",
  selectionBackground: "rgba(74,108,247,0.22)",
  black: "#24252e",
  red: "#c8352f",
  green: "#0b7a4f",
  yellow: "#9a6700",
  blue: "#3556db",
  magenta: "#7c4ddb",
  cyan: "#0e7490",
  white: "#9394a0",
  brightBlack: "#6b6d7a",
  brightRed: "#e0453e",
  brightGreen: "#0f9560",
  brightYellow: "#b58105",
  brightBlue: "#4a6cf7",
  brightMagenta: "#9163ea",
  brightCyan: "#1590ad",
  brightWhite: "#b7b8c2",
};
