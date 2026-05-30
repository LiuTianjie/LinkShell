// Binds an xterm.js instance to a BridgeClient's terminal stream. Terminal output
// goes straight to term.write (no React render per chunk), and user keystrokes /
// resizes flow back to the gateway. Mirrors the mobile TerminalView, minus the
// WebView indirection — in a browser xterm runs natively in the DOM.

import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type { BridgeClient, BridgeEvent } from "../lib/bridge-client";

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
      theme: {
        background: "#0b0d0f",
        foreground: "#e6e8eb",
        cursor: "#2dd4bf",
        selectionBackground: "rgba(45,212,191,0.25)",
      },
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

    // Announce initial size.
    bridge.sendResize(terminalId, term.cols, term.rows);

    return () => {
      dataSub.dispose();
      resizeSub.dispose();
      off();
      ro.disconnect();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [bridge, terminalId]);

  return { containerRef };
}
