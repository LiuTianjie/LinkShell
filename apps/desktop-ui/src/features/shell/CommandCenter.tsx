import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useStore } from "zustand";
import {
  DESKTOP_LOCAL,
  isElectronRuntime,
  postDesktopMessage,
} from "../../bridge/desktop-bridge";
import {
  canUseFusionMode,
  computerNames,
  connectAndStartComputerFusion,
  engine,
  fusionStore,
  MANAGE_PAGES,
  routerStore,
  saveLocal,
  sessionTitle,
  stopComputerFusion,
  STORAGE_KEYS,
  useActiveDesktopPlatform,
  useI18n,
  useRouter,
  type Computer,
  type ManagePage,
} from "../../core";
import {
  DESKTOP_SHORTCUTS,
  formatShortcut,
} from "../../bridge/shortcuts";
import { AgentMark, DesktopIcon, type DesktopIconName } from "../../icons";
import { Dialog, isImeComposing, Kbd } from "../../primitives";
import { applyDesktopAppearance, type ThemeMode } from "../../theme";
import {
  computerPlatformIcon,
  currentFusionCapabilityEnv,
  displayComputerName,
  folderBasename,
  sessionRecency,
  switchToComputer,
  useConnectionStore,
} from "./shell-helpers";
import type { DesktopPlatform } from "../../bridge/desktop-bridge";

export interface CommandCenterProps {
  onRequestNewSession: (computerKey?: string, cwd?: string) => void;
  onOpenLocalPairingQr?: () => void;
  platformOverride?: DesktopPlatform;
}

interface CommandActionItem {
  id: string;
  group: string;
  title: string;
  subtitle?: string;
  keywords: string;
  icon: DesktopIconName | ReactNode;
  shortcut?: string;
  run: () => void;
}

const MANAGE_PAGE_ICONS: Record<ManagePage, DesktopIconName> = {
  overview: "host-daemon",
  devices: "phone-device",
  password: "lock",
  usage: "usage-meter",
  log: "file-text",
  updates: "sparkles",
  settings: "settings",
};

export function CommandCenter({
  onRequestNewSession,
  onOpenLocalPairingQr,
  platformOverride,
}: CommandCenterProps) {
  const { locale, t } = useI18n();
  const activePlatform = useActiveDesktopPlatform(platformOverride);
  const open = useRouter((s) => s.commandCenterOpen);
  const setOpen = useRouter((s) => s.setCommandCenterOpen);
  const navigate = useRouter((s) => s.navigate);
  const openSession = useRouter((s) => s.openSession);
  const openScreen = useRouter((s) => s.openScreen);
  const openFusion = useRouter((s) => s.openFusion);
  const openSystemModal = useRouter((s) => s.openSystemModal);
  const toggleSidebar = useRouter((s) => s.toggleSidebar);
  const toggleInspector = useRouter((s) => s.toggleInspector);
  const toggleBottomDock = useRouter((s) => s.toggleBottomDock);
  const setConnectModalOpen = useRouter((s) => s.setConnectModalOpen);
  const setShortcutSheetOpen = useRouter((s) => s.setShortcutSheetOpen);

  const computers = useStore(engine.state, (s) => s.computers);
  const localComputer = useStore(engine.state, (s) => s.localComputer);
  const activeConnection = useStore(engine.state, (s) => s.connection);
  const names = useStore(computerNames.store);
  const fusionByComputer = useStore(fusionStore, (s) => s.byComputer);
  const sessionsMap = useConnectionStore(activeConnection, (s) => s.sessions);

  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const activeRouteKind = useRouter((s) => s.activeRoute.kind);
  const inSession = activeRouteKind === "session";

  useEffect(() => {
    if (open) {
      setQuery("");
      setActiveIndex(0);
      queueMicrotask(() => {
        inputRef.current?.focus({ preventScroll: true });
      });
    }
  }, [open]);

  const activeComputer: Computer | undefined =
    activeConnection?.computer ?? localComputer ?? computers[0];
  const activeComputerKey = activeComputer?.key ?? DESKTOP_LOCAL;

  const setTheme = (mode: ThemeMode) => {
    saveLocal(STORAGE_KEYS.appearance, mode);
    applyDesktopAppearance(mode);
    if (isElectronRuntime()) {
      postDesktopMessage({ action: "appearance", value: mode });
    }
  };

  const allItems = useMemo<CommandActionItem[]>(() => {
    const items: CommandActionItem[] = [];
    const groupFusion = t("desktop.fusion.title");
    const groupQuick = t("desktop.shell.paletteWorkspace");
    const groupSessions = t("desktop.nav.sessions");
    const groupComputers = t("desktop.nav.computers");
    const groupSystem = t("desktop.localManagement");

    // 1. Global First-Class Fusion Mode Commands — reachable from ANY computer (including desktop:local)!
    const fusionEnv = currentFusionCapabilityEnv(activePlatform);
    for (const computer of computers) {
      if (computer.key === DESKTOP_LOCAL) continue;
      if (!canUseFusionMode(computer.key, computer.machine.platform, fusionEnv)) continue;
      const compName = displayComputerName(computer, names, locale);
      const fusionState = fusionByComputer[computer.key];
      const isConnected = Boolean(fusionState?.connected);

      if (computer.machine.online || isConnected) {
        items.push({
          id: `fusion-open-${computer.key}`,
          group: groupFusion,
          title: `${
            isConnected ? t("desktop.fusion.title") : t("desktop.fusion.start")
          } — ${compName}`,
          subtitle: isConnected
            ? t("desktop.fusion.windowCount", {
                count: Object.values(fusionState?.windowCounts ?? {}).reduce(
                  (a, b) => a + b,
                  0,
                ),
              })
            : t("desktop.fusion.subtitle"),
          keywords: `fusion 融合 应用 窗口 remote mac ${compName}`,
          icon: "fusion-mode",
          run: () => {
            engine.select(computer);
            openFusion(computer.key);
            if (!isConnected) {
              void connectAndStartComputerFusion(computer.key);
            }
          },
        });

        if (isConnected) {
          items.push({
            id: `fusion-stop-${computer.key}`,
            group: groupFusion,
            title: `${t("desktop.fusion.stop")} — ${compName}`,
            keywords: `stop disconnect fusion 结束 断开 融合 ${compName}`,
            icon: "close",
            run: () => {
              void stopComputerFusion(computer.key, compName);
            },
          });
        }
      }
    }

    // 2. Primary Workspace & Pane Commands
    items.push(
      {
        id: "new-session",
        group: groupQuick,
        title: t("desktop.newSession"),
        subtitle: displayComputerName(activeComputer, names, locale),
        keywords: "new session create 新建 会话 thread agent",
        icon: "plus",
        shortcut: formatShortcut(DESKTOP_SHORTCUTS.newSession, activePlatform),
        run: () => onRequestNewSession(activeComputerKey),
      },
      {
        id: "connect-computer",
        group: groupQuick,
        title: t("desktop.fleet.connectComputer"),
        keywords: "pair connect login account 连接 配对 登录 扫码",
        icon: "gateway-relay",
        run: () => setConnectModalOpen(true),
      },
      ...(onOpenLocalPairingQr
        ? [
            {
              id: "pair-phone",
              group: groupQuick,
              title: t("desktop.fleet.pairDevice"),
              keywords: "qr phone mobile 配对 手机 二维码",
              icon: "phone-device" as const,
              run: () => onOpenLocalPairingQr(),
            },
          ]
        : []),
      {
        id: "toggle-sidebar",
        group: groupQuick,
        title: t("desktop.toggleSidebar"),
        keywords: "sidebar rail 侧栏 折叠",
        icon: "sidebar-toggle",
        shortcut: formatShortcut(DESKTOP_SHORTCUTS.toggleSidebar, activePlatform),
        run: () => toggleSidebar(),
      },
    );
    // Panels belong to an open session; offering them elsewhere toggled hidden state with no visible effect.
    if (inSession) items.push(
      {
        id: "toggle-terminal",
        group: groupQuick,
        title: t("desktop.toggleBottomDock"),
        keywords: "terminal shell console 终端 底部",
        icon: "bottom-dock",
        shortcut: formatShortcut(DESKTOP_SHORTCUTS.terminal, activePlatform),
        run: () => toggleBottomDock(),
      },
      {
        id: "toggle-inspector",
        group: groupQuick,
        title: t("desktop.toggleInspector"),
        keywords: "inspector panel diff changes files 右侧面板 检查器 改动",
        icon: "inspector-toggle",
        shortcut: formatShortcut(DESKTOP_SHORTCUTS.toggleInspector, activePlatform),
        run: () => toggleInspector(),
      },
      {
        id: "inspector-changes",
        group: groupQuick,
        title: t("desktop.inspector.changes"),
        keywords: "diff git changes 改动 检查器",
        icon: "diff-changes",
        run: () => {
          const r = routerStore.getState();
          r.setInspectorTab("changes");
          r.toggleInspector(true);
        },
      },
      {
        id: "inspector-files",
        group: groupQuick,
        title: t("desktop.inspector.files"),
        keywords: "files tree editor 文件 浏览",
        icon: "file-code",
        run: () => {
          const r = routerStore.getState();
          r.setInspectorTab("files");
          r.toggleInspector(true);
        },
      },
      {
        id: "inspector-ports",
        group: groupQuick,
        title: t("desktop.inspector.ports"),
        keywords: "ports preview web 端口 预览",
        icon: "port-preview",
        run: () => {
          const r = routerStore.getState();
          r.setInspectorTab("ports");
          r.toggleInspector(true);
        },
      },
    );
    items.push(
      {
        id: "nav-projects",
        group: groupQuick,
        title: t("desktop.nav.projects"),
        keywords: "projects folders 项目 目录",
        icon: "folder-open",
        run: () => navigate({ kind: "projects" }),
      },
      {
        id: "nav-computers",
        group: groupQuick,
        title: t("desktop.nav.computers"),
        keywords: "computers machines fleet 电脑 设备 连接",
        icon: "computer-pc",
        run: () => navigate({ kind: "computers" }),
      },
      {
        id: "nav-archive",
        group: groupQuick,
        title: t("desktop.nav.archive"),
        keywords: "archive history 已归档 历史",
        icon: "archive",
        run: () => navigate({ kind: "archive" }),
      },
    );

    // 3. Active & Recent Sessions on Selected Computer
    const liveSessions = Object.values(sessionsMap)
      .filter((s) => !s.archived)
      .sort((a, b) => sessionRecency(b) - sessionRecency(a))
      .slice(0, 24);

    for (const session of liveSessions) {
      const title = sessionTitle(session);
      const folder = folderBasename(session.cwd);
      items.push({
        id: `session-${session.id}`,
        group: groupSessions,
        title,
        subtitle: folder,
        keywords: `${title} ${folder} ${session.agent} session 会话`,
        icon: <AgentMark agent={session.agent} size={16} />,
        run: () => openSession(activeComputerKey, session.id),
      });
    }

    // 4. Computers & Remote Desktop
    for (const computer of computers) {
      const compName = displayComputerName(computer, names, locale);
      items.push({
        id: `switch-computer-${computer.key}`,
        group: groupComputers,
        title: compName,
        subtitle:
          computer.key === activeComputerKey ? t("desktop.shell.selected") : undefined,
        keywords: `computer switch 切换 电脑 ${compName} ${computer.machine.platform ?? ""}`,
        icon: computerPlatformIcon(computer.machine.platform),
        run: () => switchToComputer(computer),
      });

      if (computer.key !== DESKTOP_LOCAL && computer.machine.online) {
        items.push({
          id: `screen-${computer.key}`,
          group: groupComputers,
          title: `${t("desktop.nav.screen")} — ${compName}`,
          keywords: `remote screen desktop 远程屏幕 桌面 ${compName}`,
          icon: "remote-screen",
          run: () => {
            engine.select(computer);
            openScreen(computer.key);
          },
        });
      }
    }

    // 5. System, Local Host Management, Appearance & Shortcuts
    const pageI18nMap: Record<ManagePage, Parameters<typeof t>[0]> = {
      overview: "desktop.manage.overview",
      devices: "desktop.manage.devices",
      password: "desktop.manage.password",
      usage: "desktop.manage.usage",
      log: "desktop.manage.log",
      updates: "desktop.manage.updates",
      settings: "desktop.manage.settings",
    };

    for (const page of MANAGE_PAGES) {
      const label = t(pageI18nMap[page]);
      items.push({
        id: `manage-${page}`,
        group: groupSystem,
        title: `${t("desktop.localManagement")} · ${label}`,
        keywords: `manage host system 本机 管理 服务 ${page} ${label}`,
        icon: MANAGE_PAGE_ICONS[page],
        shortcut: page === "settings" ? formatShortcut(DESKTOP_SHORTCUTS.settings, activePlatform) : undefined,
        run: () => openSystemModal(page),
      });
    }

    items.push(
      {
        id: "theme-light",
        group: groupSystem,
        title: `${t("desktop.manage.appearance")} · ${t("desktop.manage.appearanceLight")}`,
        keywords: "theme light appearance 浅色 亮色 主题 外观",
        icon: "sun",
        run: () => setTheme("light"),
      },
      {
        id: "theme-dark",
        group: groupSystem,
        title: `${t("desktop.manage.appearance")} · ${t("desktop.manage.appearanceDark")}`,
        keywords: "theme dark appearance 深色 暗黑 主题 外观",
        icon: "moon",
        run: () => setTheme("dark"),
      },
      {
        id: "theme-system",
        group: groupSystem,
        title: `${t("desktop.manage.appearance")} · ${t("desktop.manage.appearanceSystem")}`,
        keywords: "theme system auto 跟随系统 自动 主题 外观",
        icon: "sliders",
        run: () => setTheme("system"),
      },
      {
        id: "shortcuts-sheet",
        group: groupSystem,
        title: t("desktop.shortcuts"),
        keywords: "shortcuts keys help 快捷键 帮助",
        icon: "command",
        shortcut: "?",
        run: () => setShortcutSheetOpen(true),
      },
    );

    return items;
  }, [
    activeComputer,
    activeComputerKey,
    activePlatform,
    computers,
    inSession,
    fusionByComputer,
    locale,
    names,
    navigate,
    onOpenLocalPairingQr,
    onRequestNewSession,
    openFusion,
    openScreen,
    openSession,
    openSystemModal,
    sessionsMap,
    setConnectModalOpen,
    setShortcutSheetOpen,
    t,
    toggleBottomDock,
    toggleInspector,
    toggleSidebar,
  ]);

  const filteredItems = useMemo(() => {
    const trimmed = query.trim().toLowerCase();
    if (!trimmed) return allItems;
    const tokens = trimmed.split(/\s+/).filter(Boolean);
    return allItems.filter((item) => {
      const haystack = `${item.title} ${item.subtitle ?? ""} ${item.keywords} ${item.group}`.toLowerCase();
      return tokens.every((tok) => haystack.includes(tok));
    });
  }, [allItems, query]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  const activeOptionId = filteredItems[activeIndex]
    ? `ls-command-option-${filteredItems[activeIndex].id.replace(/[^a-zA-Z0-9_-]/g, "_")}`
    : undefined;

  // Arrow keys move the highlight; keep it on screen like any native list.
  useEffect(() => {
    if (!open || !activeOptionId) return;
    const option = listRef.current?.querySelector<HTMLElement>(`#${activeOptionId}`);
    option?.scrollIntoView?.({ block: "nearest" });
  }, [activeOptionId, open]);

  const groupedFiltered = useMemo(() => {
    const groups: { name: string; entries: { item: CommandActionItem; flatIndex: number }[] }[] = [];
    const byName = new Map<string, (typeof groups)[number]>();
    filteredItems.forEach((item, flatIndex) => {
      let bucket = byName.get(item.group);
      if (!bucket) {
        bucket = { name: item.group, entries: [] };
        byName.set(item.group, bucket);
        groups.push(bucket);
      }
      bucket.entries.push({ item, flatIndex });
    });
    return groups;
  }, [filteredItems]);

  const executeItem = (item: CommandActionItem | undefined) => {
    if (!item) return;
    setOpen(false);
    item.run();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      size="palette"
      dismissible
      aria-label={t("desktop.commandCenter")}
    >
      <div className="command-center">
        <div className="command-center__search-bar">
          <span className="command-center__search-icon" aria-hidden="true">
            <DesktopIcon name="search" size="md" />
          </span>
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls="ls-command-center-results"
            aria-activedescendant={activeOptionId}
            aria-label={t("desktop.commandCenter")}
            value={query}
            placeholder={t("desktop.shell.palettePlaceholder")}
            className="command-center__input"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (isImeComposing(event)) return;
              if (event.key === "ArrowDown") {
                event.preventDefault();
                if (filteredItems.length > 0) {
                  setActiveIndex((prev) => (prev + 1) % filteredItems.length);
                }
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                if (filteredItems.length > 0) {
                  setActiveIndex((prev) =>
                    prev <= 0 ? filteredItems.length - 1 : prev - 1,
                  );
                }
              } else if (event.key === "Enter") {
                event.preventDefault();
                executeItem(filteredItems[activeIndex]);
              }
            }}
          />
          <Kbd shortcut="Esc" />
        </div>

        <div
          id="ls-command-center-results"
          ref={listRef}
          role="listbox"
          aria-label={t("desktop.commandCenter")}
          className="command-center__list"
        >
          {groupedFiltered.length > 0 ? (
            groupedFiltered.map((group) => (
              <div key={group.name} className="command-center__group">
                <div className="command-center__group-label">{group.name}</div>
                {group.entries.map(({ item, flatIndex }) => {
                  const isActive = flatIndex === activeIndex;
                  return (
                    <button
                      key={item.id}
                      id={`ls-command-option-${item.id.replace(/[^a-zA-Z0-9_-]/g, "_")}`}
                      type="button"
                      tabIndex={-1}
                      role="option"
                      aria-selected={isActive}
                      data-active={isActive ? "true" : undefined}
                      className="command-center__item"
                      onPointerMove={() => {
                        if (activeIndex !== flatIndex) setActiveIndex(flatIndex);
                      }}
                      onClick={() => executeItem(item)}
                    >
                      <span className="command-center__item-icon" aria-hidden="true">
                        {typeof item.icon === "string" ? (
                          <DesktopIcon name={item.icon as DesktopIconName} size="md" />
                        ) : (
                          item.icon
                        )}
                      </span>
                      <span className="command-center__item-body">
                        <span className="command-center__item-title">{item.title}</span>
                        {item.subtitle ? (
                          <span className="command-center__item-sub">{item.subtitle}</span>
                        ) : null}
                      </span>
                      {item.shortcut ? <Kbd>{item.shortcut}</Kbd> : null}
                    </button>
                  );
                })}
              </div>
            ))
          ) : (
            <div className="command-center__empty">{t("desktop.shell.paletteEmpty")}</div>
          )}
        </div>

        <div className="command-center__footer">
          <div className="command-center__hints">
            <span className="command-center__hint">
              <Kbd>↑↓</Kbd>
              <span>{t("desktop.shell.paletteNavigate")}</span>
            </span>
            <span className="command-center__hint">
              <Kbd>↵</Kbd>
              <span>{t("desktop.shell.paletteRun")}</span>
            </span>
          </div>
          <span>{filteredItems.length}</span>
        </div>
      </div>
    </Dialog>
  );
}
