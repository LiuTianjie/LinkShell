import { dateLocaleTag } from "@linkshell/client-core";
import {
  checkUpdates,
  installUpdate,
  newVersion as hasNewVersion,
  setDesktopSetting,
  standalone as isStandalone,
  useManagement,
} from "../../core";
import { DesktopIcon } from "../../icons";
import { Badge, Button, Switch, Tab, TabList, Tabs } from "../../primitives";
import type { SystemConfirmAction } from "./SystemOverviewPage";
import { useSystemI18n } from "./system-i18n";

export function SystemUpdatesPage({
  onRequestConfirm,
}: {
  onRequestConfirm: (action: SystemConfirmAction) => void;
}) {
  const { locale, ts, tm } = useSystemI18n();
  const state = useManagement();
  const standalone = isStandalone(state);
  const newVersion = hasNewVersion(state);
  const update = state.update;

  const hostVer = state.snapshot?.machine?.hostVersion;
  const desktopVer = state.about?.version;
  const cliVer = state.snapshot?.cliVersion ?? (standalone ? desktopVer : undefined);
  const unified = Boolean(cliVer && cliVer === hostVer && cliVer === desktopVer);

  const installSourceText = standalone
    ? ts("updates.sourceStandalone")
    : state.snapshot?.source === "homebrew"
      ? ts("updates.sourceHomebrew")
      : state.snapshot?.source === "npm"
        ? ts("updates.sourceNpm")
        : ts("status.unknown");

  const checkedSuffix = update.checkedAt
    ? ts("updates.lastChecked", {
        time: new Date(update.checkedAt).toLocaleTimeString(
          dateLocaleTag(locale),
          { hour: "2-digit", minute: "2-digit" },
        ),
      })
    : "";

  return (
    <div className="ls-system-stack">
      <section
        className="ls-system-group"
        aria-label={ts("updates.groupTitle")}
      >
        <div className="ls-system-group__head">
          <h3 className="ls-system-group__title">{ts("updates.groupTitle")}</h3>
        </div>

        <div className="ls-system-card">
          <div className="ls-system-row">
            <div className="ls-system-row__copy">
              <span className="ls-system-row__title">
                {ts("updates.installSource")}
              </span>
            </div>
            <div className="ls-system-row__controls">
              <span className="ls-system-value">{installSourceText}</span>
            </div>
          </div>

          {unified ? (
            <div className="ls-system-row">
              <div className="ls-system-row__copy">
                <span className="ls-system-row__title">
                  {ts("updates.unifiedVersion")}
                </span>
              </div>
              <div className="ls-system-row__controls">
                <Badge tone="neutral">{cliVer}</Badge>
              </div>
            </div>
          ) : (
            <>
              <div className="ls-system-row">
                <div className="ls-system-row__copy">
                  <span className="ls-system-row__title">
                    {ts("updates.desktopVersion")}
                  </span>
                </div>
                <div className="ls-system-row__controls">
                  <span className="ls-system-value">
                    {desktopVer ?? ts("updates.devBuild")}
                  </span>
                </div>
              </div>
              <div className="ls-system-row">
                <div className="ls-system-row__copy">
                  <span className="ls-system-row__title">
                    {ts("updates.hostVersion")}
                  </span>
                </div>
                <div className="ls-system-row__controls">
                  <span className="ls-system-value">
                    {hostVer ?? ts("updates.notConnected")}
                  </span>
                </div>
              </div>
              <div className="ls-system-row">
                <div className="ls-system-row__copy">
                  <span className="ls-system-row__title">
                    {ts("updates.cliVersion")}
                  </span>
                </div>
                <div className="ls-system-row__controls">
                  <span className="ls-system-value">
                    {cliVer ?? hostVer ?? ts("updates.notConnected")}
                  </span>
                </div>
              </div>
            </>
          )}

          <div className="ls-system-row">
            <div className="ls-system-row__copy">
              <span className="ls-system-row__title">
                {ts("updates.channel")}
              </span>
            </div>
            <div className="ls-system-row__controls">
              {standalone ? (
                <Tabs
                  value={state.settings.updateChannel}
                  variant="segmented"
                  onValueChange={(next) =>
                    void setDesktopSetting(
                      "updateChannel",
                      next === "beta" ? "beta" : "stable",
                    )
                  }
                >
                  <TabList label={ts("updates.channel")}>
                    <Tab
                      value="stable"
                      disabled={update.checking || update.installing}
                    >
                      {ts("updates.channelStable")}
                    </Tab>
                    <Tab
                      value="beta"
                      disabled={update.checking || update.installing}
                    >
                      {ts("updates.channelBeta")}
                    </Tab>
                  </TabList>
                </Tabs>
              ) : (
                <span className="ls-system-value">
                  {ts("updates.channelStable")}
                </span>
              )}
            </div>
          </div>

          <div className="ls-system-row">
            <div className="ls-system-row__copy">
              <span className="ls-system-row__title">
                {ts("updates.autoCheck")}
              </span>
            </div>
            <div className="ls-system-row__controls">
              <Switch
                checked={state.settings.autoCheck}
                aria-label={ts("updates.autoCheck")}
                onCheckedChange={(checked) =>
                  void setDesktopSetting("autoCheck", checked)
                }
              />
            </div>
          </div>

          <div className="ls-system-row">
            <div className="ls-system-row__copy">
              <span className="ls-system-row__title">
                <DesktopIcon name="download" size="sm" />
                {ts("updates.checkRow")}
              </span>
              <span className="ls-system-row__detail" role="status">
                {(tm(update.message) || ts("updates.notCheckedYet")) + checkedSuffix}
              </span>
            </div>
            <div className="ls-system-row__controls">
              {newVersion && standalone ? (
                <Button
                  size="sm"
                  variant="primary"
                  loading={update.installing}
                  disabled={state.busy || update.checking || update.installing}
                  onClick={installUpdate}
                >
                  {update.installing
                    ? ts("updates.installingAppBtn")
                    : ts("updates.installAppBtn")}
                </Button>
              ) : null}

              {newVersion && !standalone ? (
                <Button
                  size="sm"
                  variant="primary"
                  disabled={state.busy || update.checking}
                  onClick={() => onRequestConfirm({ kind: "upgrade" })}
                >
                  {ts("updates.installCliBtn")}
                </Button>
              ) : null}

              <Button
                size="sm"
                variant={newVersion ? "ghost" : "secondary"}
                loading={update.checking}
                disabled={update.checking || update.installing}
                onClick={() => void checkUpdates()}
              >
                {update.checking
                  ? ts("updates.checkingBtn")
                  : ts("updates.checkNowBtn")}
              </Button>
            </div>
          </div>
        </div>

        <p className="ls-system-note">
          {standalone ? ts("updates.footStandalone") : ts("updates.footCli")}
        </p>
      </section>
    </div>
  );
}
