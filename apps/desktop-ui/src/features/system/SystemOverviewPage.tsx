import { useState } from "react";
import { MONTHLY_UPGRADE_COPY, dateLocaleTag, membershipTierLabel } from "@linkshell/client-core";
import {
  OFFICIAL_GATEWAY,
  cancelLogin,
  clearGatewayMessage,
  clearSignInError,
  healthy as isHealthy,
  login,
  loginWithPassword,
  loginWithProvider,
  membershipOf,
  openMembershipPage,
  openSetup,
  openYearlyUpgradePage,
  refreshAccount,
  serviceAction,
  setGateway,
  standalone as isStandalone,
  useManagement,
  validateGateway,
  type GatewayChoice,
  type ManagePage,
} from "../../core";
import { DesktopIcon } from "../../icons";
import { Badge, Button, Field, IconButton, Input, StatusDot } from "../../primitives";
import { ReferralSummaryCard, SignInForm } from "./SignInForm";
import { useSystemI18n } from "./system-i18n";

export type SystemConfirmAction =
  | { kind: "stop" }
  | { kind: "restart" }
  | { kind: "logout" }
  | { kind: "remove-password" }
  | { kind: "upgrade" }
  | { kind: "revoke-device"; deviceId: string; deviceName: string };

function isSameGateway(a: string, b: string): boolean {
  const normalize = (url: string) =>
    url.trim().replace(/^http/i, "ws").replace(/\/+$/, "").toLowerCase();
  return normalize(a) === normalize(b);
}

export function SystemOverviewPage({
  onNavigate,
  onRequestConfirm,
}: {
  onNavigate: (page: ManagePage) => void;
  onRequestConfirm: (action: SystemConfirmAction) => void;
}) {
  const { locale, tCore, ts, tm, computer } = useSystemI18n();
  const state = useManagement();
  const healthy = isHealthy(state);
  const unreachable = state.snapshot?.status === "unreachable";
  const standalone = isStandalone(state);
  const snapshot = state.snapshot;
  const gateway = snapshot?.gateway;
  const devices = gateway?.devices ?? [];
  const onlineCount = devices.filter((d) => d.online).length;
  const signedIn = snapshot?.account?.state === "signed-in";
  const permissions = state.permissions;
  const screenReady = permissions.recording && permissions.control;
  const externalCliHost =
    standalone &&
    healthy &&
    Boolean(state.about?.bundle) &&
    snapshot?.hostOwner !== state.about?.bundle;

  const [editingGateway, setEditingGateway] = useState(false);
  const [gatewayKind, setGatewayKind] = useState<GatewayChoice["kind"]>("official");
  const [gatewayUrl, setGatewayUrl] = useState("");
  const [gatewayValidationErr, setGatewayValidationErr] = useState<string>();

  const [signInExpanded, setSignInExpanded] = useState(false);

  const openGatewayEditor = () => {
    const currentKind: GatewayChoice["kind"] =
      gateway?.status === "off" || !gateway?.url
        ? "off"
        : isSameGateway(gateway.url, OFFICIAL_GATEWAY)
          ? "official"
          : "own";
    setGatewayKind(currentKind);
    setGatewayUrl(currentKind === "own" ? gateway?.url ?? "" : "");
    setGatewayValidationErr(undefined);
    clearGatewayMessage();
    setEditingGateway(true);
  };

  const handleSaveGateway = async () => {
    if (gatewayKind === "own") {
      try {
        const normalized = validateGateway(gatewayUrl);
        setGatewayValidationErr(undefined);
        if (await setGateway({ kind: "own", url: normalized })) {
          setEditingGateway(false);
        }
      } catch (err) {
        setGatewayValidationErr(err instanceof Error ? err.message : String(err));
      }
      return;
    }
    setGatewayValidationErr(undefined);
    if (await setGateway({ kind: gatewayKind })) {
      setEditingGateway(false);
    }
  };

  const serviceStatusLabel = state.problem
    ? ts("status.unknown")
    : snapshot?.status === "running"
      ? ts("status.running")
      : snapshot?.status === "stopped"
        ? ts("status.stopped")
        : snapshot?.status === "unreachable"
          ? ts("status.unreachable")
          : ts("status.connecting");

  const gatewayStatusLabel = !healthy
    ? ts("status.unknown")
    : gateway?.status === "online"
      ? ts("gateway.connected")
      : gateway?.status === "connecting"
        ? ts("gateway.connecting")
        : gateway?.status === "offline"
          ? ts("gateway.disconnected")
          : ts("gateway.off");

  const gatewayDetail =
    gateway?.error?.message ??
    (!healthy
      ? ts("overview.gatewayAfterStart")
      : gateway?.status === "online"
        ? ts("overview.gatewayOnlineDetail")
        : gateway?.status === "connecting"
          ? ts("overview.gatewayConnectingDetail")
          : signedIn
            ? ts("overview.gatewayLocalSignedIn")
            : ts("overview.gatewayLocalSignedOut"));

  const screenDetail = !permissions.known
    ? ts("overview.screenChecking")
    : screenReady
      ? ts("overview.screenReadyDetail")
      : permissions.sharing === false
        ? ts("overview.screenDisabledDetail")
        : !permissions.recording && !permissions.control
          ? ts("overview.screenMissingBoth")
          : permissions.recording
            ? ts("overview.screenMissingControl")
            : ts("overview.screenMissingRecording");

  const membership = membershipOf(snapshot?.account);
  const upgradeCopy = MONTHLY_UPGRADE_COPY[locale] ?? MONTHLY_UPGRADE_COPY.en;
  const trialExpiringSoon =
    membership.kind === "pro" &&
    Boolean(membership.isTrial) &&
    (membership.daysRemaining ?? 99) <= 2;

  const recentActivity = state.activity.slice(0, 5);

  return (
    <div className="ls-system-stack">
      {externalCliHost ? (
        <div className="ls-system-banner" data-tone="warning">
          <div className="ls-system-banner__copy">
            <DesktopIcon name="alert-triangle" size="sm" />
            <span>{ts("overview.externalCliBanner")}</span>
          </div>
          <Button
            size="sm"
            variant="secondary"
            disabled={state.busy}
            onClick={() => onRequestConfirm({ kind: "restart" })}
          >
            {ts("overview.switchBuiltin")}
          </Button>
        </div>
      ) : null}

      {/* 1. LinkShell Account & iTool Pro Entitlement (Inline Sign-In, Zero Nested Modal!) */}
      <section className="ls-system-group" aria-label={ts("overview.accountGroup")}>
        <div className="ls-system-group__head">
          <h3 className="ls-system-group__title">{ts("overview.accountGroup")}</h3>
        </div>
        <div className="ls-system-card">
          <div className="ls-system-row">
            <div className="ls-system-row__copy">
              <span className="ls-system-row__title">
                <DesktopIcon name="user" size="sm" />
                {signedIn
                  ? snapshot?.account?.email ?? snapshot?.account?.userId
                  : ts("overview.notSignedIn")}
              </span>
              <span className="ls-system-row__detail">
                {signedIn
                  ? ts("overview.signedInDetail")
                  : ts("overview.signedOutDetail")}
              </span>
            </div>
            <div className="ls-system-row__controls">
              {state.signingIn ? (
                <Button size="sm" variant="secondary" onClick={cancelLogin}>
                  {ts("overview.cancelSignIn")}
                </Button>
              ) : signedIn ? (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={state.busy}
                  onClick={() => onRequestConfirm({ kind: "logout" })}
                >
                  {ts("overview.signOutBtn")}
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={state.busy}
                  onClick={() => {
                    clearSignInError();
                    setSignInExpanded((prev) => !prev);
                  }}
                >
                  {signInExpanded ? ts("modal.cancel") : ts("overview.signInBtn")}
                </Button>
              )}
            </div>
          </div>

          {!signedIn && (signInExpanded || state.signingIn) ? (
            <div className="ls-system-inline-panel">
              <SignInForm
                pending={state.signingIn ? state.signInMethod : undefined}
                link={state.signInLink}
                error={state.signInError}
                disabled={state.busy && !state.signingIn}
                // The form stays open after a failed or cancelled sign-in, so its error is seen.
                onPassword={(email, password) =>
                  void loginWithPassword(email, password).then((signedIn) => {
                    if (signedIn) setSignInExpanded(false);
                  })
                }
                onProvider={(provider) =>
                  void loginWithProvider(provider).then((signedIn) => {
                    if (signedIn) setSignInExpanded(false);
                  })
                }
                onBrowser={() =>
                  void login().then((signedIn) => {
                    if (signedIn) setSignInExpanded(false);
                  })
                }
                onCancel={() => {
                  cancelLogin();
                  setSignInExpanded(false);
                }}
                onEdit={clearSignInError}
              />
            </div>
          ) : null}

          {signedIn ? (
            <>
              <div className="ls-system-row">
                <div className="ls-system-row__copy">
                  <span className="ls-system-row__title">
                    {ts("overview.membershipRow")}
                  </span>
                  <span className="ls-system-row__detail">
                    {membership.kind === "pro"
                      ? tCore("desktop.membership.expiresOn", {
                          date: membership.expiresAt.toLocaleDateString(
                            dateLocaleTag(locale),
                            { year: "numeric", month: "long", day: "numeric" },
                          ),
                        })
                      : membership.kind === "free"
                        ? ts("overview.membershipFreeDetail")
                        : state.checkingMembership
                          ? tCore("desktop.membership.checking")
                          : ts("overview.membershipUnknown")}
                  </span>
                </div>
                <div className="ls-system-row__controls">
                  {membership.kind === "pro" ? (
                    <Badge
                      tone={membership.isTrial ? "waiting" : "ok"}
                      dot={membership.isTrial ? "waiting" : "ok"}
                    >
                      {membershipTierLabel(membership.tier, {
                        isTrial: membership.isTrial,
                        daysRemaining: membership.daysRemaining,
                        locale,
                      })}
                    </Badge>
                  ) : membership.kind === "free" ? (
                    <Badge tone="neutral">
                      {tCore("desktop.membership.notSubscribed")}
                    </Badge>
                  ) : null}
                  <IconButton
                    icon={state.checkingMembership ? "spinner" : "refresh"}
                    size="icon-sm"
                    variant="ghost"
                    label={tCore("desktop.membership.refresh")}
                    disabled={state.busy || state.checkingMembership}
                    onClick={refreshAccount}
                  />
                </div>
              </div>

              {trialExpiringSoon && membership.kind === "pro" ? (
                <button
                  type="button"
                  className="ls-system-row"
                  onClick={() => openMembershipPage(locale)}
                >
                  <div className="ls-system-row__copy">
                    <span className="ls-system-row__title">
                      {tCore("desktop.membership.trialExpiringBanner", {
                        days: membership.daysRemaining ?? 0,
                      })}
                    </span>
                  </div>
                  <div className="ls-system-row__controls">
                    <span className="ls-signin-link">
                      {tCore("desktop.membership.activateOfficialPlan")}
                    </span>
                  </div>
                </button>
              ) : null}

              {membership.kind === "pro" &&
              !membership.isTrial &&
              membership.tier === "monthly" ? (
                <button
                  type="button"
                  className="ls-system-row"
                  onClick={() => openYearlyUpgradePage(locale)}
                >
                  <div className="ls-system-row__copy">
                    <span className="ls-system-row__detail">{upgradeCopy.unlocked}</span>
                  </div>
                  <div className="ls-system-row__controls">
                    <span className="ls-signin-link">{upgradeCopy.action}</span>
                  </div>
                </button>
              ) : null}

              {membership.kind === "free" ? (
                <div className="ls-system-row">
                  <div className="ls-system-row__copy">
                    <span className="ls-system-row__title">
                      {tCore("desktop.membership.subscribeAction")}
                    </span>
                    <span className="ls-system-row__detail">
                      {ts("overview.subscribeDetail")}
                    </span>
                  </div>
                  <div className="ls-system-row__controls">
                    <Button
                      size="sm"
                      variant="secondary"
                      leadingIcon="external-link"
                      onClick={() => openMembershipPage(locale)}
                    >
                      {tCore("desktop.membership.subscribeAction")}
                    </Button>
                  </div>
                </div>
              ) : null}
            </>
          ) : null}
        </div>

        {signedIn && snapshot?.account?.userId ? (
          <ReferralSummaryCard
            userId={snapshot.account.userId}
            disabled={state.busy}
          />
        ) : null}

        {state.accountMessage ? (
          <p className="ls-system-note" role="status">
            {tm(state.accountMessage)}
          </p>
        ) : null}
      </section>

      {/* 2. This Computer: Host Daemon, Inline Gateway Editor, Permissions & Devices */}
      <section className="ls-system-group" aria-label={computer}>
        <div className="ls-system-group__head">
          <h3 className="ls-system-group__title">{computer}</h3>
        </div>
        <div className="ls-system-card">
          <div className="ls-system-row">
            <div className="ls-system-row__copy">
              <span className="ls-system-row__title">
                <DesktopIcon name="host-daemon" size="sm" />
                {ts("overview.hostServiceRow")}
              </span>
              <span className="ls-system-row__detail">
                {healthy
                  ? ts("overview.hostReadyDetail")
                  : unreachable
                    ? ts("overview.hostUnreachableDetail")
                    : ts("overview.hostStoppedDetail")}
              </span>
            </div>
            <div className="ls-system-row__controls">
              <Badge
                tone={
                  healthy
                    ? "ok"
                    : snapshot?.status === "unreachable"
                      ? "danger"
                      : "neutral"
                }
                dot={
                  healthy
                    ? "ok"
                    : snapshot?.status === "unreachable"
                      ? "danger"
                      : snapshot?.status === "stopped"
                        ? "offline"
                        : "running"
                }
              >
                {serviceStatusLabel}
              </Badge>
              {!healthy && !unreachable ? (
                <Button
                  size="sm"
                  variant="primary"
                  disabled={state.busy}
                  onClick={() => void serviceAction("start")}
                >
                  {ts("modal.startService")}
                </Button>
              ) : (
                <>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={state.busy}
                    onClick={() => onRequestConfirm({ kind: "restart" })}
                  >
                    {ts("modal.restartService")}
                  </Button>
                  <Button
                    size="sm"
                    variant="danger-ghost"
                    disabled={state.busy}
                    onClick={() => onRequestConfirm({ kind: "stop" })}
                  >
                    {ts("modal.stopService")}
                  </Button>
                </>
              )}
            </div>
          </div>

          <div className="ls-system-row">
            <div className="ls-system-row__copy">
              <span className="ls-system-row__title">
                <DesktopIcon name="gateway-relay" size="sm" />
                {ts("overview.gatewayRow")}
              </span>
              <span className="ls-system-row__detail">{gatewayDetail}</span>
            </div>
            <div className="ls-system-row__controls">
              <Badge
                tone={
                  !healthy
                    ? "neutral"
                    : gateway?.status === "online"
                      ? "ok"
                      : gateway?.status === "offline" || gateway?.error
                        ? "danger"
                        : gateway?.status === "connecting"
                          ? "running"
                          : "neutral"
                }
                dot={
                  !healthy
                    ? "offline"
                    : gateway?.status === "online"
                      ? "ok"
                      : gateway?.status === "offline" || gateway?.error
                        ? "danger"
                        : gateway?.status === "connecting"
                          ? "running"
                          : "offline"
                }
              >
                {gatewayStatusLabel}
              </Badge>
              {healthy ? (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={state.busy}
                  onClick={() => {
                    if (editingGateway) setEditingGateway(false);
                    else openGatewayEditor();
                  }}
                >
                  {editingGateway ? ts("modal.cancel") : ts("overview.changeGateway")}
                </Button>
              ) : null}
            </div>
          </div>

          {editingGateway && healthy ? (
            <form
              className="ls-system-inline-panel"
              onSubmit={(event) => {
                event.preventDefault();
                void handleSaveGateway();
              }}
            >
              <div className="ls-system-radio-list" role="radiogroup" aria-label={ts("overview.gatewayRow")}>
                {(
                  [
                    {
                      value: "official" as const,
                      title: ts("overview.gatewayOfficial"),
                      detail: signedIn
                        ? ts("overview.gatewayOfficialDesc")
                        : ts("overview.gatewayOfficialNeedLogin"),
                      disabled: !signedIn,
                    },
                    {
                      value: "own" as const,
                      title: ts("overview.gatewayOwn"),
                      detail: ts("overview.gatewayOwnDesc"),
                      disabled: false,
                    },
                    {
                      value: "off" as const,
                      title: ts("overview.gatewayOff"),
                      detail: ts("overview.gatewayOffDesc"),
                      disabled: false,
                    },
                  ]
                ).map((option) => (
                  <label
                    key={option.value}
                    className="ls-system-radio-card"
                    data-checked={gatewayKind === option.value ? "true" : undefined}
                    data-disabled={option.disabled ? "true" : undefined}
                  >
                    <input
                      type="radio"
                      name="system-gateway-kind"
                      value={option.value}
                      checked={gatewayKind === option.value}
                      disabled={option.disabled || state.busy}
                      onChange={() => {
                        setGatewayKind(option.value);
                        setGatewayValidationErr(undefined);
                        clearGatewayMessage();
                      }}
                    />
                    <span className="ls-system-radio-card__copy">
                      <strong>{option.title}</strong>
                      <small>{option.detail}</small>
                    </span>
                  </label>
                ))}
              </div>

              {gatewayKind === "own" ? (
                <Field
                  label={ts("overview.gatewayOwn")}
                  error={gatewayValidationErr ?? (state.gatewayMessage || undefined)}
                >
                  <Input
                    type="url"
                    autoFocus
                    placeholder={ts("overview.gatewayUrlPlaceholder")}
                    value={gatewayUrl}
                    disabled={state.busy}
                    spellCheck={false}
                    autoComplete="off"
                    onChange={(event) => {
                      setGatewayUrl(event.target.value);
                      setGatewayValidationErr(undefined);
                      clearGatewayMessage();
                    }}
                  />
                </Field>
              ) : state.gatewayMessage ? (
                <p className="ls-system-note" data-tone="danger" role="alert">
                  {state.gatewayMessage}
                </p>
              ) : null}

              <div className="ls-system-inline-actions">
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  disabled={state.busy}
                  onClick={() => setEditingGateway(false)}
                >
                  {ts("modal.cancel")}
                </Button>
                <Button
                  type="submit"
                  size="sm"
                  variant="primary"
                  loading={state.busy}
                  disabled={state.busy || (gatewayKind === "own" && !gatewayUrl.trim())}
                >
                  {state.busy ? ts("modal.saving") : ts("modal.save")}
                </Button>
              </div>
            </form>
          ) : null}

          <div className="ls-system-row">
            <div className="ls-system-row__copy">
              <span className="ls-system-row__title">
                <DesktopIcon name="remote-screen" size="sm" />
                {ts("overview.screenRow")}
              </span>
              <span className="ls-system-row__detail">{screenDetail}</span>
            </div>
            <div className="ls-system-row__controls">
              {!permissions.known ? (
                <Badge tone="neutral">{ts("status.unknown")}</Badge>
              ) : screenReady ? (
                <Badge tone="ok" dot="ok">
                  {ts("overview.screenReady")}
                </Badge>
              ) : permissions.sharing === false ? (
                <>
                  <Badge tone="neutral">{ts("overview.screenDisabled")}</Badge>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => onNavigate("settings")}
                  >
                    {ts("overview.openSettingsBtn")}
                  </Button>
                </>
              ) : (
                <>
                  <Badge tone="waiting" dot="waiting">
                    {ts("settings.permMissing")}
                  </Badge>
                  <Button size="sm" variant="secondary" onClick={openSetup}>
                    {ts("overview.authorizeBtn")}
                  </Button>
                </>
              )}
            </div>
          </div>

          <button
            type="button"
            className="ls-system-row"
            onClick={() => onNavigate("devices")}
          >
            <div className="ls-system-row__copy">
              <span className="ls-system-row__title">
                <DesktopIcon name="phone-device" size="sm" />
                {ts("overview.devicesRow")}
              </span>
              <span className="ls-system-row__detail">
                {devices.length === 0
                  ? ts("overview.devicesNone")
                  : onlineCount > 0
                    ? ts("overview.devicesOnlineCount", { count: onlineCount })
                    : ts("overview.devicesAllOffline")}
              </span>
            </div>
            <div className="ls-system-row__controls">
              <span className="ls-system-value">
                {ts("overview.devicesCountValue", { count: devices.length })}
              </span>
              <DesktopIcon name="chevron-right" size="sm" />
            </div>
          </button>
        </div>
      </section>

      {/* 3. Recent Host Activity */}
      {recentActivity.length >= 2 ? (
        <section
          className="ls-system-group"
          aria-label={ts("overview.recentActivity")}
        >
          <div className="ls-system-group__head">
            <h3 className="ls-system-group__title">{ts("overview.recentActivity")}</h3>
          </div>
          <div className="ls-system-card">
            {recentActivity.map((event) => (
              <div
                key={`${event.at}:${tm(event.text)}`}
                className="ls-system-row"
              >
                <div className="ls-system-row__copy">
                  <span className="ls-system-row__detail">{tm(event.text)}</span>
                </div>
                <div className="ls-system-row__controls">
                  <StatusDot tone="neutral" />
                  <time
                    className="ls-system-value"
                    dateTime={new Date(event.at).toISOString()}
                  >
                    {new Date(event.at).toLocaleTimeString(dateLocaleTag(locale), {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </time>
                </div>
              </div>
            ))}
            <button
              type="button"
              className="ls-system-row"
              onClick={() => onNavigate("log")}
            >
              <span className="ls-system-row__title">
                {ts("overview.viewFullLog")}
              </span>
              <DesktopIcon name="chevron-right" size="sm" />
            </button>
          </div>
        </section>
      ) : null}
    </div>
  );
}
