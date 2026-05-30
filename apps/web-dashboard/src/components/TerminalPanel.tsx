import { useEffect, useState, useCallback } from "react";
import { useTerminal } from "../hooks/useTerminal";
import type { BridgeClient, BridgeEvent } from "../lib/bridge-client";
import { IconPlus, IconClose, IconTerminal } from "./icons";

interface Tab {
  id: string;
  label: string;
}

// One xterm bound to a terminalId. Keyed by id at the call site so switching
// tabs remounts a fresh instance, which replays the bridge's per-terminal
// buffer — inactive tabs therefore don't lose content.
function TerminalView({ bridge, terminalId }: { bridge: BridgeClient | null; terminalId: string }) {
  const { containerRef } = useTerminal(bridge, terminalId);
  return <div ref={containerRef} className="xterm-host min-h-0 flex-1 p-2" />;
}

export function TerminalPanel({
  bridge,
  onNewTerminal,
}: {
  bridge: BridgeClient | null;
  onNewTerminal?: () => void;
}) {
  // Seed with the host's always-present "default" terminal so there's content
  // immediately; more tabs appear as terminals are spawned/discovered.
  const [tabs, setTabs] = useState<Tab[]>([{ id: "default", label: "默认" }]);
  const [activeId, setActiveId] = useState<string>("default");

  const upsertTab = useCallback((id: string, label?: string) => {
    setTabs((prev) =>
      prev.some((t) => t.id === id)
        ? prev
        : [...prev, { id, label: label || id.slice(0, 8) }],
    );
  }, []);

  useEffect(() => {
    if (!bridge) return;
    bridge.requestTerminalList();
    const off = bridge.onEvent((e: BridgeEvent) => {
      if (e.type === "terminal.output") {
        upsertTab(e.terminalId);
        return;
      }
      if (e.type === "terminal.list") {
        const env = e.envelope;
        const payload = env.payload as Record<string, unknown> | undefined;
        if (env.type === "terminal.spawned") {
          const id = payload?.terminalId as string | undefined;
          if (id) {
            upsertTab(id, payload?.projectName as string | undefined);
            setActiveId(id);
          }
        } else if (env.type === "terminal.list") {
          const list = Array.isArray(payload?.terminals) ? (payload!.terminals as Record<string, unknown>[]) : [];
          for (const t of list) {
            const id = t.terminalId as string | undefined;
            if (id && t.status !== "exited") upsertTab(id, t.projectName as string | undefined);
          }
        }
      }
    });
    return off;
  }, [bridge, upsertTab]);

  const spawn = () => onNewTerminal?.();

  const close = (id: string) => {
    bridge?.killTerminal(id);
    setTabs((prev) => {
      const next = prev.filter((t) => t.id !== id);
      if (id === activeId) setActiveId(next[0]?.id ?? "default");
      return next.length > 0 ? next : [{ id: "default", label: "默认" }];
    });
  };

  return (
    <div className="flex h-full flex-col bg-canvas">
      {/* Tab bar */}
      <div className="flex items-center gap-0.5 border-b border-border bg-surface px-1.5 py-1">
        <IconTerminal size={13} className="mx-1 shrink-0 text-content-faint" />
        <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
          {tabs.map((t) => (
            <div
              key={t.id}
              className={`group flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-2xs transition-colors ${
                t.id === activeId
                  ? "bg-surface-overlay text-content-primary"
                  : "text-content-muted hover:bg-surface-overlay/60"
              }`}
            >
              <button onClick={() => setActiveId(t.id)} className="cursor-pointer font-mono">
                {t.label}
              </button>
              {tabs.length > 1 && (
                <button
                  onClick={() => close(t.id)}
                  className="cursor-pointer rounded text-content-faint opacity-0 transition hover:text-danger group-hover:opacity-100"
                  aria-label="关闭终端"
                >
                  <IconClose size={11} />
                </button>
              )}
            </div>
          ))}
        </div>
        <button
          onClick={spawn}
          className="ml-1 shrink-0 cursor-pointer rounded-md p-1 text-content-muted transition-colors hover:bg-surface-overlay hover:text-accent"
          title="新建终端"
          aria-label="新建终端"
        >
          <IconPlus size={14} />
        </button>
      </div>
      {/* Active terminal (remounts on tab switch → replays its buffer) */}
      <TerminalView key={activeId} bridge={bridge} terminalId={activeId} />
    </div>
  );
}
