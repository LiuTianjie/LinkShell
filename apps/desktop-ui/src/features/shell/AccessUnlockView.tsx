import { useState } from "react";
import { useStore } from "zustand";
import {
  computerNames,
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
      setError(err instanceof Error ? err.message : String(err));
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

        <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
          <h2 style={{ margin: 0, fontSize: "16px", fontWeight: 650 }}>
            {t("desktop.fleet.accessLocked")}
          </h2>
          <p style={{ margin: 0, fontSize: "13px", color: "var(--ls-fg-secondary)" }}>
            {computerTitle}
          </p>
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

        <div style={{ display: "flex", alignItems: "center", gap: "8px", justifyContent: "flex-end" }}>
          <Button
            variant="ghost"
            onClick={() => {
              const local = engine.state.getState().localComputer;
              if (local && local.key !== connection.computer.key) {
                engine.select(local);
              } else {
                navigate({ kind: "computers" });
              }
            }}
          >
            {t("desktop.nav.computers")}
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
