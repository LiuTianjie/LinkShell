import { useState } from "react";
import { useStore } from "zustand";
import {
  computerNames,
  describeActionError,
  engine,
  useI18n,
  useRouter,
  type Connection,
} from "../../core";
import { DesktopIcon } from "../../icons";
import { Button, Field, Input } from "../../primitives";
import { displayComputerName } from "./shell-helpers";

export interface AccessUnlockViewProps {
  connection: Connection;
}

export function AccessUnlockView({ connection }: AccessUnlockViewProps) {
  const { locale, t } = useI18n();
  const navigate = useRouter((s) => s.navigate);
  const names = useStore(computerNames.store);
  const localComputer = useStore(engine.state, (s) => s.localComputer);
  const canSwitchToLocal = Boolean(localComputer && localComputer.key !== connection.computer.key);

  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const computerTitle = displayComputerName(connection.computer, names, locale);

  const handleUnlock = async () => {
    const trimmed = password.trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    setError(undefined);
    try {
      await connection.store.getState().unlock(trimmed);
      setPassword("");
    } catch (err) {
      setError(describeActionError(err, locale));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="unlock-gate">
      <div className="unlock-card">
        <div className="unlock-card__icon" aria-hidden="true">
          <DesktopIcon name="lock" size="lg" />
        </div>

        <div className="unlock-card__heading">
          <h2 className="unlock-card__title">{t("desktop.fleet.accessLocked")}</h2>
          <p className="unlock-card__subtitle">{computerTitle}</p>
        </div>

        <Field
          label={t("desktop.manage.password")}
          error={error}
        >
          <Input
            type="password"
            autoFocus
            value={password}
            placeholder={t("desktop.fleet.unlockPlaceholder")}
            onChange={(e) => {
              setPassword(e.target.value);
              if (error) setError(undefined);
            }}
            onEnterSubmit={() => void handleUnlock()}
          />
        </Field>

        <div className="unlock-card__actions">
          <Button
            variant="ghost"
            onClick={() => {
              if (canSwitchToLocal && localComputer) engine.select(localComputer);
              else navigate({ kind: "computers" });
            }}
          >
            {canSwitchToLocal
              ? t("desktop.shell.switchToComputer", {
                  name: displayComputerName(localComputer, names, locale),
                })
              : t("desktop.nav.computers")}
          </Button>

          <Button
            variant="primary"
            leadingIcon="unlock"
            loading={submitting}
            disabled={!password.trim()}
            onClick={() => void handleUnlock()}
          >
            {t("desktop.fleet.unlockAction")}
          </Button>
        </div>
      </div>
    </div>
  );
}
