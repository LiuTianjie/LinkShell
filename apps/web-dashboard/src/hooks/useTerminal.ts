// Binds an xterm.js instance to a BridgeClient's terminal stream. Terminal output
// goes straight to term.write (no React render per chunk), and user keystrokes /
// resizes flow back to the gateway. Mirrors the mobile TerminalView, minus the
// WebView indirection — in a browser xterm runs natively in the DOM.

import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type { BridgeClient, BridgeEvent } from "../lib/bridge-client";

function cssRgb(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value ? `rgb(${value})` : fallback;
}

function cssRgba(name: string, alpha: number, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value ? `rgb(${value} / ${alpha})` : fallback;
}

function readTerminalTheme(): NonNullable<ConstructorParameters<typeof Terminal>[0]>["theme"] {
  return {
    background: cssRgb("--c-canvas", "#0b0d0f"),
    foreground: cssRgb("--c-content-primary", "#e6e8eb"),
    cursor: cssRgb("--c-accent", "#2dd4bf"),
    selectionBackground: cssRgba("--c-accent", 0.22, "rgba(45,212,191,0.25)"),
    black: cssRgb("--c-content-faint", "#4e535a"),
    brightBlack: cssRgb("--c-content-muted", "#70767e"),
    white: cssRgb("--c-content-secondary", "#9ea5ad"),
    brightWhite: cssRgb("--c-content-primary", "#e9ebee"),
  };
}

export function useTerminal(
  bridge: BridgeClient | null,
  terminalId: string,
): { containerRef: React.RefObject<HTMLDivElement | null> } {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    if (!containerRef.current || !bridge) return;

    const term = new Terminal({
      fontFamily: "JetBrains Mono, ui-monospace, monospace",
      fontSize: 13,
      cursorBlink: true,
      theme: readTerminalTheme(),
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;

    // Replay buffered output so a reopened pane restores its prior content
    // (xterm is disposed on unmount; the bridge keeps a per-terminal buffer).
    const buffered = bridge.terminalBuffer(terminalId);
    if (buffered) term.write(buffered);

    // User input → gateway (bridge auto-claims control).
    const dataSub = term.onData((data) => bridge.sendInput(terminalId, data));
    const resizeSub = term.onResize(({ cols, rows }) => bridge.sendResize(terminalId, cols, rows));

    // Gateway output → terminal. On replayed resume, reset before re-writing.
    const off = bridge.onEvent((e: BridgeEvent) => {
      if (e.type === "terminal.reset" && e.terminalId === terminalId) {
        term.reset();
        return;
      }
      if (e.type === "terminal.output" && e.terminalId === terminalId) {
        term.write(e.data);
      }
    });

    // Fit on container resize.
    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
        bridge.sendResize(terminalId, term.cols, term.rows);
      } catch {}
    });
    ro.observe(containerRef.current);

    const themeObserver = new MutationObserver(() => {
      term.options.theme = readTerminalTheme();
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });

    // Announce initial size.
    bridge.sendResize(terminalId, term.cols, term.rows);

    return () => {
      dataSub.dispose();
      resizeSub.dispose();
      off();
      ro.disconnect();
      themeObserver.disconnect();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [bridge, terminalId]);

  return { containerRef };
}
