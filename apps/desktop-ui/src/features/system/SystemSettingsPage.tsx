import { useEffect, useState } from "react";
import { LOCALE_LABELS, type LocalePreference } from "@linkshell/client-core";
import {
  DESKTOP_APPEARANCE_EVENT,
  getShellAppearance,
  revealOnDesktop,
  setAppearanceBridge,
} from "../../bridge/desktop-bridge";
import {
  STORAGE_KEYS,
  copyCommandPath,
  installCommand,
  openLoginItems,
  openSetup,
  readLocal,
  reportDesktopError,
  saveLocal,
  serviceAction,
  setDesktopSetting,
  setLaunchAtLogin,
  setScreenSharing,
  splitPath,
  standalone as isStandalone,
  useActiveDesktopPlatform,
  useManagement,
} from "../../core";
import { DesktopIcon } from "../../icons";
import { Badge, Button, Select, Switch, Tab, TabList, Tabs } from "../../primitives";
import { applyDesktopAppearance, type ThemeMode } from "../../theme";
import { useSystemI18n } from "./system-i18n";

function readAppearanceMode(): ThemeMode {
  const fromShell = getShellAppearance();
  if (fromShell === "light" || fromShell === "dark" || fromShell === "system") {
    return fromShell;
  }
  const saved = readLocal<string>(STORAGE_KEYS.appearance, "system");
  return saved === "light" || saved === "dark" ? saved : "system";
}

function MiddleTruncatedPath({ path }: { path: string }) {
  const [head, tail] = splitPath(path);
  return (
    <span className="ls-system-path" title={path}>
      <span className="ls-system-path__head">{head}</span>
      <span className="ls-system-path__tail">{tail}</span>
    </span>
  );
}

export function SystemSettingsPage() {
  const { preference, setPreference, tCore, ts, revealInFiles } = useSystemI18n();
  const activePlatform = useActiveDesktopPlatform();
  const isWin = activePlatform === "windows";
  const state = useManagement();
  const standalone = isStandalone(state);
  const permissions = state.permissions;
  const homePath = state.about?.home ?? state.snapshot?.home ?? "~/.linkshell";
  const revealable = /^(?:\/|[A-Za-z]:[\\/])/.test(homePath);

  const [themeMode, setThemeMode] = useState<ThemeMode>(readAppearanceMode);

  useEffect(() => {
    const syncAppearance = () => setThemeMode(readAppearanceMode());
    window.addEventListener(DESKTOP_APPEARANCE_EVENT, syncAppearance);
    return () => window.removeEventListener(DESKTOP_APPEARANCE_EVENT, syncAppearance);
  }, []);

  const handleThemeChange = (next: ThemeMode) => {
    setThemeMode(next);
    saveLocal(STORAGE_KEYS.appearance, next);
    applyDesktopAppearance(next);
    setAppearanceBridge(next);
  };

  const keepAwakeMode: "smart" | "always" | "off" =
    state.settings.keepAwake === "always" || state.settings.keepAwake === true
      ? "always"
      : state.settings.keepAwake === "off" || state.settings.keepAwake === false
        ? "off"
        : "smart";

  return (
    <div className="ls-system-stack">
      {/* 1. Appearance, Language & Startup */}
      <section
        className="ls-system-group"
        aria-label={ts("settings.appearanceGroup")}
      >
        <div className="ls-system-group__head">
          <h3 className="ls-system-group__title">
            {ts("settings.appearanceGroup")}
          </h3>
        </div>
        <div className="ls-system-card">
          <div className="ls-system-row">
            <div className="ls-system-row__copy">
              <span className="ls-system-row__title">
                <DesktopIcon name="globe" size="sm" />
                {ts("settings.language")}
              </span>
            </div>
            <div className="ls-system-row__controls">
              <Select
                size="sm"
                ariaLabel={ts("settings.language")}
                value={preference}
                onValueChange={(next) =>
                  setPreference(next as LocalePreference)
                }
                options={[
                  { value: "system", label: ts("settings.languageSystem") },
                  { value: "zh", label: LOCALE_LABELS.zh },
                  { value: "en", label: LOCALE_LABELS.en },
                  { value: "ja", label: LOCALE_LABELS.ja },
                ]}
              />
            </div>
          </div>

          <div className="ls-system-row">
            <div className="ls-system-row__copy">
              <span className="ls-system-row__title">
                <DesktopIcon
                  name={themeMode === "dark" ? "moon" : "sun"}
                  size="sm"
                />
                {ts("settings.theme")}
              </span>
            </div>
            <div className="ls-system-row__controls">
              <Tabs
                value={themeMode}
                variant="segmented"
                onValueChange={(next) => handleThemeChange(next as ThemeMode)}
              >
                <TabList label={ts("settings.theme")}>
                  <Tab value="system">{ts("settings.themeSystem")}</Tab>
                  <Tab value="light">{ts("settings.themeLight")}</Tab>
                  <Tab value="dark">{ts("settings.themeDark")}</Tab>
                </TabList>
              </Tabs>
            </div>
          </div>

          {!isWin ? (
            <div className="ls-system-row">
              <div className="ls-system-row__copy">
                <span className="ls-system-row__title">
                  {ts("settings.opaqueWindow")}
                </span>
                <span className="ls-system-row__detail">
                  {ts("settings.opaqueWindowDesc")}
                </span>
              </div>
              <div className="ls-system-row__controls">
                <Switch
                  checked={state.settings.opaqueWindow}
                  aria-label={ts("settings.opaqueWindow")}
                  onCheckedChange={(checked) =>
                    void setDesktopSetting("opaqueWindow", checked)
                  }
                />
              </div>
            </div>
          ) : null}

          {standalone ? (
            <div className="ls-system-row">
              <div className="ls-system-row__copy">
                <span className="ls-system-row__title">
                  {ts("settings.launchAtLogin")}
                </span>
                <span className="ls-system-row__detail">
                  {ts("settings.launchAtLoginDesc")}
                </span>
              </div>
              <div className="ls-system-row__controls">
                <Switch
                  checked={state.loginItem.enabled}
                  aria-label={ts("settings.launchAtLogin")}
                  onCheckedChange={(checked) => void setLaunchAtLogin(checked)}
                />
              </div>
            </div>
          ) : null}

          {state.loginItem.approval ? (
            <div className="ls-system-row">
              <div className="ls-system-row__copy">
                <span className="ls-system-row__title">
                  {ts("settings.loginItemApproval")}
                </span>
                <span className="ls-system-row__detail">
                  {ts("settings.loginItemApprovalDesc")}
                </span>
              </div>
              <div className="ls-system-row__controls">
                <Badge tone="waiting" dot="waiting">
                  {ts("settings.permMissing")}
                </Badge>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={openLoginItems}
                >
                  {ts("settings.openLoginItems")}
                </Button>
              </div>
            </div>
          ) : null}
        </div>
        {state.loginItemMessage ? (
          <p className="ls-system-note" data-tone="warning">
            {state.loginItemMessage}
          </p>
        ) : null}
        <p className="ls-system-note">{ts("settings.trayFoot")}</p>
      </section>

      {/* 2. Keep-Awake Power Control */}
      <section
        className="ls-system-group"
        aria-label={ts("settings.keepAwakeGroup")}
      >
        <div className="ls-system-group__head">
          <h3 className="ls-system-group__title">
            {ts("settings.keepAwakeGroup")}
          </h3>
        </div>
        <div className="ls-system-card">
          <div className="ls-system-row">
            <div className="ls-system-row__copy">
              <span className="ls-system-row__title">
                <DesktopIcon
                  name={keepAwakeMode === "off" ? "keep-awake-off" : "keep-awake"}
                  size="sm"
                />
                {tCore("power.keepAwake")}
              </span>
              <span className="ls-system-row__detail">
                {keepAwakeMode === "smart"
                  ? tCore("power.keepAwakeSmartDesc")
                  : keepAwakeMode === "always"
                    ? tCore("power.keepAwakeAlwaysDesc")
                    : tCore("power.keepAwakeOffDesc")}
              </span>
            </div>
            <div className="ls-system-row__controls">
              <Tabs
                value={keepAwakeMode}
                variant="segmented"
                onValueChange={(next) => {
                  const resolved =
                    next === "always" || next === "off" ? next : "smart";
                  void setDesktopSetting("keepAwake", resolved);
                }}
              >
                <TabList label={tCore("power.keepAwake")}>
                  <Tab value="smart">{tCore("power.keepAwakeSmart")}</Tab>
                  <Tab value="always">{tCore("power.keepAwakeAlways")}</Tab>
                  <Tab value="off">{tCore("power.keepAwakeOff")}</Tab>
                </TabList>
              </Tabs>
            </div>
          </div>
        </div>
      </section>

      {/* 3. Screen Capture & Input Permissions */}
      <section
        className="ls-system-group"
        aria-label={ts("settings.screenGroup")}
      >
        <div className="ls-system-group__head">
          <h3 className="ls-system-group__title">
            {ts("settings.screenGroup")}
          </h3>
        </div>
        <div className="ls-system-card">
          {isWin ? (
            <div className="ls-system-row">
              <div className="ls-system-row__copy">
                <span className="ls-system-row__title">
                  {ts("settings.winSharing")}
                </span>
                <span className="ls-system-row__detail">
                  {ts("settings.winSharingDesc")}
                </span>
              </div>
              <div className="ls-system-row__controls">
                <Switch
                  checked={permissions.sharing !== false}
                  aria-label={ts("settings.winSharing")}
                  onCheckedChange={(checked) => void setScreenSharing(checked)}
                />
              </div>
            </div>
          ) : (
            <>
              <div className="ls-system-row">
                <div className="ls-system-row__copy">
                  <span className="ls-system-row__title">
                    {ts("settings.macRecording")}
                  </span>
                  <span className="ls-system-row__detail">
                    {ts("settings.macRecordingDesc")}
                  </span>
                </div>
                <div className="ls-system-row__controls">
                  <PermissionStatusControl
                    known={permissions.known}
                    granted={permissions.recording}
                  />
                </div>
              </div>
              <div className="ls-system-row">
                <div className="ls-system-row__copy">
                  <span className="ls-system-row__title">
                    {ts("settings.macAccessibility")}
                  </span>
                  <span className="ls-system-row__detail">
                    {ts("settings.macAccessibilityDesc")}
                  </span>
                </div>
                <div className="ls-system-row__controls">
                  <PermissionStatusControl
                    known={permissions.known}
                    granted={permissions.control}
                  />
                </div>
              </div>
            </>
          )}
        </div>
      </section>

      {/* 4. Data Directory & Bundled CLI */}
      <section className="ls-system-group" aria-label={ts("settings.dataGroup")}>
        <div className="ls-system-group__head">
          <h3 className="ls-system-group__title">{ts("settings.dataGroup")}</h3>
        </div>
        <div className="ls-system-card">
          <div className="ls-system-row">
            <div className="ls-system-row__copy">
              <span className="ls-system-row__title">
                <DesktopIcon name="folder" size="sm" />
                {ts("settings.dataDir")}
              </span>
              <span className="ls-system-row__detail">
                <MiddleTruncatedPath path={homePath} />
              </span>
            </div>
            <div className="ls-system-row__controls">
              <Button
                size="sm"
                variant="secondary"
                disabled={!revealable}
                onClick={() =>
                  void revealOnDesktop(homePath).catch(reportDesktopError)
                }
              >
                {revealInFiles}
              </Button>
            </div>
          </div>

          {standalone ? (
            <>
              <div className="ls-system-row">
                <div className="ls-system-row__copy">
                  <span className="ls-system-row__title">
                    <DesktopIcon name="terminal" size="sm" />
                    {ts("settings.cliCommand")}
                  </span>
                  <span className="ls-system-row__detail">
                    {isWin
                      ? ts("settings.cliWinDesc")
                      : ts("settings.cliMacDesc")}
                  </span>
                </div>
                <div className="ls-system-row__controls">
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() =>
                      void (isWin
                        ? copyCommandPath()
                        : installCommand())
                    }
                  >
                    {isWin
                      ? ts("settings.cliWinCopy")
                      : ts("settings.cliMacInstall")}
                  </Button>
                </div>
              </div>

              <div className="ls-system-row">
                <div className="ls-system-row__copy">
                  <span className="ls-system-row__title">
                    {ts("settings.recoverService")}
                  </span>
                  <span className="ls-system-row__detail">
                    {ts("settings.recoverServiceDesc")}
                  </span>
                </div>
                <div className="ls-system-row__controls">
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={state.busy}
                    onClick={() => void serviceAction("recover-update")}
                  >
                    {ts("settings.recoverBtn")}
                  </Button>
                </div>
              </div>
            </>
          ) : null}
        </div>
        {state.commandMessage ? (
          <p className="ls-system-note" role="status">
            {state.commandMessage}
          </p>
        ) : null}
      </section>
    </div>
  );
}

function PermissionStatusControl({
  known,
  granted,
}: {
  known: boolean;
  granted: boolean;
}) {
  const { ts } = useSystemI18n();
  if (!known) {
    return <Badge tone="neutral">{ts("status.unknown")}</Badge>;
  }
  if (granted) {
    return (
      <Badge tone="ok" dot="ok">
        {ts("settings.permGranted")}
      </Badge>
    );
  }
  return (
    <>
      <Badge tone="waiting" dot="waiting">
        {ts("settings.permMissing")}
      </Badge>
      <Button size="sm" variant="secondary" onClick={openSetup}>
        {ts("overview.authorizeBtn")}
      </Button>
    </>
  );
}
