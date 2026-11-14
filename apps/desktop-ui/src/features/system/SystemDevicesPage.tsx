import { dateLocaleTag } from "@linkshell/client-core";
import { useManagement } from "../../core";
import { DesktopIcon } from "../../icons";
import { Badge, Button, EmptyState } from "../../primitives";
import { LocalPairingSection } from "./qr-pairing";
import type { SystemConfirmAction } from "./SystemOverviewPage";
import { useSystemI18n } from "./system-i18n";

export function SystemDevicesPage({
  onRequestConfirm,
}: {
  onRequestConfirm: (action: SystemConfirmAction) => void;
}) {
  const { locale, ts } = useSystemI18n();
  const state = useManagement();
  const gateway = state.snapshot?.gateway;
  const devices = gateway?.devices ?? [];

  return (
    <div className="ls-system-stack">
      <section className="ls-system-group" aria-label={ts("devices.addGroup")}>
        <div className="ls-system-group__head">
          <h3 className="ls-system-group__title">{ts("devices.addGroup")}</h3>
        </div>
        <LocalPairingSection devices={devices} disabled={state.busy} />
        <p className="ls-system-note">{ts("devices.note")}</p>
      </section>

      <section className="ls-system-group" aria-label={ts("devices.pairedGroup")}>
        <div className="ls-system-group__head">
          <h3 className="ls-system-group__title">{ts("devices.pairedGroup")}</h3>
          {devices.length > 0 ? (
            <span className="ls-system-group__meta">
              {ts("overview.devicesCountValue", { count: devices.length })}
            </span>
          ) : null}
        </div>

        <div className="ls-system-card">
          {devices.length === 0 ? (
            <EmptyState
              compact
              icon="phone-device"
              title={ts("devices.emptyTitle")}
              description={ts("devices.emptyDesc")}
            />
          ) : (
            devices.map((device) => {
              const revoking = state.revokingDeviceId === device.id;
              return (
                <div key={device.id} className="ls-system-row">
                  <div className="ls-system-row__copy">
                    <span className="ls-system-row__title">
                      <DesktopIcon name="phone-device" size="sm" />
                      {device.name}
                    </span>
                    {device.pairedAt ? (
                      <span className="ls-system-row__detail">
                        {ts("devices.pairedAt", {
                          date: new Date(device.pairedAt).toLocaleDateString(
                            dateLocaleTag(locale),
                            { year: "numeric", month: "short", day: "numeric" },
                          ),
                        })}
                      </span>
                    ) : null}
                  </div>
                  <div className="ls-system-row__controls">
                    <Badge
                      tone={device.online ? "ok" : "neutral"}
                      dot={device.online ? "ok" : "offline"}
                    >
                      {device.online ? ts("status.online") : ts("status.offline")}
                    </Badge>
                    <Button
                      size="sm"
                      variant="danger-ghost"
                      loading={revoking}
                      disabled={state.busy || Boolean(state.revokingDeviceId)}
                      onClick={() =>
                        onRequestConfirm({
                          kind: "revoke-device",
                          deviceId: device.id,
                          deviceName: device.name,
                        })
                      }
                    >
                      {revoking ? ts("devices.revokingBtn") : ts("devices.revokeBtn")}
                    </Button>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {gateway?.url ? (
          <p className="ls-system-note">
            {ts("devices.gatewayFoot", { url: gateway.url })}
          </p>
        ) : null}
        {gateway?.error?.message ? (
          <p className="ls-system-note" data-tone="warning">
            {gateway.error.message}
          </p>
        ) : null}
      </section>
    </div>
  );
}
