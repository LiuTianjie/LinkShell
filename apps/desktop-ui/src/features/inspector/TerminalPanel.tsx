import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type ClipboardEvent,
  type CSSProperties,
  type DragEvent,
  type JSX,
} from "react";
import { useStore } from "zustand";
import {
  DESKTOP_SHORTCUTS,
  formatShortcut,
} from "../../bridge/shortcuts";
import type { Connection } from "../../core/connections";
import { routerStore } from "../../core/router-store";
import {
  MAX_TERMINAL_FONT_SIZE,
  MIN_TERMINAL_FONT_SIZE,
} from "../../core/terminal-replay";
import { DesktopIcon } from "../../icons";
import {
  Badge,
  Button,
  EmptyState,
  ErrorBoundary,
  IconButton,
  SplitResizer,
  Toolbar,
} from "../../primitives";
import { useInspectorI18n } from "./i18n-inspector";
import { getTerminalStageController } from "./terminal-runtime";
import { useInspectorConnection } from "./use-inspector-connection";

export interface TerminalStageHostProps {
  stageKey: string;
  computerKey: string;
  connection?: Connection;
  online: boolean;
  sessionId?: string;
  cwd?: string;
  dockPosition: "right" | "bottom" | "standalone";
  active?: boolean;
  onToggleDock?: () => void;
  onCloseDock?: () => void;
}

export function TerminalStageHost({
  stageKey,
  computerKey,
  connection,
  online,
  sessionId,
  cwd,
  dockPosition,
  active = true,
  onToggleDock,
  onCloseDock,
}: TerminalStageHostProps) {
  const { t, ti } = useInspectorI18n();
  const slotRef = useRef<HTMLDivElement | null>(null);

  const controller = useMemo(
    () => getTerminalStageController(stageKey, computerKey),
    [stageKey, computerKey],
  );
  const snap = useStore(controller.store);

  useEffect(() => {
    controller.bindConnection(connection);
    if (connection && online && active) {
      void controller.refreshList({ cwd, sessionId });
    }
  }, [controller, connection, online, active, cwd, sessionId]);

  // Atomic DOM reparenting (`Element.prototype.moveBefore()`): moves the live stage element
  // into whichever active slot (Inspector vs BottomTerminalDock) currently owns it without unmounting xterm!
  useLayoutEffect(() => {
    if (!active) return undefined;
    const slot = slotRef.current;
    if (!slot) return undefined;
    controller.attachToSlot(slot);
    if (dockPosition === "bottom") {
      return () => {
        controller.parkBeforeUnmount(slot);
      };
    }
    return undefined;
  }, [controller, active, dockPosition, snap.terminals.length, snap.activeId]);

  const handleDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (files.length === 0) return;
      event.preventDefault();
      void controller.uploadFilesToActive(files, cwd);
    },
    [controller, cwd],
  );

  const handlePaste = useCallback(
    (event: ClipboardEvent<HTMLDivElement>) => {
      const files = Array.from(event.clipboardData?.files ?? []);
      if (files.length === 0) return;
      event.preventDefault();
      void controller.uploadFilesToActive(files, cwd);
    },
    [controller, cwd],
  );

  const dockShortcut = formatShortcut(DESKTOP_SHORTCUTS.terminal);

  return (
    <div
      className="inspector-terminal-shell"
      data-dock-position={dockPosition}
      onDragOver={(e) => {
        if (e.dataTransfer?.types?.includes("Files")) {
          e.preventDefault();
        }
      }}
      onDrop={handleDrop}
      onPaste={handlePaste}
    >
      <div className="inspector-terminal-bar">
        <div
          className="inspector-terminal-tabs"
          role="tablist"
          aria-label={t("desktop.inspector.terminal")}
        >
          {snap.terminals.map((term, idx) => {
            const isActive = snap.activeId === term.id;
            const titleText =
              term.title?.trim() ||
              ti("terminalTabLabel", { index: idx + 1 });
            return (
              <div
                key={term.id}
                data-active={isActive ? "true" : undefined}
                className="inspector-terminal-tab"
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  className="inspector-terminal-tab__select"
                  onClick={() => {
                    controller.selectTerminal(term.id);
                    controller.focusActive();
                  }}
                >
                  <DesktopIcon name="terminal" size="xs" />
                  <span className="ls-truncate">{titleText}</span>
                  {term.exitCode !== undefined && term.exitCode !== null ? (
                    <Badge variant="tag" tone="neutral" data-tabular="">
                      {term.exitCode}
                    </Badge>
                  ) : null}
                </button>
                <IconButton
                  icon="close"
                  size="icon-sm"
                  label={ti("closeTerminal")}
                  onClick={() => {
                    void controller.closeTerminal(term.id);
                  }}
                />
              </div>
            );
          })}

          <IconButton
            icon="plus"
            size="icon-sm"
            label={ti("newTerminal")}
            disabled={!online}
            disabledReason={!online ? ti("offlineTitle") : undefined}
            onClick={() => {
              void controller.createTerminal({ cwd, sessionId });
            }}
          />
        </div>

        <Toolbar label={t("desktop.inspector.terminal")}>
          <IconButton
            icon="minus"
            size="icon-sm"
            label={ti("fontSmaller")}
            disabled={snap.fontSize <= MIN_TERMINAL_FONT_SIZE}
            onClick={() => controller.setFontSize(snap.fontSize - 1)}
          />
          <Badge variant="tag" tone="neutral" data-tabular="">
            {`${snap.fontSize}px`}
          </Badge>
          <IconButton
            icon="plus"
            size="icon-sm"
            label={ti("fontLarger")}
            disabled={snap.fontSize >= MAX_TERMINAL_FONT_SIZE}
            onClick={() => controller.setFontSize(snap.fontSize + 1)}
          />

          {onToggleDock && dockPosition !== "right" ? (
            <IconButton
              icon={
                dockPosition === "bottom" ? "inspector-toggle" : "bottom-dock"
              }
              size="icon-sm"
              shortcut={dockShortcut}
              label={
                dockPosition === "bottom"
                  ? ti("dockToRight")
                  : ti("dockToBottom")
              }
              onClick={onToggleDock}
            />
          ) : null}

          {onCloseDock ? (
            <IconButton
              icon="close"
              size="icon-sm"
              shortcut={dockShortcut}
              label={ti("closeBottomDock")}
              onClick={onCloseDock}
            />
          ) : null}
        </Toolbar>
      </div>

      <div ref={slotRef} className="inspector-terminal-slot" />

      {snap.terminals.length === 0 ? (
        <div
          style={{
            position: "absolute",
            inset: "36px 0 0 0",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            pointerEvents: "auto",
          }}
        >
          <EmptyState
            compact
            icon="terminal"
            title={online ? ti("emptyTerminalTitle") : ti("offlineTitle")}
            description={online ? ti("emptyTerminalDesc") : ti("offlineDesc")}
            actions={
              online ? (
                <Button
                  size="sm"
                  variant="primary"
                  leadingIcon="plus"
                  onClick={() => {
                    void controller.createTerminal({ cwd, sessionId });
                  }}
                >
                  {ti("newTerminal")}
                </Button>
              ) : undefined
            }
          />
        </div>
      ) : null}
    </div>
  );
}

export interface TerminalPanelProps {
  computerKey: string;
  connection?: Connection;
  online: boolean;
  sessionId?: string;
  cwd?: string;
}

export function TerminalPanel({
  computerKey,
  connection,
  online,
  sessionId,
  cwd,
}: TerminalPanelProps) {
  const { ti } = useInspectorI18n();
  const bottomDockOpen = useStore(routerStore, (s) => s.bottomDockOpen);

  return (
    <div className="inspector-panel-fill" style={{ position: "relative" }}>
      <div
        className="inspector-panel-fill"
        style={bottomDockOpen ? { display: "none" } : undefined}
      >
        <TerminalStageHost
          stageKey={computerKey || "default"}
          computerKey={computerKey || "default"}
          connection={connection}
          online={online}
          sessionId={sessionId}
          cwd={cwd}
          dockPosition="right"
          active={!bottomDockOpen}
        />
      </div>

      {bottomDockOpen ? (
        <div className="inspector-panel-fill">
          <EmptyState
            icon="bottom-dock"
            title={ti("terminalDockedTitle")}
            description={ti("terminalDockedDesc")}
            actions={
              <Button
                size="sm"
                variant="secondary"
                leadingIcon="inspector-toggle"
                shortcut={formatShortcut(DESKTOP_SHORTCUTS.terminal)}
                onClick={() => routerStore.getState().toggleBottomDock(false)}
              >
                {ti("dockToRight")}
              </Button>
            }
          />
        </div>
      ) : null}
    </div>
  );
}

export interface BottomTerminalDockProps {
  computerKey: string;
  sessionId?: string;
  cwd?: string;
}

export function BottomTerminalDock({
  computerKey,
  sessionId,
  cwd: cwdProp,
}: BottomTerminalDockProps): JSX.Element {
  const { t, ti } = useInspectorI18n();
  const bottomDockOpen = useStore(routerStore, (s) => s.bottomDockOpen);
  const bottomDockHeight = useStore(routerStore, (s) => s.bottomDockHeight);

  const { connection, online, cwd } = useInspectorConnection({
    computerKey,
    sessionId,
    cwd: cwdProp,
  });

  if (!bottomDockOpen) {
    return <></>;
  }

  return (
    <section
      aria-label={t("desktop.inspector.terminal")}
      className="desktop-bottom-dock inspector-bottom-dock"
      style={
        {
          "--bottom-dock-h": `${bottomDockHeight}px`,
          height: "var(--bottom-dock-h)",
        } as CSSProperties
      }
    >
      <SplitResizer
        orientation="horizontal"
        side="start"
        size={bottomDockHeight}
        min={140}
        max={640}
        defaultSize={260}
        cssVariable="--bottom-dock-h"
        targetSelector=".desktop-bottom-dock"
        paneSelector=".desktop-bottom-dock"
        label={ti("resizeBottomDock")}
        className="inspector-bottom-resizer"
        collapse={{
          threshold: 96,
          onCollapse: () => routerStore.getState().toggleBottomDock(false),
        }}
        onResize={(next) => routerStore.getState().setBottomDockHeight(next)}
      />

      <ErrorBoundary resetKeys={[computerKey, sessionId]}>
        <TerminalStageHost
          stageKey={computerKey || "default"}
          computerKey={computerKey || "default"}
          connection={connection}
          online={online}
          sessionId={sessionId}
          cwd={cwd}
          dockPosition="bottom"
          active
          onToggleDock={() => {
            routerStore.getState().toggleBottomDock(false);
            routerStore.getState().toggleInspector(true);
          }}
          onCloseDock={() => routerStore.getState().toggleBottomDock(false)}
        />
      </ErrorBoundary>
    </section>
  );
}
