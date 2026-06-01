import { useEffect, useState, useCallback, useRef } from "react";
import { useTerminal } from "../hooks/useTerminal";
import type { BridgeClient, BridgeEvent } from "../lib/bridge-client";
import { IconPlus, IconClose, IconTerminal } from "./icons";

interface Tab {
  id: string;
  label: string;
}

// Human label for a terminal. The host's always-present shell is "default";
// spawned terminals carry a projectName, otherwise we fall back to a short id.
function tabLabel(id: string, projectName?: string): string {
  if (id === "default") return "默认";
  return projectName || id.slice(0, 8);
}

// Remember the last terminal the user was viewing, per session, so switching
// the right panel away and back (or reloading) restores that tab instead of
// snapping to the empty "default" shell.
const lastTerminalKey = (sessionId: string) => `linkshell:web:lastTerminal:${sessionId}`;

function loadLastTerminalId(sessionId: string | undefined): string | null {
  if (!sessionId) return null;
  try {
    return localStorage.getItem(lastTerminalKey(sessionId));
  } catch {
    return null;
  }
}

function saveLastTerminalId(sessionId: string | undefined, id: string): void {
  if (!sessionId) return;
  try {
    localStorage.setItem(lastTerminalKey(sessionId), id);
  } catch {
    // Ignore storage failures (private mode / quota) — selection still works
    // for the current mount, we just can't persist it.
  }
}

// Pick which terminal to show after the host's authoritative list arrives.
// Preference: the terminal the user last viewed (if still alive) → the most
// recently spawned non-default terminal (Map insertion order, last = newest) →
// the first living terminal. Returns null when the host has no live terminals.
// This is what makes a process the user started reappear instead of the panel
// snapping back to the empty default shell.
function pickActiveTerminal(livingIds: string[], remembered: string | null): string | null {
  if (livingIds.length === 0) return null;
  if (remembered && livingIds.includes(remembered)) return remembered;
  const nonDefault = livingIds.filter((id) => id !== "default");
  if (nonDefault.length > 0) return nonDefault[nonDefault.length - 1]!;
  return livingIds[0]!;
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
  const sessionId = bridge?.sessionId;

  // Tabs are rebuilt from the host's authoritative terminal.list on mount, so a
  // remounted panel (right-panel switch / reload / new device) reflects what's
  // actually running on the host instead of a stale hardcoded seed. Start empty
  // and let the list response populate it.
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeId, setActiveId] = useState<string>("default");

  // One-shot guards so the authoritative list only drives the initial active
  // selection (later user clicks win) and we never double-spawn on a re-render.
  const initializedRef = useRef(false);
  const spawnedIfEmptyRef = useRef(false);

  const upsertTab = useCallback((id: string, label?: string) => {
    setTabs((prev) =>
      prev.some((t) => t.id === id)
        ? prev
        : [...prev, { id, label: tabLabel(id, label) }],
    );
  }, []);

  useEffect(() => {
    if (!bridge) return;
    // Reset per-mount guards (a new bridge means a fresh session view).
    initializedRef.current = false;
    spawnedIfEmptyRef.current = false;
    // Snapshot the remembered terminal up front, before the persistence effect
    // (which runs later in this commit) can overwrite it with the placeholder
    // "default" — that read is what lets us restore the user's last tab.
    const rememberedId = loadLastTerminalId(sessionId);
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
            setActiveId(id); // a freshly spawned terminal becomes active
          }
          return;
        }
        if (env.type === "terminal.list") {
          const raw = Array.isArray(payload?.terminals)
            ? (payload!.terminals as Record<string, unknown>[])
            : [];
          const living = raw.filter(
            (t) => typeof t.terminalId === "string" && t.status !== "exited",
          );
          // Rebuild the tab set from the authoritative living list.
          const nextTabs: Tab[] = living.map((t) => ({
            id: t.terminalId as string,
            label: tabLabel(t.terminalId as string, t.projectName as string | undefined),
          }));
          setTabs(nextTabs);

          // Drive the initial active selection / spawn-if-empty exactly once.
          if (!initializedRef.current) {
            initializedRef.current = true;
            const livingIds = nextTabs.map((t) => t.id);
            const pick = pickActiveTerminal(livingIds, rememberedId);
            if (pick) {
              setActiveId(pick);
            } else if (!spawnedIfEmptyRef.current) {
              // Host has no live terminals — start one in the session cwd so the
              // panel is never empty. The resulting terminal.spawned selects it.
              spawnedIfEmptyRef.current = true;
              onNewTerminal?.();
            }
          }
        }
      }
    });
    return off;
  }, [bridge, upsertTab, onNewTerminal]);

  // Persist the active terminal per session so a remount restores this view.
  // Gated on initialization so the placeholder "default" we start with can't
  // overwrite a previously remembered id before the host's list arrives.
  useEffect(() => {
    if (initializedRef.current && activeId) saveLastTerminalId(sessionId, activeId);
  }, [sessionId, activeId]);

  const spawn = () => onNewTerminal?.();

  const close = (id: string) => {
    bridge?.killTerminal(id);
    setTabs((prev) => {
      const next = prev.filter((t) => t.id !== id);
      if (id === activeId) setActiveId(next[next.length - 1]?.id ?? "default");
      return next;
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
